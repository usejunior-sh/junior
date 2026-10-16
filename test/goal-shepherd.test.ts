/**
 * M5: the PR shepherd (core/goals/shepherd.ts + goalWatchPrsOp in
 * server/goals.ts). Every default policy is fed a fake watcher event and must
 * pick its step; the caps (three fixes, a bot comment that comes back) must
 * reach the user. Then the watcher runs end to end over a real store with a
 * fake PR source the test rewrites between polls.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { GoalLedger } from '../core/goals/ledger.js'
import { budgetCheck } from '../core/goals/run.js'
import { planFrom } from '../core/goals/plan.js'
import {
  afterDecision,
  assess,
  DEFAULT_POLICIES,
  fingerprint,
  newWatch,
  nextPoll,
  policyFor,
  pollDelay,
  prRefFrom,
  SHEPHERD_GATE,
  snapshotFrom,
  WATCH_POLL_TAIL_MIN,
  type PolicyDecision,
  type PolicyId,
  type PrCheck,
  type PrRef,
  type PrSnapshot,
  type PrThread,
  type PrWatch,
  type WatcherEvent,
} from '../core/goals/shepherd.js'
import { MAX_FIX_ATTEMPTS, type Goal } from '../core/goals/types.js'
import {
  goalAnswerOp,
  goalApproveOp,
  goalArmGateOp,
  goalCreateOp,
  goalDispatchWorkerOp,
  goalHandoffWriteOp,
  goalLeadSettledOp,
  goalLeadStartedOp,
  goalLogAppendOp,
  goalProposePlanOp,
  goalPumpIdle,
  goalSessionEndedOp,
  goalWatchPrsOp,
  onGoalEvent,
  pumpGoals,
  type GoalDeps,
  type GoalEngine,
  type PrSource,
  type StartSpec,
} from '../server/goals.js'

const MIN = 60_000
const PR: PrRef = { repo: 'acme/app', number: 12 }

const check = (extra: Partial<PrCheck> = {}): PrCheck => ({ name: 'test', status: 'failure', id: '1', runId: 100, url: 'https://ci/1', conclusion: 'FAILURE', ...extra })
const thread = (extra: Partial<PrThread> = {}): PrThread => ({ id: 'PRRT_aaa111', author: 'coderabbitai[bot]', isBot: true, resolved: false, path: 'src/a.ts', body: 'Possible null deref on line 42', url: null, ...extra })
const snap = (extra: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: PR.repo,
  number: PR.number,
  url: 'https://github.com/acme/app/pull/12',
  state: 'OPEN',
  headSha: 'aaaaaaa1',
  baseRef: 'main',
  headRef: 'goal/fix-abc123',
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  checks: [],
  threads: [],
  closedBy: null,
  ...extra,
})

// ---------------------------------------------------------------------------
// Pure: every default policy, from a fake event
// ---------------------------------------------------------------------------

/** One row per policy in the table: the event the watcher would see, the watch it sees it with, and what must come out. */
const ROWS: { policy: PolicyId; ev: WatcherEvent; watch?: Partial<PrWatch>; log?: string; want: Partial<PolicyDecision> & { do: PolicyDecision['do'] } }[] = [
  { policy: 'push', ev: { kind: 'pushed', key: 'push:b', sha: 'bbbbbbb2', from: 'aaaaaaa1' }, want: { do: 'note' } },
  { policy: 'checks_failed', ev: { kind: 'checks_failed', key: 'k', sha: 'aaaaaaa1', check: check() }, log: 'AssertionError: expected 2, got 3', want: { do: 'step', step: 'fix_ci', stepId: 'pr-ci-test' } },
  { policy: 'bot_thread', ev: { kind: 'bot_thread', key: 'k', thread: thread() }, want: { do: 'step', step: 'fix_thread' } },
  { policy: 'human_thread', ev: { kind: 'human_thread', key: 'k', thread: thread({ author: 'samar', isBot: false }) }, want: { do: 'step', step: 'fix_thread' } },
  { policy: 'bot_repeat', ev: { kind: 'bot_thread', key: 'k', thread: thread({ id: 'PRRT_bbb222', body: 'Possible null deref on line 57' }) }, watch: { botPrints: [fingerprint(thread())] }, want: { do: 'ask_user' } },
  { policy: 'conflict', ev: { kind: 'conflict', key: 'k', sha: 'aaaaaaa1' }, want: { do: 'step', step: 'rebase', stepId: 'pr-rebase' } },
  { policy: 'ready', ev: { kind: 'ready', key: 'k', sha: 'aaaaaaa1' }, want: { do: 'step', step: 'merge', stepId: 'pr-merge' } },
  { policy: 'closed', ev: { kind: 'closed', key: 'k', by: 'someone' }, want: { do: 'ask_user' } },
]

