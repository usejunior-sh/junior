/**
 * Stage and turn, where a work item is in its life, and whose move it is
 * (.docs/work-item-model.md). Pure, browser-safe; time is an argument.
 *
 *   stage  new → briefing → ready → working → review → done
 *   turn   me | ai | others | none
 *
 * Both are derived from what triage can already see, the item's status and
 * kind, its newest brief job, its newest dispatched session, never from model
 * output. Where the rules can't see the truth ("waiting on Niraj"), the user
 * sets an override; it holds until something newer happens to the item (a
 * brief starts, a session ends), then the derived flow takes over again.
 *
 * The server materializes the result on the row and logs every change in the
 * item's event log; this module only answers "what is it now".
 */
import { askOf } from './asks.js'
import type { WorkItem } from './types.js'

export type Stage = 'new' | 'briefing' | 'ready' | 'working' | 'review' | 'done'
export type Turn = 'me' | 'ai' | 'others' | 'none'

export const STAGES: readonly Stage[] = ['new', 'briefing', 'ready', 'working', 'review', 'done']
export const TURNS: readonly Turn[] = ['me', 'ai', 'others', 'none']

export const STAGE_LABEL: Record<Stage, string> = {
  new: 'New',
  briefing: 'Briefing',
  ready: 'Ready',
  working: 'Working',
  review: 'Review',
  done: 'Done',
}

export const TURN_LABEL: Record<Turn, string> = {
  me: 'My turn',
  ai: 'AI working',
  others: 'Waiting on others',
  none: 'Nobody',
}

export const isStage = (v: unknown): v is Stage => typeof v === 'string' && (STAGES as readonly string[]).includes(v)
export const isTurn = (v: unknown): v is Turn => typeof v === 'string' && (TURNS as readonly string[]).includes(v)

/** A user's correction, for what the rules can't see. Either field may be absent. */
export interface FlowOverride {
  stage?: Stage
  turn?: Turn
  /** who or what it is waiting on, in the user's words: "Niraj to confirm the copy" */
  note?: string
  /** epoch ms it was set */
  at: number
}

/** The newest brief job for the item, reduced to what the rule reads. */
export interface BriefSignal {
  status: 'queued' | 'running' | 'ready' | 'failed'
  /** epoch ms of its latest move (finished, else started, else queued) */
  at: number
}

/** The newest session dispatched for the item, reduced to what the rule reads. */
export interface SessionSignal {
  /** a turn is running now */
  running: boolean
  /** a permission prompt or question is waiting on the user */
  waiting: boolean
  /** the subprocess died with an error */
  error: boolean
  /** epoch ms of its last activity */
  at: number
}

/** A team run on the item (core/teams/engine.ts), reduced to what the rule reads. */
export interface TeamSignal {
  state: 'proposed' | 'running' | 'gate' | 'waiting' | 'paused' | 'stopped' | 'done'
  /** epoch ms of its last activity */
  at: number
  /** a goal run: questions Junior asked you that are still unanswered */
  asks?: number
  /** a goal run: done, waiting on your accept */
  toAccept?: boolean
}

/** The newest live goal on the item (core/goals), reduced to what the rule reads. */
export interface GoalSignal {
  state: 'draft_plan' | 'plan_ready' | 'queued' | 'running' | 'waiting_world' | 'waiting_you' | 'result_ready' | 'paused'
  /** epoch ms of its last change */
  at: number
}

/** Queued actions (core/actions/queue.ts) on the item waiting on your approval. */
export interface ActionsSignal {
  /** how many wait on you */
  pending: number
  /** epoch ms the newest was queued */
  at: number
}

export interface FlowSignals {
  brief?: BriefSignal
  session?: SessionSignal
  team?: TeamSignal
  goal?: GoalSignal
  actions?: ActionsSignal
  override?: FlowOverride
}

export interface ItemFlow {
  stage: Stage
  turn: Turn
  /** on my turn, the specific next: "read brief", "dispatch", "review result", "merge" */
  next?: string
  /** something broke on this item: "CI failing", "brief failed", "session failed" */
  broken?: string
  /** epoch ms the item has been in this turn (for "waiting 2d") */
  since: number
  /** the user's override is in force */
  overridden?: boolean
  /** the override's note */
  note?: string
}

type FlowItem = Pick<WorkItem, 'kind' | 'ask' | 'status' | 'updatedAt' | 'createdAt' | 'ingestedAt' | 'ciFailing'>

const ms = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** Derive an item's flow from its own fields and the signals around it. */
export function flowOf(item: FlowItem, signals: FlowSignals = {}): ItemFlow {
  const derived = deriveFlow(item, signals)
  const o = signals.override
  if (!o || derived.stage === 'done') return derived
  // Something that happened after the override (a brief, a session, a queued action) wins.
  const newest = Math.max(signals.brief?.at ?? 0, signals.session?.at ?? 0, signals.team?.at ?? 0, signals.goal?.at ?? 0, signals.actions?.at ?? 0)
  if (newest > o.at) return derived
  const stage = o.stage ?? derived.stage
  const turn = o.turn ?? derived.turn
  return {
    stage,
    turn,
    ...(turn === 'me' ? { next: derived.turn === 'me' && derived.stage === stage ? derived.next : nextFor(stage) } : {}),
    ...(derived.broken ? { broken: derived.broken } : {}),
    since: o.at,
    overridden: true,
    ...(o.note ? { note: o.note } : {}),
  }
}

