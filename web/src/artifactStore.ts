/**
 * The artifacts index as a tiny external store, shared by the Artifacts page,
 * the `@` picker and (later) the item page's brief card. Loaded lazily, the
 * first surface that needs it asks, and refreshed whenever the server says
 * the index changed, so an edit in your editor shows up without a reload.
 */
import { useSyncExternalStore } from 'react'
import type { ArtifactWithLinks, ArtifactsResponse } from '../../shared/protocol.js'
import { store } from './store.js'

export type ArtifactsSnapshot = {
  artifacts: readonly ArtifactWithLinks[]
  /** the workspace's artifacts folder, absolute */
  root: string
  /** whether the last load included briefs of finished items */
  all: boolean
  loaded: boolean
  loading: boolean
  error?: string
}

let snap: ArtifactsSnapshot = { artifacts: [], root: '', all: false, loaded: false, loading: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify() {
  for (const fn of listeners) fn()
}

export const artifactStore = {
  get: (): ArtifactsSnapshot => snap,

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  refresh(all: boolean = snap.all): Promise<void> {
    if (inflight && all === snap.all) return inflight
    snap = { ...snap, all, loading: true }
    notify()
    inflight = fetch(`/api/artifacts${all ? '?all=1' : ''}`)
      .then((r) => r.json() as Promise<ArtifactsResponse>)
      .then((b) => {
        if (b.ok) snap = { artifacts: b.artifacts, root: b.root, all, loaded: true, loading: false }
        else snap = { ...snap, loading: false, error: b.error }
        notify()
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
}

// Once loaded, stay current: the server broadcasts every index change.
store.onArtifactsChanged(() => {
  if (snap.loaded) void artifactStore.refresh()
})

export function useArtifacts(): ArtifactsSnapshot {
  return useSyncExternalStore(artifactStore.subscribe, artifactStore.get)
}
