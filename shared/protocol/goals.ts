import type { Goal, GoalTurn, GoalPlan, GoalStepState, Gate, GoalEvent, StepRole } from '../../core/goals/types.js'
import type { PlanComment } from '../../core/goals/review.js'

// ---------------------------------------------------------------------------
// Goals (GET /api/goals, GET /api/goals/<id>) — outcomes Junior drives across
// many sessions (.docs/goals/goals-engine.md). Domain types live in
// core/goals/types.ts; the state machine in core/goals/machine.ts.
// ---------------------------------------------------------------------------

export type {
  Gate,
  GateEvaluator,
  GateSpec,
  GateStatus,
  GateVerdict,
  Goal,
  GoalActor,
  GoalBudget,
  GoalEvent,
  GoalEventKind,
  GoalHorizon,
  GoalLogEntry,
  GoalPlan,
  GoalState,
  GoalStepState,
  GoalTurn,
  PlanStep,
  StepRole,
  StepStatus,
  StepType,
  TeamSeat,
} from '../../core/goals/types.js'

/** One row of the Goals list. */
export type GoalSummary = Pick<Goal, 'id' | 'title' | 'state' | 'horizon' | 'reason' | 'sourceItemId' | 'currentStep' | 'spentUsd' | 'budget' | 'updatedAt'> & {
  turn: GoalTurn
  /** gates still open, AI and user */
  openGates: number
}

export type GoalsResponse =
  | {
      ok: true
      goals: GoalSummary[]
      /** goals whose turn is the user's — the Inbox's and the rail's count */
      waitingOnYou: number
    }
  | { ok: false; error: string }

/** A question or plan change from a goal's lead, open until the user answers it. */
/**
 * A gate the user is asked about: a user gate (an approval), an AI gate its
 * checker couldn't decide, or one past its deadline. Answered with
 * approve / keep waiting (an AI gate only) / reject.
 */
export type GoalAskGate = { id: string; stepId: string; condition: string; evaluator: 'ai' | 'user' | 'watcher'; why: 'approval' | 'needs_user' | 'deadline' }

export type GoalAsk =
  | { kind: 'ask'; question: string; recommended: string; evidence: string | null; options: string[]; gate: GoalAskGate | null }
  | { kind: 'plan_change'; why: string; plan: GoalPlan }
  | { kind: 'other'; reason: string }

/** The goal page: the record, its run-time state, and the ledger's files as text. */
export type GoalResponse =
  | {
      ok: true
      goal: Goal
      turn: GoalTurn
      steps: GoalStepState[]
      gates: Gate[]
      /** newest last */
      events: GoalEvent[]
      plan: string
      handoff: string
      /** the latest entries of log.md, oldest first */
      log: string
      /** set after repeated ledger commit failures (decision 7) */
      ledgerWarning: string | null
      /** comments on the plan under review, since it was proposed — what send-back hands the lead */
      comments: PlanComment[]
      /** the lead session drafting the plan right now, if one is */
      leadSessionId: string | null
      /** M3: the session working the goal right now (a run lead or a worker), if one is */
      liveSession: { sessionId: string; role: StepRole; stepId: string | null } | null
      /** M6: everyone on the goal right now — the lead alone, or its workers side by side — oldest first */
      team: GoalTeamMember[]
      /** M3: what the goal waits on the user for — a question with Junior's recommended answer, or a plan change */
      ask: GoalAsk | null
    }
  | { ok: false; error: string }

/** One live session on a goal: who, on which step, since when, and when it last did something. */
export type GoalTeamMember = { sessionId: string; role: StepRole; stepId: string | null; startedAt: number; lastActivityAt: number | null }

/**
 * What a goal write did. created / existing = goal_create (existing: the key
 * was taken, nothing written); proposed / unchanged = goal_propose_plan;
 * appended / revised / unchanged = goal_log_append; written / unchanged =
 * goal_handoff_write; approved / commented / sent_back = the user's plan
 * review. `unchanged` is a repeat call that wrote nothing.
 */
export type GoalWriteOutcome =
  | 'created'
  | 'existing'
  | 'proposed'
  | 'appended'
  | 'revised'
  | 'written'
  | 'approved'
  | 'commented'
  | 'sent_back'
  | 'unchanged'
  // M3: the run loop's steering — answers, messages, edits, take over and hand back, the result
  | 'answered'
  | 'messaged'
  | 'edited'
  | 'taken_over'
  | 'handed_back'
  | 'accepted'

export type GoalWriteResponse = { ok: true; goal: Goal; outcome: GoalWriteOutcome } | { ok: false; error: string }
