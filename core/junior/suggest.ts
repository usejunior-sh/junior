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
 * to and nothing changed since, an FYI.
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
}

const STARTS: Partial<Record<Playbook, { head: string; would: string }>> = {
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
