/**
 * The browser pane, client side (.docs/browser.md). The page itself is a
 * native view Junior.app lays over the pane's rect; this module is its remote
 * control, the preload's `juniorDesktop.browser`, plus which sessions have
 * the pane open. Outside Junior.app (a browser tab, a phone) there is no
 * bridge, and the pane says where to find it.
 *
 * Profiles and each tab's remembered state are the daemon's: the list comes
 * from GET /api/browser/profiles and the `browser_profiles` frame, a tab's
 * from GET /api/browser/tabs/:key and `browser_tab`. A tab is only ever made
 * over HTTP (POST …/open), so the daemon always names its profile.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type {
  BrowserDownload,
  BrowserHostStatus,
  BrowserProfile,
  BrowserProfileColor,
  BrowserProfileInput,
  BrowserProfileResponse,
  BrowserProfilesResponse,
  BrowserSite,
  BrowserSitesResponse,
  BrowserTabInfo,
  BrowserTabResponse,
} from '../../shared/protocol.js'
import { openSettings } from './settings.js'
import { store } from './store.js'

export type BrowserViewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
export type BrowserPreset = 'fit' | 'desktop' | 'laptop' | 'tablet' | 'mobile'
export type ColorScheme = 'dark' | 'light' | null

/** Why the page didn't load: Chromium's error name (`ERR_CONNECTION_REFUSED`), or 'crashed'. */
export type PageError = { code: string; url: string }

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
  /** the profile the live tab is in */
  profile?: string | null
  /** a sign-in window this tab opened, still open */
  popup?: { url: string } | null
  dialog?: { type: string; message: string } | null
  error?: PageError | null
}

export type PaneRect = { x: number; y: number; width: number; height: number }

export type PaneKey = 'focus-url' | 'find' | 'reload' | 'back' | 'forward'

type BrowserBridge = {
  setPane: (sessionId: string | null, rect: PaneRect | null) => void
  nav: (sessionId: string, action: 'back' | 'forward' | 'reload' | 'stop') => void
  setViewport: (sessionId: string, preset: BrowserPreset | '', colorScheme?: ColorScheme) => Promise<BrowserState | null>
  state: (sessionId: string) => Promise<BrowserState>
  pick: (sessionId: string) => Promise<number | null>
  cancelPick: (sessionId: string) => void
  devtools: (sessionId: string) => void
  onState: (cb: (s: BrowserState) => void) => () => void
  onActivity: (cb: (s: { sessionId: string }) => void) => () => void
  // Newer app builds only; checked before use.
  /** the same text again moves to the next match (or previous, forward: false); new text starts over; empty clears */
  find?: (sessionId: string, text: string, opts?: { forward?: boolean }) => void
  stopFind?: (sessionId: string) => void
  reveal?: (path: string) => void
  onFound?: (cb: (f: { tabKey: string; matches: number; active: number }) => void) => () => void
  onKey?: (cb: (k: { tabKey: string; key: PaneKey }) => void) => () => void
  /** the page as a PNG data URL, for the frozen frame under our menus */
  capture?: (sessionId: string) => Promise<string | null>
  /** bring the tab's sign-in window to the front */
  focusPopup?: (sessionId: string) => void
}

export const browserBridge: BrowserBridge | null = (() => {
  const b = (globalThis as { juniorDesktop?: { browser?: Partial<BrowserBridge> } }).juniorDesktop?.browser
  return b && typeof b.setPane === 'function' && typeof b.onState === 'function' ? (b as BrowserBridge) : null
})()

/** Junior.app can host the pane here. */
export const hasBrowser = browserBridge !== null

// ── which sessions have the pane open (per browser, survives a reload) ──────

const KEY = 'junior.browserOpen'
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

