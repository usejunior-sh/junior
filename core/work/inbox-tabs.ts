/**
 * The inbox tabs — the sidebar beside the inbox, one tab per step of the
 * pipeline (.docs/work-item-model.md). Pure, browser-safe; time is an argument.
 *
 *   1. Needs you now      a blocked agent: a session on a prompt, an action or
 *                         step to approve, a paused team — or something broke
 *   2. Due                your turn, and a day you or the source set is today or past
 *   3. People waiting     your turn, and a person asked: reviews, replies, decisions
 *   4. New                your turn, arrived in the last day
 *   5. Brief ready        a brief (or a team proposal) waits on you
 *   6. AI working         briefing, a session running, a team running
 *   7. To review          a session or team finished, your PR to merge
 *   8. Waiting on others  your PR with reviewers, follow-ups, your own overrides
 *   9. Backlog            everything else open: older new items
 *
 * Every open item is in exactly one tab, and the first rule that matches wins,
 * so the counts add up. Snoozed and Archived are the item's status, not a rule.
 */
import { dueOf } from './due.js'
import { isStuck, type ItemFlow } from './flow.js'
import type { Label } from './labels.js'
import type { WorkItem } from './types.js'

export type OpenTab = 'needs' | 'due' | 'people' | 'new' | 'ready' | 'ai' | 'review' | 'others' | 'backlog'
export type StatusTab = 'snoozed' | 'archived' | 'done'
export type InboxTab = OpenTab | StatusTab

export const OPEN_TABS: readonly OpenTab[] = ['needs', 'due', 'people', 'new', 'ready', 'ai', 'review', 'others', 'backlog']
export const STATUS_TABS: readonly StatusTab[] = ['snoozed', 'archived', 'done']
export const DEFAULT_TAB: OpenTab = 'needs'

export const TAB_TITLE: Record<InboxTab, string> = {
  needs: 'Needs you now',
  due: 'Due',
  people: 'People waiting',
  new: 'New',
  ready: 'Brief ready',
  ai: 'AI working',
  review: 'To review',
  others: 'Waiting on others',
  backlog: 'Backlog',
  snoozed: 'Snoozed',
  archived: 'Archived',
  done: 'Done',
}

export const isInboxTab = (v: unknown): v is InboxTab =>
  typeof v === 'string' && ((OPEN_TABS as readonly string[]).includes(v) || (STATUS_TABS as readonly string[]).includes(v))
export const isOpenTab = (t: InboxTab): t is OpenTab => (OPEN_TABS as readonly string[]).includes(t)

export type TabItem = Pick<
  WorkItem,
  'id' | 'source' | 'peopleWaiting' | 'createdAt' | 'updatedAt' | 'ingestedAt' | 'dueAt' | 'dueSource'
> & { label: Label; score: number; flow?: ItemFlow; linked?: { id: string }[] }

/** A session held on a prompt — reduced to what the tab reads. */
export interface BlockedSession {
  id: string
  /** the item it was dispatched for */
  itemId?: string
  updatedAt: number
}

export interface TabEntry<T> {
  item: T
  /** New: arrived in the last day. Updated: an older item with fresh activity. */
  badge?: 'new' | 'updated'
  /** a wait on someone else that has gone on too long — offer a nudge */
  stuck?: boolean
}

export interface InboxTabs<T, S> {
  /** each open tab's entries in reading order; every tab is present, empty or not */
  tabs: Map<OpenTab, TabEntry<T>[]>
  /** blocked sessions under the row they belong to, keyed by the row's id */
  sessionsByRow: Map<string, S[]>
  /** blocked sessions whose item isn't an open row — each its own row in Needs you now */
  orphans: S[]
  /** rows per tab; Needs you now counts its orphan sessions too */
  counts: Record<OpenTab, number>
}

const DAY = 86_400_000
const HUMAN_ASKS: ReadonlySet<Label> = new Set(['review', 'reply', 'decide'])
/** Asks that hold an agent until you answer: they jump the queue. */
const BLOCKING_ASKS: ReadonlySet<string> = new Set(['approve action', 'approve the step', 'resume the team', 'answer the session'])

