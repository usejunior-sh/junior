/**
 * The attention split's two ends on the server (core/junior/attention.ts):
 *
 * - recordSurfaced: the inbox sync marks every open item that landed on
 *   Needs you with one `surfaced` event per open cycle. Today nothing else
 *   records when something reached you.
 * - readAttentionInput / readAttentionSplit: a thin, read-only adapter from
 *   the store to the pure split. Nothing calls it yet: showing the split
 *   waits for the standup call. Nothing here is sent anywhere.
 */
import { attentionSplit, type AttentionHandoff, type AttentionInput, type AttentionItem, type AttentionSend, type AttentionTask, type AttentionOptions, type AttentionSplit, needsYouVia, WEEK_MS } from '../core/junior/attention.js'
import { judge } from '../core/approvals/track.js'
import { askOf } from '../core/work/asks.js'
import { isHumanAsk } from '../core/work/inbox-tabs.js'
import type { ScoredItem, WorkItem } from '../core/work/types.js'
import type { Store, WorkItemStore } from '../core/store/types.js'

/** How far before the week the read looks for items: a wait or a cycle can start weeks before it closes. */
export const ATTENTION_LOOKBACK_MS = 4 * WEEK_MS

/**
 * Mark the items on Needs you as surfaced (once per open cycle; the store
 * skips the rest). Returns the ids marked now.
 */
export async function recordSurfaced(items: WorkItemStore, ranked: readonly ScoredItem[], now: number): Promise<string[]> {
  const entries = ranked.flatMap((i) => {
    const via = needsYouVia(i, now)
    return via ? [{ id: i.id, detail: { via } }] : []
  })
  return entries.length ? items.markSurfaced(entries, now) : []
}

/** When a person started waiting on you for it, or null when nobody waits. A to-do you wrote yourself has nobody. */
export function waitingSinceOf(item: WorkItem): number | null {
  if (!isHumanAsk({ ...item, ask: askOf(item), score: 0 })) return null
  const at = Date.parse(item.createdAt)
  return Number.isFinite(at) ? at : null
}

/** The split's input for items with any event in [since, until): their logs, held sends, tasks and hand-offs. */
export async function readAttentionInput(store: Store, q: { since: number; until: number }): Promise<AttentionInput> {
  const ids = [...new Set((await store.items.eventsBetween(q.since, q.until)).map((e) => e.itemId))]
  const want = new Set(ids)
  const input = { items: [] as AttentionItem[], sends: [] as AttentionSend[], tasks: [] as AttentionTask[], handoffs: [] as AttentionHandoff[] }
  const items = new Map<string, WorkItem>()
  for (const id of ids) {
    const item = await store.items.get(id)
    if (!item) continue
    items.set(id, item)
    input.items.push({ id, waitingSince: waitingSinceOf(item), events: await store.items.events(id) })
  }

  const held = (await store.actions.held({ since: q.since, until: q.until })).filter((r) => r.itemId && want.has(r.itemId))
  const history = await store.actions.history(held.map((r) => r.id))
  for (const record of held) {
    const j = judge({ record, history: history.get(record.id) ?? [] })
    if (j) input.sends.push({ itemId: record.itemId!, outcome: j.outcome, at: j.decidedAt })
  }

  const tasks = await store.tasks.forItems(ids)
  for (const [itemId, list] of tasks) {
    for (const t of list) input.tasks.push({ itemId, owner: t.owner, state: t.state, endedAt: t.endedAt ?? null })
  }

  // A hand-off isn't timed in the store: the first Junior task that started is the latest it can have been.
  for (const [id, item] of items) {
    if (!item.handoff) continue
    const started = (tasks.get(id) ?? []).filter((t) => t.owner === 'junior' && t.startedAt).map((t) => t.startedAt!)
    input.handoffs.push({ itemId: id, at: started.length ? Math.min(...started) : null })
  }
  return input
}

/** The split for the week starting `weekStart`, read from the store. Read-only. */
export async function readAttentionSplit(store: Store, weekStart: number, now: number, opts: AttentionOptions = {}): Promise<AttentionSplit> {
  const until = Math.min(weekStart + WEEK_MS, now + 1)
  const input = await readAttentionInput(store, { since: weekStart - ATTENTION_LOOKBACK_MS, until })
  return attentionSplit(input, weekStart, now, opts)
}
