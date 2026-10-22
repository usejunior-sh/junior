/**
 * M3: the run loop (core/goals/run.ts + the ops in server/goals.ts). The
 * decisions are pure and tabled here; the ops are driven end to end with a
 * fake engine that records each session the scheduler starts, so a test plays
 * the sessions' part by calling the tools they would call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { GoalLedger } from '../core/goals/ledger.js'
import { heldEntry, heldRecord } from '../core/actions/queue.js'
import { recordFor } from '../core/actions/track.js'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { shortActionId } from '../core/actions/view.js'
import { afterSession, budgetCheck, isWake, nextSession, nextWorkers, pickGoals, reconcileSteps, reportResult, unreadWakes, workerCap, workerPrompt, workingSessions } from '../core/goals/run.js'
import type { Gate, Goal, GoalEvent, GoalStepState } from '../core/goals/types.js'
import type { GoalSessionRecord } from '../core/store/types.js'
import {
  bootGoalRun,
  goalAcceptOp,
  goalActionHeldOp,
  goalAnswerOp,
  goalApproveOp,
  goalAskUserOp,
  goalCreateOp,
  goalDispatchWorkerOp,
  goalGetOp,
  goalHandBackOp,
  goalHandoffWriteOp,
  goalHeldActions,
  GoalHeldIndex,
  goalLeadSettledOp,
  goalLeadStartedOp,
  goalLogAppendOp,
  goalMessageOp,
  goalProposePlanOp,
  goalPumpIdle,
  goalSessionEndedOp,
  goalTakeOverOp,
  loadGoalHeld,
  onGoalEvent,
  pumpGoals,
  type GoalDeps,
  type GoalEngine,
  type StartSpec,
} from '../server/goals.js'

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-run-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const PLAN = {
  summary: 'Fix the flaky test, review it, then prove it holds.',
  doneWhen: 'the flaky test passes 20 runs in a row on the goal branch',
  steps: [
    { id: 's1', title: 'Fix the test', type: 'agent', role: 'builder', doneWhen: 'the test passes locally' },
    { id: 's2', title: 'Review the fix', type: 'agent', role: 'reviewer', dependsOn: ['s1'], doneWhen: 'no open findings' },
    { id: 's3', title: 'Run it 20 times', type: 'agent', role: 'tester', dependsOn: ['s2'], doneWhen: '20 green runs' },
  ],
}

type Started = { goalId: string; sessionId: string; spec: StartSpec }

let clock = 9_000_000
/** Deps over a real store and ledger; the engine records each session start and gives it an id. */
function harness(dir: string, store = openSqliteStore(path.join(dir, 'junior.db'))) {
  const root = path.join(dir, 'artifacts')
  execFileSync('mkdir', ['-p', root])
  try {
    execFileSync('git', ['rev-parse'], { cwd: root, stdio: 'ignore' })
  } catch {
    execFileSync('git', ['init', '-q'], { cwd: root })
  }
  const now = () => ++clock
  const started: Started[] = []
  const pending: Promise<void>[] = []
  let n = 0
  const eng: GoalEngine = {
    wakeLead: async () => {},
    stepsQueued: () => void pending.push(pumpGoals(d, eng)),
    startSession: async (goal, spec, ok) => {
      const sessionId = `${spec.role}-${++n}-${clock}`
      started.push({ goalId: goal.id, sessionId, spec })
      await ok(sessionId)
    },
    worktreeHead: async () => 'abc123',
  }
  const d: GoalDeps = {
    store,
    ledger: new GoalLedger(root, now),
    now,
    defaultProjectId: async () => null,
    changed: () => {},
    emit: (ev) => void pending.push(onGoalEvent(d, eng, ev)),
  }
  const settle = async () => {
    while (pending.length) await pending.shift()
    await goalPumpIdle(d)
  }
  const last = () => started.at(-1)!
  return { d, eng, store, started, settle, last }
}
type H = ReturnType<typeof harness>

