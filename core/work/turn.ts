/**
 * Whose turn: one answer for every item, you · Junior · others, with the
 * reason it is theirs. Pure, browser-safe, no time, no model output.
 *
 * Three vocabularies grew up for this, and this module is the one they read:
 *
 *   flow.ts         Turn         me · ai · others · none   (stage + turn)
 *   inbox-tabs.ts   OpenTab      needs · … · ai · … · others · backlog
 *   junior/ledger   LedgerTab    needs · up · reviews · prs · with · waiting
 *   verdict.ts      VerdictTurn  you · ready · junior · others · idle
 *
 * The mapping to the Junior page's tabs is fixed, and the labels stay the
 * ones users already see (no rename to You / Junior / Others):
 *
 *   you     → Needs you     the ball is with you
 *   junior  → With Junior   Junior holds it, nothing pings you
 *   others  → Waiting       a person, a reviewer, the world or the clock
 *
 * flow.ts's `me` is `you`, `ai` is `junior`, `others` is `others`; `none`
 * (an override to "Nobody") reads by the rules below.
 *
 * Rules run in order and the first match wins, so every item gets exactly
 * one reason, and every reason belongs to exactly one turn (TURN_REASONS).
 * Roughly: something holding until you answer, then Junior busy, then your
 * PR's own state (red only where main is red too waits on main), then a
 * finished run, then a message that asks you (status.ts), then someone else,
 * then Junior watching, then whatever is left is on your plate.
 *
 * "Not useful" (ledger.ts `quieted`) is attention, not turn: a quieted item
 * is still yours, it just leaves the Needs you list until something new.
 */
import { askOf, type Ask } from './asks.js'
import type { ItemFlow } from './flow.js'
import { mainRedOnly } from './handoff.js'
import { sourceOf } from '../../shared/sources.js'
import type { MessageStatus } from './status.js'
import type { ScoredItem, WorkItem } from './types.js'

export type WhoseTurn = 'you' | 'junior' | 'others'
export const WHOSE_TURNS: readonly WhoseTurn[] = ['you', 'junior', 'others']

/** The Junior page tab each turn shows on, in today's words. */
export const TURN_TAB_LABEL: Record<WhoseTurn, string> = {
  you: 'Needs you',
  junior: 'With Junior',
  others: 'Waiting',
}

/** Why it is that turn. A closed union: each reason implies one turn. */
export type TurnReason =
  // you
  | 'session-blocked'
  | 'held-send'
  | 'junior-asks'
  | 'first-pass-ready'
  | 'task-on-you'
  | 'broken'
  | 'merge'
  | 'ci-red'
  | 'conflicts'
  | 'result-ready'
  | 'person-asks'
  | 'paused'
  | 'yours'
  // junior
  | 'junior-task'
  | 'junior-run'
  | 'set-with-junior'
  | 'junior-fixing'
  | 'junior-watching'
  | 'handed-in'
  // others
  | 'set-waiting'
  | 'main-red'
  | 'reviewers'
  | 'review-posted'
  | 'follow-up'
  | 'world'
  | 'snoozed'
  | 'closed'

/** Every reason, its turn, and a short line for a muted reason column. */
export const TURN_REASONS: Record<TurnReason, { turn: WhoseTurn; text: string }> = {
  'session-blocked': { turn: 'you', text: 'A chat waits on your answer' },
  'held-send': { turn: 'you', text: 'A send waits for your OK' },
  'junior-asks': { turn: 'you', text: 'Junior is paused on you' },
  'first-pass-ready': { turn: 'you', text: 'First pass waits for your OK' },
  'task-on-you': { turn: 'you', text: 'A task waits on you' },
  broken: { turn: 'you', text: 'Something broke' },
  merge: { turn: 'you', text: 'Approved. Merge it' },
  'ci-red': { turn: 'you', text: 'CI is red' },
  conflicts: { turn: 'you', text: 'It conflicts with its base' },
  'result-ready': { turn: 'you', text: 'Junior finished. Review it' },
  'person-asks': { turn: 'you', text: 'Someone asked you' },
  paused: { turn: 'you', text: 'You paused Junior on it' },
  yours: { turn: 'you', text: 'On your plate' },
  'junior-task': { turn: 'junior', text: 'Junior is working on it' },
  'junior-run': { turn: 'junior', text: 'A run is going' },
  'set-with-junior': { turn: 'junior', text: 'You said Junior has it' },
  'junior-fixing': { turn: 'junior', text: 'Junior will fix it' },
  'junior-watching': { turn: 'junior', text: 'Junior is watching it' },
  'handed-in': { turn: 'junior', text: 'Handed to Junior' },
  'set-waiting': { turn: 'others', text: 'You said it waits on someone' },
  'main-red': { turn: 'others', text: 'Main is red too · not yours' },
  reviewers: { turn: 'others', text: 'Waiting on reviewers' },
  'review-posted': { turn: 'others', text: 'Review posted. The author has it' },
  'follow-up': { turn: 'others', text: 'You wait on someone' },
  world: { turn: 'others', text: 'Waiting on an outside change' },
  snoozed: { turn: 'others', text: 'Snoozed' },
  closed: { turn: 'others', text: 'Closed' },
}

export const TURN_REASON_LIST = Object.keys(TURN_REASONS) as TurnReason[]

export interface TurnOf {
  turn: WhoseTurn
  reason: TurnReason
}

/** What the rules read off an item. Everything but kind, source and peopleWaiting may be absent. */
export type TurnItem = Pick<WorkItem, 'kind' | 'source' | 'peopleWaiting'> &
  Partial<Pick<WorkItem, 'status' | 'handoff' | 'ciFailing'>> &
  Partial<Pick<ScoredItem, 'junior' | 'tasks' | 'seen'>> & { ask?: string; flow?: ItemFlow }

