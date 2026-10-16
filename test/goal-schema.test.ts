/**
 * The goal tables (core/store/sqlite.ts migration 31 + ensureDurableSchema):
 * present after a fresh open, untouched by a reopen, and present even when the
 * migration counter got past 31 without running ours.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../core/store/sqlite.js'

const GOAL_TABLES = ['goal_events', 'goal_gates', 'goal_sessions', 'goal_steps', 'goals']

function withDb(fn: (file: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-schema-'))
    try {
      await fn(path.join(dir, 'triage.db'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const tables = (db: DatabaseSync) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'goal*' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)

test('a fresh store has the goal tables, and reopening it changes nothing', withDb(async (file) => {
  await (await openSqliteStore(file)).close()
  const db = new DatabaseSync(file)
  assert.deepEqual(tables(db), GOAL_TABLES)
  db.prepare(`INSERT INTO goals (id, title, done_when, horizon, state, budget, created_at, updated_at) VALUES ('g1', 'T', 'D', 'today', 'draft_plan', '{}', 1, 1)`).run()
  db.close()

  await (await openSqliteStore(file)).close()
  const again = new DatabaseSync(file)
  assert.deepEqual(tables(again), GOAL_TABLES)
  assert.equal((again.prepare('SELECT COUNT(*) AS n FROM goals').get() as { n: number }).n, 1)
  again.close()
}))

test('the goal tables converge when the migration counter skipped ours', withDb(async (file) => {
  await (await openSqliteStore(file)).close()
  const db = new DatabaseSync(file)
  for (const t of GOAL_TABLES) db.exec(`DROP TABLE ${t}`)
  db.close()

  await (await openSqliteStore(file)).close()
  const back = new DatabaseSync(file)
  assert.deepEqual(tables(back), GOAL_TABLES)
  back.close()
}))

test("a goal's key is unique when given; goals without one don't collide", withDb(async (file) => {
  await (await openSqliteStore(file)).close()
  const db = new DatabaseSync(file)
  const insert = db.prepare(`INSERT INTO goals (id, title, done_when, horizon, state, key, budget, created_at, updated_at) VALUES (?, 'T', 'D', 'today', 'draft_plan', ?, '{}', 1, 1)`)
  insert.run('g1', null)
  insert.run('g2', null)
  insert.run('g3', 'manual:1')
  assert.throws(() => insert.run('g4', 'manual:1'), /UNIQUE/)
  db.close()
}))
