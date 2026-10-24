/**
 * The default-project gate defers to Junior's first message (core/junior/onboarding-gate.ts):
 * it asks for a folder only on a zero-project workspace whose message was skipped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultProjectGateOpen, onboardingSkipKey } from '../core/junior/onboarding-gate.js'

test('gate opens only when projects are missing and the first message was skipped', () => {
  const rows: [boolean, boolean, boolean, boolean, boolean][] = [
    // missing, skipped, later, suspended → open
    [true, true, false, false, true],
    [true, false, false, false, false], // the message is asking: no dialog on top
    [false, true, false, false, false], // has projects: never
    [true, true, true, false, false], // Later for this page load
    [true, true, false, true, false], // another modal has the screen
  ]
  for (const [missing, onboardingSkipped, later, suspended, open] of rows) {
    assert.equal(defaultProjectGateOpen({ missing, onboardingSkipped, later, suspended }), open, JSON.stringify({ missing, onboardingSkipped, later, suspended }))
  }
})

test('skip key is per workspace and matches the key the first message has always used', () => {
  assert.equal(onboardingSkipKey('default'), 'junior.onboarding.skipped.default')
  assert.notEqual(onboardingSkipKey('a'), onboardingSkipKey('b'))
})
