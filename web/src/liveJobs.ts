import { useEffect, useSyncExternalStore } from 'react'
import type { Job, JobsResponse } from '../../shared/protocol.js'
import { useWorkspaceId } from './hooks.js'

/**
 * The workspace's jobs as they are now, for cards that outlive the moment
 * they were drawn (a draft_job result in a chat). One fetch shared by every
 * card on screen, again when the window comes back or the route changes:
 * enabling happens on the job page, so the chat is re-shown after it.
 * null = not loaded (or the fetch failed): callers keep what they had.
 */
let jobs: Job[] | null = null
let inflight: Promise<void> | null = null
let users = 0
const listeners = new Set<() => void>()

function refresh(): void {
  if (inflight) return
  inflight = fetch('/api/jobs')
    .then((r) => r.json() as Promise<JobsResponse>)
    .then((b) => {
      if (!b.ok) return
      jobs = b.jobs
      for (const fn of listeners) fn()
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
    })
}

const onVisible = () => {
  if (document.visibilityState === 'visible') refresh()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Live jobs while `active`; null until the first answer. */
export function useLiveJobs(active: boolean): Job[] | null {
  const ws = useWorkspaceId()
  useEffect(() => {
    if (!active) return
    if (users++ === 0) {
      window.addEventListener('focus', refresh)
      window.addEventListener('hashchange', refresh)
      document.addEventListener('visibilitychange', onVisible)
    }
    refresh()
    return () => {
      if (--users === 0) {
        window.removeEventListener('focus', refresh)
        window.removeEventListener('hashchange', refresh)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [active, ws])
  return useSyncExternalStore(subscribe, () => jobs)
}
