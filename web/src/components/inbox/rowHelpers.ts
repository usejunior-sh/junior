import type { ScoredItem } from '../../../../shared/protocol.js'
import type { Section } from '../../../../core/work/due.js'

/** A row's own id and every signal folded into it (core/work/link.ts). */
export function signalIds(item: ScoredItem): string[] {
  return [item.id, ...(item.linked ?? []).map((l) => l.id)]
}

/** "4 signals · Niraj, Drew", for a row that folds several items about one thing. */
export function signalsText(item: ScoredItem): string | null {
  if (!item.linked?.length) return null
  const people = [...new Set([item.author, ...item.linked.map((l) => l.author)].filter(Boolean))]
  const who = people.length > 2 ? `${people.slice(0, 2).join(', ')} +${people.length - 2}` : people.join(', ')
  return [`${item.linked.length + 1} signals`, who].filter(Boolean).join(' · ')
}

/** The due keys: t today, m next workday (Monday on a Friday), w this week, l later. */
export const DUE_KEYS: Record<string, Section> = { t: 'today', m: 'next-workday', w: 'this-week', l: 'later' }
export const DUE_KEY_OF = Object.fromEntries(Object.entries(DUE_KEYS).map(([k, s]) => [s, k])) as Record<Section, string>

/** Tomorrow 09:00 local: the one snooze duration the inbox knows (`z`). */
export function tomorrow9(): number {
  const t = new Date()
  t.setDate(t.getDate() + 1)
  t.setHours(9, 0, 0, 0)
  return t.getTime()
}
