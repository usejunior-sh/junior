/**
 * M4: gates (core/goals/gates.ts + the gate ops in server/goals.ts). The pure
 * rules are tabled — the checker's fence, its read tools, the back-off, the
 * two-met rule — and the sweep is driven end to end over a real store with a
 * fake checker that hands back whatever verdict the test says.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { GoalLedger } from '../core/goals/ledger.js'
import { afterSession } from '../core/goals/run.js'
import {
  applyVerdict,
  GATE_VERDICT_FULL,
  gateCheckPrompt,
  gateFenceDecision,
  gateReadTools,
  isHighStakes,
  nextCheckDelay,
  requiredConfirmations,
  verdictFrom,
  type ProbedServer,
} from '../core/goals/gates.js'
import { GATE_CHECK_SCHEDULE_MIN, type Gate, type GateVerdict, type Goal, type GoalStepState } from '../core/goals/types.js'
import { flowOf } from '../core/work/flow.js'
import {
  goalAnswerOp,
  goalApproveOp,
  goalArmGateOp,
  goalCreateOp,
  goalDispatchWorkerOp,
  goalGateSweepOp,
  goalGetOp,
  goalHandoffWriteOp,
  goalLeadSettledOp,
  goalLeadStartedOp,
  goalLogAppendOp,
  goalProposePlanOp,
  goalPumpIdle,
  goalSessionEndedOp,
  onGoalEvent,
  pumpGoals,
  type GateChecker,
  type GoalDeps,
  type GoalEngine,
  type StartSpec,
} from '../server/goals.js'

const MIN = 60_000

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

const LINEAR: ProbedServer = {
  server: 'claude.ai Linear',
  name: 'Linear',
  tools: [
    { name: 'get_issue', fullName: 'mcp__claude_ai_Linear__get_issue', readOnly: true },
    { name: 'list_issues', fullName: 'mcp__claude_ai_Linear__list_issues', readOnly: true },
    { name: 'update_issue', fullName: 'mcp__claude_ai_Linear__update_issue', readOnly: false },
    { name: 'create_comment', fullName: 'mcp__claude_ai_Linear__create_comment' },
  ],
}
const SENTRY: ProbedServer = {
  server: 'sentry',
  tools: [
    { name: 'get_issue', fullName: 'mcp__sentry__get_issue', readOnly: true },
    { name: 'resolve_issue', fullName: 'mcp__sentry__resolve_issue', readOnly: true, destructive: true },
    { name: 'search', fullName: 'mcp__sentry__search' },
  ],
}

test('gateReadTools: the named connectors\' read tools only — never a write, never an unnamed connector', () => {
  const linear = gateReadTools(['Linear'], [LINEAR, SENTRY])
  assert.deepEqual(linear, ['mcp__claude_ai_Linear__get_issue', 'mcp__claude_ai_Linear__list_issues'])
  assert.deepEqual(gateReadTools(['claude.ai linear'], [LINEAR]), linear, 'by server name too, case-blind')
  assert.deepEqual(gateReadTools(['sentry'], [LINEAR, SENTRY]), ['mcp__sentry__get_issue'], 'destructive and unmarked tools are out')
  assert.deepEqual(gateReadTools(['PagerDuty'], [LINEAR, SENTRY]), [], 'a connector nobody probed gives nothing')
})

test('the gate checker\'s fence refuses every write tool, the shell and file tools; it allows the read tools and its verdict', () => {
  const reads = new Set(gateReadTools(['Linear'], [LINEAR]))
  for (const t of [...reads, GATE_VERDICT_FULL, 'ToolSearch']) assert.deepEqual(gateFenceDecision(reads, t), { allow: true }, t)
  for (const t of ['mcp__claude_ai_Linear__update_issue', 'mcp__claude_ai_Linear__create_comment', 'mcp__sentry__get_issue', 'Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'mcp__triage__create_work_item']) {
    const d = gateFenceDecision(reads, t)
    assert.equal(d.allow, false, t)
    if (!d.allow) assert.match(d.reason, /only reads/)
  }
})

test('high stakes: a merge, a deploy or production needs two "met" in a row, whatever was asked', () => {
  for (const t of ['PR #12 is merged', 'deploy to prod finished', 'the release is out', 'production error rate below 1%']) assert.ok(isHighStakes(t), t)
  for (const t of ['LIN-2214 is in QA', 'CI is green', 'the reviewer replied', 'productive meeting']) assert.ok(!isHighStakes(t), t)
  assert.equal(requiredConfirmations(1, 'LIN-2214 is in QA'), 1)
  assert.equal(requiredConfirmations(1, 'CI green', 'Merge the PR'), 2, 'the step title counts too')
  assert.equal(requiredConfirmations(3, 'PR merged'), 3)
})

const gate = (extra: Partial<Gate> = {}): Gate => ({
  id: 'g1',
  goalId: 'goal',
  stepId: 's2',
  evaluator: 'ai',
  condition: 'PR #12 is merged',
  connectors: [],
  status: 'open',
  refs: [],
  armedAt: 0,
  nextCheckAt: 5 * MIN,
  checks: 0,
  checkEveryMs: null,
  deadlineAt: 1_000 * MIN,
  confirmationsNeeded: 2,
  confirmationsSeen: 0,
  lastVerdict: null,
  itemId: null,
  settledAt: null,
  ...extra,
})
const v = (verdict: GateVerdict['verdict'], checkAgainIn: string | null = null): GateVerdict => ({ verdict, evidence: verdict, checkAgainIn })

test('applyVerdict: two "met" in a row resolve a high-stakes gate; anything between resets the count', () => {
  const first = applyVerdict(gate(), v('met'), 10 * MIN)
  assert.equal(first.outcome, 'recheck')
  assert.equal(first.gate.confirmationsSeen, 1)
  assert.equal(first.gate.nextCheckAt, 15 * MIN)
  const reset = applyVerdict(first.gate, v('not_met'), 15 * MIN)
  assert.equal(reset.outcome, 'recheck')
  assert.equal(reset.gate.confirmationsSeen, 0)
  const again = applyVerdict(applyVerdict(reset.gate, v('met'), 20 * MIN).gate, v('met'), 25 * MIN)
  assert.equal(again.outcome, 'resolved')
  assert.equal(again.gate.confirmationsSeen, 2)
  assert.equal(applyVerdict(gate({ confirmationsNeeded: 1 }), v('met'), 1).outcome, 'resolved')
  assert.equal(applyVerdict(gate(), v('needs_user'), 1).outcome, 'to_user')
  assert.equal(applyVerdict(gate({ confirmationsSeen: 1 }), v('error'), 1).gate.confirmationsSeen, 0)
})

test('the back-off: 5, 5, 10, 10, 20, 20, 30, 30, 40, 40 minutes, then hourly; check_every overrides; a hint only slows it', () => {
  const delays = Array.from({ length: 12 }, (_, i) => nextCheckDelay(i, null) / MIN)
  assert.deepEqual(delays, [...GATE_CHECK_SCHEDULE_MIN, 60, 60])
  assert.equal(nextCheckDelay(3, 15 * MIN), 15 * MIN)
  assert.equal(nextCheckDelay(0, null, '2h'), 60 * MIN, 'capped at the hourly tail')
  assert.equal(nextCheckDelay(4, null, '1m'), 20 * MIN, 'never sooner than the schedule')
  let g = gate({ confirmationsNeeded: 1 })
  for (let i = 0; i < 3; i++) g = applyVerdict(g, v('not_met'), 100 * MIN).gate
  assert.equal(g.checks, 3)
  assert.equal(g.nextCheckAt, 110 * MIN)
})

test('the checker sees the condition and the ids, and its verdicts are validated', () => {
  const p = gateCheckPrompt([{ id: 'g1', condition: 'LIN-2214 is in QA', refs: ['LIN-2214'], connectors: ['Linear'] }])
  assert.match(p, /Gate g1\n {2}Condition: LIN-2214 is in QA\n {2}Ids: LIN-2214/)
  assert.deepEqual(verdictFrom({ verdict: 'met', evidence: ' In QA ', checkAgainIn: 'soon' }), { verdict: 'met', evidence: 'In QA', checkAgainIn: null })
  assert.equal(verdictFrom({ verdict: 'yes' }), null)
  assert.equal(verdictFrom('met'), null)
})

test('afterSession: an armed gate step has no worker coming — the goal waits on the world', () => {
  const plan = { steps: [{ id: 's2', type: 'gate', dependsOn: [] }] } as unknown as NonNullable<Goal['plan']>
  const st = { goalId: 'g', stepId: 's2', status: 'running', sessionId: null } as GoalStepState
  assert.equal(afterSession({ plan }, [st], [gate()], []).trigger, 'wait_world')
})

// ---------------------------------------------------------------------------
// The sweep, end to end
// ---------------------------------------------------------------------------

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-gates-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const plan = (gateStep: Record<string, unknown>) => ({
  summary: 'Fix the bug, wait for it to land, then check it.',
  doneWhen: 'the fix is merged and verified',
  steps: [
    { id: 's1', title: 'Fix the bug', type: 'agent', role: 'builder', doneWhen: 'the test passes' },
    { id: 's2', title: 'Wait for it', type: 'gate', dependsOn: ['s1'], doneWhen: 'the condition holds', gate: gateStep },
    { id: 's3', title: 'Verify', type: 'agent', role: 'tester', dependsOn: ['s2'], doneWhen: 'verified' },
  ],
})

type Started = { goalId: string; sessionId: string; spec: StartSpec }

/** Deps over a real store and ledger, a clock the test moves, and a checker that answers from `verdicts`. */
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
  const verdicts = new Map<string, GateVerdict>()
  const checked: { ids: string[]; model: string }[] = []
  const check: GateChecker = async (gates, model) => {
    checked.push({ ids: gates.map((g) => g.id), model })
    return { verdicts: new Map(gates.filter((g) => verdicts.has('*')).map((g) => [g.id, verdicts.get('*')!])), costUsd: 0.01 }
  }
  const settle = async () => {
    while (pending.length) await pending.shift()
    await goalPumpIdle(d)
  }
  return {
    d,
    eng,
    store,
    started,
    settle,
    checked,
    say: (x: GateVerdict) => verdicts.set('*', x),
    advance: (ms: number) => void (clock += ms),
    sweep: async () => {
      const r = await goalGateSweepOp(d, eng, check)
      await settle()
      return r
    },
    last: () => started.at(-1)!,
  }
}
type H = ReturnType<typeof harness>

