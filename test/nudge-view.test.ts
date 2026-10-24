/**
 * "Draft nudge?" words and keys (core/work/nudge-view.ts, plan item `nudge-ui`):
 * the state cell, what Junior says, the impact line per way, the result
 * lines, and that only ⌘↩ / Ctrl↩ sends.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isNudgeSendKey,
  NUDGE_ASK,
  nudgeDone,
  nudgeDraftFailed,
  nudgeFine,
  nudgeImpact,
  nudgeRows,
  nudgeSays,
  nudgeSendFailed,
  nudgeWaited,
  nudgeWay,
} from '../core/work/nudge-view.js'

test('the way: a mark that can send, or a draft routed to a Slack thread, sends; everything else copies', () => {
  assert.equal(nudgeWay({ send: true, via: 'slack-thread', lands: 'in the Slack thread' }), 'send')
  assert.equal(nudgeWay({ send: false }), 'copy')
  assert.equal(nudgeWay('slack-thread'), 'send')
  assert.equal(nudgeWay(null), 'copy')
  assert.equal(nudgeWay(undefined), 'copy')
  assert.equal(nudgeWay('email'), 'copy')
})

test('the state cell reads "Waiting 3d · Draft nudge?"', () => {
  assert.equal(`${nudgeWaited('3d')} · ${NUDGE_ASK}`, 'Waiting 3d · Draft nudge?')
  assert.equal(nudgeWaited(''), 'Waiting')
})

test('Junior says how long, and who else waits on the same person', () => {
  assert.equal(nudgeSays({ person: 'ana', workingDays: 3, alsoWaiting: [] }), 'ana has had this 3 working days.')
  assert.equal(nudgeSays({ person: 'ana', workingDays: 1, alsoWaiting: [] }), 'ana has had this 1 working day.')
  assert.equal(
    nudgeSays({ person: 'ana', workingDays: 3, alsoWaiting: ['github:acme/api#3240', 'linear:NOV-12'] }),
    'ana has had this 3 working days. Also waiting on ana: #3240, NOV-12.',
  )
})

test('the impact line: a Slack thread reply as you, or you send it yourself', () => {
  assert.deepEqual(nudgeImpact('send'), ['Reply in a thread in Slack', 'as you', 'can edit or delete, not unsend'])
  assert.deepEqual(nudgeImpact('copy'), ['You send it yourself', 'Junior sends nothing'])
  assert.equal(nudgeFine('send'), 'sent word for word, as you')
  assert.equal(nudgeFine('copy'), 'copy it and send it yourself')
})

test('the result and error lines', () => {
  assert.equal(nudgeDone('sent', 'ana'), 'Sent to ana. No nudge for ana for a day.')
  assert.equal(nudgeDone('by-hand', 'ana'), 'Marked sent. No nudge for ana for a day.')
  assert.equal(nudgeDone('rule', 'ana'), 'Sent under a rule you wrote. See it in the Log.')
  assert.equal(nudgeDraftFailed('no open item x'), "Couldn't draft the nudge: no open item x")
  assert.equal(nudgeSendFailed('Slack is down'), "Didn't send: Slack is down. Your text is still here.")
})

test('the box grows from 2 to 6 rows', () => {
  assert.equal(nudgeRows('one line'), 2)
  assert.equal(nudgeRows('a\nb\nc'), 3)
  assert.equal(nudgeRows('1\n2\n3\n4\n5\n6\n7\n8'), 6)
})

test('only ⌘↩ or Ctrl↩ sends; a plain ↩ is a newline', () => {
  const k = (over: Partial<Parameters<typeof isNudgeSendKey>[0]>) => isNudgeSendKey({ key: 'Enter', metaKey: false, ctrlKey: false, ...over })
  assert.equal(k({}), false)
  assert.equal(k({ metaKey: true }), true)
  assert.equal(k({ ctrlKey: true }), true)
  assert.equal(k({ metaKey: true, shiftKey: true }), false)
  assert.equal(k({ metaKey: true, altKey: true }), false)
  assert.equal(k({ metaKey: true, isComposing: true }), false)
  assert.equal(k({ key: 'a', metaKey: true }), false)
})
