/**
 * The workspace switches (server/settings-ops.ts): a new workspace starts with
 * jobs and every watch off; one from before keeps jobs as they were and its
 * watches on; a switch you set is never rewritten; each watch saves on its own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import { jobsEnabled, readSettings, settleSwitches, touchesWatches, watchesOn, writeSettings } from '../server/settings-ops.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

async function withRt(fn: (rt: WorkspaceRuntime, store: Store) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-switches-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = { store, meta: { id: 'test' }, clients: new Set() } as unknown as WorkspaceRuntime
  try {
    await fn(rt, store)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const item = { id: 'manual:1', source: 'manual', kind: 'todo', title: 'x', url: '', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }

test('a new workspace: jobs and every watch start off', async () => {
  await withRt(async (rt) => {
    await settleSwitches(rt)
    assert.equal(await jobsEnabled(rt), false)
    assert.deepEqual(await watchesOn(rt), { babysit: false, review: false })
  })
})

test('a workspace from before: jobs stay as they were, watches stay on', async () => {
  await withRt(async (rt, store) => {
    await store.items.upsert(item as never)
    await store.config.set('jobs.enabled', true)
    await settleSwitches(rt)
    assert.equal(await jobsEnabled(rt), true)
    assert.deepEqual(await watchesOn(rt), { babysit: true, review: true })
  })
})

test('a switch you set is never rewritten at boot', async () => {
  await withRt(async (rt, store) => {
    await settleSwitches(rt)
    await writeSettings(rt, { babysitEnabled: true })
    await store.items.upsert(item as never)
    await settleSwitches(rt)
    assert.deepEqual(await watchesOn(rt), { babysit: true, review: false })
  })
})

test('each watch saves on its own, and only as a boolean', async () => {
  await withRt(async (rt) => {
    await settleSwitches(rt)
    const s = await writeSettings(rt, { reviewsEnabled: true })
    assert.equal(s.reviewsEnabled, true)
    assert.equal(s.babysitEnabled, false)
    await assert.rejects(writeSettings(rt, { babysitEnabled: 'yes' }), /babysitEnabled must be a boolean/)
    assert.equal((await readSettings(rt)).babysitEnabled, false)
  })
})

test('a patch that flips a watch switch resyncs the inbox; others do not', () => {
  assert.equal(touchesWatches({ babysitEnabled: true }), true)
  assert.equal(touchesWatches({ reviewsEnabled: false }), true)
  assert.equal(touchesWatches({ jobsEnabled: true }), false)
  assert.equal(touchesWatches({ babysitEnabled: 'yes' }), false)
  assert.equal(touchesWatches(null), false)
})
