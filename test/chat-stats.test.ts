/**
 * A DM's sign-off (web/src/transcript.ts `chatStats`): time, turns and the
 * cost to the cent. A cost under a cent still says something was spent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatStats } from '../web/src/transcript.js'

test('keeps time and turns, rounds the cost to cents', () => {
  assert.equal(chatStats('2.9s · 1 turn · $0.0197'), '2.9s · 1 turn · $0.02')
  assert.equal(chatStats('32.2s · 9 turns · $0.8007'), '32.2s · 9 turns · $0.80')
})

test('a tiny cost shows as a cent; no cost, just the time', () => {
  assert.equal(chatStats('1.0s · 1 turn · $0.0004'), '1.0s · 1 turn · $0.01')
  assert.equal(chatStats('4.1s · 3 turns'), '4.1s · 3 turns')
})
