/**
 * The chat's right sidebar (web/src/chatSide.ts): one tab per chat, a header
 * icon that toggles its tab, the browser pane's close that only clears the
 * browser, the cap, and the first load from the browser pane's old store.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIDE_CAP, browserClosed, parseSide, toggled, withTab } from '../web/src/chatSide.js'

test('a header icon opens its tab, swaps from another, and closes its own', () => {
  let m = toggled({}, 's1', 'artifacts')
  assert.deepEqual(m, { s1: 'artifacts' })
  m = toggled(m, 's1', 'browser')
  assert.deepEqual(m, { s1: 'browser' })
  m = toggled(m, 's1', 'browser')
  assert.deepEqual(m, {})
})

test('closing the browser pane leaves another tab alone', () => {
  assert.deepEqual(browserClosed({ s1: 'agents' }, 's1'), { s1: 'agents' })
  assert.deepEqual(browserClosed({ s1: 'browser', s2: 'agents' }, 's1'), { s2: 'agents' })
})

test('at most SIDE_CAP chats, the oldest forgotten first', () => {
  let m = {}
  for (let i = 0; i <= SIDE_CAP; i++) m = withTab(m, `s${i}`, 'artifacts')
  assert.equal(Object.keys(m).length, SIDE_CAP)
  assert.ok(!('s0' in m))
  // touching an old one makes it newest
  m = withTab(m, 's1', 'agents')
  m = withTab(m, 'new', 'agents')
  assert.ok('s1' in m)
  assert.ok(!('s2' in m))
})

test('first load: the stored map wins, else the old browser list, bad entries dropped', () => {
  assert.deepEqual(parseSide('{"a":"agents","b":"nope"}', '["x"]'), { a: 'agents' })
  assert.deepEqual(parseSide(null, '["x","y",3]'), { x: 'browser', y: 'browser' })
  assert.deepEqual(parseSide(null, null), {})
  assert.deepEqual(parseSide('not json', null), {})
})
