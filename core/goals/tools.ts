/**
 * Goal tool signatures, locked before the engine is built.
 *
 * GOAL_TOOLS join the triage MCP contract (core/mcp/tools.ts `TOOLS`, and the
 * zod copy `goalMcpTools` in server/goals.ts) in M1 — every transport, idempotent like the
 * upserts. ENGINE_TOOLS are served only to a goal's lead, on its per-wake SDK
 * server (M3): the lead decides through them, and the engine carries each
 * decision out. GOAL_TOOLS are registered (M1); ENGINE_TOOLS not yet.
 *
 * Field names are camelCase, as the rest of the MCP surface is (`updatedAt`,
 * `budgetUsd`) — including the plan-step JSON in plan.md, which the brief
 * sketched in snake_case.
 */
import { GOAL_STATES, STEP_ROLES, type GateEvaluator, type GoalHorizon, type GoalPlan, type GoalState, type SessionOutcome, type StepRole } from './types.js'

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

const STATE_ENUM = [...GOAL_STATES]
const ROLE_ENUM = [...STEP_ROLES]
const OUTCOME_ENUM: SessionOutcome[] = ['done', 'failed', 'blocked']

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    evaluator: { type: 'string', enum: ['ai', 'user', 'watcher'], description: 'ai = a read-only checker judges it; user = an approval in the Inbox; watcher = the PR watcher (use the "shepherd-pr" block)' },
    condition: { type: 'string', description: 'what must hold, checkable from outside: "LIN-2214 is in QA"' },
    checkEvery: { type: 'string', description: 'a fixed interval like "15m"; omit for the default back-off' },
    deadline: { type: 'string', description: 'like "4h"; past it the gate becomes an approval. Default 24h' },
    confirmations: { type: 'number', description: '"met" verdicts in a row needed; 2 for merge or anything touching production. Default 1' },
    connectors: { type: 'array', items: { type: 'string' }, description: 'MCP servers whose read tools the checker may use' },
  },
  required: ['evaluator', 'condition'],
}

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short and unique in the plan, e.g. "s1"' },
    title: { type: 'string' },
    type: { type: 'string', enum: ['agent', 'gate', 'block'] },
    role: { type: 'string', enum: ROLE_ENUM, description: 'who does an agent step' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'step ids that must be done first' },
    doneWhen: { type: 'string', description: 'what the engine checks before it counts the step done' },
    gate: GATE_SCHEMA,
    block: { type: 'string', description: 'a workflow block name, for a block step. The one there is: "shepherd-pr" — the PR watcher gets the PR the step before opened to merged' },
  },
  required: ['id', 'title', 'type', 'doneWhen'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'what you found and what you chose, in a paragraph' },
    doneWhen: { type: 'string' },
    horizon: { type: 'string', enum: ['today', 'until_done', 'ongoing'] },
    steps: { type: 'array', items: STEP_SCHEMA, minItems: 1 },
    team: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ROLE_ENUM },
          count: { type: 'number' },
          why: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['role', 'count', 'why'],
      },
    },
    budgetUsd: { type: 'number' },
    budgetMinutes: { type: 'number' },
    mayDo: { type: 'array', items: { type: 'string' }, description: 'what Junior may do without asking, one per line' },
    models: {
      type: 'object',
      properties: { lead: { type: 'string' }, worker: { type: 'string' }, gate: { type: 'string' } },
      description: 'overrides of the default models (lead opus, workers sonnet, gate haiku)',
    },
  },
  required: ['summary', 'doneWhen', 'steps'],
}

export const GOAL_TOOLS: readonly ToolDef[] = [
  {
    name: 'goal_create',
    description:
      'Start a goal: an outcome with a done-when that Junior drives across many sessions. It begins in draft_plan; nothing runs until the user approves a plan. Idempotent: a repeat call with the same key (default: sourceItemId) returns the existing goal.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        doneWhen: { type: 'string', description: 'what must be true for the goal to be done, checkable' },
        horizon: { type: 'string', enum: ['today', 'until_done', 'ongoing'], description: 'default until_done' },
        sourceItemId: { type: 'string', description: 'the work item it came from' },
        key: { type: 'string', description: 'a caller-stable id to dedupe on; defaults to sourceItemId' },
        projectId: { type: 'string', description: 'the project it works in; default = the default project' },
        budgetUsd: { type: 'number' },
        budgetMinutes: { type: 'number' },
      },
      required: ['title', 'doneWhen'],
    },
  },
  {
    name: 'goal_get',
    description: "One goal by id: its record, plan, open gates, the handoff and the latest log entries.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'goal_list',
    description: 'The goals, newest update first, with state and whose turn it is. Filter by state or source item.',
    inputSchema: {
      type: 'object',
      properties: {
        states: { type: 'array', items: { type: 'string', enum: STATE_ENUM } },
        sourceItemId: { type: 'string' },
      },
    },
  },
  {
    name: 'goal_propose_plan',
    description:
      "Propose the plan for a goal in draft_plan. It is validated and rejected, never repaired; a valid plan moves the goal to plan_ready for the user's review. Proposing the same plan again is a no-op.",
    inputSchema: {
      type: 'object',
      properties: { goalId: { type: 'string' }, plan: PLAN_SCHEMA, sessionId: { type: 'string', description: 'your triage session id' } },
      required: ['goalId', 'plan'],
    },
  },
  {
    name: 'goal_log_append',
    description:
      "Append this session's entry to the goal's log.md. Keyed by (sessionId, stepId): repeating the same entry writes nothing; a changed entry is appended as a revision after it (log.md is never rewritten).",
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        sessionId: { type: 'string' },
        stepId: { type: 'string' },
        role: { type: 'string', enum: ROLE_ENUM },
        outcome: { type: 'string', enum: OUTCOME_ENUM },
        text: { type: 'string', description: 'what you did and what came of it, markdown' },
        commits: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        commands: {
          type: 'array',
          items: { type: 'object', properties: { cmd: { type: 'string' }, ok: { type: 'boolean' } }, required: ['cmd', 'ok'] },
        },
      },
      required: ['goalId', 'sessionId', 'role', 'text'],
    },
  },
  {
    name: 'goal_handoff_write',
    description: "Rewrite the goal's handoff.md for whoever wakes next: what's done, what's next, what to watch out for. Writing the same text again is a no-op.",
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        sessionId: { type: 'string' },
        done: { type: 'string' },
        next: { type: 'string' },
        watchOut: { type: 'string' },
      },
      required: ['goalId', 'sessionId', 'done', 'next'],
    },
  },
]

