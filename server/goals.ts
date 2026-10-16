/**
 * Goals (.docs/goals/goals-engine.md), the server half of M1: the `goal*Op`
 * functions every door funnels through — the in-process triage MCP
 * (makeTriageMcp), the external MCP (core/mcp/tools.ts → these routes), the
 * HTTP API and the `triage goal` CLI — so a goal created one way reads the
 * same every other way. Input is validated here once and rejected, never
 * repaired.
 *
 * Every write is idempotent, like upsert_work_item: goal_create dedupes on
 * its key, a repeat plan proposal / log entry / handoff writes nothing.
 *
 * M2, plan review: an op writes its event to goal_events and then hands it to
 * `emit`, which reacts at once (`onGoalEvent`: wake the drafting lead, queue
 * the first step) — no polling. An event not yet handled is replayed at boot
 * (`replayGoalEvents`). Approve, comment and send back are the user's clicks
 * (HTTP only); agents never approve a plan.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type http from 'node:http'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { GoalSessionRecord, Store } from '../core/store/types.js'
import { isLedgerId, type GoalLedger } from '../core/goals/ledger.js'
import { parseDuration, transition, turnOf, type GoalTrigger } from '../core/goals/machine.js'
import { parsePlanMd, planFrom, renderPlanMd, samePlan, MAX_CONFIRMATIONS, MAX_PLAN_BUDGET_USD, type PlanOpts } from '../core/goals/plan.js'
import type { WorkflowBlock } from '../core/goals/blocks.js'
import {
  afterSession,
  armRefusal,
  budgetCheck,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_MAX_TEAM,
  dispatchRefusal,
  leadRunPrompt,
  minutesUsed,
  nextWorkers,
  openAsk,
  pickGoals,
  planInputOf,
  reconcileSteps,
  reportResult,
  roleWrites,
  unlock,
  unreadWakes,
  workerDue,
  workerOutcome,
  workerCap,
  workerPrompt,
  workingSessions,
  type Working,
  type HeldAction,
  type WorkerSpec,
} from '../core/goals/run.js'
import { applyVerdict, NO_VERDICT, nextCheckDelay, requiredConfirmations } from '../core/goals/gates.js'
import { commentFrom, MAX_COMMENT, pendingComments, reactTo, REVIEW_EVENTS, type LeadWake } from '../core/goals/review.js'
import { ENGINE_TOOLS, GOAL_TOOLS } from '../core/goals/tools.js'
import {
  afterDecision,
  assess,
  fixCiBrief,
  mergeBrief,
  newWatch,
  nextPoll,
  policyFor,
  PR_QUERY,
  prRefFrom,
  rebaseBrief,
  snapshotFrom,
  threadBrief,
  type PolicyDecision,
  type PrCheck,
  type PrRef,
  type PrSnapshot,
  type PrWatch,
  type WatcherEvent,
} from '../core/goals/shepherd.js'
import {
  DEFAULT_GOAL_MODELS,
  GATE_CHECK_SCHEDULE_MIN,
  GATE_DEFAULT_DEADLINE,
  GOAL_STATES,
  GOAL_HORIZONS,
  isGoalHorizon,
  isGoalState,
  LEAD_LOG_ENTRIES,
  STEP_ROLES,
  type Gate,
  type GateVerdict,
  type Goal,
  type GoalEvent,
  type GoalState,
  type GoalStepState,
  type SessionOutcome,
  type StepRole,
} from '../core/goals/types.js'
import type { GoalAsk, GoalAskGate, GoalResponse, GoalTeamMember, GoalSummary, GoalsResponse, GoalWriteOutcome, GoalWriteResponse } from '../shared/protocol.js'

export type GoalDeps = {
  store: Store
  ledger: GoalLedger
  now: () => number
  /** the project a goal works in when the caller names none */
  defaultProjectId: () => Promise<string | null>
  /** a goal was created or written — broadcast goals_changed */
  changed: (goalId: string) => void
  /** an event was written: react to it now (onGoalEvent). Never throws; errors are the reactor's to log. */
  emit: (ev: GoalEvent) => void
  /** the inbox item a goal made from chat lives under (a manual item, like propose_team's); null = none */
  itemFor?: (goal: Goal) => Promise<string | null>
  /** M6: the workflow blocks a plan may name (the workspace's team recipes); none = only shepherd-pr */
  blocks?: () => Promise<WorkflowBlock[]>
}

/** What the engine does for the review events; the server spawns the session. */
export type GoalEngine = {
  /** start the drafting lead for `ev`; it calls goalLeadSettledOp when it ends, which marks `ev` handled */
  wakeLead: (goal: Goal, wake: LeadWake, ev: GoalEvent) => Promise<void>
  /** steps became runnable — the scheduler pumps */
  stepsQueued?: (goal: Goal, stepIds: string[]) => void
  /**
   * M3: start the session the scheduler picked for a running goal. Call
   * `started(sessionId)` once the session row exists and before its first
   * message; when it ends, call goalSessionEndedOp. A throw before `started`
   * means it never ran.
   */
  startSession?: (goal: Goal, spec: StartSpec, started: (sessionId: string) => Promise<void>) => Promise<void>
  /** stop the goal's live session (take over, cancel); it still ends through goalSessionEndedOp */
  stopSessions?: (goalId: string) => Promise<void>
  /** the goal worktree's HEAD commit, recorded at take over and hand back */
  worktreeHead?: (goal: Goal) => Promise<string | null>
  /** take over: open the goal's worktree in the user's editor */
  openWorktree?: (goal: Goal) => Promise<void>
  /**
   * M6: a worker that ran in a child worktree finished its step — commit what
   * it left, merge its branch into the goal's and remove it. Returns why it
   * couldn't (a conflict), or null when merged or there was no child.
   */
  mergeBack?: (goal: Goal, sessionId: string) => Promise<string | null>
  /** M6: the goal branch against its base, for a reviewer — stat, then the patch */
  worktreeDiff?: (goal: Goal) => Promise<string>
}

/** What one goal session is told: the run lead's wake, or a worker's step. */
export type StartSpec =
  | { role: 'lead'; model: string; prompt: string; upTo: number }
  | {
      role: Exclude<StepRole, 'lead'>
      model: string
      stepId: string
      attempt: number
      writes: boolean
      context: string
      first: string
      /** where it works: the goal's worktree, or (a builder beside other sessions) a child worktree branched from it */
      worktree: 'goal' | 'child'
    }

/** How many log entries the goal page shows; goal_get returns the lead's LEAD_LOG_ENTRIES. */
export const PAGE_LOG_ENTRIES = 20

const MAX_TITLE = 200
const MAX_TEXT = 50_000

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

function obj(v: unknown): Raw {
  if (!isObj(v)) throw new Error('expected a JSON object')
  return v
}

function str(v: unknown, name: string, max = MAX_TEXT): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} must be a non-empty string`)
  if (v.length > max) throw new Error(`${name} is over ${max} characters`)
  return v.trim()
}

function optStr(v: unknown, name: string, max = MAX_TEXT): string | null {
  return v === undefined || v === null || v === '' ? null : str(v, name, max)
}

function optPositive(v: unknown, name: string, cap?: number): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`)
  if (cap !== undefined && v > cap) throw new Error(`${name} is over the cap of ${cap}`)
  return v
}

function strList(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${name} must be a list of strings`)
  return v as string[]
}

function id(v: unknown, name: string): string {
  const s = str(v, name, 120)
  if (!isLedgerId(s)) throw new Error(`${name} "${s}" has characters an id can't have`)
  return s
}

async function goalOrThrow(d: GoalDeps, goalId: string): Promise<Goal> {
  const goal = await d.store.goals.get(goalId)
  if (!goal) throw new Error(`no goal "${goalId}"`)
  return goal
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function goalListOp(d: GoalDeps, raw: unknown = {}): Promise<Omit<Extract<GoalsResponse, { ok: true }>, 'ok'>> {
  const q = obj(raw)
  const states = strList(q.states, 'states')
  for (const s of states) if (!isGoalState(s)) throw new Error(`unknown state "${s}" (one of ${GOAL_STATES.join(', ')})`)
  const goals = await d.store.goals.list({ ...(states.length ? { states: states as GoalState[] } : {}), ...(typeof q.sourceItemId === 'string' && q.sourceItemId ? { sourceItemId: q.sourceItemId } : {}) })
  const summaries: GoalSummary[] = []
  for (const g of goals) {
    const gates = await d.store.goals.gates(g.id)
    summaries.push({
      id: g.id,
      title: g.title,
      state: g.state,
      horizon: g.horizon,
      reason: g.reason,
      sourceItemId: g.sourceItemId,
      currentStep: g.currentStep,
      spentUsd: g.spentUsd,
      budget: g.budget,
      updatedAt: g.updatedAt,
      turn: turnOf(g.state),
      openGates: gates.filter((x) => x.status === 'open' || x.status === 'needs_user').length,
    })
  }
  // The count is every goal waiting on the user, whatever the list was narrowed to.
  const waiting = states.length || q.sourceItemId ? await d.store.goals.list({ states: ['plan_ready', 'waiting_you', 'result_ready'] }) : goals.filter((g) => turnOf(g.state) === 'me')
  return { goals: summaries, waitingOnYou: waiting.length }
}

export async function goalGetOp(d: GoalDeps, goalId: string, logEntries = PAGE_LOG_ENTRIES): Promise<Omit<Extract<GoalResponse, { ok: true }>, 'ok'>> {
  const goal = await goalOrThrow(d, goalId)
  const [steps, gates, events, files] = await Promise.all([
    d.store.goals.steps(goal.id),
    d.store.goals.gates(goal.id),
    d.store.goals.events(goal.id),
    d.ledger.read(goal.id, logEntries),
  ])
  const rows = await d.store.goals.sessions(goal.id)
  const lead = rows.filter((r) => r.role === 'lead' && r.endedAt === null).sort((a, b) => b.startedAt - a.startedAt)[0]
  const team = goal.state === 'running' ? workingSessions(steps, events) : []
  const live = team.at(-1)
  return {
    goal,
    turn: turnOf(goal.state),
    steps,
    gates,
    events,
    plan: files.plan,
    handoff: files.handoff,
    log: files.log,
    ledgerWarning: d.ledger.warning(goal.id),
    comments: goal.state === 'plan_ready' ? pendingComments(events) : [],
    leadSessionId: lead?.sessionId ?? null,
    liveSession: live ? { sessionId: live.sessionId, role: live.role, stepId: live.stepId } : null,
    team: await teamOf(d, rows, team),
    ask: goal.state === 'waiting_you' ? askOf(goal, events, gates) : null,
  }
}

/** A running goal's open sessions, for the page's live team. */
async function teamOf(d: GoalDeps, rows: readonly GoalSessionRecord[], team: readonly Working[]): Promise<GoalTeamMember[]> {
  const out = await Promise.all(
    team.map(async (w) => ({
      ...w,
      startedAt: rows.find((r) => r.sessionId === w.sessionId)?.startedAt ?? 0,
      lastActivityAt: (await d.store.sessions.get(w.sessionId))?.updatedAt ?? null,
    })),
  )
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/** What a goal waiting on the user waits for, in the page's terms. */
function askOf(goal: Goal, events: readonly GoalEvent[], gates: readonly Gate[]): GoalAsk {
  const open = openAsk(events)
  const d = open?.ev.detail ?? {}
  if (open?.kind === 'ask') {
    const g = typeof d.gateId === 'string' ? gates.find((x) => x.id === d.gateId && x.status === 'needs_user') : undefined
    const why = d.why === 'deadline' || d.why === 'needs_user' ? d.why : 'approval'
    const gate: GoalAskGate | null = g ? { id: g.id, stepId: g.stepId, condition: g.condition, evaluator: g.evaluator, why } : null
    return {
      kind: 'ask',
      question: String(d.question ?? ''),
      recommended: String(d.recommended ?? ''),
      evidence: typeof d.evidence === 'string' ? d.evidence : null,
      options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === 'string') : [],
      gate,
    }
  }
  if (open?.kind === 'plan_change' && isObj(d.plan)) return { kind: 'plan_change', why: String(d.why ?? ''), plan: d.plan as unknown as NonNullable<Goal['plan']> }
  return { kind: 'other', reason: goal.reason ?? 'Junior is waiting on you.' }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type WriteResult = { goal: Goal; outcome: GoalWriteOutcome }

/** goal_create: a goal in draft_plan. A taken key returns the goal it names; with no key, a live goal with the same title and done-when is the same goal. */
export async function goalCreateOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const title = str(b.title, 'title', MAX_TITLE)
  const doneWhen = str(b.doneWhen, 'doneWhen')
  if (b.horizon !== undefined && !isGoalHorizon(b.horizon)) throw new Error('horizon must be today, until_done or ongoing')
  const sourceItemId = optStr(b.sourceItemId, 'sourceItemId', 300)
  const key = optStr(b.key, 'key', 300) ?? sourceItemId
  let projectId = optStr(b.projectId, 'projectId', 120)
  if (projectId && !(await d.store.projects.list()).some((p) => p.id === projectId)) throw new Error(`no project "${projectId}"`)
  projectId ??= await d.defaultProjectId()
  const budget = { usd: optPositive(b.budgetUsd, 'budgetUsd', MAX_PLAN_BUDGET_USD), minutes: optPositive(b.budgetMinutes, 'budgetMinutes') }

  // With no key, the store finds a live goal with the same title and done-when in the insert's own transaction.
  const { goal, created } = await d.store.goals.create(
    { id: randomUUID(), title, doneWhen, horizon: (b.horizon as Goal['horizon'] | undefined) ?? 'until_done', sourceItemId, key, projectId, budget, priority: 0 },
    d.now(),
  )
  if (!created) return { goal, outcome: 'existing' }
  let out = goal
  // A goal from chat gets an inbox item to live under, so its plan review lands in the Inbox like any other item's.
  // Best effort: a goal without an item still works, it just isn't in the Inbox.
  if (!goal.sourceItemId && d.itemFor) {
    const itemId = await d.itemFor(goal).catch(() => null)
    if (itemId) out = (await d.store.goals.update(goal.id, { sourceItemId: itemId }, d.now())) ?? goal
  }
  d.changed(goal.id)
  const ev = (await d.store.goals.events(goal.id)).find((e) => e.kind === 'created')
  if (ev) d.emit(ev)
  return { goal: out, outcome: 'created' }
}

/** goal_propose_plan: validate, write plan.md, move draft_plan → plan_ready. The same plan again, once it's up for review, is a no-op. */
export async function goalProposePlanOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  const sessionId = b.sessionId === undefined ? null : id(b.sessionId, 'sessionId')
  const parsed = planFrom(b.plan, goal, await planOpts(d, true))
  if (!parsed.ok) throw new Error(`plan rejected: ${parsed.error}`)
  if (goal.state === 'plan_ready' && samePlan(goal.plan, parsed.plan)) return { goal, outcome: 'unchanged' }
  const t = transition(goal.state, 'plan_proposed', 'engine')
  if (!t.ok) throw new Error(t.error)

  const at = d.now()
  const version = goal.planVersion + 1
  await d.ledger.writePlan(goal.id, renderPlanMd(goal, parsed.plan, version), version)
  await d.store.goals.update(goal.id, { plan: parsed.plan, planVersion: version }, at)
  await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'lead', sessionId, kind: 'plan_proposed', from: null, to: null, detail: { steps: parsed.plan.steps.length } })
  const moved = await d.store.goals.move(goal.id, t.from, t.to, { actor: 'engine', sessionId, detail: { trigger: 'plan_proposed' }, reason: null }, at)
  if (!moved) throw new Error('the goal moved while the plan was being proposed; read it again')
  d.changed(goal.id)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'proposed' }
}

