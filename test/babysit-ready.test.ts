/**
 * "Ready because…" (core/babysit/ready.ts): the hand-back gate. One row per
 * failing check and the all-green case, the line each gives, staleness, and
 * the gate wired through the babysit watch (no request on an open thread)
 * and the tick (the hand-back line on the request, the gate on the PR's seen).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chipHref, chipTone, handBackLine, handBackSays, readiness, readyAt, readyLine, readySummary, READY_CHECK_IDS, showsEvidence, type ChipTone, type ReadyCheckId, type ReadyPr } from '../core/babysit/ready.js'
import { babysitEvents, decide, newBabysitWatch, seenOf } from '../core/babysit/watch.js'
import type { BabysitPr } from '../core/babysit/pr.js'
import type { PrCheck, PrThread } from '../core/babysit/ci.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { BABYSIT_WATCH_KEY, babysitTickOp, pollBabysitSoon, type BabysitDeps, type BabysitWatchState } from '../server/babysit/watch.js'

const URL = 'https://github.com/acme/api/pull/12'
const check = (name: string, status: PrCheck['status'] = 'success', over: Partial<PrCheck> = {}): PrCheck => ({ name, status, id: `${name}-1`, runId: 7, url: null, conclusion: null, ...over })
const thread = (over: Partial<PrThread> = {}): PrThread => ({ id: 'T1', author: 'cursor[bot]', isBot: true, resolved: false, path: 'src/api.ts', body: 'Unused variable', url: 'https://gh/t1', ...over })
const green: ReadyPr = { url: URL, headSha: 'abc1234def', baseRef: 'main', checks: [check('lint'), check('test')], threads: [], mergeable: 'MERGEABLE', behind: false }
const at = (over: Partial<ReadyPr>): ReadyPr => ({ ...green, ...over })

type Row = { name: string; pr: ReadyPr; failing: ReadyCheckId[]; label?: string; evidence?: RegExp; url?: string | null; line: string }

const ROWS: Row[] = [
  { name: 'all green', pr: green, failing: [], line: 'Ready because: CI green · 0 threads · no conflicts · up to date' },
  { name: 'a check red', pr: at({ checks: [check('lint', 'failure', { url: 'https://ci/lint' }), check('test')] }), failing: ['ci'], label: 'lint red', evidence: /^Failed on abc1234: lint\.$/, url: 'https://ci/lint', line: 'Not ready: lint red' },
  { name: 'two checks red', pr: at({ checks: [check('lint', 'failure'), check('test', 'failure')] }), failing: ['ci'], label: '2 checks red', url: `${URL}/checks`, line: 'Not ready: 2 checks red' },
  { name: 'CI still running', pr: at({ checks: [check('lint'), check('test', 'pending')] }), failing: ['ci'], label: 'CI running', evidence: /1 of 2 checks still running on abc1234: test/, line: 'Not ready: CI running' },
  { name: 'no CI reported yet', pr: at({ checks: [] }), failing: ['ci'], label: 'no CI yet', line: 'Not ready: no CI yet' },
  { name: "a bot's open thread", pr: at({ threads: [thread()] }), failing: ['threads'], label: '1 thread open', evidence: /^Open: cursor on api\.ts\.$/, url: 'https://gh/t1', line: 'Not ready: 1 thread open' },
  { name: "a person's open thread", pr: at({ threads: [thread({ id: 'T2', author: 'priya', isBot: false, path: null, url: null })] }), failing: ['threads'], label: '1 thread open', evidence: /^Open: priya\.$/, url: URL, line: 'Not ready: 1 thread open' },
  { name: 'conflicts', pr: at({ mergeable: 'CONFLICTING' }), failing: ['mergeable'], label: 'conflicts', evidence: /Conflicts with main/, line: 'Not ready: conflicts' },
  { name: 'mergeability unknown', pr: at({ mergeable: 'UNKNOWN' }), failing: ['mergeable'], label: 'merge unknown', line: 'Not ready: merge unknown' },
  { name: 'behind its base', pr: at({ behind: true }), failing: ['behind'], label: 'behind main', line: 'Not ready: behind main' },
  {
    name: 'several at once, in order',
    pr: at({ checks: [check('lint', 'failure')], threads: [thread(), thread({ id: 'T2' })], behind: true }),
    failing: ['ci', 'threads', 'behind'],
    line: 'Not ready: lint red · 2 threads open · behind main',
  },
]

for (const row of ROWS)
  test(`readiness: ${row.name}`, () => {
    const r = readiness(row.pr)
    assert.equal(r.ready, row.failing.length === 0)
    assert.equal(r.sha, row.pr.headSha)
    assert.deepEqual(r.checks.map((c) => c.id), READY_CHECK_IDS)
    assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), row.failing)
    for (const c of r.checks) assert.ok(c.evidence.length > 0 && c.label.length > 0, `${c.id} has a label and evidence`)
    const first = r.checks.find((c) => c.id === row.failing[0])
    if (row.label) assert.equal(first?.label, row.label)
    if (row.evidence) assert.match(first?.evidence ?? '', row.evidence)
    if (row.url !== undefined) assert.equal(first?.url, row.url)
    assert.equal(readyLine(r), row.line)
    // brand copy: 15 words or fewer
    assert.ok(readyLine(r).split(/\s+/).filter((w) => w !== '·').length <= 15)
  })

test('the all-green evidence: what passed, on which head, with links', () => {
  const r = readiness(at({ threads: [thread({ resolved: true })] }))
  assert.deepEqual(
    r.checks.map((c) => [c.id, c.evidence, c.url]),
    [
      ['ci', '2 checks passed on abc1234.', `${URL}/checks`],
      ['threads', 'All 1 review thread resolved.', URL],
      ['mergeable', 'Merges cleanly into main.', URL],
      ['behind', 'Not behind main.', URL],
    ],
  )
  // a neutral check (skipped, informational) doesn't hold it
  assert.equal(readiness(at({ checks: [check('lint'), check('docs', 'neutral')] })).ready, true)
  // a PR with no url still has evidence, just no link
  assert.equal(readiness(at({ url: '' })).checks[0]!.url, null)
})

test('stale facts are never ready: a push since moves the head', () => {
  const r = readiness(green)
  assert.equal(readyAt(r, 'abc1234def'), true)
  assert.equal(readyAt(r, 'fff0000'), false)
  assert.equal(readyAt(r, null), false)
  assert.equal(readyAt(undefined, 'abc1234def'), false)
  assert.equal(readyAt(readiness(at({ behind: true })), 'abc1234def'), false)
})

const pr = (over: Partial<BabysitPr> = {}): BabysitPr => ({
  repo: 'acme/api', number: 12, url: URL, state: 'OPEN', headSha: 'abc1234def', baseRef: 'main', headRef: 'feat/x', mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  checks: [check('lint')], threads: [], closedBy: null, isDraft: false, behind: false, reviewers: [], reviewed: false, defaultBranch: 'main', ...over,
})

test('a handed-off PR with an open thread is not marked ready, and no request goes to you', () => {
  const open = pr({ threads: [thread({ author: 'priya', isBot: false })] })
  assert.equal(seenOf(open).ready?.ready, false)
  assert.ok(!babysitEvents(open).some((e) => e.kind === 'green'))
  assert.equal(handBackLine({ reason: 'your-pr', junior: { stage: 'watching' }, seen: seenOf(open) }), 'Not ready: 1 thread open')
  // resolved: ready, and the request carries the line it was handed back with
  const done = pr({ threads: [thread({ author: 'priya', isBot: false, resolved: true })] })
  const ev = babysitEvents(done).find((e) => e.kind === 'green')
  assert.ok(ev)
  const d = decide(ev, newBabysitWatch(), { base: 'main', isDraft: false, reviewer: 'anirudha' })
  assert.ok(d.do === 'task')
  assert.equal(d.task.whyDetail, 'Ready because: CI green · 0 threads · no conflicts · up to date')
  assert.deepEqual((d.task.input?.ready as { id: string; ok: boolean }[]).map((c) => [c.id, c.ok]), READY_CHECK_IDS.map((id) => [id, true]))
})

test('the hand-back line only for your PR, while Junior has nothing under way', () => {
  const seen = seenOf(pr())
  assert.equal(handBackLine({ reason: 'your-pr', junior: { stage: 'watching' }, seen }), 'Ready because: CI green · 0 threads · no conflicts · up to date')
  assert.equal(handBackLine({ reason: 'your-pr', junior: { stage: 'working' }, seen }), null, 'Junior is on it: its progress line says so')
  assert.equal(handBackLine({ reason: 'review-requested', junior: { stage: 'watching' }, seen }), null)
  assert.equal(handBackLine({ reason: 'your-pr', junior: { stage: 'watching' }, seen: {} }), null, 'a watch saved before the gate')
  assert.equal(handBackLine({ reason: 'your-pr', seen }), null, 'not handed off')
})

const node = (number: number, threads: unknown[]) => ({
  __typename: 'PullRequest', number, title: `PR ${number}`, url: `https://github.com/acme/api/pull/${number}`, isDraft: false,
  createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T11:00:00Z', state: 'OPEN',
  repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } }, author: { login: 'samar' },
  headRefOid: `sha${number}`, headRefName: `feat/${number}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [] }, reviews: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', databaseId: number, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null, checkSuite: { workflowRun: { databaseId: 9 } } }] } } } }] },
  reviewThreads: { nodes: threads },
})

test('the tick: the gate rides on each PR it read, and gates the request', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-ready-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    const nodes = [
      node(1, [{ id: 'T9', isResolved: false, path: 'db.ts', comments: { nodes: [{ url: 'https://gh/c9', body: 'Why a loop?', author: { __typename: 'User', login: 'priya' } }] } }]),
      node(2, []),
    ]
    const deps: BabysitDeps = {
      store,
      source: { login: async () => 'samar', search: async () => ({ data: { prs: { nodes } } }), failedLog: async () => '', rerun: async () => {}, mainRuns: async () => [] },
      repos: async () => ['acme/api'],
      upsertItem: async (item) => {
        await store.items.upsert(item)
        await store.items.setFields(item.id, { handoff: 'on' })
      },
      reviewerFor: async () => 'anirudha',
      added: () => {},
      log: () => {},
    }
    const T0 = Date.parse('2026-10-24T02:00:00Z')
    await babysitTickOp(deps, T0)
    const state = await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY)
    assert.equal(state?.prs['github:acme/api#1']?.seen?.ready?.ready, false)
    assert.equal(state?.prs['github:acme/api#2']?.seen?.ready?.ready, true)
    // the open thread: Answer priya on you, and no request handed back
    const one = await store.tasks.list('github:acme/api#1')
    assert.deepEqual(one.map((t) => t.step), ['reply-thread'])
    const [req] = await store.tasks.list('github:acme/api#2')
    assert.deepEqual([req?.step, req?.whyDetail], ['request-review', 'Ready because: CI green · 0 threads · no conflicts · up to date'])

    // Junior hands in a push: the next minute tick reads the PR again
    assert.ok((state?.nextPollAt ?? 0) > T0)
    await pollBabysitSoon(store)
    assert.equal((await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.nextPollAt, 0)
    // and a head that moved since the last poll keeps the fast pace while its checks come in
    nodes[1] = { ...node(2, []), headRefOid: 'sha2-new' }
    await babysitTickOp(deps, T0 + 60_000)
    assert.equal((await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.nextPollAt, T0 + 120_000)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- the chips (ready-because-ui) ----------

test('chip tone: passing, settling, left, and orange only on Needs you', () => {
  const ci = (over: Partial<ReadyPr>) => readiness(at(over)).checks[0]!
  const rows: [string, ReturnType<typeof ci>, ChipTone, ChipTone][] = [
    ['CI green', ci({}), 'ok', 'ok'],
    ['lint red', ci({ checks: [check('lint', 'failure')] }), 'left', 'needs'],
    ['CI running', ci({ checks: [check('e2e', 'pending')] }), 'wait', 'wait'],
    ['no CI yet', ci({ checks: [] }), 'wait', 'wait'],
    ['merge unknown', readiness(at({ mergeable: 'UNKNOWN' })).checks[2]!, 'wait', 'wait'],
    ['conflicts', readiness(at({ mergeable: 'CONFLICTING' })).checks[2]!, 'left', 'needs'],
    ['thread open', readiness(at({ threads: [thread()] })).checks[1]!, 'left', 'needs'],
    ['behind main', readiness(at({ behind: true })).checks[3]!, 'left', 'needs'],
  ]
  for (const [name, c, off, on] of rows) {
    assert.equal(chipTone(c, false), off, `${name}, not on Needs you`)
    assert.equal(chipTone(c, true), on, `${name}, on Needs you`)
  }
})

test('closed-row summary: Ready, or the first thing left in line order plus how many more', () => {
  assert.deepEqual(readySummary(readiness(green)), { label: 'Ready', tone: 'ok', more: 0 })
  assert.deepEqual(readySummary(readiness(at({ checks: [check('lint', 'failure')], threads: [thread()] }))), { label: 'lint red', tone: 'left', more: 1 })
  assert.deepEqual(readySummary(readiness(at({ threads: [thread()], behind: true, mergeable: 'CONFLICTING' }))), { label: '1 thread open', tone: 'left', more: 2 })
  // settling reads ash, never orange, even first in line
  assert.deepEqual(readySummary(readiness(at({ checks: [check('e2e', 'pending')] }))), { label: 'CI running', tone: 'wait', more: 0 })
})

test('every chip on a real read links to its evidence over https', () => {
  const r = readiness(at({ checks: [check('lint', 'failure', { url: 'https://ci/lint' })], threads: [thread({ url: 'https://github.com/acme/api/pull/12#discussion_r1' })] }))
  assert.deepEqual(r.checks.map(chipHref), ['https://ci/lint', 'https://github.com/acme/api/pull/12#discussion_r1', URL, URL])
  assert.deepEqual(readiness(green).checks.map(chipHref), [`${URL}/checks`, URL, URL, URL])
})

test('a chip with no link, or a link that is not https, draws as text and shows its evidence', () => {
  for (const url of [null, '', 'javascript:alert(1)', 'http://github.com/x', 'https://a b']) {
    const c = { ok: true, url }
    assert.equal(chipHref(c), null, String(url))
    assert.equal(showsEvidence(c), true, String(url))
  }
  assert.equal(showsEvidence({ ok: true, url: URL }), false)
  assert.equal(showsEvidence({ ok: false, url: URL }), true)
})

test("Junior's line under the chips says what happens next, not which checks", () => {
  assert.equal(handBackSays(readiness(green)), 'Ready for review. All four checks pass.')
  assert.equal(handBackSays(readiness(at({ threads: [thread()] }))), "Not ready yet. I'll hand it back when all four pass.")
})
