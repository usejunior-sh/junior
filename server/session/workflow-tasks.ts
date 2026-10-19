import type { SdkMessage, SessionEvent, WorkflowProgressEntry } from '../../shared/protocol.js'

// The server's side of Ultracode runs (.docs/ultracode.md): which Workflow
// runs are still going in a live subprocess, and how often their progress
// frames are worth keeping. Pure, so a recorded stream can be replayed
// through it in a test.

// Which runs are going is shared with the web's transcript fold, which numbers
// turns the way this server holds them open.
export { endedTask, noteWorkflowTask, WorkflowTurns } from '../../core/workflows/tasks.js'

/**
 * What a progress snapshot says about its agents: a new one, one changing
 * state, or one leaving the queue is worth keeping. A queued agent and a
 * started one can both say 'start'; only the started one has an id (which
 * names its transcript) and a start time.
 */
export function progressSignature(snapshot: readonly WorkflowProgressEntry[]): string {
  return snapshot
    .flatMap((e) => (e?.type === 'workflow_agent' ? [`${e.index}:${e.state ?? ''}:${e.agentId ?? ''}:${e.startedAt ?? ''}`] : []))
    .join(',')
}

/** Which workflow agent ids a progress snapshot names, so a permission prompt can say whose run it came from. */
export function snapshotAgentIds(m: SdkMessage): string[] {
  if (!Array.isArray(m.workflow_progress)) return []
  return m.workflow_progress.flatMap((e) => (e?.type === 'workflow_agent' && typeof e.agentId === 'string' && e.agentId ? [e.agentId] : []))
}

/** A run's progress is written to the log at most this often while nothing changes state. */
export const PROGRESS_PERSIST_MS = 5_000

export type ProgressMark = { sig: string; at: number }

/**
 * A run's throttle state: the last frame the log kept, plus what it still
 * owes: the newest skipped snapshot, and the newest bare frame (usage, no
 * snapshot) skipped after it.
 */
export type ProgressPending = ProgressMark & { snapshot?: SessionEvent; bare?: SessionEvent }

/**
 * Fold one task_progress frame into the throttle: whether it goes into the
 * log, what goes in ahead of it, and the state after. A bare frame kept on
 * the clock carries no snapshot, so the newest skipped one goes in first.
 */
export function throttleProgress(
  prev: ProgressPending | undefined,
  m: SdkMessage,
  event: SessionEvent,
  now: number,
): { keep: boolean; before: SessionEvent[]; next: ProgressPending } {
  const { keep, mark } = keepProgress(prev, m, now)
  const snap = Array.isArray(m.workflow_progress)
  if (keep) return { keep, before: !snap && prev?.snapshot ? [prev.snapshot] : [], next: mark }
  return { keep, before: [], next: snap ? { ...mark, snapshot: event } : { ...mark, snapshot: prev?.snapshot, bare: event } }
}

/** What the log still owes a run, oldest first. */
export const owedProgress = (p: ProgressPending | undefined): SessionEvent[] => [p?.snapshot, p?.bare].filter((e): e is SessionEvent => !!e)

/**
 * Whether a Workflow task_progress frame goes into the log. Every frame is
 * broadcast; the log keeps the first, any whose agents changed state, and one
 * every few seconds otherwise. A frame without a snapshot keeps the last
 * signature, so it is only kept on the clock.
 */
export function keepProgress(last: ProgressMark | undefined, m: SdkMessage, now: number): { keep: boolean; mark: ProgressMark } {
  const sig = Array.isArray(m.workflow_progress) ? progressSignature(m.workflow_progress) : (last?.sig ?? '')
  const keep = !last || sig !== last.sig || now - last.at >= PROGRESS_PERSIST_MS
  return { keep, mark: keep ? { sig, at: now } : { sig, at: last.at } }
}