const OUTCOMES: readonly SessionOutcome[] = ['done', 'failed', 'blocked']

function commandsFrom(v: unknown): { cmd: string; ok: boolean }[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error('commands must be a list')
  return v.map((c, i) => {
    if (!isObj(c) || typeof c.cmd !== 'string' || typeof c.ok !== 'boolean') throw new Error(`commands[${i}] must be { cmd, ok }`)
    return { cmd: c.cmd, ok: c.ok }
  })
}

/** goal_log_append: this session's entry in log.md and its goal_sessions row. A repeat of the same entry writes nothing. */
export async function goalLogAppendOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  const sessionId = id(b.sessionId, 'sessionId')
  const stepId = b.stepId === undefined || b.stepId === null || b.stepId === '' ? null : id(b.stepId, 'stepId')
  if (stepId && goal.plan && !goal.plan.steps.some((s) => s.id === stepId)) throw new Error(`step "${stepId}" isn't in the goal's plan`)
  if (!STEP_ROLES.includes(b.role as StepRole)) throw new Error(`role must be one of ${STEP_ROLES.join(', ')}`)
  if (b.outcome !== undefined && b.outcome !== null && !OUTCOMES.includes(b.outcome as SessionOutcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`)
  const entry = {
    sessionId,
    stepId,
    role: b.role as StepRole,
    outcome: (b.outcome as SessionOutcome | undefined) ?? null,
    text: str(b.text, 'text'),
    commits: strList(b.commits, 'commits'),
    files: strList(b.files, 'files'),
    commands: commandsFrom(b.commands),
  }
  const outcome = await d.ledger.appendLog(goal.id, entry)
  if (outcome === 'unchanged') return { goal, outcome }

  const at = d.now()
  const prior = (await d.store.goals.sessions(goal.id)).find((s) => s.sessionId === sessionId)
  await d.store.goals.putSession({
    goalId: goal.id,
    sessionId,
    role: entry.role,
    stepId,
    planVersion: goal.planVersion,
    startedAt: prior?.startedAt ?? at,
    endedAt: entry.outcome ? at : (prior?.endedAt ?? null),
    commits: entry.commits,
    files: entry.files,
    commands: entry.commands,
    actions: prior?.actions ?? [],
    outcome: entry.outcome,
    costUsd: prior?.costUsd ?? null,
  })
  d.changed(goal.id)
  return { goal: (await d.store.goals.update(goal.id, {}, at))!, outcome }
}

/** goal_handoff_write: rewrite handoff.md. The same handoff again writes nothing. */
export async function goalHandoffWriteOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  const changed = await d.ledger.writeHandoff(goal.id, {
    sessionId: id(b.sessionId, 'sessionId'),
    done: str(b.done, 'done'),
    next: str(b.next, 'next'),
    watchOut: optStr(b.watchOut, 'watchOut'),
  })
  if (!changed) return { goal, outcome: 'unchanged' }
  d.changed(goal.id)
  return { goal: (await d.store.goals.update(goal.id, {}, d.now()))!, outcome: 'written' }
}

// ---------------------------------------------------------------------------
// Plan review (M2): the user's comment / approve / send back, the drafting
// lead's bookkeeping, and the reaction to each event.
// ---------------------------------------------------------------------------

/** A comment on the plan under review; a step id must name one of its steps. Recorded as a plan_commented event. */
async function addComment(d: GoalDeps, goal: Goal, raw: unknown, at: number): Promise<boolean> {
  const b = obj(raw)
  const stepId = b.stepId === undefined || b.stepId === null || b.stepId === '' ? null : id(b.stepId, 'stepId')
  if (stepId && !goal.plan?.steps.some((s) => s.id === stepId)) throw new Error(`step "${stepId}" isn't in the plan`)
  const c = commentFrom({ stepId, text: str(b.text, 'text', MAX_COMMENT) }, at)!
  const pending = pendingComments(await d.store.goals.events(goal.id))
  if (pending.some((p) => p.stepId === c.stepId && p.text === c.text)) return false
  await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'plan_commented', from: null, to: null, detail: { stepId: c.stepId, text: c.text, version: goal.planVersion } })
  return true
}

function reviewable(goal: Goal): void {
  if (goal.state !== 'plan_ready') throw new Error(`there's no plan up for review: the goal is ${goal.state.replace('_', ' ')}`)
}

/** A client's `version` must be the plan it read, so a click never approves a plan the lead replaced since. */
function sameVersion(goal: Goal, v: unknown): void {
  if (v === undefined || v === null) return
  if (v !== goal.planVersion) throw new Error(`the plan changed since you read it (now v${goal.planVersion}); read it again`)
}

/** Comment on the plan under review, on a step or on the whole. The same comment again writes nothing. */
export async function goalCommentOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  reviewable(goal)
  if (!(await addComment(d, goal, b, d.now()))) return { goal, outcome: 'unchanged' }
  d.changed(goal.id)
  return { goal, outcome: 'commented' }
}

/** Approve the plan: plan_ready → queued, then plan_approved, whose reaction queues the first step(s). Approving it again is a no-op. */
export async function goalApproveOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  if (goal.state !== 'plan_ready' && (b.version === undefined || b.version === goal.planVersion)) {
    const approved = (await d.store.goals.events(goal.id)).some((e) => e.kind === 'plan_approved' && e.detail?.version === goal.planVersion)
    if (approved) return { goal, outcome: 'unchanged' }
  }
  reviewable(goal)
  sameVersion(goal, b.version)
  const t = transition(goal.state, 'approve', 'you')
  if (!t.ok) throw new Error(t.error)
  const at = d.now()
  const comments = pendingComments(await d.store.goals.events(goal.id))
  // The event goes first: a crash before the move leaves an approval of a goal still in plan_ready, which reactTo ignores.
  const ev = await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'plan_approved', from: null, to: null, detail: { version: goal.planVersion, comments } })
  const moved = await d.store.goals.move(goal.id, t.from, t.to, { actor: 'you', sessionId: null, detail: { trigger: 'approve' }, reason: null }, at)
  if (!moved) throw new Error('the goal moved while you were approving it; read it again')
  d.changed(goal.id)
  d.emit(ev)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'approved' }
}

/**
 * Send the plan back: record any comments given with it, then plan_ready →
 * draft_plan and plan_sent_back carrying every pending comment, whose
 * reaction wakes the lead to revise. It needs at least one comment: the lead
 * can't fix what nobody named.
 */
export async function goalSendBackOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  reviewable(goal)
  sameVersion(goal, b.version)
  const t = transition(goal.state, 'send_back', 'you')
  if (!t.ok) throw new Error(t.error)
  const at = d.now()
  const given = b.comments === undefined || b.comments === null ? [] : b.comments
  if (!Array.isArray(given)) throw new Error('comments must be a list of { stepId?, text }')
  if (typeof b.text === 'string' && b.text.trim()) given.push({ stepId: b.stepId, text: b.text })
  for (const c of given) await addComment(d, goal, c, at)
  const comments = pendingComments(await d.store.goals.events(goal.id))
  if (!comments.length) throw new Error('say what to change: send it back with at least one comment')
  const ev = await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'plan_sent_back', from: null, to: null, detail: { version: goal.planVersion, comments } })
  const moved = await d.store.goals.move(goal.id, t.from, t.to, { actor: 'you', sessionId: null, detail: { trigger: 'send_back' }, reason: null }, at)
  if (!moved) throw new Error('the goal moved while you were sending it back; read it again')
  d.changed(goal.id)
  d.emit(ev)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'sent_back' }
}

/** The drafting lead started: its goal_sessions row, open. */
export async function goalLeadStartedOp(d: GoalDeps, goalId: string, sessionId: string): Promise<void> {
  const goal = await goalOrThrow(d, goalId)
  await d.store.goals.putSession({
    goalId,
    sessionId,
    role: 'lead',
    stepId: null,
    planVersion: goal.planVersion,
    startedAt: d.now(),
    endedAt: null,
    commits: [],
    files: [],
    commands: [],
    actions: [],
    outcome: null,
    costUsd: null,
  })
  d.changed(goalId)
}

/**
 * The drafting lead ended (its turn finished, it timed out, or it never
 * started — sessionId null): close its row and mark the event that woke it
 * handled. A lead that ended without proposing leaves the goal in draft_plan
 * with the reason on it; the user re-wakes it by sending back or asking Junior.
 */
export async function goalLeadSettledOp(d: GoalDeps, s: { goalId: string; seq: number; sessionId: string | null; error?: string | null; costUsd?: number | null }): Promise<void> {
  const at = d.now()
  const goal = await d.store.goals.get(s.goalId)
  if (!goal) return
  const proposed = goal.state !== 'draft_plan'
  if (s.sessionId) {
    const row = (await d.store.goals.sessions(goal.id)).find((r) => r.sessionId === s.sessionId)
    if (row && row.endedAt === null) await d.store.goals.putSession({ ...row, endedAt: at, outcome: proposed ? 'done' : 'failed', costUsd: s.costUsd ?? row.costUsd })
  }
  if (!proposed) {
    const why = s.error ? `: ${s.error}` : '.'
    await d.store.goals.update(goal.id, { reason: `The lead finished without proposing a plan${why}`.slice(0, 500) }, at)
  }
  await d.store.goals.markHandled(goal.id, s.seq, at)
  d.changed(goal.id)
}

/**
 * React to one event — called by `emit` right after the op that wrote it, and
 * by the boot replay. Waking the lead hands off to the engine, and the event is
 * marked handled when that lead settles; everything else is handled here.
 */
