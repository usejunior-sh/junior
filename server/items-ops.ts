import { randomUUID } from 'node:crypto'
import { type FileRef, type InboxSnapshot, isImageMediaType, type ItemDetail, type ItemImage, type ItemImageEdit, type Link, MAX_FILES_PER_ITEM, MAX_IMAGE_BYTES, MAX_IMAGES_PER_ITEM, type SessionContext, type WorkItem } from '../shared/protocol.js'
import { applyImageEdits } from './itemImages.js'
import { applyItemFileEdits, copyItemFilesToSession, itemFileEdits, missingFilesNote } from './attachments.js'
import { log } from './log.js'
import type { ItemStatus } from '../core/work/state.js'
import type { UpsertOutcome } from '../core/store/types.js'
import { dueInput } from '../core/work/due.js'
import { reasonOf } from '../core/work/fields.js'
import { taskSummary } from '../core/work/tasks.js'
import { NOT_USEFUL_UNDO_MS, quietKey, waitKeyOf } from '../core/junior/ledger.js'
import { ANY_ITEM_ID_RE, ITEM_STATUSES, manualItemFrom, MAX_URLS_PER_ITEM, workItemFrom } from './validate.js'
import { BASE64, base64Bytes } from './ws/parse.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { invalidateInbox } from './ws/send.js'
import { getInbox, listItemsByStatus } from './inbox/sync.js'
import { flowFor } from './inbox/flow.js'
import { upsertItem } from './settings-ops.js'
import { defaultProject } from './session/sessions.js'

/**
 * The `urls` field of an item save: the complete desired list of the human's
 * links, trimmed and deduplicated. Absent leaves them alone, `[]` clears them.
 * Refused, not repaired, like images, a link that silently vanishes is worse.
 */
export function itemUrls(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('urls must be a list of http(s) links')
  const out: string[] = []
  for (const entry of v) {
    const u = typeof entry === 'string' ? entry.trim() : ''
    if (!/^https?:\/\/\S+$/.test(u) || u.length > 2000) throw new Error('each link must be an http(s) URL')
    if (!out.includes(u)) out.push(u)
  }
  if (out.length > MAX_URLS_PER_ITEM) throw new Error(`up to ${MAX_URLS_PER_ITEM} links per item`)
  return out
}

/**
 * The `images` field of an item save: `{ id }` keeps an image the item already
 * holds, anything else is a new base64 upload, judged by the same rules as a
 * chat attachment. The list is the complete desired set, absent leaves the
 * item's images alone, `[]` drops them all. Unlike the socket's
 * `imageAttachments`, a bad entry is *refused*, not dropped: this is a form,
 * and a screenshot that silently vanishes on save is worse than an error.
 */
export function itemImageEdits(raw: Record<string, unknown>): ItemImageEdit[] | undefined {
  const v = raw.images
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('images must be a list')
  if (v.length > MAX_IMAGES_PER_ITEM) throw new Error(`up to ${MAX_IMAGES_PER_ITEM} images per item`)
  const out: ItemImageEdit[] = []
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null) throw new Error('each image must be an object')
    const e = entry as Record<string, unknown>
    if (typeof e.id === 'string' && e.id) {
      out.push({ id: e.id })
      continue
    }
    if (!isImageMediaType(e.mediaType)) throw new Error('images must be PNG, JPEG, GIF or WebP')
    if (typeof e.data !== 'string' || !e.data || !BASE64.test(e.data)) throw new Error('image data must be base64')
    if (base64Bytes(e.data) > MAX_IMAGE_BYTES)
      throw new Error(`each image must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`)
    out.push({
      mediaType: e.mediaType,
      data: e.data,
      ...(typeof e.name === 'string' && e.name ? { name: e.name.slice(0, 200) } : {}),
    })
  }
  return out
}

/**
 * Write the item's new image set to disk and record the refs. Works for any
 * item, not just manual ones. A screenshot pasted onto a GitHub item's
 * description is the same thing.
 */
export async function setItemImagesOp(rt: WorkspaceRuntime, id: string, edits: ItemImageEdit[]): Promise<ItemImage[]> {
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')
  const images = await applyImageEdits(rt.attachmentsDir, id, item.images ?? [], edits)
  await rt.store.items.setImages(id, images)
  invalidateInbox(rt)
  return images
}

