/**
 * A session's provider is stored on its row (migration 27), against a real
 * sqlite store in a temp dir — never ~/.junior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../core/store/sqlite.js'

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-session-provider-'))
  return { file: path.join(dir, 'junior.db'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('sessions from before providers read back as claude', async () => {
  const { file, done } = tempDb()
  try {
    // Wind a fresh DB back to migration 26: a session row with no provider column.
    await openSqliteStore(file).close()
    const db = new DatabaseSync(file)
    db.exec(`ALTER TABLE sessions DROP COLUMN provider; DELETE FROM schema_migrations WHERE version >= 27`)
    db.prepare(`INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('old', 'old', '/tmp', 1, 1)`).run()
    db.close()

    const store = openSqliteStore(file)
    assert.equal((await store.sessions.get('old'))?.provider, 'claude')
    await store.close()
  } finally {
    done()
  }
})

test('a codex session keeps its provider across a reopen; omitted = claude', async () => {
  const { file, done } = tempDb()
  try {
    let store = openSqliteStore(file)
    assert.equal((await store.sessions.create({ id: 'c', title: 'c', cwd: '/tmp', projectId: null, provider: 'codex' })).provider, 'codex')
    assert.equal((await store.sessions.create({ id: 'd', title: 'd', cwd: '/tmp', projectId: null })).provider, 'claude')
    await store.close()
    store = openSqliteStore(file)
    assert.equal((await store.sessions.get('c'))?.provider, 'codex')
    assert.equal((await store.sessions.get('d'))?.provider, 'claude')
    await store.close()
  } finally {
    done()
  }
})

test('a provider this build does not know reads back as claude', async () => {
  const { file, done } = tempDb()
  try {
    let store = openSqliteStore(file)
    await store.sessions.create({ id: 'x', title: 'x', cwd: '/tmp', projectId: null })
    await store.close()
    const db = new DatabaseSync(file)
    db.prepare(`UPDATE sessions SET provider = 'cursor' WHERE id = 'x'`).run()
    db.close()
    store = openSqliteStore(file)
    assert.equal((await store.sessions.get('x'))?.provider, 'claude')
    await store.close()
  } finally {
    done()
  }
})
