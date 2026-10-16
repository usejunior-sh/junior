/**
 * Plan review (M2): the lead drafts, the user approves, comments on a step,
 * or sends the plan back. Pure — no I/O, no clock — so the reaction to every
 * event is unit-tested (test/goal-review.test.ts):
 *
 *   created         → wake the lead to draft the plan
 *   plan_sent_back  → wake the lead to revise it, with the user's comments
 *   plan_approved   → queue the first step(s): no dependencies = runnable
 *
 * Comments are `plan_commented` events, not a table: the ones since the
 * latest proposal are the pending ones, and send-back hands them all over.
 */
import type { Goal, GoalEvent, GoalPlan, GoalStepState } from './types.js'

/** One comment on a proposed plan; stepId null = on the plan as a whole. */
export type PlanComment = { stepId: string | null; text: string; at: number }

/** Why the lead wakes in draft_plan: the first draft, or a revision with the user's comments. */
export type LeadWake = { kind: 'draft' } | { kind: 'revise'; comments: PlanComment[]; version: number }

/** What the engine does about one event. `none` = nothing, mark it handled. */
export type ReviewReaction =
  | { kind: 'wake_lead'; wake: LeadWake }
  | { kind: 'queue_steps'; steps: GoalStepState[]; currentStep: string | null }
  | { kind: 'none' }

export const MAX_COMMENT = 4_000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A comment out of an event's detail (or a client's body); null when it isn't one. */
export function commentFrom(v: unknown, at: number): PlanComment | null {
  if (!isObj(v) || typeof v.text !== 'string' || !v.text.trim()) return null
  const stepId = typeof v.stepId === 'string' && v.stepId ? v.stepId : null
  return { stepId, text: v.text.trim().slice(0, MAX_COMMENT), at: typeof v.at === 'number' ? v.at : at }
}

/** The comments made since the latest plan proposal, oldest first — what send-back hands the lead. */
export function pendingComments(events: readonly GoalEvent[]): PlanComment[] {
  let start = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'plan_proposed') {
      start = i + 1
      break
    }
  }
  const out: PlanComment[] = []
  for (const e of events.slice(start)) {
    if (e.kind !== 'plan_commented') continue
    const c = commentFrom(e.detail, e.at)
    if (c) out.push(c)
  }
  return out
}

/** Every step of an approved plan at the start: no dependencies = runnable, else pending. Plan order is kept. */
export function initialSteps(goalId: string, plan: GoalPlan, at: number): GoalStepState[] {
  return plan.steps.map((s) => ({
    goalId,
    stepId: s.id,
    status: s.dependsOn.length ? 'pending' : 'runnable',
    attempts: 0,
    sessionId: null,
    startedAt: null,
    endedAt: null,
    updatedAt: at,
  }))
}

/**
 * What to do about `ev` for a goal now in `goal.state`. Guards on the state,
 * so a replayed event the goal has moved past does nothing: a `created` whose
 * goal already has a plan, an approval of a goal that was since cancelled.
 * `existing` = the step rows already there; an approval never requeues them.
 */
export function reactTo(goal: Goal, ev: GoalEvent, existing: readonly GoalStepState[], at: number): ReviewReaction {
  switch (ev.kind) {
    case 'created':
      return goal.state === 'draft_plan' && !goal.plan ? { kind: 'wake_lead', wake: { kind: 'draft' } } : { kind: 'none' }
    case 'plan_sent_back': {
      if (goal.state !== 'draft_plan') return { kind: 'none' }
      const raw = isObj(ev.detail) && Array.isArray(ev.detail.comments) ? ev.detail.comments : []
      const comments = raw.map((c) => commentFrom(c, ev.at)).filter((c): c is PlanComment => !!c)
      const version = isObj(ev.detail) && typeof ev.detail.version === 'number' ? ev.detail.version : goal.planVersion
      return { kind: 'wake_lead', wake: { kind: 'revise', comments, version } }
    }
    case 'plan_approved': {
      if (goal.state !== 'queued' || !goal.plan || existing.length) return { kind: 'none' }
      const steps = initialSteps(goal.id, goal.plan, at)
      return { kind: 'queue_steps', steps, currentStep: steps.find((s) => s.status === 'runnable')?.stepId ?? null }
    }
    default:
      return { kind: 'none' }
  }
}

/** The events the review engine acts on — the ones replayed after a restart. */
export const REVIEW_EVENTS: ReadonlySet<GoalEvent['kind']> = new Set(['created', 'plan_sent_back', 'plan_approved'])

// ---------------------------------------------------------------------------
// The drafting lead
// ---------------------------------------------------------------------------

/**
 * The drafting lead's contract, in its system prompt so it survives `resume`.
 * It works headless and read-only; its one write is goal_propose_plan.
 */
export const LEAD_DRAFT_APPEND = `
You are the LEAD of a triage goal, running headless to research it and draft its plan. Nobody is watching this
session and nobody can answer a question, so never ask one: decide, and say what you assumed in the plan's
summary. Read whatever you need: files, \`gh\` and \`git\` read-only commands, connectors, the goal's source work
item and its brief. Make NO changes anywhere: do not edit or create files, do not push, comment, post or send.

Your output is ONE call to goal_propose_plan with the whole plan:
- summary: what you found and what you chose, in a paragraph the user reads first.
- steps: short, each one session's work or one wait. type "agent" with a role (builder, reviewer, tester) for
  work; type "gate" for anything the goal must wait on outside (CI, a person, a ticket status), with a checkable
  condition. Every step has a doneWhen the engine can check. dependsOn names earlier step ids.
- team, budgetUsd, mayDo (what Junior may do without asking, in plain words) when they matter.
The tool validates the plan and rejects it with the reason; fix it and call again. Text you reply with is not
kept; once the plan is proposed, you are done — end your turn.`

/** The lead's first message for one wake. */
export function leadDraftPrompt(goal: Pick<Goal, 'id' | 'title' | 'doneWhen' | 'horizon' | 'sourceItemId' | 'budget'>, wake: LeadWake, currentPlan: string | null): string {
  const head = [
    `Goal ${goal.id}: ${goal.title}`,
    `Done when: ${goal.doneWhen}`,
    `Horizon: ${goal.horizon.replace('_', ' ')}`,
    goal.budget.usd !== null || goal.budget.minutes !== null
      ? `Budget: ${[goal.budget.usd !== null ? `$${goal.budget.usd}` : null, goal.budget.minutes !== null ? `${goal.budget.minutes} min` : null].filter(Boolean).join(' · ')}`
      : null,
    goal.sourceItemId ? `It came from work item ${goal.sourceItemId} — read it with get_work_item (and its brief, if it has one).` : null,
  ].filter(Boolean)
  if (wake.kind === 'draft') {
    return [...head, '', 'Research it, then draft the plan and propose it with goal_propose_plan.'].join('\n')
  }
  const comments = wake.comments.length
    ? wake.comments.map((c) => `- ${c.stepId ? `on step ${c.stepId}` : 'on the plan'}: ${c.text}`)
    : ['- (no comments — the user sent it back as a whole; ask yourself what a reviewer would find missing)']
  return [
    ...head,
    '',
    `The user sent plan v${wake.version} back. Their comments:`,
    ...comments,
    '',
    'Revise the plan so each comment is addressed, say how in the summary, and propose it again with goal_propose_plan.',
    ...(currentPlan ? ['', 'The plan they sent back:', '', currentPlan.trim()] : []),
  ].join('\n')
}