const ms = (iso: string): number => Date.parse(iso) || 0

/** Someone, not something, is waiting on you. A to-do you wrote yourself isn't one. */
export function isHumanAsk(item: TabItem): boolean {
  if (item.source === 'manual') return false
  return item.peopleWaiting > 0 || HUMAN_ASKS.has(item.label)
}

/** A day set by you or the source, today or earlier. A label's default is a bucket, not a deadline. */
export function isDue(item: TabItem, now: number): boolean {
  const d = dueOf(item, now)
  return d.source !== 'default' && d.at != null && d.section === 'today'
}

function freshness(item: TabItem, now: number): 'new' | 'updated' | undefined {
  if (now - arrivedAt(item) < DAY) return 'new'
  if (now - ms(item.updatedAt) < DAY) return 'updated'
  return undefined
}

const arrivedAt = (item: TabItem) => item.ingestedAt ?? ms(item.createdAt)

/**
 * Which open tab an item belongs in. `blocked` = a session dispatched for it
 * (any of them, not only the newest) is on a prompt.
 */
export function inboxTabOf(item: TabItem, now: number, blocked = false): OpenTab {
  const f: ItemFlow = item.flow ?? { stage: 'new', turn: 'me', since: arrivedAt(item) }
  const mine = f.turn === 'me'
  if (blocked || f.broken || (mine && f.ask && BLOCKING_ASKS.has(f.ask))) return 'needs'
  if (mine && isDue(item, now)) return 'due'
  if (mine && isHumanAsk(item)) return 'people'
  if (mine && f.stage === 'new' && now - arrivedAt(item) < DAY) return 'new'
  if (mine && f.stage === 'ready') return 'ready'
  if (f.turn === 'ai') return 'ai'
  if (mine && f.stage === 'review') return 'review'
  if (f.turn === 'others') return 'others'
  return 'backlog'
}

/** Sort every open row and blocked session into its tab. */
export function inboxTabs<T extends TabItem, S extends BlockedSession>(
  items: readonly T[],
  sessions: readonly S[],
  now: number,
): InboxTabs<T, S> {
  // A row folds linked items (link.ts); a session on any of them is the row's.
  const rowOf = new Map<string, string>()
  for (const i of items) {
    rowOf.set(i.id, i.id)
    for (const l of i.linked ?? []) if (!rowOf.has(l.id)) rowOf.set(l.id, i.id)
  }
  const sessionsByRow = new Map<string, S[]>()
  const orphans: S[] = []
  for (const s of [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)) {
    const row = s.itemId ? rowOf.get(s.itemId) : undefined
    if (!row) orphans.push(s)
    else sessionsByRow.set(row, [...(sessionsByRow.get(row) ?? []), s])
  }

  const tabs = new Map<OpenTab, TabEntry<T>[]>(OPEN_TABS.map((t) => [t, []]))
  for (const item of items) {
    const entry: TabEntry<T> = { item }
    const badge = freshness(item, now)
    if (badge) entry.badge = badge
    if (item.flow && isStuck(item.flow, now)) entry.stuck = true
    tabs.get(inboxTabOf(item, now, sessionsByRow.has(item.id)))!.push(entry)
  }

  const byScore = (a: TabEntry<T>, b: TabEntry<T>) => b.item.score - a.item.score
  for (const [tab, list] of tabs) {
    if (tab === 'people') list.sort((a, b) => ms(a.item.createdAt) - ms(b.item.createdAt) || byScore(a, b))
    else if (tab === 'due') list.sort((a, b) => (a.item.dueAt ?? 0) - (b.item.dueAt ?? 0) || byScore(a, b))
    else list.sort(byScore)
  }

  const counts = Object.fromEntries(OPEN_TABS.map((t) => [t, tabs.get(t)!.length])) as Record<OpenTab, number>
  counts.needs += orphans.length
  return { tabs, sessionsByRow, orphans, counts }
}

/** "2d", "5h", "12m" — how long something has been waiting. */
export function waitedFor(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
