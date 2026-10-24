/**
 * The supervision line (.docs/overnight-2026-10-24/designs/supervision-line.md):
 * one quiet line on an item saying what Junior did that you haven't looked at.
 *
 *   4 files changed, not reviewed by you · 2 sends wait for your OK
 *
 * Files are the paths Junior's file tools (Write, Edit, MultiEdit,
 * NotebookEdit) named in the item's sessions after you last opened the item's
 * file list. Files changed through Bash are not counted. Sends are the item's
 * actions that wait for your OK. The line is null when both counts are zero:
 * nothing renders, no "all reviewed".
 *
 * Pure and browser-safe: time is always an argument.
 */
import { isToolUseBlock, type RawBlock, type SessionEvent } from '../../shared/protocol.js'

/** One file a file tool named, in one session, at one time. */
export type FileTouch = { path: string; sessionId: string; at: number }

export type Supervision = {
  unreviewedFiles: number
  heldSends: number
  /** the full line, ≤ 15 words; null when both counts are zero */
  line: string | null
  /** the phone row's short form; null when both counts are zero */
  short: string | null
}

/** The item page's list shows at most this many files, newest first. All of them are marked seen. */
export const SUPERVISION_LIST_MAX = 12

/** The file tools whose path counts as Junior changing a file. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The separator between the two parts. */
export const SUPERVISION_SEP = ' · '

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** `1 file changed, not reviewed by you` / `{n} files changed, not reviewed by you`; null at zero. */
export function filesPart(n: number): string | null {
  return n > 0 ? `${n} ${plural(n, 'file', 'files')} changed, not reviewed by you` : null
}

/** `1 send waits for your OK` / `{n} sends wait for your OK`; null at zero. */
export function sendsPart(n: number): string | null {
  return n > 0 ? `${n} ${plural(n, 'send waits', 'sends wait')} for your OK` : null
}

/** The phone row's short files part: `{n} files not reviewed`. */
export function filesShort(n: number): string | null {
  return n > 0 ? `${n} ${plural(n, 'file', 'files')} not reviewed` : null
}

/** The phone row's short sends part: `{n} sends wait`. */
export function sendsShort(n: number): string | null {
  return n > 0 ? `${n} ${plural(n, 'send waits', 'sends wait')}` : null
}

const joined = (parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => !!p)
  return kept.length ? kept.join(SUPERVISION_SEP) : null
}

/** The unseen files, newest first, one entry per path (its newest touch wins). With no `seenAt`, every touch is unseen. */
export function unseenFiles(touches: readonly FileTouch[], seenAt: number | null): FileTouch[] {
  const newest = new Map<string, FileTouch>()
  for (const t of touches) {
    if (seenAt !== null && t.at <= seenAt) continue
    const was = newest.get(t.path)
    if (!was || t.at > was.at) newest.set(t.path, t)
  }
  return [...newest.values()].sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
}

/** The line from counts alone: what the client builds from the snapshot's `supervision`. */
export function supervisionLine(files: number, sends: number): Supervision {
  const f = Math.max(0, Math.floor(files))
  const s = Math.max(0, Math.floor(sends))
  return {
    unreviewedFiles: f,
    heldSends: s,
    line: joined([filesPart(f), sendsPart(s)]),
    short: joined([filesShort(f), sendsShort(s)]),
  }
}

/** What Junior did on an item that you haven't looked at. `line` is null when both counts are zero. */
export function supervisionOf(input: { touches: readonly FileTouch[]; seenAt: number | null; heldSends: number }): Supervision {
  return supervisionLine(unseenFiles(input.touches, input.seenAt).length, input.heldSends)
}

/**
 * The file touches in one session's events: every Write/Edit/MultiEdit/NotebookEdit
 * `tool_use` block in an assistant message (a subagent's included), its
 * `file_path` (or `notebook_path`) as the path and the event's time as `at`.
 */
export function touchesOf(sessionId: string, events: readonly { event: SessionEvent; createdAt: number }[]): FileTouch[] {
  const out: FileTouch[] = []
  for (const { event, createdAt } of events) {
    if (event.kind !== 'sdk' || event.message.type !== 'assistant') continue
    const content: unknown = event.message.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as RawBlock[]) {
      if (!b || typeof b !== 'object' || !isToolUseBlock(b) || !FILE_TOOLS.has(b.name)) continue
      const input = (b.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
      const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
      if (p.trim()) out.push({ path: p.trim(), sessionId, at: createdAt })
    }
  }
  return out
}

/** A path shown relative to the session's folder when it sits inside it; else as written. */
export function relativeTo(root: string | null | undefined, p: string): string {
  if (!root) return p
  const base = root.endsWith('/') ? root : `${root}/`
  return p.startsWith(base) ? p.slice(base.length) : p
}

/** A path cut into its folder (with the trailing slash) and its file name: the folder gives way first. */
export function splitPath(p: string): { dir: string; name: string } {
  const cut = p.lastIndexOf('/')
  return cut === -1 ? { dir: '', name: p } : { dir: p.slice(0, cut + 1), name: p.slice(cut + 1) }
}
