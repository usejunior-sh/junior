/**
 * Subagents in a chat (web/src/agents.ts, web/src/transcript.ts): the fold that
 * turns a session's events into its agents, and the transcript split between
 * main and an agent's own view. Event shapes are copied from real sessions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgents, cleanReport, agentAncestors } from '../web/src/agents.js'
import { buildTranscript } from '../web/src/transcript.js'
import { frameAgentRelay } from '../core/agents/relay.js'
import type { SdkMessage, SessionEvent } from '../shared/protocol.js'

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
const init = () => sdk({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: [] })
const say = (text: string, parent: string | null = null) =>
  sdk({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
  sdk({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: unknown, parent: string | null = null, isError = false) =>
  sdk({
    type: 'user',
    parent_tool_use_id: parent,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  })
const started = (toolUseId: string, taskId: string, extra: Partial<SdkMessage> = {}) =>
  sdk({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: 'local_agent',
    description: 'find callers',
    subagent_type: 'Explore',
    is_backgrounded: false,
    prompt: 'List every caller.',
    ...extra,
  })

/** Explore runs in the foreground, reads one file, and reports back in its tool result. */
function foreground(): SessionEvent[] {
  return [
    init(),
    { kind: 'local_user', text: 'who calls runAllowedTools?' },
    say('Spawning an agent.'),
    call('toolu_A', 'Agent', { description: 'find callers', subagent_type: 'Explore', prompt: 'List every caller.' }),
    started('toolu_A', 'a1b2'),
    say('Looking in server/.', 'toolu_A'),
    call('toolu_R', 'Read', { file_path: '/repo/server/index.ts' }, 'toolu_A'),
    sdk({ type: 'system', subtype: 'task_progress', task_id: 'a1b2', tool_use_id: 'toolu_A', description: 'Reading index.ts', usage: { total_tokens: 18200, tool_uses: 1, duration_ms: 2400 }, last_tool_name: 'Read' }),
    result('toolu_R', 'file body', 'toolu_A'),
    sdk({ type: 'system', subtype: 'task_notification', task_id: 'a1b2', tool_use_id: 'toolu_A', status: 'completed', summary: 'find callers', usage: { total_tokens: 20100, tool_uses: 1, duration_ms: 3100 } }),
    result('toolu_A', [{ type: 'text', text: 'Two callers: server/index.ts:2398 and core/watch/tools.ts:41.\nagentId: a1b2 (use SendMessage to continue)\n<usage>total_tokens: 20100</usage>' }]),
    say('Found two callers.'),
  ]
}

test('a foreground agent: started, worked, reported back in its tool result', () => {
  const [a] = buildAgents(foreground())
  assert.equal(a.toolUseId, 'toolu_A')
  assert.equal(a.agentId, 'a1b2')
  assert.equal(a.type, 'Explore')
  assert.equal(a.description, 'find callers')
  assert.equal(a.prompt, 'List every caller.')
  assert.equal(a.state, 'done')
  assert.equal(a.background, false)
  assert.equal(a.tokens, 20100)
  assert.equal(a.toolUses, 1)
  assert.equal(a.report, 'Two callers: server/index.ts:2398 and core/watch/tools.ts:41.')
  assert.equal(a.parentToolUseId, null)
})

test("main's transcript leaves the agent's work out and shows one agent card", () => {
  const events = foreground()
  const items = buildTranscript(events, undefined, { agents: buildAgents(events) })
  const kinds = items.map((i) => i.kind)
  assert.deepEqual(kinds, ['init', 'user', 'assistant', 'agent', 'assistant'])
  assert.deepEqual(items[3], { key: 'c3.0', kind: 'agent', toolUseId: 'toolu_A' })
  assert.ok(!items.some((i) => i.kind === 'assistant' && i.text === 'Looking in server/.'))
})

test("an agent's view keeps only what it did", () => {
  const events = foreground()
  const items = buildTranscript(events, undefined, { scope: 'toolu_A', agents: buildAgents(events) })
  assert.deepEqual(
    items.map((i) => i.kind),
    ['assistant', 'toolGroup'],
  )
  assert.equal(items[0].kind === 'assistant' && items[0].text, 'Looking in server/.')
  const group = items[1]
  assert.ok(group.kind === 'toolGroup' && group.members[0].kind === 'tool' && group.members[0].result?.text === 'file body')
})

