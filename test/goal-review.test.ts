/**
 * M2: plan review (core/goals/review.ts + the ops in server/goals.ts). The
 * reaction to each event is pure; the ops write the event and hand it to
 * `emit` at once, so approving queues the first step and sending back wakes
 * the lead with the comments without a timer or a poll. Unfinished events are
 * replayed after a restart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { GoalLedger } from '../core/goals/ledger.js'
import { initialSteps, leadDraftPrompt, pendingComments, reactTo, type LeadWake } from '../core/goals/review.js'
import type { Goal, GoalEvent } from '../core/goals/types.js'
import { flowOf } from '../core/work/flow.js'
import {
  goalApproveOp,
  goalCommentOp,
  goalCreateOp,
  goalGetOp,
  goalLeadSettledOp,
  goalLeadStartedOp,
  goalProposePlanOp,
  goalSendBackOp,
  onGoalEvent,
  replayGoalEvents,
  type GoalDeps,
  type GoalEngine,
} from '../server/goals.js'

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-review-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const PLAN = {
  summary: 'Fix the flaky test, then wait for CI.',
  doneWhen: 'CI is green on main',
  steps: [
    { id: 's1', title: 'Fix the test', type: 'agent', role: 'builder', doneWhen: 'the test passes 20 times in a row' },
    { id: 's2', title: 'Review the fix', type: 'agent', role: 'reviewer', doneWhen: 'no open findings' },
    { id: 's3', title: 'CI green', type: 'gate', dependsOn: ['s1', 's2'], doneWhen: 'checks pass', gate: { evaluator: 'ai', condition: 'CI is green on the head commit', checkEvery: '10m' } },
  ],
}

type Wake = { goalId: string; wake: LeadWake; seq: number }

let clock = 5_000_000
/**
 * Deps whose `emit` runs the real reaction against a fake engine: `wakes`
 * records each lead wake, `settle()` waits for every reaction emitted so far.
 * Nothing here uses a timer.
 */
function harness(dir: string, store = openSqliteStore(path.join(dir, 'triage.db'))) {
  const root = path.join(dir, 'artifacts')
  execFileSync('mkdir', ['-p', root])
  execFileSync('git', ['init', '-q'], { cwd: root })
  const now = () => ++clock
  const wakes: Wake[] = []
  const queued: string[][] = []
  const pending: Promise<void>[] = []
  const emitted: GoalEvent[] = []
  const eng: GoalEngine = {
    wakeLead: async (goal, wake, ev) => {
      wakes.push({ goalId: goal.id, wake, seq: ev.seq })
    },
    stepsQueued: (_goal, ids) => queued.push(ids),
  }
  const d: GoalDeps = {
    store,
    ledger: new GoalLedger(root, now),
    now,
    defaultProjectId: async () => null,
    changed: () => {},
    emit: (ev) => {
      emitted.push(ev)
      pending.push(onGoalEvent(d, eng, ev))
    },
  }
  const settle = async () => {
    while (pending.length) await pending.shift()
  }
  return { d, eng, store, wakes, queued, emitted, settle }
}

/** A goal with a proposed plan, up for review; its first wake is the draft. */
async function proposed(h: ReturnType<typeof harness>): Promise<Goal> {
  const { goal } = await goalCreateOp(h.d, { title: 'Fix the flaky test', doneWhen: 'CI is green on main' })
  await h.settle()
  const created = (await h.store.goals.events(goal.id)).find((e) => e.kind === 'created')!
  await goalLeadStartedOp(h.d, goal.id, 'lead-1')
  await goalProposePlanOp(h.d, { goalId: goal.id, plan: PLAN, sessionId: 'lead-1' })
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: created.seq, sessionId: 'lead-1' })
  return (await h.store.goals.get(goal.id))!
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

const goalIn = (state: Goal['state'], plan: Goal['plan'] = null): Goal =>
  ({ id: 'g', title: 'T', doneWhen: 'D', state, plan, planVersion: plan ? 1 : 0, horizon: 'until_done', budget: { usd: null, minutes: null }, sourceItemId: null }) as unknown as Goal
