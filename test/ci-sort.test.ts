/**
 * Sorting a failed check (core/babysit/ci-sort.ts): red on main too, flaky,
 * or the PR's own failure. A table of cases, then the helpers' edges.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, flakyLine, latestMainRun, touchedFiles, type CiSortVerdict, type MainRun } from '../core/babysit/ci-sort.js'

const run = (over: Partial<MainRun> = {}): MainRun => ({
  name: 'test',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/acme/api/actions/runs/9/job/1',
  sha: 'f00dbab',
  completedAt: '2026-10-24T01:00:00Z',
  ...over,
})

const check = { name: 'test', conclusion: 'FAILURE' }
const ASSERT_LOG = 'FAIL src/retry.test.ts\n  expected 3 to equal 2\n    at src/retry.ts:41:7'
const FILES = ['src/retry.ts', 'src/retry.test.ts']

type Case = {
  name: string
  check?: { name: string; conclusion: string | null }
  runs: MainRun[] | null | undefined
  log?: string
  files?: string[]
  verdict: CiSortVerdict
  url?: string | null
}

const CASES: Case[] = [
  // main-red
  { name: 'same check failed on main', runs: [run()], log: ASSERT_LOG, files: FILES, verdict: 'main-red', url: 'https://github.com/acme/api/actions/runs/9/job/1' },
  { name: 'GraphQL-cased fields still match', runs: [run({ status: 'COMPLETED', conclusion: 'FAILURE' })], verdict: 'main-red' },
  { name: 'main timed out counts as red', runs: [run({ conclusion: 'timed_out' })], verdict: 'main-red' },
  { name: 'main red beats a flaky log', runs: [run()], log: 'Error: connect ETIMEDOUT 140.82.112.3:443', verdict: 'main-red' },
  {
    name: 'latest completed run decides: older pass, newer fail',
    runs: [run({ conclusion: 'success', completedAt: '2026-10-23T01:00:00Z' }), run({ conclusion: 'failure', completedAt: '2026-10-24T01:00:00Z', url: 'https://ci/new' })],
    verdict: 'main-red',
    url: 'https://ci/new',
  },
  {
    name: 'a run still in progress is skipped for the last completed one',
    runs: [run({ status: 'in_progress', conclusion: null, completedAt: null }), run({ url: 'https://ci/done' })],
    verdict: 'main-red',
    url: 'https://ci/done',
  },
  // not main-red: main passed, or no usable main data
  { name: 'latest completed run on main passed', runs: [run({ conclusion: 'failure', completedAt: '2026-10-23T01:00:00Z' }), run({ conclusion: 'success' })], verdict: 'fix' },
  { name: 'no main data (null)', runs: null, log: ASSERT_LOG, verdict: 'fix' },
  { name: 'no main data (undefined)', runs: undefined, verdict: 'fix' },
  { name: 'no main runs at all', runs: [], verdict: 'fix' },
  { name: 'main ran other checks only', runs: [run({ name: 'lint' })], verdict: 'fix' },
  { name: 'main run of the check is still running', runs: [run({ status: 'in_progress', conclusion: null })], verdict: 'fix' },
  { name: 'main run cancelled is not red', runs: [run({ conclusion: 'cancelled' })], verdict: 'fix' },
  { name: 'completed with no conclusion is no data', runs: [run({ conclusion: null })], verdict: 'fix' },
  // flaky
  { name: 'network error in the log', runs: [run({ conclusion: 'success' })], log: 'npm ERR! network\nnpm ERR! code ECONNRESET', verdict: 'flaky' },
  { name: 'runner lost', runs: null, log: 'The self-hosted runner lost communication with the server.', verdict: 'flaky' },
  { name: 'GitHub said timed out', check: { name: 'test', conclusion: 'TIMED_OUT' }, runs: null, verdict: 'flaky' },
  { name: 'GitHub said cancelled', check: { name: 'test', conclusion: 'CANCELLED' }, runs: [], verdict: 'flaky' },
  // fix
  { name: 'plain assertion failure', runs: [run({ conclusion: 'success' })], log: ASSERT_LOG, files: FILES, verdict: 'fix' },
  { name: 'flaky line names a file the PR changed', runs: null, log: 'src/retry.test.ts: Timeout of 2000ms exceeded', files: FILES, verdict: 'fix' },
  { name: 'empty log, no main data', runs: null, log: '', verdict: 'fix' },
]

for (const c of CASES) {
  test(`classify: ${c.name} → ${c.verdict}`, () => {
    const out = classify(c.check ?? check, c.runs, c.log ?? '', c.files ?? [])
    assert.equal(out.verdict, c.verdict)
    if (c.url !== undefined) {
      assert.equal(out.verdict, 'main-red')
      if (out.verdict === 'main-red') assert.equal(out.evidence.url, c.url)
    }
  })
}

test('main-red carries the run link, sha and conclusion, and the row line', () => {
  const out = classify(check, [run()], '', [])
  assert.deepEqual(out, {
    verdict: 'main-red',
    why: 'Main is red too · not yours',
    evidence: { url: 'https://github.com/acme/api/actions/runs/9/job/1', sha: 'f00dbab', conclusion: 'FAILURE', completedAt: '2026-10-24T01:00:00Z' },
  })
})

test('flaky carries the log line that matched', () => {
  const out = classify(check, null, 'Run npm ci\nnpm ERR! code ECONNRESET\nnpm ERR! network aborted', [])
  assert.equal(out.verdict, 'flaky')
  if (out.verdict !== 'flaky') return
  assert.deepEqual(out.evidence, { match: 'npm ERR! code ECONNRESET', source: 'log' })
  assert.match(out.why, /^Looks flaky: /)
})

test('flaky from the conclusion says so in words', () => {
  const out = classify({ name: 'e2e', conclusion: 'STARTUP_FAILURE' }, null, '', [])
  assert.equal(out.verdict, 'flaky')
  if (out.verdict !== 'flaky') return
  assert.deepEqual(out.evidence, { match: 'STARTUP_FAILURE', source: 'conclusion' })
  assert.equal(out.why, 'Looks flaky: startup failure')
})

test('fix names the changed files the log mentions', () => {
  const out = classify(check, [run({ conclusion: 'success' })], ASSERT_LOG, FILES)
  assert.equal(out.verdict, 'fix')
  if (out.verdict !== 'fix') return
  assert.deepEqual(out.evidence.touched, ['src/retry.ts', 'src/retry.test.ts'])
  assert.equal(out.why, 'Fails in src/retry.ts, changed in this PR')
})

test('fix wording only claims main passed when it did', () => {
  assert.equal(classify(check, [run({ conclusion: 'success' })], '', []).why, 'Passes on main, fails here')
  assert.equal(classify(check, null, '', []).why, 'Fails on this PR')
  assert.equal(classify(check, [run({ conclusion: 'cancelled' })], '', []).why, 'Fails on this PR')
})

test('every row line is short and never says "AI"', () => {
  const outs = [
    classify(check, [run()], '', []),
    classify(check, null, 'x'.repeat(500) + ' ETIMEDOUT', []),
    classify(check, null, ASSERT_LOG, FILES),
    classify(check, null, '', []),
  ]
  for (const o of outs) {
    assert.ok(o.why.length <= 100, o.why)
    assert.doesNotMatch(o.why, /\bAI\b/)
  }
})

test('latestMainRun: ties and missing times keep the first', () => {
  const a = run({ url: 'a', completedAt: null })
  const b = run({ url: 'b', completedAt: null })
  assert.equal(latestMainRun('test', [a, b])?.url, 'a')
  assert.equal(latestMainRun('test', [a, run({ url: 'c' })])?.url, 'c')
  assert.equal(latestMainRun(' test ', [run({ name: 'test ' })])?.name, 'test ')
  assert.equal(latestMainRun('test', null), null)
})

test('flakyLine: null for a clean log, the first matching line otherwise', () => {
  assert.equal(flakyLine(''), null)
  assert.equal(flakyLine(ASSERT_LOG), null)
  assert.equal(flakyLine('ok\n  Error: 503 Service Unavailable  \nmore'), 'Error: 503 Service Unavailable')
  assert.ok((flakyLine('y'.repeat(400) + ' ECONNRESET') ?? '').length <= 200)
})

test('touchedFiles: whole paths only, deduped, capped', () => {
  assert.deepEqual(touchedFiles('at /home/runner/work/api/api/src/retry.ts:4', ['src/retry.ts', 'retry.ts']), ['src/retry.ts', 'retry.ts'])
  assert.deepEqual(touchedFiles('index.ts failed', ['src/index.ts']), [])
  assert.deepEqual(touchedFiles('./a.ts a.ts', ['./a.ts', 'a.ts']), ['a.ts'])
  const many = Array.from({ length: 9 }, (_, i) => `f${i}.ts`)
  assert.equal(touchedFiles(many.join(' '), many).length, 5)
  assert.deepEqual(touchedFiles('', ['a.ts']), [])
})