test('every default policy maps its watcher event to its step', () => {
  for (const row of ROWS) {
    const w = { ...newWatch('g', 0), ...row.watch }
    const d = policyFor(row.ev, w, PR, row.log)
    assert.equal(d.policy, row.policy, row.policy)
    for (const [k, v] of Object.entries(row.want)) assert.equal((d as Record<string, unknown>)[k], v, `${row.policy}.${k}`)
  }
  // The budget row is the scheduler's (budgetCheck), not the watcher's: tell at 80%, stop at 100%.
  assert.equal(budgetCheck({ budget: { usd: 10, minutes: null }, spentUsd: 8 }, 0, false).kind, 'warn')
  assert.equal(budgetCheck({ budget: { usd: 10, minutes: null }, spentUsd: 10 }, 0, true).kind, 'stop')
  const covered = new Set<PolicyId>([...ROWS.map((r) => r.policy), 'budget'])
  assert.deepEqual(
    DEFAULT_POLICIES.map((p) => p.id).filter((id) => !covered.has(id)),
    [],
    'a policy in the table with no test row',
  )
  assert.deepEqual(policyFor({ kind: 'merged', key: 'merged' }, newWatch('g', 0), PR), { do: 'resolve', policy: null, text: 'acme/app#12 is merged' })
})

test('the caps: a check fixed three times, and a bot comment that comes back, go to the user', () => {
  let w = newWatch('g', 0)
  for (let i = 1; i <= MAX_FIX_ATTEMPTS; i++) {
    const ev: WatcherEvent = { kind: 'checks_failed', key: `fail:${i}`, sha: `sha${i}`, check: check({ id: String(i) }) }
    const d = policyFor(ev, w, PR, 'AssertionError')
    assert.equal(d.do, 'step', `fix ${i}`)
    if (d.do === 'step') assert.match(d.text, new RegExp(`fix ${i} of ${MAX_FIX_ATTEMPTS}`))
    w = afterDecision(w, ev, d)
  }
  assert.equal(w.fixes.test, MAX_FIX_ATTEMPTS)
  const fourth = policyFor({ kind: 'checks_failed', key: 'fail:4', sha: 'sha4', check: check({ id: '4' }) }, w, PR, 'AssertionError')
  assert.equal(fourth.do, 'ask_user')
  if (fourth.do === 'ask_user') {
    assert.match(fourth.question, /still fails .* after 3 fixes/)
    assert.match(fourth.evidence ?? '', /AssertionError/)
  }
  assert.equal(policyFor({ kind: 'checks_failed', key: 'x', sha: 's', check: check({ name: 'lint' }) }, w, PR).do, 'step', 'the cap is per check')

  // A bot finding fixed once; the same finding (a different line number) comes back on a new thread.
  const first: WatcherEvent = { kind: 'bot_thread', key: 'thread:1', thread: thread() }
  const w2 = afterDecision(newWatch('g', 0), first, policyFor(first, newWatch('g', 0), PR))
  const again = policyFor({ kind: 'bot_thread', key: 'thread:2', thread: thread({ id: 'PRRT_zzz', body: 'Possible  null deref on line 99' }) }, w2, PR)
  assert.equal(again.do, 'ask_user')
  assert.equal(again.policy, 'bot_repeat')
  assert.equal(policyFor({ kind: 'bot_thread', key: 'thread:3', thread: thread({ id: 'PRRT_y', body: 'Unused import' }) }, w2, PR).do, 'step', 'a different finding is fixed')
})

