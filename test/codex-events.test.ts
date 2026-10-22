/**
 * Codex events (server/providers/codex-events.ts): a turn recorded from
 * `codex app-server` (codex-cli 0.150.1) folded into the normalised union, and
 * the transcript the UI draws from it — text, a Bash card with its output, an
 * edit card per patched file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexModels, createCodexMapper, fileChangeTool, splitDiff, unwrapShell } from '../server/providers/codex-events.js'
import type { ProviderEvent } from '../server/providers/types.js'
import type { SessionEvent } from '../shared/protocol.js'
import { buildTranscript, type TranscriptItem } from '../web/src/transcript.js'

const THREAD = '01a12a3e-868a-7033-9091-25ff10165f70'

// One live turn, ids shortened and noise thinned: a commentary line, a command
// (approved), a two-file patch (approved), the final answer.
const RECORDED: Array<{ method: string; params: Record<string, unknown> }> = [
  {"method":"mcpServer/startupStatus/updated","params":{"name":"cua_repl","status":"starting","error":null,"failureReason":null}},
  {"method":"turn/started","params":{"turn":{"id":"turn-1","status":"inProgress","error":null,"durationMs":null}}},
  {"method":"item/started","params":{"item":{"type":"userMessage","id":"u1","content":[{"type":"text","text":"Do exactly these, briefly: 1) run `cat notes.txt` 2) change \"line two\" to \"line 2\" in notes.txt 3) create hi.txt containing \"hi\". Then reply \"done\".","text_elements":[]}]}}},
  {"method":"item/completed","params":{"item":{"type":"userMessage","id":"u1","content":[{"type":"text","text":"Do exactly these, briefly: 1) run `cat notes.txt` 2) change \"line two\" to \"line 2\" in notes.txt 3) create hi.txt containing \"hi\". Then reply \"done\".","text_elements":[]}]}}},
  {"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_1","text":"","phase":"commentary"}}},
  {"method":"item/agentMessage/delta","params":{"itemId":"msg_1","delta":"I’ll make"}},
  {"method":"item/agentMessage/delta","params":{"itemId":"msg_1","delta":" the two requested file edits"}},
  {"method":"item/agentMessage/delta","params":{"itemId":"msg_1","delta":" after reading `notes.txt`."}},
  {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_1","text":"I’ll make the two requested file edits after reading `notes.txt`.","phase":"commentary"}}},
  {"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-1","command":"/bin/zsh -lc 'cat notes.txt'","cwd":"/tmp/proj","status":"inProgress","aggregatedOutput":null,"exitCode":null}}},
  {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-1","command":"/bin/zsh -lc 'cat notes.txt'","cwd":"/tmp/proj","status":"completed","aggregatedOutput":"line one\nline two\n","exitCode":0}}},
  {"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":17846,"inputTokens":17743,"cachedInputTokens":6912,"outputTokens":103}}}},
  {"method":"item/started","params":{"item":{"type":"fileChange","id":"exec-2","changes":[{"path":"/tmp/proj/hi.txt","kind":{"type":"add"},"diff":"hi\n"},{"path":"/tmp/proj/notes.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1,2 +1,2 @@\n line one\n-line two\n+line 2\n"}],"status":"inProgress"}}},
  {"method":"item/completed","params":{"item":{"type":"fileChange","id":"exec-2","changes":[{"path":"/tmp/proj/hi.txt","kind":{"type":"add"},"diff":"hi\n"},{"path":"/tmp/proj/notes.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1,2 +1,2 @@\n line one\n-line two\n+line 2\n"}],"status":"completed"}}},
  {"method":"turn/diff/updated","params":{"diff":"diff --git a/hi.txt b/hi.txt\n…"}},
  {"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":35868,"inputTokens":35618,"cachedInputTokens":24064,"outputTokens":250}}}},
  {"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_2","text":"","phase":"final_answer"}}},
  {"method":"item/agentMessage/delta","params":{"itemId":"msg_2","delta":"done"}},
  {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_2","text":"done","phase":"final_answer"}}},
  {"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":53919,"inputTokens":53664,"cachedInputTokens":41216,"outputTokens":255}}}},
  {"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed","error":null,"durationMs":15409}}},
]

function replay(): ProviderEvent[] {
  const mapper = createCodexMapper(THREAD)
  return [mapper.started('gpt-5.6-terra'), ...RECORDED.flatMap((n) => mapper.notification(n.method, n.params))]
}

/** What the pump persists: every event's record but the stream deltas. */
const persisted = (events: ProviderEvent[]): SessionEvent[] =>
  events.filter((e) => e.kind !== 'stream').map((e) => ({ kind: 'sdk', message: e.record }))

