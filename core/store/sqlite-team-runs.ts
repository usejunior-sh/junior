/**
 * The team-run adapter (TeamRunStore in core/store/types.ts) over the tables in
 * TEAM_RUNS_SCHEMA (core/store/sqlite-migrations.ts). Goals are team runs with
 * `goal` set, so they live here too.
 *
 * The run is stored whole as JSON; `status`, `goal`, `created_at` and
 * `updated_at` are copies of it for the lists to filter and sort on. Every
 * method is synchronous underneath (node:sqlite), so appendEvent's
 * read-max-then-insert can't interleave with another caller.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { RunState, TeamRun } from '../teams/engine-types.js'
import type { TeamRunEvent, TeamRunStore } from './types.js'

/** A run in one of these is over: listOpen leaves it out. */
export const TEAM_RUN_CLOSED_STATES: readonly RunState[] = ['done', 'stopped']

/** Where team runs lived before these tables: one JSON array under this config key. */
export const LEGACY_TEAM_RUNS_KEY = 'team_runs'
/** Config key recording that the legacy array was copied in, and by which copy. */
export const LEGACY_TEAM_RUNS_COPIED_KEY = 'team_runs.copied'
/**
 * Bump to copy the legacy array again. Until server/team-run/state.ts moves to
 * this store it still saves to the config array, so runs saved after the first
 * copy aren't in the tables: the change that switches it over should bump this
 * once, so its first boot picks them up. A copy never overwrites a row that is
 * already there: rows the store wrote win over the old array.
 */
export const LEGACY_TEAM_RUNS_COPY_VERSION = 1

type RunRow = { id: string; status: string; goal: number; created_at: number; updated_at: number; json: string }
type EventRow = { run_id: string; seq: number; at: number; json: string }

const CLOSED_SQL = TEAM_RUN_CLOSED_STATES.map((s) => `'${s}'`).join(', ')

function parse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** A row whose JSON no longer parses reads as missing, never as a crash. */
const toRun = (r: RunRow): TeamRun | null => {
  const run = parse<TeamRun>(r.json)
  return run && typeof run === 'object' ? run : null
}

const toEvent = (r: EventRow): TeamRunEvent => ({ runId: r.run_id, seq: r.seq, at: r.at, data: parse<unknown>(r.json) ?? null })

const runs = (rows: RunRow[]): TeamRun[] => rows.map(toRun).filter((r): r is TeamRun => r !== null)

export class SqliteTeamRuns implements TeamRunStore {
  constructor(private db: DatabaseSync) {}

  async upsert(run: TeamRun, at: number): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO team_runs (id, status, goal, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, goal = excluded.goal,
           created_at = excluded.created_at, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(run.id, run.state, run.goal ? 1 : 0, run.createdAt, at, JSON.stringify(run))
  }

  async get(id: string): Promise<TeamRun | null> {
    const r = this.db.prepare('SELECT * FROM team_runs WHERE id = ?').get(id) as RunRow | undefined
    return r ? toRun(r) : null
  }

  async listOpen(): Promise<TeamRun[]> {
    return runs(this.db.prepare(`SELECT * FROM team_runs WHERE status NOT IN (${CLOSED_SQL}) ORDER BY created_at, id`).all() as RunRow[])
  }

  async listRecent(limit: number, opts: { goal?: boolean } = {}): Promise<TeamRun[]> {
    const n = Math.max(0, Math.floor(limit))
    const where = opts.goal === undefined ? '' : 'WHERE goal = ?'
    const args: number[] = opts.goal === undefined ? [n] : [opts.goal ? 1 : 0, n]
    const sql = `SELECT * FROM team_runs ${where} ORDER BY updated_at DESC, created_at DESC, id LIMIT ?`
    return runs(this.db.prepare(sql).all(...args) as RunRow[])
  }

  async appendEvent<T>(runId: string, data: T, at: number): Promise<TeamRunEvent<T>> {
    const { seq } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM team_run_events WHERE run_id = ?').get(runId) as { seq: number }
    this.db.prepare('INSERT INTO team_run_events (run_id, seq, at, json) VALUES (?, ?, ?, ?)').run(runId, seq, at, JSON.stringify(data ?? null))
    return { runId, seq, at, data }
  }

  async events(runId: string): Promise<TeamRunEvent[]> {
    return (this.db.prepare('SELECT * FROM team_run_events WHERE run_id = ? ORDER BY seq').all(runId) as EventRow[]).map(toEvent)
  }
}

/**
 * Copy the legacy `team_runs` config array into rows, once per
 * LEGACY_TEAM_RUNS_COPY_VERSION. The config key stays as it was. Entries
 * without a string id are skipped; a row already there is left alone. Returns
 * how many rows it added. Runs on every open and finds nothing to do once the
 * marker is set.
 */
export function copyLegacyTeamRuns(db: DatabaseSync, now: number = Date.now()): number {
  const read = (key: string): unknown => {
    const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    return r ? parse<unknown>(r.value) : undefined
  }
  const marker = read(LEGACY_TEAM_RUNS_COPIED_KEY) as { version?: unknown } | undefined
  if (marker && typeof marker.version === 'number' && marker.version >= LEGACY_TEAM_RUNS_COPY_VERSION) return 0

  const legacy = read(LEGACY_TEAM_RUNS_KEY)
  const list = Array.isArray(legacy) ? legacy : []
  const insert = db.prepare('INSERT OR IGNORE INTO team_runs (id, status, goal, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)')
  let copied = 0
  db.exec('BEGIN')
  try {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const run = raw as Partial<TeamRun>
      if (typeof run.id !== 'string' || !run.id) continue
      // A run with no state can't be resumed: file it as stopped so boot doesn't load it.
      const status = typeof run.state === 'string' ? run.state : 'stopped'
      const created = typeof run.createdAt === 'number' ? run.createdAt : now
      copied += Number(insert.run(run.id, status, run.goal ? 1 : 0, created, created, JSON.stringify(run)).changes)
    }
    db.prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(LEGACY_TEAM_RUNS_COPIED_KEY, JSON.stringify({ version: LEGACY_TEAM_RUNS_COPY_VERSION, at: now, copied }))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return copied
}
