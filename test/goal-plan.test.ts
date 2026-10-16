/**
 * Plan validation and plan.md (core/goals/plan.ts): rejected, never repaired;
 * plan.md renders deterministically and reads back to the same plan.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanMd, planFrom, renderPlanMd, samePlan } from '../core/goals/plan.js'

const goal = { horizon: 'until_done' as const, budget: { usd: 10, minutes: null } }
const step = (o: Record<string, unknown> = {}) => ({ id: 's1', title: 'Build', type: 'agent', role: 'builder', doneWhen: 'tests pass', ...o })
const plan = (o: Record<string, unknown> = {}) => ({ summary: 'S', doneWhen: 'D', steps: [step()], ...o })

const err = (raw: unknown) => {
  const r = planFrom(raw, goal)
  assert.equal(r.ok, false)
  return r.ok ? '' : r.error
}

test('a minimal plan fills what the goal supplies', () => {
  const r = planFrom(plan(), goal)
  assert.ok(r.ok)
  assert.deepEqual(r.plan, {
    summary: 'S',
    doneWhen: 'D',
    horizon: 'until_done',
    steps: [{ id: 's1', title: 'Build', type: 'agent', role: 'builder', dependsOn: [], doneWhen: 'tests pass', gate: null, block: null }],
    team: [],
    budget: { usd: 10, minutes: null },
    mayDo: [],
    policies: [],
    models: null,
  })
})

test('bad plans are rejected with the reason', () => {
  assert.match(err(null), /must be an object/)
  assert.match(err(plan({ steps: [] })), /at least one step/)
  assert.match(err(plan({ bogus: 1 })), /unknown key "bogus"/)
  assert.match(err(plan({ steps: [step({ extra: true })] })), /steps\[0\]: unknown key "extra"/)
  assert.match(err(plan({ steps: [step({ role: undefined })] })), /role must be one of/)
  assert.match(err(plan({ steps: [step({ type: 'gate', role: undefined })] })), /gate must be an object/)
  assert.match(err(plan({ steps: [step({ gate: { evaluator: 'ai', condition: 'c' } })] })), /gate is only for gate steps/)
  assert.match(err(plan({ steps: [step({ type: 'gate', role: undefined, gate: { evaluator: 'ai', condition: 'c', deadline: 'soon' } })] })), /duration/)
  assert.match(err(plan({ steps: [step({ type: 'gate', role: undefined, gate: { evaluator: 'ai', condition: 'c', confirmations: 9 } })] })), /confirmations/)
  assert.match(err(plan({ steps: [step({ type: 'block', role: undefined })] })), /block must be a non-empty string/)
  assert.match(err(plan({ steps: [step(), step()] })), /used twice/)
  assert.match(err(plan({ steps: [step({ dependsOn: ['s9'] })] })), /depends on "s9", which isn't a step/)
  assert.match(err(plan({ steps: [step({ dependsOn: ['s1'] })] })), /depends on itself/)
  assert.match(err(plan({ steps: [step({ dependsOn: ['s2'] }), step({ id: 's2', dependsOn: ['s1'] })] })), /cycle/)
  assert.match(err(plan({ budgetUsd: 1000 })), /over the cap/)
  assert.match(err(plan({ team: [{ role: 'builder', count: 0, why: 'w' }] })), /count/)
  assert.match(err(plan({ horizon: 'later' })), /horizon/)
})

test('plan.md renders the same bytes for the same plan and reads back to it', () => {
  const r = planFrom(
    plan({
      steps: [step(), { id: 'g', title: 'CI', type: 'gate', dependsOn: ['s1'], doneWhen: 'green', gate: { evaluator: 'user', condition: 'looks right', confirmations: 2 } }],
      team: [{ role: 'builder', count: 1, why: 'small' }],
      mayDo: ['run tests'],
      models: { worker: 'haiku' },
      budgetMinutes: 90,
    }),
    goal,
  )
  assert.ok(r.ok)
  const md = renderPlanMd({ id: 'g1', title: 'Goal' }, r.plan, 1)
  assert.equal(renderPlanMd({ id: 'g1', title: 'Goal' }, r.plan, 1), md)
  assert.match(md, /\*\*Budget:\*\* \$10 · 90 min/)
  assert.match(md, /Waits for: looks right/)
  assert.deepEqual(parsePlanMd(md), r.plan)
  assert.equal(parsePlanMd('# no block'), null)
  assert.ok(samePlan(parsePlanMd(md), r.plan))
  assert.ok(!samePlan(r.plan, { ...r.plan, summary: 'other' }))
})
