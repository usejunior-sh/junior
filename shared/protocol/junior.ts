

// ---------------------------------------------------------------------------
// Junior (.docs/junior-goals-teams): the persona, the Junior page's day, and
// today's plan. Domain types and the pure rules live in core/junior/.
// ---------------------------------------------------------------------------

export type { Persona, Voice } from '../../core/junior/persona.js'
export type { Mood } from '../../core/junior/mood.js'
export type { Blocking, BriefFacts, BriefRef, BriefTarget, Finished, Segment } from '../../core/junior/brief.js'
export type { NeedsRow, NeedsTarget } from '../../core/junior/needs.js'
export type { AddedBy, Owner, PlanRow, PlanStatus, PlanView, TodayEntry } from '../../core/junior/today.js'
export type { CanDoFill, Offer } from '../../core/junior/offers.js'
export type { MorningBrief, MorningRow } from '../../core/junior/morning.js'

/** GET/PUT /api/persona — the workspace's persona; PUT takes a partial patch. */
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

/** GET /api/junior?since=&away= — everything the Junior page shows, in one read. */
export type JuniorDay = {
  /** what the user is called: a first name for the greeting, an initial for the "You" chip */
  you: { name: string | null; initial: string }
  /** no plan has ever existed here and no chat has been started: Junior introduces itself */
  firstOpen: boolean
  now: JuniorNow
  needs: import('../../core/junior/needs.js').NeedsRow[]
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
}
export type JuniorDayResponse = { ok: true; day: JuniorDay } | { ok: false; error: string }

/** GET /api/today, POST /api/today/open|add|remove — today's plan. */
export type TodayResponse = { ok: true; plan: import('../../core/junior/today.js').PlanView } | { ok: false; error: string }

/**
 * POST /api/today/add: an existing item by id, or `title` to create a manual
 * to-do and put it on today in one step. `owner` = whose it is today.
 */
export type TodayAddRequest = { itemId?: string; title?: string; owner: import('../../core/junior/today.js').Owner }

/** GET /api/today/match?q= — the open item a few typed words mean, if any. */
export type TodayMatchResponse =
  | { ok: true; match: { id: string; title: string; ref: string; onToday: boolean } | null }
  | { ok: false; error: string }
