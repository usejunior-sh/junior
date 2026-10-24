/**
 * The reason chip's corrections (core/work/corrections.ts): which of the three
 * apply to a row, which are pressed, and the shown sum that always adds up.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreItem } from '../core/work/score.js'
import type { ItemKind, WorkItem } from '../core/work/types.js'
import type { ScoreWeight } from '../core/work/weights.js'
import { correctionsFor, displayParts, isAdjusted, pressedLine, scopeOf, setAgo } from '../core/work/corrections.js'
import { isBotLogin } from '../core/work/status.js'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const DAY = 86_400_000

function item(extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'i1',
    source: 'github',
    kind: 'review-requested' as ItemKind,
    title: 'fix(auth): refresh token race',
    url: 'https://github.com/acme/web/pull/3318',
    repo: 'acme/web',
    author: 'priya',
    peopleWaiting: 1,
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    ...extra,
  }
}

const w = (key: string, delta: number, setAt = NOW): ScoreWeight => ({ key, delta, setAt: new Date(setAt).toISOString() })
const ids = (i: WorkItem, me: string | null = 'samar', ws: ScoreWeight[] = []) => correctionsFor(scoreItem(i, NOW, ws), me, ws).map((c) => c.id)

test('all three apply to a teammate’s review request, in button order, with their keys and sizes', () => {
  const cs = correctionsFor(scoreItem(item(), NOW), 'samar')
  assert.deepEqual(
    cs.map((c) => [c.id, c.key, c.delta, c.pressed]),
    [
      ['matters', 'person:priya', 20, false],
      ['not-important', 'kind:review-requested', -20, false],
      ['not-mine', 'repo:acme/web', -40, false],
    ],
  )
  assert.equal(cs[0]!.effect, '+20 on every item from @priya')
  assert.equal(cs[1]!.effect, '−20 on every review requested item')
  assert.equal(cs[2]!.effect, '−40 on everything in acme/web')
  assert.equal(cs[2]!.reason, "acme/web isn't mine")
  assert.equal(cs[0]!.reason, undefined)
})

test('which corrections a row gets', () => {
  const table: [string, WorkItem, string | null, string[]][] = [
    ['author is me', item({ author: 'samar' }), 'samar', ['not-important', 'not-mine']],
    ['author is me, with @ and case', item({ author: '@Samar' }), 'samar', ['not-important', 'not-mine']],
    ['me unknown keeps the person', item(), null, ['matters', 'not-important', 'not-mine']],
    ['no author', item({ author: '' }), 'samar', ['not-important', 'not-mine']],
    ['a bot author', item({ author: 'dependabot[bot]' }), 'samar', ['not-important', 'not-mine']],
    ['a -bot author', item({ author: 'ci-bot' }), 'samar', ['not-important', 'not-mine']],
    ['Junior’s find', item({ source: 'job', kind: 'job-hit', author: '' }), 'samar', ['not-mine']],
    ['manual', item({ source: 'manual', kind: 'manual', author: '', repo: '' }), 'samar', []],
    ['job-hit with an author', item({ kind: 'job-hit' }), 'samar', ['matters', 'not-mine']],
    ['no repo', item({ repo: '' }), 'samar', ['matters', 'not-important']],
    ['a Slack channel', item({ source: 'slack', kind: 'slack-mention', repo: '#eng-platform', author: 'niraj' }), 'samar', ['matters', 'not-important', 'not-mine']],
  ]
  for (const [name, i, me, want] of table) assert.deepEqual(ids(i, me), want, name)
})

test('a weight with the same key and sign is pressed; the opposite sign is not', () => {
  const set = NOW - 3 * DAY
  const same = [w('person:priya', 20, set)]
  const cs = correctionsFor(scoreItem(item(), NOW, same), 'samar', same)
  assert.equal(cs[0]!.pressed, true)
  assert.equal(cs[0]!.setAt, new Date(set).toISOString())
  assert.equal(cs[1]!.pressed, false)

  const opposite = [w('person:priya', -20), w('repo:acme/web', 10)]
  const cs2 = correctionsFor(scoreItem(item(), NOW, opposite), 'samar', opposite)
  assert.equal(cs2[0]!.pressed, false)
  assert.equal(cs2[2]!.pressed, false)
  assert.equal(cs2[0]!.setAt, undefined)

  // pressed comes from the row's parts: without the weights list there's no age
  const bare = correctionsFor(scoreItem(item(), NOW, same), 'samar')
  assert.equal(bare[0]!.pressed, true)
  assert.equal(bare[0]!.setAt, undefined)
})

test('an expired weight is not on the row, so nothing is pressed', () => {
  const old = [w('kind:review-requested', -20, NOW - 61 * DAY)]
  const cs = correctionsFor(scoreItem(item(), NOW, old), 'samar', old)
  assert.equal(cs[1]!.pressed, false)
})

test('the shown sum rounds each part and its total adds up', () => {
  const { parts, total } = displayParts([
    { points: 100, label: 'review requested' },
    { points: 15, label: '1 person waiting' },
    { points: 7.6, label: 'waited 2d' },
    { points: 2.4, label: 'x' },
    { points: -0.4, label: 'tiny' },
  ])
  assert.deepEqual(
    parts.map((p) => p.shown),
    [100, 15, 8, 2, 0],
  )
  assert.equal(total, 125)
  assert.equal(
    total,
    parts.reduce((s, p) => s + p.shown, 0),
  )
  const real = scoreItem(item({ ciFailing: true }), NOW, [w('person:priya', 20)])
  const shown = displayParts(real.rankParts!)
  assert.ok(Math.abs(shown.total - real.score) < real.rankParts!.length)
})

test('a row with a weight on it is adjusted', () => {
  assert.equal(isAdjusted(scoreItem(item(), NOW)), false)
  assert.equal(isAdjusted(scoreItem(item(), NOW, [w('repo:acme/web', -40)])), true)
  assert.equal(isAdjusted({ rankParts: undefined }), false)
})

test('ages, pressed line and scope words', () => {
  assert.equal(setAgo(new Date(NOW - 3600_000).toISOString(), NOW), 'today')
  assert.equal(setAgo(new Date(NOW - 3 * DAY).toISOString(), NOW), '3d ago')
  assert.equal(setAgo(new Date(NOW - 15 * DAY).toISOString(), NOW), '2w ago')
  assert.equal(pressedLine(new Date(NOW - 3 * DAY).toISOString(), NOW), 'Set 3d ago. Press again to clear.')
  assert.equal(pressedLine(new Date(NOW).toISOString(), NOW), 'Set today. Press again to clear.')
  assert.equal(pressedLine(undefined, NOW), 'Press again to clear.')
  assert.equal(scopeOf('person:priya'), 'person')
  assert.equal(scopeOf('repo:acme/web'), 'repo')
  assert.equal(scopeOf('kind:mention'), 'kind')
})

test('bot logins', () => {
  for (const b of ['dependabot[bot]', 'renovate-bot', 'ci_bot', '@github-actions[bot]']) assert.equal(isBotLogin(b), true, b)
  for (const p of ['priya', 'abbott', 'robot']) assert.equal(isBotLogin(p), false, p)
})
