/**
 * The spend vocabulary, formatting and series colour, shared by every
 * surface that shows cost: the Usage tab and the per-item readout on the item
 * page. One module on purpose: two formattings of `$`, or two blues for Opus,
 * is how two surfaces start disagreeing.
 */

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
