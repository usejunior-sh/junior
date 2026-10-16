/**
 * Goals (.docs/goals/goals-engine.md, mapping note .docs/goals/goals-mapping.md):
 * an outcome with a done-when that Junior drives across many short sessions,
 * pausing only at gates. A goal has a plan the user approved, a lead that wakes
 * on events, a team, gates and a ledger (plan/log/handoff files in the
 * artifacts repo; state in the database).
 *
 * This file is the shared vocabulary — browser-safe, no I/O. The web imports
 * these types through shared/protocol.ts. The state machine is
 * core/goals/machine.ts; the tool signatures core/goals/tools.ts.
 */
import type { Turn } from '../work/flow.js'

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

/**
 * Where a goal is (the lifecycle diagram's 8 states, plus decision 3's two):
 *   draft_plan     the lead is researching and writing the plan
 *   plan_ready     the plan waits on the user's review
 *   queued         runnable, waiting for a session slot
 *   running        a lead or worker session is working it
 *   waiting_world  parked on a gate the world resolves (CI, a ticket status)
 *   waiting_you    parked on the user: an approval, a question, a plan change, a budget pause
 *   result_ready   done-when holds; the result waits on the user's accept
 *   done           accepted (terminal)
 *   paused         the user took over: not running, not the user's turn
 *   cancelled      the user stopped it (terminal)
 */
export type GoalState =
  | 'draft_plan'
  | 'plan_ready'
  | 'queued'
  | 'running'
  | 'waiting_world'
  | 'waiting_you'
  | 'result_ready'
  | 'done'
  | 'paused'
  | 'cancelled'

export const GOAL_STATES: readonly GoalState[] = [
  'draft_plan',
  'plan_ready',
  'queued',
  'running',
  'waiting_world',
  'waiting_you',
  'result_ready',
  'done',
  'paused',
  'cancelled',
]
export const isGoalState = (v: unknown): v is GoalState => typeof v === 'string' && (GOAL_STATES as readonly string[]).includes(v)

export const GOAL_STATE_LABEL: Record<GoalState, string> = {
  draft_plan: 'Drafting plan',
  plan_ready: 'Plan ready',
  queued: 'Queued',
  running: 'Running',
  waiting_world: 'Waiting on the world',
  waiting_you: 'Waiting on you',
  result_ready: 'Result ready',
  done: 'Done',
  paused: 'Paused',
  cancelled: 'Cancelled',
}

/** today = finish by end of day; until_done = keep going; ongoing = never "done", e.g. keep a dependency current. */
export type GoalHorizon = 'today' | 'until_done' | 'ongoing'
export const GOAL_HORIZONS: readonly GoalHorizon[] = ['today', 'until_done', 'ongoing']
export const isGoalHorizon = (v: unknown): v is GoalHorizon => typeof v === 'string' && (GOAL_HORIZONS as readonly string[]).includes(v)

/** Spend and time caps. Null = no cap of that kind. */
export type GoalBudget = { usd: number | null; minutes: number | null }