test('a flaky-looking failure is rerun once per head commit, then fixed', () => {
  const ev: WatcherEvent = { kind: 'checks_failed', key: 'k1', sha: 'aaa', check: check() }
  const d = policyFor(ev, newWatch('g', 0), PR, 'Error: connect ETIMEDOUT 10.0.0.1:443')
  assert.equal(d.do, 'rerun')
  const w = afterDecision(newWatch('g', 0), ev, d)
  assert.deepEqual(w.reruns, ['test@aaa'])
  assert.equal(w.fixes.test, undefined, 'a rerun is not a fix')
  assert.equal(policyFor({ ...ev, key: 'k2', check: check({ id: '2' }) }, w, PR, 'ETIMEDOUT').do, 'step', 'still failing after the rerun: fix it')
  assert.equal(policyFor({ ...ev, check: check({ conclusion: 'TIMED_OUT' }) }, newWatch('g', 0), PR).do, 'rerun', "GitHub's own timed out counts")
  assert.equal(policyFor({ ...ev, check: check({ runId: null }) }, newWatch('g', 0), PR, 'ETIMEDOUT').do, 'step', 'a status context has no run to rerun')
  assert.equal(policyFor(ev, newWatch('g', 0), PR, 'AssertionError: expected 2').do, 'step')
})

test('assess: each thing on the PR once, in order; merged and closed stand alone', () => {
  const s = snap({
    checks: [check(), check({ name: 'lint', status: 'success', id: '9' }), check({ name: 'e2e', status: 'pending', id: '8' })],
    threads: [thread(), thread({ id: 'PRRT_h', author: 'samar', isBot: false }), thread({ id: 'PRRT_done', resolved: true })],
    mergeable: 'CONFLICTING',
  })
  const evs = assess(s, newWatch('g', 0))
  assert.deepEqual(
    evs.map((e) => e.kind),
    ['pushed', 'checks_failed', 'bot_thread', 'human_thread', 'conflict'],
  )
  let w = newWatch('g', 0)
  for (const e of evs) w = afterDecision(w, e, policyFor(e, w, PR))
  assert.deepEqual(assess(s, { ...w, headSha: s.headSha }), [], 'nothing new on the next poll')
  assert.equal(assess({ ...s, checks: [check({ id: '2' })] }, { ...w, headSha: s.headSha })[0]?.kind, 'checks_failed', 'a rerun that fails again is new')

  const green = snap({ checks: [check({ status: 'success' })], reviewDecision: 'APPROVED' })
  assert.deepEqual(assess(green, { seen: [], headSha: green.headSha }).map((e) => e.kind), ['ready'])
  assert.deepEqual(assess({ ...green, reviewDecision: 'REVIEW_REQUIRED' }, { seen: [], headSha: green.headSha }), [], 'not approved: not ready')
  assert.deepEqual(assess(snap({ state: 'MERGED', threads: [thread()] }), newWatch('g', 0)).map((e) => e.kind), ['merged'])
  assert.deepEqual(assess(snap({ state: 'CLOSED', closedBy: 'x' }), newWatch('g', 0)).map((e) => e.kind), ['closed'])
})

test('the back-off: fast after something happened, one step slower per quiet poll, then every 15 minutes', () => {
  let w = newWatch('g', 0)
  const gaps: number[] = []
  for (let i = 0; i < 10; i++) {
    w = nextPoll(w, false, 0)
    gaps.push(w.nextPollAt / MIN)
  }
  assert.deepEqual(gaps, [1, 2, 2, 5, 5, 10, 10, 15, 15, 15])
  assert.equal(nextPoll(w, true, 100).nextPollAt, 100 + MIN, 'something happened: back to a minute')
  assert.equal(pollDelay(99), WATCH_POLL_TAIL_MIN * MIN)
})

