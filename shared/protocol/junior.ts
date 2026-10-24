

// Junior (.docs/junior-goals-teams): the persona, the Junior page's day, and
// today's plan. Domain types and the pure rules live in core/junior/.

export type { Persona, Voice } from '../../core/junior/persona.js'
export type { Mood } from '../../core/junior/mood.js'
export type { Blocking, BriefFacts, BriefRef, BriefTarget, Finished, Segment } from '../../core/junior/brief.js'
export type { NeedsMove, NeedsRow, NeedsTarget } from '../../core/junior/needs.js'
export type { RowMove } from '../../core/junior/row-move.js'
export type { AddedBy, Owner, PlanRow, PlanStatus, PlanView, TodayEntry } from '../../core/junior/today.js'
export type { CanDoFill, Offer } from '../../core/junior/offers.js'
export type { MorningBrief, MorningRow } from '../../core/junior/morning.js'
export type { HandoffReadiness, JuniorWork, WatchId } from '../../core/work/handoff.js'

/**
 * POST /api/handoff/start|pause|resume|not-now: the item as it is now, and
 * whether its hand-off can do anything (a PR whose watch is off reads
 * "watch-off"; the hand-off never turns the watch on).
 */
export type HandoffResponse =
  | { ok: true; item: import('../../core/work/types.js').WorkItem; readiness: import('../../core/work/handoff.js').HandoffReadiness }
  | { ok: false; error: string }

/** GET/PUT /api/persona: the workspace's persona; PUT takes a partial patch. */
export type PersonaResponse =
  | {
      ok: true
      persona: import('../../core/junior/persona.js').Persona
      /** what Junior calls you: the first word of the Mac's full name (GET only) */
      you?: string | null
    }
  | { ok: false; error: string }

/** Where Junior is right now: the most relevant live session or job run, or free. */
export type JuniorNow =
  | { idle: true }
  | {
      idle: false
      /** what it is doing, lower-case: "finding the auth test flake" */
      label: string
      step: { n: number; of: number } | null
      /** other things running besides this one */
      more: number
      target: { kind: 'session'; id: string } | { kind: 'job'; id: string }
    }

/** First open: what Junior can see on this Mac. */
export type JuniorSeen = {
  /** the gh login, when gh is signed in */
  github: string | null
  /** connected sources by name (Slack, Linear, Sentry…), and the ones that need attention */
  sources: { name: string; connected: boolean }[]
  projects: string[]
}

/** A focus window that is on now: Needs you shows only what gets through until it ends. */
export type JuniorFocus = {
  /** epoch ms the window ends */
  until: number
  /** a person waiting this long gets through */
  waitMinutes: number
  /** the setting in words (describeFocus), for the line's tooltip */
  text: string
}

/** POST /api/focus/end: the rest of this window is skipped; `focus` is what is on after (null when ended). */
export type FocusEndResponse = { ok: true; focus: JuniorFocus | null } | { ok: false; error: string }

