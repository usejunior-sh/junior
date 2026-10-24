/**
 * Focus hours: during deep work, only what can't wait reaches Needs you.
 * Pure and browser-safe. Time is always an argument; days and clocks are the
 * Mac's local time, like due.ts.
 *
 * Two things get through a focus window, nothing else:
 *
 *   person-waiting   a person has waited on you at least the threshold
 *                    (`waitMinutes`, counted from the item's last update)
 *   prod-red         production is on fire: an urgent item (priority 1, any
 *                    source), or anything from an incident tool (PagerDuty,
 *                    Opsgenie, incident.io, FireHydrant, Rootly)
 *
 * Everything else is held, not dropped: the caller shows held items again
 * when the window ends, and can count them meanwhile ("3 waiting").
 *
 * A window is days + a start and end clock. An end at or before the start
 * runs past midnight, and belongs to the day it starts on. "End focus"
 * (`endFocus`) skips the rest of the current window only; the next one
 * starts as set.
 *
 * Stored as one workspace config value (server/settings-ops.ts), set by chat
 * through the junior MCP's set_focus_hours. There is no form.
 */
import { sourceOf } from '../../shared/sources.js'
import type { WorkItem } from './types.js'

export interface FocusWindow {
  /** local weekdays the window starts on: 0 = Sunday … 6 = Saturday, sorted, unique */
  days: number[]
  /** minutes after local midnight, 0–1439 */
  start: number
  /** minutes after local midnight, 0–1439; at or before `start` = runs past midnight */
  end: number
}

export interface FocusHours {
  windows: FocusWindow[]
  /** a person waiting this long gets through */
  waitMinutes: number
  /** "End focus": no focus until this epoch ms (the end of the window it was pressed in) */
  endedUntil?: number
}

export type FocusPass = 'person-waiting' | 'prod-red'

export const DEFAULT_WAIT_MINUTES = 60
export const MAX_WAIT_MINUTES = 7 * 24 * 60
export const MAX_WINDOWS = 14

/** Sources whose items mean production is red. Matched lower-case, ignoring spaces, dots and dashes. */
export const INCIDENT_SOURCES: ReadonlySet<string> = new Set(['pagerduty', 'opsgenie', 'incidentio', 'firehydrant', 'rootly'])

const DAY_MIN = 24 * 60
const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const DAY_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes()

/** Epoch ms of `minutes` after local midnight on the day of `day`, plus `addDays`. */
function at(day: Date, minutes: number, addDays = 0): number {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + addDays, 0, 0, 0, 0)
  d.setHours(Math.floor(minutes / 60), minutes % 60)
  return d.getTime()
}

/** When this window ends if `now` is inside it, else null. */
export function inWindow(w: FocusWindow, now: number): number | null {
  const d = new Date(now)
  const m = minuteOfDay(d)
  const today = d.getDay()
  const yesterday = (today + 6) % 7
  if (w.end > w.start) {
    return w.days.includes(today) && m >= w.start && m < w.end ? at(d, w.end) : null
  }
  // runs past midnight: tonight's started today, this morning's started yesterday
  if (w.days.includes(today) && m >= w.start) return at(d, w.end, 1)
  if (w.days.includes(yesterday) && m < w.end) return at(d, w.end)
  return null
}

/**
 * Whether `now` is in focus, and until when. Overlapping windows run to the
 * latest end among them. Null = not in focus (no window now, or focus ended).
 */
export function inFocus(focus: FocusHours | null | undefined, now: number): { until: number } | null {
  if (!focus || focus.windows.length === 0) return null
  if (focus.endedUntil != null && now < focus.endedUntil) return null
  let until: number | null = null
  for (const w of focus.windows) {
    const end = inWindow(w, now)
    if (end != null && (until == null || end > until)) until = end
  }
  return until == null ? null : { until }
}

/** "End focus": skip the rest of the current window. Out of focus, it returns the hours unchanged. */
export function endFocus(focus: FocusHours, now: number): FocusHours {
  const f = inFocus(focus, now)
  return f ? { ...focus, endedUntil: f.until } : focus
}

/** What focusFilter reads off an item. */
export type FocusItem = Pick<WorkItem, 'source' | 'peopleWaiting' | 'updatedAt'> & Partial<Pick<WorkItem, 'priority'>>

