/**
 * SQLite adapter for the Store interface, on node:sqlite (stdlib — keeps the
 * global install dependency-free; vision principle 5).
 *
 * Single-writer by design: SQLite has one writer and this process is it.
 * Nothing here may leak into the interface — a Postgres adapter for the hosted
 * version implements core/store/types.ts, not this file.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { SqliteGoals } from './sqlite-goals.js'
import type { Store } from './types.js'
import { SqliteActions } from './sqlite-actions.js'
import { SqliteArtifacts, SqliteBriefJobs, SqliteLinks } from './sqlite-artifacts.js'
import { SqliteWorkItems } from './sqlite-items.js'
import { SqliteJobRuns, SqliteJobs } from './sqlite-jobs.js'
import { SqliteCheckouts, SqliteProjects } from './sqlite-projects.js'
import { ensureDurableSchema, migrate, renameLegacyTables, renameLegacyValues } from './sqlite-schema.js'
import { SqliteConfig, SqliteEvents, SqliteInbox, SqliteSessions, SqliteTurns } from './sqlite-sessions.js'
import { SqliteToday } from './sqlite-today.js'

export function openSqliteStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  renameLegacyTables(db)
  migrate(db)
  ensureDurableSchema(db)
  renameLegacyValues(db)

  return {
    sessions: new SqliteSessions(db),
    events: new SqliteEvents(db),
    turns: new SqliteTurns(db),
    inbox: new SqliteInbox(db),
    config: new SqliteConfig(db),
    projects: new SqliteProjects(db),
    checkouts: new SqliteCheckouts(db),
    jobs: new SqliteJobs(db),
    jobRuns: new SqliteJobRuns(db),
    items: new SqliteWorkItems(db),
    artifacts: new SqliteArtifacts(db),
    links: new SqliteLinks(db),
    briefs: new SqliteBriefJobs(db),
    actions: new SqliteActions(db),
    goals: new SqliteGoals(db),
    today: new SqliteToday(db),
    close: async () => db.close(),
  }
}
