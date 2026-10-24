/**
 * Local full-text search (core/store/sqlite-search.ts): the query builder, the
 * triggers that keep items and sessions in step, the rebuild a DB from before
 * search gets on open, and artifacts indexed by the artifact indexer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../core/store/sqlite.js'
import { ftsQuery } from '../core/store/sqlite-search.js'
import { ArtifactIndex, searchTextOf } from '../server/artifacts.js'
import { SNIPPET_CLOSE, SNIPPET_OPEN, snippetParts } from '../shared/protocol.js'
import type { WorkItem } from '../core/work/types.js'

const hl = (s: string) => s.replaceAll(SNIPPET_OPEN, '[').replaceAll(SNIPPET_CLOSE, ']')

const gh = (n: number, title: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id: `github:acme/api#${n}`,
  source: 'github',
  kind: 'review-requested',
  title,
  url: `https://github.com/acme/api/pull/${n}`,
  repo: 'acme/api',
  author: 'priya',
  peopleWaiting: 0,
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  ...extra,
})

const tmpDir = () => mkdtempSync(path.join(tmpdir(), 'junior-search-'))

test('ftsQuery: every word quoted and a prefix; nothing searchable is null', () => {
  assert.equal(ftsQuery('flaky billing'), '"flaky"* "billing"*')
  assert.equal(ftsQuery('  "drop" table  OR  '), '"drop"* "table"* "OR"*')
  assert.equal(ftsQuery('acme/api #12'), '"acme/api"* "#12"*')
  assert.equal(ftsQuery(''), null)
  assert.equal(ftsQuery(' -- * " '), null)
})

test('snippetParts splits matched runs from plain text', () => {
  assert.deepEqual(snippetParts(`fix the ${SNIPPET_OPEN}flaky${SNIPPET_CLOSE} test`), [
    { text: 'fix the ', hit: false },
    { text: 'flaky', hit: true },
    { text: ' test', hit: false },
  ])
  assert.deepEqual(snippetParts('plain'), [{ text: 'plain', hit: false }])
})

test("search('flaky billing') finds an item by its description, with a snippet", async () => {
  const store = openSqliteStore(':memory:')
  try {
    await store.items.upsert(gh(1, 'Retry the export job'))
    const id = await store.items.createManual({ id: 'manual:1', title: 'Look at CI', description: 'The billing suite is flaky on main since Tuesday' })
    await store.items.createManual({ id: 'manual:2', title: 'Billing copy', description: 'Rewrite the pricing page' })
    const hits = await store.search.search('flaky billing')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, 'item')
    assert.equal(hits[0].ref, id)
    assert.equal(hits[0].title, 'Look at CI')
    assert.match(hl(hits[0].snippet), /\[billing\] suite is \[flaky\]/)
    // a prefix works as you type
    assert.equal((await store.search.search('flak bill')).length, 1)
  } finally {
    await store.close()
  }
})

test('updating an item reindexes it; ingestion and manual edits both count', async () => {
  const store = openSqliteStore(':memory:')
  try {
    await store.items.upsert(gh(7, 'Bump lodash'))
    assert.equal((await store.search.search('lodash')).length, 1)
    // a newer source update renames the PR
    await store.items.upsert(gh(7, 'Bump underscore', { updatedAt: '2026-10-21T10:00:00Z' }))
    assert.equal((await store.search.search('lodash')).length, 0)
    assert.equal((await store.search.search('underscore'))[0].ref, 'github:acme/api#7')

    const id = await store.items.createManual({ id: 'manual:9', title: 'Plan', description: 'invoices' })
    await store.items.updateManual(id, { description: 'receipts' })
    assert.equal((await store.search.search('invoices')).length, 0)
    assert.equal((await store.search.search('receipts'))[0].ref, id)
    await store.items.setDescription(id, 'statements')
    assert.equal((await store.search.search('receipts')).length, 0)
    assert.equal((await store.search.search('statements'))[0].ref, id)

    // who and where are searchable too
    assert.equal((await store.search.search('priya')).length, 1)
  } finally {
    await store.close()
  }
})

test('deleting or re-keying an item row follows in the index (triggers)', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'junior.db')
  const store = openSqliteStore(file)
  try {
    await store.items.upsert(gh(3, 'Flaky checkout test'))
    await store.items.upsert(gh(4, 'Flaky login test'))
    const db = new DatabaseSync(file)
    db.prepare("UPDATE work_items SET id = 'github:acme/api#30' WHERE id = 'github:acme/api#3'").run()
    db.prepare("DELETE FROM work_items WHERE id = 'github:acme/api#4'").run()
    const refs = db.prepare("SELECT kind, ref FROM search_refs WHERE kind = 'item' ORDER BY ref").all()
    db.close()
    const hits = await store.search.search('flaky')
    assert.deepEqual(hits.map((h) => h.ref), ['github:acme/api#30'])
    assert.deepEqual(refs.map((r) => ({ ...r })), [{ kind: 'item', ref: 'github:acme/api#30' }])
    // a status change alone touches nothing searchable
    await store.items.transition('github:acme/api#30', { status: 'done', actor: 'user' })
    assert.equal((await store.search.search('checkout')).length, 1)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessions: title and handle are searchable, rename and remove follow', async () => {
  const store = openSqliteStore(':memory:')
  try {
    await store.sessions.create({ id: 's1', title: 'Fix the billing export', cwd: '/tmp', projectId: null })
    assert.deepEqual((await store.search.search('billing')).map((h) => [h.kind, h.ref]), [['session', 's1']])
    await store.sessions.rename('s1', 'Fix the invoice export')
    assert.equal((await store.search.search('billing')).length, 0)
    await store.sessions.setName('s1', 'exporter')
    assert.equal((await store.search.search('exporter'))[0].ref, 's1')
    await store.sessions.remove('s1')
    assert.equal((await store.search.search('invoice')).length, 0)
  } finally {
    await store.close()
  }
})

test('kinds filter, limit, and a title hit outranks a body hit', async () => {
  const store = openSqliteStore(':memory:')
  try {
    await store.items.createManual({ id: 'manual:a', title: 'Notes', description: 'something about deploys' })
    await store.items.createManual({ id: 'manual:b', title: 'Deploys are slow' })
    await store.sessions.create({ id: 's1', title: 'Speed up deploys', cwd: '/tmp', projectId: null })
    const all = await store.search.search('deploys')
    assert.equal(all.length, 3)
    assert.equal(all.at(-1)!.ref, 'manual:a')
    assert.deepEqual((await store.search.search('deploys', { kinds: ['session'] })).map((h) => h.ref), ['s1'])
    assert.equal((await store.search.search('deploys', { kinds: ['item'] })).length, 2)
    assert.equal((await store.search.search('deploys', { limit: 1 })).length, 1)
    assert.deepEqual(await store.search.search('   '), [])
    // FTS syntax in the input is just words
    assert.deepEqual(await store.search.search('deploys OR zebra'), [])
    assert.equal((await store.search.search('"deploys')).length, 3)
  } finally {
    await store.close()
  }
})

test('a DB from before search gets its index built from the rows on open', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'junior.db')
  try {
    const first = openSqliteStore(file)
    await first.items.createManual({ id: 'manual:old', title: 'Old todo', description: 'flaky billing again' })
    await first.sessions.create({ id: 's-old', title: 'Old billing chat', cwd: '/tmp', projectId: null })
    await first.close()

    // wind it back to before migration 40: no index, no triggers, version 39
    const db = new DatabaseSync(file)
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'search_*'").all() as { name: string }[]) {
      db.exec(`DROP TRIGGER ${name}`)
    }
    db.exec('DROP TABLE search; DROP TABLE search_refs; DELETE FROM schema_migrations WHERE version >= 40')
    db.close()

    const store = openSqliteStore(file)
    try {
      const hits = await store.search.search('billing')
      assert.deepEqual(hits.map((h) => h.ref).sort(), ['manual:old', 's-old'])
      // and the triggers are back
      await store.items.createManual({ id: 'manual:new', title: 'New billing todo' })
      assert.equal((await store.search.search('billing')).length, 3)
      // a rebuild is idempotent
      await store.search.rebuild()
      assert.equal((await store.search.search('billing')).length, 3)
    } finally {
      await store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchTextOf strips markup and keeps other text as written', () => {
  assert.equal(searchTextOf('html', '<html><style>p{}</style><body><p>Q3 &amp; billing</p><script>x()</script></body></html>'), 'Q3 & billing')
  assert.equal(searchTextOf('csv', 'a,b\n1,2'), 'a,b\n1,2')
})

test('artifacts: the indexer hands bodies in on write, remove drops them, a rebuild is backfilled', async () => {
  const dir = tmpDir()
  const store = openSqliteStore(':memory:')
  const idx = new ArtifactIndex(path.join(dir, 'artifacts'), store, () => {})
  try {
    const md = await idx.create({ title: 'Brief for #12', body: 'The billing retries are flaky under load.', author: 'model' })
    const page = await idx.create({ title: 'Q3 report', body: '<html><body><h1>Churn</h1><p>Enterprise renewals</p></body></html>', author: 'model', format: 'html' })
    let hits = await store.search.search('flaky billing', { kinds: ['artifact'] })
    assert.deepEqual(hits.map((h) => h.ref), [md.id])
    assert.match(hl(hits[0].snippet), /\[billing\] retries are \[flaky\]/)
    assert.equal((await store.search.search('renewals'))[0].ref, page.id)
    assert.equal((await store.search.search('html')).length, 0, 'tags are not words')

    await idx.update(md.id, { body: 'Now about invoices.' })
    assert.equal((await store.search.search('flaky')).length, 0)
    assert.equal((await store.search.search('invoices'))[0].ref, md.id)

    // a rebuild leaves bodies unread; the next refresh reads them again
    await store.search.rebuild()
    assert.deepEqual((await store.search.artifactsWithoutBody()).sort(), [md.id, page.id].sort())
    assert.equal((await store.search.search('invoices')).length, 0)
    assert.equal((await store.search.search('brief'))[0].ref, md.id, 'the title is indexed straight away')
    await idx.refresh(true)
    assert.deepEqual(await store.search.artifactsWithoutBody(), [])
    assert.equal((await store.search.search('invoices'))[0].ref, md.id)

    await idx.remove(page.id)
    assert.equal((await store.search.search('renewals')).length, 0)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