/** A goal on `gateStep`'s plan, run to the point the lead has armed s2 and ended: the goal is on the gate. */
async function onTheGate(h: H, gateStep: Record<string, unknown>, arm: Record<string, unknown> = {}): Promise<Goal> {
  const { goal } = await goalCreateOp(h.d, { title: 'Land the fix', doneWhen: 'the fix is merged and verified' })
  await h.settle()
  const created = (await h.store.goals.events(goal.id)).find((e) => e.kind === 'created')!
  await goalLeadStartedOp(h.d, goal.id, 'draft-1')
  await goalProposePlanOp(h.d, { goalId: goal.id, plan: plan(gateStep), sessionId: 'draft-1' })
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: created.seq, sessionId: 'draft-1' })
  await goalApproveOp(h.d, { goalId: goal.id })
  await h.settle()
  // lead → s1's worker → lead, which arms the gate.
  await goalDispatchWorkerOp(h.d, { goalId: goal.id, sessionId: h.last().sessionId }, { stepId: 's1', brief: 'fix it' })
  await goalSessionEndedOp(h.d, h.eng, { goalId: goal.id, sessionId: h.last().sessionId })
  await h.settle()
  const w = h.last()
  await goalHandoffWriteOp(h.d, { goalId: goal.id, sessionId: w.sessionId, done: 'fixed', next: 'wait for the merge' })
  await goalLogAppendOp(h.d, { goalId: goal.id, sessionId: w.sessionId, stepId: 's1', role: 'builder', outcome: 'done', text: 'fixed' })
  await goalSessionEndedOp(h.d, h.eng, { goalId: goal.id, sessionId: w.sessionId })
  await h.settle()
  const lead = h.last()
  assert.equal(lead.spec.role, 'lead')
  await goalArmGateOp(h.d, { goalId: goal.id, sessionId: lead.sessionId }, { stepId: 's2', refs: ['#12'], ...arm })
  await goalSessionEndedOp(h.d, h.eng, { goalId: goal.id, sessionId: lead.sessionId })
  await h.settle()
  return (await h.store.goals.get(goal.id))!
}

