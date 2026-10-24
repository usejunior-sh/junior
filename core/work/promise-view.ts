/**
 * How a promise item reads on a row (plan item `promise-items-ui`,
 * .docs/overnight-2026-10-24/designs/promise-items-ui.md):
 *
 *   Dev   Owed to Dev · overdue 1d                 Overdue 1d   #eng-api   2d
 *         “I'll look at the retry fix tomorrow”
 *
 * The move names who is owed (never "Answer Dev"), the due rides in the
 * reasons and the state cell, and the quote is the row's second line.
 * A due is a day (startOfDay): overdue means before today.
 *
 * Pure and browser-safe; the reference time is always an argument.
 */
import { startOfDay } from './due.js'

const DAY = 86_400_000
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Where a promise's due day stands today. */
export interface PromiseDue {
  /** days from today to the due day: 0 today, 1 tomorrow, -2 two days late */
  days: number
  overdue: boolean
  /** in the move's reasons, mono: "due today", "due Fri", "overdue 2d" */
  reason: string
  /** the state cell: "Due today", "Due Fri", "Overdue 2d" */
  cell: string
  /** the open card's Due line: "Today", "Tomorrow", "Fri", "Thu, 2 days late" */
  line: string
}

/** Whole calendar days from a to b (both local midnights); DST-safe. */
function dayDiff(a: number, b: number): number {
  return Math.round((b - a) / DAY)
}

/** "Fri" within the week ahead or behind, else "Nov 3". */
function dayName(dayMs: number, days: number): string {
  const d = new Date(dayMs)
  return Math.abs(days) <= 6 ? WEEKDAY[d.getDay()]! : `${MONTH[d.getMonth()]} ${d.getDate()}`
}

/** The due as words, or null with no due day. */
export function promiseDue(dueAt: number | undefined | null, now: number): PromiseDue | null {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) return null
  const day = startOfDay(dueAt)
  const days = dayDiff(startOfDay(now), day)
  if (days < 0) {
    const n = -days
    return { days, overdue: true, reason: `overdue ${n}d`, cell: `Overdue ${n}d`, line: `${dayName(day, days)}, ${n} day${n === 1 ? '' : 's'} late` }
  }
  if (days === 0) return { days, overdue: false, reason: 'due today', cell: 'Due today', line: 'Today' }
  if (days === 1) return { days, overdue: false, reason: 'due tomorrow', cell: 'Due tomorrow', line: 'Tomorrow' }
  const name = dayName(day, days)
  return { days, overdue: false, reason: `due ${name}`, cell: `Due ${name}`, line: name }
}

/**
 * Who's owed, as a row names them: "@dev" → "dev", "Dev Patel" → "Dev",
 * a Slack "<@U1|dev>" → "dev". Null when no one is named.
 */
export function owedName(owedTo: string | undefined | null): string | null {
  const raw = owedTo?.trim()
  if (!raw) return null
  const slack = /^<@[A-Z0-9]+\|([^>]+)>$/.exec(raw)
  const s = (slack ? slack[1]! : raw).replace(/^@/, '').trim()
  return s.split(/\s+/)[0] || null
}

/** Line 1's verb: "Owed to Dev", or "Your promise" when no one is named. */
export function promiseVerb(owedTo: string | undefined | null): string {
  const n = owedName(owedTo)
  return n ? `Owed to ${n}` : 'Your promise'
}

/** What Junior says on the open card: "You told Dev you would. It's 2 days late." */
export function promiseSays(owedTo: string | undefined | null, due: PromiseDue | null): string {
  const n = owedName(owedTo)
  const head = n ? `You told ${n} you would.` : 'You said you would.'
  if (!due) return head
  if (due.days === 0) return `${head} It's due today.`
  if (due.overdue) return `${head} It's ${-due.days} day${due.days === -1 ? '' : 's'} late.`
  return head
}

/** "4:12 pm". */
function clock(d: Date): string {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}`
}

/** When you said it, for the open card: "Tue 4:12 pm" within the week, "Oct 12, 4:12 pm" before. */
export function saidWhen(saidAt: number, now: number): string {
  const d = new Date(saidAt)
  const days = dayDiff(startOfDay(saidAt), startOfDay(now))
  const day = days >= 0 && days <= 6 ? WEEKDAY[d.getDay()]! : `${MONTH[d.getMonth()]} ${d.getDate()},`
  return `${day} ${clock(d)}`
}

/** The quote with curly quotes, for the chip: “I'll look at it tomorrow”. */
export function quoted(quote: string): string {
  return `“${quote.trim().replace(/^["“”]+|["“”]+$/g, '')}”`
}