const ev = (kind: GoalEvent['kind'], detail: GoalEvent['detail'] = null, seq = 1): GoalEvent => ({ goalId: 'g', seq, at: seq, actor: 'you', sessionId: null, kind, from: null, to: null, detail, handledAt: null })
const steps = [
  { id: 'a', title: 'A', type: 'agent', role: 'builder', doneWhen: 'x', dependsOn: [] },
  { id: 'b', title: 'B', type: 'agent', role: 'builder', doneWhen: 'x', dependsOn: ['a'] },
] as unknown as NonNullable<Goal['plan']>['steps']
const plan = { summary: 's', doneWhen: 'D', steps } as unknown as NonNullable<Goal['plan']>

test('reactTo: created wakes the drafting lead only while there is no plan', () => {
  assert.deepEqual(reactTo(goalIn('draft_plan'), ev('created'), [], 1), { kind: 'wake_lead', wake: { kind: 'draft' } })
  assert.deepEqual(reactTo(goalIn('draft_plan', plan), ev('created'), [], 1), { kind: 'none' })
  assert.deepEqual(reactTo(goalIn('plan_ready', plan), ev('created'), [], 1), { kind: 'none' })
})

test('reactTo: approval queues no-dependency steps as runnable, once', () => {
  const r = reactTo(goalIn('queued', plan), ev('plan_approved', { version: 1 }), [], 7)
  assert.equal(r.kind, 'queue_steps')
  if (r.kind !== 'queue_steps') return
  assert.equal(r.currentStep, 'a')
  assert.deepEqual(r.steps.map((s) => [s.stepId, s.status]), [['a', 'runnable'], ['b', 'pending']])
  assert.deepEqual(reactTo(goalIn('queued', plan), ev('plan_approved'), initialSteps('g', plan, 7), 8), { kind: 'none' })
  // An approval of a goal still in plan_ready (crash before the move) or since cancelled does nothing.
  assert.deepEqual(reactTo(goalIn('plan_ready', plan), ev('plan_approved'), [], 8), { kind: 'none' })
  assert.deepEqual(reactTo(goalIn('cancelled', plan), ev('plan_approved'), [], 8), { kind: 'none' })
})

test('reactTo: send-back wakes the lead to revise, carrying the comments', () => {
  const comments = [{ stepId: 'a', text: 'split this', at: 3 }, { stepId: null, text: 'too big', at: 4 }]
  const r = reactTo(goalIn('draft_plan', plan), ev('plan_sent_back', { version: 1, comments }), [], 5)
  assert.deepEqual(r, { kind: 'wake_lead', wake: { kind: 'revise', version: 1, comments } })
  assert.deepEqual(reactTo(goalIn('plan_ready', plan), ev('plan_sent_back', { version: 1, comments }), [], 5), { kind: 'none' })
})

test('pendingComments: only the comments since the latest proposal', () => {
  const evs = [ev('plan_proposed', null, 1), ev('plan_commented', { stepId: 'a', text: 'old' }, 2), ev('plan_proposed', null, 3), ev('plan_commented', { stepId: null, text: 'new' }, 4), ev('plan_commented', { text: '  ' }, 5)]
  assert.deepEqual(pendingComments(evs), [{ stepId: null, text: 'new', at: 4 }])
})

test('leadDraftPrompt: a revision names each comment and its step', () => {
  const g = { id: 'g', title: 'T', doneWhen: 'D', horizon: 'until_done' as const, sourceItemId: 'manual:1', budget: { usd: 5, minutes: null } }
  const text = leadDraftPrompt(g, { kind: 'revise', version: 2, comments: [{ stepId: 's1', text: 'split it', at: 1 }, { stepId: null, text: 'add a test step', at: 2 }] }, '# Plan')
  assert.match(text, /sent plan v2 back/)
  assert.match(text, /- on step s1: split it/)
  assert.match(text, /- on the plan: add a test step/)
  assert.match(text, /get_work_item/)
  assert.match(leadDraftPrompt(g, { kind: 'draft' }, null), /draft the plan and propose it with goal_propose_plan/)
})

test('flow: a goal waiting on its plan review is the item\'s ready step, on my turn', () => {
  const item = { kind: 'manual', ask: undefined, status: 'open', updatedAt: '2026-10-16T00:00:00Z', createdAt: '2026-10-16T00:00:00Z' } as unknown as Parameters<typeof flowOf>[0]
  assert.deepEqual(flowOf(item, { goal: { state: 'plan_ready', at: 9 } }), { stage: 'ready', turn: 'me', next: 'review the plan', since: 9 })
  assert.equal(flowOf(item, { goal: { state: 'draft_plan', at: 9 } }).turn, 'ai')
  assert.equal(flowOf(item, { goal: { state: 'queued', at: 9 } }).stage, 'working')
})