const stateOf = async (h: H, id: string) => (await h.store.goals.get(id))!.state
const gateOf = async (h: H, id: string) => (await h.store.goals.gates(id))[0]!
const stepOf = async (h: H, id: string, stepId: string) => (await h.store.goals.steps(id)).find((s) => s.stepId === stepId)!

test(
  'an AI gate pauses the goal with no session; nothing is checked before it is due; a met verdict wakes the lead',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onTheGate(h, { evaluator: 'ai', condition: 'LIN-2214 is in QA', connectors: ['Linear'] })
    assert.equal(g.state, 'waiting_world')
    const before = h.started.length
    const gt = await gateOf(h, g.id)
    assert.equal(gt.confirmationsNeeded, 1)
    assert.equal(gt.nextCheckAt, gt.armedAt + 5 * MIN)

    assert.deepEqual(await h.sweep(), { checked: 0, resolved: 0, toUser: 0 })
    assert.equal(h.checked.length, 0, 'nothing due: no session')

    h.advance(5 * MIN)
    h.say({ verdict: 'not_met', evidence: 'In Progress', checkAgainIn: null })
    assert.deepEqual(await h.sweep(), { checked: 1, resolved: 0, toUser: 0 })
    assert.deepEqual(h.checked[0], { ids: [gt.id], model: 'haiku' })
    assert.equal(await stateOf(h, g.id), 'waiting_world')
    assert.equal(h.started.length, before, 'not met: nobody wakes')

    h.advance(5 * MIN)
    h.say({ verdict: 'met', evidence: 'In QA', checkAgainIn: null })
    assert.deepEqual(await h.sweep(), { checked: 1, resolved: 1, toUser: 0 })
    assert.equal((await gateOf(h, g.id)).status, 'met')
    assert.equal((await stepOf(h, g.id, 's2')).status, 'done')
    assert.equal((await stepOf(h, g.id, 's3')).status, 'runnable')
    const lead = h.last()
    assert.equal(h.started.length, before + 1)
    assert.equal(lead.spec.role, 'lead')
    if (lead.spec.role === 'lead') assert.match(lead.spec.prompt, /gate resolved/)
    assert.equal(await stateOf(h, g.id), 'running')
    assert.ok((await h.store.goals.get(g.id))!.spentUsd > 0, 'the check is booked to the goal')
  }),
)

