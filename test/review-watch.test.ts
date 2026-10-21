/**
 * The review watch (core/review + server/review/watch.ts): the search, the
 * parse, one pass per request, a re-request is a new pass, and a PR that no
 * longer asks you stops what hasn't run. Real sqlite store, fake GitHub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { ItemTask } from '../core/work/tasks.js'
import { DEFAULT_BABYSIT } from '../core/babysit/settings.js'
import { latestRequest, parseReview, reviewSearch } from '../core/review/pr.js'
import { reviewTask } from '../core/review/watch.js'
import { REVIEW_WATCH_KEY, reviewTickOp, type ReviewDeps, type ReviewWatchState } from '../server/review/watch.js'

const T0 = Date.parse('2026-10-21T12:00:00Z')
const ID = 'github:acme/api#40'

const ev = (id: string, login: string, by = 'drew') => ({ id, createdAt: '2026-10-21T11:00:00Z', actor: { login: by }, requestedReviewer: { __typename: 'User', login } })
const prNode = (over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest', number: 40, title: 'Cache the token', url: 'https://github.com/acme/api/pull/40', isDraft: false,
  createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T11:00:00Z', state: 'OPEN',
  repository: { nameWithOwner: 'acme/api' }, author: { login: 'drew' },
  headRefOid: 'aaa111', headRefName: 'drew/cache', baseRefName: 'main', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  timelineItems: { nodes: [ev('E1', 'samar')] },
  ...over,
})

test('the search asks for requests to you personally, scoped to the repos when it fits', () => {
  assert.deepEqual(reviewSearch('samar', ['acme/api']), { q: 'is:open is:pr user-review-requested:samar archived:false repo:acme/api', clientFilter: false })
  assert.equal(reviewSearch('samar', Array.from({ length: 20 }, (_, i) => `acme/repo-number-${i}`)).clientFilter, true)
})

test('the latest request is the newest one naming you, not a team or someone else', () => {
  const tl = { nodes: [ev('E1', 'samar'), ev('E2', 'anirudha'), { id: 'E3', createdAt: 'x', actor: { login: 'drew' }, requestedReviewer: { __typename: 'Team', slug: 'platform' } }, ev('E4', 'Samar', 'kim')] }
  assert.deepEqual(latestRequest(tl, 'samar'), { id: 'E4', by: 'kim', at: '2026-10-21T11:00:00Z' })
  assert.equal(latestRequest({ nodes: [ev('E2', 'anirudha')] }, 'samar'), null)
  assert.equal(latestRequest(undefined, 'samar'), null)
})

test('parse: open PRs in the repos become review-requested items with their head', () => {
  const data = { data: { prs: { nodes: [prNode(), prNode({ number: 41, repository: { nameWithOwner: 'other/repo' } }), prNode({ number: 42, state: 'MERGED' })] } } }
  const got = parseReview(data, ['acme/api'], 'samar')
  assert.equal(got.length, 1)
  assert.equal(got[0]!.item.id, ID)
  assert.equal(got[0]!.item.kind, 'review-requested')
  assert.deepEqual(got[0]!.pr, { repo: 'acme/api', number: 40, author: 'drew', headSha: 'aaa111', headRef: 'drew/cache', baseRef: 'main', isDraft: false, request: { id: 'E1', by: 'drew', at: '2026-10-21T11:00:00Z' } })
})

test('the task is keyed on the request, or on the head when no request shows', () => {
  const [{ pr }] = parseReview({ data: { prs: { nodes: [prNode()] } } }, [], 'samar')
  const t = reviewTask(pr!)
  assert.deepEqual([t.title, t.owner, t.step, t.key, t.whyDetail], ['Review first pass', 'junior', 'review', 'review:E1', 'drew requested your review'])
  assert.equal(reviewTask({ ...pr!, request: null }).key, 'review:aaa111')
})

async function harness(fn: (h: { store: Store; deps: ReviewDeps; nodes: unknown[]; added: ItemTask[] }) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-review-'))
  const store = openSqliteStore(path.join(dir, 'triage.db'))
  const nodes: unknown[] = []
  const added: ItemTask[] = []
  const deps: ReviewDeps = {
    store,
    source: { login: async () => 'samar', search: async () => ({ data: { prs: { nodes } } }) },
    settings: async () => ({ ...DEFAULT_BABYSIT, reviews: true }),
    repos: async () => ['acme/api'],
    upsertItem: async (item) => void (await store.items.upsert(item)),
    added: (t) => void added.push(t),
    log: () => {},
  }
  try {
    await fn({ store, deps, nodes, added })
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('off, or no repos: nothing is read', () =>
  harness(async ({ deps }) => {
    assert.equal(await reviewTickOp({ ...deps, settings: async () => DEFAULT_BABYSIT }, T0), null)
    assert.equal(await reviewTickOp({ ...deps, repos: async () => [] }, T0), null)
  }))

test('a request becomes one first pass; reading it again adds nothing; a re-request adds another', () =>
  harness(async ({ store, deps, nodes, added }) => {
    nodes.push(prNode())
    assert.deepEqual(await reviewTickOp(deps, T0), { polled: 1, added: 1, stopped: 0 })
    assert.equal((await store.items.get(ID))?.playbook, 'review')
    assert.deepEqual((await store.tasks.list(ID)).map((t) => [t.title, t.state, t.key]), [['Review first pass', 'queued', 'review:E1']])
    assert.equal(added.length, 1)
    // not due for 2 minutes; forced, the same request adds nothing
    assert.equal(await reviewTickOp(deps, T0 + 1000), null)
    assert.equal((await reviewTickOp(deps, T0 + 1000, true))?.added, 0)
    const w = await store.config.get<ReviewWatchState>(REVIEW_WATCH_KEY)
    assert.deepEqual(w?.prs[ID], { headSha: 'aaa111', headRef: 'drew/cache', baseRef: 'main', requestId: 'E1' })
    assert.equal(w?.nextPollAt, T0 + 1000 + 120_000)
    // new commits alone: no new pass
    nodes[0] = prNode({ headRefOid: 'bbb222' })
    assert.equal((await reviewTickOp(deps, T0 + 200_000))?.added, 0)
    // re-requested: a new event, a new pass
    nodes[0] = prNode({ headRefOid: 'bbb222', timelineItems: { nodes: [ev('E1', 'samar'), ev('E9', 'samar')] } })
    assert.equal((await reviewTickOp(deps, T0 + 400_000))?.added, 1)
    assert.deepEqual((await store.tasks.list(ID)).map((t) => t.key), ['review:E1', 'review:E9'])
  }))

test('a PR that no longer asks you: its queued pass and unposted review stop, a running pass is left', () =>
  harness(async ({ store, deps, nodes }) => {
    nodes.push(prNode(), prNode({ number: 41, url: 'https://github.com/acme/api/pull/41' }))
    await reviewTickOp(deps, T0)
    const [a] = await store.tasks.list(ID)
    const [b] = await store.tasks.list('github:acme/api#41')
    await store.tasks.move(b!.id, 'running', {}, T0)
    await store.tasks.add({ itemId: ID, title: 'Post review', owner: 'you', why: 'playbook', step: 'post-review', key: 'post:E1', state: 'waiting' }, T0)
    nodes.length = 0
    assert.deepEqual(await reviewTickOp(deps, T0 + 200_000), { polled: 0, added: 0, stopped: 2 })
    assert.deepEqual((await store.tasks.list(ID)).map((t) => [t.title, t.state]), [['Review first pass', 'stopped'], ['Post review', 'stopped']])
    assert.equal((await store.tasks.get(a!.id))?.error, 'the PR no longer asks for your review')
    assert.equal((await store.tasks.get(b!.id))?.state, 'running')
  }))
