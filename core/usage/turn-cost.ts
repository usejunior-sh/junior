import type { SdkMessage, SessionEvent } from '../../shared/protocol.js'

// A turn's own cost, from the cumulative counters on each result. The server
// books it (team and goal spend) and the transcript prints it, so both read
// a result the same way.
//
// total_cost_usd counts from when the subprocess's counters started. A resume
// sometimes restores them and sometimes starts them over: Claude Code restores
// cost only when this session was the last one saved for its folder, and many
// sessions share a folder. So "the total went up" proves nothing on its own.
// API time and every model's tokens restart along with the cost, and a fresh
// first turn rarely outgrows all of them at once.

/** Where a subprocess's cumulative counters stood at one result. */
export type CostMark = { total: number; apiMs?: number; tokens?: Record<string, number> }

const okResult = (m: SdkMessage) => m.subtype === 'success' && m.is_error !== true

/** A result's counters; null when it says nothing about spend (no total, or a crash's zeroed one). */
export function costMark(m: SdkMessage): CostMark | null {
  if (m.type !== 'result') return null
  const total = m.total_cost_usd
  if (typeof total !== 'number' || !Number.isFinite(total) || (total === 0 && !okResult(m))) return null
  const mark: CostMark = { total }
  if (typeof m.duration_api_ms === 'number') mark.apiMs = m.duration_api_ms
  if (m.modelUsage && typeof m.modelUsage === 'object') {
    mark.tokens = {}
    for (const [model, u] of Object.entries(m.modelUsage)) {
      mark.tokens[model] = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0)
    }
  }
  return mark
}

/** Whether `next` counts on from `from`, rather than from zero. */
export function carriesOn(next: CostMark, from: CostMark): boolean {
  if (next.total < from.total) return false
  if (next.apiMs !== undefined && from.apiMs !== undefined && next.apiMs < from.apiMs) return false
  if (from.tokens) for (const [model, n] of Object.entries(from.tokens)) if ((next.tokens?.[model] ?? 0) < n) return false
  return true
}

/**
 * One result's spend, given the counters at the last result (null: none yet,
 * or a subprocess known to start from zero). A result with no usable total
 * spends nothing and moves nothing.
 */
export function costStep(m: SdkMessage, seen: CostMark | null): { delta: number; seen: CostMark | null } {
  const mark = costMark(m)
  if (!mark) return { delta: 0, seen }
  return { delta: seen && carriesOn(mark, seen) ? mark.total - seen.total : mark.total, seen: mark }
}

/** The counters at the last result a session's log kept: where a resumed subprocess may carry on from. */
export function lastResultMark(events: readonly { event: SessionEvent }[]): CostMark | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event
    if (e.kind !== 'sdk') continue
    const mark = costMark(e.message)
    if (mark) return mark
  }
  return null
}