test('without agents passed, an Agent call is still a card, never a tool line', () => {
  const items = buildTranscript(foreground())
  assert.ok(items.some((i) => i.kind === 'agent'))
  assert.ok(!items.some((i) => i.kind === 'toolGroup'))
})

test('a background agent: the launch receipt is not its end; the notification and its handback are', () => {
  const events = [
    init(),
    call('toolu_B', 'Agent', { description: 'review the diff', subagent_type: 'git-review', prompt: 'Review it.', run_in_background: true }),
    started('toolu_B', 'ab0a', { is_backgrounded: true, description: 'review the diff', subagent_type: 'git-review' }),
    result('toolu_B', [{ type: 'text', text: "Async agent launched successfully.\nagentId: ab0a (internal ID - Use SendMessage with to: 'ab0a')" }]),
    call('toolu_H', 'SubagentHandback', { message: '## Verdict: SAFE' }, 'toolu_B'),
  ]
  let [b] = buildAgents(events)
  assert.equal(b.state, 'running')
  assert.equal(b.background, true)
  assert.equal(b.report, '## Verdict: SAFE')
  assert.equal(b.toolUses, 0, 'the handback is the report, not a step')

  events.push(
    sdk({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'ab0a',
      tool_use_id: 'toolu_B',
      status: 'completed',
      summary: 'This agent\'s report was delivered to you as a message from "ab0a" (its SubagentHandback call).',
      handback_report: { text: '## Verdict: SAFE\nNothing changes for existing users.' },
    }),
  )
  ;[b] = buildAgents(events)
  assert.equal(b.state, 'done')
  assert.equal(b.report, '## Verdict: SAFE\nNothing changes for existing users.')

  const view = buildTranscript(events, undefined, { scope: 'toolu_B', agents: buildAgents(events) })
  assert.deepEqual(view, [], 'the handback call is drawn as the hand-back card, not as a tool line')
})

test("background shells (local_bash) aren't agents", () => {
  const events = [
    init(),
    call('toolu_S', 'Bash', { command: 'npm test', run_in_background: true }),
    sdk({ type: 'system', subtype: 'task_started', task_id: 'bx1', tool_use_id: 'toolu_S', task_type: 'local_bash', description: 'npm test' }),
  ]
  assert.deepEqual(buildAgents(events), [])
})

test('stopped (task_updated killed), failed (error result), and interrupted (a new subprocess)', () => {
  const stopped = buildAgents([
    init(),
    call('toolu_A', 'Agent', { description: 'x' }),
    started('toolu_A', 'a1'),
    sdk({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'killed' } }),
  ])[0]
  assert.equal(stopped.state, 'stopped')

  const failed = buildAgents([init(), call('toolu_A', 'Agent', { description: 'x' }), started('toolu_A', 'a1'), result('toolu_A', 'Prompt is too long', null, true)])[0]
  assert.equal(failed.state, 'failed')
  assert.equal(failed.error, 'Prompt is too long')

  const interrupted = buildAgents([init(), call('toolu_A', 'Agent', { description: 'x' }), started('toolu_A', 'a1'), { kind: 'subprocess' }, init()])[0]
  assert.equal(interrupted.state, 'interrupted')
})

