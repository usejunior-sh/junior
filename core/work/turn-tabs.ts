/**
 * Fewer tabs, same words: the Junior page's six ledger tabs folded into the
 * three turns (turn.ts), with Up next, Reviews and My PRs as filters inside
 * them. Pure, browser-safe, no time.
 *
 *   needs     Needs you     turnOf says the ball is with you
 *   with      With Junior   Junior holds it, nothing pings you
 *   waiting   Waiting       a person, a reviewer, the world or the clock
 *
 * Every item lands in exactly one tab, because turnOf gives every item
 * exactly one turn. The labels are today's (turn.ts TURN_TAB_LABEL): no
 * rename to You / Junior / Others.
 *
 * The filters keep today's tab rules (core/junior/ledger.ts), so an item
 * keeps its Reviews or My PRs filter in whichever tab it lands in:
 *
 *   up-next   today's Up next: open, not a digest, Junior isn't waiting on you
 *   reviews   a PR asking for your review
 *   my-prs    your own PR (a dead one shows in the ledger's Close? group)
 *
 * An item you marked "not useful" stays in Needs you if it is your turn (it
 * is attention, not turn), but sorts last and never counts toward the tab's
 * orange count, and the Up next filter keeps it as today's Up next tab does.
 *
 * Callers pass open items. A snoozed or closed one still gets an answer
 * (Waiting, as turnOf reads it) so the mapping stays total.
 */
import { onNeeds, quieted, type LedgerTab } from '../junior/ledger.js'
import { TURN_TAB_LABEL, turnOf, type TurnContext, type TurnItem, type TurnOf, type WhoseTurn } from './turn.js'
import type { ScoredItem } from './types.js'

export type TurnTab = 'needs' | 'with' | 'waiting'
export const TURN_TABS: readonly TurnTab[] = ['needs', 'with', 'waiting']

export type TurnFilter = 'up-next' | 'reviews' | 'my-prs'
export const TURN_FILTERS: readonly TurnFilter[] = ['up-next', 'reviews', 'my-prs']

/** The tab each turn shows on. The ids are the ledger's, so old links to them still mean the same tab. */
export const TAB_OF_TURN: Record<WhoseTurn, TurnTab> = { you: 'needs', junior: 'with', others: 'waiting' }

/** The tab labels, read from turn.ts so the two can't drift. */
export const TURN_TAB_TITLE: Record<TurnTab, string> = {
  needs: TURN_TAB_LABEL.you,
  with: TURN_TAB_LABEL.junior,
  waiting: TURN_TAB_LABEL.others,
}

/** The filter pill labels: today's tab names. */
export const TURN_FILTER_TITLE: Record<TurnFilter, string> = {
  'up-next': 'Up next',
  reviews: 'Reviews',
  'my-prs': 'My PRs',
}

/** What the mapping reads off an item: what turnOf reads, plus what the filters read. */
export type TurnTabItem = TurnItem & Pick<ScoredItem, 'reason' | 'updatedAt'> & Partial<Pick<ScoredItem, 'notUseful' | 'close'>>

export interface TabOf extends TurnOf {
  tab: TurnTab
}

/** Which of the three tabs an item is on, with the turn and reason that put it there. */
export function tabOf(item: TurnTabItem, ctx: TurnContext = {}): TabOf {
  const t = turnOf(item, ctx)
  return { ...t, tab: TAB_OF_TURN[t.turn] }
}

/** Which filters apply to an item, in TURN_FILTERS order. Independent of its tab. */
export function filtersOf(item: TurnTabItem): TurnFilter[] {
  const out: TurnFilter[] = []
  // a dead PR (core/work/close.ts) leaves Up next; My PRs keeps it, in its Close? group
  if (item.kind !== 'digest' && !onNeeds(item) && !item.close) out.push('up-next')
  if (item.reason === 'review-requested') out.push('reviews')
  if (item.reason === 'your-pr') out.push('my-prs')
  return out
}

