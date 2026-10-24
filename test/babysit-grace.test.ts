/**
 * The grace period before the first fix (core/babysit/grace.ts): you push, CI
 * is red, and Junior waits `graceMinutes` before its fix, so you don't both
 * fix the same check. Junior's own push starts no window, and a PR you didn't
 * hand off gets no task at all. Fake clock throughout; the tick runs against
 * a real sqlite store and a fake GitHub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { ActionRecord } from '../core/actions/types.js'
import { BABYSIT_WATCH_KEY, babysitTickOp, type BabysitDeps, type BabysitWatchState } from '../server/babysit/watch.js'
import { decide, MAX_FIX_ATTEMPTS, newBabysitWatch, pollSoon, type BabysitEvent } from '../core/babysit/watch.js'
import { fixesShown, fixFraction, graceFor, graceShown, inGrace, juniorPushed, PUSH_SLACK_MS } from '../core/babysit/grace.js'
import { babysitSettingsFrom, DEFAULT_BABYSIT } from '../core/babysit/settings.js'
import { nextMove, type NextItem } from '../core/work/next.js'
import { moveKey, rowMove } from '../core/junior/row-move.js'
import type { PrCheck } from '../core/babysit/ci.js'

const T0 = Date.parse('2026-10-24T15:32:00Z')
const MIN = 60_000
const ID = 'github:acme/api#12'

// ---- pure ----

test('graceFor: a new head after an earlier one opens a window; the first poll and Junior’s push do not', () => {
  assert.deepEqual(graceFor(undefined, 'aaa', T0, 10, false), { headSeenAt: T0, graceUntil: null }, 'first poll: no earlier head, no window')
  assert.deepEqual(graceFor({ headSha: null }, 'aaa', T0, 10, false), { headSeenAt: T0, graceUntil: null })
  assert.deepEqual(graceFor({ headSha: 'aaa' }, 'bbb', T0, 10, false), { headSeenAt: T0, graceUntil: T0 + 10 * MIN })
  assert.deepEqual(graceFor({ headSha: 'aaa' }, 'bbb', T0, 10, true), { headSeenAt: T0, graceUntil: null }, 'Junior pushed it')
  assert.deepEqual(graceFor({ headSha: 'aaa' }, 'bbb', T0, 0, false), { headSeenAt: T0, graceUntil: null }, '0 = off')
  assert.deepEqual(graceFor({ headSha: 'aaa' }, 'bbb', T0, 500, false).graceUntil, T0 + 60 * MIN, 'capped at an hour')
  // same head: the window is kept, and its start too
  const kept = graceFor({ headSha: 'bbb', headSeenAt: T0, graceUntil: T0 + 10 * MIN }, 'bbb', T0 + 3 * MIN, 10, false)
  assert.deepEqual(kept, { headSeenAt: T0, graceUntil: T0 + 10 * MIN })
  // the push turned out to be Junior's after all: the window closes
  assert.equal(graceFor({ headSha: 'bbb', headSeenAt: T0, graceUntil: T0 + 10 * MIN }, 'bbb', T0 + MIN, 10, true).graceUntil, null)
  assert.ok(inGrace({ graceUntil: T0 + MIN }, T0))
  assert.ok(!inGrace({ graceUntil: T0 + MIN }, T0 + MIN))
  assert.ok(!inGrace({ graceUntil: null }, T0))
})

test('juniorPushed: a task that reported the sha, a task mid-run, or a push on the item just before', () => {
  const base = { tasks: [], pushes: [], headSeenAt: T0 }
  assert.ok(!juniorPushed('abcdef1234', base))
  assert.ok(juniorPushed('abcdef1234', { ...base, tasks: [{ owner: 'junior', state: 'done', output: { sha: 'abcdef1' } }] }), 'a short sha names the same commit')
  assert.ok(!juniorPushed('abcdef1234', { ...base, tasks: [{ owner: 'junior', state: 'done', output: { sha: '9999999' } }] }))
  assert.ok(juniorPushed('abcdef1234', { ...base, tasks: [{ owner: 'junior', state: 'running' }] }))
  assert.ok(!juniorPushed('abcdef1234', { ...base, tasks: [{ owner: 'you', state: 'running' }] }))
  assert.ok(juniorPushed('abcdef1234', { ...base, pushes: [{ attemptedAt: T0 - 2 * MIN }] }))
  assert.ok(!juniorPushed('abcdef1234', { ...base, pushes: [{ attemptedAt: T0 - PUSH_SLACK_MS - 1 }] }), 'an old push made an older head')
})

const check = (name: string, over: Partial<PrCheck> = {}): PrCheck => ({ name, status: 'failure', id: `${name}-1`, runId: 77, url: null, conclusion: 'FAILURE', ...over })
const ctx = { base: 'main', isDraft: false, reviewer: null }

test('decide: inside the window a fix waits; a flake is still rerun; after it, the fix', () => {
  const ev: BabysitEvent = { kind: 'checks_failed', sha: 'bbb', check: check('lint') }
  const until = T0 + 10 * MIN
  assert.deepEqual(decide(ev, newBabysitWatch(), { ...ctx, graceUntil: until, now: T0 }), { do: 'wait', until })
  assert.equal(decide(ev, newBabysitWatch(), { ...ctx, graceUntil: until, now: until }).do, 'task')
  assert.equal(decide(ev, newBabysitWatch(), { ...ctx, graceUntil: null, now: T0 }).do, 'task')
  assert.equal(decide(ev, newBabysitWatch(), { ...ctx, graceUntil: until, now: T0, log: 'Error: read ECONNRESET' }).do, 'rerun')
  // a stuck check waits too: you may be fixing it right now
  assert.equal(decide(ev, { ...newBabysitWatch(), fixes: { lint: MAX_FIX_ATTEMPTS } }, { ...ctx, graceUntil: until, now: T0 }).do, 'wait')
  assert.ok(pollSoon([], false, false, true), 'a held fix keeps the pace fast')
})

test('fixesShown: the most on any red check, stuck ones left to their task', () => {
  assert.equal(fixesShown({}, ['lint']), null)
  assert.equal(fixesShown({ lint: 2, test: 1 }, ['lint', 'test']), 2)
  assert.equal(fixesShown({ lint: 2, test: 1 }, ['test']), 1, 'lint is green now')
  assert.equal(fixesShown({ lint: 3, test: 1 }, ['lint', 'test'], ['lint']), 1)
  assert.equal(fixesShown({ lint: 3 }, ['lint'], ['lint']), null)
  assert.equal(fixFraction(2), `fix 2 of ${MAX_FIX_ATTEMPTS}`)
  assert.deepEqual(graceShown({ graceUntil: T0 + MIN, fixes: 2 }, T0), { graceUntil: T0 + MIN }, 'grace and the fraction never together')
  assert.deepEqual(graceShown({ graceUntil: T0 + MIN, fixes: 2 }, T0 + MIN), { fixes: 2 })
  assert.equal(graceShown({}, T0), null)
})

test('settings: graceMinutes defaults to 10, 0 to 60 whole minutes', () => {
  assert.equal(DEFAULT_BABYSIT.graceMinutes, 10)
  assert.equal(babysitSettingsFrom({ graceMinutes: 0 }).graceMinutes, 0)
  assert.equal(babysitSettingsFrom({ graceMinutes: 25 }).graceMinutes, 25)
  for (const bad of [-1, 61, 2.5, '5', null]) assert.equal(babysitSettingsFrom({ graceMinutes: bad }).graceMinutes, 10)
})

// ---- the row ----

const prItem = (seen: NextItem['seen']): NextItem & { id: string; updatedAt: string } => ({
  id: ID,
  kind: 'own-pr-open',
  source: 'github',
  peopleWaiting: 0,
  author: 'samar',
  handoff: 'on',
  ciFailing: true,
  updatedAt: new Date(T0).toISOString(),
  ...(seen ? { seen } : {}),
})
const seenBase = { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false }

test('the row: "you just pushed · fix after …" in the window, "fix n of 3" after', () => {
  const g = nextMove(prItem({ ...seenBase, graceUntil: T0 + 10 * MIN }), {}, T0)
  assert.equal(g.verb, 'Fix red CI')
  assert.deepEqual(g.reasons.slice(0, 2), ['with Junior', 'you just pushed'])
  assert.match(g.reasons[2]!, /^fix after \S/)
  assert.ok(!g.reasons.some((r) => r.startsWith('fix ') && r.includes(' of ')))
  // the window passed: no grace text, even if a stale snapshot still carries it
  const over = nextMove(prItem({ ...seenBase, graceUntil: T0 + 10 * MIN }), {}, T0 + 11 * MIN)
  assert.ok(!over.reasons.includes('you just pushed'))
  const f = nextMove(prItem({ ...seenBase, fixes: 2 }), {}, T0)
  assert.ok(f.reasons.includes(`fix 2 of ${MAX_FIX_ATTEMPTS}`))
  // not handed off: neither
  const off = nextMove({ ...prItem({ ...seenBase, fixes: 2, graceUntil: T0 + MIN }), handoff: undefined }, {}, T0)
  assert.ok(!off.reasons.some((r) => r === 'you just pushed' || r.startsWith('fix 2')))
  // a served line with the window in it is made again once the window passes
  const item = prItem({ ...seenBase, graceUntil: T0 + 10 * MIN })
  const served = { action: g.action, verb: g.verb, reasons: g.reasons, text: g.text, key: moveKey(item) }
  assert.ok(rowMove(item, served, T0)?.reasons.includes('you just pushed'))
  const line = rowMove(item, served, T0 + 11 * MIN)
  assert.ok(line && !line.reasons.includes('you just pushed'))
})

// ---- the tick, end to end ----

type Check = { name: string; conclusion: string; id: number }
const prNode = (sha: string, checks: Check[]) => ({
  __typename: 'PullRequest', number: 12, title: 'PR 12', url: 'https://github.com/acme/api/pull/12', isDraft: false,
  createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T11:00:00Z', state: 'OPEN',
  repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } }, author: { login: 'samar' },
  headRefOid: sha, headRefName: 'feat/12', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [] }, reviews: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: checks.map((c) => ({ __typename: 'CheckRun', databaseId: c.id, name: c.name, status: 'COMPLETED', conclusion: c.conclusion, detailsUrl: null, checkSuite: { workflowRun: { databaseId: 500 + c.id } } })) } } } }] },
  reviewThreads: { nodes: [] },
})
const GREEN = [{ name: 'lint', conclusion: 'SUCCESS', id: 1 }]
const RED = [{ name: 'lint', conclusion: 'FAILURE', id: 1 }]

type H = { store: Store; deps: BabysitDeps; head: { node: unknown }; reruns: string[]; logs: Record<string, string> }

async function harness(fn: (h: H) => Promise<void>, handOff = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-grace-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const head: { node: unknown } = { node: null }
  const reruns: string[] = []
  const logs: Record<string, string> = {}
  const deps: BabysitDeps = {
    store,
    source: {
      login: async () => 'samar',
      search: async () => ({ data: { prs: { nodes: head.node ? [head.node] : [] } } }),
      failedLog: async (_repo, c) => logs[c.name] ?? 'src/a.ts:1 error no-unused-vars',
      rerun: async (_repo, c) => void reruns.push(c.name),
      mainRuns: async () => [],
    },
    repos: async () => ['acme/api'],
    upsertItem: async (item) => {
      await store.items.upsert(item)
      if (handOff && !(await store.items.get(item.id))?.handoff) await store.items.setFields(item.id, { handoff: 'on' })
    },
    reviewerFor: async () => null,
    graceMinutes: async () => 10,
    added: () => {},
    log: () => {},
  }
  try {
    await fn({ store, deps, head, reruns, logs })
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const fixTasks = async (store: Store) => (await store.tasks.list(ID)).filter((t) => t.step === 'fix-ci')
const watchOf = async (store: Store) => (await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.prs[ID]

test('your push: no fix inside the window, the fix on the first poll after it', () =>
  harness(async ({ store, deps, head }) => {
    head.node = prNode('aaa', GREEN)
    await babysitTickOp(deps, T0 - 5 * MIN, true)
    // you push at T0; CI is red on the new head
    head.node = prNode('bbb', RED)
    for (const at of [T0, T0 + 3 * MIN, T0 + 9 * MIN]) {
      const r = await babysitTickOp(deps, at, true)
      assert.equal(r?.added, 0, `no task at +${(at - T0) / MIN}m`)
    }
    assert.equal((await fixTasks(store)).length, 0)
    const w = await watchOf(store)
    assert.equal(w?.graceUntil, T0 + 10 * MIN)
    assert.equal(w?.seen?.graceUntil, T0 + 10 * MIN, 'the row reads the window')
    assert.equal(w?.seen?.fixes, undefined)
    assert.equal((await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.nextPollAt, T0 + 10 * MIN, 'the pace stays fast')
    // still red after it: the fix
    const r = await babysitTickOp(deps, T0 + 10 * MIN, true)
    assert.equal(r?.added, 1)
    const [t] = await fixTasks(store)
    assert.deepEqual([t?.key, t?.input?.attempt], ['ci:bbb:lint', 1])
    const after = await watchOf(store)
    assert.equal(after?.seen?.graceUntil, undefined)
    assert.equal(after?.seen?.fixes, 1, 'fix 1 of 3 on the row')
  }))

test('green inside the window: nothing added; another push: a new window', () =>
  harness(async ({ store, deps, head }) => {
    head.node = prNode('aaa', GREEN)
    await babysitTickOp(deps, T0 - 5 * MIN, true)
    head.node = prNode('bbb', RED)
    await babysitTickOp(deps, T0, true)
    head.node = prNode('bbb', GREEN)
    await babysitTickOp(deps, T0 + 4 * MIN, true)
    assert.equal((await watchOf(store))?.seen?.graceUntil, undefined, 'green: the grace text goes')
    head.node = prNode('ccc', RED)
    await babysitTickOp(deps, T0 + 12 * MIN, true)
    await babysitTickOp(deps, T0 + 20 * MIN, true)
    assert.equal((await fixTasks(store)).length, 0)
    assert.equal((await watchOf(store))?.graceUntil, T0 + 22 * MIN)
  }))

const pushRecord = (at: number): ActionRecord => ({
  id: `s1:tu-${at}`, sessionId: 's1', sessionKind: 'chat', tool: 'Bash', kind: 'push', summary: 'git push origin feat/12', args: { command: 'git push origin feat/12' },
  status: 'succeeded', link: null, error: null, why: 'bash pattern', whyDetail: null, allowedBy: 'policy', allowedDetail: null, jobId: null, teamRunId: null,
  itemId: ID, groupKey: null, count: 1, calls: [`tu-${at}`], attemptedAt: at, settledAt: at, updatedAt: at,
})

test('a push in Junior’s action log starts no window: the fix comes at once', () =>
  harness(async ({ store, deps, head }) => {
    head.node = prNode('aaa', GREEN)
    await babysitTickOp(deps, T0 - 5 * MIN, true)
    await store.actions.put(pushRecord(T0 - MIN))
    head.node = prNode('bbb', RED)
    const r = await babysitTickOp(deps, T0, true)
    assert.equal(r?.added, 1)
    assert.equal((await watchOf(store))?.graceUntil, null)
  }))

test('a head a task of Junior’s reported starts no window', () =>
  harness(async ({ store, deps, head }) => {
    head.node = prNode('aaa', RED)
    await babysitTickOp(deps, T0 - 30 * MIN, true)
    const [t] = await fixTasks(store)
    await store.tasks.move(t!.id, 'running', {}, T0 - 20 * MIN)
    await store.tasks.move(t!.id, 'done', { output: { summary: 'fixed lint', sha: 'bbb1234' } }, T0 - 10 * MIN)
    head.node = prNode('bbb1234def', RED)
    const r = await babysitTickOp(deps, T0, true)
    assert.equal(r?.added, 1)
    assert.equal((await fixTasks(store))[1]?.input?.attempt, 2)
    assert.equal((await watchOf(store))?.seen?.fixes, 2)
  }))

test('a flake is still rerun inside the window, its log read once', () =>
  harness(async ({ deps, head, reruns, logs }) => {
    logs.lint = 'Error: read ECONNRESET'
    head.node = prNode('aaa', GREEN)
    await babysitTickOp(deps, T0 - 5 * MIN, true)
    head.node = prNode('bbb', RED)
    const r = await babysitTickOp(deps, T0, true)
    assert.deepEqual([r?.added, r?.reruns], [0, 1])
    assert.deepEqual(reruns, ['lint'])
  }))

test('a PR you did not hand off gets no task, and no grace or fraction on its row', () =>
  harness(async ({ store, deps, head }) => {
    head.node = prNode('aaa', GREEN)
    await babysitTickOp(deps, T0 - 5 * MIN, true)
    head.node = prNode('bbb', RED)
    for (const at of [T0, T0 + 11 * MIN]) await babysitTickOp(deps, at, true)
    assert.equal((await store.tasks.list(ID)).length, 0)
    const w = await watchOf(store)
    assert.equal(w?.seen?.graceUntil, undefined)
    assert.equal(w?.seen?.fixes, undefined)
  }, false))
