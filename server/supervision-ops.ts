/**
 * The supervision line's server side (core/work/supervision.ts): which
 * sessions worked an item, which of its sends wait for your OK, the counts the
 * inbox snapshot carries, and the one op that opens the item's file list and
 * records that you looked.
 *
 * Your own signal, like "not useful": HTTP only, never on the MCP surface, so
 * Junior can't mark its own work seen.
 */
import type { ChangedByJunior } from '../shared/protocol.js'
import { isOwnHandIn } from '../core/actions/own.js'
import { overriddenOff } from '../core/actions/sort.js'
import { type FileTouch, relativeTo, SUPERVISION_LIST_MAX, supervisionOf, touchesOf, unseenFiles } from '../core/work/supervision.js'
import type { ItemTask } from '../core/work/tasks.js'
import type { ScoredItem } from '../core/work/types.js'
import { ANY_ITEM_ID_RE } from './validate.js'
import { log } from './log.js'
import { invalidateInbox } from './ws/send.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

/**
 * The sessions that worked each item: dispatched chats, team and goal
 * sessions, task sessions. Brief runs only read the item, so they're left out.
 */
async function sessionsByItem(rt: WorkspaceRuntime, itemIds: ReadonlySet<string>, tasks: ReadonlyMap<string, readonly ItemTask[]>): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const add = (itemId: string, sessionId: string) => {
    if (!itemIds.has(itemId)) return
    if (rt.rows?.get(sessionId)?.kind === 'brief') return
    let s = out.get(itemId)
    if (!s) out.set(itemId, (s = new Set()))
    s.add(sessionId)
  }
  for (const l of await rt.store.links.list()) {
    if (l.fromKind === 'session' && l.toKind === 'item' && l.role !== 'brief') add(l.toId, l.fromId)
  }
  for (const [sessionId, itemId] of rt.sessionItem ?? []) add(itemId, sessionId)
  for (const [itemId, ts] of tasks) for (const t of ts) if (t.sessionId) add(itemId, t.sessionId)
  return out
}

/** Sends that wait for your OK, by item: queued, not set aside by the actions file, not a hand-in to Junior's own servers. */
async function heldSendsByItem(rt: WorkspaceRuntime): Promise<Map<string, number>> {
  const rules = rt.actionsFile?.current().rules
  const out = new Map<string, number>()
  for (const a of await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })) {
    if (isOwnHandIn(a) || (rules && overriddenOff(a, rules))) continue
    const itemId = a.itemId ?? rt.sessionItem?.get(a.sessionId)
    if (itemId) out.set(itemId, (out.get(itemId) ?? 0) + 1)
  }
  return out
}

/** Every file touch in these sessions after `since`, oldest first. */
async function touchesIn(rt: WorkspaceRuntime, sessionIds: Iterable<string>, since: number): Promise<FileTouch[]> {
  const events = await rt.store.events.fileEdits([...sessionIds], since)
  const bySession = new Map<string, typeof events>()
  for (const e of events) {
    const list = bySession.get(e.sessionId)
    if (list) list.push(e)
    else bySession.set(e.sessionId, [e])
  }
  return [...bySession].flatMap(([sid, evs]) => touchesOf(sid, evs))
}

/** Items the line can show on: With Junior's rows (handed off, or Junior's turn). */
const withJunior = (i: ScoredItem): boolean => !!i.junior || i.flow?.turn === 'ai'

/**
 * Put `supervision` on each ranked item Junior works: files changed since you
 * last opened its list, and sends that wait for your OK. Left off when both
 * are zero. Never fails the sync.
 */
export async function withSupervision(rt: WorkspaceRuntime, ranked: ScoredItem[], tasks: ReadonlyMap<string, readonly ItemTask[]>): Promise<void> {
  try {
    const targets = ranked.filter(withJunior)
    if (targets.length === 0) return
    const ids = new Set(targets.map((i) => i.id))
    const [sessions, held] = await Promise.all([sessionsByItem(rt, ids, tasks), heldSendsByItem(rt)])
    for (const i of targets) {
      const sids = sessions.get(i.id)
      const seenAt = i.changesSeenAt ?? null
      const touches = sids?.size ? await touchesIn(rt, sids, seenAt ?? 0) : []
      const s = supervisionOf({ touches, seenAt, heldSends: held.get(i.id) ?? 0 })
      if (s.unreviewedFiles > 0 || s.heldSends > 0) i.supervision = { files: s.unreviewedFiles, sends: s.heldSends }
    }
  } catch (err) {
    log('warn', 'inbox', `could not count what Junior did unseen: ${err instanceof Error ? err.message : String(err)}`, { workspace: rt.meta.id })
  }
}

export type ChangesSeen = { files: ChangedByJunior[]; total: number; since: number | null; seenAt: number }

/**
 * Open the item's list of files Junior changed since you last looked, and
 * record that you looked: one `changes-seen` note by you and the stamp
 * `changesSeenAt`, so those files no longer count. Returns the newest
 * SUPERVISION_LIST_MAX; every one of them is marked seen. Nothing is written
 * when the read fails, so the count stays.
 */
export async function changesSeenOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<ChangesSeen> {
  const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such item')
  const since = item.changesSeenAt ?? null
  const tasks = new Map([[id, await rt.store.tasks.list(id)]])
  const sids = (await sessionsByItem(rt, new Set([id]), tasks)).get(id) ?? new Set<string>()
  const unseen = unseenFiles(sids.size ? await touchesIn(rt, sids, since ?? 0) : [], since)
  const rows = new Map(
    await Promise.all([...new Set(unseen.slice(0, SUPERVISION_LIST_MAX).map((t) => t.sessionId))].map(async (sid) => [sid, rt.rows?.get(sid) ?? (await rt.store.sessions.get(sid))] as const)),
  )
  const files = unseen.slice(0, SUPERVISION_LIST_MAX).map((t): ChangedByJunior => {
    const row = rows.get(t.sessionId)
    return { path: relativeTo(row?.cwd, t.path), sessionId: t.sessionId, sessionTitle: row?.title ?? null, at: t.at }
  })
  await rt.store.items.note(id, 'changes-seen', 'user', now, { files: unseen.length })
  await rt.store.items.setFields(id, { changesSeenAt: now })
  invalidateInbox(rt)
  log('info', 'inbox', `changes seen: ${id}, ${unseen.length} file(s) (by user)`, { id, workspace: rt.meta.id })
  return { files, total: unseen.length, since, seenAt: now }
}
