/**
 * The browser host wire (.docs/browser.md): Triage.app's main process dials the
 * daemon at `/browser-host` and executes the verbs the daemon sends, against
 * the one tab that belongs to the session named in the frame. The daemon
 * shapes (snapshots, logs, evidence); the app only runs Chrome DevTools
 * Protocol commands on the right tab.
 *
 * `desktop/src/browser.ts` keeps a copy of these types, its tsconfig can't
 * reach outside `desktop/src`, so a change here is a change there too, and a
 * new BROWSER_WIRE_VERSION.
 */

export const BROWSER_WIRE_VERSION = 1
export const BROWSER_HOST_PATH = '/browser-host'

/** What the agent's tab is laid out at, independent of the pane it is shown in. */
export type Viewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }

export type HostVerb =
  /** load a URL in the session's tab, creating it; resolves once it loaded (or the wait ran out) */
  | { verb: 'open'; url: string; wait: 'load' | 'idle' }
  /**
   * one CDP command on the session's tab. Input.dispatchMouseEvent coordinates
   * are CSS pixels: the app scales them to the pane's zoom itself.
   */
  | { verb: 'cdp'; method: string; params?: Record<string, unknown> }
  /** set the tab's emulated viewport (null = fit the pane) and dark/light */
  | { verb: 'viewport'; viewport: Viewport | null; colorScheme?: 'dark' | 'light' | null }
  /** outline an element for a moment, so whoever watches sees what the agent touched */
  | { verb: 'flash'; backendNodeId: number }
  /** the tab's current state: URL, title, viewport, whether it exists */
  | { verb: 'state' }
  | { verb: 'close' }

export type TabState = {
  exists: boolean
  url: string
  title: string
  loading: boolean
  viewport: Viewport | null
  colorScheme: 'dark' | 'light' | null
}

/** daemon → app */
export type DaemonFrame = { type: 'call'; id: number; sessionId: string } & HostVerb

/** One thing the page said that the agent may need: console, uncaught errors, failed requests. */
export type PageLog = {
  level: 'error' | 'warning' | 'info'
  source: 'console' | 'exception' | 'network'
  text: string
  /** where it came from: the script URL, or the failed request's URL */
  url?: string
  at: number
}

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
      return typeof f.sessionId === 'string' && !!f.log && typeof f.log === 'object' ? (f as HostFrame) : null
    case 'navigated':
      return typeof f.sessionId === 'string' && typeof f.url === 'string' ? (f as HostFrame) : null
    case 'touched':
    case 'closed':
      return typeof f.sessionId === 'string' ? (f as HostFrame) : null
    default:
      return null
  }
}
