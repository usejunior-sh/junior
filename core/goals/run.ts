/**
 * The run loop: what a goal does between plan approval and its result.
 * Pure, no I/O, no clock, so every decision is unit-tested
 * (test/goal-run.test.ts); server/goals.ts carries each one out.
 *
 * A running goal runs its lead alone, or up to `workerCap` workers at once
 * (its team section, capped by the user's max team size). The scheduler
 * gives a queued goal slots and `nextWorkers` says who fills them: workers for
 * steps the lead dispatched, in plan order, else the lead. Workers for more
 * dispatched steps join a running goal as slots free up; the lead never runs
 * beside them. When the last session ends, `afterSession` says where the goal goes:
 *
 *   an ask or a plan change is open       → ask_you      (waits on the user)
 *   every step is done                    → result       (no lead wake needed)
 *   a dispatched worker hasn't started    → yield        (back to the queue)
 *   a wake event nobody has read          → yield        (the lead wakes for it)
 *   a gate is armed                       → wait_world
 *   none of these                         → ask_you      (the lead decided nothing)
 *
 * Wake events are the ones the lead must read: a step ended, a gate resolved,
 * the user wrote, answered or edited. The lead marks the ones it was shown
 * handled when it ends; anything newer wakes it again.
 */
import { shortActionId } from '../actions/view.js'
import { MAX_FIX_ATTEMPTS, type Gate, type Goal, type GoalEvent, type GoalEventKind, type GoalPlan, type GoalStepState, type PlanStep, type SessionOutcome, type StepRole, type StepStatus } from './types.js'
import type { GoalSessionRecord } from '../store/types.js'
import { teamSize } from './plan.js'

/** Events the lead wakes for. A user message to a live worker went to the worker and isn't one. */
export const WAKE_EVENTS: ReadonlySet<GoalEventKind> = new Set([
  'step_finished',
  'step_failed',
  'gate_resolved',
  'watcher',
  'user_message',
  'answered',
  'plan_change_settled',
  'user_edited',
])

export const isWake = (e: GoalEvent): boolean => WAKE_EVENTS.has(e.kind) && !(e.kind === 'user_message' && e.detail?.to === 'worker')

/** The wake events not yet read by a lead, oldest first. */
export const unreadWakes = (events: readonly GoalEvent[]): GoalEvent[] => events.filter((e) => e.handledAt === null && isWake(e))

/** Steps that count as finished for the goal's done-when. */
const FINISHED: ReadonlySet<StepStatus> = new Set(['done', 'skipped'])

/** Default parallel goals (config key `goals.maxParallel`): one session each. */
export const DEFAULT_MAX_PARALLEL = 2
/** A goal's session past this is stopped and recorded as failed. */
export const GOAL_SESSION_TIMEOUT_MS = 45 * 60_000
/** Share of a budget at which the goal page warns, once. */
export const BUDGET_WARN_AT = 0.8
/** Claude Code caps a /goal condition. */
export const GOAL_CONDITION_MAX = 500

export type WorkerSpec = { role: StepRole; stepId: string; brief: string; model: string | null; attempt: number }
export type NextSession = { role: 'lead' } | ({ kind: 'worker' } & WorkerSpec)

/** A step the lead dispatched whose worker hasn't started: running, no session. */
export const isDispatched = (s: GoalStepState) => s.status === 'running' && s.sessionId === null

/** A dispatched agent step waits for its worker. An armed gate step is running with no session too, but no worker comes for it. */
export const workerDue = (plan: GoalPlan | null, steps: readonly GoalStepState[]): boolean =>
  steps.some((s) => isDispatched(s) && plan?.steps.find((p) => p.id === s.stepId)?.type === 'agent')