export async function onGoalEvent(d: GoalDeps, eng: GoalEngine, ev: GoalEvent): Promise<void> {
  if (!REVIEW_EVENTS.has(ev.kind) || ev.handledAt !== null) return
  const goal = await d.store.goals.get(ev.goalId)
  if (!goal) return
  const at = d.now()
  const r = reactTo(goal, ev, await d.store.goals.steps(goal.id), at)
  if (r.kind === 'wake_lead') {
    try {
      await eng.wakeLead(goal, r.wake, ev)
    } catch (err) {
      await goalLeadSettledOp(d, { goalId: goal.id, seq: ev.seq, sessionId: null, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (r.kind === 'queue_steps') {
    for (const step of r.steps) await d.store.goals.putStep(step)
    await d.store.goals.update(goal.id, { currentStep: r.currentStep }, at)
  }
  await d.store.goals.markHandled(goal.id, ev.seq, at)
  if (r.kind === 'queue_steps') {
    d.changed(goal.id)
    eng.stepsQueued?.(goal, r.steps.filter((x) => x.status === 'runnable').map((x) => x.stepId))
  }
}

/**
 * After a restart: react to the review events nobody finished. Per goal only
 * the latest one counts (an older wake was superseded); the rest are marked
 * handled. A lead row still open belonged to a session the restart killed.
 */
export async function replayGoalEvents(d: GoalDeps, eng: GoalEngine): Promise<number> {
  const latest = new Map<string, GoalEvent>()
  const at = d.now()
  for (const ev of await d.store.goals.unhandled()) {
    if (!REVIEW_EVENTS.has(ev.kind)) continue
    const prev = latest.get(ev.goalId)
    if (prev) await d.store.goals.markHandled(prev.goalId, prev.seq, at)
    latest.set(ev.goalId, ev)
  }
  for (const ev of latest.values()) {
    for (const row of await d.store.goals.sessions(ev.goalId)) {
      if (row.role === 'lead' && row.endedAt === null) await d.store.goals.putSession({ ...row, endedAt: at, outcome: 'failed' })
    }
    await onGoalEvent(d, eng, ev)
  }
  return latest.size
}

// ---------------------------------------------------------------------------
// The run loop (M3): the scheduler, one session per running goal, the lead's
// engine tools, and the user's steering. The decisions are core/goals/run.ts;
// these carry them out. A running goal's session is the one named by its
// latest step_started event; a session that ends after the goal moved on
// (taken over, cancelled, replaced) only closes its row.
// ---------------------------------------------------------------------------

/** Write an event the lead never wakes for, already handled. */
async function note(d: GoalDeps, e: Omit<GoalEvent, 'seq' | 'handledAt' | 'goalId' | 'at'>, goalId: string, at: number): Promise<GoalEvent> {
  const ev = await d.store.goals.addEvent({ goalId, at, ...e })
  await d.store.goals.markHandled(goalId, ev.seq, at)
  return { ...ev, handledAt: at }
}

/** The session a running goal is on: its latest step_started. */
function currentSession(events: readonly GoalEvent[]): { sessionId: string; role: StepRole; stepId: string | null; upTo: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind !== 'step_started' || !e.detail) continue
    return {
      sessionId: String(e.detail.sessionId),
      role: e.detail.role as StepRole,
      stepId: typeof e.detail.stepId === 'string' ? e.detail.stepId : null,
      upTo: typeof e.detail.upTo === 'number' ? e.detail.upTo : 0,
    }
  }
  return null
}

/** The step_started event of one session: who it was and, for a lead, the last event it was shown. */
function startedOf(events: readonly GoalEvent[], sessionId: string): { role: StepRole; stepId: string | null; upTo: number; at: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind !== 'step_started' || e.detail?.sessionId !== sessionId) continue
    return { role: e.detail.role as StepRole, stepId: typeof e.detail.stepId === 'string' ? e.detail.stepId : null, upTo: typeof e.detail.upTo === 'number' ? e.detail.upTo : 0, at: e.at }
  }
  return null
}

/** Move a goal by an engine trigger; false when it had moved already. */
async function engineMove(d: GoalDeps, goal: Goal, trigger: GoalTrigger, reason: string | null, at: number, detail: Record<string, unknown> = {}): Promise<boolean> {
  const t = transition(goal.state, trigger, 'engine')
  if (!t.ok) return false
  return d.store.goals.move(goal.id, t.from, t.to, { actor: 'engine', sessionId: null, detail: { trigger, ...detail }, reason }, at)
}

async function youMove(d: GoalDeps, goal: Goal, trigger: GoalTrigger, reason: string | null, at: number, detail: Record<string, unknown> = {}): Promise<void> {
  const t = transition(goal.state, trigger, 'you')
  if (!t.ok) throw new Error(t.error)
  const moved = await d.store.goals.move(goal.id, t.from, t.to, { actor: 'you', sessionId: null, detail: { trigger, ...detail }, reason }, at)
  if (!moved) throw new Error('the goal moved meanwhile; read it again')
}

const pumps = new WeakMap<GoalDeps, Promise<void>>()

/**
 * The scheduler: fill free session slots, up to `goals.maxParallel` goal
 * sessions at once. Running goals' dispatched workers go first, up to each
 * goal's worker cap, so a team finishes what it started; then queued goals,
 * highest priority first. Serial per workspace, so two pumps never start the
 * same goal or step. Called on every event that can free or need a slot — no timer.
 */
export function pumpGoals(d: GoalDeps, eng: GoalEngine): Promise<void> {
  const run = (pumps.get(d) ?? Promise.resolve()).then(() => pumpOnce(d, eng))
  pumps.set(
    d,
    run.catch(() => {}),
  )
  return run
}

/** Resolves once no pump is queued — for tests and for boot logs. */
export async function goalPumpIdle(d: GoalDeps): Promise<void> {
  for (let p = pumps.get(d); p; p = pumps.get(d) === p ? undefined : pumps.get(d)) await p
}

export const GOALS_MAX_TEAM_KEY = 'goals.maxTeam'

/** The user's max team size (Settings → Teams): the most workers one goal runs at once. */
export async function goalMaxTeam(d: GoalDeps): Promise<number> {
  const v = Number(await d.store.config.get<number>(GOALS_MAX_TEAM_KEY))
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_TEAM
}

/** What a plan is read against: the workflow blocks, and the max team size when the lead is proposing (a user's own edit isn't capped). */
async function planOpts(d: GoalDeps, capped: boolean): Promise<PlanOpts> {
  return { blocks: (await d.blocks?.()) ?? [], maxTeam: capped ? await goalMaxTeam(d) : null }
}

const working = async (d: GoalDeps, goalId: string) => workingSessions(await d.store.goals.steps(goalId), await d.store.goals.events(goalId))

async function pumpOnce(d: GoalDeps, eng: GoalEngine): Promise<void> {
  if (!eng.startSession) return
  const raw = Number((await d.store.config.get<number>('goals.maxParallel')) ?? DEFAULT_MAX_PARALLEL)
  const cap = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PARALLEL
  const maxTeam = await goalMaxTeam(d)
  const running = await d.store.goals.list({ states: ['running'] })
  const open = new Map<string, Working[]>()
  for (const g of running) open.set(g.id, await working(d, g.id))
  let busy = [...open.values()].reduce((n, rows) => n + rows.length, 0)
  // Steps the lead dispatched beside a running goal's workers join them as slots free up; never beside its lead.
  for (const g of running) {
    const rows = open.get(g.id)!
    if (!rows.length || rows.some((r) => r.role === 'lead') || busy >= cap) continue
    busy += await startWorkers(d, eng, g, Math.min(cap - busy, workerCap(g.plan, maxTeam) - rows.length), rows.length)
  }
  const queued = await d.store.goals.list({ states: ['queued'] })
  for (const goal of pickGoals(queued, busy, cap)) {
    if (busy >= cap) break
    busy += await startGoal(d, eng, goal, Math.min(cap - busy, workerCap(goal.plan, maxTeam)))
  }
}

/** The queued actions a goal's workers filed, for the next worker's prompt. */
export async function goalHeldActions(d: GoalDeps, goalId: string): Promise<HeldAction[]> {
  const out: HeldAction[] = []
  for (const row of await d.store.goals.sessions(goalId)) {
    for (const id of row.actions) {
      const rec = await d.store.actions.get(id)
      if (rec && !out.some((a) => a.id === id)) out.push({ id, summary: rec.summary, status: rec.status })
    }
  }
  return out
}

/**
 * One queued goal into running: budget first, then up to `slots` dispatched
 * steps' workers, else the lead. Returns how many sessions it started.
 */
async function startGoal(d: GoalDeps, eng: GoalEngine, goal: Goal, slots: number): Promise<number> {
  const start = eng.startSession
  if (!start || slots < 1) return 0
  const [steps, events, sessions] = await Promise.all([d.store.goals.steps(goal.id), d.store.goals.events(goal.id), d.store.goals.sessions(goal.id)])
  // Approval queues the steps a moment after the move: wait for them.
  if (!goal.plan || !steps.length) return 0
  const at = d.now()
  const b = budgetCheck(goal, minutesUsed(sessions, at), events.some((e) => e.kind === 'budget'))
  if (b.kind === 'stop') {
    await note(d, { actor: 'engine', sessionId: null, kind: 'budget', from: null, to: null, detail: { level: 'stop', text: b.text } }, goal.id, at)
    if (await engineMove(d, goal, 'ask_you', b.text, at)) d.changed(goal.id)
    return 0
  }
  if (b.kind === 'warn') await note(d, { actor: 'engine', sessionId: null, kind: 'budget', from: null, to: null, detail: { level: 'warn', text: b.text } }, goal.id, at)

  const workers = nextWorkers(goal, steps, events, slots)
  if (!workers.length) {
    const files = await d.ledger.read(goal.id, LEAD_LOG_ENTRIES)
    const spec: StartSpec = { role: 'lead', model: goal.plan.models?.lead ?? DEFAULT_GOAL_MODELS.lead, prompt: leadRunPrompt(goal, steps, files, unreadWakes(events)), upTo: events.at(-1)?.seq ?? 0 }
    if (!(await engineMove(d, goal, 'start', null, at))) return 0
    d.changed(goal.id)
    return (await startOne(d, eng, goal, spec)) ? 1 : 0
  }
  if (!(await engineMove(d, goal, 'start', null, at))) return 0
  d.changed(goal.id)
  return startWorkers(d, eng, goal, workers.length, 0, workers)
}

/**
 * Start workers for a running goal's dispatched steps, beside the `beside`
 * sessions it already runs. A builder with company works in a child worktree
 * (merged back when its step is done), so two writers never share a checkout.
 */
async function startWorkers(d: GoalDeps, eng: GoalEngine, goal: Goal, slots: number, beside: number, picked?: WorkerSpec[]): Promise<number> {
  if (slots < 1 || !goal.plan) return 0
  const [steps, events] = await Promise.all([d.store.goals.steps(goal.id), d.store.goals.events(goal.id)])
  const workers = picked ?? nextWorkers(goal, steps, events, slots)
  if (!workers.length) return 0
  const files = await d.ledger.read(goal.id, LEAD_LOG_ENTRIES)
  const held = await goalHeldActions(d, goal.id)
  const crowd = beside + workers.length > 1
  let n = 0
  for (const w of workers) {
    if (w.role === 'lead') continue
    const step = goal.plan.steps.find((s) => s.id === w.stepId)!
    // Reviewer independence (M6): the plan and the change, never the builders' handoff or log.
    const view = w.role === 'reviewer' ? { plan: goal.plan, steps, diff: (await eng.worktreeDiff?.(goal).catch(() => '')) ?? '' } : files
    const p = workerPrompt(goal, step, w, view, held)
    const spec: StartSpec = {
      role: w.role,
      model: w.model ?? goal.plan.models?.worker ?? DEFAULT_GOAL_MODELS.worker,
      stepId: w.stepId,
      attempt: w.attempt,
      writes: roleWrites(w.role),
      context: p.context,
      first: p.first,
      worktree: crowd && roleWrites(w.role) ? 'child' : 'goal',
    }
    if (await startOne(d, eng, goal, spec)) n++
    else if ((await d.store.goals.get(goal.id))?.state !== 'running') break
  }
  return n
}

/**
 * Start one session and record it once it exists. A session that never
 * started parks the goal on the user when the goal has no other; beside
 * others, its step fails and the lead hears of it when they end.
 */
async function startOne(d: GoalDeps, eng: GoalEngine, goal: Goal, spec: StartSpec): Promise<boolean> {
  let sessionId: string | null = null
  const stepId = spec.role === 'lead' ? null : spec.stepId
  try {
    await eng.startSession!(goal, spec, async (id) => {
      sessionId = id
      const t = d.now()
      await d.store.goals.putSession({ goalId: goal.id, sessionId: id, role: spec.role, stepId, planVersion: goal.planVersion, startedAt: t, endedAt: null, commits: [], files: [], commands: [], actions: [], outcome: null, costUsd: null })
      await note(d, { actor: 'engine', sessionId: id, kind: 'step_started', from: null, to: null, detail: { sessionId: id, role: spec.role, stepId, upTo: spec.role === 'lead' ? spec.upTo : null, attempt: spec.role === 'lead' ? null : spec.attempt } }, goal.id, t)
      if (stepId) {
        const st = (await d.store.goals.steps(goal.id)).find((s) => s.stepId === stepId)
        if (st) await d.store.goals.putStep({ ...st, sessionId: id, startedAt: st.startedAt ?? t, updatedAt: t })
      }
      await d.store.goals.update(goal.id, { currentStep: stepId ?? goal.currentStep, reason: null }, t)
      d.changed(goal.id)
    })
    return sessionId !== null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (sessionId) {
      await goalSessionEndedOp(d, eng, { goalId: goal.id, sessionId, error: msg })
      return false
    }
    const g = await d.store.goals.get(goal.id)
    if (!g) return false
    if (!(await working(d, goal.id)).length) {
      // Never started: park it on the user rather than retry in a loop.
      if (await engineMove(d, g, 'ask_you', `Couldn't start a session: ${msg}`.slice(0, 500), d.now())) d.changed(goal.id)
    } else if (stepId) {
      const st = (await d.store.goals.steps(goal.id)).find((s) => s.stepId === stepId)
      const at = d.now()
      if (st) await d.store.goals.putStep({ ...st, status: 'failed', endedAt: at, updatedAt: at })
      await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'engine', sessionId: null, kind: 'step_failed', from: null, to: null, detail: { stepId, outcome: 'failed', error: `couldn't start: ${msg}`.slice(0, 300) } })
      d.changed(goal.id)
    }
    return false
  }
}