test('prRefFrom and snapshotFrom read what gh hands back', () => {
  assert.deepEqual(prRefFrom(['https://github.com/acme/app/pull/12'], null), PR)
  assert.deepEqual(prRefFrom(['github:acme/app#12'], null), PR)
  assert.deepEqual(prRefFrom(['acme/app#12'], null), PR)
  assert.deepEqual(prRefFrom(['#12'], 'acme/app'), PR)
  assert.equal(prRefFrom(['#12'], null), null, 'a bare number needs the repo')
  assert.equal(prRefFrom(['LIN-12'], 'acme/app'), null)

  const s = snapshotFrom(PR, {
    data: {
      repository: {
        pullRequest: {
          url: 'u',
          state: 'OPEN',
          headRefOid: 'abc',
          headRefName: 'h',
          baseRefName: 'main',
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          timelineItems: { nodes: [] },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        { __typename: 'CheckRun', databaseId: 5, name: 'test', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'd', checkSuite: { workflowRun: { databaseId: 77 } } },
                        { __typename: 'CheckRun', databaseId: 6, name: 'lint', status: 'IN_PROGRESS', conclusion: null, checkSuite: null },
                        { __typename: 'StatusContext', id: 'S', context: 'vercel', state: 'SUCCESS', targetUrl: null, createdAt: 't' },
                      ],
                    },
                  },
                },
              },
            ],
          },
          reviewThreads: { nodes: [{ id: 'T', isResolved: false, path: 'a.ts', comments: { nodes: [{ url: 'c', body: 'b', author: { __typename: 'Bot', login: 'coderabbitai' } }] } }] },
        },
      },
    },
  })
  assert.deepEqual(
    s.checks.map((c) => [c.name, c.status, c.runId]),
    [
      ['test', 'failure', 77],
      ['lint', 'pending', null],
      ['vercel', 'success', null],
    ],
  )
  assert.equal(s.threads[0]!.isBot, true)
  assert.throws(() => snapshotFrom(PR, { data: { repository: { pullRequest: null } } }), /not found/)
})

const PLAN = {
  summary: 'Fix it, open the PR, shepherd it to merged.',
  doneWhen: 'the fix is merged',
  steps: [
    { id: 's1', title: 'Fix and open the PR', type: 'agent', role: 'builder', doneWhen: 'the PR is open' },
    { id: 's2', title: 'Shepherd the PR', type: 'block', block: 'shepherd-pr', dependsOn: ['s1'], doneWhen: 'the PR is merged' },
  ],
}

test('a shepherd-pr block expands into a watcher gate, and the plan carries the policies', () => {
  const r = planFrom(PLAN, { title: 'Fix', doneWhen: 'merged', budget: { usd: null, minutes: null } } as Goal)
  assert.ok(r.ok, r.ok ? '' : r.error)
  if (!r.ok) return
  const s2 = r.plan.steps[1]!
  assert.equal(s2.type, 'gate')
  assert.equal(s2.block, null)
  assert.deepEqual(s2.gate, SHEPHERD_GATE)
  assert.equal(r.plan.policies.length, DEFAULT_POLICIES.length)
  const bad = planFrom({ ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[1], block: 'deploy' }] }, { title: 'Fix', doneWhen: 'merged', budget: { usd: null, minutes: null } } as Goal)
  assert.ok(!bad.ok && /isn't a workflow block/.test(bad.error))
})

// ---------------------------------------------------------------------------
// End to end: the watcher over a real store, a fake PR
// ---------------------------------------------------------------------------

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-shepherd-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

type Started = { goalId: string; sessionId: string; spec: StartSpec }

function harness(dir: string) {
  const store = openSqliteStore(path.join(dir, 'triage.db'))
  const root = path.join(dir, 'artifacts')
  execFileSync('mkdir', ['-p', root])
  execFileSync('git', ['init', '-q'], { cwd: root })
  let clock = 1_000_000
  const started: Started[] = []
  const pending: Promise<void>[] = []
  let n = 0
  const eng: GoalEngine = {
    wakeLead: async () => {},
    stepsQueued: () => void pending.push(pumpGoals(d, eng)),
    startSession: async (goal, spec, ok) => {
      const sessionId = `${spec.role}-${++n}`
      started.push({ goalId: goal.id, sessionId, spec })
      await ok(sessionId)
    },
  }
  const d: GoalDeps = {
    store,
    ledger: new GoalLedger(root, () => clock),
    now: () => clock,
    defaultProjectId: async () => null,
    changed: () => {},
    emit: (ev) => void pending.push(onGoalEvent(d, eng, ev)),
    itemFor: async () => 'manual:goal-item',
  }
  const pr = { now: snap(), log: '', reruns: [] as string[], polls: 0 }
  const src: PrSource = {
    find: async (_goal, gate) => prRefFrom(gate.refs, null),
    snapshot: async () => {
      pr.polls++
      return pr.now
    },
    failedLog: async () => pr.log,
    diff: async () => 'diff --git a/src/a.ts b/src/a.ts',
    rerun: async (_pr, c) => void pr.reruns.push(c.name),
  }
  const settle = async () => {
    while (pending.length) await pending.shift()
    await goalPumpIdle(d)
  }
  const h = {
    d,
    eng,
    store,
    started,
    settle,
    pr,
    advance: (ms: number) => void (clock += ms),
    last: () => started.at(-1)!,
    watch: async () => {
      const r = await goalWatchPrsOp(d, eng, src)
      await settle()
      return r
    },
    /** the current session ends: a worker logs its step done first */
    end: async (goalId: string) => {
      const s = h.last()
      if (s.spec.role !== 'lead') {
        await goalHandoffWriteOp(d, { goalId, sessionId: s.sessionId, done: 'pushed a fix', next: 'watch CI' })
        await goalLogAppendOp(d, { goalId, sessionId: s.sessionId, stepId: s.spec.stepId, role: s.spec.role, outcome: 'done', text: 'pushed' })
      }
      await goalSessionEndedOp(d, eng, { goalId, sessionId: s.sessionId })
      await settle()
    },
  }
  return h
}
type H = ReturnType<typeof harness>