/**
 * Check an item save's `files` against what the item holds, before anything is
 * written: a bad id or a vanished upload refuses the whole save. `undefined` =
 * the key is absent, files untouched.
 */
export const itemFilePlan = (rt: WorkspaceRuntime, raw: unknown, held: readonly FileRef[]) =>
  itemFileEdits(rt.attachmentsDir, (raw ?? {}) as Record<string, unknown>, held, MAX_FILES_PER_ITEM)

/**
 * An item's files, copied into a session about to start. A file gone from disk
 * is logged with the item and file, and named in `note` for the first message.
 */
export async function itemFilesForSession(rt: WorkspaceRuntime, sessionId: string, item: { id: string; files?: readonly FileRef[] }) {
  const { files, missing } = await copyItemFilesToSession(rt.attachmentsDir, sessionId, item.id, item.files)
  for (const f of missing) log('warn', 'attachments', `item file missing on disk, not attached: ${f.name}`, { itemId: item.id, session: sessionId, workspace: rt.meta.id })
  return { files, note: missingFilesNote(missing) }
}

/** Move the planned files into the item's folder, drop the ones left out, record the refs. Any item, like images. */
export async function setItemFilesOp(rt: WorkspaceRuntime, id: string, plan: NonNullable<Awaited<ReturnType<typeof itemFilePlan>>>): Promise<FileRef[]> {
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')
  const files = await applyItemFileEdits(rt.attachmentsDir, id, item.files ?? [], plan)
  await rt.store.items.setFiles(id, files)
  invalidateInbox(rt)
  return files
}

// Work-item operations. One core, three callers: the HTTP routes below, the
// in-process MCP server that web chats get (rt.juniorMcp(), one per session), and the
// stdio shim (server/mcp.ts) which reaches them over HTTP. Every transport
// funnels through these functions, so list/create/edit/upsert/resolve behave
// identically no matter who calls them. Validation stays in workItemFrom/
// manualItemFrom: the single source of truth, never duplicated per transport.
export async function listItemsOp(
  rt: WorkspaceRuntime,
  filter: { source?: string; kind?: string; status?: string } = {},
): Promise<InboxSnapshot['items']> {
  // 'open' is the live inbox (scanned + ranked + cached); any other status is
  // read straight from the durable store, same as the status tabs.
  const status = filter.status && filter.status !== 'open' ? filter.status : null
  if (status && !ITEM_STATUSES.has(status as ItemStatus)) throw new Error(`unknown status: ${status}`)
  let items = status ? await listItemsByStatus(rt, status as ItemStatus) : (await getInbox(rt, false)).items
  if (filter.source) items = items.filter((i) => i.source === filter.source)
  if (filter.kind) items = items.filter((i) => i.kind === filter.kind)
  return items
}

/**
 * One work item, whole. The counterpart to listItemsOp: that one answers "what
 * should I do next" and is therefore open-only and repo-scoped, this one
 * answers "tell me about this one" and filters nothing. Every neighbour it
 * returns carries an id and a title, so a reader handed an id, by a `linked`
 * sibling, by an old link, by the user, can always follow it one more hop.
 */
