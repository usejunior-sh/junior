/**
 * The open inbox, as a tiny external store shared by every surface that shows
 * it: the Queue panel, the rail badge, the inbox page and the item page. The
 * server keeps a snapshot cache, so a refresh is cheap (~30ms). The page that
 * owns the full lifecycle (InboxPage) publishes here after its own loads and
 * optimistic edits, so the panel never lags the list beside it.
 */
import { useSyncExternalStore } from 'react'
import type { InboxAlert, InboxResponse, ScoredItem } from '../../shared/protocol.js'
import { store } from './store.js'

export type InboxSnapshot = {
  items: readonly ScoredItem[]
  syncedAt: number
  notices: readonly string[]
  /** Needs you now's entries that aren't items: a failed job, a paused team run */
  alerts: readonly InboxAlert[]
  /** items done since midnight */
  landedToday: number
  /** snoozed and archived rows, for the sidebar's counts */
  counts?: { snoozed: number; archived: number }
  /** false until the first successful load */
  loaded: boolean
  /** the last refresh's failure, cleared by the next success */
  error?: string
  /** a refresh is in flight */
  loading: boolean
}

let snap: InboxSnapshot = { items: [], syncedAt: 0, notices: [], alerts: [], landedToday: 0, loaded: false, loading: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify() {
  for (const fn of listeners) fn()
}

export const inboxStore = {
  get: (): InboxSnapshot => snap,

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  set(
    items: readonly ScoredItem[],
    syncedAt: number,
    notices: readonly string[],
    extras: { alerts?: readonly InboxAlert[]; landedToday?: number; counts?: InboxSnapshot['counts'] } = {},
  ) {
    snap = {
      items,
      syncedAt,
      notices,
      alerts: extras.alerts ?? [],
      landedToday: extras.landedToday ?? 0,
      counts: extras.counts ?? snap.counts,
      loaded: true,
      loading: false,
    }
    notify()
  },

  /** Local edit (done / snoozed / priority), keep the panel in step. */
  patch(fn: (items: readonly ScoredItem[]) => readonly ScoredItem[]) {
    snap = { ...snap, items: fn(snap.items) }
    notify()
  },

  refresh(force = false): Promise<void> {
    if (inflight) return inflight
    snap = { ...snap, loading: true }
    notify()
    inflight = fetch(`/api/inbox${force ? '?refresh=1' : ''}`)
      .then((r) => r.json() as Promise<InboxResponse>)
      .then((b) => {
        if (b.ok) inboxStore.set(b.items, b.syncedAt, b.notices, { alerts: b.alerts, landedToday: b.landedToday, counts: b.counts })
        else {
          snap = { ...snap, loading: false, error: b.error }
          notify()
        }
      })
      .catch((err: unknown) => {
        snap = { ...snap, loading: false, error: String(err) }
        notify()
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  /** A refetch queued behind any load already in flight, so it can't be answered by a snapshot taken before a change. */
  refreshAfterChange(): Promise<void> {
    return (inflight ?? Promise.resolve()).then(() => inboxStore.refresh())
  },
}

// Once loaded, stay current: a chat's create_work_item, a job run and another
// tab all move items, and the server says so. A burst (a job filing twenty
// items) coalesces into one refetch, queued behind any load already in flight
// so it can't be answered by a snapshot taken before the change.
let pending: ReturnType<typeof setTimeout> | null = null
store.onInboxChanged(() => {
  if (!snap.loaded || pending) return
  pending = setTimeout(() => {
    pending = null
    void inboxStore.refreshAfterChange()
  }, 150)
})

export function useInbox(): InboxSnapshot {
  return useSyncExternalStore(inboxStore.subscribe, inboxStore.get)
}
