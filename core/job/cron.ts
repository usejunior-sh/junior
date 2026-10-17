/**
 * A small, dependency-free 5-field cron engine (.docs/jobs-v2.md).
 *
 * Standard fields: minute hour day-of-month month day-of-week, each supporting
 * `*`, lists (`a,b`), ranges (`a-b`), and steps (`* /n`, `a-b/n`, `a/n`).
 * Day-of-week is 0-6 with 0 = Sunday (7 also accepted as Sunday). Evaluated in
 * LOCAL time, so "0 9 * * *" means 9am where the user sits.
 *
 * Scheduling is coalescing by construction (like Hermes): the due-checker asks
 * `lastScheduled(expr, now)`, the most recent minute at or before now that the
 * expression matches, and a job is due when its last run predates that. A
 * machine that slept through a slot fires it once on wake; it never stacks,
 * because the next check finds the same (now past) slot already covered.
 */

export interface CronExpr {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** Vixie rule: when both day fields are restricted, a date matches EITHER. */
  domRestricted: boolean
  dowRestricted: boolean
}

function parseField(spec: string, min: number, max: number): Set<number> | null {
  const set = new Set<number>()
  for (const part of spec.split(',')) {
    if (!part) return null
    let step = 1
    let range = part
    const slash = part.split('/')
    if (slash.length === 2) {
      step = Number(slash[1])
      range = slash[0]
      if (!Number.isInteger(step) || step < 1) return null
    } else if (slash.length > 2) {
      return null
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(range)
      // "a/n" means from a to the max in steps of n; a bare "a" is just a.
      hi = slash.length === 2 ? max : lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) set.add(v)
  }
  return set.size ? set : null
}

/** Parse a 5-field cron expression, or null if malformed / not a string. */
export function parseCron(expr: string): CronExpr | null {
  if (typeof expr !== 'string') return null
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dom = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dowRaw = parseField(parts[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dowRaw) return null
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)))
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

/** Does the given local date/time match the expression (to the minute)? */
export function matchesCron(c: CronExpr, d: Date): boolean {
  if (!c.minute.has(d.getMinutes())) return false
  if (!c.hour.has(d.getHours())) return false
  if (!c.month.has(d.getMonth() + 1)) return false
  const domOk = c.dom.has(d.getDate())
  const dowOk = c.dow.has(d.getDay())
  // Both day fields restricted → OR (Vixie cron). Otherwise the unrestricted
  // one is a full set, so `&&` already lets it through.
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

const SEARCH_CAP_MINUTES = 366 * 24 * 60

/** The most recent minute ≤ now the expression fires, or null (never / invalid). */
export function lastScheduled(expr: string, now: number): number | null {
  const c = parseCron(expr)
  if (!c) return null
  const d = new Date(now)
  d.setSeconds(0, 0)
  for (let i = 0; i < SEARCH_CAP_MINUTES; i++) {
    if (matchesCron(c, d)) return d.getTime()
    d.setMinutes(d.getMinutes() - 1)
  }
  return null
}

/** The next minute strictly after `from` the expression fires, or null. */
export function nextScheduled(expr: string, from: number): number | null {
  const c = parseCron(expr)
  if (!c) return null
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < SEARCH_CAP_MINUTES; i++) {
    if (matchesCron(c, d)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

// Human-readable rendering and presets: powering the frequency dropdown and
// the "Every day at 9:00 AM" preview line.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtTime(h: number, m: number): string {
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

const singleValue = (set: Set<number>): number | null => (set.size === 1 ? [...set][0] : null)

/** A best-effort English description of common expressions; falls back to raw. */
export function describeCron(expr: string): string {
  const c = parseCron(expr)
  if (!c) return typeof expr === 'string' ? expr : ''
  const m = singleValue(c.minute)
  const h = singleValue(c.hour)

  // */n minutes
  if (!c.domRestricted && !c.dowRestricted && c.hour.size === 24 && c.minute.size > 1) {
    const step = stepOf(c.minute, 60)
    if (step) return `Every ${step} minutes`
  }
  // hourly at minute m
  if (m != null && c.hour.size === 24 && !c.domRestricted && !c.dowRestricted) {
    return m === 0 ? 'Every hour' : `Every hour at :${String(m).padStart(2, '0')}`
  }
  // */n hours at minute m
  if (m != null && c.hour.size > 1 && !c.domRestricted && !c.dowRestricted) {
    const step = stepOf(c.hour, 24)
    if (step) return `Every ${step} hours`
  }
  if (m != null && h != null) {
    const at = fmtTime(h, m)
    if (!c.domRestricted && !c.dowRestricted) return `Every day at ${at}`
    if (!c.domRestricted && c.dowRestricted) {
      const days = [...c.dow].sort()
      if (days.length === 5 && days.every((d, i) => d === i + 1)) return `Weekdays at ${at}`
      if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${at}`
      return `${days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')} at ${at}`
    }
    if (c.domRestricted && !c.dowRestricted) {
      const dom = singleValue(c.dom)
      if (dom != null) return `Monthly on the ${ordinal(dom)} at ${at}`
    }
  }
  return expr
}

function stepOf(set: Set<number>, mod: number): number | null {
  const vals = [...set].sort((a, b) => a - b)
  if (vals.length < 2 || vals[0] !== 0) return null
  const step = vals[1] - vals[0]
  for (let i = 1; i < vals.length; i++) if (vals[i] - vals[i - 1] !== step) return null
  // must cover the whole cycle evenly
  if (mod % step !== 0 || vals.length !== mod / step) return null
  return step
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

/** The frequency-dropdown presets (label → cron), shared by server and web. */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 2 hours', cron: '0 */2 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9:00 AM', cron: '0 9 * * *' },
  { label: 'Weekdays at 9:00 AM', cron: '0 9 * * 1-5' },
  { label: 'Weekly (Monday 9:00 AM)', cron: '0 9 * * 1' },
]

/**
 * A tiny natural-language shim for the common phrases the dialog subtitle
 * promises ("every 15 minutes", "every 2 hours"). Returns a cron string or
 * null; the caller falls back to treating input as raw cron.
 */
export function phraseToCron(text: string): string | null {
  if (typeof text !== 'string') return null
  const t = text.trim().toLowerCase()
  let m = /^every\s+(\d+)\s*(m|min|mins|minute|minutes)$/.exec(t)
  if (m) {
    const n = Number(m[1])
    return n >= 1 && n <= 59 ? `*/${n} * * * *` : null
  }
  m = /^every\s+(\d+)\s*(h|hr|hrs|hour|hours)$/.exec(t)
  if (m) {
    const n = Number(m[1])
    return n >= 1 && n <= 23 ? `0 */${n} * * *` : null
  }
  if (/^(hourly|every hour)$/.test(t)) return '0 * * * *'
  if (/^daily$/.test(t)) return '0 9 * * *'
  return null
}

/** Backfill a cron string from the legacy cadence model (for old rows). */
export function cronFromCadence(
  cadence: 'hourly' | 'daily' | 'weekly',
  windowStart?: string,
  windowDay?: number,
): string {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(windowStart ?? '')
  const h = mt ? Math.min(23, Number(mt[1])) : 9
  const m = mt ? Math.min(59, Number(mt[2])) : 0
  if (cadence === 'hourly') return '0 * * * *'
  if (cadence === 'daily') return `${m} ${h} * * *`
  return `${m} ${h} * * ${((windowDay ?? 1) % 7 + 7) % 7}`
}
