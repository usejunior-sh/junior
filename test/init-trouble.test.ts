/**
 * A DM hides its "session ready" line unless something broke
 * (web/src/transcript.ts `initTrouble`): a failed server counts, unless its
 * tools are loaded under the same name anyway; sign-ins and pending don't.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initTrouble } from '../web/src/transcript.js'

test('a failed server with no tools loaded is trouble', () => {
  assert.equal(initTrouble([{ name: 'slack', status: 'failed' }], []), true)
})

test('failed but serving under the same name, needs-auth and pending are not', () => {
  assert.equal(initTrouble([{ name: 'junior', status: 'failed' }], ['mcp__junior__list_work_items']), false)
  assert.equal(initTrouble([{ name: 'gmail', status: 'needs-auth' }, { name: 'x', status: 'pending' }], []), false)
  assert.equal(initTrouble([], []), false)
})
