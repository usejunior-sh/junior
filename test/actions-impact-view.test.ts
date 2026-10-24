/**
 * The impact line as the card draws it (core/actions/view.ts): which states
 * show it, and its parts, which the card wraps as units.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { impactParts, impactShown } from '../core/actions/view.js'
import { ACTION_STATUSES, type ActionStatus } from '../core/actions/types.js'

test('impactShown: only a send that reached someone, may have, or still could', () => {
  const want: Record<ActionStatus, boolean> = {
    needs_you: true,
    scheduled: true,
    sending: true,
    succeeded: true,
    attempted: true,
    unknown: true,
    failed: false,
    denied: false,
    rejected: false,
    expired: false,
    sent_back: false,
  }
  assert.equal(ACTION_STATUSES.length, Object.keys(want).length)
  for (const s of ACTION_STATUSES) assert.equal(impactShown(s), want[s], s)
})

test('impactParts: the line, split at its separators, nothing empty', () => {
  assert.deepEqual(impactParts({ tool: 'Bash', args: { command: 'gh pr comment 3235 -R acme/api --body "Fixed."' } }, 'Bash'), [
    'Comment on acme/api#3235',
    'as you',
    'can edit or delete, not unsend',
  ])
  // A reach that is itself two parts comes apart too.
  assert.deepEqual(impactParts({ tool: 'Bash', args: { command: 'git push origin feat/x\ngh pr create -t x' } }, 'Bash'), [
    'Open a PR',
    '+1 more send',
    'as you',
    'can close, not delete',
  ])
  // An unknown tool: what runs and as whom, no claim about undo.
  assert.deepEqual(impactParts({ tool: 'Write', args: {} }, 'Write'), ['Runs Write', 'as you'])
})

test('impactParts: an odd record falls back to the tool name, never throws', () => {
  // args missing entirely: the core may throw on it; the card still gets a line.
  const parts = impactParts({ tool: 'Bash', args: null as unknown as Record<string, unknown> }, 'Bash')
  assert.ok(parts.length >= 2)
  assert.ok(parts.includes('as you'))
})