const norm = (s: string) => s.toLowerCase().replace(/[\s.\-_]/g, '')

/** Production is red on it: urgent, or from an incident tool. */
export function isProdRed(item: FocusItem): boolean {
  return item.priority === 1 || INCIDENT_SOURCES.has(norm(item.source))
}

/**
 * Why an item gets through focus, or null when it is held. A person's wait
 * counts from the item's last update; an unreadable time lets it through, so
 * focus never hides a person on a bad timestamp.
 */
export function getsThrough(item: FocusItem, waitMinutes: number, now: number): FocusPass | null {
  if (isProdRed(item)) return 'prod-red'
  if (item.peopleWaiting > 0 && !sourceOf(item.source).yours) {
    const since = Date.parse(item.updatedAt)
    if (!Number.isFinite(since) || now - since >= waitMinutes * 60_000) return 'person-waiting'
  }
  return null
}

/**
 * Split a list for a focus window: what gets through (in the order given) and
 * what is held until it ends. Callers pass what Needs you would show.
 */
export function focusFilter<T extends FocusItem>(items: readonly T[], opts: { waitMinutes: number; now: number }): { through: T[]; held: T[] } {
  const through: T[] = []
  const held: T[] = []
  for (const item of items) (getsThrough(item, opts.waitMinutes, opts.now) ? through : held).push(item)
  return { through, held }
}

// ── Reading and writing ─────────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** "9", "09:30", "9am", "12:30pm", "17:00" → minutes after midnight. "24:00" reads as midnight. */
export function parseClock(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 24) return (raw % 24) * 60
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(raw)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const ap = m[3]?.toLowerCase()
  if (min > 59) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (ap === 'pm' ? 12 : 0)
  } else if (h > 24 || (h === 24 && min > 0)) return null
  return ((h % 24) * 60 + min) % DAY_MIN
}

/** "weekdays", "weekends", "every day", "mon", "Tuesday", 0–6, or a list of those → sorted weekday numbers. */
export function parseDays(raw: unknown): number[] | null {
  const list = Array.isArray(raw) ? raw : [raw]
  const out = new Set<number>()
  for (const x of list) {
    if (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 6) {
      out.add(x)
      continue
    }
    if (typeof x !== 'string') return null
    const s = x.trim().toLowerCase()
    if (s === 'weekdays' || s === 'workdays') WEEKDAYS.forEach((d) => out.add(d))
    else if (s === 'weekends' || s === 'weekend') WEEKEND.forEach((d) => out.add(d))
    else if (s === 'every day' || s === 'everyday' || s === 'daily' || s === 'all') ALL_DAYS.forEach((d) => out.add(d))
    else {
      // "mon", "tues", "thursday": three letters or more of one day's name; "mongoose" is none
      const i = s.length >= 3 ? DAY_FULL.findIndex((d) => d.startsWith(s)) : -1
      if (i < 0) return null
      out.add(i)
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : null
}

/**
 * Focus hours from the wire (the set_focus_hours tool):
 * { windows: [{ days, start, end }], waitMinutes? }. Clocks may be "9", "09:30"
 * or "9am"; days as parseDays reads them. An empty list means no focus hours.
 * Anything else is an error, not a repair.
 */
export function focusFrom(raw: unknown): Parsed<FocusHours | null> {
  const r = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(r.windows)) return { ok: false, error: 'windows must be a list of { days, start, end }' }
  if (r.windows.length > MAX_WINDOWS) return { ok: false, error: `at most ${MAX_WINDOWS} windows` }
  let waitMinutes = DEFAULT_WAIT_MINUTES
  if (r.waitMinutes !== undefined) {
    const w = r.waitMinutes
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > MAX_WAIT_MINUTES) return { ok: false, error: `waitMinutes must be whole minutes from 0 to ${MAX_WAIT_MINUTES}` }
    waitMinutes = w
  }
  if (r.windows.length === 0) return { ok: true, value: null }
  const windows: FocusWindow[] = []
  for (const [i, raw] of r.windows.entries()) {
    const w = (raw ?? {}) as Record<string, unknown>
    const days = parseDays(w.days ?? 'every day')
    if (!days) return { ok: false, error: `window ${i + 1}: days must be weekday names, "weekdays", "weekends" or "every day"` }
    const start = parseClock(w.start)
    const end = parseClock(w.end)
    if (start == null || end == null) return { ok: false, error: `window ${i + 1}: start and end must be clock times like "9:00" or "12:30"` }
    if (start === end) return { ok: false, error: `window ${i + 1}: start and end are the same time` }
    windows.push({ days, start, end })
  }
  return { ok: true, value: { windows, waitMinutes } }
}

