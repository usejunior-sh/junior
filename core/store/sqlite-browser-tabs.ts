import { DatabaseSync } from 'node:sqlite'
import type { ColorScheme, Viewport } from '../browser/wire.js'
import type { BrowserTabRow, BrowserTabStore } from './types.js'

type Row = { session_id: string; profile: string | null; url: string; title: string; viewport: string | null; color_scheme: string | null; updated_at: number }

function viewportOf(json: string | null): Viewport | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<Viewport> | null
    if (v && typeof v.width === 'number' && typeof v.height === 'number') {
      return { width: v.width, height: v.height, deviceScaleFactor: typeof v.deviceScaleFactor === 'number' ? v.deviceScaleFactor : 1, mobile: v.mobile === true }
    }
  } catch {}
  return null
}

const schemeOf = (s: string | null): ColorScheme => (s === 'dark' || s === 'light' ? s : null)

const toTab = (r: Row): BrowserTabRow => ({
  sessionId: r.session_id,
  profile: r.profile,
  url: r.url,
  title: r.title,
  viewport: viewportOf(r.viewport),
  colorScheme: schemeOf(r.color_scheme),
  updatedAt: r.updated_at,
})

export class SqliteBrowserTabs implements BrowserTabStore {
  constructor(private db: DatabaseSync) {}

  async get(sessionId: string): Promise<BrowserTabRow | null> {
    const r = this.db.prepare('SELECT * FROM browser_tabs WHERE session_id = ?').get(sessionId) as Row | undefined
    return r ? toTab(r) : null
  }

  async put(sessionId: string, patch: Partial<Omit<BrowserTabRow, 'sessionId' | 'updatedAt'>>, at: number): Promise<void> {
    const cur = (await this.get(sessionId)) ?? { sessionId, profile: null, url: '', title: '', viewport: null, colorScheme: null, updatedAt: at }
    const next = { ...cur, ...patch }
    this.db
      .prepare(
        `INSERT INTO browser_tabs (session_id, profile, url, title, viewport, color_scheme, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET profile = excluded.profile, url = excluded.url, title = excluded.title,
           viewport = excluded.viewport, color_scheme = excluded.color_scheme, updated_at = excluded.updated_at`,
      )
      .run(sessionId, next.profile, next.url, next.title, next.viewport ? JSON.stringify(next.viewport) : null, next.colorScheme, at)
  }

  async remove(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM browser_tabs WHERE session_id = ?').run(sessionId)
  }

  async withProfile(profile: string): Promise<string[]> {
    return (this.db.prepare('SELECT session_id FROM browser_tabs WHERE profile = ?').all(profile) as { session_id: string }[]).map((r) => r.session_id)
  }
}
