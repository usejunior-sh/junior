import type { ScoredItem } from '../../shared/protocol.js'

/** "YYYY-MM-DD" in local time — the day string the due route and the pickers speak. */
export function toDayInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A day string as a local Date at noon, so a DST shift can never move it to another day. */
export function fromDayInput(day: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : undefined
}

/** The day you set on an item, for a picker; '' when none (a source's own deadline isn't yours to edit). */
export function dayInput(item: ScoredItem | null): string {
  return item?.dueSource === 'you' && item.dueAt != null ? toDayInput(item.dueAt) : ''
}
