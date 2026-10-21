/**
 * The inbox views: one list of every work item, cut four ways (Triage for
 * engineers, M0). Replaces the nine stage tabs as what the inbox shows; the
 * tabs (inbox-tabs.ts) still order the rows, so what is held on you, due or
 * waited on by a person still reads first. Pure, browser-safe.
 *
 *   Not started   open, and nobody has started on it: new, briefing, brief ready
 *   In progress   open, and work has begun: a chat or team on it, a result or
 *                 your PR in review, or a session held on you
 *   Done          its status is done
 *   All           the open items, then the done ones
 *
 * Snoozed and Archived are statuses, not views: the panel links to them quietly.
 */
import type { ItemFlow } from './flow.js'
import { OPEN_TABS, type InboxTab, type InboxTabs, type TabEntry, type TabItem } from './inbox-tabs.js'

export type OpenView = 'todo' | 'doing'
export type InboxView = OpenView | 'done' | 'all'
/** Where an inbox route can point: a view, or one of the two parked statuses. */
export type InboxRoute = InboxView | 'snoozed' | 'archived'

export const INBOX_VIEWS: readonly InboxView[] = ['todo', 'doing', 'done', 'all']

export const VIEW_TITLE: Record<InboxRoute, string> = {
  todo: 'Not started',
  doing: 'In progress',
  done: 'Done',
  all: 'All',
  snoozed: 'Snoozed',
  archived: 'Archived',
}

const ROUTES: readonly string[] = [...INBOX_VIEWS, 'snoozed', 'archived']

/** The stage tabs before the views: an old `#/inbox/<tab>` link lands on the view it now sits in. */
const LEGACY: Partial<Record<InboxTab, InboxRoute>> = {
  needs: 'doing',
  ai: 'doing',
  review: 'doing',
  others: 'doing',
  due: 'todo',
  people: 'todo',
  new: 'todo',
  ready: 'todo',
  backlog: 'todo',
}

/** An inbox route's segment, read from a URL; old tab names map to their view, anything else is undefined. */
export function parseInboxRoute(v: string): InboxRoute | undefined {
  if (ROUTES.includes(v)) return v as InboxRoute
  return LEGACY[v as InboxTab]
}

export const isOpenView = (v: InboxRoute): v is OpenView | 'all' => v === 'todo' || v === 'doing' || v === 'all'

/** Work has begun on it: past the brief, or a session dispatched for it is held on you. */
export function isStarted(flow: ItemFlow | undefined, blocked = false): boolean {
  if (blocked) return true
  const stage = flow?.stage ?? 'new'
  return stage === 'working' || stage === 'review'
}

export interface InboxViews<T> {
  todo: TabEntry<T>[]
  doing: TabEntry<T>[]
}

/** Split the open rows into Not started and In progress, keeping the tabs' reading order. */
export function inboxViews<T extends TabItem, S>(tabs: InboxTabs<T, S>): InboxViews<T> {
  const out: InboxViews<T> = { todo: [], doing: [] }
  for (const tab of OPEN_TABS) {
    for (const e of tabs.tabs.get(tab) ?? []) {
      out[isStarted(e.item.flow, tabs.sessionsByRow.has(e.item.id)) ? 'doing' : 'todo'].push(e)
    }
  }
  return out
}