/** A goal on PLAN, approved: the scheduler has started its run lead. */
async function approved(h: H): Promise<Goal> {
  const { goal } = await goalCreateOp(h.d, { title: 'Fix the flaky test', doneWhen: PLAN.doneWhen })
  await h.settle()
  const created = (await h.store.goals.events(goal.id)).find((e) => e.kind === 'created')!
  await goalLeadStartedOp(h.d, goal.id, 'draft-1')
  await goalProposePlanOp(h.d, { goalId: goal.id, plan: PLAN, sessionId: 'draft-1' })
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: created.seq, sessionId: 'draft-1' })
  await goalApproveOp(h.d, { goalId: goal.id })
  await h.settle()
  return (await h.store.goals.get(goal.id))!
}

/** The run lead dispatches `stepId` and ends its turn. */
async function leadDispatches(h: H, goalId: string, stepId: string) {
  const lead = h.last()
  assert.equal(lead.spec.role, 'lead')
  await goalDispatchWorkerOp(h.d, { goalId, sessionId: lead.sessionId }, { stepId, brief: `do ${stepId}` })
  await goalSessionEndedOp(h.d, h.eng, { goalId, sessionId: lead.sessionId, costUsd: 0.1 })
  await h.settle()
}

/** The worker on `stepId` logs it done, hands off, and ends. */
async function workerFinishes(h: H, goalId: string, stepId: string) {
  const w = h.last()
  assert.equal(w.spec.role !== 'lead' && w.spec.stepId, stepId)
  await goalHandoffWriteOp(h.d, { goalId, sessionId: w.sessionId, done: `${stepId} done`, next: 'the next step' })
  await goalLogAppendOp(h.d, { goalId, sessionId: w.sessionId, stepId, role: w.spec.role, outcome: 'done', text: `finished ${stepId}` })
  await goalSessionEndedOp(h.d, h.eng, { goalId, sessionId: w.sessionId, costUsd: 0.2 })
  await h.settle()
}

const stateOf = async (h: H, id: string) => (await h.store.goals.get(id))!.state
const stepOf = async (h: H, id: string, stepId: string) => (await h.store.goals.steps(id)).find((s) => s.stepId === stepId)!

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

const plan3 = { summary: 's', doneWhen: 'D', steps: PLAN.steps.map((s) => ({ dependsOn: [], ...s })) } as unknown as NonNullable<Goal['plan']>
const row = (stepId: string, status: GoalStepState['status'], extra: Partial<GoalStepState> = {}): GoalStepState =>
  ({ goalId: 'g', stepId, status, sessionId: null, attempts: 0, startedAt: null, endedAt: null, updatedAt: 1, ...extra }) as GoalStepState
const ev = (kind: GoalEvent['kind'], detail: GoalEvent['detail'] = null, seq = 1, handledAt: number | null = null): GoalEvent =>
  ({ goalId: 'g', seq, at: seq, actor: 'engine', sessionId: null, kind, from: null, to: null, detail, handledAt })
const goal = { id: 'g', plan: plan3, budget: { usd: 10, minutes: null }, spentUsd: 0 } as unknown as Goal

test('afterSession: an open ask, then all done, then a dispatched step, then unread wakes, then a gate, else ask', () => {
  const done = [row('s1', 'done'), row('s2', 'done'), row('s3', 'done')]
  const asked = [ev('asked_you', { question: 'q' }, 1, 1)]
  assert.equal(afterSession(goal, done, [], asked).trigger, 'ask_you')
  assert.equal(afterSession(goal, done, [], []).trigger, 'result')
  assert.equal(afterSession(goal, [row('s1', 'running')], [], []).trigger, 'yield')
  assert.equal(afterSession(goal, [row('s1', 'done'), row('s2', 'runnable')], [], [ev('step_finished', { stepId: 's1' })]).trigger, 'yield')
  const gate = { status: 'open' } as Gate
  assert.equal(afterSession(goal, [row('s1', 'running', { sessionId: 'x' })], [gate], []).trigger, 'wait_world')
  const stuck = afterSession(goal, [row('s1', 'runnable')], [], [])
  assert.equal(stuck.trigger, 'ask_you')
  assert.match(stuck.reason ?? '', /without a next step/)
})

