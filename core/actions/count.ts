/**
 * The daily count line: "Today: 3 PRs, 5 comments, 2 tickets, 1 post".
 * Counts only what went out — succeeded. A call still waiting on its result,
 * one held for approval, a failed or denied one: none of them. Pure and
 * browser-safe.
 */
import { ACTION_KINDS, KIND_LABEL, type ActionKind, type ActionStatus } from './types.js'

export type KindCount = { kind: ActionKind; n: number }

/** Per kind, in the kinds' own order, for records started at or after `since`. */
export function countSince(records: ReadonlyArray<{ kind: ActionKind; status: ActionStatus; count: number; attemptedAt: number }>, since: number): KindCount[] {
  const by = new Map<ActionKind, number>()
  for (const r of records) {
    if (r.attemptedAt < since || r.status !== 'succeeded') continue
    by.set(r.kind, (by.get(r.kind) ?? 0) + Math.max(1, r.count))
  }
  return ACTION_KINDS.filter((k) => by.has(k)).map((kind) => ({ kind, n: by.get(kind)! }))
}

/** "3 PRs" / "1 comment". */
export const kindCount = (c: KindCount): string => `${c.n} ${KIND_LABEL[c.kind][c.n === 1 ? 0 : 1]}`

/** The line, with today's failures after it when there were any: "Today: 1 PR, 4 pushes · 1 failed". */
export function countLine(counts: KindCount[], failed = 0): string {
  const line = counts.length ? `Today: ${counts.map(kindCount).join(', ')}` : 'Today: nothing has gone out yet'
  return failed > 0 ? `${line} · ${failed} failed` : line
}
