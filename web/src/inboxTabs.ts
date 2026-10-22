/**
 * The inbox tabs (core/work/inbox-tabs.ts) over the shared inbox snapshot and
 * the live session list, and the views cut from them (core/work/inbox-views.ts),
 * read by both the sidebar and the inbox page, so the counts beside a view are
 * always the rows under it.
 */
import { useMemo } from 'react'
import type { ScoredItem, SessionSummary } from '../../shared/protocol.js'
import { inboxTabs, type InboxTabs } from '../../core/work/inbox-tabs.js'
import { inboxViews, isStarted, type InboxRoute, type InboxViews, type OpenView } from '../../core/work/inbox-views.js'
import { useSessions } from './hooks.js'
import { useInbox } from './inboxStore.js'

export type Tabs = InboxTabs<ScoredItem, SessionSummary>

export function useInboxTabs(): Tabs {
  const snap = useInbox()
  const sessions = useSessions()
  // The session list rebroadcasts on every status change; re-key on who is blocked.
  const key = sessions
    .filter((s) => s.waiting)
    .map((s) => `${s.id}:${s.itemId ?? ''}:${s.waitingOn ?? ''}`)
    .join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const blocked = useMemo(() => sessions.filter((s) => s.waiting), [key])
  return useMemo(() => inboxTabs(snap.items, blocked, Date.now()), [snap.items, blocked])
}

export type Views = InboxViews<ScoredItem>

export function useInboxViews(tabs: Tabs): Views {
  return useMemo(() => inboxViews(tabs), [tabs])
}

/** The view a bare `#/inbox` opens: In progress when something there is held on you, else Not started. */
export function resolveView(view: InboxRoute | undefined, tabs: Tabs): InboxRoute {
  if (view) return view
  const held = tabs.orphans.length > 0 || (tabs.tabs.get('needs') ?? []).some((e) => isStarted(e.item.flow, tabs.sessionsByRow.has(e.item.id)))
  return held ? 'doing' : 'todo'
}

/** Which open view a row (or an item folded into one) sits in; null when it isn't open. */
export function viewOfItem(views: Views, id: string): OpenView | null {
  const has = (e: Views['todo'][number]) => e.item.id === id || !!e.item.linked?.some((l) => l.id === id)
  if (views.doing.some(has)) return 'doing'
  if (views.todo.some(has)) return 'todo'
  return null
}

/** "Permission: Bash", "Question" or "Plan to approve", what a blocked session is waiting on. */
export function waitingText(s: Pick<SessionSummary, 'waitingOn'>): string {
  if (!s.waitingOn) return 'Waiting on you'
  if (s.waitingOn === 'AskUserQuestion') return 'Question'
  if (s.waitingOn === 'ExitPlanMode') return 'Plan to approve'
  return `Permission: ${s.waitingOn.replace(/^mcp__.+?__/, '')}`
}

/**
 * What a chat is waiting on you for, or null: a prompt (permission, question,
 * plan) or, for a team's lead, its card or a gate. The tab, the sidebar row
 * and the top bar's Waiting list all read this.
 */
export function needsYouText(s: Pick<SessionSummary, 'waiting' | 'waitingOn' | 'teamRun'>): string | null {
  if (s.waiting) return waitingText(s)
  if (s.teamRun?.role !== 'lead') return null
  if (s.teamRun.state === 'proposed') return 'Team to approve'
  if (s.teamRun.state === 'gate') return 'Team waiting at a gate'
  return null
}
