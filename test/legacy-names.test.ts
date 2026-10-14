/**
 * Jobs were called watches before v1.1. A DB and a workspace folder from then
 * are renamed in place on open (core/store/sqlite.ts, server/job-files.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../core/store/sqlite.js'
import { renameLegacyFolders } from '../server/job-files.js'
import { defaultPlaybook } from '../server/briefs.js'

/** A current DB, turned back into one from before the rename. */
function legacyDb(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'triage-legacy-')), 'triage.db')
  const fresh = openSqliteStore(file)
  void fresh.close()
  const db = new DatabaseSync(file)
  const now = Date.now()
  db.exec(`ALTER TABLE jobs RENAME TO watches;
    ALTER TABLE job_runs RENAME TO watch_runs;
    ALTER TABLE watch_runs RENAME COLUMN job_id TO watch_id;
    ALTER TABLE sessions RENAME COLUMN job_id TO watch_id;
    ALTER TABLE actions RENAME COLUMN job_id TO watch_id;`)
  db.prepare(`INSERT INTO sessions (id, title, cwd, kind, watch_id, created_at, updated_at) VALUES ('s1', 'run', '/tmp', 'watch-run', 'w1', ?, ?)`).run(now, now)
  db.prepare(`INSERT INTO watch_runs (id, watch_id, slot, trigger, status, started_at) VALUES ('r1', 'w1', 1, 'manual', 'ok', ?)`).run(now)
  db.prepare(`INSERT INTO config (key, value) VALUES ('watches.enabled', 'true')`).run()
  const payload = (id: string, kind: string, source: string) =>
    JSON.stringify({ id, kind, source, title: 'Apple Watch thread', url: 'https://x', updatedAt: new Date(now).toISOString(), watchId: 'w1', foundBy: [{ watchId: 'w1', at: now }] })
  const item = db.prepare(`INSERT INTO work_items (id, source, kind, status_at, source_updated_at, ingested_at, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  item.run('slack:C1/1', 'slack', 'watch-hit', now, now, now, payload('slack:C1/1', 'watch-hit', 'slack'), now, now)
  item.run('watch:w1', 'watch', 'digest', now, now, now, payload('watch:w1', 'digest', 'watch'), now, now)
  db.prepare(`INSERT INTO item_events (item_id, seq, at, actor, event) VALUES ('watch:w1', 1, ?, 'watch:r1', 'created')`).run(now)
  db.prepare(`INSERT INTO links (id, from_kind, from_id, to_kind, to_id, role, created_at) VALUES ('l1', 'artifact', 'a1', 'item', 'watch:w1', 'context', ?)`).run(now)
  db.prepare(`INSERT INTO inbox_snapshot (id, synced_at, payload) VALUES (1, ?, '{}')`).run(now)
  db.close()
  return file
}

test('a DB from before the rename opens with jobs tables, columns and values', async () => {
  const file = legacyDb()
  const store = openSqliteStore(file)
  await store.close()
  const db = new DatabaseSync(file)
  const row = (sql: string) => ({ ...(db.prepare(sql).get() as object) })
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name)
  assert.ok(tables.includes('jobs') && tables.includes('job_runs'))
  assert.ok(!tables.some((t) => t.startsWith('watch')))
  assert.deepEqual(row(`SELECT kind, job_id FROM sessions`), { kind: 'job-run', job_id: 'w1' })
  assert.deepEqual(row(`SELECT job_id FROM job_runs`), { job_id: 'w1' })
  assert.deepEqual(row(`SELECT key FROM config WHERE key GLOB 'jobs.*'`), { key: 'jobs.enabled' })
  const items = db.prepare(`SELECT id, source, kind, payload FROM work_items ORDER BY id`).all() as { id: string; source: string; kind: string; payload: string }[]
  assert.deepEqual(items.map((r) => [r.id, r.source, r.kind]), [['job:w1', 'job', 'digest'], ['slack:C1/1', 'slack', 'job-hit']])
  const p = JSON.parse(items[0].payload)
  assert.deepEqual([p.id, p.source, p.jobId, p.foundBy[0].jobId, p.watchId], ['job:w1', 'job', 'w1', 'w1', undefined])
  assert.equal(JSON.parse(items[1].payload).title, 'Apple Watch thread', 'free text is left alone')
  assert.deepEqual(row(`SELECT item_id, actor FROM item_events`), { item_id: 'job:w1', actor: 'job:r1' })
  assert.deepEqual(row(`SELECT to_id FROM links`), { to_id: 'job:w1' })
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM inbox_snapshot`).get() as { n: number }).n, 0)
  db.close()
})

test('a renamed DB opens again untouched — the saved inbox survives', async () => {
  const file = legacyDb()
  await openSqliteStore(file).close()
  const db = new DatabaseSync(file)
  db.prepare(`INSERT INTO inbox_snapshot (id, synced_at, payload) VALUES (1, 1, '{}')`).run()
  db.close()
  await openSqliteStore(file).close()
  const again = new DatabaseSync(file)
  assert.equal((again.prepare(`SELECT COUNT(*) AS n FROM inbox_snapshot`).get() as { n: number }).n, 1)
  again.close()
})

test('the workspace folder moves to its new names; an untouched playbook becomes the new default', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'triage-legacy-ws-'))
  mkdirSync(path.join(root, 'watches'))
  writeFileSync(path.join(root, 'watches', 'mine.md'), 'x')
  mkdirSync(path.join(root, 'playbooks'))
  const oldDefault = defaultPlaybook('job-hit').replace(/job(s)?/gi, (m, s) => (m[0] === 'J' ? 'Watch' : 'watch') + (s ? 'es' : ''))
  writeFileSync(path.join(root, 'playbooks', 'watch-hit.md'), oldDefault)
  mkdirSync(path.join(root, 'dispatch'))
  writeFileSync(path.join(root, 'dispatch', 'watch-hit.md'), 'my template')
  renameLegacyFolders(root)
  assert.equal(readFileSync(path.join(root, 'jobs', 'mine.md'), 'utf8'), 'x')
  assert.ok(!existsSync(path.join(root, 'watches')))
  assert.equal(readFileSync(path.join(root, 'playbooks', 'job-hit.md'), 'utf8'), defaultPlaybook('job-hit'))
  assert.equal(readFileSync(path.join(root, 'dispatch', 'job-hit.md'), 'utf8'), 'my template')
})

test('an existing jobs folder wins over a leftover old one', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'triage-legacy-ws-'))
  mkdirSync(path.join(root, 'watches'))
  mkdirSync(path.join(root, 'jobs'))
  writeFileSync(path.join(root, 'jobs', 'new.md'), 'new')
  renameLegacyFolders(root)
  assert.ok(existsSync(path.join(root, 'watches')))
  assert.equal(readFileSync(path.join(root, 'jobs', 'new.md'), 'utf8'), 'new')
})
