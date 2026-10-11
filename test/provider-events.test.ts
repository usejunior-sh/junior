/**
 * Provider events (server/providers/claude-events.ts): a recorded Claude SDK
 * stream folded into the normalised union, and the transcript the UI draws
 * from it unchanged.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { claudeEvent, claudeEvents } from '../server/providers/claude-events.js'
import type { ProviderEvent } from '../server/providers/types.js'
import type { SessionEvent } from '../shared/protocol.js'
import { buildTranscript } from '../web/src/transcript.js'

const SID = 'c0ffee00-0000-4000-8000-000000000001'

// One turn as the SDK sends it: init, deltas, a tool call and its result, a
// subagent, a mid-run command change, then the result.
const RECORDED: Record<string, unknown>[] = [
  {
    type: 'system',
    subtype: 'init',
    session_id: SID,
    model: 'claude-opus-5-5',
    tools: ['Read', 'Edit', 'Agent'],
    mcp_servers: [{ name: 'triage', status: 'connected' }],
    terminal_slash_commands: ['login'],
    fast_mode_state: 'off',
    cwd: '/tmp/proj',
    uuid: 'u1',
  },
  { type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fix' } } },
  { type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ing it.' } } },
  {
    type: 'assistant',
    session_id: SID,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Fixing it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
      ],
    },
  },
  {
    type: 'user',
    session_id: SID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
  },
  {
    type: 'assistant',
    session_id: SID,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Agent', input: { description: 'look', prompt: 'look around', subagent_type: 'Explore' } }],
    },
  },
  { type: 'system', subtype: 'task_started', session_id: SID, task_id: 't1', tool_use_id: 'toolu_2', task_type: 'local_agent', description: 'look' },
  {
    type: 'assistant',
    session_id: SID,
    parent_tool_use_id: 'toolu_2',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Looked.' }] },
  },
  {
    type: 'user',
    session_id: SID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'Looked.' }] }] },
  },
  {
    type: 'system',
    subtype: 'commands_changed',
    session_id: SID,
    commands: [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }],
  },
  { type: 'assistant', session_id: SID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: SID,
    result: 'Done.',
    total_cost_usd: 0.42,
    duration_ms: 1234,
    num_turns: 3,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 },
    fast_mode_state: 'off',
  },
]

async function* replay<T>(xs: T[]) {
  for (const x of xs) yield x
}

async function collect(): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const ev of claudeEvents(replay(RECORDED))) out.push(ev)
  return out
}

test('a recorded stream maps to the union, one event per message', async () => {
  const events = await collect()
  assert.deepEqual(
    events.map((e) => e.kind),
    ['started', 'stream', 'stream', 'message', 'message', 'message', 'other', 'message', 'message', 'commands', 'message', 'result'],
  )
  // the record is the message itself: nothing the transcript reads is lost
  events.forEach((e, i) => assert.equal(e.record, RECORDED[i]))
})

test('init becomes started with the session id, model and terminal commands', async () => {
  const [started] = await collect()
  assert.equal(started.kind, 'started')
  if (started.kind !== 'started') return
  assert.equal(started.sessionId, SID)
  assert.equal(started.model, 'claude-opus-5-5')
  assert.deepEqual(started.terminalCommands, ['login'])
  assert.deepEqual(started.fastMode, { state: 'off', reason: undefined })
})

test('messages carry their role and tool calls', async () => {
  const events = await collect()
  const msg = events[3]
  assert.equal(msg.kind, 'message')
  if (msg.kind !== 'message') return
  assert.equal(msg.role, 'assistant')
  assert.deepEqual(msg.toolCalls, [{ id: 'toolu_1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }])
  const result = events[4]
  assert.ok(result.kind === 'message' && result.role === 'user' && result.toolCalls.length === 0)
  assert.equal(events[1].fastMode, undefined)
})

test('commands_changed becomes the whole new list', async () => {
  const ev = (await collect())[9]
  assert.ok(ev.kind === 'commands')
  assert.deepEqual(ev.commands, [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }])
})

test('result carries text, cumulative cost and summed tokens', async () => {
  const ev = (await collect()).at(-1)!
  assert.ok(ev.kind === 'result')
  assert.equal(ev.ok, true)
  assert.equal(ev.overBudget, false)
  assert.equal(ev.text, 'Done.')
  assert.equal(ev.costUsd, 0.42)
  assert.equal(ev.tokens, 1125)
})

test('an over-budget stop is flagged, and a result without usage counts zero', () => {
  const ev = claudeEvent({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: SID })
  assert.ok(ev.kind === 'result')
  assert.equal(ev.ok, false)
  assert.equal(ev.overBudget, true)
  assert.equal(ev.text, '')
  assert.equal(ev.costUsd, undefined)
  assert.equal(ev.tokens, 0)
})

test('the transcript renders the same through the union as from the raw stream', async () => {
  // Before: every SDK message but stream_event was persisted as it came.
  const before: SessionEvent[] = RECORDED.filter((m) => m.type !== 'stream_event').map((m) => ({ kind: 'sdk', message: m as never }))
  // Now: what the pump persists — each event's record, every kind but stream.
  const after: SessionEvent[] = (await collect()).filter((e) => e.kind !== 'stream').map((e) => ({ kind: 'sdk', message: e.record }))
  assert.deepEqual(after, before)
  const items = buildTranscript(after)
  assert.deepEqual(items, buildTranscript(before))
  // and it is a real transcript: the edit's result stitched onto its card
  const edit = items.find((it) => it.kind === 'tool' && it.name === 'Edit')
  assert.ok(edit && edit.kind === 'tool' && edit.result?.text === 'ok')
})

test('the protocol and the transcript know no provider', () => {
  for (const file of ['shared/protocol.ts', 'web/src/transcript.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const spec of imports) {
      assert.ok(!spec.includes('claude-agent-sdk'), `${file} imports ${spec}`)
      assert.ok(!spec.includes('providers'), `${file} imports ${spec}`)
    }
  }
})