export const hasFilter = (item: TurnTabItem, filter: TurnFilter): boolean => filtersOf(item).includes(filter)

export interface TurnTabs<T> {
  /** each tab's items in reading order; every tab is present, empty or not */
  tabs: Record<TurnTab, T[]>
  /** rows per tab */
  counts: Record<TurnTab, number>
  /** the one count the page shows: Needs you, less what you marked not useful. Orange above zero */
  needsCount: number
}

/**
 * Sort open items into the three tabs. `ctxOf` supplies what an item can't
 * say about itself (a blocked session, held sends, its newest message).
 * Order within a tab: score, highest first; in Needs you, quieted items last.
 */
export function turnTabs<T extends TurnTabItem & { score: number }>(
  items: readonly T[],
  ctxOf: (item: T) => TurnContext | undefined = () => undefined,
): TurnTabs<T> {
  const tabs: Record<TurnTab, T[]> = { needs: [], with: [], waiting: [] }
  for (const i of items) tabs[tabOf(i, ctxOf(i) ?? {}).tab].push(i)
  const byScore = (a: T, b: T) => b.score - a.score
  tabs.with.sort(byScore)
  tabs.waiting.sort(byScore)
  tabs.needs.sort((a, b) => Number(quieted(a)) - Number(quieted(b)) || byScore(a, b))
  return {
    tabs,
    counts: { needs: tabs.needs.length, with: tabs.with.length, waiting: tabs.waiting.length },
    needsCount: tabs.needs.filter((i) => !quieted(i)).length,
  }
}

/** A tab's rows with a filter applied, or all of them. */
export function filterRows<T extends TurnTabItem>(rows: readonly T[], filter?: TurnFilter | null): T[] {
  return filter ? rows.filter((i) => hasFilter(i, filter)) : [...rows]
}

/**
 * Where an old ledger tab opens in the three-tab layout, so links and
 * keyboard routes still resolve. Up next, Reviews and My PRs become a filter;
 * they open on Needs you, where their rows that need you are.
 */
export const LEDGER_TAB_ROUTE: Record<LedgerTab, { tab: TurnTab; filter?: TurnFilter }> = {
  needs: { tab: 'needs' },
  up: { tab: 'needs', filter: 'up-next' },
  reviews: { tab: 'needs', filter: 'reviews' },
  prs: { tab: 'needs', filter: 'my-prs' },
  with: { tab: 'with' },
  waiting: { tab: 'waiting' },
}

/** How many of a tab's rows each filter keeps: the pills' counts. */
export function filterCounts<T extends TurnTabItem>(rows: readonly T[]): Record<TurnFilter, number> {
  const out: Record<TurnFilter, number> = { 'up-next': 0, reviews: 0, 'my-prs': 0 }
  // the My PRs pill counts active PRs only: the Close? group never adds to it
  for (const i of rows) for (const f of filtersOf(i)) if (!(f === 'my-prs' && i.close)) out[f]++
  return out
}

/**
 * Where an old ledger tab's link lands, given today's rows. Up next, Reviews
 * and My PRs open on Needs you with that filter (LEDGER_TAB_ROUTE); when the
 * filter keeps nothing there, the first tab, in order, where it keeps
 * something. Nowhere: Needs you, filter on, its empty line.
 */
export function openTurnTab<T extends TurnTabItem>(from: LedgerTab, tabs: Readonly<Record<TurnTab, readonly T[]>>): { tab: TurnTab; filter: TurnFilter | null } {
  const r = LEDGER_TAB_ROUTE[from]
  const filter = r.filter ?? null
  if (!filter) return { tab: r.tab, filter }
  const has = (t: TurnTab) => tabs[t].some((i) => hasFilter(i, filter))
  if (has(r.tab)) return { tab: r.tab, filter }
  return { tab: TURN_TABS.find(has) ?? r.tab, filter }
}
