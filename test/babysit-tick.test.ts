/**
 * The babysit tick end to end, against a real sqlite store in a temp dir and
 * a fake GitHub: PRs become items with tasks once handed off, an event read
 * twice adds one task, a flake is rerun, pacing holds, a merged PR's tasks
 * stop, and a PR nobody handed off is read but never touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { ItemTask } from '../core/work/tasks.js'
import { BABYSIT_WATCH_KEY, babysitTickOp, type BabysitDeps, type BabysitWatchState } from '../server/babysit/watch.js'
import { unhandedNote } from '../server/tasks/runner.js'

const T0 = Date.parse('2026-10-21T12:00:00Z')

type Check = { name: string; conclusion: string; id: number; status?: string }
const prNode = (number: number, sha: string, checks: Check[], over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest', number, title: `PR ${number}`, url: `https://github.com/acme/api/pull/${number}`, isDraft: false,
  createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T11:00:00Z', state: 'OPEN',
  repository: { nameWithOwner: 'acme/api' }, author: { login: 'samar' },
  headRefOid: sha, headRefName: `feat/${number}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [] }, reviews: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: checks.map((c) => ({ __typename: 'CheckRun', databaseId: c.id, name: c.name, status: c.status ?? 'COMPLETED', conclusion: c.conclusion, detailsUrl: null, checkSuite: { workflowRun: { databaseId: 500 + c.id } } })) } } } }] },
  reviewThreads: { nodes: [] },
  ...over,
})

/** `handAll`: every PR is handed off as it is filed, as if you'd pressed Babysit on each. */
async function harness(fn: (h: { store: Store; deps: BabysitDeps; nodes: unknown[]; added: [ItemTask, boolean][]; reruns: string[]; logs: Record<string, string> }) => Promise<void>, handAll = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-babysit-'))
  const store = openSqliteStore(path.join(dir, 'triage.db'))
  const nodes: unknown[] = []
  const added: [ItemTask, boolean][] = []
  const reruns: string[] = []
  const logs: Record<string, string> = {}
  const deps: BabysitDeps = {
    store,
    source: {
      login: async () => 'samar',
      search: async () => ({ data: { prs: { nodes } } }),
      failedLog: async (_repo, check) => logs[check.name] ?? 'src/a.ts:1 error no-unused-vars',
      rerun: async (_repo, check) => void reruns.push(check.name),
    },
    repos: async () => ['acme/api'],
    upsertItem: async (item) => {
      await store.items.upsert(item)
      if (handAll && !(await store.items.get(item.id))?.handoff) await store.items.setFields(item.id, { handoff: 'on' })
    },
    reviewerFor: async () => 'anirudha',
    added: (t, stuck) => void added.push([t, stuck]),
    log: () => {},
  }
  try {
    await fn({ store, deps, nodes, added, reruns, logs })
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a red PR becomes an item with "Fix lint", once', () =>
  harness(async ({ store, deps, nodes, added }) => {
    nodes.push(prNode(12, 'aaa', [{ name: 'lint', conclusion: 'FAILURE', id: 1 }, { name: 'test', conclusion: 'SUCCESS', id: 2 }]))
    const r = await babysitTickOp(deps, T0)
    assert.deepEqual(r, { polled: 1, added: 1, reruns: 0, stopped: 0 })
    const item = await store.items.get('github:acme/api#12')
    assert.equal(item?.playbook, 'babysit')
    const tasks = await store.tasks.list('github:acme/api#12')
    assert.deepEqual(tasks.map((t) => [t.title, t.state, t.step, t.key]), [['Fix lint', 'queued', 'fix-ci', 'ci:aaa:lint']])
    assert.deepEqual(added.map(([t, stuck]) => [t.title, stuck]), [['Fix lint', false]])
    // the same read again: not due yet, and forced it adds nothing
    assert.equal(await babysitTickOp(deps, T0 + 1000), null)
    assert.equal((await babysitTickOp(deps, T0 + 1000, true))?.added, 0)
    const w = await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY)
    assert.equal(w?.prs['github:acme/api#12']?.headSha, 'aaa')
    assert.equal(w?.prs['github:acme/api#12']?.fixes.lint, 1)
    // a queued task keeps the pace fast
    assert.equal(w?.nextPollAt, T0 + 1000 + 60_000)
  }))

