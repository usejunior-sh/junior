/**
 * The snooze menu's times (hand-offs, Phase 1): 1 hour, 4 hours, 1, 2 or 3
 * days. Hours are exact; days land at 9:00 that morning, so a snooze never
 * wakes you at night. A snooze ends early when the item changes (the reopen
 * rule, state.ts). Pure, browser-safe; local time.
 */

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
