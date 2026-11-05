/**
 * The spend vocabulary, formatting and series colour, shared by every
 * surface that shows cost: the Usage tab and the per-item readout on the item
 * page. One module on purpose: two formattings of `$`, or two blues for Opus,
 * is how two surfaces start disagreeing.
 */
import type { SessionEvent } from '../../shared/protocol.js'

/** `$4.73`, `$1.2k`, and `<$0.01` rather than a misleading `$0.00`. */
export const money = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : '<$0.01'

/** `2.3M`, `903k`, `38`, never a raw seven-digit number. */
export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/**
 * Series colours: the first six slots of the validated dark categorical
 * palette (blue, orange, aqua, yellow, magenta, violet). Checked against this
 * surface for the lightness band, chroma floor, colour-blind separation and
 * contrast, do not swap one for a brighter app accent, which fails the band.
 * Models past the sixth fold into "Other" rather than inventing a hue.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9']
export const OTHER = '#6b6f76'
/** The id the tail of the model list is drawn under, past the sixth hue. */
export const OTHER_KEY = '\u0000other'
export const MAX_SERIES = SERIES.length

/** `claude-opus-4-8` → `Opus 4.8`; anything unexpected passes through. */
export function modelLabel(id: string): string {
  if (id === OTHER_KEY) return 'Other'
  const parts = id.replace(/^claude-/, '').split('-')
  if (parts.length === 0) return id
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).join('.')
  return version ? `${family} ${version}` : family
}

/**
 * How full the main agent's context is: the prompt side of its last reply
 * (input, cache writes and cache reads) over the model's window, which the
 * latest `result` reports. Subagents run in their own context, so their
 * replies don't count. Null until both are known (before the first turn ends).
 */
export function contextUse(events: readonly SessionEvent[]): { used: number; window: number; pct: number } | null {
  let used: number | null = null
  let window: number | null = null
  for (let i = events.length - 1; i >= 0 && (used === null || window === null); i--) {
    const ev = events[i]
    if (ev.kind !== 'sdk') continue
    const m = ev.message
    if (used === null && m.type === 'assistant' && !m.parent_tool_use_id && m.message?.usage) {
      const u = m.message.usage
      used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    }
    if (window === null && m.type === 'result' && m.modelUsage) {
      const w = Math.max(0, ...Object.values(m.modelUsage).map((x) => x.contextWindow ?? 0))
      if (w > 0) window = w
    }
  }
  if (used === null || window === null) return null
  return { used, window, pct: Math.min(100, Math.round((used / window) * 100)) }
}