/** The latest dispatch of `stepId`: its brief and model. */
export function dispatchOf(events: readonly GoalEvent[], stepId: string): { brief: string; model: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind === 'step_dispatched' && e.detail?.stepId === stepId) {
      return { brief: typeof e.detail.brief === 'string' ? e.detail.brief : '', model: typeof e.detail.model === 'string' ? e.detail.model : null }
    }
  }
  return null
}

/** The user's max team size when they set none (Settings → Teams, `goals.maxTeam`). */
export const DEFAULT_MAX_TEAM = 3

/** Workers a goal runs at once: its team's seats besides the lead, capped by the user's max team size. No team section: one at a time. */
export function workerCap(plan: Pick<GoalPlan, 'team'> | null, maxTeam: number): number {
  return Math.max(1, Math.min(teamSize(plan?.team ?? []) || 1, maxTeam))
}

/** Dispatched agent steps whose worker hasn't started, in plan order, up to `n`. */
export function nextWorkers(goal: Pick<Goal, 'plan'>, steps: readonly GoalStepState[], events: readonly GoalEvent[], n: number): WorkerSpec[] {
  const out: WorkerSpec[] = []
  for (const ps of goal.plan?.steps ?? []) {
    if (out.length >= n) break
    const st = steps.find((s) => s.stepId === ps.id)
    if (!st || !isDispatched(st) || ps.type !== 'agent' || !ps.role || ps.role === 'lead') continue
    const d = dispatchOf(events, ps.id)
    out.push({ role: ps.role, stepId: ps.id, brief: d?.brief ?? '', model: d?.model ?? null, attempt: st.attempts })
  }
  return out
}

/** One session working a running goal. */
export type Working = { sessionId: string; role: StepRole; stepId: string | null }

/**
 * Who is working a running goal now: the workers holding their steps (a
 * running step with a session), else the lead, when it started last. A
 * session row's endedAt can't say: a worker's log with an outcome closes it
 * before the session exits. Settling a session lets go of its step, so a
 * session counts once.
 */
export function workingSessions(steps: readonly GoalStepState[], events: readonly GoalEvent[]): Working[] {
  const started = new Map<string, Working>()
  let last: Working | null = null
  for (const e of events) {
    if (e.kind !== 'step_started' || typeof e.detail?.sessionId !== 'string') continue
    last = { sessionId: e.detail.sessionId, role: e.detail.role as StepRole, stepId: typeof e.detail.stepId === 'string' ? e.detail.stepId : null }
    started.set(last.sessionId, last)
  }
  const workers = steps
    .filter((s) => s.status === 'running' && s.sessionId)
    .map((s) => started.get(s.sessionId!) ?? { sessionId: s.sessionId!, role: 'builder' as StepRole, stepId: s.stepId })
  if (workers.length) return workers
  return last?.role === 'lead' ? [last] : []
}

/** Who runs in the slot the scheduler just gave `goal`: a dispatched step's worker, in plan order, else the lead. */
export function nextSession(goal: Pick<Goal, 'plan'>, steps: readonly GoalStepState[], events: readonly GoalEvent[]): NextSession {
  const w = nextWorkers(goal, steps, events, 1)[0]
  return w ? { kind: 'worker', ...w } : { role: 'lead' }
}

export type OpenAsk = { kind: 'ask' | 'plan_change'; ev: GoalEvent }

/** The question or plan change the user hasn't answered yet, if any. */
export function openAsk(events: readonly GoalEvent[]): OpenAsk | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind === 'answered' || e.kind === 'plan_change_settled') return null
    if (e.kind === 'asked_you') return { kind: 'ask', ev: e }
    if (e.kind === 'plan_change_proposed') return { kind: 'plan_change', ev: e }
  }
  return null
}

export function allDone(plan: GoalPlan | null, steps: readonly GoalStepState[]): boolean {
  if (!plan?.steps.length) return false
  return plan.steps.every((p) => FINISHED.has(steps.find((s) => s.stepId === p.id)?.status ?? 'pending'))
}

export type Move = { trigger: 'result' | 'yield' | 'wait_world' | 'ask_you'; reason: string | null }

