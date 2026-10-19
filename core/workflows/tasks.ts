import type { SdkMessage } from '../../shared/protocol.js'

// Which Ultracode Workflow runs a subprocess still has going, from its own
// stream. The server holds a turn open while one is (live-session.ts), and the
// web's transcript fold mirrors it so both number turns the same way.

const ENDED = new Set(['completed', 'failed', 'stopped', 'killed'])

/** The task this message says has ended, if it says so. */
export function endedTask(m: SdkMessage): string | undefined {
  if (m.type !== 'system' || !m.task_id) return undefined
  if (m.subtype === 'task_notification' || (m.subtype === 'task_updated' && ENDED.has(m.patch?.status ?? ''))) return m.task_id
  return undefined
}

/**
 * Fold one SDK message into the set of running Workflow task ids. Returns
 * whether the set changed. task_started / task_updated / task_notification
 * are the edges; background_tasks_changed is the CLI's own level signal and
 * replaces the set, so a missed edge can't leave a run "going" forever.
 */
export function noteWorkflowTask(running: Set<string>, m: SdkMessage): boolean {
  if (m.type !== 'system') return false
  const id = m.task_id
  switch (m.subtype) {
    case 'task_started':
      if (!id || m.task_type !== 'local_workflow' || running.has(id)) return false
      running.add(id)
      return true
    case 'task_updated':
    case 'task_notification': {
      const ended = endedTask(m)
      return !!ended && running.delete(ended)
    }
    case 'background_tasks_changed': {
      const tasks = (m as { tasks?: unknown }).tasks
      if (!Array.isArray(tasks)) return false
      const now = new Set<string>()
      for (const t of tasks as { task_id?: unknown; task_type?: unknown; ambient?: unknown }[]) {
        if (t && typeof t.task_id === 'string' && t.task_type === 'local_workflow' && t.ambient !== true) now.add(t.task_id)
      }
      if (now.size === running.size && [...now].every((t) => running.has(t))) return false
      running.clear()
      for (const t of now) running.add(t)
      return true
    }
    default:
      return false
  }
}

/**
 * Whether a result closes the turn, from the runs a subprocess has going. A
 * run outlives the turn that launched it and edits files, so the turn stays
 * open while one goes on. When one ends, the SDK starts a turn of its own to
 * report it (and maybe apply what it found), so the result of the turn the run
 * ended in leaves it open too, for that wake-up's result to close. Every turn
 * opens with an init, which is how the wake-up is told apart from the turn
 * the run ended in.
 */
export class WorkflowTurns {
  readonly running = new Set<string>()
  private endedThisTurn = false

  /** Fold one SDK message in; returns whether the running set changed. */
  note(m: SdkMessage): boolean {
    if (m.type === 'system' && m.subtype === 'init') this.endedThisTurn = false
    const before = this.running.size ? [...this.running] : null
    const changed = noteWorkflowTask(this.running, m)
    if (changed && before?.some((t) => !this.running.has(t))) this.endedThisTurn = true
    return changed
  }

  /** At a result: whether the turn stays open for a run. Call it at every result. */
  holdAtResult(): boolean {
    const held = this.running.size > 0 || this.endedThisTurn
    this.endedThisTurn = false
    return held
  }

  /** The subprocess is gone, and its runs with it. */
  clear() {
    this.running.clear()
    this.endedThisTurn = false
  }
}