/** One goal, as the `goals` table holds it. The plan is cached parsed; `plan.md` is its source. */
export type Goal = {
  id: string
  title: string
  doneWhen: string
  horizon: GoalHorizon
  state: GoalState
  /** why it's waiting, paused or cancelled, in a line */
  reason: string | null
  /** the work item it came from; null = made from chat */
  sourceItemId: string | null
  /** the caller-stable key goal_create dedupes on (a source item id, a client id) */
  key: string | null
  /** the project it works in, and the goal's one worktree (decision 2) once made */
  projectId: string | null
  checkoutId: string | null
  /** the approved plan; null until one is proposed. While plan_ready, the proposal. */
  plan: GoalPlan | null
  /** bumped on every accepted plan change, so a log entry can say which plan it worked from */
  planVersion: number
  /** the step being worked, or the one waiting; null between steps */
  currentStep: string | null
  budget: GoalBudget
  /** dollars recorded by the goal's sessions so far */
  spentUsd: number
  /** higher runs first in the queue; ties go to the older goal */
  priority: number
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** agent = a session does it; gate = a pause the goal can't pass until it resolves; block = a workflow block expanded at approval. */
export type StepType = 'agent' | 'gate' | 'block'
export const STEP_TYPES: readonly StepType[] = ['agent', 'gate', 'block']

export type StepRole = 'lead' | 'builder' | 'reviewer' | 'tester'
export const STEP_ROLES: readonly StepRole[] = ['lead', 'builder', 'reviewer', 'tester']

/** ai = a read-only checker session judges the condition; user = an approval in the Inbox. */
export type GateEvaluator = 'ai' | 'user'

/** A gate as the plan states it. Durations are strings like "5m", "4h", "1d" (core/goals/machine.ts parseDuration). */
export type GateSpec = {
  evaluator: GateEvaluator
  condition: string
  /** overrides the default back-off (GATE_CHECK_SCHEDULE_MIN) with a fixed interval */
  checkEvery: string | null
  /** default GATE_DEFAULT_DEADLINE; past it the gate becomes an approval */
  deadline: string | null
  /** "met" verdicts in a row needed; 2 for high-stakes gates (merge, production) */
  confirmations: number
  /** connectors whose read tools the checker may use (MCP server names) */
  connectors: string[]
}

/** One step of a plan. JSON in a fenced block inside plan.md; validated, never repaired. */
export type PlanStep = {
  id: string
  title: string
  type: StepType
  /** who does an agent step; null for gate and block steps */
  role: StepRole | null
  dependsOn: string[]
  doneWhen: string
  /** set when type is 'gate' */
  gate: GateSpec | null
  /** the workflow block's name, when type is 'block' (e.g. "shepherd-pr") */
  block: string | null
}

/** One role on the team: how many, and why the lead wants them. */
export type TeamSeat = { role: StepRole; count: number; why: string; model: string | null }

/** What the lead proposes and the user approves. */
export type GoalPlan = {
  /** the lead's research, in a paragraph: what it found, what it chose */
  summary: string
  doneWhen: string
  horizon: GoalHorizon
  steps: PlanStep[]
  team: TeamSeat[]
  budget: GoalBudget
  /** what Junior may do without asking, in the user's words, one per line */
  mayDo: string[]
  /** names of the policies applied to this plan (core defaults + goal-policies.md) */
  policies: string[]
  /** per-role model overrides; null = DEFAULT_GOAL_MODELS */
  models: Partial<Record<'lead' | 'worker' | 'gate', string>> | null
}

/** Default models (decision 5): lead Opus, workers Sonnet, gate checker Haiku. */
export const DEFAULT_GOAL_MODELS = { lead: 'opus', worker: 'sonnet', gate: 'haiku' } as const

// ---------------------------------------------------------------------------
// Steps at run time
// ---------------------------------------------------------------------------

/**
 * Where one plan step is:
 *   pending   a dependency isn't done yet
 *   runnable  dependencies done; waiting for a slot
 *   running   a session holds it (agent), or it's armed (gate)
 *   done      the engine checked it, not just the agent's say-so
 *   failed    the last attempt failed; the lead decides what next
 *   blocked   needs the user
 *   skipped   dropped by an accepted plan change
 */
export type StepStatus = 'pending' | 'runnable' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped'
export const STEP_STATUSES: readonly StepStatus[] = ['pending', 'runnable', 'running', 'done', 'failed', 'blocked', 'skipped']

export type GoalStepState = {
  goalId: string
  stepId: string
  status: StepStatus
  /** sessions tried so far; caps fix loops (MAX_FIX_ATTEMPTS) */
  attempts: number
  sessionId: string | null
  startedAt: number | null
  endedAt: number | null
  updatedAt: number
}

/** 3 fix attempts per failing check, then the user (M5); same cap as recipes' MAX_FIX_ROUNDS. */
export const MAX_FIX_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** open = waiting; met / expired / cancelled = settled. needs_user = handed to the Inbox as an approval. */
export type GateStatus = 'open' | 'met' | 'needs_user' | 'expired' | 'cancelled'
export const GATE_STATUSES: readonly GateStatus[] = ['open', 'met', 'needs_user', 'expired', 'cancelled']

/** One armed gate, as `goal_gates` holds it. */
export type Gate = {
  id: string
  goalId: string
  stepId: string
  evaluator: GateEvaluator
  condition: string
  connectors: string[]
  status: GateStatus
  /** ids the checker gets as input (a PR number, a ticket key) — never the transcript */
  refs: string[]
  armedAt: number
  /** when the sweep should look next; null for a user gate */
  nextCheckAt: number | null
  /** index into the back-off schedule: checks done so far */
  checks: number
  /** fixed interval from the plan's check_every, overriding the schedule */
  checkEveryMs: number | null
  deadlineAt: number
  confirmationsNeeded: number
  /** "met" verdicts in a row so far */
  confirmationsSeen: number
  lastVerdict: GateVerdict | null
  /** the Inbox item made when the gate went to the user */
  itemId: string | null
  settledAt: number | null
}

/** What an AI gate checker returns, and nothing else. The engine decides what follows. */
export type GateVerdictKind = 'met' | 'not_met' | 'needs_user' | 'error'
export const GATE_VERDICT_KINDS: readonly GateVerdictKind[] = ['met', 'not_met', 'needs_user', 'error']
export type GateVerdict = { verdict: GateVerdictKind; evidence: string; checkAgainIn: string | null }

/** Decision 6: minutes between checks after arming — then every 60, unless the gate sets check_every. */
export const GATE_CHECK_SCHEDULE_MIN: readonly number[] = [5, 5, 10, 10, 20, 20, 30, 30, 40, 40]
export const GATE_CHECK_TAIL_MIN = 60
/** Decision 6: the sweep timer. */
export const GATE_SWEEP_INTERVAL_MS = 5 * 60_000
/** Decision 6: past this a gate becomes an approval in the Inbox. */
export const GATE_DEFAULT_DEADLINE = '24h'

// ---------------------------------------------------------------------------
// Events — the bus (M3) and the transition log, one table
// ---------------------------------------------------------------------------

/** Who caused an event. `engine` is triage itself; a session is named by its id. */
export type GoalActor = 'you' | 'engine' | 'lead' | 'worker' | 'gate' | 'watcher'

/**
 * Everything that happens to a goal. Every event is written to `goal_events`
 * first, then emitted; one not yet handled is replayed after a restart.
 */
export type GoalEventKind =
  | 'created'
  | 'plan_proposed'
  | 'plan_approved'
  | 'plan_sent_back'
  | 'plan_commented'
  | 'plan_change_proposed'
  | 'plan_change_settled'
  /** the lead handed a step to a worker: its brief and model; the scheduler starts the worker */
  | 'step_dispatched'
  | 'step_started'
  | 'step_finished'
  | 'step_failed'
  | 'gate_armed'
  | 'gate_checked'
  | 'gate_resolved'
  | 'watcher'
  | 'user_message'
  | 'user_edited'
  | 'asked_you'
  | 'answered'
  | 'budget'
  | 'transition'

export const GOAL_EVENT_KINDS: readonly GoalEventKind[] = [
  'created',
  'plan_proposed',
  'plan_approved',
  'plan_sent_back',
  'plan_commented',
  'plan_change_proposed',
  'plan_change_settled',
  'step_dispatched',
  'step_started',
  'step_finished',
  'step_failed',
  'gate_armed',
  'gate_checked',
  'gate_resolved',
  'watcher',
  'user_message',
  'user_edited',
  'asked_you',
  'answered',
  'budget',
  'transition',
]

/** One row of `goal_events`. `from`/`to` are set on a transition, else null. */
export type GoalEvent = {
  goalId: string
  /** per goal, from 1 — the order the lead reads them in */
  seq: number
  at: number
  actor: GoalActor
  /** the session that caused it, when one did */
  sessionId: string | null
  kind: GoalEventKind
  from: GoalState | null
  to: GoalState | null
  /** the trigger's name on a transition; free JSON otherwise (a step id, comments, a watcher payload) */
  detail: Record<string, unknown> | null
  /** when the engine finished acting on it; null = replay after a restart */
  handledAt: number | null
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** How a session's step ended. */
export type SessionOutcome = 'done' | 'failed' | 'blocked'

/** One session's work on a goal: `goal_sessions` holds it, log.md says it in words. */
export type GoalLogEntry = {
  goalId: string
  sessionId: string
  role: StepRole
  stepId: string | null
  planVersion: number
  startedAt: number
  endedAt: number | null
  commits: string[]
  files: string[]
  /** commands run, each with how it ended */
  commands: { cmd: string; ok: boolean }[]
  /** action ids queued in the Outbox */
  actions: string[]
  outcome: SessionOutcome | null
  costUsd: number | null
  /** the markdown section appended to log.md */
  text: string
}

/** The ledger's files, relative to the artifacts folder (decision 9: log rolls over past LOG_ROLLOVER_BYTES). */
export const goalDir = (goalId: string) => `goals/${goalId}`
export const LEDGER_FILES = ['plan.md', 'log.md', 'handoff.md'] as const
export const LOG_ROLLOVER_BYTES = 200 * 1024
/** Decision 9: the lead reads handoff.md plus this many latest log entries. */
export const LEAD_LOG_ENTRIES = 5
/** Decision 7: warn on the goal page after this many failed ledger commits in a row. */
export const LEDGER_COMMIT_WARN_AFTER = 3

/** Whose turn a goal is, in the inbox's own words (core/work/flow.ts). */
export type GoalTurn = Turn