/** Where a running goal goes when its session ends. */
export function afterSession(goal: Pick<Goal, 'plan'>, steps: readonly GoalStepState[], gates: readonly Gate[], events: readonly GoalEvent[]): Move {
  const ask = openAsk(events)
  if (ask) {
    const text = ask.kind === 'ask' ? String(ask.ev.detail?.question ?? 'Junior has a question') : `Plan change: ${String(ask.ev.detail?.why ?? 'see the proposal')}`
    return { trigger: 'ask_you', reason: text.slice(0, 500) }
  }
  if (allDone(goal.plan, steps)) return { trigger: 'result', reason: null }
  if (workerDue(goal.plan, steps)) return { trigger: 'yield', reason: null }
  if (unreadWakes(events).length) return { trigger: 'yield', reason: null }
  const gate = gates.find((g) => g.status === 'open')
  if (gate) return { trigger: 'wait_world', reason: `Waiting for: ${gate.condition}`.slice(0, 500) }
  return { trigger: 'ask_you', reason: 'Junior stopped without a next step. Tell it what to do next.' }
}

/** Pending steps whose dependencies are all finished become runnable. Returns only the rows that changed. */
export function unlock(plan: GoalPlan, steps: readonly GoalStepState[], at: number): GoalStepState[] {
  const status = (id: string) => steps.find((s) => s.stepId === id)?.status ?? 'pending'
  const out: GoalStepState[] = []
  for (const p of plan.steps) {
    const st = steps.find((s) => s.stepId === p.id)
    if (!st || st.status !== 'pending') continue
    if (p.dependsOn.every((d) => FINISHED.has(status(d)))) out.push({ ...st, status: 'runnable', updatedAt: at })
  }
  return out
}

/** How a worker's step ended, from what it logged and how its session ended. A session that logged nothing failed. */
export function workerOutcome(row: Pick<GoalSessionRecord, 'outcome'> | undefined, error: string | null): SessionOutcome {
  if (error) return row?.outcome === 'blocked' ? 'blocked' : 'failed'
  return row?.outcome ?? 'failed'
}

const stepOf = (plan: GoalPlan | null, id: string): PlanStep | undefined => plan?.steps.find((s) => s.id === id)

/** Why `stepId` can't be dispatched now, or null when it can. */
export function dispatchRefusal(plan: GoalPlan | null, steps: readonly GoalStepState[], stepId: string): string | null {
  const p = stepOf(plan, stepId)
  if (!p) return `step "${stepId}" isn't in the plan`
  if (p.type !== 'agent') return `step ${stepId} is a ${p.type} step: ${p.type === 'gate' ? 'arm it with arm_gate' : 'blocks are expanded at approval'}`
  if (!p.role || p.role === 'lead') return `step ${stepId} is yours to do: do it, then report_step_result with evidence`
  const st = steps.find((s) => s.stepId === stepId)
  if (!st) return `step ${stepId} has no state yet`
  if (st.status === 'runnable') return null
  if (st.status === 'failed') return st.attempts >= MAX_FIX_ATTEMPTS ? `step ${stepId} failed ${st.attempts} times: ask the user (ask_user) instead of trying again` : null
  if (st.status === 'pending') return `step ${stepId} waits on ${p.dependsOn.join(', ')}`
  if (st.status === 'running') return `step ${stepId} is already dispatched`
  return `step ${stepId} is ${st.status}`
}

/** Why the gate on `stepId` can't be armed now, or null. */
export function armRefusal(plan: GoalPlan | null, steps: readonly GoalStepState[], gates: readonly Gate[], stepId: string): string | null {
  const p = stepOf(plan, stepId)
  if (!p) return `step "${stepId}" isn't in the plan`
  if (p.type !== 'gate') return `step ${stepId} isn't a gate step`
  const st = steps.find((s) => s.stepId === stepId)
  if (!st || st.status === 'pending') return `step ${stepId} waits on ${p.dependsOn.join(', ')}`
  if (gates.some((g) => g.stepId === stepId && (g.status === 'open' || g.status === 'needs_user'))) return `the gate on ${stepId} is already armed`
  if (st.status !== 'runnable' && st.status !== 'failed') return `step ${stepId} is ${st.status}`
  return null
}