/** The stored value, read forgivingly: bad windows are dropped, a bad whole reads as no focus hours. */
export function readFocus(raw: unknown): FocusHours | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.windows)) return null
  const okMin = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < DAY_MIN
  const windows = r.windows
    .filter((w): w is FocusWindow => {
      const x = (w ?? {}) as Record<string, unknown>
      return okMin(x.start) && okMin(x.end) && x.start !== x.end && Array.isArray(x.days) && x.days.length > 0 && x.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    })
    .map((w) => ({ days: [...new Set(w.days)].sort((a, b) => a - b), start: w.start, end: w.end }))
  if (windows.length === 0) return null
  const wait = r.waitMinutes
  const waitMinutes = typeof wait === 'number' && Number.isInteger(wait) && wait >= 0 && wait <= MAX_WAIT_MINUTES ? wait : DEFAULT_WAIT_MINUTES
  const ended = r.endedUntil
  return { windows, waitMinutes, ...(typeof ended === 'number' && Number.isFinite(ended) ? { endedUntil: ended } : {}) }
}

// ── Words ───────────────────────────────────────────────────────────────

/** 540 → "9:00", 750 → "12:30". */
export const formatClock = (m: number): string => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`

function formatDays(days: number[]): string {
  const key = days.join(',')
  if (key === ALL_DAYS.join(',')) return 'every day'
  if (key === WEEKDAYS.join(',')) return 'on weekdays'
  if (key === WEEKEND.join(',')) return 'on weekends'
  return `on ${days.map((d) => DAY_LABELS[d]).join(', ')}`
}

/** 60 → "1h", 90 → "1h 30m", 45 → "45m", 2880 → "2d". */
export function formatWait(min: number): string {
  if (min === 0) return 'any wait'
  if (min % DAY_MIN === 0) return `${min / DAY_MIN}d`
  const h = Math.floor(min / 60)
  const m = min % 60
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`
}

/** One window in words: "9:00–12:00 on weekdays". */
export const describeWindow = (w: FocusWindow): string => `${formatClock(w.start)}–${formatClock(w.end)} ${formatDays(w.days)}`

/** The whole setting in a line, for a tool result or a tooltip. */
export function describeFocus(focus: FocusHours | null): string {
  if (!focus) return 'No focus hours set.'
  const when = focus.windows.map(describeWindow).join('; ')
  const wait = focus.waitMinutes === 0 ? 'anyone waiting on you' : `people waiting ${formatWait(focus.waitMinutes)} or more`
  return `Focus ${when}. During focus, only ${wait} and prod-red items reach Needs you.`
}

// ── The halo line (the Junior page during focus) ────────────────────────

/** An epoch ms as the Mac's 24h clock: "12:00", "9:30". */
export const clockAt = (ms: number): string => formatClock(minuteOfDay(new Date(ms)))

/** Every string the Junior page shows during focus, for `held` items waiting until `until`. */
export function focusWords(until: number, held: number): {
  /** "12:00" */
  clock: string
  /** after "Focus until 12:00 · ": "3 waiting" or "nothing waiting" */
  waiting: string
  /** under the Needs you list, only when something is held */
  foot: string | null
  /** Needs you with nothing let through */
  empty: string
  /** said to a screen reader once End focus worked */
  ended: string
} {
  const clock = clockAt(until)
  return {
    clock,
    waiting: held > 0 ? `${held} waiting` : 'nothing waiting',
    foot: held > 0 ? `Quiet until ${clock}. ${held} ${held === 1 ? 'waits' : 'wait'} for you then.` : null,
    empty: `Nothing needs you before ${clock}.`,
    ended: `Focus ended. ${held} back on Needs you.`,
  }
}
