/**
 * Chats that start chats (start_session / message_session / read_session /
 * list_sessions in the junior MCP). A started session is an ordinary chat in
 * the list: the only difference is that its first message came from another
 * chat, not the user. Sessions address each other by name, the handle
 * `/rename` sets (core/sessions/names.ts).
 *
 * All local work: a session's own sends stay held by its policy, and a
 * message from another chat is framed so it never reads as the user.
 */
import { renameSession } from '@anthropic-ai/claude-agent-sdk'
import type { StoredSession } from '../../core/store/types.js'
import type { Project } from '../../shared/protocol.js'
import { chatPermissionMode } from '../../core/actions/policy.js'
import { cleanSessionName, sameName } from '../../core/sessions/names.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { broadcastSessionList } from '../ws/send.js'
import { log } from '../log.js'
import { errText } from '../errors.js'
import { checkoutById, makeWorktree } from './checkouts.js'
import { lastReplyText } from './mentions.js'
import { createSession, getOrRevive } from './sessions.js'

/** At most this many sessions in one start_session call. */
export const MAX_STARTED_PER_CALL = 6
/** A backstop on two chats messaging each other forever: messages one session may send per hour. */
const MAX_MESSAGES_PER_HOUR = 30

export type StartSpec = { name: string; title?: string; prompt: string; mode?: 'normal' | 'plan'; worktree?: string }

const sent = new WeakMap<WorkspaceRuntime, Map<string, number[]>>()

/** The session holding `name`, if any. */
export function sessionByName(rt: WorkspaceRuntime, name: string): StoredSession | undefined {
  for (const row of rt.rows.values()) if (sameName(row.name, name)) return row
  return undefined
}

/** A name that is valid and free (for `forId`, its own name counts as free). Throws why not. */
function freeName(rt: WorkspaceRuntime, raw: string, forId?: string): string {
  const clean = cleanSessionName(raw)
  if (!clean.ok) throw new Error(clean.error)
  const holder = sessionByName(rt, clean.name)
  if (holder && holder.id !== forId) throw new Error(`the name "${clean.name}" is taken by the session "${holder.title}"`)
  return clean.name
}

/**
 * Set or clear a session's name: from `/rename` in a chat, or a started
 * session's birth. Claude Code gets the same name in its own transcript, so
 * `claude --resume` lists it too; a session it hasn't seen yet takes it at
 * spawn instead (LiveSession passes `title`).
 */
export async function setSessionNameOp(rt: WorkspaceRuntime, sessionId: string, raw: string): Promise<string | null> {
  const row = rt.rows.get(sessionId)
  if (!row) throw new Error('unknown session')
  const name = raw.trim() ? freeName(rt, raw, row.id) : null
  await rt.store.sessions.setName(row.id, name)
  row.name = name
  if (name && row.sdkSessionId && row.provider === 'claude') {
    await renameSession(row.sdkSessionId, name, { dir: row.cwd }).catch((err: unknown) => log('warn', 'session', `rename in Claude Code failed: ${errText(err)}`, { sessionId: row.id }))
  }
  broadcastSessionList(rt)
  return name
}

/** Start one chat per spec, each opened with its prompt as a message from `parentId`. */
export async function startSessionsOp(rt: WorkspaceRuntime, parentId: string, specs: StartSpec[]): Promise<({ id: string; name: string; title: string } | { name: string; error: string })[]> {
  const parent = rt.rows.get(parentId)
  if (!parent) throw new Error('unknown session')
  if (!specs.length) throw new Error('nothing to start')
  if (specs.length > MAX_STARTED_PER_CALL) throw new Error(`at most ${MAX_STARTED_PER_CALL} sessions per call`)
  // Every name is checked before any session exists, so a bad one starts none.
  const names = specs.map((s) => freeName(rt, s.name))
  const dup = names.find((n, i) => names.findIndex((m) => sameName(m, n)) !== i)
  if (dup) throw new Error(`the name "${dup}" is used twice`)
  for (const s of specs) if (!s.prompt.trim()) throw new Error(`"${s.name}" has no prompt`)

  const project = parent.projectId ? (await rt.store.projects.list()).find((p) => p.id === parent.projectId) : undefined
  const out: ({ id: string; name: string; title: string } | { name: string; error: string })[] = []
  for (const [i, spec] of specs.entries()) {
    // One that fails (a worktree that can't be made) is reported, and the rest still start.
    try {
      out.push(await startOne(rt, parent, project, spec, names[i]))
    } catch (err) {
      out.push({ name: names[i], error: errText(err) })
    }
  }
  return out
}