export type SessionEnd = {
  goalId: string
  sessionId: string
  /** why it ended early: a crash, a timeout, a stop */
  error?: string | null
  /** what this session spent, in dollars */
  costUsd?: number | null
  /** the daemon restarted under it: a worker's step is dispatched again, not failed */
  restart?: boolean
}

/** One session end at a time per goal: two workers ending together must not both move the goal, nor merge into its worktree at once. */
const ending = new WeakMap<GoalDeps, Map<string, Promise<void>>>()

/**
 * A goal session ended: close its row, book its spend, settle its step (a
 * worker — merged back first when it ran in a child worktree) or the wakes it
 * was shown (the lead). While others of the goal's sessions still run, that's
 * all, and a freed slot is pumped; the last one to end moves the goal on
 * (afterSession). Safe to call twice: only a session still open moves anything.
 */
export function goalSessionEndedOp(d: GoalDeps, eng: GoalEngine, s: SessionEnd): Promise<void> {
  let m = ending.get(d)
  if (!m) ending.set(d, (m = new Map()))
  const run = (m.get(s.goalId) ?? Promise.resolve()).then(() => sessionEnded(d, eng, s))
  const tail = run.catch(() => {})
  m.set(s.goalId, tail)
  void tail.then(() => {
    if (m.get(s.goalId) === tail) m.delete(s.goalId)
  })
  return run
}

async function sessionEnded(d: GoalDeps, eng: GoalEngine, s: SessionEnd): Promise<void> {
  const goal = await d.store.goals.get(s.goalId)
  if (!goal) return
  const at = d.now()
  const row = (await d.store.goals.sessions(goal.id)).find((r) => r.sessionId === s.sessionId)
  if (!row) return
  const events = await d.store.goals.events(goal.id)
  let steps = await d.store.goals.steps(goal.id)
  const st = row.stepId ? steps.find((x) => x.stepId === row.stepId) : undefined
  const holds = st && st.status === 'running' && st.sessionId === s.sessionId
  // Only a session still working the goal moves it: a worker holding its step, or the lead that started last.
  const live = goal.state === 'running' && (!!holds || currentSession(events)?.sessionId === s.sessionId)
  let error = s.error ?? null
  const cost = s.costUsd && s.costUsd > 0 ? s.costUsd : 0
  let outcome: SessionOutcome = row.role === 'lead' ? (error ? 'failed' : 'done') : workerOutcome(row, error)
  let unmerged = false
  // A builder in a child worktree hands its step in by merging into the goal branch; a conflict fails the step.
  if (live && holds && !s.restart && outcome === 'done' && eng.mergeBack) {
    const why = await eng.mergeBack(goal, s.sessionId).catch((err) => (err instanceof Error ? err.message : String(err)))
    if (why) {
      error = `couldn't merge into the goal branch: ${why}`.slice(0, 500)
      outcome = 'failed'
      unmerged = true
    }
  }
  if (row.endedAt === null || cost || unmerged) await d.store.goals.putSession({ ...row, endedAt: row.endedAt ?? at, outcome: unmerged ? outcome : (row.outcome ?? outcome), costUsd: cost ? (row.costUsd ?? 0) + cost : row.costUsd })
  if (cost) await d.store.goals.update(goal.id, { spentUsd: goal.spentUsd + cost }, at)

  if (!live || (s.restart && row.role !== 'lead' && outcome !== 'done')) {
    // Taken over, cancelled, or the daemon died under it: the step is dispatched again for whoever comes next.
    if (holds && outcome !== 'done') await d.store.goals.putStep({ ...st, sessionId: null, updatedAt: at })
    if (!live) {
      d.changed(goal.id)
      return
    }
  } else if (row.role === 'lead') {
    const upTo = startedOf(events, s.sessionId)?.upTo ?? 0
    for (const e of unreadWakes(events)) if (e.seq <= upTo) await d.store.goals.markHandled(goal.id, e.seq, at)
  } else if (holds) {
    if (outcome === 'done') {
      await d.store.goals.putStep({ ...st, status: 'done', endedAt: at, updatedAt: at })
      await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'worker', sessionId: s.sessionId, kind: 'step_finished', from: null, to: null, detail: { stepId: st.stepId, sessionId: s.sessionId } })
      steps = await d.store.goals.steps(goal.id)
      for (const u of unlock(goal.plan!, steps, at)) await d.store.goals.putStep(u)
    } else {
      await d.store.goals.putStep({ ...st, status: outcome === 'blocked' ? 'blocked' : 'failed', endedAt: at, updatedAt: at })
      await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'worker', sessionId: s.sessionId, kind: 'step_failed', from: null, to: null, detail: { stepId: st.stepId, sessionId: s.sessionId, outcome, error } })
    }
  }

  // The rest of the team is still at it: the goal waits for its last session; a freed slot may start another.
  if ((await working(d, goal.id)).some((w) => w.sessionId !== s.sessionId)) {
    d.changed(goal.id)
    void pumpGoals(d, eng).catch(() => {})
    return
  }
  const [after, gates, evs] = await Promise.all([d.store.goals.steps(goal.id), d.store.goals.gates(goal.id), d.store.goals.events(goal.id)])
  const move = afterSession(goal, after, gates, evs)
  // Every step done: the goal is finished without waking the lead to say so.
  if (move.trigger === 'result') for (const e of unreadWakes(evs)) await d.store.goals.markHandled(goal.id, e.seq, at)
  const fresh = (await d.store.goals.get(goal.id))!
  await engineMove(d, fresh, move.trigger, move.reason, at, error ? { error: error.slice(0, 300) } : {})
  if (move.trigger === 'result') await d.store.goals.update(goal.id, { currentStep: null }, at)
  d.changed(goal.id)
  // Not awaited: this may run inside a pump (a session that ended before it started), which the next one queues behind.
  void pumpGoals(d, eng).catch(() => {})
}

/**
 * After a restart: every goal still `running` lost its sessions. Close each
 * as a restart (a worker's step goes back to dispatched, the lead's wakes
 * stay unread), move the goal back to the queue, and pump. The next worker
 * reads the handoff and the list of actions already queued, so nothing is filed twice.
 */
export async function bootGoalRun(d: GoalDeps, eng: GoalEngine): Promise<number> {
  const running = await d.store.goals.list({ states: ['running'] })
  const quiet: GoalEngine = { ...eng, startSession: undefined, mergeBack: undefined }
  for (const goal of running) {
    const lost = await working(d, goal.id)
    // Rows a restart left open that nobody settles (an earlier session's): closed as failed.
    for (const r of await d.store.goals.sessions(goal.id)) if (r.endedAt === null && !lost.some((w) => w.sessionId === r.sessionId)) await d.store.goals.putSession({ ...r, endedAt: d.now(), outcome: r.outcome ?? 'failed' })
    for (const w of lost) await goalSessionEndedOp(d, quiet, { goalId: goal.id, sessionId: w.sessionId, error: 'triage restarted', restart: true })
    const g = await d.store.goals.get(goal.id)
    if (g?.state === 'running') await engineMove(d, g, 'yield', null, d.now(), { restart: true })
    d.changed(goal.id)
  }
  await pumpGoals(d, eng)
  return running.length
}

// --- the lead's engine tools ------------------------------------------------

/** The goal a lead tool call acts on — only while that lead is the goal's live session. */
async function asLead(d: GoalDeps, goalId: string, sessionId: string): Promise<{ goal: Goal; steps: GoalStepState[]; events: GoalEvent[] }> {
  const goal = await goalOrThrow(d, goalId)
  const events = await d.store.goals.events(goal.id)
  const cur = currentSession(events)
  if (goal.state !== 'running' || cur?.sessionId !== sessionId || cur.role !== 'lead') throw new Error("this session isn't the goal's lead right now")
  return { goal, steps: await d.store.goals.steps(goal.id), events }
}

type LeadCall = { goalId: string; sessionId: string }

/** dispatch_worker: the step is running with no session yet; the scheduler starts its worker once the lead ends. */
export async function goalDispatchWorkerOp(d: GoalDeps, c: LeadCall, raw: unknown): Promise<string> {
  const b = obj(raw)
  const { goal, steps } = await asLead(d, c.goalId, c.sessionId)
  const stepId = id(b.stepId, 'stepId')
  const brief = str(b.brief, 'brief')
  const model = optStr(b.model, 'model', 80)
  const why = dispatchRefusal(goal.plan, steps, stepId)
  if (why) throw new Error(why)
  const st = steps.find((s) => s.stepId === stepId)!
  const at = d.now()
  await d.store.goals.putStep({ ...st, status: 'running', sessionId: null, attempts: st.attempts + 1, startedAt: at, endedAt: null, updatedAt: at })
  await note(d, { actor: 'lead', sessionId: c.sessionId, kind: 'step_dispatched', from: null, to: null, detail: { stepId, brief, model, attempt: st.attempts + 1 } }, goal.id, at)
  d.changed(goal.id)
  return `dispatched ${stepId} (try ${st.attempts + 1}); its worker starts when you end your turn`
}

/**
 * arm_gate: an AI gate is a row the sweep checks; a user gate is an approval
 * on the goal's Inbox item at once. The step is running until it resolves.
 */
export async function goalArmGateOp(d: GoalDeps, c: LeadCall, raw: unknown): Promise<string> {
  const b = obj(raw)
  const { goal, steps, events } = await asLead(d, c.goalId, c.sessionId)
  const stepId = id(b.stepId, 'stepId')
  const gates = await d.store.goals.gates(goal.id)
  const why = armRefusal(goal.plan, steps, gates, stepId)
  if (why) throw new Error(why)
  const step = goal.plan!.steps.find((s) => s.id === stepId)!
  const spec = step.gate!
  // A watcher gate stays the watcher's: its PR is read by code, not judged.
  const evaluator = spec.evaluator !== 'watcher' && (b.evaluator === 'ai' || b.evaluator === 'user') ? b.evaluator : spec.evaluator
  const checkEvery = optStr(b.checkEvery, 'checkEvery', 20) ?? spec.checkEvery
  const deadline = optStr(b.deadline, 'deadline', 20) ?? spec.deadline ?? GATE_DEFAULT_DEADLINE
  const checkEveryMs = checkEvery ? parseDuration(checkEvery) : null
  if (checkEvery && checkEveryMs === null) throw new Error(`checkEvery "${checkEvery}" isn't a duration like 15m`)
  const deadlineMs = parseDuration(deadline)
  if (deadlineMs === null) throw new Error(`deadline "${deadline}" isn't a duration like 4h`)
  const confirmations = b.confirmations === undefined ? spec.confirmations : Number(b.confirmations)
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > MAX_CONFIRMATIONS) throw new Error(`confirmations must be 1 to ${MAX_CONFIRMATIONS}`)
  const condition = optStr(b.condition, 'condition') ?? spec.condition
  const recommended = evaluator === 'user' ? str(b.recommended, 'recommended (your recommended answer, for a user gate)', 4_000) : null
  if (evaluator === 'user' && openAsk(events)) throw new Error('something is already waiting on the user this wake')
  const at = d.now()
  const gate: Gate = {
    id: randomUUID(),
    goalId: goal.id,
    stepId,
    evaluator,
    condition,
    connectors: b.connectors === undefined ? spec.connectors : strList(b.connectors, 'connectors'),
    // A user gate is the user's from the start: there is nothing to sweep.
    status: evaluator === 'user' ? 'needs_user' : 'open',
    refs: strList(b.refs, 'refs'),
    armedAt: at,
    nextCheckAt: evaluator === 'ai' ? at + (checkEveryMs ?? GATE_CHECK_SCHEDULE_MIN[0]! * 60_000) : null,
    checks: 0,
    checkEveryMs,
    deadlineAt: at + deadlineMs,
    // High stakes (a merge, a deploy, production): never on one "met" — unless code read it (the watcher).
    confirmationsNeeded: evaluator === 'watcher' ? 1 : requiredConfirmations(confirmations, condition, step.title),
    confirmationsSeen: 0,
    lastVerdict: null,
    itemId: evaluator === 'user' ? goal.sourceItemId : null,
    settledAt: null,
  }
  await d.store.goals.putGate(gate)
  const st = steps.find((s) => s.stepId === stepId)!
  await d.store.goals.putStep({ ...st, status: 'running', attempts: st.attempts + 1, startedAt: at, endedAt: null, updatedAt: at })
  await note(d, { actor: 'lead', sessionId: c.sessionId, kind: 'gate_armed', from: null, to: null, detail: { stepId, gateId: gate.id, condition: gate.condition, evaluator } }, goal.id, at)
  if (evaluator === 'user') {
    await note(
      d,
      { actor: 'lead', sessionId: c.sessionId, kind: 'asked_you', from: null, to: null, detail: { gateId: gate.id, why: 'approval', question: condition, recommended, evidence: optStr(b.evidence, 'evidence'), options: [] } },
      goal.id,
      at,
    )
  }
  d.changed(goal.id)
  if (evaluator === 'watcher') return `the PR watcher has ${stepId}: it works the PR until "${gate.condition}". End your turn — you wake when its steps finish or the PR merges`
  return evaluator === 'user'
    ? `asked the user to approve ${stepId}: "${condition}". End your turn — you wake when they answer`
    : `armed the gate on ${stepId}: the goal waits for "${gate.condition}" once you end your turn${gate.confirmationsNeeded > 1 ? ` (${gate.confirmationsNeeded} "met" checks in a row)` : ''}`
}

