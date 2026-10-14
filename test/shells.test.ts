/**
 * Shells in a chat (core/shells/fold.ts): the fold that turns a session's events
 * into the Bash commands it ran, and the transcript's Bash items that carry
 * them. Event shapes are copied from real sessions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildShells, shellElapsedMs } from '../core/shells/fold.js'
import { buildTranscript, type ToolItem } from '../web/src/transcript.js'
import type { SdkMessage, SessionEvent } from '../shared/protocol.js'

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
const bash = (id: string, input: Record<string, unknown>) =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  })
const result = (id: string, content: string, isError = false) =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  })
const started = (toolUseId: string, taskId: string, description: string, backgrounded: boolean) =>
  sdk({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    is_backgrounded: backgrounded,
    task_type: 'local_bash',
  })
const heartbeat = (toolUseId: string, n: number) =>
  sdk({
    type: 'tool_progress',
    tool_use_id: `${toolUseId}-heartbeat-${n}`,
    parent_tool_use_id: toolUseId,
    tool_name: 'Bash',
    elapsed_time_seconds: 30 * (n + 1),
  } as SdkMessage)
const notified = (toolUseId: string, taskId: string, status: string, summary: string, outputFile = '') =>
  sdk({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status, summary, output_file: outputFile })

const out = (taskId: string) => `/private/tmp/claude-502/-repo/s1/tasks/${taskId}.output`
const OUT = out('b846yiuzs')

/** Timestamps by position: event i happened at i seconds. */
const at = (events: readonly SessionEvent[]) => (ev: SessionEvent) => events.indexOf(ev) * 1000

test('a foreground shell: running until its result, then done', () => {
  const events = [
    bash('toolu_T', { command: 'npm test', description: 'Run unit tests' }),
    started('toolu_T', 'bkjczaubu', 'Run unit tests', false),
    heartbeat('toolu_T', 0),
    heartbeat('toolu_T', 1),
  ]
  const [s] = buildShells(events, at(events))
  assert.equal(s.state, 'running')
  assert.equal(s.taskId, 'bkjczaubu')
  assert.equal(s.background, false)
  assert.equal(s.description, 'Run unit tests')
  assert.equal(shellElapsedMs(s, 90_000), 90_000)

  const done = [...events, result('toolu_T', '# pass 214'), notified('toolu_T', 'bkjczaubu', 'completed', 'Run unit tests')]
  const [d] = buildShells(done, at(done))
  assert.equal(d.state, 'done')
  // The notification after the result changes nothing: the call ended at its result.
  assert.equal(d.endedAt, 4000)
})

test('a background shell keeps running past its receipt, until its notification', () => {
  const events = [
    bash('toolu_B', { command: 'npm run build', description: 'Build', run_in_background: true }),
    started('toolu_B', 'b846yiuzs', 'Build', true),
    result(
      'toolu_B',
      `Command running in background with ID: b846yiuzs. Output is being written to: ${OUT}. You will be notified when it completes.`,
    ),
  ]
  const [s] = buildShells(events, at(events))
  assert.equal(s.state, 'running')
  assert.equal(s.background, true)
  assert.equal(s.outputFile, OUT)

  // The transcript's Bash item has its result (the receipt) and a shell still running.
  const tool = (evs: SessionEvent[]) => {
    const [g] = buildTranscript(evs, at(evs))
    assert.equal(g.kind, 'toolGroup')
    return (g as Extract<typeof g, { kind: 'toolGroup' }>).members[0] as ToolItem
  }
  assert.ok(tool(events).result)
  assert.equal(tool(events).shell?.state, 'running')

  const failed = [...events, notified('toolu_B', 'b846yiuzs', 'failed', 'Background command "Build" failed with exit code 2', OUT)]
  const [f] = buildShells(failed, at(failed))
  assert.equal(f.state, 'failed')
  assert.equal(f.exitCode, 2)
  assert.equal(shellElapsedMs(f, 0), 3000)
  assert.equal(tool(failed).shell?.state, 'failed')
})

test('a foreground shell moved to the background by its timeout', () => {
  const events = [
    bash('toolu_E', { command: 'node e2e.mjs', description: 'Run end-to-end test', timeout: 600000 }),
    started('toolu_E', 'bkjczaubu', 'Run end-to-end test', false),
    sdk({ type: 'system', subtype: 'task_updated', task_id: 'bkjczaubu', patch: { is_backgrounded: true } }),
    result(
      'toolu_E',
      `Command did not complete within its 600s timeout and was moved to the background (ID: bkjczaubu). Output is being written to: ${out('bkjczaubu')}. You will be notified when it completes.`,
    ),
    sdk({ type: 'system', subtype: 'task_updated', task_id: 'bkjczaubu', patch: { status: 'completed' } }),
  ]
  const [s] = buildShells(events, at(events))
  assert.equal(s.background, true)
  assert.equal(s.outputFile, out('bkjczaubu'))
  assert.equal(s.state, 'done')
})

test('a fresh subprocess interrupts shells the last one left running', () => {
  const events: SessionEvent[] = [
    bash('toolu_D', { command: 'npm run dev', run_in_background: true }),
    started('toolu_D', 'bqbne4bdz', 'Run dev server', true),
    result('toolu_D', `Command running in background with ID: bqbne4bdz. Output is being written to: ${out('bqbne4bdz')}`),
    { kind: 'subprocess' },
  ]
  const [s] = buildShells(events)
  assert.equal(s.state, 'interrupted')
})

test('a foreground command that prints a receipt is not a background shell', () => {
  const events = [
    bash('toolu_F', { command: 'cat notes.txt' }),
    started('toolu_F', 'bfgtask01', 'Show notes', false),
    result('toolu_F', 'Command running in background with ID: bother99. Output is being written to: /etc/tasks/bother99.output'),
  ]
  const [s] = buildShells(events)
  assert.equal(s.background, false)
  assert.equal(s.state, 'done')
  assert.equal(s.outputFile, undefined)
})
