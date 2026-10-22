import type { BrowserProfile, BrowserProfileColor } from '../../core/browser/profiles.js'
import type { ColorScheme, SiteCookies, Viewport } from '../../core/browser/wire.js'

// The browser pane (.docs/browser.md). The page lives in Junior.app; these are
// the daemon's routes for what sessions saw there and for the element picker.

export type BrowserShotKind = 'screenshot' | 'checkpoint' | 'compare' | 'pick'

/** One saved image: GET /api/browser/shots/<sessionId>/<n> serves its bytes. */
export type BrowserShot = {
  n: number
  file: string
  mime: string
  kind: BrowserShotKind
  url: string
  title: string
  viewport: string
  at: number
  label?: string
  note?: string
}

export type BrowserShotsResponse = { ok: true; shots: BrowserShot[] } | { ok: false; error: string }

/** POST /api/browser/pick { sessionId, uid }, an element picked in the pane, described for the composer. */
export type BrowserPickResponse =
  | { ok: true; text: string; image: string | null; shot: number | null }
  | { ok: false; error: string }

/** Matches the marker a browser tool result carries for a saved shot. */
export const BROWSER_SHOT_RE = /\[shot #(\d+)\]/g

// Profiles (.docs/browser.md → Profiles): machine-wide, the daemon's list; the
// cookie jars are Junior.app's. Every change is broadcast as `browser_profiles`.

export type { BrowserProfile, BrowserProfileColor } from '../../core/browser/profiles.js'
export type { SiteCookies as BrowserSite, Viewport as BrowserViewportSpec, ColorScheme as BrowserColorScheme } from '../../core/browser/wire.js'

/** Whether Junior.app is there to host tabs, and speaks this daemon's wire. */
export type BrowserHostStatus = { connected: boolean; compatible: boolean; version: number | null }

/** GET /api/browser/profiles */
export type BrowserProfilesResponse =
  | { ok: true; profiles: BrowserProfile[]; workspaceDefault: string; app: BrowserHostStatus }
  | { ok: false; error: string }

/** POST /api/browser/profiles { name, color? } · PATCH /api/browser/profiles/:id { name?, color? } */
export type BrowserProfileInput = { name?: string; color?: BrowserProfileColor }
export type BrowserProfileResponse = { ok: true; profile: BrowserProfile } | { ok: false; error: string }

/** GET /api/browser/profiles/:id/sites (needs Junior.app) */
export type BrowserSitesResponse = { ok: true; sites: SiteCookies[] } | { ok: false; error: string }

/** POST /api/browser/profiles/:id/clear { site? } (needs Junior.app) */
export type BrowserClearResponse = { ok: true; removed: number } | { ok: false; error: string }

/** PUT /api/browser/default { profile }: this workspace's default profile */
export type BrowserDefaultResponse = { ok: true; workspaceDefault: string } | { ok: false; error: string }

/** What the daemon remembers about one session's tab (persisted, survives restarts). */
/** One of a session's pages, when it has more than one. */
export type BrowserPageInfo = {
  /** 1 = the session's own tab; numbers don't shift when a page closes */
  n: number
  /** the tab key the desktop app knows it by: the session id, or `<session>.p<n>` */
  key: string
  url: string
  title: string
  live: boolean
}

export type BrowserTabInfo = {
  sessionId: string
  /** the page the pane shows and Junior's tools act on: give this key to the desktop app */
  pageKey: string
  /** every page, page 1 first, when there is more than one; [] = just the session's tab */
  pages: BrowserPageInfo[]
  /** the profile picked for this session; null = follow the default */
  profile: string | null
  /** the profile the tab is actually in: picked → team lead's → job's → workspace default → 'default' */
  effectiveProfile: string
  url: string
  title: string
  viewport: Viewport | null
  colorScheme: ColorScheme
  /** a tab is open in Junior.app right now */
  live: boolean
  /** the user took the tab over: Junior's browser tools wait until they hand it back */
  heldByUser: boolean
  /** what Junior is doing with the page right now ("Clicking "Send"", "Opening app.pendo.io"); null between calls */
  agentStep: string | null
  updatedAt: number | null
}

/**
 * GET  /api/browser/tabs/:tabKey                  → BrowserTabResponse
 * PUT  /api/browser/tabs/:tabKey { profile }      → BrowserTabResponse (switches a live tab: it reloads in the new jar)
 * POST /api/browser/tabs/:tabKey/open { url? }    → BrowserTabResponse (no url = reopen the remembered one)
 * PUT  /api/browser/tabs/:tabKey/takeover { on }  → BrowserTabResponse (on: you drive, Junior waits; off: hand back)
 * `tabKey` is a session id, or `profile-<id>` for a profile's sign-in tab.
 */
export type BrowserTabResponse = { ok: true; tab: BrowserTabInfo } | { ok: false; error: string }

/** A download from a session's tab, as the pane shows it. */
export type BrowserDownload = {
  sessionId: string
  file: string
  path: string
  bytes: number
  state: 'completed' | 'cancelled' | 'interrupted' | 'refused'
  byAgent: boolean
  at: number
}
