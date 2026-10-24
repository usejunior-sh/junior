/**
 * What Junior could take, for the Suggested tab (hand-offs, Phase 1, artifact
 * f335b876). Plain rules, no model: what reaches the list, and the one line
 * of what Junior would do. You hand it off, snooze it, or say not this one.
 *
 *   your PR       CI red, comments open, a conflict, or behind; or a draft
 *                 Junior opened. Not: a draft you opened, a green PR with
 *                 nothing to do.
 *   review        someone asked for your review and no first pass exists
 *   other items   a rule says suggest (core/rules): its playbook
 *
 * Never: an item already handed off (or paused), one you said not this one
 * to and nothing changed since, an FYI, or a kind you asked Junior to stop
 * suggesting in that repo (the suppressions below).
 *
 * Order: people waiting on you, then your PRs that are red or blocked, then
 * Junior's own drafts, then the rest; the inbox's score within each.
 *
 * Pure, browser-safe.
 */
import type { PrSeen } from '../work/handoff.js'
import type { Handoff, Playbook, Reason } from '../work/fields.js'

/** What a hand-off from the list starts: babysit and review run off their watches. */
export type SuggestPlaybook = 'babysit' | 'review' | 'answer' | 'debug-fix' | 'investigate'

export type Suggestion = {
  playbook: SuggestPlaybook
  /** "I'd babysit it" */
  head: string
  /** "Fix lint and unit, answer 2 bot comments." */
  would: string
  /** 1 people waiting · 2 your PR red or blocked · 3 Junior's own draft · 4 a rule says suggest */
  tier: 1 | 2 | 3 | 4
}

export type SuggestItem = {
  reason: Reason
  kind: string
  updatedAt: string
  peopleWaiting: number
  isDraft?: boolean
  ciFailing?: boolean
  handoff?: Handoff
  notNow?: string
  /** where it came from and its home, for the suppressions: `github`, `acme/web` */
  source?: string
  repo?: string
}

export type SuggestInput = {
  item: SuggestItem
  /** Junior has a task of its own still open on it */
  juniorBusy: boolean
  /** a first pass exists on it (any state) */
  reviewed: boolean
  /** the babysit watch's last read of the PR, when it has one */
  seen?: PrSeen
  /** Junior opened this PR (a debug-fix's draft) */
  juniorPr: boolean
  /** the rule for the item, when one is on */
  rule: { playbook: Playbook | null; start: 'auto' | 'suggest' } | null
  /** the suppression keys in force (suppressedKeys): a match is never suggested */
  suppressed?: ReadonlySet<string>
}

