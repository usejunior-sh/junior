/**
 * How full a session's context is: the prompt side of the main agent's last
 * reply (input, cache writes and cache reads) over the model's window, which
 * the latest `result` reports. Subagents run in their own context, so their
 * replies don't count. A DM compacts at DM_COMPACT_WINDOW, well before the
 * model's window, so for a DM that is what full means.
 *
 * Pure and browser-safe: an open chat reads its own events.
 */
import type { SessionEvent } from '../../shared/protocol.js'
import { DM_COMPACT_WINDOW } from '../junior/dms.js'

/** What is known so far; either side is absent until a turn reports it. */
export type ContextFill = { used?: number; window?: number }

export type ContextUse = { used: number; window: number; pct: number }

/** Where 80% starts: the bar turns amber, compaction is near. */
export const CONTEXT_FULL_PCT = 80

/** The prompt size of a main-agent reply, or null when the event is anything else. */
function usedOf(ev: SessionEvent): number | null {
  if (ev.kind !== 'sdk') return null
  const m = ev.message
  if (m.type !== 'assistant' || m.parent_tool_use_id || !m.message?.usage) return null
  const u = m.message.usage
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

/** The largest window a turn's result reports, or null. */
function windowOf(ev: SessionEvent): number | null {
  if (ev.kind !== 'sdk') return null
  const m = ev.message
  if (m.type !== 'result' || !m.modelUsage) return null
  const w = Math.max(0, ...Object.values(m.modelUsage).map((x) => x.contextWindow ?? 0))
  return w > 0 ? w : null
}

/** The window that counts as full: a DM's compaction point, else the model's. */
export const fullAt = (window: number, kind?: string | null) => (kind === 'dm' ? Math.min(window, DM_COMPACT_WINDOW) : window)

/** Used over full, as a percentage. Null until both are known (before the first turn ends). */
export function contextPct(fill: ContextFill | undefined, kind?: string | null): ContextUse | null {
  if (fill?.used === undefined || fill.window === undefined) return null
  const window = fullAt(fill.window, kind)
  return { used: fill.used, window, pct: Math.min(100, Math.round((fill.used / window) * 100)) }
}

/** A session's whole log at once: the latest of each, read from the end. */
export function contextUse(events: readonly SessionEvent[], kind?: string | null): ContextUse | null {
  let used: number | null = null
  let window: number | null = null
  for (let i = events.length - 1; i >= 0 && (used === null || window === null); i--) {
    if (used === null) used = usedOf(events[i])
    if (window === null) window = windowOf(events[i])
  }
  return contextPct({ used: used ?? undefined, window: window ?? undefined }, kind)
}