/** The default next step for a stage that is on my turn. */
function nextFor(stage: Stage): string | undefined {
  switch (stage) {
    case 'ready':
      return 'dispatch'
    case 'review':
      return 'review result'
    case 'working':
      return 'answer the session'
    default:
      return undefined
  }
}

function deriveFlow(item: FlowItem, s: FlowSignals): ItemFlow {
  const updated = ms(item.updatedAt)
  const created = item.ingestedAt ?? ms(item.createdAt)
  if (item.status === 'done' || item.status === 'archived') return { stage: 'done', turn: 'none', since: updated }
  // An agent's action held for approval blocks whatever step the item is on:
  // nothing it drafted goes out until you answer it.
  if (s.actions && s.actions.pending > 0) return { stage: 'review', turn: 'me', next: 'approve action', since: s.actions.at }

  const brief = s.brief
  const session = s.session
  // A goal drives the item end to end: its lead's and workers' sessions are its own, so it reads first.
  const goal = s.goal
  if (goal && (!brief || goal.at >= brief.at)) {
    switch (goal.state) {
      case 'draft_plan':
        return { stage: 'briefing', turn: 'ai', since: goal.at }
      case 'plan_ready':
        return { stage: 'ready', turn: 'me', next: 'review the plan', since: goal.at }
      case 'queued':
      case 'running':
        return { stage: 'working', turn: 'ai', since: goal.at }
      case 'waiting_world':
        return { stage: 'working', turn: 'others', since: goal.at }
      case 'waiting_you':
        return { stage: 'working', turn: 'me', next: 'answer the goal', since: goal.at }
      case 'result_ready':
        return withOwnPr(item, { stage: 'review', turn: 'me', next: 'review result', since: goal.at })
      case 'paused':
        return { stage: 'working', turn: 'none', since: goal.at }
    }
  }
  // A team run is the dispatch, step by step; a stopped one hands back to the session rules.
  const team = s.team && s.team.state !== 'stopped' ? s.team : undefined
  if (team && (!brief || team.at >= brief.at)) {
    // Junior asked you something: whatever the team is doing, it's your turn to answer.
    if (team.asks && team.state !== 'done') return { stage: 'working', turn: 'me', next: 'answer Junior', since: team.at }
    switch (team.state) {
      case 'waiting':
        return { stage: 'working', turn: 'others', since: team.at }
      case 'proposed':
        return { stage: 'ready', turn: 'me', next: 'approve the team', since: team.at }
      case 'gate':
        return { stage: 'working', turn: 'me', next: 'approve the step', since: team.at }
      case 'paused':
        return { stage: 'working', turn: 'me', next: 'resume the team', broken: 'team paused', since: team.at }
      case 'running':
        return { stage: 'working', turn: 'ai', since: team.at }
      case 'done':
        return withOwnPr(item, { stage: 'review', turn: 'me', next: team.toAccept ? 'accept the result' : 'review result', since: team.at })
    }
  }
  // A session dispatched after the latest brief is the item's newest step.
  if (session && (!brief || session.at >= brief.at)) {
    if (session.error) return { stage: 'review', turn: 'me', next: 'review result', broken: 'session failed', since: session.at }
    if (session.running && session.waiting) return { stage: 'working', turn: 'me', next: 'answer the session', since: session.at }
    if (session.running) return { stage: 'working', turn: 'ai', since: session.at }
    return withOwnPr(item, { stage: 'review', turn: 'me', next: 'review result', since: session.at })
  }
  if (brief) {
    if (brief.status === 'queued' || brief.status === 'running') return { stage: 'briefing', turn: 'ai', since: brief.at }
    if (brief.status === 'ready') return withOwnPr(item, { stage: 'ready', turn: 'me', next: 'read brief', since: brief.at })
    // A failed brief leaves the item where it started, flagged.
    return { ...fromKind(item, created, updated), broken: 'brief failed' }
  }
  return fromKind(item, created, updated)
}

/**
 * Your own PR, read from what GitHub says about it: waiting on reviewers,
 * approved, conflicting, red. These hold whatever step triage is on.
 */
function withOwnPr(item: FlowItem, f: ItemFlow): ItemFlow {
  if (item.ciFailing && isOwnPr(item)) return { ...f, stage: 'review', turn: 'me', next: 'fix CI', broken: 'CI failing' }
  return f
}

const isOwnPr = (item: FlowItem) => item.kind.startsWith('own-pr-')

function fromKind(item: FlowItem, created: number, updated: number): ItemFlow {
  if (isOwnPr(item)) {
    if (item.ciFailing) return { stage: 'review', turn: 'me', next: 'fix CI', broken: 'CI failing', since: updated }
    switch (item.kind) {
      case 'own-pr-approved':
        return { stage: 'review', turn: 'me', next: 'merge', since: updated }
      case 'own-pr-conflicting':
        return { stage: 'review', turn: 'me', next: 'resolve conflicts', since: updated }
      default:
        // open or stale: the reviewers have the turn
        return { stage: 'review', turn: 'others', since: updated }
    }
  }
  // "You are waiting on someone else and may need to nudge them."
  if (askOf(item) === 'follow-up') return { stage: 'new', turn: 'others', since: updated }
  return { stage: 'new', turn: 'me', since: created }
}

/** How long a turn with others may sit before Today raises it as stuck. */
export const STUCK_AFTER_MS = 2 * 86_400_000

/** Waiting on a person (or the AI) too long: Today shows it, with a nudge. */
export function isStuck(flow: ItemFlow, now: number): boolean {
  return flow.turn === 'others' && now - flow.since > STUCK_AFTER_MS
}
