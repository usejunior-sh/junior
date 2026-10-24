/**
 * The goal store (core/store/sqlite-goals.ts). The old goals engine is gone,
 * but its goal_* tables stay as history, so the store that reads them must
 * keep working: create dedupes on key, move is first-writer-wins, and steps
 * and gates survive a reopen unchanged.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Gate } from '../core/goals/types.js'

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

test('steps and gates survive a store reopen unchanged', withDir(async (dir) => {
  const file = path.join(dir, 'junior.db')
  const store = openSqliteStore(file)
  const { goal } = await store.goals.create({ id: 'g1', title: 'T', doneWhen: 'D', horizon: 'today', sourceItemId: null, key: null, projectId: null, budget: { usd: null, minutes: null }, priority: 0 }, 1)
  const gate: Gate = { id: 'gate-1', goalId: goal.id, stepId: 's2', evaluator: 'ai', condition: 'CI green', connectors: ['github'], status: 'open', refs: ['#12'], armedAt: 5, nextCheckAt: 10, checks: 0, checkEveryMs: null, deadlineAt: 99, confirmationsNeeded: 2, confirmationsSeen: 0, lastVerdict: { verdict: 'not_met', evidence: 'pending', checkAgainIn: null }, itemId: null, settledAt: null }
  await store.goals.putGate(gate)
  await store.goals.putStep({ goalId: goal.id, stepId: 's1', status: 'done', attempts: 1, sessionId: 'w-1', startedAt: 3, endedAt: 4, updatedAt: 4 })
  const before = await store.goals.get(goal.id)
  const stepsBefore = await store.goals.steps(goal.id)
  await store.close()

  const again = openSqliteStore(file)
  assert.deepEqual(await again.goals.get(goal.id), before)
  assert.deepEqual(await again.goals.steps(goal.id), stepsBefore)
  assert.deepEqual(await again.goals.gate('gate-1'), gate)
  await again.close()
}))
