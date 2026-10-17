/**
 * The connected agents' live accounts (GET /api/providers), as an external
 * store shared by the top-bar Providers popover and Settings → Providers.
 *
 * Each read spawns a throwaway subprocess per agent server-side, so it is
 * fetched on demand, when one of those opens, and reused while fresh. The
 * server caches too; `refresh` goes past both.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ProviderStatus, ProvidersStatusResponse } from '../../shared/protocol.js'

/** Older than this, the next open asks again. */
const STALE_MS = 60_000

export type ProviderStatusState = {
  workspaceId: string
  providers: ProviderStatus[] | null
  loading: boolean
  error: string | null
  at: number
}

let state: ProviderStatusState = { workspaceId: '', providers: null, loading: false, error: null, at: 0 }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null

function set(next: Partial<ProviderStatusState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

/** Read the accounts for `workspaceId`; `refresh` asks the agents again rather than the server's cache. */
export function loadProviderStatus(workspaceId: string, refresh = false): Promise<void> {
  if (workspaceId !== state.workspaceId) set({ workspaceId, providers: null, error: null, at: 0 })
  if (inFlight && !refresh) return inFlight
  set({ loading: true, error: null })
  const run = fetch(`/api/providers?workspace=${encodeURIComponent(workspaceId)}${refresh ? '&refresh=1' : ''}`)
    .then((r) => r.json() as Promise<ProvidersStatusResponse>)
    .then((b) => {
      if (state.workspaceId !== workspaceId) return
      if (b.ok) set({ providers: b.providers, at: Date.now() })
      else set({ error: b.error })
    })
    .catch((e: unknown) => {
      if (state.workspaceId === workspaceId) set({ error: e instanceof Error ? e.message : String(e) })
    })
    .finally(() => {
      if (inFlight === run) inFlight = null
      if (state.workspaceId === workspaceId) set({ loading: false })
    })
  inFlight = run
  return run
}

/** Drop what is known, e.g. after a connection changed. The next open reads afresh. */
export function invalidateProviderStatus() {
  set({ at: 0 })
}

/** The accounts for `workspaceId`, loaded when `active` and stale. */
export function useProviderStatus(workspaceId: string, active = true): ProviderStatusState {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => state,
  )
  const stale = s.workspaceId !== workspaceId || Date.now() - s.at > STALE_MS
  useEffect(() => {
    if (active && workspaceId && stale && !inFlight) void loadProviderStatus(workspaceId)
  }, [active, workspaceId, stale])
  return s.workspaceId === workspaceId ? s : { workspaceId, providers: null, loading: active, error: null, at: 0 }
}

/** "in 3h", "in 2d", "in 12m", when a window resets. */
export function resetsIn(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/** "business" → "Business", "max_20x" → "Max 20x". */
export const planLabel = (plan: string) => plan.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** 1_234_567 → "1.2M". */
export function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
