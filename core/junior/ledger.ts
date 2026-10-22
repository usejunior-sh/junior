/**
 * The Junior page's Ledger (.docs/junior-goals-teams/junior-home-list.html,
 * artifact 065cfb8a v7): one line per row, who · title · Junior's state ·
 * where · age, under pill tabs.
 *
 *   needs     Needs you: Junior waiting on you. Items it is paused on or has a
 *             first pass ready for; the page puts the sessions, plans, gates
 *             and sends held on you (core/junior/needs.ts) above them
 *   up        Up next: the task list, everything else open, in the scorer's
 *             groups (core/work/score.ts): someone waiting · stuck · this
 *             cycle · FYI
 *   reviews   PRs asking for your review
 *   prs       your open PRs
 *   with      everything handed to Junior
 *   waiting   you are waiting on someone else
 *
 * Pure and browser-safe: the page renders what this decides.
 */
import type { Group, ScoredItem } from '../work/types.js'

export type LedgerTab = 'needs' | 'up' | 'reviews' | 'prs' | 'with' | 'waiting'
export type LedgerGroup = 'waiting' | 'stuck' | 'cycle' | 'fyi'

export const LEDGER_GROUPS: readonly LedgerGroup[] = ['waiting', 'stuck', 'cycle', 'fyi']

export const LEDGER_GROUP_TITLE: Record<LedgerGroup, string> = {
  waiting: 'Someone is waiting on you',
  stuck: 'Stuck',
  cycle: 'This cycle',
  fyi: 'For your info',
}

const OF_GROUP: Record<Group, LedgerGroup> = { blocking: 'waiting', 'blocked-stale': 'stuck', cycle: 'cycle', fyi: 'fyi' }

type Item = Pick<
  ScoredItem,
  'id' | 'kind' | 'reason' | 'group' | 'score' | 'handoff' | 'junior' | 'tasks' | 'suggestion' | 'flow' | 'peopleWaiting'
>

/** Where an item sits in Up next: the scorer's group. */
export const ledgerGroup = (i: Item): LedgerGroup => OF_GROUP[i.group]

/** Junior is waiting on you: paused on you, or its first pass waits for your OK. */
export const juniorWaits = (i: Item): boolean => i.junior?.stage === 'needs-you' || i.tasks?.review?.state === 'ready'

/** You are waiting on someone else: their turn, or your PR waiting on review. */
export const isWaitingOnOthers = (i: Item): boolean => i.flow?.turn === 'others' || i.kind === 'own-pr-open' || i.kind === 'own-pr-stale'

/** The rows a tab shows, in its order. */
export function ledgerRows<T extends Item>(items: readonly T[], tab: LedgerTab): T[] {
  const byScore = (a: T, b: T) => b.score - a.score
  switch (tab) {
    case 'needs':
      return items.filter(juniorWaits).sort(byScore)
    case 'up': {
      const at = (i: T) => LEDGER_GROUPS.indexOf(ledgerGroup(i))
      return items.filter((i) => i.kind !== 'digest' && !juniorWaits(i)).sort((a, b) => at(a) - at(b) || byScore(a, b))
    }
    case 'reviews':
      return items.filter((i) => i.reason === 'review-requested').sort((a, b) => Number(b.tasks?.review?.state === 'ready') - Number(a.tasks?.review?.state === 'ready') || byScore(a, b))
    case 'prs':
      return items.filter((i) => i.reason === 'your-pr').sort((a, b) => Number(b.junior?.stage === 'needs-you') - Number(a.junior?.stage === 'needs-you') || byScore(a, b))
    case 'with': {
      const order = ['needs-you', 'working', 'watching', 'paused', 'handed-in']
      return items.filter((i) => i.junior).sort((a, b) => order.indexOf(a.junior!.stage) - order.indexOf(b.junior!.stage) || byScore(a, b))
    }
    case 'waiting':
      return items.filter(isWaitingOnOthers).sort(byScore)
  }
}

/** A tab's count, and how many of those wait on you (orange): all of Needs you, a person on the rest. */
export function ledgerCount(items: readonly Item[], tab: LedgerTab): { n: number; hot: number } {
  const rows = ledgerRows(items, tab)
  if (tab === 'needs') return { n: rows.length, hot: rows.length }
  return { n: rows.length, hot: tab === 'waiting' || tab === 'with' ? rows.filter(juniorWaits).length : rows.filter((i) => personWaits(i) && !juniorWaits(i)).length }
}

/** A person waits on you: the age column turns orange. Junior waiting on you does not. */
export const personWaits = (i: Item): boolean => i.group === 'blocking' && i.junior?.stage !== 'needs-you'

/**
 * Junior's state in a word or two, in sky; `quiet` greys it out (nothing for
 * you to do there). Empty when Junior has nothing to say about the item.
 */
export function juniorState(i: Item): { text: string; quiet: boolean } {
  const say = (text: string, quiet = false) => ({ text, quiet })
  if (i.handoff === 'paused' || i.junior?.stage === 'paused') return say('Paused', true)
  if (i.junior?.stage === 'needs-you') return say('Paused on you')
  const r = i.tasks?.review
  if (r) {
    if (r.state === 'queued') return say('Queued', true)
    if (r.state === 'reviewing') return say('Reading')
    if (r.state === 'ready') return say('First pass ready')
    if (r.state === 'posted') return say('Posted', true)
    if (r.state === 'failed') return say('Stuck')
    return say('Set aside', true)
  }
  if (i.junior?.stage === 'working') return say('Working')
  if (i.junior?.stage === 'watching') return say(i.reason === 'your-pr' ? 'Babysitting' : 'Watching', true)
  if (i.junior?.stage === 'handed-in') return say('Handed in', true)
  if (i.handoff === 'on') return say('On it')
  if (i.suggestion) return say(i.suggestion.playbook === 'babysit' ? 'Can babysit' : i.suggestion.playbook === 'review' ? 'Can first-pass' : 'Can take')
  return say('', true)
}

/** Plan → approve → work → draft PR → babysit, as a share of the way; null without a pipeline. */
export const ledgerProgress = (i: Item): number | null => (i.junior?.pipeline && i.junior.stage === 'working' ? Math.min(1, i.junior.pipeline.done / 5) : null)