test('a recorded turn maps to started, deltas, messages and one result; noise maps to nothing', () => {
  assert.deepEqual(
    replay().map((e) => (e.kind === 'message' ? `${e.role}:${e.toolCalls.map((c) => c.name).join('+') || 'text'}` : e.kind)),
    [
      'started',
      'stream',
      'stream',
      'stream',
      'assistant:text',
      'assistant:Bash',
      'user:text',
      'assistant:Write+Edit',
      'user:text',
      'stream',
      'assistant:text',
      'result',
    ],
  )
})

test('started carries the thread id as the resume key, and the model', () => {
  const [started] = replay()
  assert.ok(started.kind === 'started')
  assert.equal(started.sessionId, THREAD)
  assert.equal(started.model, 'gpt-5.6-terra')
  assert.equal(started.record.type, 'system')
  assert.equal(started.record.subtype, 'init')
})

test('deltas are the live line the store already draws', () => {
  const ev = replay()[1]
  assert.deepEqual(ev.record.event, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I’ll make' } })
})

test('a command is a Bash call without its login-shell wrapper; a patch is an edit tool per file', () => {
  const events = replay()
  const bash = events[5]
  assert.ok(bash.kind === 'message')
  assert.deepEqual(bash.toolCalls, [{ id: 'exec-1', name: 'Bash', input: { command: 'cat notes.txt' } }])
  const patch = events[7]
  assert.ok(patch.kind === 'message')
  assert.deepEqual(patch.toolCalls, [
    { id: 'exec-2:0', name: 'Write', input: { file_path: '/tmp/proj/hi.txt', content: 'hi\n' } },
    { id: 'exec-2:1', name: 'Edit', input: { file_path: '/tmp/proj/notes.txt', old_string: 'line one\nline two\n', new_string: 'line one\nline 2\n' } },
  ])
})

test('the result carries the final answer and the turn’s own tokens, with no cost', () => {
  const ev = replay().at(-1)!
  assert.ok(ev.kind === 'result')
  assert.equal(ev.ok, true)
  assert.equal(ev.overBudget, false)
  assert.equal(ev.text, 'done')
  assert.equal(ev.costUsd, undefined)
  assert.equal(ev.tokens, 53919)
  assert.equal(ev.record.total_cost_usd, undefined)
  assert.equal(ev.record.duration_ms, 15409)
})

test('a second turn counts only its own tokens', () => {
  const mapper = createCodexMapper(THREAD)
  const usage = (totalTokens: number) => ({ tokenUsage: { total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0 } } })
  const turn = (total: number) => {
    mapper.notification('turn/started', { turn: { id: 't' } })
    mapper.notification('thread/tokenUsage/updated', usage(total))
    return mapper.notification('turn/completed', { turn: { id: 't', status: 'completed' } })[0]
  }
  assert.ok(turn(100).kind === 'result')
  const second = turn(250)
  assert.ok(second.kind === 'result' && second.tokens === 150)
})

test('a failed or interrupted turn is a result that is not ok, with the reason as its text', () => {
  const mapper = createCodexMapper(THREAD)
  mapper.notification('turn/started', { turn: { id: 't' } })
  mapper.notification('error', { error: { message: 'stream disconnected' }, willRetry: false })
  const failed = mapper.notification('turn/completed', { turn: { id: 't', status: 'failed', error: null } })[0]
  assert.ok(failed.kind === 'result' && !failed.ok && failed.text === 'stream disconnected')
  assert.equal(failed.record.subtype, 'error_during_execution')
  mapper.notification('turn/started', { turn: { id: 't2' } })
  const stopped = mapper.notification('turn/completed', { turn: { id: 't2', status: 'interrupted', error: null } })[0]
  assert.ok(stopped.kind === 'result' && !stopped.ok && stopped.text === 'Interrupted.')
})

test('a failing command and a declined patch come back as errors', () => {
  const mapper = createCodexMapper(THREAD)
  const cmd = mapper.notification('item/completed', {
    item: { type: 'commandExecution', id: 'c', command: 'false', status: 'failed', aggregatedOutput: '', exitCode: 1 },
  })
  // completed without a started: the call and its result arrive together
  assert.deepEqual(cmd.map((e) => e.kind === 'message' && e.role), ['assistant', 'user'])
  assert.equal((cmd[1].record.message?.content?.[0] as { is_error?: boolean }).is_error, true)
  const patch = mapper.notification('item/completed', {
    item: { type: 'fileChange', id: 'p', status: 'declined', changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: 'x' }] },
  })
  assert.deepEqual(patch[1].record.message?.content, [{ type: 'tool_result', tool_use_id: 'p:0', content: 'Declined.', is_error: true }])
})

