/**
 * The browser host wire (.docs/browser.md): Junior.app's main process dials the
 * daemon at `/browser-host` and executes the verbs the daemon sends, against
 * the one tab that belongs to the session named in the frame. The daemon
 * shapes (snapshots, logs, evidence) and decides which profile a tab is in;
 * the app only runs Chrome DevTools Protocol commands on the right tab, in the
 * cookie jar the frame names.
 *
 * `desktop/src/browser.ts` keeps a copy of these types, its tsconfig can't
 * reach outside `desktop/src`, so a change here is a change there too, and a
 * new BROWSER_WIRE_VERSION.
 */

export const BROWSER_WIRE_VERSION = 3
export const BROWSER_HOST_PATH = '/browser-host'

/** A browser profile's id: 'default' or a slug. `partitionOf(id)` (core/browser/profiles.ts) is its cookie jar. */
export type ProfileId = string

/** What the agent's tab is laid out at, independent of the pane it is shown in. */
export type Viewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
export type ColorScheme = 'dark' | 'light' | null

export type HostVerb =
  /**
   * load a URL in the session's tab, creating it; resolves once it loaded (or
   * the wait ran out). `restore` is applied before the load, so a revived tab
   * never flashes at the wrong size.
   */
  | {
      verb: 'open'
      url: string
      wait: 'load' | 'idle'
      restore?: { viewport: Viewport | null; colorScheme: ColorScheme }
      /** you sent it (the pane's address bar, a profile switch): not the agent's, so no "Junior is driving", and `navigated` says byUser */
      byUser?: boolean
    }
  /**
   * one CDP command on the session's tab. Input.dispatchMouseEvent coordinates
   * are CSS pixels: the app scales them to the pane's zoom itself.
   */
  | { verb: 'cdp'; method: string; params?: Record<string, unknown> }
  /** set the tab's emulated viewport (null = fit the pane) and dark/light */
  | { verb: 'viewport'; viewport: Viewport | null; colorScheme?: ColorScheme }
  /** outline an element for a moment, so whoever watches sees what the agent touched */
  | { verb: 'flash'; backendNodeId: number }
  /** the tab's current state: URL, title, viewport, whether it exists */
  | { verb: 'state' }
  | { verb: 'close' }

/** A JavaScript dialog (alert, confirm, prompt, beforeunload) the page has open: it blocks the page until answered. */
export type PageDialog = { type: string; message: string }

export type TabState = {
  exists: boolean
  url: string
  title: string
  loading: boolean
  viewport: Viewport | null
  colorScheme: ColorScheme
  /** the jar the live tab is in; null when there is no tab */
  profile: ProfileId | null
  /** a sign-in window this tab opened, still open */
  popup: { url: string } | null
  dialog: PageDialog | null
}

/**
 * daemon → app. `sessionId` is the tab key: a session id, `<session>.p<n>` for
 * a session's extra page, or `profile-<id>` for a profile's sign-in tab in Settings. `profile` is the jar the tab must
 * be in: a live tab in another one is recreated in this one first.
 */
export type CallFrame = { type: 'call'; id: number; sessionId: string; profile: ProfileId } & HostVerb

/** One site's cookies in a profile's jar: what "sites with saved logins" is built from. */
export type SiteCookies = { site: string; cookies: number; persistent: number; expiresAt: number | null }

/** daemon → app: work on a whole profile's jar, no tab involved. */
export type ProfileFrame =
  /** → { sites: SiteCookies[] } */
  | { type: 'profile'; id: number; profile: ProfileId; op: 'sites' }
  /** → { removed: number }; one site (registrable domain) or the whole jar */
  | { type: 'profile'; id: number; profile: ProfileId; op: 'clear'; site?: string }
  /** the profile was deleted: close its tabs, wipe the jar, remove its folder at the next launch → null */
  | { type: 'profile'; id: number; profile: ProfileId; op: 'drop' }

export type DaemonFrame = CallFrame | ProfileFrame

/** One thing the page said that the agent may need: console, uncaught errors, failed requests. */
export type PageLog = {
  level: 'error' | 'warning' | 'info'
  source: 'console' | 'exception' | 'network'
  text: string
  /** where it came from: the script URL, or the failed request's URL */
  url?: string
  at: number
}

export type DownloadState = 'completed' | 'cancelled' | 'interrupted' | 'refused'

/** app → daemon */
export type HostFrame =
  | { type: 'hello'; version: number; app: string }
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  /** the page logged something; the daemon buffers it per session */
  | { type: 'log'; sessionId: string; log: PageLog }
  /** the tab navigated (by the agent, a link, or you) */
  | { type: 'navigated'; sessionId: string; url: string; byUser: boolean }
  /** you took the tab somewhere or clicked in it. The agent's next call hears about it */
  | { type: 'touched'; sessionId: string }
  | { type: 'closed'; sessionId: string }
  /** remember me: sent (debounced) after a navigation, a title, viewport or scheme change */
  | { type: 'tab'; sessionId: string; profile: ProfileId; url: string; title: string; viewport: Viewport | null; colorScheme: ColorScheme }
  /** a sign-in window opened from the tab, or closed */
  | { type: 'popup'; sessionId: string; url: string; state: 'opened' | 'closed' }
  /** a JavaScript dialog opened (or was answered: null) */
  | { type: 'dialog'; sessionId: string; dialog: PageDialog | null }
  /** a link or window.open in the tab wants a new tab: the daemon makes it a new page in the session (v3) */
  | { type: 'newpage'; sessionId: string; url: string }
  /** a download finished, failed or was refused; `byAgent` = it started during an agent call */
  | { type: 'download'; sessionId: string; file: string; path: string; bytes: number; state: DownloadState; byAgent: boolean }

const str = (v: unknown) => typeof v === 'string'

export function parseHostFrame(raw: string): HostFrame | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  switch (f.type) {
    case 'hello':
      return typeof f.version === 'number' ? (f as HostFrame) : null
    case 'result':
      return typeof f.id === 'number' && typeof f.ok === 'boolean' ? (f as HostFrame) : null
    case 'log':
      return str(f.sessionId) && !!f.log && typeof f.log === 'object' ? (f as HostFrame) : null
    case 'navigated':
      return str(f.sessionId) && str(f.url) ? (f as HostFrame) : null
    case 'touched':
    case 'closed':
      return str(f.sessionId) ? (f as HostFrame) : null
    case 'tab':
      return str(f.sessionId) && str(f.profile) && str(f.url) && str(f.title) ? (f as HostFrame) : null
    case 'popup':
      return str(f.sessionId) && str(f.url) && (f.state === 'opened' || f.state === 'closed') ? (f as HostFrame) : null
    case 'dialog':
      return str(f.sessionId) && (f.dialog === null || (!!f.dialog && typeof f.dialog === 'object')) ? (f as HostFrame) : null
    case 'newpage':
      return str(f.sessionId) && str(f.url) ? (f as HostFrame) : null
    case 'download':
      return str(f.sessionId) && str(f.file) && str(f.path) && typeof f.bytes === 'number' && str(f.state) ? (f as HostFrame) : null
    default:
      return null
  }
}
