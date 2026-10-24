/**
 * Close candidates: your own PRs that look dead (.docs/overnight-2026-10-24/
 * designs/close-candidates.md). Quiet for 30 whole days, or replaced by a
 * merged PR that links them. They leave My PRs, Up next and Waiting for one
 * collapsed "Close?" group at the bottom of My PRs.
 *
 * Junior only suggests. Nothing is drafted until you pick "Close with a
 * note", and the close itself (`gh pr close --comment`) is a held send.
 * "Keep" stamps `keptOpen`: no more asking for KEEP_OPEN_DAYS.
 *
 * Pure and browser-safe: time is always an argument.
 */
import { textRefs } from './link.js'
import type { WorkItem } from './types.js'

export const CLOSE_QUIET_DAYS = 30
export const KEEP_OPEN_DAYS = 30
/** Merged PRs older than this aren't read for "replaced by": a PR that old is quiet anyway. */
export const SUPERSEDE_LOOKBACK_DAYS = 30
/** Rows the open group shows before "{n} more quiet PRs". */
export const CLOSE_SHOWN = 10

const DAY = 86_400_000

export type CloseWhy = { why: 'quiet'; days: number } | { why: 'superseded'; by: string }

export type CloseInput = Pick<WorkItem, 'kind' | 'updatedAt' | 'handoff' | 'keptOpen'> & { reason?: WorkItem['reason'] }

/**
 * Whether Junior asks "Close?" about this PR, and why. Null when it doesn't:
 * not your PR, approved (merge it, don't close it), handed to Junior, kept
 * open in the last 30 days, or a source time that doesn't parse.
 * `supersededBy` is the ref of a merged PR that links this one (e.g. "#3310").
 */
export function closeCandidate(pr: CloseInput, now: number, supersededBy?: string): CloseWhy | null {
  if (pr.reason !== 'your-pr') return null
  if (pr.kind === 'own-pr-approved') return null
  if (pr.handoff === 'on') return null
  if (typeof pr.keptOpen === 'number' && now - pr.keptOpen < KEEP_OPEN_DAYS * DAY) return null
  if (supersededBy) return { why: 'superseded', by: supersededBy }
  const at = Date.parse(pr.updatedAt)
  if (!Number.isFinite(at)) return null
  const days = Math.floor((now - at) / DAY)
  return days >= CLOSE_QUIET_DAYS ? { why: 'quiet', days } : null
}

/** The order inside the group: replaced ones first, then the longest quiet. */
export function closeOrder(a: { close?: CloseWhy }, b: { close?: CloseWhy }): number {
  const rank = (c?: CloseWhy) => (c?.why === 'superseded' ? 0 : 1)
  const days = (c?: CloseWhy) => (c?.why === 'quiet' ? c.days : 0)
  return rank(a.close) - rank(b.close) || days(b.close) - days(a.close)
}

/**
 * How one GitHub item names another: "#3310" in the same repo,
 * "acme/api#881" across repos. Null for anything that isn't a GitHub id.
 */
export function shortRef(id: string, from?: string): string | null {
  const m = /^github:([^#]+)#(\d+)$/.exec(id)
  if (!m) return null
  return m[1] === from ? `#${m[2]}` : `${m[1]}#${m[2]}`
}

type Linkable = Pick<WorkItem, 'id' | 'repo' | 'title' | 'why' | 'refs'>

/**
 * Which open PRs a merged PR replaced: the merged PR names them, in its refs
 * or its own words (core/work/link.ts textRefs). Open id → the merged PR's
 * ref as the open one would say it. The newest-listed merged PR wins a tie.
 */
export function supersededBy(open: readonly Pick<WorkItem, 'id' | 'repo'>[], merged: readonly Linkable[]): Map<string, string> {
  const want = new Map(open.map((o) => [o.id, o.repo]))
  const out = new Map<string, string>()
  for (const m of merged) {
    for (const ref of new Set([...(m.refs ?? []), ...textRefs(m)])) {
      if (ref === m.id || !want.has(ref)) continue
      const by = shortRef(m.id, want.get(ref))
      if (by) out.set(ref, by)
    }
  }
  return out
}

/** The row's state column: quiet grey, never orange. */
export const closeState = (c: CloseWhy): string => (c.why === 'quiet' ? `Quiet ${c.days} days` : `Replaced by ${c.by}`)

/** What Junior says on the open row. */
export const closeSays = (c: CloseWhy): string =>
  c.why === 'quiet'
    ? `No one has touched this in ${c.days} days. Keep it, or I’ll draft a closing note for you to read.`
    : `${c.by} merged and links here. Keep it, or I’ll draft a closing note for you to read.`

/** The chat draft "Close with a note" opens: one line to Junior, nothing drafted yet. */
export const closePrompt = (ref: string, c: CloseWhy): string =>
  c.why === 'quiet'
    ? `Close ${ref}. It has been quiet for ${c.days} days. Write a short, kind closing note first. Show it to me before anything goes out.`
    : `Close ${ref}. ${c.by} replaced it. Write a short closing note that points there. Show it to me before anything goes out.`

/** The group header's accessible name. */
export const closeGroupLabel = (n: number): string => `Close? ${n} quiet PR${n === 1 ? '' : 's'}`

/** The "more" button under the first CLOSE_SHOWN rows. */
export const closeMoreLabel = (n: number): string => (n === 1 ? '1 more quiet PR' : `${n} more quiet PRs`)

export const CLOSE_HINT = 'Quiet for 30 days, or replaced by a merged PR. Nothing is drafted until you ask.'
export const CLOSE_ONLY_EMPTY = 'No active PRs. The quiet ones are below.'
export const KEEP_TITLE = 'Keep it open. I won’t ask again for 30 days.'
export const CLOSE_TITLE = 'Opens a chat. I draft the note, and it waits for your OK.'
export const keptSaid = (title: string): string => `Kept open: ${title}. I won’t ask again for 30 days.`