/** ask_user: the question goes on the goal; it waits on the user once the lead ends. */
export async function goalAskUserOp(d: GoalDeps, c: LeadCall, raw: unknown): Promise<string> {
  const b = obj(raw)
  const { goal, events } = await asLead(d, c.goalId, c.sessionId)
  const question = str(b.question, 'question', 4_000)
  const open = openAsk(events)
  if (open?.kind === 'ask' && open.ev.detail?.question === question) return 'already asked; end your turn'
  if (open) throw new Error('one question at a time: you already asked something this wake')
  await note(
    d,
    { actor: 'lead', sessionId: c.sessionId, kind: 'asked_you', from: null, to: null, detail: { question, recommended: str(b.recommended, 'recommended', 4_000), evidence: optStr(b.evidence, 'evidence'), options: strList(b.options, 'options') } },
    goal.id,
    d.now(),
  )
  d.changed(goal.id)
  return 'asked; end your turn — you wake with the answer'
}

/** propose_plan_change: validated now; it goes to the user once the lead ends. */
export async function goalProposePlanChangeOp(d: GoalDeps, c: LeadCall, raw: unknown): Promise<string> {
  const b = obj(raw)
  const { goal, events } = await asLead(d, c.goalId, c.sessionId)
  const why = str(b.why, 'why', 4_000)
  const parsed = planFrom(b.plan, goal, await planOpts(d, true))
  if (!parsed.ok) throw new Error(`plan rejected: ${parsed.error}`)
  if (samePlan(goal.plan, parsed.plan)) throw new Error("that's the plan already approved")
  if (openAsk(events)) throw new Error('something is already waiting on the user this wake')
  await note(d, { actor: 'lead', sessionId: c.sessionId, kind: 'plan_change_proposed', from: null, to: null, detail: { why, plan: parsed.plan } }, goal.id, d.now())
  d.changed(goal.id)
  return 'proposed; end your turn — you wake when the user accepts or turns it down'
}

