/**
 * Today — the inbox's default view: only what you must see, most urgent
 * first (.docs/work-item-model.md). Pure, browser-safe; time is an argument.
 *
 *   1. Due or overdue        a day you or the source set, today or past
 *   2. People waiting on you human asks (reviews, replies, decisions), oldest first
 *   3. Ready for approval    briefs to dispatch, results to review, PRs to merge
 *   4. Something broke       red CI, failed briefs and sessions, stuck waits
 *   5. New and updated       arrived or moved in the last day
 *
 * Each item lands once, in its highest section. Only items on your turn make
 * it — plus anything broken, and waits on others that have gone on too long.
 */
import { dueOf } from './due.js'
import { isStuck, type ItemFlow } from './flow.js'
import type { Label } from './labels.js'
import type { WorkItem } from './types.js'

export type TodaySection = 'due' | 'waiting' | 'approval' | 'broke' | 'fresh'
export const TODAY_SECTIONS: readonly TodaySection[] = ['due', 'waiting', 'approval', 'broke', 'fresh']

export const TODAY_TITLE: Record<TodaySection, string> = {
  due: 'Due or overdue',
  waiting: 'People waiting on you',
  approval: 'Ready for your approval',
  broke: 'Something broke',
  fresh: 'New and updated',
}

export type TodayItem = Pick<
  WorkItem,
  'id' | 'source' | 'peopleWaiting' | 'createdAt' | 'updatedAt' | 'ingestedAt' | 'dueAt' | 'dueSource'
> & { label: Label; score: number; flow?: ItemFlow }

export interface TodayEntry<T> {
  item: T
  /** New: arrived in the last day. Updated: an older item with fresh activity. */
  badge?: 'new' | 'updated'
  /** a wait on someone else that has gone on too long — offer a nudge */
  stuck?: boolean
}

const DAY = 86_400_000
const HUMAN_ASKS: ReadonlySet<Label> = new Set(['review', 'reply', 'decide'])

const ms = (iso: string): number => Date.parse(iso) || 0

/** Someone, not something, is waiting on you. A to-do you wrote yourself isn't one. */
export function isHumanAsk(item: TodayItem): boolean {
  if (item.source === 'manual') return false
  return item.peopleWaiting > 0 || HUMAN_ASKS.has(item.label)
}

/** A day set by you or the source, today or earlier. A label's default is a bucket, not a deadline. */
function isDue(item: TodayItem, now: number): boolean {
  const d = dueOf(item, now)
  return d.source !== 'default' && d.at != null && d.section === 'today'
}

function freshness(item: TodayItem, now: number): 'new' | 'updated' | undefined {
  const arrived = item.ingestedAt ?? ms(item.createdAt)
  if (now - arrived < DAY) return 'new'
  if (now - ms(item.updatedAt) < DAY) return 'updated'
  return undefined
}

/** Which Today section an item belongs in, or null when Today doesn't show it. */
export function todaySectionOf(item: TodayItem, now: number): TodaySection | null {
  const flow = item.flow
  if (!flow) return null
  const mine = flow.turn === 'me'
  if (mine && isDue(item, now)) return 'due'
  // An action an agent queued is an approval, whoever asked for the item.
  if (mine && flow.ask === 'approve action') return 'approval'
  if (mine && isHumanAsk(item) && !flow.broken) return 'waiting'
  if (mine && !flow.broken && (flow.stage === 'ready' || flow.stage === 'review')) return 'approval'
  if (flow.broken || isStuck(flow, now)) return 'broke'
  if (mine && freshness(item, now)) return 'fresh'
  return null
}

/** The Today view: each section's entries in reading order; empty sections are absent. */
export function todaySections<T extends TodayItem>(items: readonly T[], now: number): Map<TodaySection, TodayEntry<T>[]> {
  const out = new Map<TodaySection, TodayEntry<T>[]>()
  for (const item of items) {
    const sec = todaySectionOf(item, now)
    if (!sec) continue
    const entry: TodayEntry<T> = { item }
    const badge = freshness(item, now)
    if (badge) entry.badge = badge
    if (item.flow && isStuck(item.flow, now)) entry.stuck = true
    const list = out.get(sec) ?? []
    list.push(entry)
    out.set(sec, list)
  }
  const byScore = (a: TodayEntry<T>, b: TodayEntry<T>) => b.item.score - a.item.score
  for (const [sec, list] of out) {
    if (sec === 'waiting') list.sort((a, b) => ms(a.item.createdAt) - ms(b.item.createdAt) || byScore(a, b))
    else if (sec === 'due') list.sort((a, b) => (a.item.dueAt ?? 0) - (b.item.dueAt ?? 0) || byScore(a, b))
    else list.sort(byScore)
  }
  return new Map(TODAY_SECTIONS.filter((s) => out.has(s)).map((s) => [s, out.get(s)!]))
}

/** "2d", "5h", "12m" — how long something has been waiting. */
export function waitedFor(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** The turn tabs beside Today. */
export type TurnTab = 'mine' | 'ai' | 'others' | 'all'

export function inTurnTab(item: Pick<TodayItem, 'flow'>, tab: TurnTab): boolean {
  if (tab === 'all') return true
  const turn = item.flow?.turn ?? 'me'
  return tab === 'mine' ? turn === 'me' : turn === tab
}
