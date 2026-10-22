/**
 * The goal state machine: which trigger moves a goal from which state to
 * which, and who may pull it. Pure, no clock, no I/O, so every allowed and
 * refused pair is unit-tested (test/goal-machine.test.ts). Only the engine
 * calls `transition`; agents propose through engine tools, and the user's
 * clicks arrive as triggers with `by: 'you'`.
 *
 *   draft_plan ──plan_proposed──▶ plan_ready ──approve──▶ queued ──start──▶ running
 *        ▲                            │
 *        └──────────send_back─────────┘
 *
 *   running ──yield──────▶ queued
 *   running ──wait_world─▶ waiting_world ──gate_met──▶ queued
 *                          waiting_world ──watcher_step──▶ queued  (the PR watcher queued a fix, a rebase, the merge)
 *   running ──ask_you────▶ waiting_you   ──answer────▶ queued
 *                          waiting_you   ──keep_waiting──▶ waiting_world  (a gate past its deadline: wait on)
 *   running ──result─────▶ result_ready  ──reopen────▶ queued
 *                                        ──accept────▶ done
 *   queued, waiting_world ──ask_you──▶ waiting_you   (budget pause, gate deadline)
 *
 *   pause:  queued / running / waiting_world / waiting_you ──▶ paused ──resume──▶ queued
 *   cancel: any state but done / cancelled ──▶ cancelled
 *
 * Every wait takes the goal out of running, and the way back in is always
 * through queued: the lead resumes in a fresh session, which needs a slot.
 */
import type { GoalState, GoalTurn } from './types.js'

export type GoalTrigger =
  | 'plan_proposed'
  | 'approve'
  | 'send_back'
  | 'start'
  | 'yield'
  | 'wait_world'
  | 'ask_you'
  | 'gate_met'
  | 'watcher_step'
  | 'answer'
  | 'keep_waiting'
  | 'result'
  | 'accept'
  | 'reopen'
  | 'pause'
  | 'resume'
  | 'cancel'

/** you = only the user's click pulls it; engine = only junior does, on an event. */
export type TriggerBy = 'you' | 'engine'

type Rule = { from: readonly GoalState[]; to: GoalState; by: TriggerBy }

const LIVE: readonly GoalState[] = ['draft_plan', 'plan_ready', 'queued', 'running', 'waiting_world', 'waiting_you', 'result_ready', 'paused']

export const TRANSITIONS: Readonly<Record<GoalTrigger, Rule>> = {
  /** the lead's drafting session exited with a valid plan */
  plan_proposed: { from: ['draft_plan'], to: 'plan_ready', by: 'engine' },
  approve: { from: ['plan_ready'], to: 'queued', by: 'you' },
  /** with comments: the lead wakes to revise */
  send_back: { from: ['plan_ready'], to: 'draft_plan', by: 'you' },
  /** the scheduler gave it a slot */
  start: { from: ['queued'], to: 'running', by: 'engine' },
  /** a session ended and there is more to do */
  yield: { from: ['running'], to: 'queued', by: 'engine' },
  /** an AI gate or a watcher wait was armed */
  wait_world: { from: ['running'], to: 'waiting_world', by: 'engine' },
  /**
   * an approval, a question, a plan change, a budget pause (queued: caught
   * before a start), or a gate that needs the user or ran past its deadline
   */
  ask_you: { from: ['queued', 'running', 'waiting_world'], to: 'waiting_you', by: 'engine' },
  gate_met: { from: ['waiting_world'], to: 'queued', by: 'engine' },
  /** the PR watcher dispatched a step while the goal waits on its PR: the step's worker needs a slot */
  watcher_step: { from: ['waiting_world'], to: 'queued', by: 'engine' },
  answer: { from: ['waiting_you'], to: 'queued', by: 'you' },
  /** a gate that ran past its deadline or stumped its checker: wait on it, without waking the lead */
  keep_waiting: { from: ['waiting_you'], to: 'waiting_world', by: 'you' },
  /** the done-when holds */
  result: { from: ['running'], to: 'result_ready', by: 'engine' },
  /** accepting closes the source item through the Outbox */
  accept: { from: ['result_ready'], to: 'done', by: 'you' },
  /** the user sends the result back with what's missing */
  reopen: { from: ['result_ready'], to: 'queued', by: 'you' },
  /** take over: the step's worktree goes to the user's editor */
  pause: { from: ['queued', 'running', 'waiting_world', 'waiting_you'], to: 'paused', by: 'you' },
  /** hand back: the next session starts from what the user did */
  resume: { from: ['paused'], to: 'queued', by: 'you' },
  cancel: { from: LIVE, to: 'cancelled', by: 'you' },
}

export const GOAL_TRIGGERS = Object.keys(TRANSITIONS) as GoalTrigger[]

export const TERMINAL_STATES: readonly GoalState[] = ['done', 'cancelled']
export const isTerminal = (s: GoalState) => TERMINAL_STATES.includes(s)

export type TransitionResult = { ok: true; from: GoalState; to: GoalState } | { ok: false; error: string }

/** Where `trigger` takes a goal in `from`, pulled `by` whom, or why it can't. */
export function transition(from: GoalState, trigger: GoalTrigger, by: TriggerBy): TransitionResult {
  const rule = TRANSITIONS[trigger]
  if (!rule) return { ok: false, error: `unknown trigger "${trigger}"` }
  if (rule.by !== by) return { ok: false, error: `${trigger} is ${rule.by === 'you' ? 'yours' : "junior's"} to pull, not ${by === 'you' ? 'yours' : "junior's"}` }
  if (!rule.from.includes(from)) return { ok: false, error: `can't ${trigger.replace('_', ' ')} a goal that is ${from}` }
  return { ok: true, from, to: rule.to }
}

/** The triggers that apply in a state, for whom, what the goal page offers as buttons. */
export function triggersFrom(state: GoalState, by?: TriggerBy): GoalTrigger[] {
  return GOAL_TRIGGERS.filter((t) => TRANSITIONS[t].from.includes(state) && (by === undefined || TRANSITIONS[t].by === by))
}

/** Whose turn a goal in `state` is: the user at review, approval and result; the world at a gate; Junior while it works. */
export function turnOf(state: GoalState): GoalTurn {
  switch (state) {
    case 'plan_ready':
    case 'waiting_you':
    case 'result_ready':
      return 'me'
    case 'waiting_world':
      return 'others'
    case 'draft_plan':
    case 'queued':
    case 'running':
      return 'ai'
    case 'paused':
    case 'done':
    case 'cancelled':
      return 'none'
  }
}

/** "5m", "4h", "1d", "30s" → ms; null for anything else. */
export function parseDuration(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (!(n > 0)) return null
  return Math.round(n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'])
}