/** report_step_result: a claim, checked (core/goals/run.ts reportResult) before it moves the step. */
export async function goalReportStepResultOp(d: GoalDeps, c: LeadCall, raw: unknown): Promise<string> {
  const b = obj(raw)
  const { goal, steps, events } = await asLead(d, c.goalId, c.sessionId)
  const stepId = id(b.stepId, 'stepId')
  if (!OUTCOMES.includes(b.outcome as SessionOutcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`)
  const outcome = b.outcome as SessionOutcome
  const summary = str(b.summary, 'summary', 4_000)
  const evidence = optStr(b.evidence, 'evidence')
  const r = reportResult(goal.plan, steps, await d.store.goals.sessions(goal.id), events, { stepId, outcome, evidence })
  if (!r.ok) throw new Error(r.error)
  const st = steps.find((s) => s.stepId === stepId)!
  const at = d.now()
  await d.store.goals.putStep({ ...st, status: r.status, endedAt: at, updatedAt: at })
  await note(d, { actor: 'lead', sessionId: c.sessionId, kind: r.status === 'done' ? 'step_finished' : 'step_failed', from: null, to: null, detail: { stepId, outcome, summary, evidence, reported: true } }, goal.id, at)
  if (r.status === 'done') for (const u of unlock(goal.plan!, await d.store.goals.steps(goal.id), at)) await d.store.goals.putStep(u)
  d.changed(goal.id)
  return `step ${stepId} is ${r.status}`
}

// --- gates (M4, decision 6) -------------------------------------------------

/** Goals whose gates the sweep looks at: a paused or finished goal's gates wait. */
const SWEPT: ReadonlySet<GoalState> = new Set(['queued', 'running', 'waiting_world', 'waiting_you'])

/**
 * Check a batch of due AI gates — the one short read-only session (server
 * side: index.ts runGateCheck). Returns a verdict per gate id it decided and
 * what the session cost; a gate it left out counts as an error.
 */
export type GateChecker = (gates: Gate[], model: string) => Promise<{ verdicts: Map<string, GateVerdict>; costUsd: number }>

export type SweepResult = { checked: number; resolved: number; toUser: number }

const span = (ms: number) => (ms >= 86_400_000 ? `${Math.round(ms / 86_400_000)}d` : ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`)

/**
 * The gate sweep: every gate past its deadline goes to the user; every due AI
 * gate is checked in one session per gate model, and its verdict applied —
 * met (confirmed) wakes the lead, not met backs off, needs the user goes to
 * the Inbox. Nothing due = nothing started.
 */
export async function goalGateSweepOp(d: GoalDeps, eng: GoalEngine, check: GateChecker): Promise<SweepResult> {
  const out: SweepResult = { checked: 0, resolved: 0, toUser: 0 }
  const goals = new Map<string, Goal | null>()
  const goalOf = async (goalId: string) => {
    if (!goals.has(goalId)) goals.set(goalId, await d.store.goals.get(goalId))
    return goals.get(goalId) ?? null
  }

  for (const g of await d.store.goals.overdueGates(d.now())) {
    const goal = await goalOf(g.goalId)
    if (!goal || !SWEPT.has(goal.state)) continue
    const last = g.lastVerdict ? ` Last check: ${g.lastVerdict.verdict.replace('_', ' ')}${g.lastVerdict.evidence ? ` — ${g.lastVerdict.evidence}` : ''}.` : ''
    if (await gateToUser(d, eng, g, 'deadline', `Still waiting after ${span(g.deadlineAt - g.armedAt)} for: ${g.condition}. Keep waiting, or call it?`, 'Keep waiting another day', `${g.checks} checks.${last}`)) out.toUser++
  }

  const byModel = new Map<string, Gate[]>()
  for (const g of await d.store.goals.dueGates(d.now())) {
    const goal = await goalOf(g.goalId)
    if (!goal || !SWEPT.has(goal.state)) continue
    const model = goal.plan?.models?.gate ?? DEFAULT_GOAL_MODELS.gate
    byModel.set(model, [...(byModel.get(model) ?? []), g])
  }
  for (const [model, due] of byModel) {
    const { verdicts, costUsd } = await check(due, model)
    const at = d.now()
    // The session's cost, shared by the goals it checked for.
    const share = costUsd > 0 ? costUsd / due.length : 0
    for (const armed of due) {
      out.checked++
      const g = await d.store.goals.gate(armed.id)
      const goal = await d.store.goals.get(armed.goalId)
      if (goal && share) await d.store.goals.update(goal.id, { spentUsd: goal.spentUsd + share }, at)
      // Settled or re-armed while it was being checked: the verdict is stale.
      if (!g || !goal || g.status !== 'open' || g.checks !== armed.checks) continue
      const v = verdicts.get(g.id) ?? NO_VERDICT
      const r = applyVerdict(g, v, at)
      await d.store.goals.putGate(r.gate)
      await note(d, { actor: 'gate', sessionId: null, kind: 'gate_checked', from: null, to: null, detail: { gateId: g.id, stepId: g.stepId, verdict: v.verdict, evidence: v.evidence, seen: r.gate.confirmationsSeen, needed: g.confirmationsNeeded } }, goal.id, at)
      if (r.outcome === 'resolved') {
        await resolveGate(d, eng, r.gate, 'gate', v.evidence)
        out.resolved++
      } else if (r.outcome === 'to_user') {
        if (await gateToUser(d, eng, r.gate, 'needs_user', `Junior's checker can't tell whether this holds: ${g.condition}`, 'Look, then approve if it holds — otherwise keep waiting', v.evidence || null)) out.toUser++
      }
      d.changed(goal.id)
    }
  }
  return out
}

/** A gate met — by its checker or the user's approval: the step is done and the lead wakes. */
async function resolveGate(d: GoalDeps, eng: GoalEngine, gate: Gate, by: 'gate' | 'you' | 'watcher', evidence: string | null): Promise<void> {
  const at = d.now()
  await d.store.goals.putGate({ ...gate, status: 'met', nextCheckAt: null, settledAt: at })
  const goal = (await d.store.goals.get(gate.goalId))!
  const st = (await d.store.goals.steps(goal.id)).find((s) => s.stepId === gate.stepId)
  if (st && st.status !== 'done') {
    await d.store.goals.putStep({ ...st, status: 'done', endedAt: at, updatedAt: at })
    for (const u of unlock(goal.plan!, await d.store.goals.steps(goal.id), at)) await d.store.goals.putStep(u)
  }
  await d.store.goals.addEvent({ goalId: goal.id, at, actor: by, sessionId: null, kind: 'gate_resolved', from: null, to: null, detail: { gateId: gate.id, stepId: gate.stepId, condition: gate.condition, by, evidence } })
  if (goal.state === 'waiting_world') await engineMove(d, goal, 'gate_met', null, at, { gateId: gate.id })
  d.changed(goal.id)
  void pumpGoals(d, eng).catch(() => {})
}

/**
 * A gate the user must settle — past its deadline, or its checker couldn't
 * tell: an approval on the goal's Inbox item, with the evidence and Junior's
 * recommended answer. Waits (false) while the user already has a question on
 * this goal: one at a time.
 */
async function gateToUser(d: GoalDeps, _eng: GoalEngine, gate: Gate, why: 'deadline' | 'needs_user', question: string, recommended: string, evidence: string | null): Promise<boolean> {
  const goal = await d.store.goals.get(gate.goalId)
  if (!goal) return false
  const at = d.now()
  if (openAsk(await d.store.goals.events(goal.id))) {
    // The user has a question on this goal already; ask after it, at the slow end of the schedule.
    if (why === 'needs_user') await d.store.goals.putGate({ ...gate, nextCheckAt: at + nextCheckDelay(Number.MAX_SAFE_INTEGER, null) })
    return false
  }
  await d.store.goals.putGate({ ...gate, status: 'needs_user', nextCheckAt: null, itemId: goal.sourceItemId })
  await note(d, { actor: 'gate', sessionId: null, kind: 'asked_you', from: null, to: null, detail: { gateId: gate.id, why, question, recommended, evidence, options: [] } }, goal.id, at)
  // A running goal is caught when its session ends (afterSession reads the open ask).
  if (goal.state === 'waiting_world' || goal.state === 'queued') await engineMove(d, goal, 'ask_you', question.slice(0, 500), at, { gateId: gate.id })
  d.changed(goal.id)
  return true
}

// --- the PR shepherd (M5) --------------------------------------------------

/** How the watcher reads and pokes a PR — `gh` in production (ghPrSource), a fake in tests. */
export type PrSource = {
  /** the PR the gate watches: one named in its refs, else the PR open on the goal's branch; null = none yet */
  find: (goal: Goal, gate: Gate) => Promise<PrRef | null>
  snapshot: (pr: PrRef) => Promise<PrSnapshot>
  /** the failing check's log (`gh run view --log-failed`); '' when there is none */
  failedLog: (pr: PrRef, check: PrCheck) => Promise<string>
  diff: (pr: PrRef) => Promise<string>
  /** run a failed check again — one per check and head commit, a policy in the approved plan */
  rerun: (pr: PrRef, check: PrCheck) => Promise<void>
}

export type WatchResult = { polled: number; acted: number; toUser: number }

/** The watch's memory, per goal: in config, so no table for one small JSON blob. */
const watchKey = (goalId: string) => `goals.prWatch.${goalId}`

/**
 * The watcher's tick: every open watcher gate whose poll is due reads its PR
 * and acts on what's new through the default policies (core/goals/shepherd.ts)
 * — a step dispatched to a worker, a flaky check rerun, a question to the
 * user, or the gate met when the PR merges. No model runs here; nothing due =
 * no `gh` call. An event that can't be acted on yet (its step is running, the
 * user has a question open) stays unseen and is read again next poll.
 */
export async function goalWatchPrsOp(d: GoalDeps, eng: GoalEngine, src: PrSource): Promise<WatchResult> {
  const out: WatchResult = { polled: 0, acted: 0, toUser: 0 }
  for (const goal of await d.store.goals.list({ states: [...SWEPT] })) {
    const gate = (await d.store.goals.gates(goal.id)).find((g) => g.evaluator === 'watcher' && g.status === 'open')
    if (!gate) continue
    const at = d.now()
    const saved = await d.store.config.get<PrWatch>(watchKey(goal.id))
    let w = saved && saved.gateId === gate.id ? saved : newWatch(gate.id, at)
    if (w.nextPollAt > at) continue
    out.polled++
    let snap: PrSnapshot
    try {
      const pr = w.pr ?? (await src.find(goal, gate))
      if (!pr) {
        await d.store.config.set(watchKey(goal.id), nextPoll(w, false, at))
        continue
      }
      w = { ...w, pr }
      snap = await src.snapshot(pr)
    } catch (err) {
      const errors = w.errors + 1
      // Once per streak: a gh that keeps failing says so on the goal, not every poll.
      if (errors === 1) await note(d, { actor: 'watcher', sessionId: null, kind: 'watcher', from: null, to: null, detail: { text: `Couldn't read the PR: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` } }, goal.id, at)
      await d.store.config.set(watchKey(goal.id), nextPoll({ ...w, errors }, false, at))
      continue
    }
    const pr = w.pr!
    const moved = snap.headSha !== w.headSha
    w = { ...w, errors: 0 }
    let acted = false
    for (const ev of assess(snap, w)) {
      const log = ev.kind === 'checks_failed' && ev.check.runId !== null ? await src.failedLog(pr, ev.check).catch(() => '') : ''
      const dec = policyFor(ev, w, pr, log)
      const r = await carryOut(d, eng, goal.id, gate, w, ev, dec, { src, pr, snap, log })
      if (r === 'deferred') continue
      if (r === 'rerun_failed') {
        // The rerun didn't go through: spend it anyway, so the next poll goes straight to a fix.
        w = { ...w, reruns: [...w.reruns, `${(ev as Extract<WatcherEvent, { kind: 'checks_failed' }>).check.name}@${snap.headSha}`] }
        continue
      }
      w = afterDecision(w, ev, dec)
      acted = true
      out.acted++
      if (dec.do === 'ask_user') out.toUser++
      if (dec.do === 'resolve') break
    }
    await d.store.config.set(watchKey(goal.id), nextPoll({ ...w, headSha: snap.headSha }, acted || moved, at))
  }
  return out
}

type Carry = { src: PrSource; pr: PrRef; snap: PrSnapshot; log: string }

/** One decision, carried out. 'deferred' = not now; the event stays unseen. */
async function carryOut(d: GoalDeps, eng: GoalEngine, goalId: string, gate: Gate, w: PrWatch, ev: WatcherEvent, dec: PolicyDecision, c: Carry): Promise<'done' | 'deferred' | 'rerun_failed'> {
  const at = d.now()
  const say = (text: string, extra: Record<string, unknown> = {}) => note(d, { actor: 'watcher', sessionId: null, kind: 'watcher', from: null, to: null, detail: { text, policy: dec.policy, pr: `${c.pr.repo}#${c.pr.number}`, ...extra } }, goalId, at)
  switch (dec.do) {
    case 'note':
      await say(dec.text)
      d.changed(goalId)
      return 'done'
    case 'rerun':
      try {
        await c.src.rerun(c.pr, dec.check)
      } catch (err) {
        await say(`${dec.check.name} looked flaky, but the rerun failed (${(err instanceof Error ? err.message : String(err)).slice(0, 200)}): fixing it instead`)
        return 'rerun_failed'
      }
      await say(dec.text)
      d.changed(goalId)
      return 'done'
    case 'ask_user':
      return (await watcherAsk(d, goalId, dec.question, dec.recommended, dec.evidence)) ? 'done' : 'deferred'
    case 'resolve': {
      // The PR merged: the fixes nobody started are moot.
      for (const st of await d.store.goals.steps(goalId)) if (w.steps.includes(st.stepId) && st.status !== 'done' && st.status !== 'skipped' && st.sessionId === null) await d.store.goals.putStep({ ...st, status: 'skipped', endedAt: at, updatedAt: at })
      const g = await d.store.goals.gate(gate.id)
      if (g?.status === 'open') await resolveGate(d, eng, g, 'watcher', `${c.snap.url || `${c.pr.repo}#${c.pr.number}`} merged`)
      return 'done'
    }
    case 'step':
      return dispatchShepherdStep(d, eng, goalId, gate, ev, dec, c)
  }
}

/** A shepherd step onto the plan (once) and dispatched to a builder, with its brief; the goal comes off waiting for the world. */
async function dispatchShepherdStep(d: GoalDeps, eng: GoalEngine, goalId: string, gate: Gate, ev: WatcherEvent, dec: Extract<PolicyDecision, { do: 'step' }>, c: Carry): Promise<'done' | 'deferred'> {
  let goal = await d.store.goals.get(goalId)
  if (!goal?.plan) return 'deferred'
  const at = d.now()
  const existing = (await d.store.goals.steps(goalId)).find((s) => s.stepId === dec.stepId)
  // A fix already under way: what it pushes is the next thing to read.
  if (existing?.status === 'running') return 'deferred'
  if (!goal.plan.steps.some((s) => s.id === dec.stepId)) {
    const gateStep = goal.plan.steps.find((s) => s.id === gate.stepId)
    const step = { id: dec.stepId, title: dec.title, type: 'agent' as const, role: 'builder' as const, dependsOn: gateStep?.dependsOn ?? [], doneWhen: dec.doneWhen, gate: null, block: null }
    const steps = [...goal.plan.steps]
    steps.splice(Math.max(0, steps.findIndex((s) => s.id === gate.stepId)), 0, step)
    await applyPlan(d, goal, { ...goal.plan, steps }, at)
    goal = (await d.store.goals.get(goalId))!
  }
  const st = (await d.store.goals.steps(goalId)).find((s) => s.stepId === dec.stepId)
  if (!st) return 'deferred'
  const attempt = st.attempts + 1
  const brief =
    dec.step === 'fix_ci' && ev.kind === 'checks_failed'
      ? fixCiBrief(c.pr, ev.check, attempt, c.log, await c.src.diff(c.pr).catch(() => ''))
      : dec.step === 'fix_thread' && (ev.kind === 'bot_thread' || ev.kind === 'human_thread')
        ? threadBrief(c.pr, ev.thread)
        : dec.step === 'rebase'
          ? rebaseBrief(c.pr, c.snap)
          : mergeBrief(c.pr)
  await d.store.goals.putStep({ ...st, status: 'running', sessionId: null, attempts: attempt, startedAt: at, endedAt: null, updatedAt: at })
  await note(d, { actor: 'watcher', sessionId: null, kind: 'step_dispatched', from: null, to: null, detail: { stepId: dec.stepId, brief, model: null, attempt } }, goalId, at)
  await note(d, { actor: 'watcher', sessionId: null, kind: 'watcher', from: null, to: null, detail: { text: dec.text, policy: dec.policy, stepId: dec.stepId, pr: `${c.pr.repo}#${c.pr.number}` } }, goalId, at)
  if (goal.state === 'waiting_world') await engineMove(d, goal, 'watcher_step', dec.title.slice(0, 500), at, { stepId: dec.stepId })
  d.changed(goalId)
  void pumpGoals(d, eng).catch(() => {})
  return 'done'
}

/** The watcher's question to the user, one at a time like every other; they answer in words and the lead wakes with it. */
async function watcherAsk(d: GoalDeps, goalId: string, question: string, recommended: string, evidence: string | null): Promise<boolean> {
  const goal = await d.store.goals.get(goalId)
  if (!goal || openAsk(await d.store.goals.events(goalId))) return false
  const at = d.now()
  await note(d, { actor: 'watcher', sessionId: null, kind: 'asked_you', from: null, to: null, detail: { why: 'watcher', question, recommended, evidence, options: [] } }, goalId, at)
  // A running goal is caught when its session ends (afterSession reads the open ask).
  if (goal.state === 'waiting_world' || goal.state === 'queued') await engineMove(d, goal, 'ask_you', question.slice(0, 500), at)
  d.changed(goalId)
  return true
}

const pExec = promisify(execFile)

/** The watcher's PR reads and its one write (a rerun), through the user's `gh` login. `cwdOf` = the goal's worktree, to find the PR on its branch. */
export function ghPrSource(cwdOf: (goal: Goal) => string | null): PrSource {
  const gh = async (args: string[], cwd?: string) => {
    try {
      return (await pExec('gh', args, { maxBuffer: 32 * 1024 * 1024, ...(cwd ? { cwd } : {}) })).stdout
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string }
      if (e.code === 'ENOENT') throw new Error('GitHub CLI (gh) not found')
      throw new Error(`gh ${args.slice(0, 2).join(' ')} failed${e.stderr?.trim() ? `: ${e.stderr.trim().slice(0, 300)}` : ''}`)
    }
  }
  return {
    find: async (goal, gate) => {
      const named = prRefFrom(gate.refs, null)
      if (named) return named
      const cwd = cwdOf(goal)
      if (!cwd) return null
      // `#12` in the refs: the repo is the worktree's.
      if (gate.refs.some((r) => prRefFrom([r], 'x/x'))) {
        const repo = (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd).catch(() => '')).trim()
        const bare = repo ? prRefFrom(gate.refs, repo) : null
        if (bare) return bare
      }
      // The PR open on the worktree's branch; none yet is not an error.
      const raw = await gh(['pr', 'view', '--json', 'number,url,state'], cwd).catch(() => '')
      if (!raw.trim()) return null
      const j = JSON.parse(raw) as { number?: number; url?: string }
      return prRefFrom([String(j.url ?? '')], null)
    },
    snapshot: async (pr) => {
      const [owner, name] = pr.repo.split('/')
      const raw = await gh(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr.number}`])
      return snapshotFrom(pr, JSON.parse(raw))
    },
    failedLog: async (pr, check) => (check.runId === null ? '' : gh(['run', 'view', String(check.runId), '-R', pr.repo, '--log-failed'])),
    diff: (pr) => gh(['pr', 'diff', String(pr.number), '-R', pr.repo]),
    rerun: async (pr, check) => {
      if (check.runId === null) throw new Error(`${check.name} isn't an Actions run`)
      await gh(['run', 'rerun', String(check.runId), '-R', pr.repo, '--failed'])
    },
  }
}

const GATE_ANSWERS = ['approve', 'wait', 'reject'] as const
type GateAnswer = (typeof GATE_ANSWERS)[number]

/**
 * The user settles a gate asked about: approve (the step is done; for an AI
 * gate, the user's word stands in for the checker's), keep waiting (an AI
 * gate only: checks resume with a fresh deadline and the lead isn't woken),
 * or reject (the step failed; the lead wakes to decide what's next). Words
 * alone settle it like a reject: the gate closes and the lead wakes to them.
 */
async function answerGate(d: GoalDeps, eng: GoalEngine, goal: Goal, gate: Gate, answer: GateAnswer | 'words', text: string | null, at: number): Promise<void> {
  const said = (verb: string) => `${verb}: ${gate.condition}${text ? ` — ${text}` : ''}`
  if (answer === 'wait') {
    if (gate.evaluator === 'user') throw new Error("a user gate has nothing to wait for: approve or reject it")
    const deadlineMs = parseDuration(GATE_DEFAULT_DEADLINE)!
    const nextCheckAt = gate.evaluator === 'ai' ? at + nextCheckDelay(gate.checks, gate.checkEveryMs) : null
    await d.store.goals.putGate({ ...gate, status: 'open', itemId: null, confirmationsSeen: 0, nextCheckAt, deadlineAt: at + deadlineMs })
    // Settled without waking the lead: it reads the answer with whatever wakes it next.
    await note(d, { actor: 'you', sessionId: null, kind: 'answered', from: null, to: null, detail: { text: said('Keep waiting'), gateId: gate.id, gate: 'wait' } }, goal.id, at)
    const [steps, events] = await Promise.all([d.store.goals.steps(goal.id), d.store.goals.events(goal.id)])
    const cur = (await d.store.goals.get(goal.id))!
    // Something else is due meanwhile (a finished step, a message): the lead runs instead of waiting.
    const trigger = workerDue(cur.plan, steps) || unreadWakes(events).length ? 'answer' : 'keep_waiting'
    await youMove(d, cur, trigger, trigger === 'keep_waiting' ? `Waiting for: ${gate.condition}`.slice(0, 500) : null, at, { gateId: gate.id })
    return
  }
  if (answer === 'approve') {
    await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'answered', from: null, to: null, detail: { text: said('Approved'), gateId: gate.id, gate: 'approve' } })
    await resolveGate(d, eng, gate, 'you', text)
  } else {
    await d.store.goals.putGate({ ...gate, status: 'cancelled', nextCheckAt: null, settledAt: at })
    const st = (await d.store.goals.steps(goal.id)).find((s) => s.stepId === gate.stepId)
    if (st && st.status === 'running') await d.store.goals.putStep({ ...st, status: 'failed', endedAt: at, updatedAt: at })
    await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'answered', from: null, to: null, detail: { text: answer === 'words' ? `${text} (about the gate: ${gate.condition})` : said('Not approved'), gateId: gate.id, gate: answer } })
  }
  await youMove(d, (await d.store.goals.get(goal.id))!, 'answer', null, at, { gateId: gate.id })
}