/** One tab's live state in Junior.app: what the pane's toolbar shows. `known` = the app has answered. */
export function useBrowserState(tabKey: string): BrowserState & { known: boolean } {
  const [s, setS] = useState<BrowserState & { known: boolean }>({ sessionId: tabKey, exists: false, known: false })
  useEffect(() => {
    if (!browserBridge) return
    setS({ sessionId: tabKey, exists: false, known: false })
    let live = true
    void browserBridge.state(tabKey).then((v) => {
      if (live) setS({ ...v, known: true })
    })
    const off = browserBridge.onState((v) => {
      if (v.sessionId === tabKey) setS({ ...v, known: true })
    })
    return () => {
      live = false
      off()
    }
  }, [tabKey])
  // "Junior is driving" must end when the call does. The app pushes a state
  // when a call finishes, but not for a tab that was closed or remade under
  // the call, so while busy, ask again until it says the call is over.
  const busy = !!s.agentBusy
  useEffect(() => {
    if (!browserBridge || !busy) return
    let live = true
    const t = setInterval(() => {
      void browserBridge!.state(tabKey).then((v) => {
        if (live && v.sessionId === tabKey) setS({ ...v, known: true })
      })
    }, 1500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [tabKey, busy])
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

// ── profiles (machine-wide, the daemon's list) ──────────────────────────────

export type ProfilesSnapshot = { profiles: BrowserProfile[]; workspaceDefault: string; app: BrowserHostStatus }

let profiles: ProfilesSnapshot | null = null
let profilesError: string | null = null
let loading: Promise<void> | null = null
const profileListeners = new Set<() => void>()
const emitProfiles = () => {
  for (const fn of profileListeners) fn()
}

async function loadProfiles(): Promise<void> {
  try {
    const b = (await (await fetch('/api/browser/profiles')).json()) as BrowserProfilesResponse
    if (b.ok) {
      profiles = { profiles: b.profiles, workspaceDefault: b.workspaceDefault, app: b.app }
      profilesError = null
    } else profilesError = b.error
  } catch (e) {
    profilesError = String(e)
  }
  emitProfiles()
}

export const browserProfiles = {
  get: () => profiles,
  error: () => profilesError,
  refresh(): Promise<void> {
    loading = loadProfiles().finally(() => {
      loading = null
    })
    return loading
  },
  subscribe(fn: () => void) {
    profileListeners.add(fn)
    if (!profiles && !loading) void browserProfiles.refresh()
    return () => {
      profileListeners.delete(fn)
    }
  },
}

// The list moved (here, in another workspace, or by Junior): take it as sent,
// then refetch for the app's status, which the frame doesn't carry.
store.onBrowser((msg) => {
  if (msg.type !== 'browser_profiles') return
  profiles = { profiles: msg.profiles, workspaceDefault: msg.workspaceDefault, app: profiles?.app ?? { connected: false, compatible: false, version: null } }
  emitProfiles()
  void browserProfiles.refresh()
})

/** The profile list, null until the first load. */
export function useBrowserProfiles(): ProfilesSnapshot | null {
  return useSyncExternalStore(browserProfiles.subscribe, browserProfiles.get)
}

/** Why the list didn't load, while it hasn't. */
export function useBrowserProfilesError(): string | null {
  return useSyncExternalStore(browserProfiles.subscribe, browserProfiles.error)
}

export const profileById = (snap: ProfilesSnapshot | null, id: string | null | undefined): BrowserProfile | null =>
  (id && snap?.profiles.find((p) => p.id === id)) || null

let draftWanted = false

/** Settings → Browser; `draft` opens it with a new profile's row ready to name. */
export function openBrowserSettings(opts: { draft?: boolean } = {}) {
  draftWanted = !!opts.draft
  openSettings('browser')
}

/** Settings → Browser asks once, on mount, whether it was opened to make a profile. */
export function takeDraftIntent(): boolean {
  const v = draftWanted
  draftWanted = false
  return v
}

/** A profile colour as a design token, for its dot. */
export const PROFILE_COLOR_VAR: Record<BrowserProfileColor, string> = {
  gray: 'var(--ash)',
  blue: 'var(--hue-0)',
  green: 'var(--hue-1)',
  amber: 'var(--hue-2)',
  red: 'var(--hue-4)',
  violet: 'var(--hue-5)',
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (await res.json()) as Result<T>
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

const profilePath = (id: string) => `/api/browser/profiles/${encodeURIComponent(id)}`

export const createProfile = (input: BrowserProfileInput) => call<Extract<BrowserProfileResponse, { ok: true }>>('POST', '/api/browser/profiles', input)
export const updateProfile = (id: string, input: BrowserProfileInput) =>
  call<Extract<BrowserProfileResponse, { ok: true }>>('PATCH', profilePath(id), input)
export const deleteProfile = (id: string) => call<object>('DELETE', profilePath(id))
export const clearProfile = (id: string, site?: string) => call<{ removed: number }>('POST', `${profilePath(id)}/clear`, site ? { site } : {})
export const setDefaultProfile = (profile: string) => call<{ workspaceDefault: string }>('PUT', '/api/browser/default', { profile })

/** The sites a profile holds saved cookies for, most cookies first; needs Junior.app. */
export async function profileSites(id: string): Promise<Result<{ sites: BrowserSite[] }>> {
  const b = await call<Extract<BrowserSitesResponse, { ok: true }>>('GET', `${profilePath(id)}/sites`)
  if (b.ok) b.sites = [...b.sites].filter((s) => s.persistent > 0).sort((a, z) => z.persistent - a.persistent)
  return b
}

// ── one tab's remembered state ──────────────────────────────────────────────

const tabPath = (tabKey: string) => `/api/browser/tabs/${encodeURIComponent(tabKey)}`

// A tab a call answered with reaches its pane now, not only when the broadcast does.
const tabListeners = new Set<(tab: BrowserTabInfo) => void>()
async function tabCall(method: string, path: string, body: unknown) {
  const b = await call<Extract<BrowserTabResponse, { ok: true }>>(method, path, body)
  if (b.ok) for (const fn of tabListeners) fn(b.tab)
  return b
}

/** Open a URL in the tab (no URL = reopen the remembered one); the daemon picks the profile. */
export const openTab = (tabKey: string, url?: string) => tabCall('POST', `${tabPath(tabKey)}/open`, url ? { url } : {})
/** Move a session's tab to a profile (null = follow the default); a live tab reloads in it. */
export const setTabProfile = (tabKey: string, profile: string | null) => tabCall('PUT', tabPath(tabKey), { profile })
/** Take the tab over (Junior's browser calls wait) or hand it back. */
export const setTakeover = (tabKey: string, on: boolean) => tabCall('PUT', `${tabPath(tabKey)}/takeover`, { on })

/** What the daemon remembers about a tab: its profile, last URL and title. null until loaded. */
export function useBrowserTab(tabKey: string): BrowserTabInfo | null {
  const [tab, setTab] = useState<BrowserTabInfo | null>(null)
  useEffect(() => {
    setTab(null)
    let live = true
    void call<Extract<BrowserTabResponse, { ok: true }>>('GET', tabPath(tabKey)).then((b) => {
      if (live && b.ok) setTab(b.tab)
    })
    const off = store.onBrowser((msg) => {
      if (msg.type === 'browser_tab' && msg.tab.sessionId === tabKey) setTab(msg.tab)
    })
    const mine = (t: BrowserTabInfo) => {
      if (t.sessionId === tabKey) setTab(t)
    }
    tabListeners.add(mine)
    return () => {
      live = false
      off()
      tabListeners.delete(mine)
    }
  }, [tabKey])
  return tab
}

/** The tab's latest download, for the pane's "Saved report.csv" line. */
export function useBrowserDownload(tabKey: string): BrowserDownload | null {
  const [d, setD] = useState<BrowserDownload | null>(null)
  useEffect(() => {
    setD(null)
    return store.onBrowser((msg) => {
      if (msg.type === 'browser_download' && msg.download.sessionId === tabKey) setD(msg.download)
    })
  }, [tabKey])
  return d
}

/** The window is narrower than `px`, live: the pane takes the chats list's room below it. */
export function useWindowNarrower(px: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < px)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < px)
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [px])
  return narrow
}