/** GET /api/junior?since=&away=: everything the Junior page shows, in one read. */
export type JuniorDay = {
  /** what the user is called: a first name for the greeting, an initial for the "You" chip */
  you: { name: string | null; initial: string }
  /** no plan has ever existed here and no chat has been started: Junior introduces itself */
  firstOpen: boolean
  now: JuniorNow
  needs: import('../../core/junior/needs.js').NeedsRow[]
  /**
   * The next move on each open item, by id (core/junior/row-move.ts): what the
   * Ledger row leads with. Made with what only the server knows (a chat on a
   * prompt, sends held for the item); a row whose item moved on makes its own.
   */
  moves: Record<string, import('../../core/junior/row-move.js').RowMove>
  facts: import('../../core/junior/brief.js').BriefFacts
  plan: import('../../core/junior/today.js').PlanView
  /** what Junior can see on this Mac: the sidebar's "Can see", and the first open's list */
  seen: JuniorSeen | null
  /** the morning brief: people waiting, due today, to review, while you were away */
  morning: import('../../core/junior/morning.js').MorningBrief
  /** jobs switched on here: "running for you" */
  jobsOn: number
  /** first open only: 3–4 starters built from the top items */
  offers: import('../../core/junior/offers.js').Offer[]
  /** the What I can do blanks */
  fill: import('../../core/junior/offers.js').CanDoFill
  /** something broke: a failed job, a paused team run */
  stuck: boolean
  /** the workspace library's skills and agents: routines you taught Junior */
  routines: { name: string; kind: 'skill' | 'agent'; path: string }[]
  /** in a focus window right now (core/work/focus.ts); null = not in focus */
  focus: JuniorFocus | null
  /**
   * Waiting items with a due nudge, by item id (core/work/nudge-suggest.ts):
   * who, since when, and whether Junior can send it or you copy it. A
   * suggestion only: no draft exists until you pick Draft nudge.
   */
  nudges: Record<string, import('../../core/work/nudge-suggest.js').NudgeMark>
  /**
   * 2+ green minor or patch dependency PRs as one suggested row on Needs you
   * (core/babysit/dep-batch.ts). A read: nothing is queued until the user
   * presses Merge. Null = no batch (or "Not now").
   */
  depBatch?: import('../../core/babysit/dep-batch.js').DepBatchView | null
}
export type JuniorDayResponse = { ok: true; day: JuniorDay } | { ok: false; error: string }

export type { NudgeMark, NudgeRoute } from '../../core/work/nudge-suggest.js'

/**
 * POST /api/nudge/draft {itemId, person?}: the nudge task on you, holding the
 * drafted text (done already when an approval you wrote sent it).
 * POST /api/tasks/send-nudge {id, text?, byHand?}: the task after the send.
 */
export type NudgeTaskResponse = { ok: true; task: import('../../core/work/tasks.js').ItemTask } | { ok: false; error: string }

/**
 * POST /api/deps/merge { refs }: the Merge press, the approval. Answers at
 * once with the run; GET /api/deps/merge/<id> reads its rows as they go.
 */
export type DepMergeResponse = { ok: true; run: import('../../core/babysit/dep-batch.js').DepMergeRun } | { ok: false; error: string }
/** POST /api/deps/not-now { refs }: hide this batch for a day, or until a new PR joins. */
export type DepNotNowResponse = { ok: true; until: number } | { ok: false; error: string }
export type { DepBatchRow, DepBatchView, DepMergeRow, DepMergeRun, DepMergeState } from '../../core/babysit/dep-batch.js'

/** GET /api/today, POST /api/today/open|add|remove, today's plan. */
export type TodayResponse = { ok: true; plan: import('../../core/junior/today.js').PlanView } | { ok: false; error: string }

/**
 * POST /api/today/add: an existing item by id, or `title` to create a manual
 * to-do and put it on today in one step. `owner` = whose it is today.
 */
export type TodayAddRequest = { itemId?: string; title?: string; owner: import('../../core/junior/today.js').Owner }

/** GET /api/today/match?q=: the open item a few typed words mean, if any. */
export type TodayMatchResponse =
  | { ok: true; match: { id: string; title: string; ref: string; onToday: boolean } | null }
  | { ok: false; error: string }

// Learnings with receipts (core/junior/learnings.ts), behind Junior's notebook.
export type { Learning, LearningScope, LearningSource, LearningStatus, ProposeLearningResult } from '../../core/junior/learnings.js'

/** GET /api/learnings[?all=1]: proposed and kept (candidates too with all=1), and files that didn't parse. */
export type LearningsResponse =
  | {
      ok: true
      learnings: import('../../core/junior/learnings.js').Learning[]
      broken: { id: string; file: string; errors: string[] }[]
      path: string
    }
  | { ok: false; error: string }

/** POST /api/learnings/keep|forget {id}, /api/learnings/edit {id, text?, scope?, confirm?}: the learning after (or as forgotten). */
export type LearningResponse = { ok: true; learning: import('../../core/junior/learnings.js').Learning } | { ok: false; error: string }