// --- the user's steering ----------------------------------------------------

/** Accept the plan change the lead proposed: plan.md v+1, steps reconciled (done stays done). */
async function applyPlan(d: GoalDeps, goal: Goal, plan: NonNullable<Goal['plan']>, at: number): Promise<number> {
  const version = goal.planVersion + 1
  await d.ledger.writePlan(goal.id, renderPlanMd(goal, plan, version), version)
  await d.store.goals.update(goal.id, { plan, planVersion: version, budget: plan.budget }, at)
  for (const st of reconcileSteps(goal.id, await d.store.goals.steps(goal.id), plan, at)) await d.store.goals.putStep(st)
  return version
}

/**
 * Answer what the goal waits on: a question (text), a plan change (accept or
 * turn down, with optional text), or a budget pause (a raised budget). Then
 * waiting_you → queued, and the lead wakes with the answer.
 */
export async function goalAnswerOp(d: GoalDeps, eng: GoalEngine, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  if (goal.state !== 'waiting_you') throw new Error(`nothing is waiting on you: the goal is ${goal.state.replace('_', ' ')}`)
  const at = d.now()
  const text = optStr(b.text, 'text', MAX_TEXT)
  const usd = optPositive(b.budgetUsd, 'budgetUsd', MAX_PLAN_BUDGET_USD)
  const minutes = optPositive(b.budgetMinutes, 'budgetMinutes')
  if (usd !== null || minutes !== null) await d.store.goals.update(goal.id, { budget: { usd: usd ?? goal.budget.usd, minutes: minutes ?? goal.budget.minutes } }, at)
  const open = openAsk(await d.store.goals.events(goal.id))
  const gateId = open?.kind === 'ask' && typeof open.ev.detail?.gateId === 'string' ? open.ev.detail.gateId : null
  const gate = gateId ? await d.store.goals.gate(gateId) : null
  if (gate && gate.status === 'needs_user') {
    // A gate asked about: approve, keep waiting or reject — or words alone, which close it and wake the lead.
    const answer = b.gate === undefined && text ? 'words' : (b.gate as GateAnswer)
    if (answer !== 'words' && !GATE_ANSWERS.includes(answer)) throw new Error('settle the gate: gate is approve, wait or reject')
    await answerGate(d, eng, goal, gate, answer, text, at)
    d.changed(goal.id)
    void pumpGoals(d, eng)
    return { goal: (await d.store.goals.get(goal.id))!, outcome: 'answered' }
  }
  if (open?.kind === 'plan_change') {
    if (typeof b.accept !== 'boolean') throw new Error('accept or turn down the plan change (accept: true | false)')
    let version: number | null = null
    if (b.accept) {
      const parsed = planFrom(planInputOf(open.ev.detail!.plan as NonNullable<Goal['plan']>), goal, await planOpts(d, false))
      if (!parsed.ok) throw new Error(`the proposed plan no longer validates: ${parsed.error}`)
      version = await applyPlan(d, (await d.store.goals.get(goal.id))!, parsed.plan, at)
    }
    await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'plan_change_settled', from: null, to: null, detail: { accepted: b.accept, text, version } })
  } else {
    if (!text && usd === null && minutes === null) throw new Error('say something: an answer, or a raised budget')
    await d.store.goals.addEvent({
      goalId: goal.id,
      at,
      actor: 'you',
      sessionId: null,
      kind: 'answered',
      from: null,
      to: null,
      detail: { text: text ?? `Budget raised to ${[usd !== null ? `$${usd}` : null, minutes !== null ? `${minutes} min` : null].filter(Boolean).join(' · ')}.`, question: open?.ev.detail?.question ?? null },
    })
  }
  await youMove(d, (await d.store.goals.get(goal.id))!, 'answer', null, at)
  d.changed(goal.id)
  void pumpGoals(d, eng)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'answered' }
}

/**
 * A message to the goal's lead from the goal page (decision 8). It wakes the
 * lead: now, when the goal is queued; after the current session, when it runs.
 * A goal waiting on you takes it as the answer; a result takes it as "reopen,
 * here's what's missing". A goal on a gate or paused reads it at its next wake.
 */
export async function goalMessageOp(d: GoalDeps, eng: GoalEngine, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  const text = str(b.text, 'text', MAX_TEXT)
  if (goal.state === 'waiting_you') {
    const r = await goalAnswerOp(d, eng, { goalId: goal.id, text })
    return { goal: r.goal, outcome: 'messaged' }
  }
  if (goal.state === 'draft_plan' || goal.state === 'plan_ready') throw new Error('the plan is still being drafted or reviewed: comment on it instead')
  if (goal.state === 'done' || goal.state === 'cancelled') throw new Error(`the goal is ${goal.state}`)
  const at = d.now()
  await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'user_message', from: null, to: null, detail: { to: 'lead', text } })
  if (goal.state === 'result_ready') await youMove(d, goal, 'reopen', null, at)
  d.changed(goal.id)
  void pumpGoals(d, eng)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'messaged' }
}

/** A message typed into a live worker's own session box went straight to it; the goal's history keeps a copy. */
export async function goalWorkerMessageOp(d: GoalDeps, goalId: string, sessionId: string, text: string): Promise<void> {
  await note(d, { actor: 'you', sessionId, kind: 'user_message', from: null, to: null, detail: { to: 'worker', sessionId, text: text.slice(0, MAX_TEXT) } }, goalId, d.now())
  d.changed(goalId)
}

/** The goal a session worked for, if any (a worker's box after it exited routes to its lead). */
export async function goalOfSession(d: GoalDeps, sessionId: string): Promise<Goal | null> {
  for (const g of await d.store.goals.list({ states: ['queued', 'running', 'waiting_world', 'waiting_you', 'result_ready', 'paused'] })) {
    if ((await d.store.goals.sessions(g.id)).some((r) => r.sessionId === sessionId)) return g
  }
  return null
}

/**
 * The user edits plan.md (its plan-data block) or handoff.md from the goal
 * page. A plan edit is validated like a proposal and becomes v+1 with the
 * steps reconciled; either edit is a user_edited wake, read at the next wake.
 */
export async function goalEditOp(d: GoalDeps, eng: GoalEngine, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  if (goal.state === 'draft_plan' || goal.state === 'plan_ready') throw new Error('the plan is under review: comment on it instead')
  if (goal.state === 'done' || goal.state === 'cancelled') throw new Error(`the goal is ${goal.state}`)
  const text = str(b.text, 'text', MAX_TEXT * 4)
  const at = d.now()
  let detail: Record<string, unknown>
  if (b.file === 'plan') {
    const plan = parsePlanMd(text)
    if (!plan) throw new Error('plan.md needs its plan data block (```json goal-plan) to be valid JSON')
    const parsed = planFrom(planInputOf(plan), goal, await planOpts(d, false))
    if (!parsed.ok) throw new Error(`plan rejected: ${parsed.error}`)
    if (samePlan(goal.plan, parsed.plan)) return { goal, outcome: 'unchanged' }
    detail = { file: 'plan', version: await applyPlan(d, goal, parsed.plan, at) }
  } else if (b.file === 'handoff') {
    if (!(await d.ledger.writeHandoffText(goal.id, text, 'you'))) return { goal, outcome: 'unchanged' }
    detail = { file: 'handoff' }
  } else throw new Error('file must be plan or handoff')
  await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'user_edited', from: null, to: null, detail })
  d.changed(goal.id)
  void pumpGoals(d, eng)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'edited' }
}

/** Take over: pause the goal, stop its session, note the worktree's HEAD and open it in the user's editor. */
export async function goalTakeOverOp(d: GoalDeps, eng: GoalEngine, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  if (goal.state === 'paused') return { goal, outcome: 'unchanged' }
  const head = (await eng.worktreeHead?.(goal).catch(() => null)) ?? null
  await youMove(d, goal, 'pause', 'You took over.', d.now(), { head })
  d.changed(goal.id)
  await eng.stopSessions?.(goal.id)
  await eng.openWorktree?.(goal).catch(() => {})
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'taken_over' }
}

/** Hand back: paused → queued; the lead wakes to what changed in the worktree since take over. */
export async function goalHandBackOp(d: GoalDeps, eng: GoalEngine, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  if (goal.state !== 'paused') throw new Error(`the goal isn't taken over: it is ${goal.state.replace('_', ' ')}`)
  const events = await d.store.goals.events(goal.id)
  const pausedAt = [...events].reverse().find((e) => e.kind === 'transition' && e.to === 'paused')
  const from = typeof pausedAt?.detail?.head === 'string' ? pausedAt.detail.head : null
  const to = (await eng.worktreeHead?.(goal).catch(() => null)) ?? null
  const at = d.now()
  const text = optStr(b.text, 'text', MAX_TEXT)
  await d.store.goals.addEvent({ goalId: goal.id, at, actor: 'you', sessionId: null, kind: 'user_edited', from: null, to: null, detail: { file: 'worktree', from, to, ...(text ? { text } : {}) } })
  await youMove(d, goal, 'resume', null, at)
  d.changed(goal.id)
  void pumpGoals(d, eng)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'handed_back' }
}

/** Accept the result: result_ready → done. */
export async function goalAcceptOp(d: GoalDeps, raw: unknown): Promise<WriteResult> {
  const b = obj(raw)
  const goal = await goalOrThrow(d, id(b.goalId, 'goalId'))
  if (goal.state === 'done') return { goal, outcome: 'unchanged' }
  await youMove(d, goal, 'accept', null, d.now())
  d.changed(goal.id)
  return { goal: (await d.store.goals.get(goal.id))!, outcome: 'accepted' }
}

// --- held actions across a goal's sessions ---------------------------------