// ---------------------------------------------------------------------------
// Ops: the done-when of T4
// ---------------------------------------------------------------------------

test('create: the created event wakes the lead to draft, and stays unhandled until the lead settles', withDir(async (dir) => {
  const h = harness(dir)
  const { goal } = await goalCreateOp(h.d, { title: 'Fix the flaky test', doneWhen: 'CI is green on main' })
  await h.settle()
  assert.deepEqual(h.wakes.map((w) => [w.goalId, w.wake.kind]), [[goal.id, 'draft']])
  assert.ok((await h.store.goals.unhandled()).some((e) => e.kind === 'created' && e.goalId === goal.id))
  // A lead that ends without proposing leaves the goal in draft_plan, with the reason, and its wake handled.
  await goalLeadStartedOp(h.d, goal.id, 'lead-1')
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: h.wakes[0]!.seq, sessionId: 'lead-1', error: 'timed out after 20 minutes' })
  const after = (await h.store.goals.get(goal.id))!
  assert.equal(after.state, 'draft_plan')
  assert.match(after.reason ?? '', /without proposing a plan: timed out/)
  assert.ok(!(await h.store.goals.unhandled()).some((e) => e.kind === 'created' && e.goalId === goal.id))
  assert.equal((await h.store.goals.sessions(goal.id))[0]!.outcome, 'failed')
  // A repeat create (same title and done-when) wakes nothing.
  await goalCreateOp(h.d, { title: 'Fix the flaky test', doneWhen: 'CI is green on main' })
  await h.settle()
  assert.equal(h.wakes.length, 1)
}))

test('approve: emits plan_approved, whose reaction queues the first steps with no polling', withDir(async (dir) => {
  const h = harness(dir)
  const goal = await proposed(h)
  assert.equal(goal.state, 'plan_ready')
  assert.equal(goal.planVersion, 1)

  const r = await goalApproveOp(h.d, { goalId: goal.id, version: 1 })
  assert.equal(r.outcome, 'approved')
  assert.equal(r.goal.state, 'queued')
  assert.equal(r.goal.planVersion, 1, 'approval does not bump the version')
  const approved = h.emitted.at(-1)!
  assert.equal(approved.kind, 'plan_approved')

  // The reaction ran off the emit itself — no timer, no sweep.
  await h.settle()
  const st = await h.store.goals.steps(goal.id)
  assert.deepEqual(st.map((s) => [s.stepId, s.status]), [['s1', 'runnable'], ['s2', 'runnable'], ['s3', 'pending']])
  assert.equal((await h.store.goals.get(goal.id))!.currentStep, 's1')
  assert.deepEqual(h.queued, [['s1', 's2']])
  assert.ok(!(await h.store.goals.unhandled()).some((e) => e.seq === approved.seq && e.goalId === goal.id))

  // Approving again writes nothing; a stale version is refused.
  assert.equal((await goalApproveOp(h.d, { goalId: goal.id })).outcome, 'unchanged')
  await assert.rejects(goalApproveOp(h.d, { goalId: goal.id, version: 0 }), /no plan up for review/)
}))

test('approve: refused for a plan the lead replaced since the user read it', withDir(async (dir) => {
  const h = harness(dir)
  const goal = await proposed(h)
  await assert.rejects(goalApproveOp(h.d, { goalId: goal.id, version: 2 }), /plan changed since you read it/)
  assert.equal((await h.store.goals.get(goal.id))!.state, 'plan_ready')
}))

