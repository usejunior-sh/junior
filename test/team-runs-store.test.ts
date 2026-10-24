/**
 * The team-run store (core/store/sqlite-team-runs.ts): runs get their own rows
 * instead of one config array. The legacy array is copied in once and left in
 * place; listOpen leaves out done and stopped runs; the event log is
 * append-only with its own seq per run. All against :memory:, no server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { ensureDurableSchema, migrate } from '../core/store/sqlite-schema.js'
import {
  copyLegacyTeamRuns,
  LEGACY_TEAM_RUNS_COPIED_KEY,
  LEGACY_TEAM_RUNS_COPY_VERSION,
  LEGACY_TEAM_RUNS_KEY,
  LEGACY_TEAM_RUNS_LIVE_UNTIL,
  SqliteTeamRuns,
} from '../core/store/sqlite-team-runs.js'
import type { RunGoal, RunState, TeamRun } from '../core/teams/engine-types.js'
import { summarizeRun } from '../core/teams/summary.js'

/** Just enough of a run for the store: it keeps the rest as JSON, untouched. */
const run = (id: string, state: RunState, createdAt: number, extra: Partial<TeamRun> = {}): TeamRun =>
  ({ id, state, createdAt, itemId: `manual:${id}`, title: `Run ${id}`, leadSessionId: `lead-${id}`, rev: 1, workers: [], outputs: [], ...extra }) as unknown as TeamRun

const goal = { doneWhen: 'CI green', horizon: 'today' } as unknown as RunGoal

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  ensureDurableSchema(db)
  return db
}

const setConfig = (db: DatabaseSync, key: string, value: unknown) =>
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
const getConfig = (db: DatabaseSync, key: string): unknown => {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
  return r ? JSON.parse(r.value) : undefined
}
const rowCount = (db: DatabaseSync) => (db.prepare('SELECT COUNT(*) AS n FROM team_runs').get() as { n: number }).n

test('upsert, get and the lists: listOpen leaves out done and stopped', async () => {
  const store = openSqliteStore(':memory:')
  const t = store.teamRuns
  await t.upsert(run('a', 'running', 1), 10)
  await t.upsert(run('b', 'done', 2), 20)
  await t.upsert(run('c', 'stopped', 3), 30)
  await t.upsert(run('d', 'waiting', 4, { goal }), 40)
  await t.upsert(run('e', 'proposed', 5), 50)
  await t.upsert(run('f', 'paused', 6), 60)
  await t.upsert(run('g', 'gate', 7), 70)

  assert.deepEqual((await t.listOpen()).map((r) => r.id), ['a', 'd', 'e', 'f', 'g'])
  assert.equal(await t.get('missing'), null)
  assert.deepEqual(await t.get('d'), run('d', 'waiting', 4, { goal }))

  // An upsert replaces the whole run and moves it up the recent list.
  await t.upsert(run('a', 'done', 1, { title: 'Renamed' }), 100)
  assert.equal((await t.get('a'))?.title, 'Renamed')
  assert.deepEqual((await t.listOpen()).map((r) => r.id), ['d', 'e', 'f', 'g'])
  assert.deepEqual((await t.listRecent(3)).map((r) => r.id), ['a', 'g', 'f'])
  assert.deepEqual((await t.listRecent(10, { goal: true })).map((r) => r.id), ['d'])
  assert.equal((await t.listRecent(10, { goal: false })).length, 6)
  assert.deepEqual(await t.listRecent(0), [])
  await store.close()
})

test('events: append-only, seq per run, oldest first', async () => {
  const store = openSqliteStore(':memory:')
  const t = store.teamRuns
  const one = await t.appendEvent('r1', { kind: 'proposed' }, 5)
  const two = await t.appendEvent('r1', { kind: 'approved', by: 'you' }, 6)
  const other = await t.appendEvent('r2', { kind: 'proposed' }, 7)
  assert.deepEqual([one.seq, two.seq, other.seq], [1, 2, 1])
  assert.deepEqual(await t.events('r1'), [
    { runId: 'r1', seq: 1, at: 5, data: { kind: 'proposed' } },
    { runId: 'r1', seq: 2, at: 6, data: { kind: 'approved', by: 'you' } },
  ])
  assert.deepEqual(await t.events('none'), [])
  await store.close()
})