export const ENGINE_TOOLS: readonly ToolDef[] = [
  {
    name: 'dispatch_worker',
    description: "Start a worker on a runnable step of the approved plan, in the goal's worktree. It does that one step and exits.",
    inputSchema: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        brief: { type: 'string', description: 'what this worker needs beyond the plan and the handoff' },
        model: { type: 'string', description: "only to override the plan's worker model" },
      },
      required: ['stepId', 'brief'],
    },
  },
  {
    name: 'arm_gate',
    description:
      "Arm the gate on a gate step. The goal waits without any session running; resolving the gate wakes you again. Fields left out come from the plan's step. An ai gate is checked by a read-only checker on a back-off; a gate on a merge, a deploy or production needs 2 \"met\" checks in a row. A user gate is an approval in the user's Inbox: give your recommended answer.",
    inputSchema: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' }, description: 'ids the checker needs: a PR number, a ticket key' },
        condition: { type: 'string' },
        evaluator: { type: 'string', enum: ['ai', 'user'] },
        checkEvery: { type: 'string' },
        deadline: { type: 'string' },
        confirmations: { type: 'number' },
        connectors: { type: 'array', items: { type: 'string' } },
        recommended: { type: 'string', description: 'a user gate: your recommended answer (required for one)' },
        evidence: { type: 'string', description: 'a user gate: what the user should look at to decide' },
      },
      required: ['stepId'],
    },
  },
  {
    name: 'propose_plan_change',
    description:
      'Propose a revised plan: a new repo or service, a bigger budget, a bigger team, or steps added or dropped. It goes to the user as "plan changed"; the goal waits on them.',
    inputSchema: { type: 'object', properties: { why: { type: 'string' }, plan: PLAN_SCHEMA }, required: ['why', 'plan'] },
  },
  {
    name: 'ask_user',
    description: 'Ask the user something outside the plan. Always give your recommended answer. The goal waits on them.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        evidence: { type: 'string', description: 'what you found that makes this a question' },
        recommended: { type: 'string', description: 'your recommended answer' },
        options: { type: 'array', items: { type: 'string' } },
      },
      required: ['question', 'recommended'],
    },
  },
  {
    name: 'report_step_result',
    description:
      "Report how a step ended, with evidence. The engine checks it against the step's done-when wherever it can before it counts — a report is a claim, not proof.",
    inputSchema: {
      type: 'object',
      properties: {
        stepId: { type: 'string' },
        outcome: { type: 'string', enum: OUTCOME_ENUM },
        summary: { type: 'string' },
        evidence: { type: 'string', description: 'what shows the done-when holds: a check run, a commit, a status' },
      },
      required: ['stepId', 'outcome', 'summary'],
    },
  },
]

// --- the inputs, as the handlers will receive them after validation ---------

/** A plan as tools carry it: GoalPlan with the budget flattened, and the defaults the engine fills (policies) left out. */
export type PlanInput = Omit<GoalPlan, 'budget' | 'policies' | 'horizon' | 'team' | 'mayDo' | 'models'> &
  Partial<Pick<GoalPlan, 'horizon' | 'team' | 'mayDo' | 'models'>> & { budgetUsd?: number; budgetMinutes?: number }

export type GoalCreateInput = {
  title: string
  doneWhen: string
  horizon?: GoalHorizon
  sourceItemId?: string
  key?: string
  projectId?: string
  budgetUsd?: number
  budgetMinutes?: number
}
export type GoalGetInput = { id: string }
export type GoalListInput = { states?: GoalState[]; sourceItemId?: string }
export type GoalProposePlanInput = { goalId: string; plan: PlanInput; sessionId?: string }
export type GoalLogAppendInput = {
  goalId: string
  sessionId: string
  stepId?: string
  role: StepRole
  outcome?: SessionOutcome
  text: string
  commits?: string[]
  files?: string[]
  commands?: { cmd: string; ok: boolean }[]
}
export type GoalHandoffWriteInput = { goalId: string; sessionId: string; done: string; next: string; watchOut?: string }

export type DispatchWorkerInput = { stepId: string; brief: string; model?: string }
export type ArmGateInput = {
  stepId: string
  refs?: string[]
  condition?: string
  evaluator?: GateEvaluator
  checkEvery?: string
  deadline?: string
  confirmations?: number
  connectors?: string[]
  /** a user gate: Junior's recommended answer (required for one) */
  recommended?: string
  evidence?: string
}
export type ProposePlanChangeInput = { why: string; plan: PlanInput }
export type AskUserInput = { question: string; evidence?: string; recommended: string; options?: string[] }
export type ReportStepResultInput = { stepId: string; outcome: SessionOutcome; summary: string; evidence?: string }
