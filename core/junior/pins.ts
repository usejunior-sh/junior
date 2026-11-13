/**
 * Pinned notes: standing facts and rules the user tells Junior in its chat
 * ("dev is failing, the tenant migration did not run", "onboarding is another
 * team's lane"). Junior pins them and says so; they ride every brief it writes
 * for a thread, and its own prompt, so they survive the chat scrolling away.
 *
 *   today   true for the rest of the local day (a fact about now)
 *   always  until the user unpins it (a rule)
 *
 * Stored as one JSON file, `<workspace>/pins.json`, read strictly: a row with
 * an unknown key or a bad field is dropped and reported, never guessed at.
 * Pure and browser-safe; time is always an argument.
 */
import { dayKey } from './today.js'

export const PIN_SCOPES = ['today', 'always'] as const
export type PinScope = (typeof PIN_SCOPES)[number]

export type Pin = {
  /** `p-<base36 time>-<n>` */
  id: string
  /** one line, as Junior wrote it down */
  text: string
  scope: PinScope
  /** ms */
  createdAt: number
}

/** A pin is a line, not a document. */
export const PIN_TEXT_MAX = 300
/** Pins kept at once: past this, the oldest `today` ones go first, then the oldest `always`. */
export const PINS_MAX = 40

const PIN_KEYS = ['id', 'text', 'scope', 'createdAt'] as const
const ID_RE = /^p-[a-z0-9]{1,16}-[0-9]{1,4}$/

export const isPinScope = (v: unknown): v is PinScope => typeof v === 'string' && (PIN_SCOPES as readonly string[]).includes(v)

/** One line: newlines and runs of spaces fold to one space. */
export const pinText = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

/** Problems with a pin's text, or null when it's fine. */
export function pinTextProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !pinText(raw)) return 'a pin needs text'
  if (pinText(raw).length > PIN_TEXT_MAX) return `a pin is at most ${PIN_TEXT_MAX} characters`
  return null
}

/** A fresh id, unique against `taken`. */
export function pinId(now: number, taken: ReadonlySet<string>): string {
  const base = `p-${Math.max(0, Math.floor(now)).toString(36)}`
  for (let n = 0; n < 10_000; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
  throw new Error('no free pin id')
}

/** The stored file, read strictly. Bad rows are dropped with a reason; a file that isn't a list is an error. */
export function parsePins(text: string): { pins: Pin[]; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { pins: [], errors: ['pins.json is not valid JSON'] }
  }
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { pins?: unknown }).pins : raw
  if (!Array.isArray(list)) return { pins: [], errors: ['pins.json holds no list of pins'] }
  const pins: Pin[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  list.forEach((row, i) => {
    const why = pinProblem(row, seen)
    if (why) errors.push(`pin ${i + 1}: ${why}`)
    else {
      const p = row as Pin
      seen.add(p.id)
      pins.push({ id: p.id, text: pinText(p.text), scope: p.scope, createdAt: p.createdAt })
    }
  })
  return { pins, errors }
}

function pinProblem(row: unknown, seen: ReadonlySet<string>): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'not an object'
  const r = row as Record<string, unknown>
  const extra = Object.keys(r).find((k) => !(PIN_KEYS as readonly string[]).includes(k))
  if (extra) return `unknown key "${extra}"`
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'bad id'
  if (seen.has(r.id)) return `id "${r.id}" is used twice`
  const t = pinTextProblem(r.text)
  if (t) return t
  if (!isPinScope(r.scope)) return 'scope: today or always'
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || r.createdAt <= 0) return 'bad createdAt'
  return null
}

/** The file's text for a list. */
export const serializePins = (pins: readonly Pin[]): string => `${JSON.stringify({ pins }, null, 2)}\n`

/** The pins that still hold at `now`: every `always`, and `today` ones from this local day. Oldest first. */
export function activePins(pins: readonly Pin[], now: number): Pin[] {
  const today = dayKey(now)
  return pins.filter((p) => p.scope === 'always' || dayKey(p.createdAt) === today).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * Add a pin. The same words (case and spacing aside) already pinned are not
 * pinned twice: the old one is returned, moved to `always` if asked. Expired
 * `today` pins are swept on the way, and the list is held to PINS_MAX.
 */
export function addPin(pins: readonly Pin[], input: { text: string; scope?: PinScope }, now: number): { pins: Pin[]; pin: Pin; existed: boolean } {
  const why = pinTextProblem(input.text)
  if (why) throw new Error(why)
  const text = pinText(input.text)
  const scope = input.scope ?? 'today'
  const live = activePins(pins, now)
  const key = text.toLowerCase().replace(/[.!]+$/, '')
  const same = live.find((p) => p.text.toLowerCase().replace(/[.!]+$/, '') === key)
  if (same) {
    const pin = scope === 'always' && same.scope === 'today' ? { ...same, scope: 'always' as const } : same
    return { pins: live.map((p) => (p.id === same.id ? pin : p)), pin, existed: true }
  }
  const pin: Pin = { id: pinId(now, new Set(live.map((p) => p.id))), text, scope, createdAt: now }
  let next = [...live, pin]
  while (next.length > PINS_MAX) {
    const drop = next.find((p) => p.scope === 'today' && p.id !== pin.id) ?? next.find((p) => p.id !== pin.id)
    if (!drop) break
    next = next.filter((p) => p.id !== drop.id)
  }
  return { pins: next, pin, existed: false }
}

/** Remove one pin by id. Throws when there is none. */
export function removePin(pins: readonly Pin[], id: string): { pins: Pin[]; pin: Pin } {
  const pin = pins.find((p) => p.id === id)
  if (!pin) throw new Error(`no pin has the id "${id}"`)
  return { pins: pins.filter((p) => p.id !== id), pin }
}

/** The prompt's block: one line per active pin, its id and how long it holds. Nothing pinned adds nothing. */
export function pinsAppend(pins: readonly Pin[]): string {
  if (!pins.length) return ''
  const lines = pins.map((p) => `- ${p.text} (${p.scope === 'today' ? 'today' : 'standing'}; ${p.id})`)
  return `\n\n## Pinned notes\nWhat the user told you to keep in mind. Carry the ones that matter into each thread's brief.\n${lines.join('\n')}`
}
