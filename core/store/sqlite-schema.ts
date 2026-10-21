import { DatabaseSync } from 'node:sqlite'
import { GOALS_SCHEMA, MIGRATIONS, TASKS_SCHEMA, TODAY_SCHEMA } from './sqlite-migrations.js'

/**
 * Converge the durable-inbox schema regardless of migration-version state.
 *
 * Numbered migrations are positional, and this repo's DBs can arrive from
 * branches that already claimed the same version numbers for different tables
 * (e.g. an activity-log branch whose migration 10 created `scan_runs`). When
 * that happens the numbered runner skips *our* migration 10 as "already
 * applied" and `work_items` is never created. This runs after `migrate` and
 * makes the v2 schema present no matter how the version counter got there:
 * tables via IF NOT EXISTS, columns added only when missing. Idempotent, so on
 * a normally-migrated DB it is a no-op.
 */
export function ensureDurableSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_items (
     id                TEXT PRIMARY KEY,
     source            TEXT NOT NULL,
     kind              TEXT NOT NULL,
     status            TEXT NOT NULL DEFAULT 'open',
     status_at         INTEGER NOT NULL,
     snooze_until      INTEGER,
     priority          INTEGER,
     pinned            INTEGER NOT NULL DEFAULT 0,
     returned          INTEGER NOT NULL DEFAULT 0,
     source_updated_at INTEGER NOT NULL,
     ingested_at       INTEGER NOT NULL,
     payload           TEXT NOT NULL,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
   CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source);
   CREATE TABLE IF NOT EXISTS item_events (
     item_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      INTEGER NOT NULL,
     actor   TEXT NOT NULL,
     event   TEXT NOT NULL,
     detail  TEXT,
     PRIMARY KEY (item_id, seq)
   );`)

  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
     id         TEXT PRIMARY KEY,
     path       TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     author     TEXT NOT NULL,
     refs       TEXT NOT NULL,
     created    INTEGER NOT NULL,
     updated    INTEGER NOT NULL,
     mtime      INTEGER NOT NULL,
     size       INTEGER NOT NULL,
     indexed_at INTEGER NOT NULL,
     warning    TEXT
   );
   CREATE TABLE IF NOT EXISTS links (
     id         TEXT PRIMARY KEY,
     from_kind  TEXT NOT NULL,
     from_id    TEXT NOT NULL,
     to_kind    TEXT NOT NULL,
     to_id      TEXT NOT NULL,
     role       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (from_kind, from_id, to_kind, to_id, role)
   );
   CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_kind, to_id);
   CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);
   CREATE TABLE IF NOT EXISTS brief_jobs (
     id          TEXT PRIMARY KEY,
     item_id     TEXT NOT NULL,
     status      TEXT NOT NULL,
     playbook    TEXT NOT NULL,
     model       TEXT,
     note        TEXT,
     session_id  TEXT,
     artifact_id TEXT,
     error       TEXT,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_item ON brief_jobs(item_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_status ON brief_jobs(status, created_at);`)

  const cols = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
  const ensure = (table: string, col: string, decl: string, have: Set<string>) => {
    if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
  }

  // Artifacts of any format, with versions: `format` is what the file is (md for every row before),
  // `version` the commits that touched it (backfilled from git on the first index), `history` 0 for a
  // file over 10 MB kept without history. Here and not in a numbered migration: an ALTER there breaks
  // a DB wound back to an earlier version (test/session-provider.test.ts does that).
  const a = cols('artifacts')
  ensure('artifacts', 'format', "format TEXT NOT NULL DEFAULT 'md'", a)
  ensure('artifacts', 'version', 'version INTEGER NOT NULL DEFAULT 1', a)
  ensure('artifacts', 'history', 'history INTEGER NOT NULL DEFAULT 1', a)
  db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_format ON artifacts(format)')

  const s = cols('sessions')
  ensure('sessions', 'kind', 'kind TEXT', s)
  ensure('sessions', 'job_id', 'job_id TEXT', s)
  ensure('sessions', 'run_status', 'run_status TEXT', s)
  ensure('sessions', 'run_matches', 'run_matches INTEGER', s)
  ensure('sessions', 'run_tokens', 'run_tokens INTEGER', s)
  ensure('sessions', 'run_error', 'run_error TEXT', s)
  ensure('sessions', 'run_cost_usd', 'run_cost_usd REAL', s)
  // Plan mode (Session mode: Normal / Plan / Goal): the session plans before it codes.
  ensure('sessions', 'planning', 'planning INTEGER NOT NULL DEFAULT 0', s)
  // Ultracode: Claude Code runs with settings.ultracode, big jobs fan out as Workflow runs.
  ensure('sessions', 'ultracode', 'ultracode INTEGER NOT NULL DEFAULT 0', s)

  const w = cols('jobs')
  ensure('jobs', 'last_run_status', 'last_run_status TEXT', w)
  ensure('jobs', 'last_run_session_id', 'last_run_session_id TEXT', w)
  ensure('jobs', 'last_run_error', 'last_run_error TEXT', w)
  ensure('jobs', 'template_id', 'template_id TEXT', w)
  ensure('jobs', 'schedule', 'schedule TEXT', w)
  ensure('jobs', 'connectors', 'connectors TEXT', w)
  ensure('jobs', 'project_id', 'project_id TEXT', w)
  ensure('jobs', 'model', 'model TEXT', w)
  ensure('jobs', 'output', 'output TEXT', w)
  for (const [col, decl] of [
    ['tools', 'tools TEXT'], ['config_error', 'config_error TEXT'], ['catch_up_window', 'catch_up_window TEXT'],
    ['timeout_ms', 'timeout_ms INTEGER'], ['max_budget_usd', 'max_budget_usd REAL'], ['daily_budget_usd', 'daily_budget_usd REAL'], ['file', 'file TEXT'], ['notify', 'notify TEXT'],
    ['consecutive_failures', 'consecutive_failures INTEGER NOT NULL DEFAULT 0'],
    ['last_run_started_at', 'last_run_started_at INTEGER'], ['last_run_new', 'last_run_new INTEGER'], ['last_run_trigger', 'last_run_trigger TEXT'],
    ['brief', 'brief TEXT'], ['draft', 'draft INTEGER NOT NULL DEFAULT 0'],
    ['skills', 'skills TEXT'], ['agents', 'agents TEXT'],
  ]) ensure('jobs', col, decl, w)
  ensure('sessions', 'run_trigger', 'run_trigger TEXT', s)
  ensure('sessions', 'run_new', 'run_new INTEGER', s)

  ensure('sessions', 'project_id', 'project_id TEXT', s)
  ensure('sessions', 'provider', "provider TEXT NOT NULL DEFAULT 'claude'", s)
  ensure('sessions', 'checkout_id', 'checkout_id TEXT', s)
  db.exec(`CREATE TABLE IF NOT EXISTS checkouts (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
     branch TEXT, base TEXT, item_id TEXT, state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_checkouts_project ON checkouts(project_id);`)
  db.exec(`CREATE TABLE IF NOT EXISTS actions (
     id             TEXT PRIMARY KEY,
     session_id     TEXT NOT NULL,
     session_kind   TEXT NOT NULL,
     tool           TEXT NOT NULL,
     kind           TEXT NOT NULL,
     summary        TEXT NOT NULL,
     args           TEXT NOT NULL,
     status         TEXT NOT NULL,
     link           TEXT,
     error          TEXT,
     why            TEXT NOT NULL,
     why_detail     TEXT,
     allowed_by     TEXT,
     allowed_detail TEXT,
     job_id       TEXT,
     team_run_id    TEXT,
     item_id        TEXT,
     group_key      TEXT,
     count          INTEGER NOT NULL DEFAULT 1,
     attempted_at   INTEGER NOT NULL,
     settled_at     INTEGER,
     updated_at     INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_actions_attempted ON actions(attempted_at DESC);
   CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);
   CREATE INDEX IF NOT EXISTS idx_actions_item ON actions(item_id);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_group ON actions(group_key) WHERE group_key IS NOT NULL;
   CREATE TABLE IF NOT EXISTS action_calls (
     session_id  TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     action_id   TEXT NOT NULL,
     PRIMARY KEY (session_id, tool_use_id)
   );
   CREATE INDEX IF NOT EXISTS idx_action_calls_action ON action_calls(action_id);
   CREATE TABLE IF NOT EXISTS action_history (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     action_id  TEXT NOT NULL,
     at         INTEGER NOT NULL,
     actor      TEXT NOT NULL,
     event      TEXT NOT NULL,
     from_status TEXT,
     to_status  TEXT NOT NULL,
     note       TEXT,
     args       TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_action_history_action ON action_history(action_id, id);`)

  // Queued actions (core/actions/queue.ts): a held call's approval state.
  // NULL queue_args = recorded as it ran, no queue.
  const ac = cols('actions')
  ensure('actions', 'queue_args', 'queue_args TEXT', ac)
  ensure('actions', 'queued_at', 'queued_at INTEGER', ac)
  ensure('actions', 'expires_at', 'expires_at INTEGER', ac)
  ensure('actions', 'send_at', 'send_at INTEGER', ac)
  ensure('actions', 'queue_note', 'queue_note TEXT', ac)
  ensure('actions', 'edits', 'edits INTEGER NOT NULL DEFAULT 0', ac)
  ensure('actions', 'delivery', 'delivery TEXT', ac)
  ensure('actions', 'cost_usd', 'cost_usd REAL', ac)
  db.exec('CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status)')

  const wi = cols('work_items')
  ensure('work_items', 'due_at', 'due_at INTEGER', wi)
  ensure('work_items', 'due_source', 'due_source TEXT', wi)
  // Stage and turn (core/work/flow.ts): the last derived values, kept so a
  // change can be logged, and the user's override as JSON.
  ensure('work_items', 'stage', 'stage TEXT', wi)
  ensure('work_items', 'turn', 'turn TEXT', wi)
  ensure('work_items', 'flow_override', 'flow_override TEXT', wi)

  // The template text the user edited in the brief composer, when it differs from the file.
  ensure('brief_jobs', 'playbook_body', 'playbook_body TEXT', cols('brief_jobs'))

  db.exec(GOALS_SCHEMA)
  db.exec(TODAY_SCHEMA)
  db.exec(TASKS_SCHEMA)
}

