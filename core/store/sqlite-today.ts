import { DatabaseSync } from 'node:sqlite'
import type { TodayStore } from './types.js'
import { type AddedBy, type TodayEntry, isOwner, type TodayDay } from '../junior/today.js'

type TodayRow = {
  date: string
  item_id: string
  owner: string
  added_by: string
  added_at: number
  ord: number
  carried_from: string | null
}

const toAddedBy = (v: string): AddedBy => (v === 'junior' || v === 'draft' ? v : 'you')

function toTodayEntry(r: TodayRow): TodayEntry {
  return {
    date: r.date,
    itemId: r.item_id,
    owner: isOwner(r.owner) ? r.owner : 'you',
    addedBy: toAddedBy(r.added_by),
    addedAt: r.added_at,
    order: r.ord,
    carriedFrom: r.carried_from,
  }
}

export class SqliteToday implements TodayStore {
  constructor(private db: DatabaseSync) {}

  async day(date: string): Promise<TodayDay | null> {
    const r = this.db.prepare('SELECT date, created_at, drafted_at FROM today_days WHERE date = ?').get(date) as
      | { date: string; created_at: number; drafted_at: number | null }
      | undefined
    return r ? { date: r.date, createdAt: r.created_at, draftedAt: r.drafted_at } : null
  }

  async openDay(day: TodayDay, rows: readonly TodayEntry[]): Promise<boolean> {
    this.db.exec('BEGIN')
    try {
      const made = this.db
        .prepare('INSERT OR IGNORE INTO today_days (date, created_at, drafted_at) VALUES (?, ?, ?)')
        .run(day.date, day.createdAt, day.draftedAt).changes
      if (made) for (const e of rows) this.insert(e)
      this.db.exec('COMMIT')
      return made > 0
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async setDrafted(date: string, at: number): Promise<void> {
    this.db.prepare('UPDATE today_days SET drafted_at = ? WHERE date = ?').run(at, date)
  }

  async entries(date: string): Promise<TodayEntry[]> {
    const rows = this.db.prepare('SELECT * FROM today_entries WHERE date = ? ORDER BY ord, added_at').all(date) as TodayRow[]
    return rows.map(toTodayEntry)
  }

  async lastBefore(date: string): Promise<{ date: string; entries: TodayEntry[] } | null> {
    const r = this.db.prepare('SELECT MAX(date) AS d FROM today_entries WHERE date < ?').get(date) as { d: string | null }
    if (!r.d) return null
    return { date: r.d, entries: await this.entries(r.d) }
  }

  private insert(e: TodayEntry) {
    this.db
      .prepare(
        `INSERT INTO today_entries (date, item_id, owner, added_by, added_at, ord, carried_from) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date, item_id) DO UPDATE SET owner = excluded.owner`,
      )
      .run(e.date, e.itemId, e.owner, e.addedBy, e.addedAt, e.order, e.carriedFrom)
  }

  async put(e: TodayEntry): Promise<void> {
    this.insert(e)
  }

  async remove(date: string, itemId: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM today_entries WHERE date = ? AND item_id = ?').run(date, itemId).changes > 0
  }

  async everPlanned(): Promise<boolean> {
    const r = this.db
      .prepare('SELECT (EXISTS (SELECT 1 FROM today_entries) OR EXISTS (SELECT 1 FROM today_days WHERE drafted_at IS NOT NULL)) AS yes')
      .get() as { yes: number }
    return r.yes === 1
  }
}
