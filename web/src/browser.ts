/**
 * The browser pane, client side (.docs/browser.md). The page itself is a
 * native view Triage.app lays over the pane's rect; this module is its remote
 * control, the preload's `triageDesktop.browser`, plus which sessions have
 * the pane open. Outside Triage.app (a browser tab, a phone) there is no
 * bridge, and the pane says where to find it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

export type BrowserViewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
export type BrowserPreset = 'fit' | 'desktop' | 'laptop' | 'tablet' | 'mobile'
export type ColorScheme = 'dark' | 'light' | null

export type BrowserState = {
  sessionId: string
  exists: boolean
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  viewport?: BrowserViewport | null
  colorScheme?: ColorScheme
  agentBusy?: boolean
  picking?: boolean
}

export type PaneRect = { x: number; y: number; width: number; height: number }

type BrowserBridge = {
  setPane: (sessionId: string | null, rect: PaneRect | null) => void
  navigate: (sessionId: string, url: string) => Promise<BrowserState>
  nav: (sessionId: string, action: 'back' | 'forward' | 'reload' | 'stop') => void
  setViewport: (sessionId: string, preset: BrowserPreset | '', colorScheme?: ColorScheme) => Promise<BrowserState | null>
  state: (sessionId: string) => Promise<BrowserState>
  pick: (sessionId: string) => Promise<number | null>
  cancelPick: (sessionId: string) => void
  devtools: (sessionId: string) => void
  onState: (cb: (s: BrowserState) => void) => () => void
  onActivity: (cb: (s: { sessionId: string }) => void) => () => void
}

export const browserBridge: BrowserBridge | null = (() => {
  const b = (globalThis as { triageDesktop?: { browser?: Partial<BrowserBridge> } }).triageDesktop?.browser
  return b && typeof b.setPane === 'function' && typeof b.onState === 'function' ? (b as BrowserBridge) : null
})()

/** Triage.app can host the pane here. */
export const hasBrowser = browserBridge !== null

// ── which sessions have the pane open (per browser, survives a reload) ──────

const KEY = 'triage.browserOpen'
let open: Set<string> = (() => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-50) : [])
  } catch {
    return new Set<string>()
  }
})()
const listeners = new Set<() => void>()

export const browserPane = {
  isOpen: (sessionId: string) => open.has(sessionId),
  set(sessionId: string, on: boolean) {
    if (open.has(sessionId) === on) return
    open = new Set(open)
    if (on) open.add(sessionId)
    else open.delete(sessionId)
    try {
      localStorage.setItem(KEY, JSON.stringify([...open]))
    } catch {
      // storage blocked: open for this page load only
    }
    for (const fn of listeners) fn()
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

export function useBrowserOpen(sessionId: string | null): boolean {
  return useSyncExternalStore(browserPane.subscribe, () => (sessionId ? open.has(sessionId) : false))
}

// The agent opened a page: the pane on that session opens itself.
browserBridge?.onActivity(({ sessionId }) => browserPane.set(sessionId, true))

/** One session's tab, live: what the pane's toolbar shows. */
export function useBrowserState(sessionId: string): BrowserState {
  const [s, setS] = useState<BrowserState>({ sessionId, exists: false })
  useEffect(() => {
    if (!browserBridge) return
    setS({ sessionId, exists: false })
    let live = true
    void browserBridge.state(sessionId).then((v) => {
      if (live) setS(v)
    })
    const off = browserBridge.onState((v) => {
      if (v.sessionId === sessionId) setS(v)
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])
  return s
}

/** The preset a viewport is, for the chip. */
export function presetOf(v: BrowserViewport | null | undefined): BrowserPreset | null {
  if (!v) return 'fit'
  if (v.width === 1440 && v.height === 900) return 'desktop'
  if (v.width === 1280 && v.height === 800) return 'laptop'
  if (v.width === 820 && v.height === 1180) return 'tablet'
  if (v.width === 390 && v.height === 844) return 'mobile'
  return null
}

export const shotSrc = (sessionId: string, n: number) => `/api/browser/shots/${sessionId}/${n}`
