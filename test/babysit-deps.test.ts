/**
 * Dependency PRs that can go together (core/babysit/deps.ts): who counts as
 * a dependency PR, the bump read off titles, bodies and labels, and the
 * batchable table. Major and red are never batchable; unknown never counts
 * as patch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchable, bump, bumpBetween, bumpOf, dependencyBatch, isDependencyPr, MIN_AGE_DAYS, parseVersion, type Bump, type DepPr } from '../core/babysit/deps.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-24T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const green = [{ name: 'lint', status: 'success' as const }, { name: 'test', status: 'success' as const }]
const dep = (over: Partial<DepPr> = {}): DepPr => ({
  author: 'dependabot[bot]',
  title: 'Bump lodash from 4.17.20 to 4.17.21',
  labels: ['dependencies'],
  createdAt: ago(5),
  checks: green,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  ...over,
})

test('isDependencyPr: the two bots under every login shape, or a dependency label', () => {
  for (const author of ['renovate[bot]', 'dependabot[bot]', 'app/dependabot', 'app/renovate', 'Renovate-Bot', '@dependabot', 'mend-renovate[bot]', 'dependabot-preview[bot]'])
    assert.equal(isDependencyPr({ author, labels: [] }), true, author)
  for (const author of ['samar', 'cursor[bot]', 'github-actions[bot]', 'renovator', null])
    assert.equal(isDependencyPr({ author, labels: [] }), false, String(author))
  assert.equal(isDependencyPr({ author: 'samar', labels: ['Dependencies'] }), true)
  assert.equal(isDependencyPr({ author: 'samar', labels: ['renovate'] }), true)
  assert.equal(isDependencyPr({ author: 'samar', labels: ['bug', 'deps-review'] }), false)
})

test('parseVersion: versions, prefixes and pre-releases; digests and ranges are not versions', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion('^4.17'), { major: 4, minor: 17, patch: 0 })
  assert.deepEqual(parseVersion('~> 2.0'), { major: 2, minor: 0, patch: 0 })
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3 })
  assert.equal(parseVersion('abc1234'), null)
  assert.equal(parseVersion('1234abc'), null)
  assert.equal(parseVersion('>=1 <2'), null)
  assert.equal(parseVersion('latest'), null)
})

test('bumpBetween: semver, with 0.x minor moves counted as breaking', () => {
  const rows: [string, string, Bump][] = [
    ['1.2.3', '1.2.4', 'patch'],
    ['1.2.3', '1.3.0', 'minor'],
    ['1.2.3', '2.0.0', 'major'],
    ['v4.17.20', 'v4.17.21', 'patch'],
    ['0.4.1', '0.4.2', 'patch'],
    ['0.4.1', '0.5.0', 'major'],
    ['0.0.3', '0.0.4', 'major'],
    ['2.0.0', '1.9.0', 'unknown'], // a downgrade
    ['1.2.3', '1.2.3', 'unknown'],
    ['1.2.3-beta.1', '1.2.3', 'unknown'],
    ['abc1234', 'def5678', 'unknown'],
  ]
  for (const [from, to, want] of rows) assert.equal(bumpBetween(from, to), want, `${from} → ${to}`)
})

test('bump(title): Dependabot and Renovate titles', () => {
  const rows: [string, Bump][] = [
    ['Bump lodash from 4.17.20 to 4.17.21', 'patch'],
    ['build(deps): bump express from 4.18.2 to 4.19.0', 'minor'],
    ['chore(deps-dev): bump @types/node from 20.11.0 to 22.0.0 in /web', 'major'],
    ['Bump actions/checkout from v3 to v4', 'major'],
    ['Bump golang.org/x/net from 0.17.0 to 0.23.0', 'major'],
    ['Bump the npm group across 1 directory with 5 updates', 'unknown'],
    ['Update dependency react to v19', 'major'],
    ['chore(deps): update dependency eslint to v9 [security]', 'major'],
    ['Update react monorepo to v19.0.0 (major)', 'major'],
    ['chore(deps): update dependency eslint to v8.57.1', 'unknown'], // no old version in the title
    ['chore(deps): update all non-major dependencies', 'unknown'],
    ['Update actions/checkout digest to b4ffde6', 'unknown'],
    ['chore(deps): lock file maintenance', 'unknown'],
    ['Pin dependencies', 'unknown'],
    ['', 'unknown'],
  ]
  for (const [title, want] of rows) assert.equal(bump(title), want, title)
})

test('bumpOf: the body settles Renovate titles; the biggest move wins; release notes are ignored', () => {
  const renovateBody = '| Package | Change |\n|---|---|\n| [eslint](https://eslint.org) | [`8.57.0` -> `8.57.1`](https://renovatebot.com/diffs/npm/eslint/8.57.0/8.57.1) |'
  assert.equal(bumpOf({ title: 'chore(deps): update dependency eslint to v8.57.1', body: renovateBody }), 'patch')
  const group = '| a | `1.0.0` -> `1.0.1` |\n| b | `2.1.0` -> `2.2.0` |'
  assert.equal(bumpOf({ title: 'chore(deps): update all non-major dependencies', body: group }), 'minor')
  const withMajor = group + '\n| c | `3.0.0` -> `4.0.0` |'
  assert.equal(bumpOf({ title: 'chore(deps): update all dependencies', body: withMajor }), 'major')
  const dependabotGroup = 'Bumps the npm group with 2 updates.\n\nUpdates `lodash` from 4.17.20 to 4.17.21\nUpdates `express` from 4.18.2 to 4.19.0'
  assert.equal(bumpOf({ title: 'Bump the npm group with 2 updates', body: dependabotGroup }), 'minor')
  // one row that can't be read makes the lot unknown
  assert.equal(bumpOf({ title: 'Update all dependencies', body: group + '\n| d | `abc1234` -> `def5678` |' }), 'unknown')
  // a release note's "from 5 to 10" is not the bump
  const notes = 'Bumps lodash.\n<details>\n<summary>Release notes</summary>\nRaised the timeout from 5 to 10 seconds.\n</details>\n> from 1.0.0 to 9.0.0'
  assert.equal(bumpOf({ title: 'Bump lodash from 4.17.20 to 4.17.21', body: notes }), 'patch')
  assert.equal(bumpOf({ title: 'Update all dependencies', body: notes }), 'unknown')
  // the title wins over the body
  assert.equal(bumpOf({ title: 'Update dependency react to v19', body: group }), 'major')
  // an update type label is the last resort
  assert.equal(bumpOf({ title: 'Update dependency x to v1.2.4', labels: ['dependencies', 'patch'] }), 'patch')
  assert.equal(bumpOf({ title: 'Update dependency x to v1.3.0', labels: ['type: minor'] }), 'minor')
  assert.equal(bumpOf({ title: 'Update dependency x to v1.3.0', labels: ['minor', 'major'] }), 'major')
  assert.equal(bumpOf({ title: 'Update dependency x to v1.3.0', labels: ['dependencies'] }), 'unknown')
})

type Row = { name: string; pr: DepPr; ok: boolean; why?: RegExp; bump?: 'minor' | 'patch' }

const ROWS: Row[] = [
  { name: 'green patch, old enough', pr: dep(), ok: true, bump: 'patch' },
  { name: 'green minor from Renovate', pr: dep({ author: 'renovate[bot]', title: 'Update dependency express to v4.19.0', body: '| express | `4.18.2` -> `4.19.0` |' }), ok: true, bump: 'minor' },
  { name: 'a neutral check counts as green', pr: dep({ checks: [...green, { name: 'optional', status: 'neutral' }] }), ok: true, bump: 'patch' },
  { name: 'mergeability not known yet still goes', pr: dep({ mergeable: 'UNKNOWN' }), ok: true, bump: 'patch' },
  { name: 'epoch ms opened time', pr: dep({ createdAt: NOW - 4 * DAY }), ok: true, bump: 'patch' },
  { name: 'exactly the minimum age', pr: dep({ createdAt: NOW - MIN_AGE_DAYS * DAY }), ok: true, bump: 'patch' },
  { name: 'major, green and old', pr: dep({ title: 'Bump react from 18.3.1 to 19.0.0', createdAt: ago(60) }), ok: false, why: /major/ },
  { name: 'major from Renovate', pr: dep({ author: 'renovate[bot]', title: 'Update dependency react to v19' }), ok: false, why: /major/ },
  { name: '0.x minor is major', pr: dep({ title: 'Bump vite-plugin from 0.4.1 to 0.5.0' }), ok: false, why: /major/ },
  { name: 'unknown bump is never patch', pr: dep({ author: 'renovate[bot]', title: 'chore(deps): update dependency eslint to v8.57.1' }), ok: false, why: /can't tell how big/ },
  { name: 'a digest update is unknown', pr: dep({ author: 'renovate[bot]', title: 'Update actions/checkout digest to b4ffde6' }), ok: false, why: /can't tell how big/ },
  { name: 'one check red', pr: dep({ checks: [green[0]!, { name: 'test', status: 'failure' }] }), ok: false, why: /CI red/ },
  { name: 'red and old patch', pr: dep({ checks: [{ name: 'test', status: 'failure' }], createdAt: ago(30) }), ok: false, why: /CI red/ },
  { name: 'red beats running', pr: dep({ checks: [{ name: 'a', status: 'pending' }, { name: 'b', status: 'failure' }] }), ok: false, why: /CI red/ },
  { name: 'CI still running', pr: dep({ checks: [green[0]!, { name: 'test', status: 'pending' }] }), ok: false, why: /CI running/ },
  { name: 'no CI at all', pr: dep({ checks: [] }), ok: false, why: /no CI yet/ },
  { name: 'conflicts', pr: dep({ mergeable: 'CONFLICTING' }), ok: false, why: /conflicts/ },
  { name: 'draft', pr: dep({ isDraft: true }), ok: false, why: /draft/ },
  { name: 'merged already', pr: dep({ state: 'MERGED' }), ok: false, why: /already merged/ },
  { name: 'closed', pr: dep({ state: 'CLOSED' }), ok: false, why: /closed/ },
  { name: 'two days old', pr: dep({ createdAt: ago(2) }), ok: false, why: /^too new, ready in 1 day$/ },
  { name: 'opened an hour ago', pr: dep({ createdAt: NOW - 3_600_000 }), ok: false, why: /^too new, ready in 3 days$/ },
  { name: 'opened time unreadable', pr: dep({ createdAt: 'yesterday' }), ok: false, why: /when it was opened/ },
  { name: "someone's own PR", pr: dep({ author: 'samar', labels: [] }), ok: false, why: /not a dependency update/ },
]

test('batchable: the table', () => {
  for (const row of ROWS) {
    const v = batchable(row.pr, NOW)
    assert.equal(v.ok, row.ok, row.name)
    if (v.ok) assert.equal(v.bump, row.bump, row.name)
    else assert.match(v.why, row.why!, row.name)
  }
})

test('batchable: major and red are never batchable, whatever the age window', () => {
  for (const minAge of [0, 1, 3, 30]) {
    assert.equal(batchable(dep({ title: 'Bump a from 1.0.0 to 2.0.0', createdAt: ago(365) }), NOW, minAge).ok, false)
    assert.equal(batchable(dep({ checks: [{ name: 't', status: 'failure' }], createdAt: ago(365) }), NOW, minAge).ok, false)
  }
})

test('batchable: the age window is an argument', () => {
  assert.equal(batchable(dep({ createdAt: ago(1) }), NOW, 0).ok, true)
  assert.equal(batchable(dep({ createdAt: ago(5) }), NOW, 7).ok, false)
})

test('dependencyBatch: splits dependency PRs into the batch and the held, leaves others out', () => {
  type P = DepPr & { number: number }
  const prs: P[] = [
    { ...dep(), number: 1 },
    { ...dep({ title: 'Bump react from 18.3.1 to 19.0.0' }), number: 2 },
    { ...dep({ author: 'samar', labels: [] }), number: 3 },
    { ...dep({ title: 'Bump express from 4.18.2 to 4.19.0' }), number: 4 },
    { ...dep({ checks: [{ name: 't', status: 'failure' }] }), number: 5 },
  ]
  const { ready, held } = dependencyBatch(prs, NOW)
  assert.deepEqual(ready.map((r) => [r.pr.number, r.bump]), [[1, 'patch'], [4, 'minor']])
  assert.deepEqual(held.map((h) => [h.pr.number, h.why]), [[2, 'major update'], [5, 'CI red']])
})
