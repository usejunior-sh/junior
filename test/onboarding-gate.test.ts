/**
 * The default-project gate defers to Junior's first message (core/junior/onboarding-gate.ts):
 * it asks for a folder only on a zero-project workspace whose message was skipped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultProjectGateOpen, onboardingSkipKey, projectGateDismissedKey } from '../core/junior/onboarding-gate.js'

test('gate opens only when projects are missing and the first message was skipped', () => {
  const rows: [boolean, boolean, boolean, boolean, boolean][] = [
    // missing, skipped, dismissed, suspended → open
    [true, true, false, false, true],
    [true, false, false, false, false], // the message is asking: no dialog on top
    [false, true, false, false, false], // has projects: never
    [true, true, true, false, false], // Not now: it doesn't ask again
    [true, true, false, true, false], // another modal has the screen
  ]
  for (const [missing, onboardingSkipped, dismissed, suspended, open] of rows) {
    assert.equal(defaultProjectGateOpen({ missing, onboardingSkipped, dismissed, suspended }), open, JSON.stringify({ missing, onboardingSkipped, dismissed, suspended }))
  }
})

test('skip key is per workspace and matches the key the first message has always used', () => {
  assert.equal(onboardingSkipKey('default'), 'junior.onboarding.skipped.default')
  assert.notEqual(onboardingSkipKey('a'), onboardingSkipKey('b'))
})

test('the gate dismiss key is per workspace and separate from the skip key', () => {
  assert.equal(projectGateDismissedKey('default'), 'junior.projectGate.dismissed.default')
  assert.notEqual(projectGateDismissedKey('a'), projectGateDismissedKey('b'))
  assert.notEqual(projectGateDismissedKey('a'), onboardingSkipKey('a'))
})