test('send back: wakes the lead with the comments; its revised plan comes back for review', withDir(async (dir) => {
  const h = harness(dir)
  const goal = await proposed(h)
  assert.equal((await goalCommentOp(h.d, { goalId: goal.id, stepId: 's1', text: 'Split the fix from the flake hunt' })).outcome, 'commented')
  assert.equal((await goalCommentOp(h.d, { goalId: goal.id, stepId: 's1', text: 'Split the fix from the flake hunt' })).outcome, 'unchanged')
  await assert.rejects(goalCommentOp(h.d, { goalId: goal.id, stepId: 's9', text: 'x' }), /isn't in the plan/)
  assert.deepEqual((await goalGetOp(h.d, goal.id)).comments.map((c) => c.stepId), ['s1'])

  const r = await goalSendBackOp(h.d, { goalId: goal.id, version: 1, text: 'Add a step that runs it on CI twice' })
  assert.equal(r.outcome, 'sent_back')
  assert.equal(r.goal.state, 'draft_plan')
  await h.settle()

  const wake = h.wakes.at(-1)!
  assert.equal(wake.wake.kind, 'revise')
  if (wake.wake.kind !== 'revise') return
  assert.equal(wake.wake.version, 1)
  assert.deepEqual(wake.wake.comments.map((c) => [c.stepId, c.text]), [['s1', 'Split the fix from the flake hunt'], [null, 'Add a step that runs it on CI twice']])
  assert.match(leadDraftPrompt(r.goal, wake.wake, null), /on step s1: Split the fix/)

  // The revision proposes v2, and the comments on v1 are no longer pending.
  await goalProposePlanOp(h.d, { goalId: goal.id, plan: { ...PLAN, summary: 'Split, then run CI twice.' }, sessionId: 'lead-2' })
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: wake.seq, sessionId: 'lead-2' })
  const page = await goalGetOp(h.d, goal.id)
  assert.equal(page.goal.state, 'plan_ready')
  assert.equal(page.goal.planVersion, 2)
  assert.deepEqual(page.comments, [])
  assert.equal(page.goal.reason, null)
}))

test('send back: needs at least one comment, and only a plan under review', withDir(async (dir) => {
  const h = harness(dir)
  const goal = await proposed(h)
  await assert.rejects(goalSendBackOp(h.d, { goalId: goal.id }), /at least one comment/)
  assert.equal((await h.store.goals.get(goal.id))!.state, 'plan_ready')
  await goalApproveOp(h.d, { goalId: goal.id })
  await assert.rejects(goalSendBackOp(h.d, { goalId: goal.id, text: 'too late' }), /no plan up for review/)
  await assert.rejects(goalCommentOp(h.d, { goalId: goal.id, text: 'too late' }), /no plan up for review/)
}))

test('a wake that throws settles the event with the reason, never leaving it pending', withDir(async (dir) => {
  const h = harness(dir)
  h.eng.wakeLead = async () => {
    throw new Error('it has no project to work in')
  }
  const { goal } = await goalCreateOp(h.d, { title: 'T', doneWhen: 'D' })
  await h.settle()
  assert.match((await h.store.goals.get(goal.id))!.reason ?? '', /no project to work in/)
  assert.ok(!(await h.store.goals.unhandled()).some((e) => e.kind === 'created' && e.goalId === goal.id))
}))

test('restart: an approval and a send-back nobody finished are replayed; an older wake is superseded', withDir(async (dir) => {
  const dbFile = path.join(dir, 'triage.db')
  const h = harness(dir, openSqliteStore(dbFile))
  // The daemon "dies" before reacting: emit drops every event on the floor.
  h.d.emit = () => {}
  const a = await proposed(h)
  await goalApproveOp(h.d, { goalId: a.id })
  const { goal: b } = await goalCreateOp(h.d, { title: 'Second', doneWhen: 'D2' })
  await goalLeadStartedOp(h.d, b.id, 'lead-b')
  await goalProposePlanOp(h.d, { goalId: b.id, plan: PLAN, sessionId: 'lead-b' })
  await goalSendBackOp(h.d, { goalId: b.id, text: 'needs a test step' })
  await h.store.close()

  const h2 = harness(dir, openSqliteStore(dbFile))
  const n = await replayGoalEvents(h2.d, h2.eng)
  assert.equal(n, 2)
  assert.deepEqual((await h2.store.goals.steps(a.id)).map((s) => s.status), ['runnable', 'runnable', 'pending'])
  assert.deepEqual(h2.wakes.map((w) => [w.goalId, w.wake.kind]), [[b.id, 'revise']])
  // b's `created` was superseded by its send-back: handled, not a second wake. Its dead lead's row is closed.
  assert.ok(!(await h2.store.goals.unhandled()).some((e) => e.goalId === b.id && e.kind === 'created'))
  assert.equal((await h2.store.goals.sessions(b.id)).find((s) => s.sessionId === 'lead-b')!.outcome, 'failed')
  await h2.store.close()
}))