/**
 * What a report_step_result does to the step, or why it's refused. A report is
 * a claim: "done" counts only for a lead's own step (with evidence), or for
 * a worker's step whose worker logged it done or that the user worked by hand
 * since its last dispatch. Gates resolve through the gate, never a report.
 */
export function reportResult(
  plan: GoalPlan | null,
  steps: readonly GoalStepState[],
  sessions: readonly GoalSessionRecord[],
  events: readonly GoalEvent[],
  r: { stepId: string; outcome: SessionOutcome; evidence?: string | null },
): { ok: true; status: StepStatus } | { ok: false; error: string } {
  const p = stepOf(plan, r.stepId)
  if (!p) return { ok: false, error: `step "${r.stepId}" isn't in the plan` }
  if (p.type === 'gate') return { ok: false, error: `step ${r.stepId} is a gate: it resolves when its condition holds, not by report` }
  const st = steps.find((s) => s.stepId === r.stepId)
  if (!st || st.status === 'pending') return { ok: false, error: `step ${r.stepId} hasn't started: it waits on ${p.dependsOn.join(', ')}` }
  if (FINISHED.has(st.status)) return { ok: false, error: `step ${r.stepId} is already ${st.status}` }
  if (r.outcome !== 'done') return { ok: true, status: r.outcome === 'blocked' ? 'blocked' : 'failed' }
  if (!r.evidence?.trim()) return { ok: false, error: 'a step reported done needs evidence: the check you ran, the commit, the status you read' }
  if (p.role === 'lead') return { ok: true, status: 'done' }
  if (sessions.some((s) => s.stepId === r.stepId && s.role !== 'lead' && s.outcome === 'done')) return { ok: true, status: 'done' }
  const lastDispatch = [...events].reverse().find((e) => e.kind === 'step_dispatched' && e.detail?.stepId === r.stepId)?.seq ?? 0
  if (events.some((e) => e.kind === 'user_edited' && e.detail?.file === 'worktree' && e.seq > lastDispatch)) return { ok: true, status: 'done' }
  return { ok: false, error: `no worker logged step ${r.stepId} done: dispatch_worker it, or ask the user` }
}

/**
 * The step rows after an accepted plan change: a step the new plan keeps keeps
 * its state (done stays done); a dropped step is skipped; a new one starts
 * pending, or runnable when its dependencies are finished.
 */
export function reconcileSteps(goalId: string, old: readonly GoalStepState[], plan: GoalPlan, at: number): GoalStepState[] {
  const out: GoalStepState[] = []
  const kept = new Set(plan.steps.map((s) => s.id))
  for (const s of old) if (!kept.has(s.stepId) && s.status !== 'skipped') out.push({ ...s, status: 'skipped', updatedAt: at })
  const rows = plan.steps.map(
    (p) =>
      old.find((s) => s.stepId === p.id) ?? { goalId, stepId: p.id, status: 'pending' as StepStatus, attempts: 0, sessionId: null, startedAt: null, endedAt: null, updatedAt: at },
  )
  const fresh = rows.filter((r) => !old.some((s) => s.stepId === r.stepId))
  const unlocked = unlock(plan, rows, at)
  for (const r of rows) {
    const u = unlocked.find((x) => x.stepId === r.stepId)
    if (u) out.push(u)
    else if (fresh.includes(r)) out.push(r)
  }
  return out
}