test('a row whose JSON is broken reads as missing, not a crash', async () => {
  const db = freshDb()
  const t = new SqliteTeamRuns(db)
  await t.upsert(run('ok', 'running', 1), 1)
  db.prepare("INSERT INTO team_runs (id, status, goal, created_at, updated_at, json) VALUES ('bad', 'running', 0, 2, 2, '{nope')").run()
  assert.equal(await t.get('bad'), null)
  assert.deepEqual((await t.listOpen()).map((r) => r.id), ['ok'])
  db.close()
})

test('migration: the legacy array is copied in once, and the config key stays', async () => {
  const db = freshDb()
  const legacy = [
    run('old-1', 'done', 100),
    run('old-2', 'running', 200, { goal }),
    { title: 'no id' },
    null,
    { id: 'no-state', createdAt: 300 },
  ]
  setConfig(db, LEGACY_TEAM_RUNS_KEY, legacy)

  assert.equal(copyLegacyTeamRuns(db, 999), 3)
  const t = new SqliteTeamRuns(db)
  assert.deepEqual(await t.get('old-2'), run('old-2', 'running', 200, { goal }))
  // no state: filed as stopped so boot never loads it as open
  assert.deepEqual((await t.listOpen()).map((r) => r.id), ['old-2'])
  assert.deepEqual((await t.listRecent(10, { goal: true })).map((r) => r.id), ['old-2'])
  assert.deepEqual(getConfig(db, LEGACY_TEAM_RUNS_KEY), legacy)
  assert.deepEqual(getConfig(db, LEGACY_TEAM_RUNS_COPIED_KEY), { version: LEGACY_TEAM_RUNS_COPY_VERSION, at: 999, copied: 3 })

  // Exactly once: the store moves on, the old array changes, a second copy does nothing.
  await t.upsert(run('old-2', 'done', 200, { goal }), 1000)
  await t.upsert(run('new', 'running', 1001), 1001)
  setConfig(db, LEGACY_TEAM_RUNS_KEY, [...legacy, run('later', 'running', 500)])
  assert.equal(copyLegacyTeamRuns(db, 2000), 0)
  assert.equal(rowCount(db), 4)
  assert.equal((await t.get('old-2'))?.state, 'done')
  assert.equal(await t.get('later'), null)

  // Running the whole migration again changes nothing either.
  migrate(db)
  ensureDurableSchema(db)
  assert.equal(copyLegacyTeamRuns(db, 3000), 0)
  assert.equal(rowCount(db), 4)
  db.close()
})

test('migration: a copy after the store took over adds only runs that are missing, never overwrites', async () => {
  const db = freshDb()
  setConfig(db, LEGACY_TEAM_RUNS_KEY, [run('kept', 'running', 1), run('missing', 'running', 2)])
  const t = new SqliteTeamRuns(db)
  await t.upsert(run('kept', 'done', 1), 50)
  // A future bump (3) over a DB whose last copy was at or past the switch-over.
  setConfig(db, LEGACY_TEAM_RUNS_COPIED_KEY, { version: LEGACY_TEAM_RUNS_LIVE_UNTIL })
  assert.equal(copyLegacyTeamRuns(db, 60, LEGACY_TEAM_RUNS_LIVE_UNTIL + 1), 1)
  assert.equal((await t.get('kept'))?.state, 'done')
  assert.equal((await t.get('missing'))?.state, 'running')
  db.close()
})

test('migration: a DB copied while the array was still live gets its rows refreshed from it', async () => {
  const db = freshDb()
  // Copied at version 1, then the server went on saving to the array: 'a' finished, 'b' was proposed.
  setConfig(db, LEGACY_TEAM_RUNS_KEY, [run('a', 'running', 1)])
  copyLegacyTeamRuns(db, 10, 1)
  setConfig(db, LEGACY_TEAM_RUNS_KEY, [run('a', 'done', 1), run('b', 'proposed', 2)])
  assert.equal(copyLegacyTeamRuns(db, 20), 2)
  const t = new SqliteTeamRuns(db)
  assert.equal((await t.get('a'))?.state, 'done')
  assert.deepEqual((await t.listOpen()).map((r) => r.id), ['b'])
  assert.deepEqual(getConfig(db, LEGACY_TEAM_RUNS_COPIED_KEY), { version: LEGACY_TEAM_RUNS_COPY_VERSION, at: 20, copied: 2 })
  assert.equal(copyLegacyTeamRuns(db, 30), 0)
  db.close()
})

