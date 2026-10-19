/**
 * The server's side of Ultracode runs (server/session/workflow-tasks.ts): which
 * runs are still going, when a result holds the turn for them, and which
 * progress frames the log keeps. Shapes are copied from a real run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  endedTask,
  keepProgress,
  noteWorkflowTask,
  owedProgress,
  PROGRESS_PERSIST_MS,
  progressSignature,
  snapshotAgentIds,
  throttleProgress,
  WorkflowTurns,
} from '../server/session/workflow-tasks.js'
import { claudeEvent } from '../server/providers/claude-events.js'
import type { SdkMessage, SessionEvent, WorkflowProgressEntry } from '../shared/protocol.js'

const TASK = 'wntvlfsk4'
const sys = (subtype: string, extra: Partial<SdkMessage> = {}): SdkMessage => ({ type: 'system', subtype, task_id: TASK, ...extra })
const started = sys('task_started', { task_type: 'local_workflow', tool_use_id: 'toolu_1', workflow_name: 'alpha-beta' })
const agent = (index: number, state: string, agentId?: string): WorkflowProgressEntry => ({
  type: 'workflow_agent',
  index,
  label: index === 1 ? 'alpha' : 'beta',
  phaseIndex: 1,
  phaseTitle: 'Run',
  ...(agentId ? { agentId, startedAt: 1792423867940 } : {}),
  state,
})
const progress = (snapshot?: WorkflowProgressEntry[]) =>
  sys('task_progress', { usage: { total_tokens: 18008 }, ...(snapshot ? { workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'Run' }, ...snapshot] } : {}) })

test('a workflow task counts from task_started until its notification', () => {
  const running = new Set<string>()
  assert.equal(noteWorkflowTask(running, started), true)
  assert.equal(noteWorkflowTask(running, started), false)
  assert.deepEqual([...running], [TASK])
  assert.equal(noteWorkflowTask(running, progress([agent(1, 'start')])), false)
  assert.equal(noteWorkflowTask(running, sys('task_notification', { status: 'completed' })), true)
  assert.equal(running.size, 0)
})

test('task_updated ends it only on a terminal status', () => {
  const running = new Set<string>()
  noteWorkflowTask(running, started)
  assert.equal(noteWorkflowTask(running, sys('task_updated', { patch: { is_backgrounded: true } })), false)
  assert.equal(running.size, 1)
  assert.equal(noteWorkflowTask(running, sys('task_updated', { patch: { status: 'completed', end_time: 1 } })), true)
  assert.equal(running.size, 0)
  // and the notification after it changes nothing
  assert.equal(noteWorkflowTask(running, sys('task_notification', { status: 'completed' })), false)
})

test('other task types never count', () => {
  const running = new Set<string>()
  assert.equal(noteWorkflowTask(running, sys('task_started', { task_type: 'local_agent' })), false)
  assert.equal(noteWorkflowTask(running, sys('task_started', { task_type: 'local_bash' })), false)
  assert.equal(noteWorkflowTask(running, { type: 'assistant' }), false)
  assert.equal(running.size, 0)
})

test('background_tasks_changed replaces the set: a missed edge cannot wedge it', () => {
  const running = new Set(['stale'])
  const level = (tasks: unknown[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks }) as SdkMessage
  assert.equal(noteWorkflowTask(running, level([{ task_id: TASK, task_type: 'local_workflow', description: 'x' }, { task_id: 'b', task_type: 'local_bash' }])), true)
  assert.deepEqual([...running], [TASK])
  assert.equal(noteWorkflowTask(running, level([{ task_id: TASK, task_type: 'local_workflow' }])), false)
  assert.equal(noteWorkflowTask(running, level([{ task_id: 'w', task_type: 'local_workflow', ambient: true }])), true)
  assert.equal(running.size, 0)
})

test('endedTask names the task a terminal message ends', () => {
  assert.equal(endedTask(sys('task_notification', { status: 'stopped' })), TASK)
  assert.equal(endedTask(sys('task_updated', { patch: { status: 'failed' } })), TASK)
  assert.equal(endedTask(sys('task_updated', { patch: { status: 'running' } })), undefined)
  assert.equal(endedTask(progress()), undefined)
})

test('the progress signature is the agents, their states and whether they left the queue, nothing else', () => {
  const a = progressSignature(progress([agent(1, 'start', 'a1'), agent(2, 'start')]).workflow_progress!)
  assert.equal(progressSignature([{ ...agent(1, 'start', 'a1'), tokens: 999 } as WorkflowProgressEntry, agent(2, 'start')]), a)
  assert.notEqual(progressSignature([agent(1, 'done', 'a1'), agent(2, 'start')]), a)
  // beta gets a slot: still 'start', but now it has an id and a start time (the probe's first two snapshots)
  assert.notEqual(progressSignature([agent(1, 'start', 'a1'), agent(2, 'start', 'b2')]), a)
})

test('a bare frame kept on the clock puts the newest skipped snapshot in ahead of it', () => {
  const t0 = 1_000_000
  const ev = (m: SdkMessage): SessionEvent => ({ kind: 'sdk', message: m })
  const s1 = progress([agent(1, 'start', 'a1'), agent(2, 'start')])
  let r = throttleProgress(undefined, s1, ev(s1), t0)
  assert.equal(r.keep, true)
  // a snapshot with the same agents, soon after: owed
  const s2 = progress([agent(1, 'start', 'a1'), agent(2, 'start')])
  const e2 = ev(s2)
  r = throttleProgress(r.next, s2, e2, t0 + 1000)
  assert.equal(r.keep, false)
  // a bare frame skipped after it keeps the snapshot owed
  const b1 = progress()
  const eb1 = ev(b1)
  r = throttleProgress(r.next, b1, eb1, t0 + 2000)
  assert.equal(r.keep, false)
  assert.deepEqual(owedProgress(r.next), [e2, eb1])
  // the next bare frame is kept on the clock, with the snapshot ahead of it
  const b2 = progress()
  r = throttleProgress(r.next, b2, ev(b2), t0 + PROGRESS_PERSIST_MS)
  assert.equal(r.keep, true)
  assert.deepEqual(r.before, [e2])
  assert.deepEqual(owedProgress(r.next), [])
})

test('a result holds the turn while a run goes on, and through the turn it ended in (the probe)', () => {
  const init: SdkMessage = { type: 'system', subtype: 'init', session_id: 's' }
  const t = new WorkflowTurns()
  // launch turn: the run starts and ends before the turn's own result
  t.note(init)
  assert.equal(t.note(started), true)
  assert.equal(t.note(sys('task_updated', { patch: { status: 'completed', end_time: 1 } })), true)
  t.note(sys('task_notification', { status: 'completed' }))
  t.note({ type: 'system', subtype: 'background_tasks_changed', tasks: [] } as SdkMessage)
  assert.equal(t.holdAtResult(), true)
  // the SDK's wake-up turn closes it
  t.note(init)
  assert.equal(t.holdAtResult(), false)
})

test('a run that outlives its launch holds every result until the wake-up after it ends', () => {
  const init: SdkMessage = { type: 'system', subtype: 'init', session_id: 's' }
  const t = new WorkflowTurns()
  t.note(init)
  t.note(started)
  assert.equal(t.holdAtResult(), true)
  // your message in the meantime: its own turn, still held
  t.note(init)
  assert.equal(t.holdAtResult(), true)
  // the run ends while idle; the wake-up's result closes it
  t.note(sys('task_notification', { status: 'completed' }))
  t.note(init)
  assert.equal(t.holdAtResult(), false)
  // and a turn with no run in it never holds
  t.note(init)
  assert.equal(t.holdAtResult(), false)
})

test('the log keeps the first frame, any state change, and one every few seconds', () => {
  const t0 = 1_000_000
  let r = keepProgress(undefined, progress([agent(1, 'start')]), t0)
  assert.equal(r.keep, true)
  let mark = r.mark
  // same states, soon after: skipped, and the clock is not reset
  r = keepProgress(mark, progress([agent(1, 'start')]), t0 + 1000)
  assert.equal(r.keep, false)
  assert.equal(r.mark.at, t0)
  mark = r.mark
  // a frame with no snapshot keeps the last signature
  r = keepProgress(mark, progress(), t0 + 2000)
  assert.equal(r.keep, false)
  assert.equal(r.mark.sig, mark.sig)
  // a new agent: kept
  r = keepProgress(mark, progress([agent(1, 'start'), agent(2, 'start')]), t0 + 2500)
  assert.equal(r.keep, true)
  mark = r.mark
  // an agent finishing: kept
  r = keepProgress(mark, progress([agent(1, 'done'), agent(2, 'start')]), t0 + 2600)
  assert.equal(r.keep, true)
  mark = r.mark
  // nothing changes, but the clock runs out
  r = keepProgress(mark, progress([agent(1, 'done'), agent(2, 'start')]), t0 + 2600 + PROGRESS_PERSIST_MS)
  assert.equal(r.keep, true)
})

test('snapshot agent ids are read off a progress frame', () => {
  assert.deepEqual(snapshotAgentIds(progress([agent(1, 'start', 'ad09cddd29f8964ed'), agent(2, 'queued')])), ['ad09cddd29f8964ed'])
  assert.deepEqual(snapshotAgentIds(progress()), [])
})

test('init carries its tools list, so a session can tell Ultracode is unavailable', () => {
  const ev = claudeEvent({ type: 'system', subtype: 'init', session_id: 's', tools: ['Read', 'Workflow'] })
  assert.equal(ev.kind, 'started')
  if (ev.kind !== 'started') return
  assert.deepEqual(ev.tools, ['Read', 'Workflow'])
})
