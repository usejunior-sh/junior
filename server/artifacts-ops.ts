import path from 'node:path'
import type { ItemStatus } from '../core/work/state.js'
import {
  ARTIFACT_BODY_MAX_CHARS,
  type Artifact,
  type ArtifactAuthor,
  type ArtifactInput,
  type ArtifactToolResult,
  type ArtifactWithLinks,
  type ArtifactWriteAction,
  isArtifactAuthor,
  isArtifactFormat,
  isLinkKind,
  isLinkRole,
  isTextFormat,
  type Link,
  type LinkKind,
  type LinkRole,
} from '../shared/protocol.js'
import { log } from './log.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { pExecFile } from './config.js'
import { openFileIn, revealFile } from './editors.js'
import { resolveSource } from './artifact-source.js'

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
  if (!isLinkRole(l.role)) throw new Error('link role must be brief, report, context, dispatch, plan or output')
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
  if (body !== undefined && body.length > ARTIFACT_BODY_MAX_CHARS) {
    throw new Error('body is too large (2 MB max) — put the file on disk and pass from:')
  }
  if (r.format !== undefined && !isArtifactFormat(r.format)) throw new Error('format must be md, html, csv, txt, json, svg, pdf, png, jpg, gif or webp')
  if (r.from !== undefined && (typeof r.from !== 'string' || !r.from || r.from.length > 4096)) throw new Error('from must be an absolute file path')
  if (r.note !== undefined && typeof r.note !== 'string') throw new Error('note must be a string')
  if (typeof r.note === 'string' && r.note.length > 500) throw new Error('note is too long (500 characters max)')
  if (r.refs !== undefined && !Array.isArray(r.refs)) throw new Error('refs must be an array of strings')
  const refs = Array.isArray(r.refs) ? r.refs.filter((x): x is string => typeof x === 'string') : undefined
  if (r.author !== undefined && !isArtifactAuthor(r.author)) throw new Error('author must be human or model')
  if (r.links !== undefined && !Array.isArray(r.links)) throw new Error('links must be an array')
  const links = Array.isArray(r.links) ? r.links.map(linkTargetFrom) : undefined
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(isArtifactFormat(r.format) ? { format: r.format } : {}),
    ...(typeof r.from === 'string' ? { from: r.from } : {}),
    ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim() } : {}),
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

/** The calling session, when the door knows it: only the in-process server does. */
export type WriteCtx = { sessionId?: string }

export type ArtifactWriteResult = {
  artifact: Artifact
  action: ArtifactWriteAction
  version: number
  /** absolute path of the file */
  abs: string
  hint?: string
}

const absOf = (rt: WorkspaceRuntime, a: Artifact): string => path.join(rt.artifacts.root, ...a.path.split('/'))

/** The one-line JSON the in-process write tools answer with: what the chat card is made from. */
export function toolResult(r: ArtifactWriteResult, hint?: string): ArtifactToolResult {
  const a = r.artifact
  const h = hint ?? r.hint
  return {
    triage: 'artifact',
    action: r.action,
    id: a.id,
    title: a.title,
    format: a.format,
    version: r.version,
    size: a.size,
    history: a.history,
    path: a.path,
    abs: r.abs,
    ...(h ? { hint: h } : {}),
  }
}

/** The session this call came from becomes the artifact's `output` link, and must exist. */
async function outputSession(rt: WorkspaceRuntime, ctx: WriteCtx): Promise<string | undefined> {
  if (!ctx.sessionId) return undefined
  await assertLinkable(rt, 'session', ctx.sessionId)
  return ctx.sessionId
}

const linkOutput = (rt: WorkspaceRuntime, artifactId: string, sessionId: string) =>
  rt.store.links.add({ fromKind: 'artifact', fromId: artifactId, toKind: 'session', toId: sessionId, role: 'output' })

/**
 * New artifact. A model call (a session, or an external client) may publish any
 * format: text ones as `body`, the rest as `from`, a file triage copies in. A
 * human call writes markdown, as before. Calls from a session link the artifact
 * to it as `output`, so the chat and the session's list can show it.
 */
export async function createArtifactOp(
  rt: WorkspaceRuntime,
  raw: unknown,
  defaultAuthor: ArtifactAuthor,
  ctx: WriteCtx = {},
): Promise<ArtifactWriteResult> {
  const input = artifactInputFrom(raw, { partial: false })
  const author = input.author ?? defaultAuthor
  if (input.from !== undefined && author !== 'model') throw new Error('from: is for files a session made; notes you write are markdown')
  if (input.body !== undefined && input.from !== undefined) throw new Error('pass body or from, not both')
  let format = input.format
  let bytes: Uint8Array | undefined
  const source = ctx.sessionId
  if (input.from !== undefined) {
    const src = await resolveSource(rt, source, input.from, input.format)
    format = src.format
    bytes = src.bytes
  } else {
    format ??= 'md'
    if (!isTextFormat(format)) throw new Error(`${format} files need from: <absolute path>`)
    // a human's blank note has no body yet; everything else must say what it holds
    if (input.body === undefined && !(format === 'md' && author === 'human')) throw new Error('pass body (text formats) or from (a file path)')
  }
  if (author === 'human' && format !== 'md') throw new Error('notes you write are markdown')
  for (const l of input.links ?? []) await assertLinkable(rt, l.kind, l.id)
  const session = await outputSession(rt, ctx)
  const artifact = await rt.artifacts.create({
    title: input.title ?? 'Untitled',
    body: input.body ?? '',
    author,
    ...(format ? { format } : {}),
    ...(bytes ? { bytes } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(session ? { session } : {}),
    ...(input.refs ? { refs: input.refs } : {}),
  })
  if (session) await linkOutput(rt, artifact.id, session)
  for (const l of input.links ?? []) {
    await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: l.kind, toId: l.id, role: l.role })
  }
  // The index announced the file before its links existed; announce again so a list built from both is whole.
  rt.artifacts.touch()
  log('info', 'artifacts', `created ${artifact.path}`, { id: artifact.id, author: artifact.author, workspace: rt.meta.id })
  return { artifact, action: 'created', version: artifact.version, abs: absOf(rt, artifact) }
}

