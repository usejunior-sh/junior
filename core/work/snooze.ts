/**
 * The snooze menu's times (hand-offs, Phase 1): 1 hour, 4 hours, 1, 2 or 3
 * days. Hours are exact; days land at 9:00 that morning, so a snooze never
 * wakes you at night. A snooze ends early when the item changes (the reopen
 * rule, state.ts). Pure, browser-safe; local time.
 *
 * The menu also takes a time in plain words ("till tue 9am", "in 2 working
 * days"), read by shared/when.ts. `readSnooze` is what the menu shows under
 * the field and what Snooze saves: the parsed time, or a hint.
 */
import { parseWhen } from '../../shared/when.js'

export type SnoozeFor = '1h' | '4h' | '1d' | '2d' | '3d'
export const SNOOZE_CHOICES: readonly { id: SnoozeFor; label: string }[] = [
  { id: '1h', label: '1 hour' },
  { id: '4h', label: '4 hours' },
  { id: '1d', label: '1 day' },
  { id: '2d', label: '2 days' },
  { id: '3d', label: '3 days' },
]

/** The morning a day-snooze lands on. */
export const SNOOZE_MORNING_HOUR = 9

export function snoozeUntil(choice: SnoozeFor, now: number): number {
  if (choice === '1h') return now + 3_600_000
  if (choice === '4h') return now + 4 * 3_600_000
  const d = new Date(now)
  d.setDate(d.getDate() + Number(choice[0]))
  d.setHours(SNOOZE_MORNING_HOUR, 0, 0, 0)
  return d.getTime()
}

const pad = (n: number) => String(n).padStart(2, '0')

/** When it comes back, as the menu shows it: "14:12" today, "Thu 9:00" after. */
export function snoozeClock(until: number, now: number): string {
  const d = new Date(until)
  const time = `${d.getHours()}:${pad(d.getMinutes())}`
  if (new Date(now).toDateString() === d.toDateString()) return time
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** What the typed field reads as: nothing yet, a time to show, or not a time. */
export type SnoozeRead =
  | { kind: 'empty' }
  | { kind: 'time'; at: number; label: string }
  | { kind: 'unread' }

/**
 * The typed field, read against `now`. Blank text is `empty` (no line, no
 * save). A past time, or text with no time in it, is `unread` (the hint,
 * no save). Otherwise the exact `at` that Snooze saves and its label.
 */
export function readSnooze(text: string, now: number): SnoozeRead {
  if (!text.trim()) return { kind: 'empty' }
  const w = parseWhen(text, now)
  if (!w || w.at <= now) return { kind: 'unread' }
  return { kind: 'time', at: w.at, label: w.label }
}

/**
 * The time to save for a read that was shown at some point: the shown `at`
 * while it is still ahead, else one fresh read (the menu was left open past
 * it). Null when even that fails, so the menu shows the hint instead.
 */
export function snoozeToSave(text: string, shown: SnoozeRead, now: number): number | null {
  if (shown.kind === 'time' && shown.at > now) return shown.at
  const again = readSnooze(text, now)
  return again.kind === 'time' ? again.at : null
}
