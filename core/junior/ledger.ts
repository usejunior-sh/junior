/**
 * The Junior page's Ledger (.docs/junior-goals-teams/junior-home-list.html,
 * artifact 065cfb8a v7): one line per row, who · title · Junior's state ·
 * where · age, under pill tabs.
 *
 *   needs     Needs you: Junior waiting on you. Items it is paused on or has a
 *             first pass ready for; the page puts the sessions, plans, gates
 *             and sends held on you (core/junior/needs.ts) above them. An
 *             item you marked "not useful" leaves until something new
 *             happens on it (`quieted`), and reads in Up next meanwhile
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
import { watchFor, type WatchId } from '../work/handoff.js'
import { WATCH_CANT_CHIP, WATCH_OFF_CHIP } from './watch-off.js'
import { readyLine, type Readiness } from '../babysit/ready.js'

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
  'id' | 'kind' | 'reason' | 'group' | 'score' | 'handoff' | 'junior' | 'tasks' | 'suggestion' | 'flow' | 'peopleWaiting' | 'updatedAt' | 'notUseful' | 'seen'
>

/** Where an item sits in Up next: the scorer's group. */
export const ledgerGroup = (i: Item): LedgerGroup => OF_GROUP[i.group]

/** Junior is waiting on you: paused on you, or its first pass waits for your OK. */
export const juniorWaits = (i: Pick<Item, 'junior' | 'tasks'>): boolean => i.junior?.stage === 'needs-you' || i.tasks?.review?.state === 'ready'

/**
 * What Junior waits on you for, in a word: the task it paused on, a first pass
 * waiting for your OK, or nothing. A new question from Junior is new, even if
 * nothing changed at the source.
 */
export const waitKeyOf = (i: Pick<Item, 'tasks'>): string =>
  i.tasks?.next ? `next:${i.tasks.next.id}` : i.tasks?.review?.state === 'ready' ? 'review' : ''

/** What "not useful" stamps on the item: its source time and what Junior waits on. Either moving is "something new". */
export const quietKey = (i: Pick<Item, 'updatedAt' | 'tasks'>): string => `${i.updatedAt}|${waitKeyOf(i)}`

/** You marked it not useful, and nothing new has happened on it since. */
export const quieted = (i: Pick<Item, 'updatedAt' | 'tasks' | 'notUseful'>): boolean => !!i.notUseful && i.notUseful === quietKey(i)

/** How long "Marked not useful · Undo" holds the row's slot when you don't touch it. */
export const NOT_USEFUL_NOTICE_MS = 5_000
/**
 * Hover or focus holds the notice (WCAG 2.2.1), but never past this many ms
 * after the mark: an Undo on screen must still be one the server takes.
 */
export const NOT_USEFUL_HOLD_MAX_MS = 50_000
/** How long after a mark the server takes its undo: the longest hold, plus slack for the round trip. */
export const NOT_USEFUL_UNDO_MS = 60_000

/** On Needs you: Junior waits on you, and you haven't marked it not useful since the last new thing. */
export const onNeeds = (i: Pick<Item, 'junior' | 'tasks' | 'updatedAt' | 'notUseful'>): boolean => juniorWaits(i) && !quieted(i)

/** You are waiting on someone else: their turn, or your PR waiting on review. */
export const isWaitingOnOthers = (i: Item): boolean => i.flow?.turn === 'others' || i.kind === 'own-pr-open' || i.kind === 'own-pr-stale'