test(
  'a high-stakes gate needs two "met" in a row before the lead wakes',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onTheGate(h, { evaluator: 'ai', condition: 'PR #12 is merged into main' })
    assert.equal((await gateOf(h, g.id)).confirmationsNeeded, 2)
    h.say({ verdict: 'met', evidence: 'merged', checkAgainIn: null })
    h.advance(5 * MIN)
    assert.deepEqual(await h.sweep(), { checked: 1, resolved: 0, toUser: 0 })
    assert.equal(await stateOf(h, g.id), 'waiting_world', 'one met is not enough')
    h.advance(5 * MIN)
    assert.deepEqual(await h.sweep(), { checked: 1, resolved: 1, toUser: 0 })
    assert.equal(await stateOf(h, g.id), 'running')
  }),
)

test(
  'a gate past its deadline goes to the Inbox as an approval; keep waiting resumes checks without waking the lead',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onTheGate(h, { evaluator: 'ai', condition: 'LIN-2214 is in QA', deadline: '1h' })
    const before = h.started.length
    h.say({ verdict: 'not_met', evidence: 'In Progress', checkAgainIn: null })
    for (let i = 0; i < 4; i++) {
      h.advance(15 * MIN)
      await h.sweep()
    }
    assert.equal(await stateOf(h, g.id), 'waiting_you')
    const gt = await gateOf(h, g.id)
    assert.equal(gt.status, 'needs_user')
    assert.equal(gt.itemId, 'manual:goal-item')
    const got = await goalGetOp(h.d, g.id)
    assert.equal(got.ask?.kind, 'ask')
    if (got.ask?.kind === 'ask') {
      assert.deepEqual(got.ask.gate && { why: got.ask.gate.why, stepId: got.ask.gate.stepId }, { why: 'deadline', stepId: 's2' })
      assert.match(got.ask.question, /LIN-2214 is in QA/)
      assert.ok(got.ask.recommended)
    }
    // The goal's Inbox item: in "Needs you now".
    const flow = flowOf({ id: 'manual:goal-item', kind: 'manual' } as never, { goal: { state: 'waiting_you', at: g.updatedAt } })
    assert.deepEqual([flow.turn, flow.ask], ['me', 'answer the goal'])

    await goalAnswerOp(h.d, h.eng, { goalId: g.id, gate: 'wait' })
    await h.settle()
    assert.equal(await stateOf(h, g.id), 'waiting_world')
    const reopened = await gateOf(h, g.id)
    assert.equal(reopened.status, 'open')
    assert.ok(reopened.deadlineAt > h.d.now() + 23 * 60 * MIN)
    assert.equal(h.started.length, before, 'keep waiting wakes nobody')
  }),
)

