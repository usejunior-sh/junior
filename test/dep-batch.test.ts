/**
 * The dependency batch (core/babysit/dep-batch.ts): the suggested row is a
 * read that queues nothing; only the merge run sends, one merge and one log
 * record per PR; a PR that turned red, got conflicts or closed is dropped
 * with a note while the others still go.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  depBatchView,
  depPrFrom,
  depSearches,
  doneLine,
  dropNote,
  mergeArgs,
  mergeMethodFor,
  mergeSummary,
  notNowHides,
  parseRef,
  runDepMerge,
  startRows,
  updateOf,
  type DepMergeDeps,
  type DepMergeRun,
  type DepPrRead,
} from '../core/babysit/dep-batch.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-24T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const green = [
  { name: 'lint', status: 'success' as const },
  { name: 'test', status: 'success' as const },
]

let n = 3300
const pr = (over: Partial<DepPrRead> = {}): DepPrRead => {
  const number = over.number ?? ++n
  return {
    repo: 'acme/web',
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    headSha: `sha${number}`,
    allows: { squash: true, merge: true, rebase: true },
    author: 'dependabot[bot]',
    title: 'Bump eslint from 9.12.0 to 9.13.0',
    labels: ['dependencies'],
    body: '',
    createdAt: ago(4),
    checks: green,
    isDraft: false,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    ...over,
  }
}

/** Fake I/O: counts every merge and record, and lets a test change a PR between reads. */
function fakeDeps(prs: Map<string, DepPrRead | null>, fail: Set<string> = new Set()) {
  const merged: string[][] = []
  const records: { summary: string; error: string | null }[] = []
  const deps: DepMergeDeps = {
    read: async (ref) => prs.get(`${ref.repo}#${ref.number}`) ?? null,
    contractMethod: async () => null,
    merge: async (args) => {
      if (fail.has(args[2]!)) throw new Error('gh pr merge failed: Base branch was modified')
      merged.push(args)
    },
    record: async (r) => void records.push({ summary: mergeSummary(r.row), error: r.error }),
    now: () => NOW,
  }
  return { deps, merged, records }
}

test('updateOf: Dependabot and Renovate titles, a grouped body, and an unreadable title', () => {
  assert.deepEqual(updateOf({ title: 'build(deps-dev): bump @types/node from 22.7.4 to 22.7.5 in /web', body: '' }), { package: '@types/node', more: 0, from: '22.7.4', to: '22.7.5' })
  assert.deepEqual(
    updateOf({ title: 'chore(deps): update dependency vite to v5.4.10', body: '| Package | Change |\n|---|---|\n| [vite](https://vite.dev) | [`5.4.8` -> `5.4.10`](https://x) |' }),
    { package: 'vite', more: 0, from: '5.4.8', to: '5.4.10' },
  )
  assert.deepEqual(
    updateOf({ title: 'Bump the npm_and_yarn group across 1 directory with 2 updates', body: 'Updates `zod` from 3.23.6 to 3.23.8\nUpdates `tsx` from 4.19.0 to 4.19.1' }),
    { package: 'zod', more: 1, from: '3.23.6', to: '3.23.8' },
  )
  assert.equal(updateOf({ title: 'fix(deps): update all non-major dependencies', body: '' }).from, null)
})

test('depBatchView: 2+ batchable make the row; held ones carry why; one alone makes none', () => {
  const a = pr({ createdAt: ago(5) })
  const b = pr({ title: 'Bump vite from 5.4.8 to 5.4.10', createdAt: ago(3.5) })
  const red = pr({ title: 'Bump prettier from 3.3.2 to 3.3.3', checks: [{ name: 'test', status: 'failure' }] })
  const major = pr({ title: 'Bump react from 18.3.1 to 19.0.0' })
  const person = pr({ author: 'samar', labels: [] })
  const v = depBatchView([b, red, a, major, person], NOW)!
  assert.ok(v)
  assert.deepEqual(
    v.prs.map((p) => p.ref),
    [`acme/web#${a.number}`, `acme/web#${b.number}`],
    'oldest first',
  )
  assert.equal(v.prs[0]!.green, 2)
  assert.equal(v.prs[1]!.bump, 'patch')
  assert.deepEqual(
    v.held.map((h) => [h.package, h.why]),
    [
      ['prettier', 'CI red'],
      ['react', 'major update'],
    ],
  )
  assert.equal(depBatchView([a, red, major], NOW), null, 'one batchable PR stays a normal row')
  assert.equal(depBatchView([], NOW), null)
})