/*
 * Jobs were called watches before v1.1, and a DB from then says so: its
 * tables, its `watch_id` columns, and the values it stored (session and item
 * kinds, digest item ids, config keys). Both steps rename in place and find
 * nothing to do once they have, so they run on every open. The tables go
 * before `migrate`, whose later steps name the new ones; the values after
 * `ensureDurableSchema`, which may be what created the tables they touch.
 */
export function renameLegacyTables(db: DatabaseSync) {
  const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name))
  if (tables.has('watches') && !tables.has('jobs')) db.exec('ALTER TABLE watches RENAME TO jobs')
  if (tables.has('watch_runs') && !tables.has('job_runs')) db.exec('ALTER TABLE watch_runs RENAME TO job_runs')
  for (const table of ['sessions', 'job_runs', 'actions']) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
    if (cols.has('watch_id') && !cols.has('job_id')) db.exec(`ALTER TABLE ${table} RENAME COLUMN watch_id TO job_id`)
  }
}

export function renameLegacyValues(db: DatabaseSync) {
  const id = (col: string) => `${col} = 'job:' || substr(${col}, 7) WHERE ${col} GLOB 'watch:*'`
  const steps = [
    `UPDATE sessions SET kind = 'job-run' WHERE kind = 'watch-run'`,
    `UPDATE actions SET session_kind = 'job-run' WHERE session_kind = 'watch-run'`,
    `UPDATE OR IGNORE config SET key = 'jobs.' || substr(key, 9) WHERE key GLOB 'watches.*'`,
    `UPDATE work_items SET kind = 'job-hit' WHERE kind = 'watch-hit'`,
    `UPDATE work_items SET source = 'job' WHERE source = 'watch'`,
    `UPDATE work_items SET payload = replace(replace(replace(replace(payload,
       '"watchId":', '"jobId":'), '"kind":"watch-hit"', '"kind":"job-hit"'), '"source":"watch"', '"source":"job"'), '"id":"watch:', '"id":"job:')
     WHERE payload GLOB '*"watchId":*' OR payload GLOB '*"kind":"watch-hit"*' OR payload GLOB '*"source":"watch"*' OR payload GLOB '*"id":"watch:*'`,
    `UPDATE OR IGNORE work_items SET ${id('id')}`,
    `UPDATE item_events SET ${id('item_id')}`,
    `UPDATE item_events SET ${id('actor')}`,
    `UPDATE OR IGNORE links SET ${id('from_id')} AND from_kind = 'item'`,
    `UPDATE OR IGNORE links SET ${id('to_id')} AND to_kind = 'item'`,
    `UPDATE brief_jobs SET ${id('item_id')}`,
    `UPDATE brief_jobs SET playbook = 'job-hit' WHERE playbook = 'watch-hit'`,
    `UPDATE checkouts SET ${id('item_id')}`,
    `UPDATE actions SET ${id('item_id')}`,
  ]
  db.exec('BEGIN')
  try {
    let changed = 0
    for (const sql of steps) changed += Number(db.prepare(sql).run().changes)
    // the saved inbox was ranked from the old values; the next sync rebuilds it
    if (changed) db.exec('DELETE FROM inbox_snapshot')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
