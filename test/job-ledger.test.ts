/**
 * The slot ledger (`job_runs`) against a real sqlite store in a temp dir —
 * never ~/.junior. Time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { NewJobSlotRun } from '../core/job/types.js'

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-ledger-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    await fn(store)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const running = (jobId: string, slot: number, extra: Partial<NewJobSlotRun> = {}): NewJobSlotRun => ({
  jobId, slot, trigger: 'scheduled', status: 'running', startedAt: slot + 5, ...extra,
})

test('the same (job, slot) twice leaves one row, first write wins', () =>
  withStore(async ({ jobRuns }) => {
    assert.equal(await jobRuns.insert(running('w1', 1000)), true)
    assert.equal(await jobRuns.insert(running('w1', 1000, { trigger: 'manual', status: 'skipped', reason: 'overlap: x' })), false)
    const rows = await jobRuns.list('w1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'running')
    assert.equal(rows[0].trigger, 'scheduled')
    assert.equal(rows[0].reason, undefined)
  }))

test('finishing a run sets status, reason, ended_at, cost and session', () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000))
    assert.equal(await jobRuns.finish('w1', 1000, { status: 'failed', reason: 'boom', sessionId: 's1', endedAt: 4000, costUsd: 0.42 }), true)
    const [row] = await jobRuns.list('w1')
    assert.deepEqual(
      [row.status, row.reason, row.endedAt, row.costUsd, row.sessionId, row.startedAt],
      ['failed', 'boom', 4000, 0.42, 's1', 1005],
    )
    // only a running row can be finished
    assert.equal(await jobRuns.finish('w1', 1000, { status: 'ok', endedAt: 5000 }), false)
    assert.equal((await jobRuns.list('w1'))[0].status, 'failed')
  }))

test("listing one job's runs is scoped to it, newest slot first", () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000))
    await jobRuns.insert(running('w1', 3000))
    await jobRuns.insert(running('w1', 2000))
    await jobRuns.insert(running('w2', 9000))
    assert.deepEqual((await jobRuns.list('w1')).map((r) => r.slot), [3000, 2000, 1000])
    assert.deepEqual((await jobRuns.list('w2')).map((r) => r.slot), [9000])
    assert.deepEqual(await jobRuns.list('nobody'), [])
  }))

test('boot sweep: running becomes interrupted with a reason, other statuses are untouched', () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000))
    await jobRuns.insert(running('w1', 2000, { status: 'ok', endedAt: 2100 }))
    await jobRuns.insert(running('w1', 3000, { status: 'skipped', reason: 'overlap: x', endedAt: 3005 }))
    await jobRuns.insert(running('w2', 4000, { status: 'failed', reason: 'boom', endedAt: 4100 }))
    await jobRuns.insert(running('w2', 5000))
    assert.equal(await jobRuns.sweepInterrupted(9000, 'interrupted: junior stopped'), 2)
    const w1 = await jobRuns.list('w1')
    assert.deepEqual(w1.map((r) => r.status), ['skipped', 'ok', 'interrupted'])
    assert.deepEqual([w1[2].reason, w1[2].endedAt], ['interrupted: junior stopped', 9000])
    assert.deepEqual([w1[0].reason, w1[0].endedAt, w1[1].reason, w1[1].endedAt], ['overlap: x', 3005, undefined, 2100])
    const w2 = await jobRuns.list('w2')
    assert.deepEqual(w2.map((r) => r.status), ['interrupted', 'failed'])
    assert.deepEqual([w2[1].reason, w2[1].endedAt], ['boom', 4100])
    assert.equal(await jobRuns.sweepInterrupted(9100, 'again'), 0)
  }))

test('a catch-up writes missed rows covered by its run, keeping any existing row', () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000, { id: 'run-1', trigger: 'catch_up' }))
    await jobRuns.insert(running('w1', 3000, { status: 'skipped', reason: 'overlap: x', endedAt: 3005 }))
    assert.equal(await jobRuns.insertMissed('w1', [2000, 3000, 4000], 'run-1', 5000), 2)
    const rows = await jobRuns.list('w1')
    assert.deepEqual(rows.map((r) => [r.slot, r.status, r.reason]), [
      [4000, 'missed', 'covered by run-1'],
      [3000, 'skipped', 'overlap: x'],
      [2000, 'missed', 'covered by run-1'],
      [1000, 'running', undefined],
    ])
    assert.equal(rows[3].id, 'run-1')
    assert.deepEqual([rows[0].trigger, rows[0].startedAt, rows[0].endedAt], ['catch_up', 5000, 5000])
    assert.equal(await jobRuns.insertMissed('w1', [2000, 4000], 'run-1', 6000), 0)
  }))

test('lastOkAt: the latest ok row per job, ignoring every other status', () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000, { status: 'ok', endedAt: 1500 }))
    await jobRuns.insert(running('w1', 2000, { status: 'ok', endedAt: 2500 }))
    await jobRuns.insert(running('w1', 3000, { status: 'failed', endedAt: 3500 }))
    await jobRuns.insert(running('w2', 4000, { status: 'skipped', endedAt: 4000 }))
    const last = await jobRuns.lastOkAt()
    assert.equal(last.get('w1'), 2500)
    assert.equal(last.has('w2'), false)
  }))

test('a running row points at its session before it finishes', () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000))
    await jobRuns.attachSession('w1', 1000, 's1')
    assert.deepEqual((await jobRuns.list('w1')).map((r) => [r.status, r.sessionId]), [['running', 's1']])
  }))

test("spentSince sums one job's recorded cost from a point in time", () =>
  withStore(async ({ jobRuns }) => {
    await jobRuns.insert(running('w1', 1000, { status: 'ok', costUsd: 9, startedAt: 1000 }))
    await jobRuns.insert(running('w1', 2000, { status: 'ok', costUsd: 0.5, startedAt: 2000 }))
    await jobRuns.insert(running('w1', 3000, { status: 'failed', costUsd: 0.25, startedAt: 3000 }))
    await jobRuns.insert(running('w1', 4000, { status: 'skipped', startedAt: 4000 }))
    await jobRuns.insert(running('w2', 2500, { status: 'ok', costUsd: 100, startedAt: 2500 }))
    assert.equal(await jobRuns.spentSince('w1', 2000), 0.75)
    assert.equal(await jobRuns.spentSince('w1', 9000), 0)
  }))

test('a job keeps its daily budget through create, update and clear', () =>
  withStore(async ({ jobs }) => {
    const now = 1_000
    await jobs.create({
      id: 'w1', source: 'slack', title: 'W', scope: '', instruction: 'x', cadence: 'daily', schedule: '0 9 * * *',
      enabled: true, createsItems: true, tools: [], projectId: 'p', output: 'items', notify: 'on_failure',
      consecutiveFailures: 0, dailyBudgetUsd: 3, createdAt: now, updatedAt: now,
    })
    assert.equal((await jobs.get('w1'))?.dailyBudgetUsd, 3)
    await jobs.update('w1', { dailyBudgetUsd: 7.5 })
    assert.equal((await jobs.get('w1'))?.dailyBudgetUsd, 7.5)
    await jobs.update('w1', { dailyBudgetUsd: null })
    assert.equal((await jobs.get('w1'))?.dailyBudgetUsd, undefined)
  }))