test('Not now hides the batch for a day, and a new PR joining brings it back', () => {
  const a = pr()
  const b = pr()
  const refs = [`acme/web#${a.number}`, `acme/web#${b.number}`]
  const notNow = { refs, until: NOW + DAY }
  assert.equal(depBatchView([a, b], NOW, notNow), null)
  assert.ok(depBatchView([a, b], NOW + DAY + 1, notNow), 'a day later it is back')
  assert.ok(depBatchView([a, b, pr()], NOW, notNow), 'a new PR joined')
  assert.equal(notNowHides(refs.slice(0, 1), notNow, NOW), true, 'one merged since: still hidden')
})

test('nothing is queued until the user acts: building the row never merges or records', async () => {
  const a = pr()
  const b = pr()
  const { deps, merged, records } = fakeDeps(new Map([[`acme/web#${a.number}`, a], [`acme/web#${b.number}`, b]]))
  // the day reads the row (any number of times): no I/O beyond the read itself
  for (let i = 0; i < 3; i++) assert.ok(depBatchView([a, b], NOW))
  assert.equal(merged.length, 0)
  assert.equal(records.length, 0)
  // a run with no PRs ticked sends nothing either
  const empty: DepMergeRun = { id: 'r0', startedAt: NOW, rows: [], done: false, summary: null }
  await runDepMerge(empty, deps)
  assert.equal(merged.length, 0)
  assert.equal(records.length, 0)
})

test('Merge: one merge and one log record per PR, pinned to the checked head; a red PR is dropped with a note', async () => {
  const a = pr({ title: 'Bump eslint from 9.12.0 to 9.13.0' })
  const b = pr({ title: 'Bump vite from 5.4.8 to 5.4.10' })
  const c = pr({ title: 'Bump zod from 3.23.6 to 3.23.8' })
  const view = depBatchView([a, b, c], NOW)!
  // between the press and the send, c's CI turned red
  const now = new Map<string, DepPrRead | null>([
    [`acme/web#${a.number}`, a],
    [`acme/web#${b.number}`, b],
    [`acme/web#${c.number}`, { ...c, checks: [{ name: 'test', status: 'failure' }] }],
  ])
  const { deps, merged, records } = fakeDeps(now)
  const seen: string[] = []
  deps.changed = (r) => seen.push(r.rows.map((x) => x.state[0]).join(''))
  const run: DepMergeRun = { id: 'r1', startedAt: NOW, rows: startRows(view, view.prs.map((p) => p.ref)), done: false, summary: null }
  await runDepMerge(run, deps)
  assert.deepEqual(
    merged.map((m) => m.join(' ')),
    [`pr merge ${a.number} -R acme/web --squash --match-head-commit sha${a.number}`, `pr merge ${b.number} -R acme/web --squash --match-head-commit sha${b.number}`],
  )
  assert.equal(records.length, 2, 'each merge is its own record')
  assert.equal(records[0]!.summary, `Merged acme/web#${a.number} (eslint 9.12.0 → 9.13.0)`)
  assert.deepEqual(
    run.rows.map((r) => [r.state, r.note]),
    [
      ['merged', null],
      ['merged', null],
      ['dropped', 'CI turned red'],
    ],
  )
  assert.equal(run.done, true)
  assert.equal(run.summary, `Merged 2 of 3. I left out acme/web#${c.number}: CI turned red.`)
  assert.ok(seen.includes('cww') && seen.includes('mww'), 'each row moves checking → merging → merged on its own')
})