test('nextSession: a dispatched agent step gets its worker, with the brief and try it was dispatched with', () => {
  const events = [ev('step_dispatched', { stepId: 's2', brief: 'look hard', model: null, attempt: 1 })]
  assert.deepEqual(nextSession(goal, [row('s1', 'done'), row('s2', 'running', { attempts: 1 })], events), {
    kind: 'worker',
    role: 'reviewer',
    stepId: 's2',
    brief: 'look hard',
    model: null,
    attempt: 1,
  })
  assert.deepEqual(nextSession(goal, [row('s1', 'runnable')], []), { role: 'lead' })
  // A worker is on it already: the lead decides what's next.
  assert.deepEqual(nextSession(goal, [row('s1', 'running', { sessionId: 'w' })], []), { role: 'lead' })
})

test('M6 workerCap: the team section sizes a goal\'s workers, never over the max team size; no team runs one at a time', () => {
  assert.equal(workerCap(null, 3), 1)
  assert.equal(workerCap({ team: [] }, 3), 1)
  const two = [{ role: 'builder', count: 2, why: 'w', model: null }, { role: 'lead', count: 1, why: 'w', model: null }] as const
  assert.equal(workerCap({ team: [...two] }, 3), 2)
  assert.equal(workerCap({ team: [...two] }, 1), 1)
})

test('M6 nextWorkers: dispatched steps without a worker, in plan order, up to n', () => {
  const events = [ev('step_dispatched', { stepId: 's3', brief: 'b3' }), ev('step_dispatched', { stepId: 's1', brief: 'b1' })]
  const rows = [row('s1', 'running', { attempts: 1 }), row('s2', 'running', { sessionId: 'busy', attempts: 1 }), row('s3', 'running', { attempts: 1 })]
  assert.deepEqual(nextWorkers(goal, rows, events, 5).map((w) => w.stepId), ['s1', 's3'])
  assert.deepEqual(nextWorkers(goal, rows, events, 1).map((w) => w.stepId), ['s1'])
})

test('M6 workingSessions: the workers holding running steps, else the lead if it started last', () => {
  const started = (sessionId: string, role: string, stepId: string | null, seq: number) => ev('step_started', { sessionId, role, stepId }, seq)
  const events = [started('lead-1', 'lead', null, 1), started('w-a', 'builder', 's1', 2), started('w-b', 'tester', 's3', 3)]
  const rows = [row('s1', 'running', { sessionId: 'w-a' }), row('s2', 'done'), row('s3', 'running', { sessionId: 'w-b' })]
  assert.deepEqual(workingSessions(rows, events), [
    { sessionId: 'w-a', role: 'builder', stepId: 's1' },
    { sessionId: 'w-b', role: 'tester', stepId: 's3' },
  ])
  // Both settled, the lead woke: it is the one working.
  assert.deepEqual(workingSessions([row('s1', 'done'), row('s3', 'done')], [...events, started('lead-2', 'lead', null, 4)]), [{ sessionId: 'lead-2', role: 'lead', stepId: null }])
  // Settled with no lead since: nobody.
  assert.deepEqual(workingSessions([row('s1', 'done'), row('s3', 'done')], events), [])
})