/** A goal whose lead has armed the shepherd gate on acme/app#12: waiting on the world. */
async function onThePr(h: H): Promise<Goal> {
  const { goal } = await goalCreateOp(h.d, { title: 'Land the fix', doneWhen: 'the fix is merged' })
  await h.settle()
  const created = (await h.store.goals.events(goal.id)).find((e) => e.kind === 'created')!
  await goalLeadStartedOp(h.d, goal.id, 'draft-1')
  await goalProposePlanOp(h.d, { goalId: goal.id, plan: PLAN, sessionId: 'draft-1' })
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: created.seq, sessionId: 'draft-1' })
  await goalApproveOp(h.d, { goalId: goal.id })
  await h.settle()
  await goalDispatchWorkerOp(h.d, { goalId: goal.id, sessionId: h.last().sessionId }, { stepId: 's1', brief: 'fix it and open the PR' })
  await h.end(goal.id) // lead
  await h.end(goal.id) // s1's worker
  const lead = h.last()
  assert.equal(lead.spec.role, 'lead')
  assert.match(await goalArmGateOp(h.d, { goalId: goal.id, sessionId: lead.sessionId }, { stepId: 's2', refs: ['acme/app#12'] }), /PR watcher/)
  await h.end(goal.id)
  return (await h.store.goals.get(goal.id))!
}

const stateOf = async (h: H, id: string) => (await h.store.goals.get(id))!.state
const gateOf = async (h: H, id: string) => (await h.store.goals.gates(id))[0]!
const stepOf = async (h: H, id: string, stepId: string) => (await h.store.goals.steps(id)).find((s) => s.stepId === stepId)