test('Merge: conflicts, closed and a failed send each leave a note; the others still go', async () => {
  const ok = pr()
  const conflicted = pr({ mergeable: 'CONFLICTING' })
  const closed = pr()
  const failing = pr()
  const prs = new Map<string, DepPrRead | null>([
    [`acme/web#${ok.number}`, ok],
    [`acme/web#${conflicted.number}`, conflicted],
    [`acme/web#${closed.number}`, null],
    [`acme/web#${failing.number}`, failing],
  ])
  const { deps, merged, records } = fakeDeps(prs, new Set([String(failing.number)]))
  const refs = [ok, conflicted, closed, failing].map((p) => `acme/web#${p.number}`)
  const run: DepMergeRun = { id: 'r2', startedAt: NOW, rows: startRows(null, refs), done: false, summary: null }
  await runDepMerge(run, deps)
  assert.deepEqual(
    run.rows.map((r) => r.state),
    ['merged', 'dropped', 'dropped', 'failed'],
  )
  assert.equal(run.rows[1]!.note, 'conflicts')
  assert.equal(run.rows[2]!.note, 'closed')
  assert.match(run.rows[3]!.note!, /Base branch was modified/)
  assert.equal(merged.length, 1)
  assert.deepEqual(
    records.map((r) => !!r.error),
    [false, true],
    'a failed send is recorded too, as failed',
  )
})

test('Merge never sends a major, a person’s PR, or a draft, even if named', async () => {
  const major = pr({ title: 'Bump react from 18.3.1 to 19.0.0' })
  const person = pr({ author: 'samar', labels: [] })
  const draft = pr({ isDraft: true })
  const prs = new Map<string, DepPrRead | null>([major, person, draft].map((p) => [`acme/web#${p.number}`, p]))
  const { deps, merged } = fakeDeps(prs)
  const run: DepMergeRun = { id: 'r3', startedAt: NOW, rows: startRows(null, [...prs.keys()]), done: false, summary: null }
  await runDepMerge(run, deps)
  assert.equal(merged.length, 0)
  assert.deepEqual(
    run.rows.map((r) => r.note),
    ['major update', 'not a dependency update', 'draft'],
  )
})

test('merge method: the repo contract when allowed, else squash, else a merge commit; never --admin', () => {
  const all = { squash: true, merge: true, rebase: true }
  assert.equal(mergeMethodFor(all, null), 'squash')
  assert.equal(mergeMethodFor(all, 'rebase'), 'rebase')
  assert.equal(mergeMethodFor({ squash: false, merge: true, rebase: true }, null), 'merge')
  assert.equal(mergeMethodFor({ squash: true, merge: false, rebase: false }, 'merge'), 'squash')
  const args = mergeArgs({ repo: 'acme/web', number: 1, headSha: 'abc' }, 'squash')
  assert.ok(!args.includes('--admin') && !args.includes('--auto'))
})

test('small helpers: refs, notes, the done line, the searches', () => {
  assert.deepEqual(parseRef('acme/web#12'), { repo: 'acme/web', number: 12 })
  assert.equal(parseRef('acme/web#12; rm -rf /'), null)
  assert.equal(parseRef('web#12'), null)
  assert.equal(dropNote('CI red'), 'CI turned red')
  assert.equal(dropNote('conflicts'), 'conflicts')
  assert.equal(doneLine([{ ref: 'a/b#1', package: 'x', from: null, to: null, state: 'merged', note: null }]), 'Merged all 1.')
  assert.deepEqual(depSearches([]), [], 'no repos: no search of all of GitHub')
  const qs = depSearches(Array.from({ length: 30 }, (_, i) => `acme/repository-number-${i}`))
  assert.ok(qs.length > 2 && qs.every((q) => q.length <= 256))
  assert.ok(qs.some((q) => q.includes('author:app/dependabot')) && qs.some((q) => q.includes('author:app/renovate')))
})

test('depPrFrom: a search node → a read PR, with checks and what the repo allows', () => {
  const p = depPrFrom({
    __typename: 'PullRequest',
    number: 7,
    title: 'Bump x from 1.0.0 to 1.0.1',
    url: 'https://github.com/acme/web/pull/7',
    isDraft: false,
    createdAt: ago(4),
    state: 'OPEN',
    body: null,
    mergeable: 'MERGEABLE',
    headRefOid: 'abc',
    author: { login: 'dependabot' },
    labels: { nodes: [{ name: 'dependencies' }] },
    repository: { nameWithOwner: 'acme/web', squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: false },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', databaseId: 1, name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
  })!
  assert.equal(p.repo, 'acme/web')
  assert.deepEqual(p.checks, [{ name: 'ci', status: 'success' }])
  assert.deepEqual(p.allows, { squash: false, merge: true, rebase: false })
  assert.equal(depPrFrom({ __typename: 'Issue' }), null)
})
