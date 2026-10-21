/**
 * The babysit watch (core/babysit): the search's parse, what a PR's state
 * becomes as events, and the task each event becomes, with the caps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { babysitSearch, parseBabysit, type BabysitPr } from '../core/babysit/pr.js'
import { afterDecision, babysitEvents, botName, decide, isStale, MAX_FIX_ATTEMPTS, newBabysitWatch, pollSoon, readyForReview, type BabysitEvent } from '../core/babysit/watch.js'
import type { PrCheck, PrThread } from '../core/goals/shepherd.js'

const NOW = Date.parse('2026-10-21T12:00:00Z')

const node = (over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest',
  number: 12,
  title: 'Add retries',
  url: 'https://github.com/acme/api/pull/12',
  isDraft: false,
  createdAt: '2026-10-21T10:00:00Z',
  updatedAt: '2026-10-21T11:00:00Z',
  state: 'OPEN',
  repository: { nameWithOwner: 'acme/api' },
  author: { login: 'samar' },
  headRefOid: 'abc1234',
  headRefName: 'feat/retries',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [] },
  reviews: { totalCount: 0 },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              nodes: [
                { __typename: 'CheckRun', databaseId: 1, name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/lint', checkSuite: { workflowRun: { databaseId: 77 } } },
                { __typename: 'CheckRun', databaseId: 2, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null, checkSuite: { workflowRun: { databaseId: 77 } } },
              ],
            },
          },
        },
      },
    ],
  },
  reviewThreads: {
    nodes: [{ id: 'T1', isResolved: false, path: 'src/api.ts', comments: { nodes: [{ url: 'https://gh/c1', body: 'Unused variable `x`', author: { __typename: 'Bot', login: 'cursor' } }] } }],
  },
  ...over,
})

test('the search is scoped to the repos when the qualifier fits, else filtered after', () => {
  assert.deepEqual(babysitSearch('samar', ['acme/api']), { q: 'is:open is:pr author:samar archived:false repo:acme/api', clientFilter: false })
  const many = Array.from({ length: 20 }, (_, i) => `acme/repo-number-${i}`)
  assert.equal(babysitSearch('samar', many).clientFilter, true)
})

test('the parse gives the item to file and the PR to watch', () => {
  const [one, ...rest] = parseBabysit({ data: { prs: { nodes: [node(), node({ number: 9, repository: { nameWithOwner: 'other/repo' } }), { __typename: 'Issue' }] } } }, ['acme/api'], NOW)
  assert.equal(rest.length, 0)
  assert.equal(one.item.id, 'github:acme/api#12')
  assert.equal(one.item.kind, 'own-pr-open')
  assert.equal(one.item.ciFailing, true)
  assert.deepEqual([one.pr.headSha, one.pr.headRef, one.pr.baseRef, one.pr.behind, one.pr.isDraft], ['abc1234', 'feat/retries', 'main', false, false])
  assert.deepEqual(one.pr.checks.map((c) => [c.name, c.status]), [['lint', 'failure'], ['test', 'success']])
  assert.deepEqual(one.pr.threads.map((t) => [t.author, t.isBot]), [['cursor', true]])
  const [asked] = parseBabysit({ data: { prs: { nodes: [node({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'anirudha' } }] }, mergeStateStatus: 'BEHIND' })] } } }, [], NOW)
  assert.deepEqual([asked.pr.reviewers, asked.pr.behind], [['anirudha'], true])
})

const check = (name: string, over: Partial<PrCheck> = {}): PrCheck => ({ name, status: 'failure', id: `${name}-1`, runId: 77, url: null, conclusion: 'FAILURE', ...over })
const thread = (over: Partial<PrThread> = {}): PrThread => ({ id: 'T1', author: 'cursor[bot]', isBot: true, resolved: false, path: 'src/api.ts', body: 'Unused variable', url: null, ...over })
const pr = (over: Partial<BabysitPr> = {}): BabysitPr => ({
  repo: 'acme/api', number: 12, url: '', state: 'OPEN', headSha: 'abc', baseRef: 'main', headRef: 'feat/x', mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  checks: [], threads: [], closedBy: null, isDraft: false, behind: false, reviewers: [], reviewed: false, ...over,
})
const ctx = { base: 'main', isDraft: false, reviewer: 'anirudha' }

test('events: failing checks, open threads, rebase, then green', () => {
  const evs = babysitEvents(pr({ checks: [check('lint'), check('test', { status: 'success' })], threads: [thread(), thread({ id: 'T2', author: 'drew', isBot: false })], mergeable: 'CONFLICTING' }))
  assert.deepEqual(evs.map((e) => e.kind), ['checks_failed', 'bot_thread', 'human_thread', 'rebase'])
  assert.deepEqual(babysitEvents(pr({ behind: true })).map((e) => e.kind), ['rebase'])
  assert.deepEqual(babysitEvents(pr({ checks: [check('lint', { status: 'success' })] })).map((e) => e.kind), ['green'])
  assert.deepEqual(babysitEvents(pr({ state: 'MERGED' })), [])
})

test('green waits for checks, bots, conflicts and a reviewer nobody asked yet', () => {
  assert.ok(readyForReview(pr()))
  assert.ok(!readyForReview(pr({ checks: [check('lint', { status: 'pending' })] })))
  assert.ok(!readyForReview(pr({ threads: [thread()] })))
  assert.ok(readyForReview(pr({ threads: [thread({ isBot: false })] })), 'a person’s thread doesn’t hold the request')
  assert.ok(!readyForReview(pr({ reviewers: ['anirudha'] })))
  assert.ok(!readyForReview(pr({ reviewed: true })))
  assert.ok(!readyForReview(pr({ mergeable: 'UNKNOWN' })))
})

test('a failing check becomes "Fix lint", keyed per head and check', () => {
  const ev: BabysitEvent = { kind: 'checks_failed', sha: 'abc', check: check('lint') }
  const d = decide(ev, newBabysitWatch(), ctx)
  assert.equal(d.do, 'task')
  if (d.do !== 'task') return
  assert.deepEqual([d.task.title, d.task.owner, d.task.step, d.task.key, d.task.whyDetail], ['Fix lint', 'junior', 'fix-ci', 'ci:abc:lint', 'CI red: lint'])
  assert.equal(d.task.input?.attempt, 1)
})

test('a flaky-looking failure is rerun once, then fixed', () => {
  const ev: BabysitEvent = { kind: 'checks_failed', sha: 'abc', check: check('test') }
  const w = newBabysitWatch()
  const d = decide(ev, w, { ...ctx, log: 'Error: connect ETIMEDOUT 10.0.0.1:443' })
  assert.equal(d.do, 'rerun')
  const w2 = afterDecision(w, ev, d)
  assert.equal(decide(ev, w2, { ...ctx, log: 'Error: connect ETIMEDOUT' }).do, 'task')
  // a status context has no run to rerun
  assert.equal(decide({ ...ev, check: check('test', { runId: null }) }, w, { ...ctx, log: 'ETIMEDOUT' }).do, 'task')
})

test(`after ${MAX_FIX_ATTEMPTS} fixes the check goes to you, stuck`, () => {
  let w = newBabysitWatch()
  for (let i = 0; i < MAX_FIX_ATTEMPTS; i++) {
    const ev: BabysitEvent = { kind: 'checks_failed', sha: `s${i}`, check: check('lint') }
    w = afterDecision(w, ev, decide(ev, w, ctx))
  }
  const d = decide({ kind: 'checks_failed', sha: 'sX', check: check('lint') }, w, ctx)
  assert.ok(d.do === 'task' && d.stuck && d.task.owner === 'you' && d.task.state === 'waiting' && d.task.key === 'stuck:ci:lint')
  assert.equal(afterDecision(w, { kind: 'checks_failed', sha: 'sX', check: check('lint') }, d), w, 'a stuck task counts nothing')
})

test('a bot comment is fixed by Junior; the same comment again goes to you', () => {
  const ev: BabysitEvent = { kind: 'bot_thread', thread: thread() }
  const d = decide(ev, newBabysitWatch(), ctx)
  assert.ok(d.do === 'task' && d.task.title === 'Fix Bugbot comment on api.ts' && d.task.step === 'fix-thread' && d.task.owner === 'junior')
  const w = afterDecision(newBabysitWatch(), ev, d)
  const again = decide({ kind: 'bot_thread', thread: thread({ id: 'T9' }) }, w, ctx)
  assert.ok(again.do === 'task' && again.stuck && again.task.owner === 'you')
})

test('a person’s thread is yours, a rebase is Junior’s, green asks you once', () => {
  const h = decide({ kind: 'human_thread', thread: thread({ author: 'drew', isBot: false, path: null }) }, newBabysitWatch(), ctx)
  assert.ok(h.do === 'task' && h.task.title === 'Answer drew' && h.task.owner === 'you' && h.task.state === 'waiting')
  const r = decide({ kind: 'rebase', sha: 'abc', why: 'behind' }, newBabysitWatch(), ctx)
  assert.ok(r.do === 'task' && r.task.title === 'Rebase on main' && r.task.whyDetail === 'behind main' && r.task.key === 'rebase:abc')
  const g = decide({ kind: 'green', sha: 'abc' }, newBabysitWatch(), ctx)
  assert.ok(g.do === 'task' && g.task.title === 'Request anirudha' && g.task.key === 'request-review' && g.task.state === 'waiting')
  const draft = decide({ kind: 'green', sha: 'abc' }, newBabysitWatch(), { ...ctx, isDraft: true, reviewer: null })
  assert.ok(draft.do === 'task' && draft.task.title === 'Mark ready + request a reviewer')
})

test('bot names, stale tasks, poll pace', () => {
  assert.equal(botName('cursor[bot]'), 'Bugbot')
  assert.equal(botName('coderabbitai[bot]'), 'coderabbitai')
  assert.ok(isStale({ step: 'fix-ci', input: { sha: 'old' } }, 'new'))
  assert.ok(!isStale({ step: 'fix-ci', input: { sha: 'new' } }, 'new'))
  assert.ok(!isStale({ step: 'fix-thread', input: {} }, 'new'))
  assert.ok(pollSoon([pr({ checks: [check('ci', { status: 'pending' })] })], false))
  assert.ok(pollSoon([], true))
  assert.ok(!pollSoon([pr()], false))
})
