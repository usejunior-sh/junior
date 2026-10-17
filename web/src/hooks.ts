import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS_TAB, isSettingsTab, LEGACY_SETTINGS_TABS, type SettingsTab } from './settings.js'
import { store } from './store.js'
import { isInboxTab, type InboxTab } from '../../core/work/inbox-tabs.js'

export function useConn() {
  return useSyncExternalStore(store.subscribeStructural, store.getConn)
}

export function useSessions() {
  return useSyncExternalStore(store.subscribeStructural, store.getSessions)
}

export function useWorkspaces() {
  return useSyncExternalStore(store.subscribeStructural, store.getWorkspaces)
}

export function useWorkspaceId() {
  return useSyncExternalStore(store.subscribeStructural, store.getWorkspaceId)
}

/** Which copy of triage this tab is talking to — see shared/protocol.ts `Build`. */
export function useBuild() {
  return useSyncExternalStore(store.subscribeStructural, store.getBuild)
}

export function useOnboarded() {
  return useSyncExternalStore(store.subscribeStructural, store.getOnboarded)
}

export function useTerminals() {
  return useSyncExternalStore(store.subscribeStructural, store.getTerminals)
}

/** Every project's folders (main + worktrees), removed ones included so old sessions still say where they ran. */
export function useCheckouts() {
  return useSyncExternalStore(store.subscribeStructural, store.getCheckouts)
}

export function useEvents(sessionId: string | null) {
  const get = useCallback(() => (sessionId ? store.getEvents(sessionId) : EMPTY), [sessionId])
  return useSyncExternalStore(store.subscribeStructural, get)
}

/**
 * The in-flight assistant line. Backed by the live channel, so a burst of token
 * deltas re-renders this one node once per frame and nothing else.
 */
export function useLiveText(sessionId: string | null) {
  const get = useCallback(() => (sessionId ? store.getLive(sessionId) : ''), [sessionId])
  return useSyncExternalStore(store.subscribeLive, get)
}

export type Route =
  | { page: 'home' }
  /** `#/junior` — Junior's page: the brief, today's plan, what it can do */
  | { page: 'junior' }
  | { page: 'session'; id: string }
  | { page: 'draft'; id: string }
  /** `#/inbox/<tab>` — one inbox tab; bare `#/inbox` opens the first that needs you */
  | { page: 'inbox'; tab?: InboxTab }
  | { page: 'item'; id: string }
  | { page: 'terminal'; id: string }
  | { page: 'terminals' }
  | { page: 'jobs' }
  /** `#/jobs/new` or `#/jobs/<id>/edit` — the full-page job form */
  | { page: 'job-form'; id: string | null }
  /** `#/jobs/<id>` — one job: health, runs, items */
  | { page: 'job'; id: string }
  | { page: 'artifacts' }
  | { page: 'artifact'; id: string }
  /** `#/run/<runId>/<path>` — one file in a team run's folder (plan.md, ledger.md, a handoff…) */
  | { page: 'run'; runId: string; path: string }
  | { page: 'changes' }
  /** `#/change/<checkoutId>/<encoded path>` — one changed file: its diff, and an editor (a project id = its main checkout) */
  | { page: 'change'; checkoutId: string; path: string }
  /** `#/actions` — everything sessions did that left this machine */
  | { page: 'actions' }
  /** `#/goals` — outcomes Junior drives across sessions */
  | { page: 'goals' }
  /** `#/goals/<id>` — one goal: its state and ledger */
  | { page: 'goal'; id: string }
  /** `#/settings/<tab>` — the settings page, on that tab */
  | { page: 'settings'; tab: SettingsTab }

/** The hash for a work item — ids carry `:` `/` `#`, so they travel encoded. */
export const itemHash = (id: string) => `/item/${encodeURIComponent(id)}`

