import type { ItemStatus } from '../core/work/state.js'
import { type Artifact, type ArtifactAuthor, type ArtifactInput, type ArtifactWithLinks, isArtifactAuthor, isLinkKind, isLinkRole, type Link, type LinkKind, type LinkRole } from '../shared/protocol.js'
import { log } from './log.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { pExecFile } from './config.js'

// The same tool surface every session gets in-process, matching the stdio
// shim's names/schemas one-for-one (server/mcp.ts) so a web chat and a local
// Claude Code session drive the inbox identically. Handlers call the ops above
// directly, no HTTP round-trip, against THIS workspace's store. Reads are
// auto-allowed in requestPermission; writes surface a permission prompt.
// artifacts + links
//
// Same shape as the item ops: validation once, three callers (HTTP, the
// in-process MCP server, the stdio shim over HTTP). The index does the file
// work; these decide what may be written and by whom.

const HIDDEN_ITEM_STATUSES = new Set<ItemStatus>(['done', 'archived'])

export type OkBody = { ok: true } | { ok: false; error: string }

/** Every artifact with its outgoing links; `hidden` marks the brief of a finished item. */
export async function listArtifactsOp(rt: WorkspaceRuntime, all: boolean): Promise<ArtifactWithLinks[]> {
  await rt.artifacts.refresh()
  const [rows, links] = await Promise.all([rt.store.artifacts.list(), rt.store.links.list()])
  const bySource = new Map<string, Link[]>()
  for (const l of links) {
    if (l.fromKind !== 'artifact') continue
    const list = bySource.get(l.fromId) ?? []
    list.push(l)
    bySource.set(l.fromId, list)
  }
  const out: ArtifactWithLinks[] = []
  for (const a of rows) {
    const mine = bySource.get(a.id) ?? []
    let hidden = false
    for (const l of mine) {
      if (l.role !== 'brief' || l.toKind !== 'item') continue
      const item = await rt.store.items.get(l.toId).catch(() => null)
      if (item?.status && HIDDEN_ITEM_STATUSES.has(item.status)) hidden = true
    }
    if (hidden && !all) continue
    out.push({ ...a, links: mine, hidden })
  }
  return out
}

function linkTargetFrom(raw: unknown): { kind: LinkKind; id: string; role: LinkRole } {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.kind) || l.kind === 'artifact') throw new Error('link kind must be item or session')
  if (typeof l.id !== 'string' || !l.id) throw new Error('a link needs an id')
  if (!isLinkRole(l.role)) throw new Error('link role must be brief, report, context, dispatch or plan')
  return { kind: l.kind, id: l.id, role: l.role }
}

/** Rejects, never repairs, like workItemFrom. */
function artifactInputFrom(raw: unknown, opts: { partial: boolean }): ArtifactInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : undefined
  const body = typeof r.body === 'string' ? r.body : undefined
  if (!opts.partial && !title) throw new Error('title is required')
  if (title !== undefined && !title) throw new Error('title cannot be empty')
  if (title && title.length > 200) throw new Error('title is too long (200 characters max)')
  if (body !== undefined && body.length > 2_000_000) throw new Error('body is too large (2 MB max)')
  if (r.refs !== undefined && !Array.isArray(r.refs)) throw new Error('refs must be an array of strings')
  const refs = Array.isArray(r.refs) ? r.refs.filter((x): x is string => typeof x === 'string') : undefined
  if (r.author !== undefined && !isArtifactAuthor(r.author)) throw new Error('author must be human or model')
  if (r.links !== undefined && !Array.isArray(r.links)) throw new Error('links must be an array')
  const links = Array.isArray(r.links) ? r.links.map(linkTargetFrom) : undefined
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(refs ? { refs } : {}),
    ...(isArtifactAuthor(r.author) ? { author: r.author } : {}),
    ...(links ? { links } : {}),
  }
}

/** A link's endpoints must exist in this workspace. A dangling link is a bug, not data. */
async function assertLinkable(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<void> {
  if (kind === 'item') {
    if (!(await rt.store.items.get(id))) throw new Error(`no work item ${id}`)
  } else if (kind === 'session') {
    if (!rt.rows.has(id)) throw new Error(`no session ${id}`)
  } else if (!(await rt.store.artifacts.get(id))) throw new Error(`no artifact ${id}`)
}

export async function createArtifactOp(rt: WorkspaceRuntime, raw: unknown, defaultAuthor: ArtifactAuthor): Promise<Artifact> {
  const input = artifactInputFrom(raw, { partial: false })
  for (const l of input.links ?? []) await assertLinkable(rt, l.kind, l.id)
  const artifact = await rt.artifacts.create({
    title: input.title ?? 'Untitled',
    body: input.body ?? '',
    author: input.author ?? defaultAuthor,
    ...(input.refs ? { refs: input.refs } : {}),
  })
  for (const l of input.links ?? []) {
    await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: l.kind, toId: l.id, role: l.role })
  }
  log('info', 'artifacts', `created ${artifact.path}`, { id: artifact.id, author: artifact.author, workspace: rt.meta.id })
  return artifact
}

/**
 * Edit in place. `by` is who is asking: a human may edit anything; the model
 * may only rewrite what the model wrote. A human's note it can propose to,
 * never overwrite (.docs/next-version.md).
 */
export async function updateArtifactOp(rt: WorkspaceRuntime, id: string, raw: unknown, by: ArtifactAuthor): Promise<Artifact> {
  const input = artifactInputFrom(raw, { partial: true })
  if (input.title === undefined && input.body === undefined && input.refs === undefined) throw new Error('nothing to change')
  const cur = await rt.store.artifacts.get(id)
  if (!cur) throw new Error('no such artifact')
  if (by === 'model' && cur.author !== 'model') {
    throw new Error('this artifact is human-authored — propose the change to the user instead of rewriting it')
  }
  const artifact = await rt.artifacts.update(id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
  })
  log('info', 'artifacts', `updated ${artifact.path}`, { id, by, workspace: rt.meta.id })
  return artifact
}

export async function addLinkOp(rt: WorkspaceRuntime, raw: unknown): Promise<Link> {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.fromKind) || !isLinkKind(l.toKind)) throw new Error('fromKind and toKind must be artifact, item or session')
  if (typeof l.fromId !== 'string' || !l.fromId || typeof l.toId !== 'string' || !l.toId) throw new Error('need fromId and toId')
  if (!isLinkRole(l.role)) throw new Error('role must be brief, report, context, dispatch or plan')
  await assertLinkable(rt, l.fromKind, l.fromId)
  await assertLinkable(rt, l.toKind, l.toId)
  return rt.store.links.add({ fromKind: l.fromKind, fromId: l.fromId, toKind: l.toKind, toId: l.toId, role: l.role })
}

/** Both directions, de-duplicated: everything that points at or from one entity. */
export async function linksFor(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<Link[]> {
  const [to, from] = await Promise.all([rt.store.links.forTarget(kind, id), rt.store.links.forSource(kind, id)])
  const seen = new Set<string>()
  return [...to, ...from].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
}

/** Open a file in whatever the OS opens .md with. The server runs on the user's own machine. */
export async function openInEditor(abs: string): Promise<void> {
  if (process.platform === 'darwin') await pExecFile('open', [abs])
  else if (process.platform === 'win32') await pExecFile('cmd', ['/c', 'start', '', abs])
  else await pExecFile('xdg-open', [abs])
}
