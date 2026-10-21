/**
 * The browser host wire: a copy of core/browser/wire.ts (and the bits of
 * core/browser/profiles.ts the app needs), since desktop's tsconfig can't
 * reach outside src/. A change there is a change here, and a new WIRE_VERSION.
 */

export const WIRE_VERSION = 2

/** A browser profile's id: 'default' or a slug. `partitionOf(id)` is its cookie jar. */
export type ProfileId = string
export type Viewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
export type ColorScheme = 'dark' | 'light' | null

export type HostVerb =
  | { verb: 'open'; url: string; wait: 'load' | 'idle'; restore?: { viewport: Viewport | null; colorScheme: ColorScheme }; byUser?: boolean }
  | { verb: 'cdp'; method: string; params?: Record<string, unknown> }
  | { verb: 'viewport'; viewport: Viewport | null; colorScheme?: ColorScheme }
  | { verb: 'flash'; backendNodeId: number }
  | { verb: 'state' }
  | { verb: 'close' }

export type PageDialog = { type: string; message: string }

export type TabState = {
  exists: boolean
  url: string
  title: string
  loading: boolean
  viewport: Viewport | null
  colorScheme: ColorScheme
  profile: ProfileId | null
  popup: { url: string } | null
  dialog: PageDialog | null
}

/** daemon → app. `sessionId` is the tab key: a session id, or `profile-<id>` for a settings sign-in tab. */
export type CallFrame = { type: 'call'; id: number; sessionId: string; profile: ProfileId } & HostVerb

export type SiteCookies = { site: string; cookies: number; persistent: number; expiresAt: number | null }

export type ProfileFrame =
  | { type: 'profile'; id: number; profile: ProfileId; op: 'sites' }
  | { type: 'profile'; id: number; profile: ProfileId; op: 'clear'; site?: string }
  | { type: 'profile'; id: number; profile: ProfileId; op: 'drop' }

export type DaemonFrame = CallFrame | ProfileFrame

export type PageLog = { level: 'error' | 'warning' | 'info'; source: 'console' | 'exception' | 'network'; text: string; url?: string; at: number }

export type DownloadState = 'completed' | 'cancelled' | 'interrupted' | 'refused'

/** app → daemon */
export type HostFrame =
  | { type: 'hello'; version: number; app: string }
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'log'; sessionId: string; log: PageLog }
  | { type: 'navigated'; sessionId: string; url: string; byUser: boolean }
  | { type: 'touched'; sessionId: string }
  | { type: 'closed'; sessionId: string }
  | { type: 'tab'; sessionId: string; profile: ProfileId; url: string; title: string; viewport: Viewport | null; colorScheme: ColorScheme }
  | { type: 'popup'; sessionId: string; url: string; state: 'opened' | 'closed' }
  | { type: 'dialog'; sessionId: string; dialog: PageDialog | null }
  | { type: 'download'; sessionId: string; file: string; path: string; bytes: number; state: DownloadState; byAgent: boolean }

// From core/browser/profiles.ts

export const DEFAULT_PROFILE = 'default'
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** A tab key: a session id, or `profile-<id>` for a profile's sign-in tab in Settings. */
export const TAB_KEY_RE = /^(profile-)?[\w-]{1,80}$/

export const partitionOf = (id: string): string => (id === DEFAULT_PROFILE ? 'persist:triage-browser' : `persist:triage-profile-${id}`)

const TWO_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or'])

/** ".mail.google.com" → "google.com", "x.co.uk" → "x.co.uk"; IPs and localhost as they are. */
export function siteOf(cookieDomain: string): string {
  const h = cookieDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
  if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const tld = parts[parts.length - 1]
  const sld = parts[parts.length - 2]
  const keep = tld.length === 2 && TWO_LEVEL.has(sld) ? 3 : 2
  return parts.slice(-keep).join('.')
}