async function startOne(rt: WorkspaceRuntime, parent: StoredSession, project: Project | undefined, spec: StartSpec, name: string): Promise<{ id: string; name: string; title: string }> {
  // Same folder as the parent by default; a branch gets its own worktree, so parallel edits don't collide.
  let checkout = checkoutById(rt, parent.checkoutId)
  if (spec.worktree?.trim()) {
    if (!project) throw new Error('this session has no project to make a worktree in')
    checkout = await makeWorktree(rt, project, spec.worktree.trim())
  }
  const title = spec.title?.trim() || name
  const row = await createSession(rt, title, checkout?.path ?? parent.cwd, parent.model, parent.effort, false, chatPermissionMode('claude'), {
    spawn: false,
    projectId: parent.projectId,
    ...(checkout ? { checkoutId: checkout.id } : {}),
    planning: spec.mode === 'plan',
    name,
    startedBy: parent.id,
  })
  broadcastSessionList(rt)
  const live = await getOrRevive(rt, row.id)
  void live?.sendUserMessage(spec.prompt.trim(), undefined, undefined, { from: parent.name ?? parent.title, fromSession: parent.id })
  return { id: row.id, name, title }
}

/** Send `text` to the session named `name`, from `fromId`. Revives it if it has stopped. */
export async function messageSessionOp(rt: WorkspaceRuntime, fromId: string, name: string, text: string): Promise<StoredSession> {
  const from = rt.rows.get(fromId)
  if (!from) throw new Error('unknown session')
  const target = sessionByName(rt, name)
  if (!target) throw new Error(`no session is named "${name}"`)
  if (target.id === fromId) throw new Error('a session cannot message itself')
  if (!text.trim()) throw new Error('the message is empty')
  const now = Date.now()
  const bySender = sent.get(rt) ?? new Map<string, number[]>()
  sent.set(rt, bySender)
  const recent = (bySender.get(fromId) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= MAX_MESSAGES_PER_HOUR) throw new Error(`this session sent ${MAX_MESSAGES_PER_HOUR} messages to other sessions in the last hour; ask the user before sending more`)
  bySender.set(fromId, [...recent, now])
  const live = await getOrRevive(rt, target.id)
  if (!live) throw new Error(`"${name}" could not be started (its folder may be gone)`)
  void live.sendUserMessage(text.trim(), undefined, undefined, { from: from.name ?? from.title, fromSession: from.id })
  return target
}

/** One session as a chat that started it reads it: where it stands and what it last said. */
export async function sessionReport(rt: WorkspaceRuntime, row: StoredSession, withReply: boolean) {
  const l = rt.live.get(row.id)
  const state = l?.waiting ? 'waiting on the user' : l?.status === 'running' || l?.workflows ? 'working' : l?.status === 'error' ? 'error' : 'idle'
  return {
    name: row.name,
    title: row.title,
    id: row.id,
    state,
    ...(l?.waiting && l.waitingOn ? { waitingOn: l.waitingOn } : {}),
    cwd: row.cwd,
    ...(withReply ? { lastReply: (await lastReplyText(rt, row.id).catch(() => null)) ?? null } : {}),
  }
}

/** The sessions `parentId` started, newest first. */
export function startedBy(rt: WorkspaceRuntime, parentId: string): StoredSession[] {
  return [...rt.rows.values()].filter((r) => r.startedBy === parentId).sort((a, b) => b.createdAt - a.createdAt)
}