test(
  'a failing check becomes a fix step a builder runs with the log; after three fixes the user is asked; merged meets the gate',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onThePr(h)
    assert.equal(g.state, 'waiting_world')
    const gt = await gateOf(h, g.id)
    assert.equal(gt.evaluator, 'watcher')
    assert.equal(gt.nextCheckAt, null, 'the AI sweep never checks it')
    assert.equal(gt.confirmationsNeeded, 1)

    for (let i = 1; i <= MAX_FIX_ATTEMPTS; i++) {
      h.pr.now = snap({ headSha: `sha${i}`, checks: [check({ id: String(i) })] })
      h.pr.log = `AssertionError: expected 2, got 3 (run ${i})`
      const before = h.started.length
      const r = await h.watch()
      assert.equal(r.polled, 1, `poll ${i}`)
      const worker = h.last()
      assert.equal(h.started.length, before + 1, `fix ${i}: a worker started`)
      assert.equal(worker.spec.role, 'builder')
      if (worker.spec.role === 'builder') {
        assert.equal(worker.spec.stepId, 'pr-ci-test')
        assert.equal(worker.spec.attempt, i)
        assert.match(worker.spec.context, /CI check "test" fails on PR acme\/app#12/)
        assert.match(worker.spec.context, new RegExp(`run ${i}`), 'the failing log is in the brief')
        assert.match(worker.spec.context, /diff --git/, 'and the diff')
      }
      const plan = (await h.store.goals.get(g.id))!.plan!
      assert.deepEqual(plan.steps.map((s) => s.id), ['s1', 'pr-ci-test', 's2'], 'the fix step sits before the gate')
      await h.end(g.id) // the fix
      await h.end(g.id) // the lead, woken by step_finished
      assert.equal(await stateOf(h, g.id), 'waiting_world', 'back on the PR')
      assert.equal((await stepOf(h, g.id, 'pr-ci-test'))!.status, 'done')
      h.advance(MIN)
      assert.deepEqual(await h.watch(), { polled: 1, acted: 0, toUser: 0 }, 'the same failure is not fixed twice')
      h.advance(2 * MIN)
    }

    h.pr.now = snap({ headSha: 'sha4', checks: [check({ id: '4' })] })
    const before = h.started.length
    const r = await h.watch()
    assert.equal(r.toUser, 1)
    assert.equal(h.started.length, before, 'no fourth fix')
    assert.equal(await stateOf(h, g.id), 'waiting_you')
    const ask = (await h.store.goals.events(g.id)).filter((e) => e.kind === 'asked_you').at(-1)!
    assert.equal(ask.actor, 'watcher')
    assert.match(String(ask.detail?.question), /still fails on acme\/app#12 after 3 fixes/)

    await goalAnswerOp(h.d, h.eng, { goalId: g.id, text: 'I fixed the flake on main; keep going' })
    await h.settle()
    await h.end(g.id) // the lead, with the answer
    assert.equal(await stateOf(h, g.id), 'waiting_world')

    h.advance(15 * MIN)
    h.pr.now = snap({ headSha: 'sha5', state: 'MERGED' })
    await h.watch()
    assert.equal((await gateOf(h, g.id)).status, 'met')
    assert.equal((await stepOf(h, g.id, 's2'))!.status, 'done')
    const resolved = (await h.store.goals.events(g.id)).find((e) => e.kind === 'gate_resolved')!
    assert.equal(resolved.actor, 'watcher')
    assert.equal(h.last().spec.role, 'lead', 'the lead wakes to close out')
  }),
)

test(
  'the watcher polls on its back-off; a flaky check is rerun before anyone is woken',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onThePr(h)
    h.pr.now = snap({ checks: [check({ status: 'pending' })] })
    assert.equal((await h.watch()).polled, 1)
    assert.equal(h.pr.polls, 1)
    assert.equal((await h.watch()).polled, 0, 'not due yet')
    assert.equal(h.pr.polls, 1, 'nothing due: no gh call')

    h.advance(MIN)
    h.pr.now = snap({ checks: [check()] })
    h.pr.log = 'Error: connect ETIMEDOUT 140.82.112.3:443'
    const before = h.started.length
    assert.deepEqual(await h.watch(), { polled: 1, acted: 1, toUser: 0 })
    assert.deepEqual(h.pr.reruns, ['test'])
    assert.equal(h.started.length, before, 'a rerun wakes nobody')
    assert.equal(await stateOf(h, g.id), 'waiting_world')

    h.advance(MIN)
    h.pr.now = snap({ checks: [check({ id: '2' })] })
    await h.watch()
    assert.deepEqual(h.pr.reruns, ['test'], 'one rerun per head commit')
    assert.equal(h.last().spec.role, 'builder', 'failed again: a fix')
  }),
)

test(
  'a bot thread is fixed once; the same comment back on a new thread goes to the user',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onThePr(h)
    h.pr.now = snap({ checks: [check({ status: 'success' })], threads: [thread()] })
    await h.watch()
    const w = h.last()
    assert.equal(w.spec.role, 'builder')
    if (w.spec.role === 'builder') {
      assert.match(w.spec.stepId, /^pr-thread-/)
      assert.match(w.spec.context, /Possible null deref/)
      assert.match(w.spec.context, /resolveReviewThread/)
    }
    await h.end(g.id)
    await h.end(g.id)
    h.advance(MIN)
    h.pr.now = snap({ headSha: 'bbbbbbb2', checks: [check({ status: 'success', id: '2' })], threads: [thread({ resolved: true }), thread({ id: 'PRRT_ccc333', body: 'Possible null deref on line 61' })] })
    const before = h.started.length
    assert.equal((await h.watch()).toUser, 1)
    assert.equal(h.started.length, before)
    assert.equal(await stateOf(h, g.id), 'waiting_you')
  }),
)