test(
  'a checker that can\'t tell hands the gate to the user; approving it finishes the step and wakes the lead',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onTheGate(h, { evaluator: 'ai', condition: 'the customer confirmed the fix' })
    h.advance(5 * MIN)
    h.say({ verdict: 'needs_user', evidence: 'no ticket to read', checkAgainIn: null })
    assert.deepEqual(await h.sweep(), { checked: 1, resolved: 0, toUser: 1 })
    assert.equal(await stateOf(h, g.id), 'waiting_you')
    const before = h.started.length
    await goalAnswerOp(h.d, h.eng, { goalId: g.id, gate: 'approve', text: 'they emailed me' })
    await h.settle()
    assert.equal((await gateOf(h, g.id)).status, 'met')
    assert.equal((await stepOf(h, g.id, 's2')).status, 'done')
    assert.equal(h.started.length, before + 1)
    const lead = h.last()
    if (lead.spec.role === 'lead') assert.match(lead.spec.prompt, /Approved: the customer confirmed the fix — they emailed me/)
  }),
)

test(
  'a user gate can\'t be armed without Junior\'s recommended answer',
  withDir(async (dir) => {
    await assert.rejects(onTheGate(harness(dir), { evaluator: 'user', condition: 'Ship the migration?' }), /recommended/)
  }),
)

test(
  'a user gate is an approval at once — the sweep never checks it; rejecting fails the step and wakes the lead',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await onTheGate(h, { evaluator: 'user', condition: 'Ship the migration?' }, { recommended: 'Yes: the dry run was clean', evidence: 'dry run log' })
    assert.equal(g.state, 'waiting_you')
    const gt = await gateOf(h, g.id)
    assert.equal(gt.status, 'needs_user')
    assert.equal(gt.nextCheckAt, null)
    h.advance(60 * MIN)
    assert.deepEqual(await h.sweep(), { checked: 0, resolved: 0, toUser: 0 })
    const got = await goalGetOp(h.d, g.id)
    if (got.ask?.kind !== 'ask') return assert.fail('an ask')
    assert.equal(got.ask.recommended, 'Yes: the dry run was clean')
    assert.equal(got.ask.gate?.why, 'approval')
    await assert.rejects(goalAnswerOp(h.d, h.eng, { goalId: g.id, gate: 'wait' }), /nothing to wait for/)
    const before = h.started.length
    await goalAnswerOp(h.d, h.eng, { goalId: g.id, gate: 'reject', text: 'not before Friday' })
    await h.settle()
    assert.equal((await gateOf(h, g.id)).status, 'cancelled')
    assert.equal((await stepOf(h, g.id, 's2')).status, 'failed')
    assert.equal(h.started.length, before + 1)
  }),
)
