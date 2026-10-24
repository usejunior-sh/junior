/**
 * The chat stall watchdog (core/sessions/stall.ts): the verdict as a table,
 * each tool's bound, and TurnWatch saying "stalled" once per turn, on a fake
 * clock. LiveSession only adds the timer and the notice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LONG_TOOL_BOUND_MS,
  MAX_BOUND_MS,
  stallNotice,
  stallVerdict,
  THINKING_BOUND_MS,
  TIMEOUT_GRACE_MS,
  TOOL_BOUND_MS,
  toolBoundMs,
  toolResultIds,
  TurnWatch,
  type RunningTool,
  type StallState,
} from '../core/sessions/stall.js'

const MIN = 60_000
const T0 = 1_800_000_000_000
const tool = (name: string, input?: unknown): RunningTool => ({ id: name, name, input, since: T0 })

test('stallVerdict: the table', () => {
  const rows: { name: string; quiet: number; tools?: RunningTool[]; waiting?: boolean; slept?: number; state: StallState; tool?: string }[] = [
    { name: 'just heard from the agent', quiet: 0, state: 'ok' },
    { name: 'thinking, 2 min quiet', quiet: 2 * MIN, state: 'ok' },
    { name: 'thinking, 3 min quiet is slow', quiet: 3 * MIN, state: 'slow' },
    { name: 'thinking, 6 min quiet is stalled', quiet: 6 * MIN, state: 'stalled' },
    { name: 'thinking, exactly at the bound is still slow', quiet: THINKING_BOUND_MS, state: 'slow' },
    { name: 'Read out 6 min: a tool gets longer', quiet: 6 * MIN, tools: [tool('Read')], state: 'slow', tool: 'Read' },
    { name: 'Read out 11 min is stalled', quiet: 11 * MIN, tools: [tool('Read')], state: 'stalled', tool: 'Read' },
    { name: 'Bash, default timeout, 11 min', quiet: 11 * MIN, tools: [tool('Bash', { command: 'npm test' })], state: 'stalled', tool: 'Bash' },
    { name: 'Bash asked for 30 min: 20 min is only slow', quiet: 20 * MIN, tools: [tool('Bash', { command: 'make', timeout: 30 * MIN })], state: 'slow', tool: 'Bash' },
    { name: 'Bash asked for 30 min: 33 min is stalled', quiet: 33 * MIN, tools: [tool('Bash', { command: 'make', timeout: 30 * MIN })], state: 'stalled', tool: 'Bash' },
    { name: 'a subagent may be quiet a long time', quiet: 20 * MIN, tools: [tool('Agent')], state: 'slow', tool: 'Agent' },
    { name: 'a Workflow past 30 min is stalled', quiet: 31 * MIN, tools: [tool('Workflow')], state: 'stalled', tool: 'Workflow' },
    { name: 'an MCP wait tool is long', quiet: 12 * MIN, tools: [tool('mcp__ci__wait_for_checks')], state: 'ok', tool: 'mcp__ci__wait_for_checks' },
    { name: 'parallel calls: the most patient sets the bound', quiet: 12 * MIN, tools: [tool('Read'), tool('Agent'), tool('Grep')], state: 'ok', tool: 'Agent' },
    { name: 'a prompt waiting on the user is never a stall', quiet: 90 * MIN, waiting: true, state: 'ok' },
    { name: 'sleep is not quiet', quiet: 60 * MIN, slept: 58 * MIN, state: 'ok' },
    { name: 'sleep is taken off, the rest still counts', quiet: 60 * MIN, slept: 50 * MIN, state: 'stalled' },
  ]
  for (const r of rows) {
    const v = stallVerdict({ lastEventAt: T0, now: T0 + r.quiet, tools: r.tools ?? [], waitingOnUser: r.waiting, sleptMs: r.slept })
    assert.equal(v.state, r.state, r.name)
    assert.equal(v.tool, r.tool, `${r.name}: tool`)
  }
})

test('stallVerdict: quiet time never goes negative', () => {
  const v = stallVerdict({ lastEventAt: T0, now: T0 + MIN, tools: [], sleptMs: 5 * MIN })
  assert.equal(v.quietMs, 0)
  assert.equal(v.state, 'ok')
})

test('toolBoundMs: known kinds, the input timeout, and the cap', () => {
  assert.equal(toolBoundMs({ name: 'Edit' }), TOOL_BOUND_MS)
  assert.equal(toolBoundMs({ name: 'Bash', input: { command: 'ls' } }), TOOL_BOUND_MS)
  assert.equal(toolBoundMs({ name: 'Bash', input: { timeout: 2 * MIN } }), TOOL_BOUND_MS, 'a short timeout never shortens the bound')
  assert.equal(toolBoundMs({ name: 'Bash', input: { timeout: 20 * MIN } }), 20 * MIN + TIMEOUT_GRACE_MS)
  assert.equal(toolBoundMs({ name: 'Bash', input: { timeout: 'soon' } }), TOOL_BOUND_MS, 'a non-number timeout is ignored')
  assert.equal(toolBoundMs({ name: 'Monitor', input: { timeout_ms: 3_600_000 } }), 3_600_000 + TIMEOUT_GRACE_MS)
  assert.equal(toolBoundMs({ name: 'Task' }), LONG_TOOL_BOUND_MS)
  assert.equal(toolBoundMs({ name: 'mcp__x__await_run' }), LONG_TOOL_BOUND_MS)
  assert.equal(toolBoundMs({ name: 'mcp__chrome__waitFor' }), LONG_TOOL_BOUND_MS)
  assert.equal(toolBoundMs({ name: 'mcp__linear__list_waitlist' }), TOOL_BOUND_MS, 'a word that only contains "wait" is not a wait')
  assert.equal(toolBoundMs({ name: 'Bash', input: { timeout: 10 * 3_600_000 } }), MAX_BOUND_MS)
})

test('toolResultIds reads tool_result blocks only', () => {
  assert.deepEqual(
    toolResultIds({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
          { type: 'text', text: 'hi' },
          { type: 'tool_result', tool_use_id: 'b', content: [] },
        ],
      },
    }),
    ['a', 'b'],
  )
  assert.deepEqual(toolResultIds({ type: 'system' }), [])
})

test('TurnWatch: one notice per stalled turn, and a new turn may notice again', () => {
  const w = new TurnWatch()
  assert.equal(w.check(T0).notify, false, 'no turn open, nothing to say')
  w.begin(T0)
  assert.equal(w.check(T0 + 2 * MIN).verdict.state, 'ok')
  assert.equal(w.check(T0 + 3 * MIN).verdict.state, 'slow')
  const first = w.check(T0 + 6 * MIN)
  assert.equal(first.verdict.state, 'stalled')
  assert.equal(first.notify, true)
  assert.equal(w.check(T0 + 7 * MIN).notify, false, 'said once')
  // It wakes up, then goes quiet again: same turn, no second notice.
  w.heard(T0 + 8 * MIN)
  assert.equal(w.check(T0 + 8 * MIN).verdict.state, 'ok')
  assert.equal(w.check(T0 + 20 * MIN).verdict.state, 'stalled')
  assert.equal(w.check(T0 + 20 * MIN).notify, false)
  w.end()
  assert.equal(w.open, false)
  assert.equal(w.check(T0 + 60 * MIN).verdict.state, 'ok', 'a closed turn is never stalled')
  w.begin(T0 + 60 * MIN)
  assert.equal(w.check(T0 + 66 * MIN).notify, true, 'the next turn gets its own notice')
})

test('TurnWatch: a message mid-turn keeps the same turn', () => {
  const w = new TurnWatch()
  w.begin(T0)
  assert.equal(w.check(T0 + 6 * MIN).notify, true)
  w.begin(T0 + 6 * MIN)
  assert.equal(w.check(T0 + 20 * MIN).notify, false)
})

test('TurnWatch: tool calls set the bound until their result comes back', () => {
  const w = new TurnWatch()
  w.begin(T0)
  w.heard(T0, { toolCalls: [{ id: 't1', name: 'Agent', input: { prompt: 'look' } }] })
  assert.equal(w.check(T0 + 20 * MIN).verdict.state, 'slow', 'a subagent gets 30 min')
  w.heard(T0 + 20 * MIN, { record: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } } })
  const v = w.check(T0 + 26 * MIN).verdict
  assert.equal(v.state, 'stalled', 'back to thinking: 5 min')
  assert.equal(v.tool, undefined)
})

test('TurnWatch: the clock waits while a prompt waits on the user', () => {
  const w = new TurnWatch()
  w.begin(T0)
  assert.equal(w.check(T0 + 40 * MIN, { waitingOnUser: true }).verdict.state, 'ok')
  // Answered: the agent gets its full bound again from the last check.
  assert.equal(w.check(T0 + 42 * MIN).verdict.state, 'ok')
  assert.equal(w.check(T0 + 46 * MIN).notify, true)
})

test('TurnWatch: end clears running tools', () => {
  const w = new TurnWatch()
  w.begin(T0)
  w.heard(T0, { toolCalls: [{ id: 't1', name: 'Workflow' }] })
  w.end()
  w.begin(T0 + MIN)
  assert.equal(w.check(T0 + 7 * MIN).verdict.state, 'stalled', 'the old turn\'s Workflow no longer lengthens the bound')
})

test('stallNotice: says what it waits on, short sentences, house rules', () => {
  const withTool = stallNotice({ state: 'stalled', quietMs: 14 * MIN, boundMs: TOOL_BOUND_MS, tool: 'Bash' })
  const without = stallNotice({ state: 'stalled', quietMs: 6 * MIN, boundMs: THINKING_BOUND_MS })
  assert.match(withTool, /Bash/)
  assert.match(withTool, /14 minutes/)
  assert.match(without, /6 minutes/)
  for (const text of [withTool, without]) {
    assert.match(text, /Stop/)
    assert.doesNotMatch(text, /24\/7|walk away|Triage/i)
    for (const sentence of text.split(/(?<=\.)\s+/)) assert.ok(sentence.split(/\s+/).length <= 15, `too long: ${sentence}`)
  }
})

test('the watchdog in LiveSession never stops, interrupts or kills anything', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(here, '../server/session/live-session.ts'), 'utf8')
  const body = (name: string) => {
    const start = src.indexOf(`  private ${name}(`)
    assert.ok(start >= 0, `${name} is in live-session.ts`)
    const end = src.indexOf('\n  }\n', start)
    return src.slice(start, end)
  }
  for (const name of ['watchTurn', 'unwatchTurn', 'checkStall']) {
    const b = body(name)
    assert.doesNotMatch(b, /\.interrupt\(|\.stop\(|kill|\.close\(|abort/, name)
  }
  assert.match(body('unwatchTurn'), /clearInterval/)
})
