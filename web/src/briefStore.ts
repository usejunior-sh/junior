/**
 * The newest brief job per work item, as a tiny external store: the inbox
 * rows show a status pill from it, the item page opens on it, and the Create
 * brief dialog knows what is already queued. Loaded once on demand, then kept
 * current by the server's `brief_status` frames, one per transition.
 */
import { useSyncExternalStore } from 'react'
import type { BriefJob, BriefJobsResponse } from '../../shared/protocol.js'
import { store } from './store.js'

export type BriefsSnapshot = {
  /** item id → its newest job */
  byItem: ReadonlyMap<string, BriefJob>
  loaded: boolean
  error?: string
}

let snap: BriefsSnapshot = { byItem: new Map(), loaded: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify() {
  for (const fn of listeners) fn()
}

export const briefStore = {
  get: (): BriefsSnapshot => snap,

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  refresh(): Promise<void> {
    if (inflight) return inflight
    inflight = fetch('/api/briefs')
      .then((r) => r.json() as Promise<BriefJobsResponse>)
      .then((b) => {
        if (b.ok) snap = { byItem: new Map(b.jobs.map((j) => [j.itemId, j])), loaded: true }
        else snap = { ...snap, error: b.error }
        notify()
      })
      .catch((err: unknown) => {
        snap = { ...snap, error: String(err) }
        notify()
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  /** A job moved: it is the item's newest unless an even newer one is already known. */
  apply(job: BriefJob) {
    const cur = snap.byItem.get(job.itemId)
    if (cur && cur.id !== job.id && cur.createdAt > job.createdAt) return
    const next = new Map(snap.byItem)
    next.set(job.itemId, job)
    snap = { ...snap, byItem: next }
    notify()
  },
}

store.onBriefStatus((job) => briefStore.apply(job))

export function useBriefs(): BriefsSnapshot {
  return useSyncExternalStore(briefStore.subscribe, briefStore.get)
}

/** The label and tone an inbox row or the item page shows for a job. */
export function briefPill(job: BriefJob | undefined, stale = false): { label: string; tone: string } | null {
  if (!job) return null
  if (job.status === 'queued') return { label: 'brief queued', tone: 'brief-queued' }
  if (job.status === 'running') return { label: 'briefing…', tone: 'brief-running' }
  if (job.status === 'failed') return { label: 'brief failed', tone: 'brief-failed' }
  return stale ? { label: 'brief stale', tone: 'brief-stale' } : { label: 'brief ready', tone: 'brief-ready' }
}