test('M6 workerPrompt: a reviewer gets the plan and the diff, never the handoff or the log', () => {
  const g = { id: 'g', title: 'Fix it', doneWhen: 'D' }
  const files = { handoff: 'SECRET HANDOFF', log: 'SECRET LOG' }
  const builder = workerPrompt(g, plan3.steps[0]!, { brief: 'b', attempt: 1 }, files, [])
  assert.match(builder.context, /SECRET HANDOFF/)
  const review = workerPrompt(g, plan3.steps[1]!, { brief: 'look hard', attempt: 1 }, { plan: plan3, steps: [row('s1', 'done')], diff: '+fixed line' }, [])
  assert.doesNotMatch(review.context, /SECRET|## Handoff|## Latest log/)
  assert.match(review.context, /review independently/)
  assert.match(review.context, /\+fixed line/)
  assert.match(review.context, /Fix the test/, 'the plan\'s steps are in it')
  const big = workerPrompt(g, plan3.steps[1]!, { brief: '', attempt: 1 }, { plan: plan3, steps: [], diff: 'x'.repeat(70_000) }, [])
  assert.match(big.context, /cut at 60000 characters/)
})

test('isWake: a message straight to a worker never wakes the lead', () => {
  assert.equal(isWake(ev('user_message', { to: 'lead', text: 'hi' })), true)
  assert.equal(isWake(ev('user_message', { to: 'worker', text: 'hi' })), false)
  assert.equal(isWake(ev('step_dispatched', { stepId: 's1' })), false)
})

test('reportResult: done needs evidence and a worker that logged it done', () => {
  const sessions = [{ sessionId: 'w', stepId: 's1', role: 'builder', outcome: 'done' }] as GoalSessionRecord[]
  assert.equal(reportResult(plan3, [row('s1', 'running')], sessions, [], { stepId: 's1', outcome: 'done', evidence: null }).ok, false)
  assert.deepEqual(reportResult(plan3, [row('s1', 'running')], sessions, [], { stepId: 's1', outcome: 'done', evidence: 'tests pass' }), { ok: true, status: 'done' })
  assert.equal(reportResult(plan3, [row('s2', 'running')], sessions, [], { stepId: 's2', outcome: 'done', evidence: 'trust me' }).ok, false)
  assert.deepEqual(reportResult(plan3, [row('s2', 'running')], sessions, [], { stepId: 's2', outcome: 'failed', evidence: null }), { ok: true, status: 'failed' })
})

test('reconcileSteps: done stays done, a dropped step is skipped, a new one waits on its dependencies', () => {
  const next = { ...plan3, steps: [plan3.steps[0]!, { id: 's4', title: 'New', type: 'agent', role: 'builder', dependsOn: ['s1'], doneWhen: 'x' }] } as NonNullable<Goal['plan']>
  const out = reconcileSteps('g', [row('s1', 'done'), row('s2', 'runnable'), row('s3', 'pending')], next, 5)
  const by = new Map(out.map((s) => [s.stepId, s.status]))
  assert.equal(by.get('s1') ?? 'done', 'done')
  assert.equal(by.get('s2'), 'skipped')
  assert.equal(by.get('s3'), 'skipped')
  assert.equal(by.get('s4'), 'runnable')
})

test('pickGoals: the free slots go to the highest priority, then the oldest', () => {
  const g = (id: string, priority: number, createdAt: number) => ({ id, priority, createdAt }) as Goal
  assert.deepEqual(pickGoals([g('a', 0, 1), g('b', 1, 3), g('c', 1, 2)], 0, 2).map((x) => x.id), ['c', 'b'])
  assert.deepEqual(pickGoals([g('a', 0, 1)], 2, 2), [])
})

test('budgetCheck: warns once at 80%, stops at the cap', () => {
  const at = (spentUsd: number) => ({ ...goal, spentUsd }) as Goal
  assert.equal(budgetCheck(at(1), 0, false).kind, 'ok')
  assert.equal(budgetCheck(at(8.5), 0, false).kind, 'warn')
  assert.equal(budgetCheck(at(8.5), 0, true).kind, 'ok')
  assert.equal(budgetCheck(at(10), 0, true).kind, 'stop')
})

// ---------------------------------------------------------------------------
// The loop, end to end
// ---------------------------------------------------------------------------

test(
  'a three-step goal runs from approval to its result: lead, worker, lead, worker, lead, worker',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await approved(h)
    assert.equal(g.state, 'running')
    assert.equal(h.started.length, 1)
    assert.equal(h.last().spec.role, 'lead')

    for (const stepId of ['s1', 's2', 's3']) {
      await leadDispatches(h, g.id, stepId)
      const w = h.last()
      if (w.spec.role === 'lead') return assert.fail(`a worker starts on ${stepId}`)
      assert.equal(w.spec.stepId, stepId)
      assert.match(w.spec.first, new RegExp(`^/goal Step ${stepId} of goal`))
      assert.ok(w.spec.first.length <= 500)
      assert.equal(w.spec.writes, stepId === 's1', 'only the builder writes')
      assert.equal(await stateOf(h, g.id), 'running')
      await workerFinishes(h, g.id, stepId)
      assert.equal((await stepOf(h, g.id, stepId)).status, 'done')
      if (stepId !== 's3') {
        // The step finished: the lead wakes to it, with the worker's handoff.
        const lead = h.last()
        assert.equal(lead.spec.role, 'lead')
        if (lead.spec.role === 'lead') {
          assert.match(lead.spec.prompt, /What woke you/)
          assert.match(lead.spec.prompt, new RegExp(`${stepId} done`))
        }
      }
    }

    assert.equal(await stateOf(h, g.id), 'result_ready')
    assert.equal(h.started.length, 6, 'no lead is woken just to say it is finished')
    assert.deepEqual(unreadWakes(await h.store.goals.events(g.id)), [], 'every wake was read')
    const got = await goalGetOp(h.d, g.id)
    assert.equal(got.liveSession, null)
    assert.equal(Math.round(got.goal.spentUsd * 100), 90)
    await goalAcceptOp(h.d, { goalId: g.id })
    assert.equal(await stateOf(h, g.id), 'done')
  }),
)