function parseRoute(hash: string): Route {
  if (!hash) return { page: 'home' }
  if (hash === '/junior') return { page: 'junior' }
  if (hash === '/inbox') return { page: 'inbox' }
  if (hash.startsWith('/inbox/')) {
    const tab = hash.slice('/inbox/'.length)
    return isInboxTab(tab) ? { page: 'inbox', tab } : { page: 'inbox' }
  }
  if (hash.startsWith('/new/')) return { page: 'draft', id: hash.slice('/new/'.length) }
  if (hash.startsWith('/item/')) {
    try {
      return { page: 'item', id: decodeURIComponent(hash.slice('/item/'.length)) }
    } catch {
      return { page: 'inbox' }
    }
  }
  if (hash === '/terminals') return { page: 'terminals' }
  if (hash.startsWith('/terminal/')) return { page: 'terminal', id: hash.slice('/terminal/'.length) }
  // Connectors used to be a page; the link still works, as a settings tab.
  if (hash === '/connectors') return { page: 'settings', tab: 'connectors' }
  // Projects used to be a page too; same deal.
  if (hash === '/projects') return { page: 'settings', tab: 'projects' }
  // Jobs were called watches; their old links still open them.
  if (hash === '/watches' || hash.startsWith('/watches/')) return parseRoute(`/jobs${hash.slice('/watches'.length)}`)
  if (hash === '/jobs') return { page: 'jobs' }
  if (hash === '/jobs/new') return { page: 'job-form', id: null }
  {
    const m = /^\/jobs\/([^/]+)\/edit$/.exec(hash)
    if (m) return { page: 'job-form', id: decodeURIComponent(m[1]) }
    const d = /^\/jobs\/([^/]+)$/.exec(hash)
    if (d) return { page: 'job', id: decodeURIComponent(d[1]) }
  }
  if (hash === '/actions') return { page: 'actions' }
  if (hash === '/goals') return { page: 'goals' }
  {
    const m = /^\/goals\/([^/]+)$/.exec(hash)
    if (m) {
      try {
        return { page: 'goal', id: decodeURIComponent(m[1]) }
      } catch {
        return { page: 'goals' }
      }
    }
  }
  if (hash === '/artifacts') return { page: 'artifacts' }
  if (hash.startsWith('/artifact/')) return { page: 'artifact', id: hash.slice('/artifact/'.length) }
  {
    const m = /^\/run\/([^/]+)(?:\/(.+))?$/.exec(hash)
    if (m) {
      try {
        return { page: 'run', runId: m[1], path: m[2] ? m[2].split('/').map(decodeURIComponent).join('/') : 'plan.md' }
      } catch {
        return { page: 'run', runId: m[1], path: 'plan.md' }
      }
    }
  }
  if (hash === '/changes') return { page: 'changes' }
  {
    const m = /^\/change\/([^/]+)\/(.+)$/.exec(hash)
    if (m) {
      try {
        return { page: 'change', checkoutId: m[1], path: decodeURIComponent(m[2]) }
      } catch {
        return { page: 'changes' }
      }
    }
  }
  if (hash === '/settings' || hash.startsWith('/settings/')) {
    const tab = hash.slice('/settings/'.length)
    return { page: 'settings', tab: isSettingsTab(tab) ? tab : (LEGACY_SETTINGS_TABS[tab] ?? DEFAULT_SETTINGS_TAB) }
  }
  return { page: 'session', id: hash }
}

/** Route state, kept in the URL hash so `/#<id>` opens a session in its own tab. */
export function useHashRoute(): [Route, (hash: string, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash.slice(1)))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash.slice(1)))
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  // Every navigation is a history entry (Triage.app's ← → walk them); a
  // redirect replaces instead, so Back never lands on the page that bounced.
  const navigate = useCallback((hash: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) location.replace(`#${hash}`)
    else location.hash = hash
    setRoute(parseRoute(hash))
  }, [])
  return [route, navigate]
}

const EMPTY: readonly never[] = []
