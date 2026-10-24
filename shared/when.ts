/**
 * Plain-words times: "till Tuesday 9am", "after 2 working days", "eod".
 * One helper for snooze, nudges and promise detection, shared by the server
 * and the browser. Pure and local time throughout; the reference time is
 * always an argument, never read from the clock.
 *
 * chrono-node (English only) reads the ordinary phrases. Three things are
 * added on top, because a work day is not a calendar day:
 *
 *   working days   "after 2 working days", "in 3 business days" and "next
 *                  working day" count Mon to Fri only. Friday + 2 = Tuesday.
 *   end of day     "eod", "end of day", "cob" mean today at 17:00, or the
 *                  next working day's 17:00 once that has passed. Next to a
 *                  day it is that day's 17:00: "by Friday EOD", "eod friday",
 *                  "end of day tomorrow".
 *   end of week    "eow", "end of the week" mean Friday at 17:00.
 *   day of month   "on the 5th", "the 30th" mean that date this month, or
 *                  next month's once it has passed.
 *
 * A phrase with a day but no hour lands at the start of the work day (9:00 by
 * default), not at noon or at the current minute: "tomorrow" means tomorrow
 * at 9. Part-of-day words pick their own hour (morning 9, afternoon 14,
 * evening 18, tonight 20). A bare clock hour from 1 to 7 with no am/pm is
 * read as the afternoon ("at 3" is 15:00), since nobody snoozes to 3 AM. A bare
 * weekday that has already passed today means next week's. A time that is
 * still in the past after that is not a time to wait for, so it returns null.
 *
 * Limits, so callers can hint: no holidays, no "end of next week", no
 * "the 5th" in the middle of a noun ("the 3rd time") — a day-of-month is read
 * only at the end of the text or before a time.
 */
import { casual } from 'chrono-node/en'

export interface When {
  /** Epoch ms, local time. Always after the reference time. */
  at: number
  /** Short, human local time: "Tomorrow 9:00 AM", "Tuesday 9:00 AM". */
  label: string
  /** The words that were read, as they appear in the text. */
  text: string
}

export interface WhenOptions {
  /** Hour a day-only phrase lands on. Default 9. */
  defaultHour?: number
  /** Hour "eod" / "end of week" mean. Default 17. */
  endOfDayHour?: number
}

const DEFAULT_HOUR = 9
const END_OF_DAY_HOUR = 17
/** Longer text is cut here: a time phrase worth reading is near the start. */
const MAX_TEXT = 2000
/** Working-day counts above this are a typo, not a plan. */
const MAX_WORKING_DAYS = 260

// ── Working days ─────────────────────────────────────────────────────────

/** Mon to Fri. Holidays are not known here. */
export function isWorkingDay(ms: number): boolean {
  const wd = new Date(ms).getDay()
  return wd !== 0 && wd !== 6
}

/**
 * `n` working days after `ms`, keeping the time of day. Weekend days are
 * skipped and not counted: Friday + 1 = Monday, Friday + 2 = Tuesday,
 * Saturday + 1 = Monday. `n <= 0` returns `ms` unchanged.
 */
export function addWorkingDays(ms: number, n: number): number {
  const d = new Date(ms)
  let left = Math.floor(n)
  while (left > 0) {
    d.setDate(d.getDate() + 1)
    if (isWorkingDay(d.getTime())) left--
  }
  return d.getTime()
}

/**
 * Working days that have passed between two times: the Mon to Fri dates
 * after `from`'s date, up to and including `to`'s date. Friday 10:00 to
 * Monday 10:00 is 1; a weekend alone is 0; `to <= from` is 0.
 */
export function workingDaysBetween(from: number, to: number): number {
  if (to <= from) return 0
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  let count = 0
  while (d.getTime() < end.getTime()) {
    d.setDate(d.getDate() + 1)
    if (isWorkingDay(d.getTime())) count++
  }
  return count
}

// ── Label ─────────────────────────────────────────────────────────────────

function dayDiff(at: number, ref: number): number {
  const a = new Date(at)
  const b = new Date(ref)
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((da - db) / 86_400_000)
}

/** The time of day as the user's locale writes it: "9:00 AM", "09:00". */
export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * A short local label for `at` seen from `ref`: "Today 3:00 PM",
 * "Tomorrow 9:00 AM", "Tuesday 9:00 AM" within the week, else
 * "Tue, Nov 3 9:00 AM" (the year added when it differs).
 */
export function whenLabel(at: number, ref: number): string {
  const diff = dayDiff(at, ref)
  const time = timeLabel(at)
  const d = new Date(at)
  if (diff === 0) return `Today ${time}`
  if (diff === 1) return `Tomorrow ${time}`
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`
  const sameYear = d.getFullYear() === new Date(ref).getFullYear()
  const date = d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${date} ${time}`
}

