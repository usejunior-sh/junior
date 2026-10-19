/**
 * The transcript's side of Ultracode (web/src/transcript.ts): a Workflow call is
 * one card, never a tool pill; per-turn cost over a revival carries on only
 * when the counters did; a turn whose window saw workflow agents spend says
 * so; and changesets are held the way the server holds them.
 * Shapes follow a real run (/tmp/ucprobe).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, type TranscriptItem } from '../web/src/transcript.js'
import type { SdkMessage, SessionEvent } from '../shared/protocol.js'

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
const you = (text: string): SessionEvent => ({ kind: 'local_user', text })
const turnEnd = (total: number) => sdk({ type: 'result', subtype: 'success', total_cost_usd: total, duration_ms: 1000, num_turns: 1 })
const launch = sdk({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_W', name: 'Workflow', input: { script: "export const meta = {\n  name: 'alpha-beta',\n}" } }] },
})
const receipt = sdk({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_W', content: 'Workflow launched in background. Task ID: t1' }] },
  tool_use_result: { status: 'async_launched', taskId: 't1', taskType: 'local_workflow', runId: 'wf_1' },
})
const started = sdk({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_W', task_type: 'local_workflow' })
const ended = sdk({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_W', status: 'completed' })
const say = (text: string) => sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } })

const metas = (items: TranscriptItem[]) => items.filter((i): i is Extract<TranscriptItem, { kind: 'meta' }> => i.kind === 'meta' && !!i.turn)

test('a Workflow call is one workflow card, not a tool pill', () => {
  const items = buildTranscript([you('go'), launch, receipt, started, turnEnd(0.1)])
  assert.deepEqual(
    items.filter((i) => i.kind === 'workflow'),
    [{ key: 'c1.0', kind: 'workflow', toolUseId: 'toolu_W' }],
  )
  assert.equal(items.some((i) => i.kind === 'tool' || i.kind === 'toolGroup'), false)
})

// Agents' spend lands in the next result, so the turn whose window saw it says so.
const spent = (tokens: number) => sdk({ type: 'system', subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_W', usage: { total_tokens: tokens } })
// Every turn opens with an init, the wake-up included.
const init = sdk({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })

test('a turn that saw workflow agents spend is marked, and so is one that closed with the run going', () => {
  const items = buildTranscript([init, you('go'), launch, receipt, started, spent(0), turnEnd(0.1), spent(36015), ended, init, say('done'), turnEnd(0.5)])
  const [first, wake] = metas(items)
  assert.equal(first.workflowSpend, true)
  assert.equal(wake.workflowSpend, true)
  assert.match(wake.stats ?? '', /\$0\.4000/)
})

test('a turn after the run ended, with no growth in its window, is not marked', () => {
  const items = buildTranscript([init, you('go'), launch, receipt, started, spent(500), ended, turnEnd(0.1), init, say('done'), turnEnd(0.2), init, you('next'), turnEnd(0.3)])
  assert.deepEqual(metas(items).map((m) => m.workflowSpend), [true, undefined, undefined])
})

// The order the QA report gave: approval, the run, its end, then the launch turn's result.
const ask = { kind: 'permission_request', id: 'p1', toolName: 'Workflow', input: {}, canAlwaysAllow: false } as SessionEvent
const allow = { kind: 'permission_resolved', id: 'p1', behavior: 'allow' } as SessionEvent
const completed = sdk({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } })
const notified = sdk({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_W', status: 'completed', usage: { total_tokens: 117793 } })

test('a run that ends inside its launching turn: a notification repeating the total is not growth', () => {
  const items = buildTranscript([
    init, you('go'), launch, ask, allow, started, spent(0), receipt, spent(88051), spent(117793), completed, notified, turnEnd(0.1582),
    init, say('done'), turnEnd(0.1774),
  ])
  const [first, wake] = metas(items)
  assert.equal(first.workflowSpend, true)
  assert.equal(wake.workflowSpend, undefined)
  assert.match(wake.stats ?? '', /\$0\.0192/)
})

test('a launch turn whose result lands mid-run is marked, and so is the wake-up that saw the growth', () => {
  // the recorded stream (demo session ae7cd18a): one agent's first call was in the launch result before any frame said so
  const items = buildTranscript([
    init, you('go'), launch, ask, allow, started, spent(0), receipt, say('running'), spent(0), turnEnd(0.1582),
    spent(88051), spent(117793), completed, notified, init, say('done'), turnEnd(0.1774),
  ])
  assert.deepEqual(metas(items).map((m) => m.workflowSpend), [true, true])
})

test('a run that ends inside its launching turn marks that turn, not the wake-up (the real probe)', () => {
  const items = buildTranscript([init, you('go'), launch, started, spent(0), receipt, spent(36015), ended, say('running'), turnEnd(0.0966), init, say('alpha, beta'), turnEnd(0.1028)])
  assert.deepEqual(metas(items).map((m) => m.workflowSpend), [true, undefined])
})

test('per-turn cost keeps counting over a resumed revival whose counters carried on', () => {
  const items = buildTranscript([you('a'), turnEnd(1), { kind: 'subprocess' } as SessionEvent, you('b'), turnEnd(1.25)])
  assert.deepEqual(metas(items).map((m) => /\$[\d.]+/.exec(m.stats ?? '')?.[0]), ['$1.0000', '$0.2500'])
})

test('a revival marked fresh starts its count from zero', () => {
  const items = buildTranscript([you('a'), turnEnd(0.4), { kind: 'subprocess', fresh: true }, you('b'), turnEnd(0.9)])
  assert.deepEqual(metas(items).map((m) => /\$[\d.]+/.exec(m.stats ?? '')?.[0]), ['$0.4000', '$0.9000'])
})

test('a resumed revival whose counters restarted counts its whole first total, though it is higher', () => {
  // session 698be0c2 in the prod log: total 4.117 -> 4.608, API time 896232 -> 844511
  const r = (total: number, apiMs: number) => sdk({ type: 'result', subtype: 'success', total_cost_usd: total, duration_api_ms: apiMs, duration_ms: 1000, num_turns: 1 })
  const items = buildTranscript([you('a'), r(4.1169, 896232), { kind: 'subprocess' }, you('b'), r(4.6076, 844511)])
  assert.deepEqual(metas(items).map((m) => /\$[\d.]+/.exec(m.stats ?? '')?.[0]), ['$4.1169', '$4.6076'])
})

test('changesets are numbered as the server holds them: one across a run that outlives its launch', () => {
  const items = buildTranscript([init, you('go'), launch, receipt, started, turnEnd(0.1), ended, init, say('done'), turnEnd(0.5), init, you('next'), turnEnd(0.6)])
  assert.deepEqual(metas(items).map((m) => m.changes), [undefined, 1, 2])
})

test('a run that ends inside its launching turn holds the changeset for the wake-up, which opens none of its own', () => {
  const items = buildTranscript([init, you('go'), launch, receipt, started, ended, turnEnd(0.1), init, say('done'), turnEnd(0.2), you('next'), init, turnEnd(0.3)])
  assert.deepEqual(metas(items).map((m) => m.changes), [undefined, 1, 2])
})

test('a run that ends inside your next turn holds it for the wake-up too', () => {
  const items = buildTranscript([init, you('go'), launch, receipt, started, turnEnd(0.1), you('and?'), init, ended, turnEnd(0.2), init, say('done'), turnEnd(0.3)])
  assert.deepEqual(metas(items).map((m) => m.changes), [undefined, undefined, 1])
})

test('a held changeset closes with its subprocess', () => {
  const items = buildTranscript([you('go'), launch, receipt, started, turnEnd(0.1), { kind: 'subprocess' } as SessionEvent, you('again'), turnEnd(0.2)])
  assert.deepEqual(metas(items).map((m) => m.changes), [undefined, 2])
})