test('an MCP call is named the way Claude names it', () => {
  const mapper = createCodexMapper(THREAD)
  const [call, result] = mapper.notification('item/completed', {
    item: { type: 'mcpToolCall', id: 'm', server: 'junior', tool: 'list_work_items', arguments: { status: 'open' }, result: { content: [{ type: 'text', text: '[]' }] }, error: null, status: 'completed' },
  })
  assert.ok(call.kind === 'message')
  assert.deepEqual(call.toolCalls, [{ id: 'm', name: 'mcp__junior__list_work_items', input: { status: 'open' } }])
  assert.deepEqual(result.record.message?.content, [{ type: 'tool_result', tool_use_id: 'm', content: [{ type: 'text', text: '[]' }], is_error: false }])
})

test('helpers: shell unwrap, diff split, delete and move', () => {
  assert.equal(unwrapShell(`/bin/zsh -lc 'echo '\\''hi'\\'''`), "echo 'hi'")
  assert.equal(unwrapShell(`/bin/zsh -lc "rg -g 'a.txt' \\"x\\" \\$HOME"`), `rg -g 'a.txt' "x" $HOME`)
  assert.equal(unwrapShell('git status'), 'git status')
  assert.deepEqual(splitDiff('@@ -1 +1 @@\n----x\n+++y\n'), { before: '---x\n', after: '++y\n' })
  assert.deepEqual(splitDiff('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file'), { before: 'a\n', after: 'b' })
  assert.deepEqual(fileChangeTool({ path: 'x', kind: { type: 'delete' }, diff: 'gone\n' }), {
    name: 'Edit',
    input: { file_path: 'x', old_string: 'gone\n', new_string: '' },
  })
  assert.equal(fileChangeTool({ path: 'x', kind: { type: 'update', move_path: 'y' }, diff: '' }).input.file_path, 'y')
})

test('buildTranscript renders the turn: text, the Bash call with its output, an edit card per file', () => {
  const items = buildTranscript(persisted(replay()))
  const flat = items.flatMap((it): TranscriptItem[] => (it.kind === 'toolGroup' ? it.members : [it]))
  assert.deepEqual(
    flat.filter((it) => it.kind === 'assistant').map((it) => it.kind === 'assistant' && it.text),
    ['I’ll make the two requested file edits after reading `notes.txt`.', 'done'],
  )
  const bash = flat.find((it) => it.kind === 'tool' && it.name === 'Bash')
  assert.ok(bash && bash.kind === 'tool')
  assert.deepEqual(bash.input, { command: 'cat notes.txt' })
  assert.deepEqual(bash.result, { text: 'line one\nline two\n', isError: false })
  const edits = flat.filter((it) => it.kind === 'tool' && (it.name === 'Write' || it.name === 'Edit'))
  assert.equal(edits.length, 2)
  for (const e of edits) assert.ok(e.kind === 'tool' && e.result?.text === 'Applied.' && !e.result.isError)
  assert.ok(items.some((it) => it.kind === 'meta'), 'the turn marker')
})

test('codexModels: model/list as picker rows, efforts kept to the ones junior names', () => {
  // model/list as codex-cli 0.150.1 answered it, trimmed, plus a hidden model and junk rows.
  const effortsOf = (...e: string[]) => e.map((reasoningEffort) => ({ reasoningEffort, description: '' }))
  const data = [
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier', isDefault: true, hidden: false, supportedReasoningEfforts: effortsOf('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultReasoningEffort: 'medium' },
    { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: '', hidden: false, supportedReasoningEfforts: effortsOf('minimal', 'low', 'medium') },
    { id: 'internal', model: 'internal', displayName: 'Internal', hidden: true, supportedReasoningEfforts: effortsOf('low') },
    { id: 'bare' },
    null,
    { model: 'no-id' },
  ]
  assert.deepEqual(codexModels(data), [
    { id: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'Frontier', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-5.6-luna', resolvedModel: 'gpt-5.6-luna', name: 'gpt-5.6-luna', description: '', efforts: ['low', 'medium'] },
    { id: 'bare', name: 'bare', description: '', efforts: [] },
  ])
  assert.deepEqual(codexModels(undefined), [])
})
