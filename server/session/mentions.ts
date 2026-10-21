import { stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { isTextFormat, MAX_INLINE_FILE_BYTES, MAX_INLINE_TOTAL_BYTES, type Mention, type ResolvedMention, type SdkMessage } from '../../shared/protocol.js'
import { resolveFileMention } from '../files.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { summarize } from './summaries.js'
import { checkoutById } from './checkouts.js'

/** The live subprocess for a session, starting one (with `resume`) if needed. */
// `@` mentions: resolved at send time into blocks the model reads

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… [truncated — ${s.length - n} more characters]` : s)

/** What a session last said, for a `@session:` stub. Its final reply, else the last assistant text. */
async function lastReplyText(rt: WorkspaceRuntime, sessionId: string): Promise<string | null> {
  const last = await rt.store.events.lastSeq(sessionId)
  const events = await rt.store.events.read(sessionId, Math.max(0, last - 200))
  let assistant: string | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.kind !== 'sdk') continue
    const m = ev.message as SdkMessage & { result?: unknown }
    if (m.type === 'result' && typeof m.result === 'string' && m.result) return m.result
    if (!assistant && m.type === 'assistant') {
      const text = (m.message?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
      if (text) assistant = text
    }
  }
  return assistant
}

const attachmentTag = (kind: string, attrs: Record<string, string | number | undefined>, body?: string) => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join('')
  return body === undefined ? `<attachment kind="${kind}"${a} />` : `<attachment kind="${kind}"${a}>\n${body}\n</attachment>`
}

/**
 * Turn the composer's mentions into what rides the message. Files are read
 * inside `cwd` (small text inlined, everything else passed as a path with a
 * note); items and sessions become short summaries. The returned `resolved`
 * list is what the event log keeps, so the transcript can show what landed.
 */
export async function resolveMentions(
  rt: WorkspaceRuntime,
  cwd: string,
  mentions: Mention[],
): Promise<{ resolved: ResolvedMention[]; blocks: string[] }> {
  const resolved: ResolvedMention[] = []
  const blocks: string[] = []
  let budget = MAX_INLINE_TOTAL_BYTES
  const seen = new Set<string>()
  for (const m of mentions) {
    const key = `${m.kind}:${m.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    if (m.kind === 'file') {
      const f = await resolveFileMention(cwd, m.ref)
      switch (f.kind) {
        case 'text': {
          if (f.bytes > budget) {
            const error = 'over the per-message inline budget'
            resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error })
            blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: `not inlined: ${error} — read it from disk` }))
            break
          }
          budget -= f.bytes
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: true })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes }, f.text))
          break
        }
        case 'large': {
          const error = `too large to inline (${Math.round(f.bytes / 1024)} KB)`
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: `not inlined: ${error} — read the parts you need from disk` }))
          break
        }
        case 'binary': {
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error: 'binary file' })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: 'binary file — not inlined' }))
          break
        }
        case 'dir': {
          const listing = f.entries.join('\n')
          budget -= listing.length
          resolved.push({ ...m, ref: f.rel, inlined: true })
          blocks.push(attachmentTag('directory', { path: f.rel, entries: f.entries.length }, listing))
          break
        }
        case 'error':
          resolved.push({ ...m, inlined: false, error: f.error })
          blocks.push(attachmentTag('file', { path: m.ref, note: `could not be attached: ${f.error}` }))
          break
      }
    } else if (m.kind === 'item') {
      const scored = rt.inboxCache?.items.find((i) => i.id === m.ref)
      const item = scored ?? (await rt.store.items.get(m.ref).catch(() => null))
      if (!item) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('work_item', { id: m.ref, note: 'could not be attached: not found in this workspace' }))
        continue
      }
      const lines = [
        `title: ${item.title}`,
        `kind: ${item.kind} (${item.source})`,
        item.url && `url: ${item.url}`,
        item.repo && `where: ${item.repo}`,
        item.author && `author: ${item.author}`,
        item.status && `status: ${item.status}`,
        scored && `rank: ${scored.score} — ${scored.rankWhy}`,
        item.why && `why: ${item.why}`,
        item.description && `description: ${item.description}`,
        item.urls?.length ? `links: ${item.urls.join(', ')}` : undefined,
        item.refs?.length ? `refs: ${item.refs.join(', ')}` : undefined,
      ].filter((l): l is string => typeof l === 'string' && l.length > 0)
      resolved.push({ ...m, label: item.title, inlined: true })
      blocks.push(attachmentTag('work_item', { id: item.id }, lines.join('\n')))
    } else if (m.kind === 'session') {
      const row = rt.rows.get(m.ref)
      if (!row) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('session', { id: m.ref, note: 'could not be attached: no such session in this workspace' }))
        continue
      }
      const sum = summarize(rt, row)
      const last = await lastReplyText(rt, row.id).catch(() => null)
      const lines = [
        `title: ${row.title}`,
        `folder: ${row.cwd}`,
        `status: ${sum.status}`,
        checkoutById(rt, row.checkoutId)?.branch && `branch: ${checkoutById(rt, row.checkoutId)?.branch}`,
        checkoutById(rt, row.checkoutId)?.kind === 'worktree' && 'checkout: a git worktree of its project',
        `last activity: ${new Date(row.updatedAt).toISOString()}`,
        row.sdkSessionId &&
          `claude session id: ${row.sdkSessionId} — its full transcript is under ~/.claude/projects, or \`claude --resume ${row.sdkSessionId}\` from that folder`,
      ].filter((l): l is string => typeof l === 'string' && l.length > 0)
      const body = lines.join('\n') + (last ? `\n\nlast reply:\n${clip(last, 4000)}` : '')
      resolved.push({ ...m, label: row.title, inlined: true })
      blocks.push(attachmentTag('session', { id: row.id }, body))
    } else if (m.kind === 'artifact') {
      const a = await rt.artifacts.read(m.ref).catch(() => null)
      if (!a) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('artifact', { id: m.ref, note: 'could not be attached: no such artifact in this workspace' }))
        continue
      }
      const attrs = { id: a.artifact.id, title: a.artifact.title, author: a.artifact.author, path: a.abs }
      if (!isTextFormat(a.artifact.format)) {
        // a pdf or image has no text to inline; the path is what the model can open
        resolved.push({ ...m, label: a.artifact.title, bytes: a.artifact.size, inlined: false, error: 'binary file' })
        blocks.push(attachmentTag('artifact', { ...attrs, format: a.artifact.format, bytes: a.artifact.size, note: 'binary file, read it from disk' }))
        continue
      }
      const bytes = Buffer.byteLength(a.body, 'utf8')
      if (bytes > MAX_INLINE_FILE_BYTES || bytes > budget) {
        const error = bytes > MAX_INLINE_FILE_BYTES ? `too large to inline (${Math.round(bytes / 1024)} KB)` : 'over the per-message inline budget'
        resolved.push({ ...m, label: a.artifact.title, bytes, inlined: false, error })
        blocks.push(attachmentTag('artifact', { ...attrs, bytes, note: `not inlined: ${error} — read it from disk` }))
        continue
      }
      budget -= bytes
      resolved.push({ ...m, label: a.artifact.title, bytes, inlined: true })
      blocks.push(attachmentTag('artifact', { ...attrs, bytes }, a.body))
    }
  }
  if (blocks.length > 0) {
    blocks.unshift('The user attached the following with @-mentions; the message above refers to them by these names.')
  }
  return { resolved, blocks }
}

/** A folder the `@` picker may list: a session's folder, a project, or anywhere under home. */
export async function isSearchableRoot(rt: WorkspaceRuntime, root: string): Promise<boolean> {
  try {
    if (!(await stat(root)).isDirectory()) return false
  } catch {
    return false
  }
  const under = (base: string) => root === base || root.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  if ([...rt.rows.values()].some((r) => r.cwd === root)) return true
  if ((await rt.store.projects.list()).some((p) => under(p.path))) return true
  return under(os.homedir())
}
