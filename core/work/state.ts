/**
 * Item lifecycle (.docs/watches-v2.md). A work item is a durable fact: once
 * created it is never hard-deleted and never silently removed. It moves between
 * four states only via recorded transitions, and every transition is appended
 * to a per-item event log — the item's `status` is just a materialization of
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

/**
 * Who caused a transition. `user` = a click in the web UI; `agent:<sessionId>`
 * = a chat/dispatch session's tool call; `watch:<runId>` = a watch run;
 * `system` = deterministic reconciliation (a merged PR auto-done, a snooze that
 * elapsed).
 */
export type ItemActor = string

export interface ItemEvent {
  seq: number
  at: number
  actor: ItemActor
  event: ItemEventKind
  /** evidence ref, archive reason, snoozeUntil, provenance — event-specific */
  detail?: Record<string, unknown>
}

/**
 * A user/agent-driven status change. Snooze carries a wake time; archive may
 * carry a reason (kept for the later refine-the-watch feedback loop).
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
 * `done` and the source has a message newer than the moment it was marked done
 * → the item returns to `open`, marked `returned`. Archived items never reopen.
 * Snoozed items are woken by the snooze timer, not this rule. Never decided from
 * an LLM-reported timestamp — the caller passes the stored `done` time.
 */
export function shouldReopen(
  status: ItemStatus,
  incomingSourceUpdatedAt: number,
  statusAt: number,
): boolean {
  return status === 'done' && incomingSourceUpdatedAt > statusAt
}

/** Project the stored lifecycle fields onto the rendered item. */
export function withLifecycle(
  item: WorkItem,
  status: ItemStatus,
  returned: boolean,
): WorkItem {
  return { ...item, status, ...(returned ? { returned: true } : {}) }
}
