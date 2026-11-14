/**
 * The needs-you count (core/work/needs-you.ts): the rail's orange number and
 * a workspace tab's count come from one sum.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsYouCount } from '../core/work/needs-you.js'

test('waiting sessions plus pending actions', () => {
  assert.equal(needsYouCount([{ waiting: true }, {}, { waiting: false }, { waiting: true }], 3), 5)
})

test('nothing waiting is zero', () => {
  assert.equal(needsYouCount([], 0), 0)
  assert.equal(needsYouCount([{}, { waiting: false }], 0), 0)
})

test('a DM counts like any chat, matching the old rail sum', () => {
  const sessions = [
    { kind: 'dm', waiting: true },
    { kind: 'chat', waiting: true },
    { kind: 'dm' },
  ]
  const old = sessions.filter((s) => s.kind === 'dm' && s.waiting).length + 2 + sessions.filter((s) => s.kind !== 'dm' && s.waiting).length
  assert.equal(needsYouCount(sessions, 2), old)
})
