/**
 * M1: the goal store (core/store/sqlite-goals.ts), the ledger folder
 * (core/goals/ledger.ts) and the goal ops every door goes through
 * (server/goals.ts). A goal and its ledger survive a store reopen unchanged;
 * every goal_* write is idempotent on a repeat call; the ledger commits only
 * its own folder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { GoalLedger } from '../core/goals/ledger.js'
import { goalCreateOp, goalGetOp, goalHandoffWriteOp, goalListOp, goalLogAppendOp, goalProposePlanOp, type GoalDeps } from '../server/goals.js'
import { LOG_ROLLOVER_BYTES, type Gate } from '../core/goals/types.js'

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-store-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function gitRepo(dir: string): string {
  const root = path.join(dir, 'artifacts')
  execFileSync('mkdir', ['-p', root])
  git(root, 'init', '-q')
  return root
}

let clock = 1_000_000
function deps(dir: string, root: string, store = openSqliteStore(path.join(dir, 'junior.db'))): GoalDeps & { store: ReturnType<typeof openSqliteStore>; seen: string[] } {
  const seen: string[] = []
  const now = () => ++clock
  return { store, ledger: new GoalLedger(root, now), now, defaultProjectId: async () => null, changed: (id) => seen.push(id), emit: () => {}, seen }
}

const PLAN = {
  summary: 'Fix the flaky test, then wait for CI.',
  doneWhen: 'CI is green on main',
  steps: [
    { id: 's1', title: 'Fix the test', type: 'agent', role: 'builder', doneWhen: 'the test passes 20 times in a row' },
    { id: 's2', title: 'CI green', type: 'gate', dependsOn: ['s1'], doneWhen: 'checks pass', gate: { evaluator: 'ai', condition: 'CI is green on the head commit', checkEvery: '10m' } },
  ],
  team: [{ role: 'builder', count: 1, why: 'one small fix' }],
  mayDo: ['run the tests'],
}

test('store: create dedupes on key, move is first-writer-wins and logs the transition', withDir(async (dir) => {
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const base = { title: 'T', doneWhen: 'D', horizon: 'today' as const, sourceItemId: 'manual:1', key: 'manual:1', projectId: null, budget: { usd: 5, minutes: null }, priority: 0 }
  const a = await store.goals.create({ ...base, id: 'g1' }, 10)
  assert.equal(a.created, true)
  assert.equal(a.goal.state, 'draft_plan')
  const b = await store.goals.create({ ...base, id: 'g2' }, 11)
  assert.equal(b.created, false)
  assert.equal(b.goal.id, 'g1')
  assert.equal((await store.goals.list()).length, 1)

  assert.equal(await store.goals.move('g1', 'queued', 'running', { actor: 'engine', sessionId: null, detail: null }, 12), false)
  assert.equal(await store.goals.move('g1', 'draft_plan', 'plan_ready', { actor: 'engine', sessionId: 's', detail: { trigger: 'plan_proposed' } }, 13), true)
  assert.equal(await store.goals.move('g1', 'draft_plan', 'plan_ready', { actor: 'engine', sessionId: 's', detail: null }, 14), false)
  const evs = await store.goals.events('g1')
  assert.deepEqual(evs.map((e) => [e.seq, e.kind, e.from, e.to]), [[1, 'created', null, 'draft_plan'], [2, 'transition', 'draft_plan', 'plan_ready']])
  assert.deepEqual(evs[1]!.detail, { trigger: 'plan_proposed' })
  assert.equal((await store.goals.unhandled()).length, 2)
  await store.goals.markHandled('g1', 1, 20)
  assert.deepEqual((await store.goals.unhandled()).map((e) => e.seq), [2])
  assert.deepEqual((await store.goals.list({ states: ['plan_ready'] })).map((g) => g.id), ['g1'])
  assert.deepEqual(await store.goals.list({ states: ['done'] }), [])
  await store.close()
}))

test('a goal and its ledger survive a store reopen unchanged', withDir(async (dir) => {
  const root = gitRepo(dir)
  const d = deps(dir, root)
  const { goal } = await goalCreateOp(d, { title: 'Fix flaky CI', doneWhen: 'CI is green on main', horizon: 'today', budgetUsd: 20 })
  await goalProposePlanOp(d, { goalId: goal.id, plan: PLAN, sessionId: 'lead-1' })
  await goalLogAppendOp(d, { goalId: goal.id, sessionId: 'w-1', stepId: 's1', role: 'builder', outcome: 'done', text: 'Pinned the clock.', commits: ['abc123'], files: ['test/a.test.ts'], commands: [{ cmd: 'npm test', ok: true }] })
  await goalHandoffWriteOp(d, { goalId: goal.id, sessionId: 'w-1', done: 's1 fixed', next: 'arm the CI gate', watchOut: 'the retry flag' })
  const gate: Gate = { id: 'gate-1', goalId: goal.id, stepId: 's2', evaluator: 'ai', condition: 'CI green', connectors: ['github'], status: 'open', refs: ['#12'], armedAt: 5, nextCheckAt: 10, checks: 0, checkEveryMs: null, deadlineAt: 99, confirmationsNeeded: 2, confirmationsSeen: 0, lastVerdict: { verdict: 'not_met', evidence: 'pending', checkAgainIn: null }, itemId: null, settledAt: null }
  await d.store.goals.putGate(gate)
  await d.store.goals.putStep({ goalId: goal.id, stepId: 's1', status: 'done', attempts: 1, sessionId: 'w-1', startedAt: 3, endedAt: 4, updatedAt: 4 })
  const before = await goalGetOp(d, goal.id)
  const sessionsBefore = await d.store.goals.sessions(goal.id)
  assert.equal(before.goal.state, 'plan_ready')
  assert.equal(before.goal.planVersion, 1)
  assert.match(before.plan, /plan version 1\b/)
  assert.deepEqual(sessionsBefore.map((s) => s.planVersion), [1])
  assert.match(before.plan, /```json goal-plan/)
  assert.match(before.handoff, /arm the CI gate/)
  assert.match(before.log, /Pinned the clock\./)
  assert.deepEqual((await d.store.goals.dueGates(10)).map((g) => g.id), ['gate-1'])
  await d.store.close()

  const again = deps(dir, root)
  const after = await goalGetOp(again, goal.id)
  assert.deepEqual(after, before)
  assert.deepEqual(await again.store.goals.sessions(goal.id), sessionsBefore)
  assert.deepEqual(await again.store.goals.gate('gate-1'), gate)
  await again.store.close()
}))

test('goal_* writes are idempotent on repeat calls', withDir(async (dir) => {
  const root = gitRepo(dir)
  const d = deps(dir, root)
  const create = { title: 'Ship it', doneWhen: 'merged', sourceItemId: 'github:o/r#1' }
  const a = await goalCreateOp(d, create)
  const b = await goalCreateOp(d, create)
  assert.equal(a.outcome, 'created')
  assert.equal(b.outcome, 'existing')
  assert.equal(b.goal.id, a.goal.id)
  // No key: a live goal with the same title and done-when is the same goal.
  const c1 = await goalCreateOp(d, { title: 'Chat goal', doneWhen: 'x' })
  const c2 = await goalCreateOp(d, { title: 'Chat goal', doneWhen: 'x' })
  assert.equal(c2.outcome, 'existing')
  assert.equal(c2.goal.id, c1.goal.id)
  // …even when the two calls race (an MCP client retrying): the lookup is inside the insert's transaction.
  const race = await Promise.all([goalCreateOp(d, { title: 'Raced', doneWhen: 'y' }), goalCreateOp(d, { title: 'Raced', doneWhen: 'y' })])
  assert.deepEqual(race.map((r) => r.outcome).sort(), ['created', 'existing'])
  assert.equal(race[0].goal.id, race[1].goal.id)
  // A finished goal doesn't block starting the same one again.
  assert.ok(await d.store.goals.move(c1.goal.id, 'draft_plan', 'cancelled', { actor: 'engine', sessionId: null, detail: null }, 50))
  const c3 = await goalCreateOp(d, { title: 'Chat goal', doneWhen: 'x' })
  assert.equal(c3.outcome, 'created')
  assert.notEqual(c3.goal.id, c1.goal.id)
  assert.equal((await goalListOp(d)).goals.length, 4)

  const id = a.goal.id
  assert.equal((await goalProposePlanOp(d, { goalId: id, plan: PLAN })).outcome, 'proposed')
  const reordered = { mayDo: PLAN.mayDo, team: PLAN.team, steps: PLAN.steps, doneWhen: PLAN.doneWhen, summary: PLAN.summary }
  const repeat = await goalProposePlanOp(d, { goalId: id, plan: reordered })
  assert.equal(repeat.outcome, 'unchanged')
  assert.equal(repeat.goal.planVersion, 1)
  assert.equal((await d.store.goals.get(id))!.planVersion, 1)
  await assert.rejects(goalProposePlanOp(d, { goalId: id, plan: { ...PLAN, summary: 'another' } }), /can't plan proposed a goal that is plan_ready/)

  const entry = { goalId: id, sessionId: 'w-1', stepId: 's1', role: 'builder', text: 'did it' }
  assert.equal((await goalLogAppendOp(d, entry)).outcome, 'appended')
  assert.equal((await goalLogAppendOp(d, entry)).outcome, 'unchanged')
  assert.equal((await goalLogAppendOp(d, { ...entry, text: 'did it, better' })).outcome, 'revised')
  assert.equal((await goalLogAppendOp(d, { ...entry, text: 'did it, better' })).outcome, 'unchanged')
  const log = readFileSync(path.join(root, 'goals', id, 'log.md'), 'utf8')
  assert.equal(log.match(/<!-- goal-log /g)!.length, 2)
  assert.match(log, /did it\n[\s\S]*revised[\s\S]*did it, better/)

  const h = { goalId: id, sessionId: 'w-1', done: 'a', next: 'b' }
  assert.equal((await goalHandoffWriteOp(d, h)).outcome, 'written')
  assert.equal((await goalHandoffWriteOp(d, h)).outcome, 'unchanged')

  const events = await d.store.goals.events(id)
  assert.deepEqual(events.map((e) => e.kind), ['created', 'plan_proposed', 'transition'])
  // Commits: plan, log ×2, handoff — repeats wrote nothing.
  assert.equal(git(root, 'log', '--oneline').trim().split('\n').length, 4)
  await d.store.close()
}))

test('ledger commits only the goal folder and warns after repeated failures', withDir(async (dir) => {
  const root = gitRepo(dir)
  writeFileSync(path.join(root, 'stray.md'), 'not the goal')
  git(root, 'add', 'stray.md')
  const d = deps(dir, root)
  const { goal } = await goalCreateOp(d, { title: 'T', doneWhen: 'D' })
  await goalHandoffWriteOp(d, { goalId: goal.id, sessionId: 's', done: 'a', next: 'b' })
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD').trim(), `goals/${goal.id}/handoff.md`)
  assert.match(git(root, 'status', '--porcelain'), /^A {2}stray\.md/m)

  // A broken repo: files are still written; the warning appears after 3 failures in a row.
  const broken = path.join(dir, 'broken')
  execFileSync('mkdir', ['-p', broken])
  writeFileSync(path.join(broken, '.git'), 'gitdir: /nonexistent/junior-test\n')
  const ledger = new GoalLedger(broken)
  for (let i = 1; i <= 3; i++) {
    assert.equal(ledger.warning('g'), null)
    await ledger.writeHandoff('g', { sessionId: 's', done: `step ${i}`, next: 'n', watchOut: null })
  }
  assert.match(ledger.warning('g') ?? '', /last 3 commits failed/)
  assert.match(readFileSync(path.join(broken, 'goals', 'g', 'handoff.md'), 'utf8'), /step 3/)
  await d.store.close()
}))

test('log.md rolls over past the cap; a repeat right after still writes nothing', withDir(async (dir) => {
  const root = gitRepo(dir)
  const ledger = new GoalLedger(root)
  const e = { sessionId: 's1', stepId: null, role: 'builder' as const, outcome: null, text: 'x'.repeat(LOG_ROLLOVER_BYTES + 10), commits: [], files: [], commands: [] }
  assert.equal(await ledger.appendLog('g', e), 'appended')
  const next = { ...e, sessionId: 's2', text: 'small' }
  assert.equal(await ledger.appendLog('g', next), 'appended')
  assert.deepEqual(readdirSync(path.join(root, 'goals', 'g')).sort(), ['log-001.md', 'log.md'])
  assert.ok(!readFileSync(path.join(root, 'goals', 'g', 'log.md'), 'utf8').includes('xxxx'))
  assert.equal(await ledger.appendLog('g', e), 'unchanged')
  assert.ok(existsSync(path.join(root, 'goals', 'g', 'log-001.md')))
}))

test('goal ops reject bad input instead of repairing it', withDir(async (dir) => {
  const root = gitRepo(dir)
  const d = deps(dir, root)
  await assert.rejects(goalCreateOp(d, { title: '', doneWhen: 'x' }), /title/)
  await assert.rejects(goalCreateOp(d, { title: 't', doneWhen: 'x', horizon: 'soon' }), /horizon/)
  await assert.rejects(goalCreateOp(d, { title: 't', doneWhen: 'x', projectId: 'nope' }), /no project/)
  const { goal } = await goalCreateOp(d, { title: 't', doneWhen: 'x' })
  await assert.rejects(goalProposePlanOp(d, { goalId: goal.id, plan: { ...PLAN, extra: 1 } }), /unknown key "extra"/)
  await assert.rejects(goalLogAppendOp(d, { goalId: goal.id, sessionId: '../x', role: 'builder', text: 't' }), /sessionId/)
  await assert.rejects(goalLogAppendOp(d, { goalId: goal.id, sessionId: 's', role: 'boss', text: 't' }), /role/)
  await assert.rejects(goalGetOp(d, 'missing'), /no goal "missing"/)
  assert.deepEqual(d.seen, [goal.id])
  await d.store.close()
}))