test(
  'a restart mid-step resumes from the handoff and never files a queued action twice',
  withDir(async (dir) => {
    const db = path.join(dir, 'junior.db')
    const h = harness(dir, openSqliteStore(db))
    const g = await approved(h)
    await leadDispatches(h, g.id, 's1')
    const w = h.last()
    assert.equal(w.spec.role, 'builder')

    // Mid-step: the worker hands off what it has, and a `gh pr create` is held for approval.
    await goalHandoffWriteOp(h.d, { goalId: g.id, sessionId: w.sessionId, done: 'patched the retry loop', next: 'open the PR' })
    const args = { command: 'gh pr create --title "Fix the flaky test" --body "x"' }
    const sorted = sortCall('Bash', args, { rules: DEFAULT_RULES })
    assert.ok(sorted, 'gh pr create sorts as an action')
    const rec = heldRecord(recordFor({ sessionId: w.sessionId, sessionKind: 'goal', permissionMode: null, jobId: null, teamRunId: null, itemId: null }, 'tu1', 'Bash', args, sorted, clock), args, clock)
    await h.store.actions.put(rec)
    await h.store.actions.addHistory(heldEntry(rec, args, clock))
    await goalActionHeldOp(h.d, new GoalHeldIndex(), { goalId: g.id, sessionId: w.sessionId, actionId: rec.id, tool: 'Bash', args })

    // The daemon dies. A new one opens the same database and ledger.
    const h2 = harness(dir, openSqliteStore(db))
    const idx = new GoalHeldIndex()
    assert.equal(await loadGoalHeld(h2.d, idx), 1)
    await bootGoalRun(h2.d, h2.eng)
    await h2.settle()

    // The same step, the same try, a fresh worker that reads the handoff and the queued action.
    assert.equal(h2.started.length, 1)
    const w2 = h2.last()
    if (w2.spec.role !== 'builder') return assert.fail(`a builder resumes, not a ${w2.spec.role}`)
    assert.equal(w2.spec.stepId, 's1')
    assert.equal(w2.spec.attempt, 1)
    assert.match(w2.spec.context, /patched the retry loop/)
    assert.match(w2.spec.context, /Already queued for approval/)
    assert.ok(w2.spec.context.includes(`#${shortActionId(rec.id)}`), 'the held action is named as the hold names it')
    const st = await stepOf(h2, g.id, 's1')
    assert.equal(st.attempts, 1)
    assert.equal(st.sessionId, w2.sessionId)
    const oldRow = (await h2.store.goals.sessions(g.id)).find((r) => r.sessionId === w.sessionId)!
    assert.notEqual(oldRow.endedAt, null, 'the killed session is closed')

    // The new worker makes the same call: the hold names the action already filed.
    assert.equal(idx.find(g.id, 'Bash', { command: `${args.command}  ` }), rec.id)
    assert.equal(idx.find(g.id, 'Bash', { command: 'gh pr create --title "Something else"' }), null)
    assert.equal((await h2.store.actions.list()).length, 1, 'one action on file')
    assert.deepEqual(await goalHeldActions(h2.d, g.id), [{ id: rec.id, summary: rec.summary, status: 'needs_you' }])

    // And it finishes the step: the run carries on as if nothing happened.
    await workerFinishes(h2, g.id, 's1')
    assert.equal((await stepOf(h2, g.id, 's1')).status, 'done')
    assert.equal(h2.last().spec.role, 'lead')
  }),
)