/** The rows a tab shows, in its order. */
export function ledgerRows<T extends Item>(items: readonly T[], tab: LedgerTab): T[] {
  const byScore = (a: T, b: T) => b.score - a.score
  switch (tab) {
    case 'needs':
      return items.filter(onNeeds).sort(byScore)
    case 'up': {
      const at = (i: T) => LEDGER_GROUPS.indexOf(ledgerGroup(i))
      // a quieted item is moved here, not hidden
      return items.filter((i) => i.kind !== 'digest' && !onNeeds(i)).sort((a, b) => at(a) - at(b) || byScore(a, b))
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

/**
 * A tab's count, and how many of those wait on you (orange): all of Needs you,
 * a person on the rest. Nothing marked not useful counts as orange.
 */
export function ledgerCount(items: readonly Item[], tab: LedgerTab): { n: number; hot: number } {
  const rows = ledgerRows(items, tab)
  if (tab === 'needs') return { n: rows.length, hot: rows.length }
  return { n: rows.length, hot: tab === 'waiting' || tab === 'with' ? rows.filter(onNeeds).length : rows.filter((i) => personWaits(i) && !juniorWaits(i)).length }
}

/** A person waits on you: the age column turns orange. Junior waiting on you does not. */
export const personWaits = (i: Item): boolean => i.group === 'blocking' && i.junior?.stage !== 'needs-you'

/** The row's age reads orange: a person waits, it's in their group, and you haven't marked it not useful. */
export const ageHot = (i: Item): boolean => personWaits(i) && ledgerGroup(i) === 'waiting' && !quieted(i)

/**
 * The handed-off PR waits on a switched-off watch: nothing will run on it
 * until you turn `watch` on. Only where that is the whole story: Junior has
 * nothing under way (watching), or only a first pass queued behind the switch.
 * Paused, needs-you and anything actually running say their own thing.
 */
export function watchOffOf(i: Item): WatchId | null {
  const r = i.junior?.readiness
  if (i.handoff !== 'on' || r?.state !== 'watch-off') return null
  return idleBehindSwitch(i) ? r.watch : null
}

/** A handed-off PR no watch can read (it didn't come from GitHub): nothing will ever run on it. */
export function cantWatchOf(i: Item): WatchId | null {
  if (i.handoff !== 'on' || i.junior?.readiness?.state !== 'unsupported') return null
  return idleBehindSwitch(i) ? watchFor(i.reason) : null
}

const idleBehindSwitch = (i: Item): boolean => {
  if (i.junior?.stage === 'paused' || i.junior?.stage === 'needs-you') return false
  const review = i.tasks?.review
  return review ? review.state === 'queued' : i.junior?.stage === 'watching'
}

/**
 * The hand-back gate the babysit watch last read on your PR
 * (core/babysit/ready.ts): the open card's Ready line. Null on anything
 * that isn't your PR, or before the watch has read it.
 */
export const readyOf = (i: Pick<Item, 'reason' | 'seen'>): Readiness | null => (i.reason === 'your-pr' ? (i.seen?.ready ?? null) : null)

/**
 * Junior's state in a word or two, in sky; `quiet` greys it out (nothing for
 * you to do there). Empty when Junior has nothing to say about the item.
 * `ready` is set on a PR Junior watches whose gate it has read: the row draws
 * it as a pill, and `text` is the full line for the row's accessible name.
 */
export function juniorState(i: Item): { text: string; quiet: boolean; ready?: Readiness } {
  const say = (text: string, quiet = false) => ({ text, quiet })
  if (i.handoff === 'paused' || i.junior?.stage === 'paused') return say('Paused', true)
  if (i.junior?.stage === 'needs-you') return say('Paused on you')
  // a switched-off watch, never "Babysitting": nothing will run until you turn it on
  const off = watchOffOf(i)
  if (off) return say(WATCH_OFF_CHIP[off], true)
  const cant = cantWatchOf(i)
  if (cant) return say(WATCH_CANT_CHIP[cant], true)
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
  if (i.junior?.stage === 'watching') {
    const ready = readyOf(i)
    if (ready) return { text: readyLine(ready), quiet: !ready.ready, ready }
    return say(i.reason === 'your-pr' ? 'Babysitting' : 'Watching', true)
  }
  if (i.junior?.stage === 'handed-in') return say('Handed in', true)
  if (i.handoff === 'on') return say('On it')
  if (i.suggestion) return say(i.suggestion.playbook === 'babysit' ? 'Can babysit' : i.suggestion.playbook === 'review' ? 'Can first-pass' : 'Can take')
  return say('', true)
}

/** Plan → approve → work → draft PR → babysit, as a share of the way; null without a pipeline. */
export const ledgerProgress = (i: Item): number | null => (i.junior?.pipeline && i.junior.stage === 'working' ? Math.min(1, i.junior.pipeline.done / 5) : null)
