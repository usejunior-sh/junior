/**
 * Item lifecycle (.docs/jobs-v2.md). A work item is a durable fact: once
 * created it is never hard-deleted and never silently removed. It moves between
 * four states only via recorded transitions, and every transition is appended
 * to a per-item event log. The item's `status` is just a materialization of
 * the latest event. Current state is always derivable from the log; any
 * mismatch is a visible bug.
 *
 * The LLM decides relevance, never lifecycle: existence, reopen, and expiry are
 * deterministic code operating on ingestion/source timestamps, applied here and
 * in the store adapter, never inferred from model output.
 */
import type { WorkItem } from './types.js'

export type ItemStatus = 'open' | 'snoozed' | 'done' | 'archived'

/**
 * A recorded transition on one item. `created`/`updated`/`reopened` are written
 * by ingestion (the reopen rule below); `done`/`archived`/`snoozed`/`woken` by
 * the user, an agent, or the system. Kept append-only, keyed `(item_id, seq)`,
 * exactly like `session_events`.
 */
export type ItemEventKind =
  | 'created'
  | 'updated'
  | 'reopened'
  | 'done'
  | 'archived'
  | 'snoozed'
  | 'woken'
  // stage/turn (flow.ts): `moved` when the derived flow changes, `flow-set`
  // when the user overrides it (or clears the override)
  | 'moved'
  | 'flow-set'
  // attention (core/junior/attention.ts): `surfaced` the first time an open
  // item lands on Needs you in this open cycle (written by the inbox sync,
  // once per cycle); `not-useful` when you mark a Needs you row not useful.
  // Neither changes the item's status.
  | 'surfaced'
  | 'not-useful'
  // supervision (core/work/supervision.ts): you opened the item's list of
  // files Junior changed; files touched before it no longer count
  | 'changes-seen'
  // close candidates (core/work/close.ts): you said keep this quiet PR open
  | 'kept-open'
  // promises (core/work/promise-items.ts): you said a promise item isn't
  // one; its thread files no more promises. Doesn't move the status (the
  // op archives the item separately).
  | 'not-a-promise'

/**
 * Who caused a transition. `user` = a click in the web UI; `agent:<sessionId>`
 * = a chat/dispatch session's tool call; `job:<runId>` = a job run;
 * `system` = deterministic reconciliation (a merged PR auto-done, a snooze that
 * elapsed).
 */
export type ItemActor = string

export interface ItemEvent {
  seq: number
  at: number
  actor: ItemActor
  event: ItemEventKind
  /** evidence ref, archive reason, snoozeUntil, provenance, event-specific */
  detail?: Record<string, unknown>
}

/**
 * A user/agent-driven status change. Snooze carries a wake time; archive may
 * carry a reason (kept for the later refine-the-job feedback loop).
 */
export interface StatusChange {
  status: ItemStatus
  actor: ItemActor
  /** epoch ms; required when status is 'snoozed' */
  snoozeUntil?: number
  detail?: Record<string, unknown>
}

/** The event kind a status transition appends. */
export function eventForStatus(status: ItemStatus): ItemEventKind {
  switch (status) {
    case 'open':
      return 'reopened'
    case 'snoozed':
      return 'snoozed'
    case 'done':
      return 'done'
    case 'archived':
      return 'archived'
  }
}

/**
 * The reopen rule (deterministic). A run/upsert touches a thread whose item is
 * `done` or `snoozed`, and the source has activity newer than the moment it
 * was marked so → the item returns to `open`, marked `returned`. A snooze
 * ends early when something changes (CI, a comment, a ping); otherwise the
 * snooze timer wakes it. Archived items never reopen. Never decided from an
 * LLM-reported timestamp: the caller passes the stored status time.
 */
export function shouldReopen(
  status: ItemStatus,
  incomingSourceUpdatedAt: number,
  statusAt: number,
): boolean {
  return (status === 'done' || status === 'snoozed') && incomingSourceUpdatedAt > statusAt
}

/** Project the stored lifecycle fields onto the rendered item. */
export function withLifecycle(
  item: WorkItem,
  status: ItemStatus,
  returned: boolean,
): WorkItem {
  return { ...item, status, ...(returned ? { returned: true } : {}) }
}

/** Events that record something about an item without moving its status. */
export type ItemNoteKind = 'surfaced' | 'not-useful' | 'changes-seen' | 'kept-open' | 'not-a-promise'

/** The status an event leaves the item in; null = it doesn't move the status. */
export function statusAfter(event: ItemEventKind, before: ItemStatus | null): ItemStatus | null {
  switch (event) {
    case 'created':
    case 'reopened':
    case 'woken':
      return 'open'
    case 'done':
    case 'archived':
    case 'snoozed':
      return event
    case 'updated':
      // only a reopen moves status on ingestion, and that writes `reopened`
      return before
    default:
      return null
  }
}

/** One open cycle of an item: from created (or reopened after a close) to its next done or archive. */
export interface ItemCycle<E extends Pick<ItemEvent, 'at' | 'event'> = ItemEvent> {
  /** the event that opened it */
  start: E
  /** every event in the cycle, the opening one first and the closing one last */
  events: E[]
  /** the done or archive that closed it; null while it is still open (or snoozed) */
  end: E | null
}

/**
 * Split an item's log into open cycles. A cycle starts at `created`, or at
 * a `reopened`/`woken` that follows a done or archive; a snooze and its wake
 * stay inside one cycle. A log whose first event isn't `created` (an older
 * item) starts its first cycle at its first event. Events must be in order.
 */
export function itemCycles<E extends Pick<ItemEvent, 'at' | 'event'>>(events: readonly E[]): ItemCycle<E>[] {
  const out: ItemCycle<E>[] = []
  let cur: ItemCycle<E> | null = null
  let status: ItemStatus | null = null
  for (const e of events) {
    const closed = status === 'done' || status === 'archived'
    const next = statusAfter(e.event, status)
    if (!cur || (closed && next === 'open') || e.event === 'created') {
      cur = { start: e, events: [], end: null }
      out.push(cur)
    }
    cur.events.push(e)
    if (e.event === 'done' || e.event === 'archived') cur.end = e
    else if (next === 'open' || next === 'snoozed') cur.end = null
    if (next !== null) status = next
  }
  return out
}

/** Whether the item's current open cycle already has a `surfaced` event. */
export function surfacedThisCycle(events: readonly Pick<ItemEvent, 'at' | 'event'>[]): boolean {
  const cycles = itemCycles(events)
  const last = cycles[cycles.length - 1]
  return !!last && !last.end && last.events.some((e) => e.event === 'surfaced')
}