/** What makes two calls the same action: the tool and its args — for Bash, the command alone (T2). */
export function goalActionKey(goalId: string, tool: string, args: Record<string, unknown>): string {
  const body = tool === 'Bash' ? String(args.command ?? '').trim() : canon(args)
  return `${goalId}\u0000${tool}\u0000${body}`
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/**
 * The actions a goal's sessions have queued, by goalActionKey — held across
 * workers and restarts, so a worker that redoes a step after a crash is told
 * "queued as #…" for a call an earlier worker already filed instead of filing
 * it again. Synchronous, because the hold that reads it is a PreToolUse veto.
 */
export class GoalHeldIndex {
  private readonly byKey = new Map<string, string>()
  find(goalId: string, tool: string, args: Record<string, unknown>): string | null {
    return this.byKey.get(goalActionKey(goalId, tool, args)) ?? null
  }
  set(goalId: string, tool: string, args: Record<string, unknown>, actionId: string): void {
    this.byKey.set(goalActionKey(goalId, tool, args), actionId)
  }
  /** a sent-back or expired action may be filed again */
  drop(actionId: string): void {
    for (const [k, v] of this.byKey) if (v === actionId) this.byKey.delete(k)
  }
}

/** Statuses after which the same call is a new action: the user asked for a change, or it lapsed. */
const REFILE_STATUSES = new Set(['sent_back', 'expired'])

/** A worker's call was held: the action joins the session's row, and the index. */
export async function goalActionHeldOp(d: GoalDeps, idx: GoalHeldIndex, h: { goalId: string; sessionId: string; actionId: string; tool: string; args: Record<string, unknown> }): Promise<void> {
  idx.set(h.goalId, h.tool, h.args, h.actionId)
  const row = (await d.store.goals.sessions(h.goalId)).find((r) => r.sessionId === h.sessionId)
  if (row && !row.actions.includes(h.actionId)) await d.store.goals.putSession({ ...row, actions: [...row.actions, h.actionId] })
}

/** Boot: rebuild the index from every live goal's sessions and the actions' original args. */
export async function loadGoalHeld(d: GoalDeps, idx: GoalHeldIndex): Promise<number> {
  let n = 0
  for (const g of await d.store.goals.list({ states: ['queued', 'running', 'waiting_world', 'waiting_you', 'result_ready', 'paused'] })) {
    const ids = [...new Set((await d.store.goals.sessions(g.id)).flatMap((r) => r.actions))]
    if (!ids.length) continue
    const history = await d.store.actions.history(ids)
    for (const aid of ids) {
      const rec = await d.store.actions.get(aid)
      if (!rec || REFILE_STATUSES.has(rec.status)) continue
      const args = history.get(aid)?.find((h) => h.event === 'queued')?.args ?? rec.queue?.args ?? rec.args
      idx.set(g.id, rec.tool, args, aid)
      n++
    }
  }
  return n
}

// ---------------------------------------------------------------------------
// HTTP: /api/goals…
//
//   GET  /api/goals?states=a,b&item=<id>   list
//   POST /api/goals                        goal_create
//   GET  /api/goals/<id>?log=<n>           the goal page
//   POST /api/goals/<id>/plan              goal_propose_plan
//   POST /api/goals/<id>/log               goal_log_append
//   POST /api/goals/<id>/handoff           goal_handoff_write
//   POST /api/goals/<id>/comment           { stepId?, text }        the user's review
//   POST /api/goals/<id>/approve           { version? }
//   POST /api/goals/<id>/send-back         { version?, comments?, text? }
// ---------------------------------------------------------------------------

export type RouteReply = { status: number; body: GoalsResponse | GoalResponse | GoalWriteResponse }

/** The reply for a /api/goals request, or null when the path isn't one of ours. */
export async function goalsRoute(d: GoalDeps, req: http.IncomingMessage, url: URL, readBody: () => Promise<unknown>, eng: GoalEngine): Promise<RouteReply | null> {
  if (url.pathname !== '/api/goals' && !url.pathname.startsWith('/api/goals/')) return null
  const parts = url.pathname.slice('/api/goals'.length).split('/').filter(Boolean).map(decodeURIComponent)
  const fail = (err: unknown, status = 400): RouteReply => ({ status, body: { ok: false, error: err instanceof Error ? err.message : String(err) } })
  const write = async (op: (d: GoalDeps, raw: unknown) => Promise<WriteResult>, extra: Raw = {}): Promise<RouteReply> => {
    try {
      const r = await op(d, { ...obj(await readBody()), ...extra })
      return { status: 200, body: { ok: true, goal: r.goal, outcome: r.outcome } }
    } catch (err) {
      return fail(err)
    }
  }
  try {
    if (parts.length === 0 && req.method === 'GET') {
      const states = url.searchParams.get('states')?.split(',').filter(Boolean) ?? []
      const item = url.searchParams.get('item')
      return { status: 200, body: { ok: true, ...(await goalListOp(d, { states, ...(item ? { sourceItemId: item } : {}) })) } }
    }
    if (parts.length === 0 && req.method === 'POST') return write(goalCreateOp)
    if (parts.length === 1 && req.method === 'GET') {
      const n = Number(url.searchParams.get('log'))
      return { status: 200, body: { ok: true, ...(await goalGetOp(d, parts[0]!, Number.isInteger(n) && n > 0 ? Math.min(n, 500) : PAGE_LOG_ENTRIES)) } }
    }
    if (parts.length === 2 && req.method === 'POST') {
      const op = {
        plan: goalProposePlanOp,
        log: goalLogAppendOp,
        handoff: goalHandoffWriteOp,
        comment: goalCommentOp,
        approve: goalApproveOp,
        'send-back': goalSendBackOp,
        answer: (d: GoalDeps, raw: unknown) => goalAnswerOp(d, eng, raw),
        message: (d: GoalDeps, raw: unknown) => goalMessageOp(d, eng, raw),
        edit: (d: GoalDeps, raw: unknown) => goalEditOp(d, eng, raw),
        'take-over': (d: GoalDeps, raw: unknown) => goalTakeOverOp(d, eng, raw),
        'hand-back': (d: GoalDeps, raw: unknown) => goalHandBackOp(d, eng, raw),
        accept: goalAcceptOp,
      }[parts[1]!]
      if (op) return write(op, { goalId: parts[0] })
    }
  } catch (err) {
    return fail(err, /^no goal /.test(err instanceof Error ? err.message : '') ? 404 : 400)
  }
  return fail(new Error('no such goals route'), 404)
}

/** goal_get as an agent reads it: the lead's share of the log, not the page's. */
export const goalGetForAgent = (d: GoalDeps, goalId: string) => goalGetOp(d, goalId, LEAD_LOG_ENTRIES)

/** A reviewer's goal_get (M6, reviewer independence): the goal, its plan and steps — no events, handoff or log. */
export async function goalGetForReviewer(d: GoalDeps, goalId: string) {
  const goal = await goalOrThrow(d, goalId)
  return { goal, steps: await d.store.goals.steps(goal.id), note: 'You review independently: the change is in the worktree (git diff against the base); the builders\' handoff and log are not yours to read.' }
}

// ---------------------------------------------------------------------------
// The in-process triage MCP's goal tools (makeTriageMcp) — the zod mirror of
// GOAL_TOOLS (core/goals/tools.ts), which the external transports serve.
// Objects are loose so planFrom sees, and rejects, a key it doesn't know.
// ---------------------------------------------------------------------------

const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
const describe = (name: string) => GOAL_TOOLS.find((t) => t.name === name)!.description

const roleZ = z.enum(STEP_ROLES as [StepRole, ...StepRole[]])
const outcomeZ = z.enum(['done', 'failed', 'blocked'])
const gateZ = z.looseObject({
  evaluator: z.enum(['ai', 'user', 'watcher']).describe('ai = a read-only checker judges it; user = an approval in the Inbox; watcher = the PR watcher (use the "shepherd-pr" block)'),
  condition: z.string().describe('what must hold, checkable from outside: "LIN-2214 is in QA"'),
  checkEvery: z.string().optional().describe('a fixed interval like "15m"; omit for the default back-off'),
  deadline: z.string().optional().describe('like "4h"; past it the gate becomes an approval. Default 24h'),
  confirmations: z.number().optional().describe('"met" verdicts in a row needed; 2 for merge or anything touching production. Default 1'),
  connectors: z.array(z.string()).optional().describe('MCP servers whose read tools the checker may use'),
})
const planZ = z.looseObject({
  summary: z.string().describe('what you found and what you chose, in a paragraph'),
  doneWhen: z.string(),
  horizon: z.enum(GOAL_HORIZONS as [Goal['horizon'], ...Goal['horizon'][]]).optional(),
  steps: z
    .array(
      z.looseObject({
        id: z.string().describe('short and unique in the plan, e.g. "s1"'),
        title: z.string(),
        type: z.enum(['agent', 'gate', 'block']),
        role: roleZ.optional().describe('who does an agent step'),
        dependsOn: z.array(z.string()).optional().describe('step ids that must be done first'),
        doneWhen: z.string().describe('what the engine checks before it counts the step done'),
        gate: gateZ.optional(),
        block: z.string().optional().describe('a workflow block name, for a block step, e.g. "shepherd-pr"'),
      }),
    )
    .min(1),
  team: z.array(z.looseObject({ role: roleZ, count: z.number(), why: z.string(), model: z.string().optional() })).optional(),
  budgetUsd: z.number().optional(),
  budgetMinutes: z.number().optional(),
  mayDo: z.array(z.string()).optional().describe('what Junior may do without asking, one per line'),
  models: z
    .looseObject({ lead: z.string().optional(), worker: z.string().optional(), gate: z.string().optional() })
    .optional()
    .describe('overrides of the default models (lead opus, workers sonnet, gate haiku)'),
})

const wrote = (r: WriteResult) => okResult(`ok: ${r.outcome} · goal ${r.goal.id} · ${r.goal.state}`)

export function goalMcpTools(d: GoalDeps) {
  const run = <A>(fn: (a: A) => Promise<ReturnType<typeof okResult>>) => async (a: A) => {
    try {
      return await fn(a)
    } catch (err) {
      return errResult(`rejected: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return [
    tool(
      'goal_create',
      describe('goal_create'),
      {
        title: z.string(),
        doneWhen: z.string().describe('what must be true for the goal to be done, checkable'),
        horizon: z.enum(GOAL_HORIZONS as [Goal['horizon'], ...Goal['horizon'][]]).optional().describe('default until_done'),
        sourceItemId: z.string().optional().describe('the work item it came from'),
        key: z.string().optional().describe('a caller-stable id to dedupe on; defaults to sourceItemId'),
        projectId: z.string().optional().describe('the project it works in; default = the default project'),
        budgetUsd: z.number().optional(),
        budgetMinutes: z.number().optional(),
      },
      run(async (a) => wrote(await goalCreateOp(d, a))),
    ),
    tool(
      'goal_get',
      describe('goal_get'),
      { id: z.string() },
      run(async (a: { id: string }) => okResult(JSON.stringify(await goalGetForAgent(d, a.id), null, 2))),
    ),
    tool(
      'goal_list',
      describe('goal_list'),
      { states: z.array(z.enum(GOAL_STATES as [GoalState, ...GoalState[]])).optional(), sourceItemId: z.string().optional() },
      run(async (a) => okResult(JSON.stringify(await goalListOp(d, a), null, 2))),
    ),
    tool(
      'goal_propose_plan',
      describe('goal_propose_plan'),
      { goalId: z.string(), plan: planZ, sessionId: z.string().optional().describe('your triage session id') },
      run(async (a) => wrote(await goalProposePlanOp(d, a))),
    ),
    tool(
      'goal_log_append',
      describe('goal_log_append'),
      {
        goalId: z.string(),
        sessionId: z.string(),
        stepId: z.string().optional(),
        role: roleZ,
        outcome: outcomeZ.optional(),
        text: z.string().describe('what you did and what came of it, markdown'),
        commits: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        commands: z.array(z.object({ cmd: z.string(), ok: z.boolean() })).optional(),
      },
      run(async (a) => wrote(await goalLogAppendOp(d, a))),
    ),
    tool(
      'goal_handoff_write',
      describe('goal_handoff_write'),
      { goalId: z.string(), sessionId: z.string(), done: z.string(), next: z.string(), watchOut: z.string().optional() },
      run(async (a) => wrote(await goalHandoffWriteOp(d, a))),
    ),
  ]
}

const describeEngine = (name: string) => ENGINE_TOOLS.find((t) => t.name === name)!.description

export type GoalSessionTag = { goalId: string; sessionId: string; role: StepRole; stepId: string | null }

/**
 * The `goal` MCP server one goal session gets, bound to its goal and session
 * so it can't act on another: the lead's engine tools plus the ledger tools,
 * or a worker's ledger tools. Served per spawn (index.ts extrasFor).
 */
export function goalSessionMcpTools(d: GoalDeps, tag: GoalSessionTag) {
  const run = <A>(fn: (a: A) => Promise<string>) => async (a: A) => {
    try {
      return okResult(await fn(a))
    } catch (err) {
      return errResult(`rejected: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const call = { goalId: tag.goalId, sessionId: tag.sessionId }
  const ledger = [
    tool('goal_get', describe('goal_get'), {}, run(async () => JSON.stringify(tag.role === 'reviewer' ? await goalGetForReviewer(d, tag.goalId) : await goalGetForAgent(d, tag.goalId), null, 2))),
    tool(
      'goal_log_append',
      describe('goal_log_append'),
      {
        outcome: outcomeZ.optional().describe(tag.role === 'lead' ? 'omit for a wake that settled no step' : 'how your step ended: the engine counts it'),
        text: z.string().describe('what you did and what came of it, markdown'),
        commits: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        commands: z.array(z.object({ cmd: z.string(), ok: z.boolean() })).optional(),
      },
      run(async (a) => {
        const r = await goalLogAppendOp(d, { ...a, ...call, role: tag.role, ...(tag.stepId ? { stepId: tag.stepId } : {}) })
        return `ok: ${r.outcome}`
      }),
    ),
    tool(
      'goal_handoff_write',
      describe('goal_handoff_write'),
      { done: z.string(), next: z.string(), watchOut: z.string().optional() },
      run(async (a) => `ok: ${(await goalHandoffWriteOp(d, { ...a, ...call })).outcome}`),
    ),
  ]
  if (tag.role !== 'lead') return ledger
  return [
    ...ledger,
    tool(
      'dispatch_worker',
      describeEngine('dispatch_worker'),
      { stepId: z.string(), brief: z.string().describe('what this worker needs beyond the plan and the handoff'), model: z.string().optional() },
      run((a) => goalDispatchWorkerOp(d, call, a)),
    ),
    tool(
      'arm_gate',
      describeEngine('arm_gate'),
      {
        stepId: z.string(),
        refs: z.array(z.string()).optional().describe('ids the checker needs: a PR number, a ticket key'),
        condition: z.string().optional(),
        evaluator: z.enum(['ai', 'user']).optional(),
        checkEvery: z.string().optional(),
        deadline: z.string().optional(),
        confirmations: z.number().optional(),
        connectors: z.array(z.string()).optional(),
        recommended: z.string().optional().describe('a user gate: your recommended answer (required for one)'),
        evidence: z.string().optional().describe('a user gate: what the user should look at to decide'),
      },
      run((a) => goalArmGateOp(d, call, a)),
    ),
    tool('propose_plan_change', describeEngine('propose_plan_change'), { why: z.string(), plan: planZ }, run((a) => goalProposePlanChangeOp(d, call, a))),
    tool(
      'ask_user',
      describeEngine('ask_user'),
      {
        question: z.string(),
        recommended: z.string().describe('your recommended answer'),
        evidence: z.string().optional().describe('what you found that makes this a question'),
        options: z.array(z.string()).optional(),
      },
      run((a) => goalAskUserOp(d, call, a)),
    ),
    tool(
      'report_step_result',
      describeEngine('report_step_result'),
      { stepId: z.string(), outcome: outcomeZ, summary: z.string(), evidence: z.string().optional() },
      run((a) => goalReportStepResultOp(d, call, a)),
    ),
  ]
}
