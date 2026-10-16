/**
 * Plan validation and plan.md (core/goals/plan.ts): rejected, never repaired;
 * plan.md renders deterministically and reads back to the same plan.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanMd, planFrom, renderPlanMd, samePlan, teamSize } from '../core/goals/plan.js'
import { blockFromRecipe, roleOf } from '../core/goals/blocks.js'
import { parseRecipe } from '../core/teams/recipe.js'
import { SHIPPED_RECIPES } from '../server/team-recipes.js'

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

// ---------------------------------------------------------------------------
// M6: workflow blocks and the team section
// ---------------------------------------------------------------------------

const BUILD = blockFromRecipe('build', parseRecipe('build', SHIPPED_RECIPES.build!).recipe!)

test('a team recipe reads as a workflow block: who does each step becomes a role', () => {
  assert.equal(BUILD.name, 'build')
  assert.deepEqual(
    BUILD.steps.map((s) => [s.id, s.type, s.role]),
    [
      ['build', 'agent', 'builder'],
      ['checks', 'agent', 'tester'],
      ['verify', 'agent', 'reviewer'],
      ['final', 'agent', 'reviewer'],
      ['report', 'agent', 'lead'],
    ],
  )
  assert.equal(roleOf({ agent: 'lead', output: 'change' }), 'builder')
  const gated = parseRecipe('g', SHIPPED_RECIPES.build!.replace('output: change', 'output: change\n    gate: you')).recipe!
  const b = blockFromRecipe('g', gated)
  assert.deepEqual(b.steps.slice(0, 2).map((s) => [s.id, s.type, s.gate?.evaluator ?? null]), [['build', 'agent', null], ['build-ok', 'gate', 'user']])
})

test('a block step expands into the block\'s steps in a chain, and its dependents wait on the last', () => {
  const r = planFrom(
    plan({
      steps: [
        step({ id: 'prep' }),
        { id: 'fix', title: 'Fix it', type: 'block', block: 'build', dependsOn: ['prep'], doneWhen: 'fixed' },
        step({ id: 'ship', dependsOn: ['fix'] }),
      ],
    }),
    goal,
    { blocks: [BUILD] },
  )
  assert.ok(r.ok, r.ok ? '' : r.error)
  if (!r.ok) return
  assert.deepEqual(
    r.plan.steps.map((s) => [s.id, s.dependsOn]),
    [
      ['prep', []],
      ['fix.build', ['prep']],
      ['fix.checks', ['fix.build']],
      ['fix.verify', ['fix.checks']],
      ['fix.final', ['fix.verify']],
      ['fix.report', ['fix.final']],
      ['ship', ['fix.report']],
    ],
  )
  // plan.md holds the expanded steps, so the user reviews what will run.
  assert.ok(samePlan(parsePlanMd(renderPlanMd({ id: 'g1', title: 'Goal' }, r.plan, 1)), r.plan))
  assert.match(err(plan({ steps: [{ id: 'x', title: 'X', type: 'block', block: 'deploy', doneWhen: 'd' }] })), /"deploy" isn't a workflow block \(there are "shepherd-pr"\)/)
  const long = planFrom(plan({ steps: [{ id: 'a'.repeat(36), title: 'X', type: 'block', block: 'build', doneWhen: 'd' }] }), goal, { blocks: [BUILD] })
  assert.ok(!long.ok && /over 40 characters/.test(long.error))
})

test('the team section is capped by the max team size; the lead seat does not count', () => {
  const team = [
    { role: 'builder', count: 2, why: 'parser and docs are independent' },
    { role: 'reviewer', count: 1, why: 'one review at the end' },
    { role: 'lead', count: 1, why: 'runs it' },
  ]
  const ok = planFrom(plan({ team }), goal, { maxTeam: 3 })
  assert.ok(ok.ok)
  if (ok.ok) assert.equal(teamSize(ok.plan.team), 3)
  const over = planFrom(plan({ team }), goal, { maxTeam: 2 })
  assert.ok(!over.ok && /asks for 3 workers at once, over the user's max team size of 2/.test(over.error))
  assert.ok(planFrom(plan({ team }), goal).ok, 'no cap given (a stored plan read back) refuses nothing')
})
