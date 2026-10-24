// "Not this one", with a reason: two matching reasons for one repo and kind stop
// Junior suggesting that kind there (core/junior/suggest.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterReason,
  clearSuppression,
  EMPTY_SUPPRESS,
  isNotNowReason,
  readSuppressState,
  suggestionFor,
  suppressedKeys,
  suppressKey,
  suppressRepo,
  type MarkedItem,
  type NotNowReason,
  type SuggestInput,
} from '../core/junior/suggest.js'

const marked = (id: string, reason: NotNowReason | null, at: string, over: Partial<MarkedItem> = {}): MarkedItem => ({
  id,
  source: 'github',
  repo: 'Acme/Web',
  kind: 'review-requested',
  ...(reason ? { notNowReason: { reason, at } } : {}),
  ...over,
})

test('reasons: only the three are taken', () => {
  assert.ok(isNotNowReason('not-mine') && isNotNowReason('too-small') && isNotNowReason('handled'))
  assert.equal(isNotNowReason('nope'), false)
  assert.equal(isNotNowReason(undefined), false)
})

test('the repo a suppression keys on: owner/name, lower case; none for Slack or a team', () => {
  assert.equal(suppressRepo({ source: 'github', repo: 'Acme/Web' }), 'acme/web')
  assert.equal(suppressRepo({ source: 'slack', repo: 'acme/web' }), null)
  assert.equal(suppressRepo({ source: 'linear', repo: 'NOV' }), null)
  assert.equal(suppressRepo({ source: 'github', repo: '' }), null)
  assert.equal(suppressRepo({ source: 'github' }), null)
})

test('one reason does nothing; a second from another item suppresses the kind in that repo', () => {
  const one = [marked('a', 'too-small', '2026-10-24T09:00:00.000Z')]
  assert.equal(afterReason(EMPTY_SUPPRESS, one, 'a').made, null)
  const two = [...one, marked('b', 'too-small', '2026-10-24T10:00:00.000Z')]
  const out = afterReason(EMPTY_SUPPRESS, two, 'b')
  assert.deepEqual(out.made, { key: 'acme/web·review-requested', repo: 'acme/web', kind: 'review-requested', reason: 'too-small', since: '2026-10-24T10:00:00.000Z', items: ['a', 'b'] })
  assert.deepEqual([...suppressedKeys(out.state)], ['acme/web·review-requested'])
  // deterministic: the same input, the same answer
  assert.deepEqual(afterReason(EMPTY_SUPPRESS, two, 'b'), out)
})

test('what never counts: already handled, mixed reasons, another repo or kind, no repo, the same item', () => {
  const at = '2026-10-24T09:00:00.000Z'
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', 'handled', at), marked('b', 'handled', at)], 'b').made, null)
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', 'not-mine', at), marked('b', 'too-small', at)], 'b').made, null)
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', 'not-mine', at, { repo: 'acme/api' }), marked('b', 'not-mine', at)], 'b').made, null)
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', 'not-mine', at, { kind: 'your-pr-red' }), marked('b', 'not-mine', at)], 'b').made, null)
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', 'not-mine', at, { source: 'slack' }), marked('b', 'not-mine', at, { source: 'slack' })], 'b').made, null)
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', 'not-mine', at)], 'a').made, null)
  // an item with no reason, or not in the list
  assert.equal(afterReason(EMPTY_SUPPRESS, [marked('a', null, at)], 'a').made, null)
  assert.equal(afterReason(EMPTY_SUPPRESS, [], 'zz').made, null)
})

test('already suppressed: no second one; cleared: only reasons said after the clear count', () => {
  const two = [marked('a', 'not-mine', '2026-10-22T09:00:00.000Z'), marked('b', 'not-mine', '2026-10-22T10:00:00.000Z')]
  const on = afterReason(EMPTY_SUPPRESS, two, 'b').state
  assert.equal(afterReason(on, two, 'b').made, null)
  const key = suppressKey('acme/web', 'review-requested')
  const off = clearSuppression(on, key, '2026-10-23T00:00:00.000Z')
  assert.equal(off.removed?.key, key)
  assert.equal(off.state.suppressions.length, 0)
  assert.equal(clearSuppression(off.state, key, '2026-10-23T00:00:00.000Z').removed, null)
  // the old two don't come straight back
  const three = [...two, marked('c', 'not-mine', '2026-10-24T09:00:00.000Z')]
  assert.equal(afterReason(off.state, three, 'c').made, null)
  const four = [...three, marked('d', 'not-mine', '2026-10-24T10:00:00.000Z')]
  assert.deepEqual(afterReason(off.state, four, 'd').made?.items, ['c', 'd'])
})

test('the stored value is read leniently', () => {
  assert.deepEqual(readSuppressState(null), EMPTY_SUPPRESS)
  assert.deepEqual(readSuppressState({ suppressions: [{ repo: 'acme/web' }, 'x'], cleared: { k: 'not a date' } }), EMPTY_SUPPRESS)
  const s = readSuppressState({
    suppressions: [
      { repo: 'acme/web', kind: 'mention', reason: 'too-small', since: '2026-10-24T09:00:00.000Z', items: ['a', 3] },
      { repo: 'acme/web', kind: 'mention', reason: 'not-mine', since: '2026-10-24T09:00:00.000Z' },
      { repo: 'acme/web', kind: 'x', reason: 'handled', since: '2026-10-24T09:00:00.000Z' },
    ],
    cleared: { 'acme/web·x': '2026-10-24T09:00:00.000Z' },
  })
  assert.deepEqual(s.suppressions, [{ key: 'acme/web·mention', repo: 'acme/web', kind: 'mention', reason: 'too-small', since: '2026-10-24T09:00:00.000Z', items: ['a'] }])
  assert.deepEqual(s.cleared, { 'acme/web·x': '2026-10-24T09:00:00.000Z' })
})

test('a suppressed kind is never suggested in that repo; elsewhere it still is', () => {
  const input = (repo: string, source = 'github'): SuggestInput => ({
    item: { reason: 'review-requested', kind: 'review-requested', updatedAt: '2026-10-24T09:00:00Z', peopleWaiting: 1, source, repo },
    juniorBusy: false,
    reviewed: false,
    juniorPr: false,
    rule: null,
    suppressed: new Set([suppressKey('acme/web', 'review-requested')]),
  })
  assert.equal(suggestionFor(input('acme/web')), null)
  assert.equal(suggestionFor(input('Acme/Web')), null)
  assert.ok(suggestionFor(input('acme/api')))
  assert.ok(suggestionFor({ ...input('acme/web'), suppressed: new Set() }))
  assert.ok(suggestionFor({ ...input('acme/web'), suppressed: undefined }))
})
