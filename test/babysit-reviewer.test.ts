/**
 * Who Junior suggests as the reviewer, what the request runs, and the
 * babysit settings' defaults (core/babysit/reviewer.ts, settings.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { learnedFresh, pickReviewer, requestCommands, REVIEWER_TTL_MS } from '../core/babysit/reviewer.js'
import { babysitSettingsFrom, DEFAULT_BABYSIT, modelFor } from '../core/babysit/settings.js'

const pr = (mergedAt: string, ...logins: (string | [string, 'Bot'])[]) => ({
  mergedAt,
  reviews: { nodes: logins.map((l) => (Array.isArray(l) ? { author: { __typename: l[1], login: l[0] } } : { author: { __typename: 'User', login: l } })) },
})
const data = (...prs: unknown[]) => ({ data: { prs: { nodes: prs } } })

test('the reviewer of most of your merged PRs, once per PR, no bots, not you', () => {
  const d = data(
    pr('2026-10-20T00:00:00Z', 'anirudha', 'anirudha', 'drew'),
    pr('2026-10-18T00:00:00Z', 'anirudha', ['coderabbitai', 'Bot'], 'samar'),
    pr('2026-10-10T00:00:00Z', 'drew', 'cursor[bot]'),
    pr('2026-10-09T00:00:00Z', 'anirudha'),
  )
  assert.equal(pickReviewer(d, 'samar'), 'anirudha')
  // a tie goes to the more recent
  assert.equal(pickReviewer(data(pr('2026-10-01T00:00:00Z', 'drew'), pr('2026-10-05T00:00:00Z', 'mo')), 'samar'), 'mo')
  assert.equal(pickReviewer(data(), 'samar'), null)
  assert.equal(pickReviewer(null, 'samar'), null)
})

test('a learned pick is read again after a day; yours holds', () => {
  const now = 10 * REVIEWER_TTL_MS
  assert.equal(learnedFresh({ login: 'a', at: now - 1000, by: 'junior' }, now), 'a')
  assert.equal(learnedFresh({ login: 'a', at: now - REVIEWER_TTL_MS - 1, by: 'junior' }, now), null)
  assert.equal(learnedFresh({ login: 'a', at: 0, by: 'you' }, now), 'a')
  assert.equal(learnedFresh(undefined, now), null)
})

test('the request: mark ready first for a draft, then add the reviewer', () => {
  assert.deepEqual(requestCommands({ repo: 'acme/api', number: 12 }, 'anirudha', false), [['pr', 'edit', '12', '-R', 'acme/api', '--add-reviewer', 'anirudha']])
  assert.deepEqual(requestCommands({ repo: 'acme/api', number: 12 }, 'acme/platform', true).map((c) => c[1]), ['ready', 'edit'])
  assert.throws(() => requestCommands({ repo: 'acme/api', number: 12 }, 'a; rm -rf /', false))
})

test('settings: defaults, then whatever is valid of what was saved', () => {
  assert.deepEqual(babysitSettingsFrom(null), DEFAULT_BABYSIT)
  assert.deepEqual(DEFAULT_BABYSIT.models, { fix: 'opus', rebase: 'sonnet', review: 'sonnet' })
  assert.deepEqual(DEFAULT_BABYSIT.budget, { perTaskUsd: 3, perDayUsd: 20, perReviewUsd: 1 })
  // the old on/off switches are gone: a stored one is ignored
  const s = babysitSettingsFrom({ enabled: true, reviews: true, models: { fix: 'claude-opus-5-5', rebase: 'bad model!' }, budget: { perTaskUsd: 5, perDayUsd: -1 }, maxRunning: 9 })
  assert.deepEqual(s, { models: { fix: 'claude-opus-5-5', rebase: 'sonnet', review: 'sonnet' }, budget: { perTaskUsd: 5, perDayUsd: 20, perReviewUsd: 1 }, maxRunning: 2, graceMinutes: 10 })
  assert.equal(modelFor('rebase', s), 'sonnet')
  assert.equal(modelFor('fix-ci', s), 'claude-opus-5-5')
  assert.equal(modelFor('fix-thread', s), 'claude-opus-5-5')
})
