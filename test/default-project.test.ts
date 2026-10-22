/**
 * Workspace → default project (decision 549a251e) against a real sqlite store
 * in a temp dir — never ~/.junior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { WorkItem } from '../core/work/types.js'

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-projects-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    await fn(store)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const project = (id: string, folder = `/tmp/${id}`) => ({ id, name: id, repo: '', path: folder })

test('exactly one project is the default, and it lists first', () =>
  withStore(async ({ projects }) => {
    await projects.create(project('b'))
    await projects.create(project('a'))
    assert.equal((await projects.list()).filter((p) => p.isDefault).length, 0)
    await projects.setDefault('b')
    await projects.setDefault('a')
    const list = await projects.list()
    assert.deepEqual(list.map((p) => [p.id, p.isDefault ?? false]), [['a', true], ['b', false]])
  }))

test('the default project cannot be deleted, only replaced', () =>
  withStore(async ({ projects }) => {
    await projects.create(project('a'))
    await projects.create(project('b'))
    await projects.setDefault('a')
    await assert.rejects(projects.remove('a'), /default project/)
    await projects.setDefault('b')
    await projects.remove('a')
    assert.deepEqual((await projects.list()).map((p) => p.id), ['b'])
  }))

test('setDefault on an unknown id leaves the old default in place', () =>
  withStore(async ({ projects }) => {
    await projects.create(project('a'))
    await projects.setDefault('a')
    await assert.rejects(projects.setDefault('nope'), /unknown project/)
    assert.equal((await projects.list()).find((p) => p.isDefault)?.id, 'a')
  }))

test('sessions store their project; backfill fills only the ones without', () =>
  withStore(async ({ sessions }) => {
    await sessions.create({ id: 's1', title: 'one', cwd: '/tmp/a', projectId: 'a' })
    await sessions.create({ id: 's2', title: 'two', cwd: '/tmp/b', projectId: null })
    const n = await sessions.backfillProjects((cwd) => (cwd === '/tmp/b' ? 'b' : null))
    assert.equal(n, 1)
    const byId = new Map((await sessions.list()).map((s) => [s.id, s.projectId]))
    assert.equal(byId.get('s1'), 'a')
    assert.equal(byId.get('s2'), 'b')
  }))

test('item backfill skips items that already name a project, and a rescan keeps it', () =>
  withStore(async ({ items }) => {
    const pr: WorkItem = {
      id: 'github:o/r#1', source: 'github', kind: 'review-requested', title: 'PR', url: 'https://x', repo: 'o/r',
      author: 'me', peopleWaiting: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    }
    await items.upsert(pr)
    await items.createManual({ id: 'manual:1', title: 'todo', projectId: 'a' })
    assert.equal(await items.backfillProjects(() => 'd'), 1)
    assert.equal((await items.get('manual:1'))?.projectId, 'a')
    assert.equal((await items.get(pr.id))?.projectId, 'd')
    await items.upsert({ ...pr, title: 'PR v2', updatedAt: '2026-10-02T00:00:00Z' })
    assert.equal((await items.get(pr.id))?.projectId, 'd')
  }))