/** A GoalPlan back into what planFrom takes: the budget flattened, empty fields left out. */
export function planInputOf(plan: GoalPlan): Record<string, unknown> {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined))
  return clean({
    summary: plan.summary,
    doneWhen: plan.doneWhen,
    horizon: plan.horizon,
    steps: plan.steps.map((s) => clean({ ...s, gate: s.gate ? clean({ ...s.gate }) : null })),
    team: plan.team.map((t) => clean({ ...t })),
    budgetUsd: plan.budget?.usd ?? null,
    budgetMinutes: plan.budget?.minutes ?? null,
    mayDo: plan.mayDo,
    models: plan.models,
  })
}

/** Which queued goals start now: highest priority first, then the oldest, up to the free slots. */
export function pickGoals<G extends Pick<Goal, 'id' | 'priority' | 'createdAt'>>(queued: readonly G[], running: number, cap: number): G[] {
  const free = Math.max(0, cap - running)
  return [...queued].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt).slice(0, free)
}

export type BudgetCheck = { kind: 'ok' } | { kind: 'warn'; text: string } | { kind: 'stop'; text: string }

export const minutesUsed = (sessions: readonly Pick<GoalSessionRecord, 'startedAt' | 'endedAt'>[], now: number) =>
  sessions.reduce((n, s) => n + Math.max(0, (s.endedAt ?? now) - s.startedAt), 0) / 60_000

/** Before a start: over a cap stops the goal for the user; past BUDGET_WARN_AT of one warns once (`warned`). */
export function budgetCheck(goal: Pick<Goal, 'budget' | 'spentUsd'>, minutes: number, warned: boolean): BudgetCheck {
  const { usd, minutes: cap } = goal.budget
  if (usd !== null && goal.spentUsd >= usd) return { kind: 'stop', text: `Spent $${goal.spentUsd.toFixed(2)} of the $${usd} budget. Raise it to go on.` }
  if (cap !== null && minutes >= cap) return { kind: 'stop', text: `Used ${Math.round(minutes)} of ${cap} minutes. Raise the time budget to go on.` }
  if (warned) return { kind: 'ok' }
  if (usd !== null && goal.spentUsd >= usd * BUDGET_WARN_AT) return { kind: 'warn', text: `Spent $${goal.spentUsd.toFixed(2)} of the $${usd} budget.` }
  if (cap !== null && minutes >= cap * BUDGET_WARN_AT) return { kind: 'warn', text: `Used ${Math.round(minutes)} of ${cap} minutes.` }
  return { kind: 'ok' }
}

/** The lead's contract for a run wake, in its system prompt. Its tools are the `goal` server's. */
export const LEAD_RUN_APPEND = `
You are the LEAD of a junior goal whose plan the user approved. You are woken headless to decide the next move;
nobody is watching and nobody answers text, so never ask in a reply. You don't do the steps' work yourself: you
decide through the goal tools, then end your turn, and the engine carries the decision out.
- dispatch_worker(stepId, brief): a worker does one runnable step in the goal's worktree and exits. Dispatch every
  runnable step you want done next: independent ones run side by side, up to the plan's team size, and a builder
  beside others works on its own branch, merged into the goal's when its step is done (a conflict fails the step).
  You wake again when the last of them ends.
- arm_gate(stepId): park the goal on a gate step's condition; you wake when it resolves. On a PR watcher gate
  (the shepherd-pr step), put the PR in refs ("owner/repo#12" or its URL): the watcher fixes CI, review threads
  and conflicts with steps of its own (pr-…), and the merge goes to the user. Leave those steps to it.
- report_step_result: for a step the plan gives to you (role lead), or one a worker or the user finished —
  always with evidence. A report is a claim the engine checks, not proof.
- ask_user: only for something outside the plan, always with your recommended answer. The goal waits.
- propose_plan_change: a new step, a bigger budget, a different approach. The goal waits on the user.
- goal_handoff_write before you end: what's done, what's next, what to watch out for.
Read anything; change nothing yourself: no file edits, no pushes, no comments or messages. When every step is
done the engine finishes the goal itself.`

