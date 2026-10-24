/**
 * The babysit watch (core/babysit): the search's parse, what a PR's state
 * becomes as events, and the task each event becomes, with the caps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { babysitSearch, parseBabysit, type BabysitPr } from '../core/babysit/pr.js'
import { afterDecision, babysitEvents, botName, decide, isStale, MAX_FIX_ATTEMPTS, newBabysitWatch, pollSoon, readyForReview, type BabysitEvent } from '../core/babysit/watch.js'
import type { PrCheck, PrThread } from '../core/babysit/ci.js'
import { classify, mainRunsFrom, type MainRun } from '../core/babysit/ci-sort.js'
import { mainRedOnly } from '../core/work/handoff.js'

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
  repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } },
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
  assert.deepEqual([one.pr.headSha, one.pr.headRef, one.pr.baseRef, one.pr.behind, one.pr.isDraft, one.pr.defaultBranch], ['abc1234', 'feat/retries', 'main', false, false, 'main'])
  assert.deepEqual(one.pr.checks.map((c) => [c.name, c.status]), [['lint', 'failure'], ['test', 'success']])
  assert.deepEqual(one.pr.threads.map((t) => [t.author, t.isBot]), [['cursor', true]])
  const [asked] = parseBabysit({ data: { prs: { nodes: [node({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'anirudha' } }] }, mergeStateStatus: 'BEHIND' })] } } }, [], NOW)
  assert.deepEqual([asked.pr.reviewers, asked.pr.behind], [['anirudha'], true])
  // a repo GitHub didn't name a default branch for: no main to compare with
  const [bare] = parseBabysit({ data: { prs: { nodes: [node({ repository: { nameWithOwner: 'acme/api' } })] } } }, [], NOW)
  assert.equal(bare.pr.defaultBranch, null)
})

const check = (name: string, over: Partial<PrCheck> = {}): PrCheck => ({ name, status: 'failure', id: `${name}-1`, runId: 77, url: null, conclusion: 'FAILURE', ...over })
const thread = (over: Partial<PrThread> = {}): PrThread => ({ id: 'T1', author: 'cursor[bot]', isBot: true, resolved: false, path: 'src/api.ts', body: 'Unused variable', url: null, ...over })
const pr = (over: Partial<BabysitPr> = {}): BabysitPr => ({
  repo: 'acme/api', number: 12, url: '', state: 'OPEN', headSha: 'abc', baseRef: 'main', headRef: 'feat/x', mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  checks: [], threads: [], closedBy: null, isDraft: false, behind: false, reviewers: [], reviewed: false, defaultBranch: 'main', ...over,
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
  const ok = [check('lint', { status: 'success' })]
  assert.ok(readyForReview(pr({ checks: ok })))
  assert.ok(!readyForReview(pr()), 'no check has reported yet')
  assert.ok(!readyForReview(pr({ checks: [check('lint', { status: 'pending' })] })))
  assert.ok(!readyForReview(pr({ checks: ok, threads: [thread()] })))
  assert.ok(!readyForReview(pr({ checks: ok, threads: [thread({ isBot: false })] })), 'a person’s open thread holds the request too (ready.ts)')
  assert.ok(readyForReview(pr({ checks: ok, threads: [thread({ isBot: false, resolved: true })] })))
  assert.ok(!readyForReview(pr({ checks: ok, reviewers: ['anirudha'] })))
  assert.ok(!readyForReview(pr({ checks: ok, reviewed: true })))
  assert.ok(!readyForReview(pr({ checks: ok, mergeable: 'UNKNOWN' })))
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

test('a bot thread still open on the next poll is not one that came back', () => {
  const ev: BabysitEvent = { kind: 'bot_thread', thread: thread() }
  const w = afterDecision(newBabysitWatch(), ev, decide(ev, newBabysitWatch(), ctx))
  assert.deepEqual(decide(ev, w, ctx), { do: 'none' })
  // a watch saved before thread ids were kept still sends the same comment to you
  assert.ok(decide(ev, { ...w, botThreads: undefined }, ctx).do === 'task')
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
  assert.ok(pollSoon([pr()], false, true), 'a head that moved since the last poll')
})

// ---- sorted before a fix is spent (ci-sort-glue) ----

const mainRun = (name: string, conclusion: string, over: Partial<MainRun> = {}): MainRun => ({ name, status: 'completed', conclusion, url: `https://github.com/acme/api/runs/${name}`, sha: 'a1b2c3d4e5', completedAt: '2026-10-21T11:20:00Z', ...over })
const failing: BabysitEvent = { kind: 'checks_failed', sha: 'abc', check: check('lint') }

test('red on main too: no task, no rerun, nothing counted', () => {
  const sort = classify(check('lint'), [mainRun('lint', 'failure')], '', [])
  assert.equal(sort.verdict, 'main-red')
  const w = newBabysitWatch()
  const d = decide(failing, w, { ...ctx, sort })
  assert.deepEqual(d, { do: 'none' })
  assert.equal(afterDecision(w, failing, d), w)
  // even a flaky-looking log or a timed-out conclusion: main-red wins, no rerun
  const timedOut: BabysitEvent = { kind: 'checks_failed', sha: 'abc', check: check('lint', { conclusion: 'TIMED_OUT' }) }
  assert.deepEqual(decide(timedOut, w, { ...ctx, log: 'ETIMEDOUT', sort }), { do: 'none' })
})

test(`red on main too after ${MAX_FIX_ATTEMPTS} fixes: still nothing, never a stuck task on you`, () => {
  const w = { ...newBabysitWatch(), fixes: { lint: MAX_FIX_ATTEMPTS } }
  assert.ok(decide(failing, w, ctx).do === 'task', 'unsorted, the cap sends it to you')
  assert.deepEqual(decide(failing, w, { ...ctx, sort: classify(check('lint'), [mainRun('lint', 'failure')], '', []) }), { do: 'none' })
})

test('sorted flaky: one rerun per head, then a fix; sorted fix: a fix even when the log looks flaky', () => {
  const ev: BabysitEvent = { kind: 'checks_failed', sha: 'abc', check: check('test') }
  const flaky = classify(check('test'), [], 'Error: read ECONNRESET', [])
  assert.equal(flaky.verdict, 'flaky')
  const w = newBabysitWatch()
  const d = decide(ev, w, { ...ctx, sort: flaky })
  assert.equal(d.do, 'rerun')
  const after = decide(ev, afterDecision(w, ev, d), { ...ctx, sort: flaky })
  assert.ok(after.do === 'task' && after.task.title === 'Fix test')
  // a status context has no run to rerun: a fix
  assert.equal(decide({ ...ev, check: check('test', { runId: null }) }, w, { ...ctx, sort: flaky }).do, 'task')
  // the sort said fix: no rerun, whatever the raw log reads like
  const fix = classify(check('test'), [mainRun('test', 'success')], 'src/a.ts:1 error', [])
  assert.equal(fix.verdict, 'fix')
  const f = decide(ev, w, { ...ctx, log: 'ETIMEDOUT', sort: fix })
  assert.ok(f.do === 'task' && f.task.key === 'ci:abc:test' && f.task.owner === 'junior')
})

test("main's check runs parse off the REST answer; anything else is no main data", () => {
  const runs = mainRunsFrom({
    total_count: 3,
    check_runs: [
      { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/api/runs/9', head_sha: 'a1b2c3d', completed_at: '2026-10-21T11:00:00Z' },
      { name: 'test', status: 'in_progress', conclusion: null, html_url: null, head_sha: 'a1b2c3d', completed_at: null },
      { status: 'completed' },
    ],
  })
  assert.deepEqual(runs, [
    { name: 'lint', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/api/runs/9', sha: 'a1b2c3d', completedAt: '2026-10-21T11:00:00Z' },
    { name: 'test', status: 'in_progress', conclusion: null, url: null, sha: 'a1b2c3d', completedAt: null },
  ])
  assert.equal(classify(check('lint'), runs, '', []).verdict, 'main-red')
  assert.equal(classify(check('test'), runs, '', []).verdict, 'fix', 'main still running is not main-red')
  for (const junk of [null, {}, { check_runs: 'x' }, 'nope']) assert.deepEqual(mainRunsFrom(junk), [])
})

test('main-red only when every red check is red on main too', () => {
  const m = (check: string) => ({ check, url: null, sha: null, at: null })
  assert.ok(mainRedOnly({ red: ['lint'], mainRed: [m('lint')] }))
  assert.ok(mainRedOnly({ red: ['lint', 'test'], mainRed: [m('test'), m('lint')] }))
  assert.ok(!mainRedOnly({ red: ['lint', 'test'], mainRed: [m('lint')] }), 'a real failure beside it is Junior’s to fix')
  assert.ok(!mainRedOnly({ red: [], mainRed: [m('lint')] }), 'nothing red now')
  assert.ok(!mainRedOnly({ red: ['lint'] }))
  assert.ok(!mainRedOnly({ red: ['lint'], mainRed: [] }))
  assert.ok(!mainRedOnly(undefined))
})