/** What the item can't say about itself. */
export interface TurnContext {
  /** a session dispatched for it (any, not only the newest) is on a prompt */
  blocked?: boolean
  /** sends drafted for it wait for your OK (core/actions/queue.ts) */
  heldSends?: number
  /**
   * the newest message on it, typed (status.ts statusOf). A question or an
   * approval puts it with you; an FYI, or no message, leaves the rules
   * below to decide: an FYI never moves an item to you on its own.
   */
  message?: MessageStatus
}

/** Flow next steps where Junior or a team is stopped until you answer. */
const ASK_NEXT: ReadonlySet<string> = new Set([
  'answer the session',
  'answer Junior',
  'approve the team',
  'approve the step',
  'resume the team',
])
/** Flow next steps where a run finished and its result is yours to read. */
const RESULT_NEXT: ReadonlySet<string> = new Set(['review result', 'accept the result', 'read brief'])
const HUMAN_ASKS: ReadonlySet<Ask> = new Set(['review', 'reply', 'decide'])

const isOwnPr = (i: TurnItem) => i.kind.startsWith('own-pr-')
const at = (reason: TurnReason): TurnOf => ({ turn: TURN_REASONS[reason].turn, reason })

/** Whose turn an item is, and why. Total: any item shape gets one answer. */
export function turnOf(item: TurnItem, ctx: TurnContext = {}): TurnOf {
  const f = item.flow
  const mine = f?.turn === 'me'
  const paused = item.handoff === 'paused' || item.junior?.stage === 'paused'

  // Off the open list: the clock or nobody has it. Callers usually filter these first.
  if (item.status === 'snoozed') return at('snoozed')
  if (item.status === 'done' || item.status === 'archived') return at('closed')

  // Something holds until you answer.
  if (ctx.blocked) return at('session-blocked')
  if ((ctx.heldSends ?? 0) > 0 || (mine && f?.next === 'approve action')) return at('held-send')
  if (item.junior?.stage === 'needs-you') return at('junior-asks')
  if (item.tasks?.review?.state === 'ready') return at('first-pass-ready')
  if (mine && f?.next && ASK_NEXT.has(f.next)) return at('junior-asks')
  // a pause stops Junior's tasks with an error; that error isn't a question
  if (!paused && (item.tasks?.needsYou ?? 0) > 0) return at('task-on-you')
  if (f?.broken && f.broken !== 'CI failing') return at('broken')

  // Junior is busy on it.
  if (!paused && item.junior?.stage === 'working') return at('junior-task')
  if (f?.turn === 'ai') return at(f.overridden ? 'set-with-junior' : 'junior-run')

  // You said someone else has it; holds until something newer happens (flow.ts).
  if (f?.overridden && f.turn === 'others') return at('set-waiting')

  // Your PR's own state. Red CI and conflicts are Junior's on a PR it can babysit.
  const juniorCan = item.handoff === 'on' && !paused && item.junior?.readiness?.state !== 'watch-off' && item.junior?.readiness?.state !== 'unsupported'
  // every red check failed on main too (the babysit watch's last poll): not this PR's to fix, nobody's move here
  if (juniorCan && isOwnPr(item) && item.ciFailing && item.kind !== 'own-pr-conflicting' && mainRedOnly(item.seen)) return at('main-red')
  if ((isOwnPr(item) && item.ciFailing) || (mine && f?.next === 'fix CI')) return at(juniorCan ? 'junior-fixing' : 'ci-red')
  if (item.kind === 'own-pr-approved' || (mine && f?.next === 'merge')) return at('merge')
  if (item.kind === 'own-pr-conflicting' || (mine && f?.next === 'resolve conflicts')) return at(juniorCan ? 'junior-fixing' : 'conflicts')

  // A run finished: its result is yours to read.
  if (mine && f?.next && RESULT_NEXT.has(f.next)) return at('result-ready')

  const juniorReviews = juniorCan && item.junior?.stage === 'watching' && item.tasks?.review?.state !== 'skipped'

  // The newest message asks you. A question is yours to answer; an approval
  // (a review ask) goes to Junior's review watch first when it can take it.
  if (ctx.message === 'question') return at('person-asks')
  if (ctx.message === 'approval') return at(juniorReviews ? 'junior-watching' : 'person-asks')

  // Someone else has the next move.
  if (item.tasks?.review?.state === 'posted') return at('review-posted')
  const ask = askOf({ kind: item.kind, ...(item.ask !== undefined ? { ask: item.ask } : {}) })
  if (item.kind === 'own-pr-open' || item.kind === 'own-pr-stale') return at('reviewers')
  if (ask === 'follow-up') return at('follow-up')
  if (f?.turn === 'others') return at('world')

  // Handed off and the watch is on: a review request is Junior's to start on, unless it set it aside.
  if (juniorReviews) return at('junior-watching')

  // A person asked you. A to-do you wrote yourself isn't one.
  if (!sourceOf(item.source).yours && (item.peopleWaiting > 0 || HUMAN_ASKS.has(ask))) return at('person-asks')

  // Handed to Junior, nothing under way.
  if (!paused && item.junior?.stage === 'watching') return at('junior-watching')
  if (!paused && (item.junior?.stage === 'handed-in' || item.handoff === 'on')) return at('handed-in')

  // Left with you.
  if (paused || (f?.turn === 'none' && !f.overridden)) return at('paused')
  return at('yours')
}