test("the SDK's per-turn init is not a restart: background agents keep running, no resumed marker", () => {
  // One agent finishes; the CLI opens a turn to tell main, and that turn starts with init — same process.
  const events: SessionEvent[] = [
    init(),
    call('toolu_A', 'Agent', { description: 'shell audit', run_in_background: true }),
    started('toolu_A', 'a1', { is_backgrounded: true }),
    call('toolu_B', 'Agent', { description: 'SPA audit', run_in_background: true }),
    started('toolu_B', 'a2', { is_backgrounded: true }),
    sdk({ type: 'result', subtype: 'success', total_cost_usd: 2.25 }),
    sdk({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_A', status: 'completed', summary: 'shell audit' }),
    init(),
    say('1 of 2 back.'),
  ]
  const agents = buildAgents(events)
  assert.equal(agents.find((a) => a.toolUseId === 'toolu_A')!.state, 'done')
  assert.equal(agents.find((a) => a.toolUseId === 'toolu_B')!.state, 'running')
  const items = buildTranscript(events, undefined, { agents })
  assert.ok(!items.some((i) => i.kind === 'meta' && i.text.includes('resumed')))

  // A real revival — triage marks it — does draw the marker, with the new process's model.
  const revived = buildTranscript([...events, { kind: 'subprocess' }, { kind: 'local_user', text: 'and?' }, init()])
  assert.ok(revived.some((i) => i.kind === 'meta' && i.text === '— session resumed · claude-opus-5-5 —'))
})

test('a finished agent written to again runs again', () => {
  const events = foreground()
  events.push(started('toolu_A', 'a1b2'))
  assert.equal(buildAgents(events)[0].state, 'running')
})

test("a subagent's permission prompt marks it waiting, until answered", () => {
  const events: SessionEvent[] = [
    init(),
    call('toolu_A', 'Agent', { description: 'migrate' }),
    started('toolu_A', 'a1'),
    { kind: 'permission_request', id: 'p1', toolName: 'Bash', input: { command: 'sqlite3 x.db' }, agentId: 'a1' },
  ]
  assert.equal(buildAgents(events)[0].waiting, true)
  // The prompt shows in main and in the agent's view, never in another agent's.
  const agents = buildAgents(events)
  assert.ok(buildTranscript(events, undefined, { agents }).some((i) => i.kind === 'permission' && i.agentId === 'a1'))
  assert.ok(buildTranscript(events, undefined, { agents, scope: 'toolu_A' }).some((i) => i.kind === 'permission'))
  events.push({ kind: 'permission_resolved', id: 'p1', behavior: 'allow' })
  assert.equal(buildAgents(events)[0].waiting, false)
})

test('nested agents know who spawned them', () => {
  const runs = buildAgents([
    init(),
    call('toolu_A', 'Agent', { description: 'refactor the gate', subagent_type: 'general-purpose' }),
    started('toolu_A', 'a1', { subagent_type: 'general-purpose', description: 'refactor the gate' }),
    call('toolu_N', 'Agent', { description: 'find callers', subagent_type: 'Explore' }, 'toolu_A'),
    started('toolu_N', 'a2', { spawn_depth: 2 }),
  ])
  const nested = runs.find((r) => r.toolUseId === 'toolu_N')!
  assert.equal(nested.parentToolUseId, 'toolu_A')
  assert.deepEqual(agentAncestors(runs, nested).map((r) => r.toolUseId), ['toolu_A'])
})

test('a relayed message: a quiet line in main, a bubble in the agent, marked once main passes it on', () => {
  const events = foreground()
  const relay = { toolUseId: 'toolu_A', agentId: 'a1b2', label: 'find callers' }
  events.push({ kind: 'local_user', text: 'Only look in core/.', relay })
  let agents = buildAgents(events)
  const main = buildTranscript(events, undefined, { agents })
  const line = main.at(-1)!
  assert.ok(line.kind === 'relay' && line.delivery === undefined)
  assert.ok(!main.some((i) => i.kind === 'user' && i.text === 'Only look in core/.'), 'never a user bubble in main')

  events.push(call('toolu_S', 'SendMessage', { to: 'a1b2', message: 'Only look in core/.', summary: 'narrow search' }))
  agents = buildAgents(events)
  const after = buildTranscript(events, undefined, { agents }).find((i) => i.kind === 'relay')
  assert.ok(after?.kind === 'relay' && after.delivery === 'verbatim')
  const inAgent = buildTranscript(events, undefined, { agents, scope: 'toolu_A' }).find((i) => i.kind === 'user')
  assert.ok(inAgent?.kind === 'user' && inAgent.relayed?.delivery === 'verbatim')
})

test('cleanReport drops the CLI trailer and a forked skill wrapper', () => {
  assert.equal(cleanReport('Done.\nagentId: a1 (internal)\n<usage>x</usage>'), 'Done.')
  assert.equal(cleanReport('Skill "code-review" completed (forked execution).\n\nResult:\nNo bugs.'), 'No bugs.')
})

test('the relay main reads names the agent and carries the text unchanged', () => {
  const framed = frameAgentRelay({ toolUseId: 'toolu_A', agentId: 'a1b2', label: 'find callers' }, 'Only look in core/.')
  assert.match(framed, /SendMessage with to: "a1b2"/)
  assert.match(framed, /<message>\nOnly look in core\/\.\n<\/message>/)
})