test(
  'steering: a question waits on you and the answer wakes the lead; take over and hand back',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await approved(h)
    const lead = h.last()
    await goalAskUserOp(h.d, { goalId: g.id, sessionId: lead.sessionId }, { question: 'Retry 3 or 5 times?', recommended: '3', options: ['3', '5'] })
    await goalSessionEndedOp(h.d, h.eng, { goalId: g.id, sessionId: lead.sessionId })
    await h.settle()
    assert.equal(await stateOf(h, g.id), 'waiting_you')
    const got = await goalGetOp(h.d, g.id)
    assert.deepEqual(got.ask && got.ask.kind === 'ask' && got.ask.options, ['3', '5'])

    await goalAnswerOp(h.d, h.eng, { goalId: g.id, text: '5' })
    await h.settle()
    assert.equal(await stateOf(h, g.id), 'running')
    const woke = h.last()
    assert.equal(woke.spec.role, 'lead')
    if (woke.spec.role === 'lead') assert.match(woke.spec.prompt, /5/)

    // Only the goal's live lead may use its tools.
    await assert.rejects(goalDispatchWorkerOp(h.d, { goalId: g.id, sessionId: lead.sessionId }, { stepId: 's1', brief: 'x' }), /isn't the goal's lead/)

    const stopped: string[] = []
    const eng = { ...h.eng, stopSessions: async (id: string) => void stopped.push(id) }
    await goalTakeOverOp(h.d, eng, { goalId: g.id })
    assert.equal(await stateOf(h, g.id), 'paused')
    assert.deepEqual(stopped, [g.id])
    // The stopped session ends after the move: it only closes its row.
    await goalSessionEndedOp(h.d, eng, { goalId: g.id, sessionId: woke.sessionId, error: 'stopped: you took over' })
    await h.settle()
    assert.equal(await stateOf(h, g.id), 'paused')

    await goalMessageOp(h.d, eng, { goalId: g.id, text: 'renamed the helper' })
    assert.equal(await stateOf(h, g.id), 'paused', 'a message to a paused goal waits for its next wake')
    await goalHandBackOp(h.d, eng, { goalId: g.id })
    await h.settle()
    assert.equal(await stateOf(h, g.id), 'running')
    const back = h.last()
    assert.equal(back.spec.role, 'lead')
    if (back.spec.role === 'lead') {
      assert.match(back.spec.prompt, /renamed the helper/)
      assert.match(back.spec.prompt, /worktree/)
    }
  }),
)

// ---------------------------------------------------------------------------
// M6: side-by-side workers
// ---------------------------------------------------------------------------

const PARALLEL = {
  summary: 'Two independent fixes, then a review.',
  doneWhen: 'both fixes are in and reviewed',
  steps: [
    { id: 'a', title: 'Fix the parser', type: 'agent', role: 'builder', doneWhen: 'parser tests pass' },
    { id: 'b', title: 'Fix the docs', type: 'agent', role: 'builder', doneWhen: 'docs build' },
    { id: 'r', title: 'Review both', type: 'agent', role: 'reviewer', dependsOn: ['a', 'b'], doneWhen: 'no open findings' },
  ],
  team: [{ role: 'builder', count: 2, why: 'two independent workstreams' }],
}