export async function itemDetailOp(rt: WorkspaceRuntime, rawId: unknown): Promise<ItemDetail> {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')

  const [all, links] = await Promise.all([rt.store.items.listAll(), rt.store.links.forTarget('item', id)])

  // Ref-siblings, transitively, the same component the inbox folds into one
  // card (core/work/link.ts), so detail and card never disagree about who is
  // related to whom. Unlike the card, this reaches items of any status.
  const byId = new Map(all.map((i) => [i.id, i]))
  const refsOf = (i: WorkItem) => [i.id, ...(i.refs ?? [])]
  const owners = new Map<string, string[]>()
  for (const i of all) {
    for (const ref of refsOf(i)) {
      const list = owners.get(ref)
      if (list) list.push(i.id)
      else owners.set(ref, [i.id])
    }
  }
  const seen = new Set([id])
  const queue = [id]
  while (queue.length) {
    const cur = byId.get(queue.shift()!)
    if (!cur) continue
    for (const ref of refsOf(cur)) {
      for (const other of owners.get(ref) ?? []) {
        if (seen.has(other)) continue
        seen.add(other)
        queue.push(other)
      }
    }
  }
  const linked = [...seen]
    .filter((sid) => sid !== id)
    .map((sid) => byId.get(sid)!)
    .map((i) => ({ id: i.id, title: i.title, source: i.source as string, url: i.url, repo: i.repo, status: i.status ?? 'open' }))

  const [artifacts, sessions, tasks] = await Promise.all([linkedArtifacts(rt, links), linkedSessions(rt, links), rt.store.tasks.list(id)])

  // Ranked only when it happens to be in the cached open inbox: ranking means
  // a scan, and reading one item must never pay for one.
  const scored = rt.inboxCache?.items.find((i) => i.id === id)
  return {
    item,
    rank: scored ? { score: scored.score, group: scored.group, reason: scored.rankWhy } : null,
    linked,
    artifacts,
    sessions,
    flow: await flowFor(rt, item),
    reason: reasonOf(item),
    tasks,
  }
}

/** The artifacts among a set of incoming links, resolved to id/title/author/path. */
async function linkedArtifacts(rt: WorkspaceRuntime, links: Link[]): Promise<ItemDetail['artifacts']> {
  const rows = await Promise.all(
    links
      .filter((l) => l.fromKind === 'artifact')
      .map(async (l) => {
        const a = await rt.store.artifacts.get(l.fromId)
        return a ? { id: a.id, title: a.title, role: l.role, author: a.author, path: a.path } : null
      }),
  )
  return rows.filter((a): a is NonNullable<typeof a> => a !== null)
}

/** The sessions among a set of incoming links, resolved to id/title/kind. */
async function linkedSessions(rt: WorkspaceRuntime, links: Link[]): Promise<ItemDetail['sessions']> {
  const rows = await Promise.all(
    links
      .filter((l) => l.fromKind === 'session')
      .map(async (l) => {
        const row = rt.rows.get(l.fromId) ?? (await rt.store.sessions.get(l.fromId))
        return row ? { id: row.id, title: row.title, role: l.role, kind: row.kind, updatedAt: row.updatedAt } : null
      }),
  )
  return rows.filter((s): s is NonNullable<typeof s> => s !== null)
}

/**
 * What a session is allowed to know about itself. A session is spawned before
 * `create_session` links it to a work item, so its system prompt cannot name
 * the item. It can only point here (shared/juniorContext.ts).
 */
export async function sessionContextOp(rt: WorkspaceRuntime, rawId: unknown): Promise<SessionContext> {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!id) throw new Error('need a session id')
  const row = rt.rows.get(id) ?? (await rt.store.sessions.get(id))
  if (!row) throw new Error('no such session')
  const [out, incoming] = await Promise.all([rt.store.links.forSource('session', id), rt.store.links.forTarget('session', id)])
  const itemLink = out.find((l) => l.toKind === 'item')
  const [item, artifacts] = await Promise.all([
    itemLink ? itemDetailOp(rt, itemLink.toId).catch(() => null) : Promise.resolve(null),
    linkedArtifacts(rt, incoming),
  ])
  return {
    workspace: { id: rt.meta.id, name: rt.meta.name, artifactsRoot: rt.artifacts.root },
    session: { id: row.id, title: row.title, kind: row.kind, cwd: row.cwd },
    item,
    artifacts,
  }
}

export async function upsertItemOp(rt: WorkspaceRuntime, raw: unknown): Promise<UpsertOutcome> {
  const parsed = workItemFrom(raw)
  if ('error' in parsed) throw new Error(parsed.error)
  const { outcome } = await upsertItem(rt, parsed.item)
  if (outcome !== 'unchanged') invalidateInbox(rt)
  return outcome
}

export async function resolveItemOp(rt: WorkspaceRuntime, rawId: unknown): Promise<void> {
  const id = typeof rawId === 'string' ? rawId : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  await rt.store.items.transition(id, { status: 'done', actor: 'agent' })
  invalidateInbox(rt)
  log('info', 'inbox', `done: ${id} (by agent)`, { id, actor: 'agent', workspace: rt.meta.id })
}

