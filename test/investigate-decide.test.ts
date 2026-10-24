/**
 * Investigate stops at a decision (server/playbooks/ops.ts): "Do it" turns the
 * recommendation into the item's plan and queues the change; "Look again"
 * needs a note and queues a fresh investigation. Neither moves a task that
 * isn't a waiting decision.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ItemTask, NewTask } from '../core/work/tasks.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
process.env.JUNIOR_HOME = mkdtempSync(path.join(os.tmpdir(), 'junior-decide-'))
const { goAheadOp, lookAgainOp } = await import('../server/playbooks/ops.js')
const { PLAYBOOK_STEPS, playbookOfStep } = await import('../core/rules/rules.js')

function runtime(task: Partial<ItemTask>) {
  const tasks = new Map<string, ItemTask>()
  const t = { id: 't1', itemId: 'manual:1', title: 'Add Inbox to PAGE_TABS', owner: 'you', state: 'waiting', why: 'playbook', step: 'decide', attempts: 0, createdAt: 1, input: { artifactId: 'a1', recommendation: 'Add Inbox to PAGE_TABS' }, ...task } as ItemTask
  tasks.set(t.id, t)
  const added: NewTask[] = []
  const plans: string[] = []
  const decisions: string[] = []
  const rt = {
    meta: { id: 'w' },
    taskPumping: true, // keep the pump from running
    artifacts: { read: async (id: string) => (id === 'a1' ? { artifact: { id }, body: '## Options\n1. Add it' } : null) },
    store: {
      tasks: {
        get: async (id: string) => tasks.get(id) ?? null,
        move: async (id: string, state: ItemTask['state'], patch: Partial<ItemTask>) => {
          const cur = tasks.get(id)
          if (!cur) return null
          const next = { ...cur, ...patch, state }
          tasks.set(id, next)
          return next
        },
        add: async (n: NewTask) => {
          added.push(n)
          return { ...n, id: `n${added.length}`, state: n.state ?? 'queued', attempts: 0, createdAt: 2 } as ItemTask
        },
      },
      items: {
        setPlan: async (_id: string, plan: string) => void plans.push(plan),
        addDecision: async (_id: string, d: { text: string }) => void decisions.push(d.text),
      },
    },
    clients: new Set(),
  } as unknown as WorkspaceRuntime
  return { rt, tasks, added, plans, decisions }
}

test('do it: the recommendation and the brief become the plan, and the change is queued', async () => {
  const { rt, tasks, added, plans, decisions } = runtime({})
  const fix = await goAheadOp(rt, 't1', {})
  assert.equal(tasks.get('t1')!.state, 'done')
  assert.equal(fix.step, 'debug-fix')
  assert.equal(added[0]!.owner, 'junior')
  assert.match(plans[0]!, /^Go with the recommendation: Add Inbox to PAGE_TABS/)
  assert.match(plans[0]!, /## Options/)
  assert.deepEqual(decisions, ['Do it: Add Inbox to PAGE_TABS'])
})

test('do it with a note: the note goes in the plan and on to the change', async () => {
  const { rt, added, plans } = runtime({})
  await goAheadOp(rt, 't1', { note: 'go with option 2' })
  assert.match(plans[0]!, /The user's note \(it wins over the brief\): go with option 2/)
  assert.deepEqual(added[0]!.input, { note: 'go with option 2' })
})

test('look again needs a note, then investigates afresh', async () => {
  const { rt, tasks, added, decisions } = runtime({})
  await assert.rejects(lookAgainOp(rt, 't1', {}), /say what/)
  assert.equal(tasks.get('t1')!.state, 'waiting')
  const again = await lookAgainOp(rt, 't1', { note: 'check the phone layout too' })
  assert.equal(tasks.get('t1')!.state, 'skipped')
  assert.equal(again.step, 'investigate')
  assert.equal(added.length, 1)
  assert.deepEqual(decisions, ['Look again: check the phone layout too'])
})

test('only a waiting decision can be decided', async () => {
  const { rt } = runtime({ state: 'done' })
  await assert.rejects(goAheadOp(rt, 't1', {}), /only a waiting decision/)
  const other = runtime({ step: 'approve-plan' })
  await assert.rejects(goAheadOp(other.rt, 't1', {}), /only a waiting decision/)
})

test('the decision belongs to the investigate playbook', () => {
  assert.deepEqual(PLAYBOOK_STEPS.investigate, ['investigate', 'decide'])
  assert.equal(playbookOfStep('decide'), 'investigate')
})
