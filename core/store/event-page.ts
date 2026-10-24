/**
 * Where to cut one page of a session's event log.
 *
 * Opening a long session used to parse its whole log at once. A page is the
 * newest events before a seq, read newest-first and cut so a page never
 * splits what the transcript draws as one thing:
 *
 *   1. `log-start`: the window reaches the first event, so nothing is cut.
 *   2. `turn`: the oldest turn start in the window (a `local_user` line)
 *      that no tool call spans. A page then holds whole turns.
 *   3. `tool`: one turn is longer than a page. Cut at the oldest event that
 *      no tool call spans, so a tool_use never lands on a different page
 *      from its tool_result. A subagent's Task call spans its whole run, so
 *      its messages stay with it.
 *   4. `hard`: one tool call spans the whole window (a huge subagent run).
 *      Keeping `limit` wins over keeping the call whole; the caller sees it.
 *
 * A call is "open" at a cut when its tool_use is before the cut and its
 * tool_result, or any message its subagent wrote (`parent_tool_use_id`), is
 * at or after it. When a call is split, the newest cut inside it is always
 * `hard`. An older page that sits wholly inside a top-level call can't see
 * either end of it, so it may report `tool`; inside a subagent run it sees
 * the subagent's messages and reports `hard` too.
 *
 * Pure and store-agnostic: any adapter fetches `limit` newest rows, asks
 * `cutPage` for the index, and returns the rest.
 */
import { isToolResultBlock, isToolUseBlock, type RawBlock, type SessionEvent } from '../../shared/protocol.js'

export type PageBoundary = 'log-start' | 'turn' | 'tool' | 'hard'

export const DEFAULT_PAGE_LIMIT = 300
export const MAX_PAGE_LIMIT = 5000

/** A sane page size: a whole number in 1..MAX_PAGE_LIMIT, default when unset or junk. */
export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}

function blocksOf(e: SessionEvent): RawBlock[] {
  if (e.kind !== 'sdk') return []
  const content = e.message.message?.content
  return Array.isArray(content) ? content : []
}

/**
 * The index of the first event to keep in `window` (oldest first), and why.
 * `reachesStart`: the window begins at the log's first event.
 */
export function cutPage(window: readonly SessionEvent[], reachesStart: boolean): { start: number; boundary: PageBoundary } {
  if (reachesStart || window.length === 0) return { start: 0, boundary: 'log-start' }

  // Cutting at index i is unsafe when a tool call opens before i and closes
  // at or after it. Mark those spans with a difference array: +1 where a
  // span starts being unsafe, -1 just past where it stops.
  const useAt = new Map<string, number>()
  const delta = new Array<number>(window.length + 1).fill(0)
  // A call opened on an earlier page (not in the window) makes every cut up
  // to `i` unsafe.
  const inside = (toolUseId: string, i: number) => {
    const u = useAt.get(toolUseId) ?? -1
    delta[u + 1]++
    delta[i + 1]--
  }
  window.forEach((e, i) => {
    if (e.kind === 'sdk' && typeof e.message.parent_tool_use_id === 'string') inside(e.message.parent_tool_use_id, i)
    for (const b of blocksOf(e)) {
      if (isToolUseBlock(b)) useAt.set(b.id, i)
      else if (isToolResultBlock(b)) inside(b.tool_use_id, i)
    }
  })

  let open = 0
  let firstSafe = -1
  for (let i = 0; i < window.length; i++) {
    open += delta[i]
    if (open > 0) continue
    if (window[i].kind === 'local_user') return { start: i, boundary: 'turn' }
    if (firstSafe < 0) firstSafe = i
  }
  if (firstSafe >= 0) return { start: firstSafe, boundary: 'tool' }
  return { start: 0, boundary: 'hard' }
}