test('closedSummaries reads done and stopped runs out of the JSON, the same as summarizeRun; remove drops a run and its log', async () => {
  const store = openSqliteStore(':memory:')
  const t = store.teamRuns
  const recipe = { label: 'Build', steps: [] }
  const workers = [
    { id: 'lead:1', stepId: 'plan', agent: 'lead', label: 'Lead', sessionId: 'lead-g' },
    { id: 'build:1', stepId: 'build', agent: 'implementer', label: 'Implementer', sessionId: 'w1' },
    { id: 'review:1', stepId: 'review', agent: 'reviewer', label: 'Reviewer', sessionId: null },
  ]
  const questions = [
    { id: 'q1', text: 'which branch?', answer: null },
    { id: 'q2', text: 'ok?', answer: 'yes' },
  ]
  const done = run('g', 'done', 3, { recipe, workers, rev: 7, goal: { ...goal, questions, acceptedAt: null } } as unknown as Partial<TeamRun>)
  const stopped = run('s', 'stopped', 1, { recipe, workers: [], goal: null } as unknown as Partial<TeamRun>)
  await t.upsert(done, 30)
  await t.upsert(stopped, 10)
  await t.upsert(run('open', 'running', 2, { recipe } as unknown as Partial<TeamRun>), 20)
  await t.upsert(run('no-recipe', 'done', 4), 40)

  const got = await t.closedSummaries()
  assert.deepEqual(got.map((x) => x.id), ['s', 'g'])
  assert.deepEqual(got, [summarizeRun(stopped), summarizeRun(done)])
  assert.deepEqual(got[1], {
    id: 'g', itemId: 'manual:g', state: 'done', rev: 7, createdAt: 3, goal: true, leadSessionId: 'lead-g', label: 'Build',
    workers: [{ sessionId: 'lead-g', agent: 'lead', label: 'Lead' }, { sessionId: 'w1', agent: 'implementer', label: 'Implementer' }],
    asks: 1, toAccept: true,
  })

  await t.appendEvent('g', { kind: 'state' }, 31)
  await t.remove('g')
  assert.equal(await t.get('g'), null)
  assert.deepEqual(await t.events('g'), [])
  assert.deepEqual((await t.closedSummaries()).map((x) => x.id), ['s'])
  await store.close()
})

test('migration: no legacy value still sets the marker; a broken one is skipped', () => {
  const empty = freshDb()
  assert.equal(copyLegacyTeamRuns(empty, 1), 0)
  assert.deepEqual(getConfig(empty, LEGACY_TEAM_RUNS_COPIED_KEY), { version: LEGACY_TEAM_RUNS_COPY_VERSION, at: 1, copied: 0 })
  empty.close()

  const broken = freshDb()
  broken.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(LEGACY_TEAM_RUNS_KEY, '{not json')
  assert.equal(copyLegacyTeamRuns(broken, 1), 0)
  assert.equal(rowCount(broken), 0)
  broken.close()
})

test('a store reopen copies nothing twice', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-runs-store-'))
  try {
    const file = path.join(dir, 'junior.db')
    // a DB from before this store: migrated, the runs still in the config array
    const old = new DatabaseSync(file)
    migrate(old)
    setConfig(old, LEGACY_TEAM_RUNS_KEY, [run('x', 'running', 1)])
    old.close()

    const second = openSqliteStore(file)
    assert.deepEqual((await second.teamRuns.listOpen()).map((r) => r.id), ['x'])
    await second.teamRuns.upsert(run('x', 'stopped', 1), 5)
    await second.close()

    const third = openSqliteStore(file)
    assert.deepEqual(await third.teamRuns.listOpen(), [])
    assert.equal((await third.teamRuns.listRecent(5)).length, 1)
    await third.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