export async function createManualOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const { images, ...input } = await manualItemFrom(rt, raw)
  const filePlan = await itemFilePlan(rt, raw, [])
  const due = dueInput((raw as Record<string, unknown>).due, Date.now())
  const id = `manual:${randomUUID()}`
  await rt.store.items.createManual({ id, ...input, projectId: input.projectId ?? (await defaultProject(rt))?.id })
  if (due) await rt.store.items.setDue(id, due)
  // The item has to exist before its images can hang off it, the folder is
  // named after the id the line above minted.
  try {
    if (images?.length) await setItemImagesOp(rt, id, images)
    if (filePlan?.order.length) await setItemFilesOp(rt, id, filePlan)
  } catch (err) {
    // The caller is told the create failed and will try again: don't leave this half-made item behind to be duplicated.
    await rt.store.items.transition(id, { status: 'archived', actor: 'user', detail: { reason: 'deleted by user', cause: 'attachments failed on create' } }).catch(() => {})
    invalidateInbox(rt)
    throw err
  }
  invalidateInbox(rt)
  log('info', 'inbox', `manual item created: ${input.title ?? id}`, { id, workspace: rt.meta.id })
  return id
}

// Edits target manual (user-authored) items only. Scanned items are
// upsert-newer-wins, so a free-form edit would be clobbered by the next scan.
// Reject those with a clear message rather than silently no-op'ing.
export async function editManualOp(rt: WorkspaceRuntime, id: string, raw: unknown): Promise<void> {
  if (!id || !id.startsWith('manual:'))
    throw new Error('edit_work_item only edits manual items (id must start with "manual:")')
  const { images, ...patch } = await manualItemFrom(rt, raw, { partial: true })
  const filePlan = await itemFilePlan(rt, raw, (await rt.store.items.get(id))?.files ?? [])
  const due = dueInput((raw as Record<string, unknown>).due, Date.now())
  await rt.store.items.updateManual(id, patch)
  if (due !== undefined) await rt.store.items.setDue(id, due)
  if (images) await setItemImagesOp(rt, id, images)
  if (filePlan) await setItemFilesOp(rt, id, filePlan)
  invalidateInbox(rt)
}

/** How long after a "not useful" mark its undo is taken (core/junior/ledger.ts: the longest hold of the notice, plus slack). */
export { NOT_USEFUL_UNDO_MS }

async function itemForNote(rt: WorkspaceRuntime, raw: unknown): Promise<WorkItem> {
  const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such item')
  return item
}

/**
 * "Not useful" on a Needs you row: it shouldn't have reached you. One
 * `not-useful` event by you, and a stamp (core/junior/ledger.ts quietKey) that
 * keeps it off Needs you until something new happens on it. The same stamp
 * twice is a no-op, so a stale client can't write a second event. Your own
 * signal: HTTP only, never on the MCP surface.
 */
export async function markNotUsefulOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<void> {
  const item = await itemForNote(rt, raw)
  const tasks = taskSummary(await rt.store.tasks.list(item.id)) ?? undefined
  const stamp = quietKey({ updatedAt: item.updatedAt, tasks })
  if (item.notUseful === stamp) return
  await rt.store.items.note(item.id, 'not-useful', 'user', now, { from: 'needs', wait: waitKeyOf({ tasks }) })
  await rt.store.items.setFields(item.id, { notUseful: stamp })
  invalidateInbox(rt)
  log('info', 'inbox', `not useful: ${item.id} (by user)`, { id: item.id, workspace: rt.meta.id })
}

/** Undo within seconds: the mark's event is taken back and the stamp cleared. Later, the mark stands. */
export async function undoNotUsefulOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<void> {
  const item = await itemForNote(rt, raw)
  if (!(await rt.store.items.unnote(item.id, 'not-useful', 'user', now - NOT_USEFUL_UNDO_MS))) throw new Error('the undo window has passed')
  await rt.store.items.setFields(item.id, { notUseful: null })
  invalidateInbox(rt)
  log('info', 'inbox', `not useful, undone: ${item.id} (by user)`, { id: item.id, workspace: rt.meta.id })
}