// ── Parsing ───────────────────────────────────────────────────────────────

interface Found {
  index: number
  text: string
  at: number
}

interface HourMinute {
  h: number
  m: number
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

const PART_OF_DAY: Array<[RegExp, HourMinute]> = [
  [/\bmorning\b/i, { h: 9, m: 0 }],
  [/\bafternoon\b/i, { h: 14, m: 0 }],
  [/\bevening\b/i, { h: 18, m: 0 }],
  [/\b(?:tonight|night)\b/i, { h: 20, m: 0 }],
]

function partOfDay(text: string): HourMinute | null {
  for (const [re, hm] of PART_OF_DAY) if (re.test(text)) return hm
  return null
}

function atHour(ms: number, hm: HourMinute): number {
  const d = new Date(ms)
  d.setHours(hm.h, hm.m, 0, 0)
  return d.getTime()
}

function plusDays(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

type ChronoResult = ReturnType<typeof casual.parse>[number]

/**
 * The clock time chrono read, or null when it read no hour. A bare hour from
 * 1 to 7 with no am/pm ("at 3", "tomorrow at 7") is the afternoon.
 */
function clockOf(r: ChronoResult): HourMinute | null {
  const s = r.start
  if (!s.isCertain('hour')) return null
  let h = s.get('hour') ?? 0
  const m = s.get('minute') ?? 0
  if (!s.isCertain('meridiem') && h >= 1 && h <= 7 && !/\b0\d/.test(r.text)) h += 12
  return { h, m }
}

/**
 * A clock time written right after a phrase chrono doesn't read itself
 * ("after 2 working days at 3pm", "next business day morning").
 */
function trailingTime(rest: string, now: number): { hm: HourMinute; length: number } | null {
  if (!rest.trim()) return null
  const r = casual.parse(rest, new Date(now))[0]
  if (!r || r.index > 4) return null
  if (r.start.isCertain('day') || r.start.isCertain('weekday')) return null
  const length = r.index + r.text.length
  const clock = clockOf(r)
  if (clock) return { hm: clock, length }
  const pod = partOfDay(r.text)
  return pod ? { hm: pod, length } : null
}

// "a"/"an" counts only after a lead word: "in a working day" is a time, "it
// is a work day" is not.
const WORKING_DAYS_RE =
  /\b(?:(?:after|in|within|for)\s+(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)|(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten))\s+(?:working|business|work)\s+days?\b/i
const NEXT_WORKING_DAY_RE = /\bnext\s+(?:working|business|work)\s+day\b/i

function findWorkingDays(text: string, now: number, o: Required<WhenOptions>): Found | null {
  let m = WORKING_DAYS_RE.exec(text)
  let n: number
  if (m) {
    const word = (m[1] ?? m[2]).toLowerCase()
    n = NUMBER_WORDS[word] ?? Number(word)
  } else {
    m = NEXT_WORKING_DAY_RE.exec(text)
    if (!m) return null
    n = 1
  }
  if (!Number.isFinite(n) || n < 1 || n > MAX_WORKING_DAYS) return null
  const end = m.index + m[0].length
  const time = trailingTime(text.slice(end), now)
  const day = addWorkingDays(now, n)
  const at = atHour(day, time?.hm ?? { h: o.defaultHour, m: 0 })
  return { index: m.index, text: text.slice(m.index, end + (time?.length ?? 0)).trim(), at }
}

const EOD_RE = /\b(?:by\s+)?(?:eod|cob|end\s+of\s+(?:the\s+)?(?:day|today)|close\s+of\s+business)\b/i
const EOW_RE = /\b(?:by\s+)?(?:eow|end\s+of\s+(?:the\s+|this\s+)?week)\b/i

/** Only these words may sit between a day and its "eod": "Friday EOD", "eod on Friday". */
const JOIN_RE = /^[\s,]*(?:(?:on|by|of)[\s,]+)?$/i

/**
 * A day chrono read right next to the "eod" match, with no hour of its own:
 * "by Friday EOD", "eod friday", "tomorrow EOD", "end of day tomorrow".
 */
function dayBeside(text: string, eod: RegExpExecArray, now: number): ChronoResult | null {
  const start = eod.index
  const end = eod.index + eod[0].length
  for (const r of casual.parse(text, new Date(now), { forwardDate: true })) {
    const s = r.start
    if (s.isCertain('hour') || !(s.isCertain('day') || s.isCertain('weekday'))) continue
    const rEnd = r.index + r.text.length
    const gap = rEnd <= start ? text.slice(rEnd, start) : r.index >= end ? text.slice(end, r.index) : null
    if (gap !== null && JOIN_RE.test(gap)) return r
  }
  return null
}

function findEndOf(text: string, now: number, o: Required<WhenOptions>): Found | null {
  const eod = EOD_RE.exec(text)
  const eow = EOW_RE.exec(text)
  const hm = { h: o.endOfDayHour, m: 0 }
  const fromEod = (): Found | null => {
    if (!eod) return null
    const day = dayBeside(text, eod, now)
    if (day) {
      let at = atHour(day.start.date().getTime(), hm)
      if (at <= now) {
        // A bare weekday whose 17:00 has passed is next week's; a named day
        // that has passed is not a time to wait for.
        if (day.start.isCertain('day')) return null
        at = plusDays(at, 7)
      }
      const index = Math.min(day.index, eod.index)
      const end = Math.max(day.index + day.text.length, eod.index + eod[0].length)
      return { index, text: text.slice(index, end), at }
    }
    let at = atHour(now, hm)
    if (!isWorkingDay(at) || at <= now) at = atHour(addWorkingDays(now, 1), hm)
    return { index: eod.index, text: eod[0], at }
  }
  const fromEow = (): Found | null => {
    if (!eow) return null
    const d = new Date(now)
    const toFriday = (5 - d.getDay() + 7) % 7
    let at = atHour(plusDays(now, toFriday), hm)
    if (at <= now) at = plusDays(at, 7)
    return { index: eow.index, text: eow[0], at }
  }
  const a = fromEod()
  const b = fromEow()
  if (a && b) return a.index <= b.index ? a : b
  return a ?? b
}

const MONTH_WORD = /^\s*(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i
// "the 5th" counts only at the end of the text or before a time / punctuation,
// so "the 3rd time it failed" is not a date.
const ORDINAL_RE =
  /\b(?:on\s+)?the\s+([1-9]|[12]\d|3[01])(?:st|nd|rd|th)\b(?=\s*(?:$|[,.;:!?)]|at\b|by\b|morning|afternoon|evening|night|\d))/i

function findDayOfMonth(text: string, now: number, o: Required<WhenOptions>): Found | null {
  const m = ORDINAL_RE.exec(text)
  if (!m) return null
  const end = m.index + m[0].length
  if (MONTH_WORD.test(text.slice(end))) return null // "the 30th of November": chrono's
  const dom = Number(m[1])
  const time = trailingTime(text.slice(end), now)
  const hm = time?.hm ?? { h: o.defaultHour, m: 0 }
  const ref = new Date(now)
  // This month, else the next month that has that day (the 31st skips short ones).
  for (let k = 0; k < 13; k++) {
    const d = new Date(ref.getFullYear(), ref.getMonth() + k, dom, hm.h, hm.m, 0, 0)
    if (d.getDate() !== dom) continue
    if (d.getTime() > now) {
      return { index: m.index, text: text.slice(m.index, end + (time?.length ?? 0)).trim(), at: d.getTime() }
    }
  }
  return null
}

function findChrono(text: string, now: number, o: Required<WhenOptions>): Found | null {
  for (const r of casual.parse(text, new Date(now), { forwardDate: true })) {
    const s = r.start
    const clock = clockOf(r)
    // A bare time ("at 3", "noon") is today's first: chrono's forward date
    // has already moved a passed 3 AM to tomorrow before it became 15:00.
    const bare = !s.isCertain('day') && !s.isCertain('weekday')
    let at = clock && bare ? now : s.date().getTime()
    at = atHour(at, clock ?? partOfDay(r.text) ?? { h: o.defaultHour, m: 0 })
    if (at <= now && !s.isCertain('day')) {
      // A bare weekday that has passed today is next week's; a bare time,
      // tomorrow's.
      at = plusDays(at, s.isCertain('weekday') ? 7 : 1)
    }
    if (at <= now) continue
    return { index: r.index, text: r.text, at }
  }
  return null
}

/**
 * Read the first time phrase in `text` against `ref`. Returns null when there
 * is none, or when the only one is already in the past.
 */
export function parseWhen(text: string, ref: number | Date, opts: WhenOptions = {}): When | null {
  const now = typeof ref === 'number' ? ref : ref.getTime()
  const src = (text ?? '').slice(0, MAX_TEXT)
  if (!src.trim() || !Number.isFinite(now)) return null
  const o: Required<WhenOptions> = {
    defaultHour: opts.defaultHour ?? DEFAULT_HOUR,
    endOfDayHour: opts.endOfDayHour ?? END_OF_DAY_HOUR,
  }
  const found = [findWorkingDays(src, now, o), findEndOf(src, now, o), findDayOfMonth(src, now, o), findChrono(src, now, o)]
    .filter((f): f is Found => f !== null && f.at > now)
    // Earliest wins; at the same spot the longer reading ("tomorrow EOD" over
    // "tomorrow").
    .sort((a, b) => a.index - b.index || b.text.length - a.text.length)[0]
  if (!found) return null
  return { at: found.at, label: whenLabel(found.at, now), text: found.text }
}
