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
import type { MainRun } from '../core/babysit/ci-sort.js'
import { MAX_FIX_ATTEMPTS } from '../core/babysit/watch.js'

const T0 = Date.parse('2026-10-21T12:00:00Z')

type Check = { name: string; conclusion: string; id: number; status?: string }
const prNode = (number: number, sha: string, checks: Check[], over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest', number, title: `PR ${number}`, url: `https://github.com/acme/api/pull/${number}`, isDraft: false,
  createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T11:00:00Z', state: 'OPEN',
  repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } }, author: { login: 'samar' },
  headRefOid: sha, headRefName: `feat/${number}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [] }, reviews: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: checks.map((c) => ({ __typename: 'CheckRun', databaseId: c.id, name: c.name, status: c.status ?? 'COMPLETED', conclusion: c.conclusion, detailsUrl: null, checkSuite: { workflowRun: { databaseId: 500 + c.id } } })) } } } }] },
  reviewThreads: { nodes: [] },
  ...over,
})

/** `handAll`: every PR is handed off as it is filed, as if you'd pressed Babysit on each. */
type Harness = {
  store: Store
  deps: BabysitDeps
  nodes: unknown[]
  added: [ItemTask, boolean][]
  reruns: string[]
  logs: Record<string, string>
  /** main's check runs per repo; a repo with an Error throws it */
  main: Record<string, MainRun[] | Error>
  /** every read of main's runs, as `repo@branch` */
  mainReads: string[]
  logLines: string[]
}

async function harness(fn: (h: Harness) => Promise<void>, handAll = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-babysit-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const nodes: unknown[] = []
  const added: [ItemTask, boolean][] = []
  const reruns: string[] = []
  const logs: Record<string, string> = {}
  const main: Record<string, MainRun[] | Error> = {}
  const mainReads: string[] = []
  const logLines: string[] = []
  const deps: BabysitDeps = {
    store,
    source: {
      login: async () => 'samar',
      search: async () => ({ data: { prs: { nodes } } }),
      failedLog: async (_repo, check) => logs[check.name] ?? 'src/a.ts:1 error no-unused-vars',
      rerun: async (_repo, check) => void reruns.push(check.name),
      mainRuns: async (repo, branch) => {
        mainReads.push(`${repo}@${branch}`)
        const m = main[repo] ?? []
        if (m instanceof Error) throw m
        return m
      },
    },
    repos: async () => ['acme/api'],
    upsertItem: async (item) => {
      await store.items.upsert(item)
      if (handAll && !(await store.items.get(item.id))?.handoff) await store.items.setFields(item.id, { handoff: 'on' })
    },
    reviewerFor: async () => 'anirudha',
    added: (t, stuck) => void added.push([t, stuck]),
    log: (_level, message) => void logLines.push(message),
  }
  try {
    await fn({ store, deps, nodes, added, reruns, logs, main, mainReads, logLines })
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

// ---- red on main too (ci-sort-glue) ----

const redOnMain = (name: string, over: Partial<MainRun> = {}): MainRun => ({ name, status: 'completed', conclusion: 'failure', url: `https://github.com/acme/api/actions/runs/9${name.length}`, sha: 'a1b2c3d4e5f6', completedAt: '2026-10-21T11:20:00Z', ...over })
const watchOf = async (store: Store, id: string) => (await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.prs[id]

test('red on main too: no fix task, no rerun, nothing counted, and the PR remembers why', () =>
  harness(async ({ store, deps, nodes, added, reruns, main, mainReads, logLines }) => {
    main['acme/api'] = [redOnMain('lint')]
    nodes.push(prNode(20, 'm20', [{ name: 'lint', conclusion: 'FAILURE', id: 20 }, { name: 'test', conclusion: 'SUCCESS', id: 21 }]))
    const r = await babysitTickOp(deps, T0)
    assert.deepEqual(r, { polled: 1, added: 0, reruns: 0, stopped: 0 })
    assert.deepEqual([added.length, reruns.length], [0, 0])
    const id = 'github:acme/api#20'
    assert.equal((await store.tasks.list(id)).length, 0)
    assert.deepEqual(mainReads, ['acme/api@main'])
    const w = await watchOf(store, id)
    assert.deepEqual(w?.fixes, {})
    assert.deepEqual(w?.seen?.mainRed, [{ check: 'lint', url: 'https://github.com/acme/api/actions/runs/94', sha: 'a1b2c3d4e5f6', at: '2026-10-21T11:20:00Z' }])
    assert.equal(logLines.filter((l) => l.includes('is red on main too')).length, 1)
    // the next poll: still red on main, still nothing, and the line isn't logged again
    assert.equal((await babysitTickOp(deps, T0 + 60_000, true))?.added, 0)
    assert.equal(logLines.filter((l) => l.includes('is red on main too')).length, 1)
    // main goes green: the PR's own failure now, so Junior fixes it, and the main-red mark clears
    main['acme/api'] = [redOnMain('lint', { conclusion: 'success' })]
    assert.equal((await babysitTickOp(deps, T0 + 120_000, true))?.added, 1)
    assert.deepEqual((await store.tasks.list(id)).map((t) => t.title), ['Fix lint'])
    assert.equal((await watchOf(store, id))?.seen?.mainRed, undefined)
  }))

test(`red on main too after ${MAX_FIX_ATTEMPTS} fixes: no stuck task lands on you`, () =>
  harness(async ({ store, deps, nodes, added, main }) => {
    const id = 'github:acme/api#21'
    await store.config.set(BABYSIT_WATCH_KEY, { nextPollAt: 0, prs: { [id]: { headSha: 'old', fixes: { lint: MAX_FIX_ATTEMPTS }, reruns: [], botPrints: [] } } } satisfies BabysitWatchState)
    main['acme/api'] = [redOnMain('lint')]
    nodes.push(prNode(21, 'm21', [{ name: 'lint', conclusion: 'FAILURE', id: 22 }]))
    assert.equal((await babysitTickOp(deps, T0))?.added, 0)
    assert.equal(added.length, 0)
    assert.equal((await store.tasks.list(id)).length, 0)
  }))

test('one red check on main, one real failure: Junior fixes the real one', () =>
  harness(async ({ store, deps, nodes, main }) => {
    main['acme/api'] = [redOnMain('lint'), redOnMain('test', { conclusion: 'success' })]
    nodes.push(prNode(22, 'm22', [{ name: 'lint', conclusion: 'FAILURE', id: 23 }, { name: 'test', conclusion: 'FAILURE', id: 24 }]))
    assert.equal((await babysitTickOp(deps, T0))?.added, 1)
    assert.deepEqual((await store.tasks.list('github:acme/api#22')).map((t) => t.title), ['Fix test'])
    const seen = (await watchOf(store, 'github:acme/api#22'))?.seen
    assert.deepEqual([seen?.red, seen?.mainRed?.map((m) => m.check)], [['lint', 'test'], ['lint']])
  }))

test("main's checks are read once per repo per tick, however many PRs are red", () =>
  harness(async ({ deps, nodes, main, mainReads }) => {
    main['acme/api'] = [redOnMain('lint')]
    nodes.push(prNode(23, 'm23', [{ name: 'lint', conclusion: 'FAILURE', id: 25 }]), prNode(24, 'm24', [{ name: 'lint', conclusion: 'FAILURE', id: 26 }, { name: 'e2e', conclusion: 'FAILURE', id: 27 }]))
    await babysitTickOp(deps, T0)
    assert.deepEqual(mainReads, ['acme/api@main'])
    // a new tick reads again: main may have changed
    await babysitTickOp(deps, T0 + 60_000, true)
    assert.deepEqual(mainReads, ['acme/api@main', 'acme/api@main'])
  }))

test("main's checks can't be read: tried once a tick, logged once, and the fix goes ahead", () =>
  harness(async ({ store, deps, nodes, main, mainReads, logLines }) => {
    main['acme/api'] = new Error('HTTP 403: rate limited')
    nodes.push(prNode(25, 'm25', [{ name: 'lint', conclusion: 'FAILURE', id: 28 }]), prNode(26, 'm26', [{ name: 'lint', conclusion: 'FAILURE', id: 29 }]))
    assert.equal((await babysitTickOp(deps, T0))?.added, 2)
    assert.deepEqual(mainReads, ['acme/api@main'])
    assert.deepEqual(logLines.filter((l) => l.startsWith("babysit: couldn't read main's checks")), ["babysit: couldn't read main's checks on acme/api: HTTP 403: rate limited"])
    assert.deepEqual((await store.tasks.list('github:acme/api#25')).map((t) => t.title), ['Fix lint'])
  }))

test('no default branch from GitHub: main is unknown, never read, and the fix goes ahead', () =>
  harness(async ({ store, deps, nodes, mainReads }) => {
    nodes.push(prNode(27, 'm27', [{ name: 'lint', conclusion: 'FAILURE', id: 30 }], { repository: { nameWithOwner: 'acme/api' } }))
    assert.equal((await babysitTickOp(deps, T0))?.added, 1)
    assert.deepEqual(mainReads, [])
    assert.deepEqual((await store.tasks.list('github:acme/api#27')).map((t) => t.title), ['Fix lint'])
  }))

test('a PR nobody handed off: main is never read, and no task of any kind is added, main red or not', () =>
  harness(async ({ store, deps, nodes, added, reruns, main, mainReads, logs }) => {
    main['acme/api'] = [redOnMain('lint')]
    logs.test = 'Error: read ECONNRESET'
    nodes.push(
      prNode(28, 'm28', [{ name: 'lint', conclusion: 'FAILURE', id: 31 }, { name: 'test', conclusion: 'FAILURE', id: 32 }], {
        mergeable: 'CONFLICTING',
        reviewThreads: { nodes: [{ id: 'T28', isResolved: false, path: 'a.ts', comments: { nodes: [{ url: null, body: 'nit', author: { __typename: 'Bot', login: 'cursor' } }] } }] },
      }),
    )
    assert.deepEqual(await babysitTickOp(deps, T0), { polled: 1, added: 0, reruns: 0, stopped: 0 })
    assert.deepEqual([added.length, reruns.length, mainReads.length], [0, 0, 0])
    assert.equal((await store.tasks.list('github:acme/api#28')).length, 0)
    // read, not worked: no main-red mark either
    assert.equal((await watchOf(store, 'github:acme/api#28'))?.seen?.mainRed, undefined)
  }, false))

test('a task that never handed in carries Junior’s last message, clipped', () => {
  assert.equal(unhandedNote('Fixed it.\n\nPushed abc1234.'), 'Junior ended without handing in. Its last message: Fixed it. Pushed abc1234.')
  const long = unhandedNote('x'.repeat(2_000))
  assert.ok(long.endsWith('…') && long.length < 700)
})
