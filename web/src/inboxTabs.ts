/**
 * The inbox tabs (core/work/inbox-tabs.ts) over the shared inbox snapshot and
 * the live session list — read by both the sidebar and the inbox page, so the
 * counts beside a tab are always the rows under it.
 */
import { useMemo } from 'react'
import type { ScoredItem, SessionSummary } from '../../shared/protocol.js'
import { DEFAULT_TAB, OPEN_TABS, inboxTabs, type InboxTab, type InboxTabs, type OpenTab } from '../../core/work/inbox-tabs.js'
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

/** The tab a bare `#/inbox` opens: Needs you now, else the first that holds anything. */
export function resolveTab(tab: InboxTab | undefined, counts: Tabs['counts']): InboxTab {
  if (tab) return tab
  return OPEN_TABS.find((t: OpenTab) => counts[t] > 0) ?? DEFAULT_TAB
}

/** Which open tab a row (or an item folded into one) sits in; null when it isn't open. */
export function tabOfItem(tabs: Tabs, id: string): OpenTab | null {
  for (const [tab, entries] of tabs.tabs) {
    if (entries.some((e) => e.item.id === id || e.item.linked?.some((l) => l.id === id))) return tab
  }
  return null
}

/** "Permission: Bash", "Question" or "Plan to approve" — what a blocked session is waiting on. */
export function waitingText(s: Pick<SessionSummary, 'waitingOn'>): string {
  if (!s.waitingOn) return 'Waiting on you'
  if (s.waitingOn === 'AskUserQuestion') return 'Question'
  if (s.waitingOn === 'ExitPlanMode') return 'Plan to approve'
  return `Permission: ${s.waitingOn.replace(/^mcp__.+?__/, '')}`
}