/** What each startable playbook would do, as a suggestion says it. */
export const STARTS: Partial<Record<Playbook, { head: string; would: string }>> = {
  answer: { head: 'I’d draft a reply', would: 'Read the thread and the code, draft a reply for you.' },
  'debug-fix': { head: 'I’d plan a fix', would: 'Find the cause, plan the fix, wait for your OK.' },
  investigate: { head: 'I’d look into it', would: 'Dig in and write up the options.' },
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What babysitting a PR would do first, in a line; null when there's nothing to do. */
export function babysitLine(s: PrSeen): string | null {
  const parts: string[] = []
  if (s.red.length) parts.push(`fix ${clip(s.red.slice(0, 3).join(', '), 48)}${s.red.length > 3 ? ` +${s.red.length - 3}` : ''}`)
  if (s.bots) parts.push(`answer ${plural(s.bots, 'bot comment')}`)
  if (s.rebase) parts.push(s.rebase === 'conflict' ? 'resolve the conflict' : 'rebase it')
  if (!parts.length) return null
  const line = list(parts)
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`
}

export function suggestionFor(i: SuggestInput): Suggestion | null {
  const it = i.item
  if (it.handoff || i.juniorBusy) return null
  if (it.notNow !== undefined && it.notNow === it.updatedAt) return null
  if (i.suppressed?.size) {
    const repo = suppressRepo(it)
    if (repo && i.suppressed.has(suppressKey(repo, it.kind))) return null
  }

  if (it.reason === 'your-pr') {
    // a draft you opened is work in progress: yours until you hand it off
    if ((i.seen?.draft ?? it.isDraft) && !i.juniorPr) return null
    const line = i.seen ? babysitLine(i.seen) : it.ciFailing ? 'Fix the red checks.' : it.kind === 'own-pr-conflicting' ? 'Resolve the conflict.' : null
    if (line) return { playbook: 'babysit', head: 'I’d babysit it', would: line, tier: 2 }
    if (i.juniorPr) return { playbook: 'babysit', head: 'I’d babysit it', would: 'Keep it green, ask you before a reviewer.', tier: 3 }
    return null
  }

  if (it.reason === 'review-requested') {
    if (i.reviewed) return null
    return { playbook: 'review', head: 'I’d do a first pass', would: 'Read the diff, run it, draft notes for you.', tier: 1 }
  }

  const pb = i.rule?.playbook
  const start = pb ? STARTS[pb] : undefined
  if (!pb || !start) return null
  return { playbook: pb as SuggestPlaybook, ...start, tier: it.reason === 'asked' || it.peopleWaiting > 0 ? 1 : 4 }
}

/** How many the tab shows before "Show N more". */
export const SUGGEST_SHOWN = 5

/** The tab's order: tier, then the inbox's own score. */
export function bySuggestion<T extends { score: number; suggestion: Pick<Suggestion, 'tier'> }>(a: T, b: T): number {
  return a.suggestion.tier - b.suggestion.tier || b.score - a.score
}

// ---------- "Not this one", with a reason ----------
//
// After "Not this one" you can say why: not mine, too small, already handled
// (.docs/overnight-2026-10-24/designs/not-this-one-reasons.md). The reason is
// kept on the item. "Not mine" or "too small" said twice for the same repo and
// item kind, from two different items, stops Junior suggesting that kind in
// that repo: a suppression. "Already handled" never counts: it is about the
// item, not the kind. Items with no repo (Slack, Linear) keep the reason and
// never suppress. A suppressed item stays in your inbox; it just isn't
// suggested. No expiry: clearing one in Junior's notebook is the way back,
// and only reasons said after the clear count towards a new one.

export type NotNowReason = 'not-mine' | 'too-small' | 'handled'
export const NOT_NOW_REASONS: readonly NotNowReason[] = ['not-mine', 'too-small', 'handled']
export const isNotNowReason = (v: unknown): v is NotNowReason => typeof v === 'string' && (NOT_NOW_REASONS as readonly string[]).includes(v)

/** The reason in words, lower case: "you said too small twice", "Got it: already handled." */
export const REASON_WORDS: Record<NotNowReason, string> = { 'not-mine': 'not mine', 'too-small': 'too small', handled: 'already handled' }

/** The reason on an item, and when you said it (ISO). */
export type NotNowMark = { reason: NotNowReason; at: string }

/** How many different items need the same reason before the kind is suppressed. */
export const SUPPRESS_AFTER = 2

export type Suppression = {
  /** `acme/web·review-requested` */
  key: string
  repo: string
  kind: string
  reason: Exclude<NotNowReason, 'handled'>
  /** when the second matching reason was said, ISO */
  since: string
  /** the items whose reasons made it */
  items: string[]
}

export type SuppressState = {
  suppressions: Suppression[]
  /** key → when you last cleared it, ISO: only reasons said after count again */
  cleared: Record<string, string>
}

/** The config key the suppressions live under, one value per workspace. */
export const SUPPRESS_KEY = 'suggest.suppressions'

export const EMPTY_SUPPRESS: SuppressState = { suppressions: [], cleared: {} }

export const suppressKey = (repo: string, kind: string) => `${repo}·${kind}`

/** The repo a suppression is keyed on: an `owner/name` home, lower case; null for Slack and anything without one. */
export function suppressRepo(i: { source?: string; repo?: string | null }): string | null {
  if (i.source === 'slack') return null
  const r = (i.repo ?? '').trim().toLowerCase()
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** The stored config value, read leniently: anything malformed is dropped, never thrown. */
export function readSuppressState(raw: unknown): SuppressState {
  const r = (raw ?? {}) as { suppressions?: unknown; cleared?: unknown }
  const suppressions: Suppression[] = []
  for (const x of Array.isArray(r.suppressions) ? r.suppressions : []) {
    const s = x as Partial<Suppression>
    if (typeof s.repo !== 'string' || typeof s.kind !== 'string' || (s.reason !== 'not-mine' && s.reason !== 'too-small') || !isIso(s.since)) continue
    const key = suppressKey(s.repo, s.kind)
    if (suppressions.some((o) => o.key === key)) continue
    suppressions.push({ key, repo: s.repo, kind: s.kind, reason: s.reason, since: s.since, items: Array.isArray(s.items) ? s.items.filter((i): i is string => typeof i === 'string') : [] })
  }
  const cleared: Record<string, string> = {}
  if (r.cleared && typeof r.cleared === 'object') for (const [k, v] of Object.entries(r.cleared as Record<string, unknown>)) if (isIso(v)) cleared[k] = v
  return { suppressions, cleared }
}

/** The keys in force, for suggestionFor. */
export const suppressedKeys = (s: SuppressState): Set<string> => new Set(s.suppressions.map((x) => x.key))

/** An item as the suppression rule reads it. */
export type MarkedItem = { id: string; source?: string; repo?: string; kind: string; notNowReason?: NotNowMark }

/**
 * After a reason is said on `itemId` (already written on it in `items`): the
 * new state, and the suppression it made, when it made one. Deterministic:
 * the same items and state always give the same answer.
 */
export function afterReason(state: SuppressState, items: readonly MarkedItem[], itemId: string): { state: SuppressState; made: Suppression | null } {
  const same = { state, made: null }
  const it = items.find((i) => i.id === itemId)
  const mark = it?.notNowReason
  if (!it || !mark || mark.reason === 'handled') return same
  const repo = suppressRepo(it)
  if (!repo) return same
  const key = suppressKey(repo, it.kind)
  if (state.suppressions.some((s) => s.key === key)) return same
  const after = state.cleared[key]
  const matching = items.filter((i) => i.kind === it.kind && suppressRepo(i) === repo && i.notNowReason?.reason === mark.reason && (!after || i.notNowReason.at > after))
  const ids = [...new Set(matching.map((i) => i.id))].sort()
  if (ids.length < SUPPRESS_AFTER) return same
  const since = matching.map((i) => i.notNowReason!.at).reduce((a, b) => (b > a ? b : a))
  const made: Suppression = { key, repo, kind: it.kind, reason: mark.reason, since, items: ids }
  return { state: { ...state, suppressions: [made, ...state.suppressions] }, made }
}

/** Clear one: Junior suggests that kind in that repo again. Reasons said before `now` stop counting. */
export function clearSuppression(state: SuppressState, key: string, now: string): { state: SuppressState; removed: Suppression | null } {
  const removed = state.suppressions.find((s) => s.key === key) ?? null
  if (!removed) return { state, removed: null }
  return { state: { suppressions: state.suppressions.filter((s) => s.key !== key), cleared: { ...state.cleared, [key]: now } }, removed }
}
