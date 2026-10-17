

// The browser pane (.docs/browser.md). The page lives in Triage.app; these are
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