/** One worker's contract: its role, its step, what it may do. */
export function workerAppend(role: StepRole, writes: boolean, rolePrompt: string | null): string {
  return [
    '',
    `You are a ${role.toUpperCase()} on a junior goal, running headless in the goal's worktree to do ONE step of an`,
    'approved plan. Nobody is watching and nobody answers questions: decide, and say what you assumed in your log.',
    writes
      ? 'You may change files in this worktree and commit locally. Anything outbound (a push, a PR, a comment, a message) is held for the user\'s approval: you are told "queued as #…"; treat that as done and carry on.'
      : 'You are read-only: do not edit or create files. Anything outbound is held for the user\'s approval.',
    'Before you end: goal_log_append once, with outcome done, failed or blocked and what you did; then',
    'goal_handoff_write for whoever wakes next. A step counts as done only when your log says so and its done-when holds.',
    ...(rolePrompt?.trim() ? ['', 'How this role works:', rolePrompt.trim()] : []),
  ].join('\n')
}

type LedgerText = { plan: string; handoff: string; log: string }

const section = (title: string, body: string, empty: string) => [`## ${title}`, '', body.trim() || empty, '']

function stepTable(plan: GoalPlan | null, steps: readonly GoalStepState[]): string {
  return (plan?.steps ?? [])
    .map((p) => {
      const st = steps.find((s) => s.stepId === p.id)
      const who = p.type === 'agent' ? p.role : p.type
      return `- ${p.id} · ${p.title} · ${who} · ${st?.status ?? 'pending'}${st?.attempts ? ` · ${st.attempts} tries` : ''}${p.dependsOn.length ? ` · after ${p.dependsOn.join(', ')}` : ''}\n  done when: ${p.doneWhen}`
    })
    .join('\n')
}

function wakeLine(e: GoalEvent): string {
  const d = e.detail ?? {}
  switch (e.kind) {
    case 'step_finished':
      return `- step ${String(d.stepId)} finished: ${String(d.summary ?? 'done')}`
    case 'step_failed':
      return `- step ${String(d.stepId)} ${String(d.outcome ?? 'failed')}: ${String(d.summary ?? d.error ?? 'no log')}`
    case 'user_message':
      return `- the user wrote: ${String(d.text ?? '')}`
    case 'answered':
      return `- the user answered: ${String(d.text ?? '')}`
    case 'plan_change_settled':
      return `- the user ${d.accepted ? 'accepted' : 'turned down'} your plan change${d.text ? `: ${String(d.text)}` : ''}`
    case 'user_edited':
      return d.file === 'worktree'
        ? `- the user took over and handed back the worktree (${String(d.from ?? '?')} → ${String(d.to ?? '?')}): read what changed`
        : `- the user edited ${String(d.file)}.md`
    default:
      return `- ${e.kind.replace(/_/g, ' ')}: ${JSON.stringify(d)}`
  }
}

/** The lead's first message for a run wake: where the goal stands and what woke it. */
export function leadRunPrompt(goal: Pick<Goal, 'id' | 'title' | 'doneWhen' | 'plan' | 'planVersion' | 'spentUsd' | 'budget'>, steps: readonly GoalStepState[], files: LedgerText, wakes: readonly GoalEvent[]): string {
  return [
    `Goal ${goal.id}: ${goal.title}`,
    `Done when: ${goal.doneWhen}`,
    `Plan v${goal.planVersion} · spent $${goal.spentUsd.toFixed(2)}${goal.budget.usd !== null ? ` of $${goal.budget.usd}` : ''}`,
    '',
    '## Steps',
    '',
    stepTable(goal.plan, steps),
    '',
    ...section('What woke you', wakes.map(wakeLine).join('\n'), 'The plan was just approved, or you are picking up where the last session stopped.'),
    ...section('Handoff', files.handoff, 'No handoff yet.'),
    ...section('Latest log', files.log, 'No log entries yet.'),
    'Decide the next move with the goal tools, write the handoff, then end your turn.',
  ].join('\n')
}

