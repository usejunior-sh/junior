/**
 * A team run reduced to what the session list, the inbox flow and the action
 * log read: who is on it, its state, and whether a goal waits on you. Boot
 * loads only open runs whole (server/team-run/state.ts); a closed one comes in
 * as this summary, read straight out of the row (closedSummaries in
 * core/store/sqlite-team-runs.ts), and is loaded whole only when something
 * needs it. summarizeRun is the same reduction over a run in memory, so the two
 * can't disagree.
 */
import type { RunState, TeamRun } from './engine-types.js'
import { LEAD } from './recipe.js'

export type TeamRunSummary = {
  id: string
  itemId: string
  state: RunState
  rev: number
  createdAt: number
  /** the run has a goal */
  goal: boolean
  leadSessionId: string
  /** the recipe's label, for "Team · Build" on an action */
  label: string
  /** every worker slot with a session, in run order */
  workers: { sessionId: string; agent: string; label: string }[]
  /** questions on its goal still unanswered */
  asks: number
  /** a goal that is done and not yet accepted: your turn */
  toAccept: boolean
}

export function summarizeRun(run: TeamRun): TeamRunSummary {
  return {
    id: run.id,
    itemId: run.itemId,
    state: run.state,
    rev: run.rev ?? 0,
    createdAt: run.createdAt,
    goal: !!run.goal,
    leadSessionId: run.leadSessionId,
    label: run.recipe?.label ?? '',
    workers: run.workers.filter((w) => !!w.sessionId).map((w) => ({ sessionId: w.sessionId!, agent: w.agent, label: w.label })),
    asks: run.goal?.questions?.filter((q) => q.answer === null).length ?? 0,
    toAccept: !!run.goal && run.state === 'done' && !run.goal.acceptedAt,
  }
}

/** The fields a session's place on a run reads: a whole run and a summary both have them. */
type Linkable = {
  id: string
  leadSessionId: string
  state: RunState
  rev: number
  goal?: unknown
  workers: readonly { sessionId: string | null; agent: string; label: string }[]
}

/** A session's place on a run: lead, or the worker slot it last filled. */
export function runLinkOf(run: Linkable, sessionId: string): { id: string; role: 'lead' | 'worker'; label: string; state: RunState; rev: number; goal?: true } {
  const lead = run.leadSessionId === sessionId
  const w = [...run.workers].reverse().find((x) => x.sessionId === sessionId && x.agent !== LEAD)
  return { id: run.id, role: lead ? 'lead' : 'worker', label: lead ? 'Lead' : w?.label ?? 'Worker', state: run.state, rev: run.rev ?? 0, ...(run.goal ? { goal: true as const } : {}) }
}