/** A goal on PARALLEL whose run lead dispatched a and b and ended its turn. */
async function bothDispatched(h: H): Promise<Goal> {
  const { goal } = await goalCreateOp(h.d, { title: 'Two fixes', doneWhen: PARALLEL.doneWhen })
  await h.settle()
  const created = (await h.store.goals.events(goal.id)).find((e) => e.kind === 'created')!
  await goalLeadStartedOp(h.d, goal.id, 'draft-p')
  await goalProposePlanOp(h.d, { goalId: goal.id, plan: PARALLEL, sessionId: 'draft-p' })
  await goalLeadSettledOp(h.d, { goalId: goal.id, seq: created.seq, sessionId: 'draft-p' })
  await goalApproveOp(h.d, { goalId: goal.id })
  await h.settle()
  const lead = h.last()
  assert.equal(lead.spec.role, 'lead')
  await goalDispatchWorkerOp(h.d, { goalId: goal.id, sessionId: lead.sessionId }, { stepId: 'a', brief: 'do a' })
  await goalDispatchWorkerOp(h.d, { goalId: goal.id, sessionId: lead.sessionId }, { stepId: 'b', brief: 'do b' })
  await goalSessionEndedOp(h.d, h.eng, { goalId: goal.id, sessionId: lead.sessionId, costUsd: 0.1 })
  await h.settle()
  return goal
}

const finish = async (h: H, goalId: string, w: Started) => {
  assert.ok(w.spec.role !== 'lead')
  await goalLogAppendOp(h.d, { goalId, sessionId: w.sessionId, stepId: w.spec.stepId, role: w.spec.role, outcome: 'done', text: 'finished' })
  await goalSessionEndedOp(h.d, h.eng, { goalId, sessionId: w.sessionId, costUsd: 0.2 })
  await h.settle()
}

test(
  'M6: two independent steps run side by side, each on its own branch, and the lead wakes after both',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await bothDispatched(h)
    const workers = h.started.filter((s) => s.goalId === g.id && s.spec.role === 'builder')
    assert.deepEqual(workers.map((w) => w.spec.role !== 'lead' && w.spec.stepId), ['a', 'b'])
    assert.ok(workers.every((w) => w.spec.role !== 'lead' && w.spec.worktree === 'child'))
    const got = await goalGetOp(h.d, g.id)
    assert.deepEqual(got.team.map((m) => m.stepId).sort(), ['a', 'b'])

    const before = h.started.length
    await finish(h, g.id, workers[0])
    assert.equal(h.started.length, before, 'the lead waits for the other worker')
    assert.equal((await stepOf(h, g.id, 'a')).status, 'done')
    assert.equal(await stateOf(h, g.id), 'running')
    await finish(h, g.id, workers[1])
    assert.equal(h.last().spec.role, 'lead')
    assert.equal(h.started.length, before + 1)
  }),
)

test(
  'M6: side-by-side workers stop at the session cap; the next starts when a slot frees',
  withDir(async (dir) => {
    const h = harness(dir)
    await h.store.config.set('goals.maxParallel', 1)
    const g = await bothDispatched(h)
    const workers = () => h.started.filter((s) => s.goalId === g.id && s.spec.role === 'builder')
    assert.equal(workers().length, 1)
    await finish(h, g.id, workers()[0])
    assert.equal(workers().length, 2, 'the second dispatched step takes the freed slot')
    await finish(h, g.id, workers()[1])
    assert.equal(h.last().spec.role, 'lead')
  }),
)

test(
  'M6: a plan without a team section runs one worker at a time',
  withDir(async (dir) => {
    const h = harness(dir)
    const g = await approved(h)
    const lead = h.last()
    await goalDispatchWorkerOp(h.d, { goalId: g.id, sessionId: lead.sessionId }, { stepId: 's1', brief: 'do s1' })
    await goalSessionEndedOp(h.d, h.eng, { goalId: g.id, sessionId: lead.sessionId })
    await h.settle()
    const w = h.last().spec
    assert.deepEqual(w.role !== 'lead' && [w.role, w.worktree], ['builder', 'goal'])
  }),
)
