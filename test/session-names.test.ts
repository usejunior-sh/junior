/**
 * Session names (core/sessions/names.ts): the handle `/rename` sets and other
 * chats address a session by; the frame a message from another chat gets
 * (core/sessions/frame.ts); and the store keeping names unique, without case.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanSessionName, MAX_NAME_LENGTH, renameCommand, sameName } from '../core/sessions/names.js'
import { frameSessionMessage } from '../core/sessions/frame.js'
import { openSqliteStore } from '../core/store/sqlite.js'

test('a name is trimmed, inner whitespace folded, and never empty or too long', () => {
  assert.deepEqual(cleanSessionName('  auth   fix \n'), { ok: true, name: 'auth fix' })
  assert.equal(cleanSessionName('   ').ok, false)
  assert.equal(cleanSessionName('x'.repeat(MAX_NAME_LENGTH)).ok, true)
  assert.equal(cleanSessionName('x'.repeat(MAX_NAME_LENGTH + 1)).ok, false)
})

test('names match without case', () => {
  assert.equal(sameName('Auth Fix', 'auth fix'), true)
  assert.equal(sameName('auth fix', 'auth-fix'), false)
  assert.equal(sameName(null, 'auth fix'), false)
})

test('/rename is the command only at the start, with or without a name', () => {
  assert.equal(renameCommand('/rename auth fix'), 'auth fix')
  assert.equal(renameCommand('  /rename   Docs pass  '), 'Docs pass')
  assert.equal(renameCommand('/rename'), '')
  assert.equal(renameCommand('/renamed x'), null)
  assert.equal(renameCommand('please /rename x'), null)
  assert.equal(renameCommand('/review'), null)
})

test('a message from another chat names it and says it is not the user', () => {
  const named = frameSessionMessage({ name: 'planner', title: 'Plan the week' }, 'Do X.')
  assert.match(named, /the chat "planner"/)
  assert.match(named, /not the user/)
  assert.ok(named.endsWith('\n\nDo X.'))
  assert.match(frameSessionMessage({ name: null, title: 'Plan the week' }, 'Do X.'), /titled "Plan the week"/)
})

test('the store keeps a name and who started the session, and refuses a taken name in any case', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-names-'))
  try {
    const store = openSqliteStore(path.join(dir, 'triage.db'))
    const parent = await store.sessions.create({ id: 'p', title: 'Parent', cwd: dir, projectId: null })
    const child = await store.sessions.create({ id: 'c', title: 'Child', cwd: dir, projectId: null, name: 'auth fix', startedBy: parent.id })
    assert.equal(child.name, 'auth fix')
    assert.equal((await store.sessions.get('c'))?.startedBy, 'p')
    assert.equal((await store.sessions.get('p'))?.name, null)
    await assert.rejects(store.sessions.setName('p', 'Auth Fix'))
    // Clearing frees it; unnamed sessions never collide.
    await store.sessions.setName('c', null)
    await store.sessions.setName('p', 'AUTH FIX')
    assert.equal((await store.sessions.get('p'))?.name, 'AUTH FIX')
    await store.sessions.create({ id: 'd', title: 'Other', cwd: dir, projectId: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