test('a flaky failure is rerun, not fixed', () =>
  harness(async ({ store, deps, nodes, reruns, logs }) => {
    logs.test = 'Error: read ECONNRESET'
    nodes.push(prNode(13, 'bbb', [{ name: 'test', conclusion: 'FAILURE', id: 3 }]))
    const r = await babysitTickOp(deps, T0)
    assert.deepEqual([r?.added, r?.reruns], [0, 1])
    assert.deepEqual(reruns, ['test'])
    assert.equal((await store.tasks.list('github:acme/api#13')).length, 0)
  }))

test('green asks you to request the reviewer it learned', () =>
  harness(async ({ store, deps, nodes }) => {
    nodes.push(prNode(14, 'ccc', [{ name: 'lint', conclusion: 'SUCCESS', id: 4 }]))
    await babysitTickOp(deps, T0)
    const [t] = await store.tasks.list('github:acme/api#14')
    assert.deepEqual([t.title, t.owner, t.state], ['Request anirudha', 'you', 'waiting'])
    // nothing moving: the slow pace
    assert.equal((await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.nextPollAt, T0 + 5 * 60_000)
  }))

test('a PR gone from the search: its waiting and queued tasks stop', () =>
  harness(async ({ store, deps, nodes }) => {
    nodes.push(prNode(15, 'ddd', [{ name: 'lint', conclusion: 'FAILURE', id: 5 }]))
    await babysitTickOp(deps, T0)
    nodes.length = 0
    const r = await babysitTickOp(deps, T0 + 120_000)
    assert.equal(r?.stopped, 1)
    const [t] = await store.tasks.list('github:acme/api#15')
    assert.deepEqual([t.state, t.error], ['stopped', 'the PR was merged or closed'])
    assert.deepEqual((await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.prs, {})
  }))

test('no repos: nothing is read', () =>
  harness(async ({ deps, nodes }) => {
    nodes.push(prNode(16, 'eee', []))
    assert.equal(await babysitTickOp({ ...deps, repos: async () => [] }, T0), null)
  }))

test('a PR nobody handed off is read, not worked; handed off, its tasks come', () =>
  harness(async ({ store, deps, nodes, added, reruns }) => {
    nodes.push(prNode(17, 'fff', [{ name: 'lint', conclusion: 'FAILURE', id: 7 }], { reviewThreads: { nodes: [] } }))
    const r = await babysitTickOp(deps, T0)
    assert.deepEqual(r, { polled: 1, added: 0, reruns: 0, stopped: 0 })
    assert.deepEqual([added.length, reruns.length], [0, 0])
    const id = 'github:acme/api#17'
    assert.equal((await store.tasks.list(id)).length, 0)
    // what it saw is kept, for the suggestion
    const w = await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY)
    assert.deepEqual(w?.prs[id]?.seen, { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false })
    await store.items.setFields(id, { handoff: 'on' })
    assert.equal((await babysitTickOp(deps, T0 + 1000, true))?.added, 1)
    assert.deepEqual((await store.tasks.list(id)).map((t) => t.title), ['Fix lint'])
    // paused: read again, nothing added even for something new
    await store.items.setFields(id, { handoff: 'paused' })
    nodes[0] = prNode(17, 'ggg', [{ name: 'lint', conclusion: 'FAILURE', id: 8 }])
    assert.equal((await babysitTickOp(deps, T0 + 2000, true))?.added, 0)
  }, false))

test('a task that never handed in carries Junior’s last message, clipped', () => {
  assert.equal(unhandedNote('Fixed it.\n\nPushed abc1234.'), 'Junior ended without handing in. Its last message: Fixed it. Pushed abc1234.')
  const long = unhandedNote('x'.repeat(2_000))
  assert.ok(long.endsWith('…') && long.length < 700)
})