/**
 * Edit in place; a content change is a new version. `by` is who is asking: a
 * human may edit anything; the model may only rewrite what the model wrote. A
 * human's note it can propose to, never overwrite (.docs/next-version.md).
 */
export async function updateArtifactOp(
  rt: WorkspaceRuntime,
  id: string,
  raw: unknown,
  by: ArtifactAuthor,
  ctx: WriteCtx = {},
): Promise<ArtifactWriteResult> {
  const input = artifactInputFrom(raw, { partial: true })
  if (input.title === undefined && input.body === undefined && input.from === undefined && input.refs === undefined) {
    throw new Error('nothing to change')
  }
  const cur = await rt.store.artifacts.get(id)
  if (!cur) throw new Error('no such artifact')
  if (by === 'model' && cur.author !== 'model') {
    throw new Error('this artifact is human-authored — propose the change to the user instead of rewriting it')
  }
  if (input.body !== undefined && input.from !== undefined) throw new Error('pass body or from, not both')
  if (input.from !== undefined && by !== 'model') throw new Error('from: is for files a session made')
  if (input.body !== undefined && !isTextFormat(cur.format)) throw new Error(`${cur.format} files need from: <absolute path>`)
  let bytes: Uint8Array | undefined
  if (input.from !== undefined) bytes = (await resolveSource(rt, ctx.sessionId, input.from, cur.format)).bytes
  const session = await outputSession(rt, ctx)
  const { artifact, changed } = await rt.artifacts.revise(id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(bytes ? { bytes } : {}),
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(session ? { session } : {}),
  })
  // The session that revises it shows its card, so it gets the link too (idempotent).
  if (session) await linkOutput(rt, id, session)
  rt.artifacts.touch()
  log('info', 'artifacts', `updated ${artifact.path}`, { id, by, workspace: rt.meta.id })
  const hint = !changed
    ? 'no new version: identical content'
    : artifact.version === cur.version
      ? 'title or refs changed; no new version, the content is identical'
      : undefined
  return { artifact, action: changed ? 'updated' : 'unchanged', version: artifact.version, abs: absOf(rt, artifact), ...(hint ? { hint } : {}) }
}

export async function addLinkOp(rt: WorkspaceRuntime, raw: unknown): Promise<Link> {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.fromKind) || !isLinkKind(l.toKind)) throw new Error('fromKind and toKind must be artifact, item or session')
  if (typeof l.fromId !== 'string' || !l.fromId || typeof l.toId !== 'string' || !l.toId) throw new Error('need fromId and toId')
  if (!isLinkRole(l.role)) throw new Error('role must be brief, report, context, dispatch, plan or output')
  await assertLinkable(rt, l.fromKind, l.fromId)
  await assertLinkable(rt, l.toKind, l.toId)
  const link = await rt.store.links.add({ fromKind: l.fromKind, fromId: l.fromId, toKind: l.toKind, toId: l.toId, role: l.role })
  rt.artifacts.touch()
  return link
}

/** Both directions, de-duplicated: everything that points at or from one entity. */
export async function linksFor(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<Link[]> {
  const [to, from] = await Promise.all([rt.store.links.forTarget(kind, id), rt.store.links.forSource(kind, id)])
  const seen = new Set<string>()
  return [...to, ...from].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
}

/**
 * Show an artifact's file on this Mac: in an editor, selected in the file
 * manager, or in whatever the OS opens that type with. The server runs on the
 * user's own machine; the route refuses anyone else.
 */
export async function openArtifactFile(abs: string, mode: 'editor' | 'reveal' | 'default'): Promise<void> {
  if (mode === 'editor') await openFileIn(abs)
  else if (mode === 'reveal') await revealFile(abs)
  else await openInEditor(abs)
}

/** Open a file in whatever the OS opens .md with. The server runs on the user's own machine. */
export async function openInEditor(abs: string): Promise<void> {
  if (process.platform === 'darwin') await pExecFile('open', [abs])
  else if (process.platform === 'win32') await pExecFile('cmd', ['/c', 'start', '', abs])
  else await pExecFile('xdg-open', [abs])
}