/** A queued action a worker of the goal already filed, so a new worker doesn't file it again. */
export type HeldAction = { id: string; summary: string; status: string }

/**
 * What a reviewer reads instead of the ledger (reviewer independence):
 * the plan's steps and the change itself, never the builders' handoff, log
 * or transcript. It judges the diff against the done-when, not the story.
 */
export type ReviewView = { plan: GoalPlan | null; steps: readonly GoalStepState[]; diff: string }

/** The diff a reviewer is shown, capped so its prompt stays a prompt. */
export const REVIEW_DIFF_MAX = 60_000

/** The worker's context (system prompt) and its first message: `/goal` with the step's done-when. */
export function workerPrompt(
  goal: Pick<Goal, 'id' | 'title' | 'doneWhen'>,
  step: PlanStep,
  spec: Pick<WorkerSpec, 'brief' | 'attempt'>,
  files: Pick<LedgerText, 'handoff' | 'log'> | ReviewView,
  held: readonly HeldAction[],
): { context: string; first: string } {
  const review = 'diff' in files
  const diff = review && files.diff.length > REVIEW_DIFF_MAX ? `${files.diff.slice(0, REVIEW_DIFF_MAX)}\n… (cut at ${REVIEW_DIFF_MAX} characters: read the rest with git in the worktree)` : review ? files.diff : ''
  const context = [
    '',
    `## The goal`,
    `Goal ${goal.id}: ${goal.title}`,
    `Done when (the whole goal): ${goal.doneWhen}`,
    '',
    `## Your step: ${step.id} · ${step.title}`,
    `Done when: ${step.doneWhen}`,
    spec.attempt > 1 ? `This is try ${spec.attempt}: an earlier session on this step didn't finish. ${review ? 'Review the change as it stands now.' : 'Start from the handoff, not from scratch.'}` : '',
    '',
    ...section('Brief from the lead', spec.brief, 'No brief beyond the plan.'),
    ...(review
      ? [
          'You review independently: you get the plan, the brief and the change, never the builders\' handoff, log or reasoning.',
          'Judge the change against the done-when; do not go looking for the goal\'s ledger or other sessions\' transcripts.',
          '',
          ...section('The plan', stepTable(files.plan, files.steps), 'No steps.'),
          ...section('The change (the goal branch against its base)', diff ? `\`\`\`diff\n${diff}\n\`\`\`` : '', 'No change yet: the branch has no commits past its base.'),
        ]
      : [...section('Handoff', files.handoff, 'No handoff yet.'), ...section('Latest log', files.log, 'No log entries yet.')]),
    ...(held.length
      ? ['## Already queued for approval — do NOT file these again', '', ...held.map((a) => `- #${shortActionId(a.id)} ${a.summary} (${a.status.replace(/_/g, ' ')})`), '']
      : []),
  ]
    .filter((l) => l !== '')
    .join('\n')
  const tail = ', and you have called goal_log_append with the outcome and goal_handoff_write'
  const head = `Step ${step.id} of goal ${goal.id} is done: `
  const room = GOAL_CONDITION_MAX - head.length - tail.length - '/goal '.length
  const when = step.doneWhen.length > room ? `${step.doneWhen.slice(0, Math.max(0, room - 1))}…` : step.doneWhen
  return { context, first: `/goal ${head}${when}${tail}` }
}

/** Role → the workspace agent file whose body is that role's prompt (mapping note, "Worker session"). */
export const ROLE_AGENT: Record<StepRole, string | null> = { lead: null, builder: 'implementer', reviewer: 'reviewer', tester: 'validator' }

/** Only builders change files; reviewers and testers are fenced read-only. */
export const roleWrites = (role: StepRole) => role === 'builder'
