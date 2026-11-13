/**
 * The chat header's context ring (web/src/usageFormat.ts `contextUse`): the
 * main agent's last prompt over the window the latest result reports. Shapes
 * copied from a real DM's events.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextUse } from '../web/src/usageFormat.js'
import type { SessionEvent } from '../shared/protocol.js'

const assistant = (input: number, write: number, read: number, parent: string | null = null): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [], usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 3 } } },
})
const result = (window: number): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'result', subtype: 'success', modelUsage: { 'claude-opus-5-5': { inputTokens: 2, contextWindow: window }, 'claude-haiku-5-5': { inputTokens: 9, contextWindow: 200_000 } } },
})

test('the last main-agent prompt over the largest window', () => {
  assert.deepEqual(contextUse([assistant(2, 65_855, 0), result(1_000_000)]), { used: 65_857, window: 1_000_000, pct: 7 })
})

test('a later reply wins, and a subagent reply never counts', () => {
  const evs = [assistant(2, 65_855, 0), result(1_000_000), assistant(1, 1_000, 120_000), assistant(5, 0, 900_000, 'toolu_sub')]
  assert.deepEqual(contextUse(evs), { used: 121_001, window: 1_000_000, pct: 12 })
})

test('unknown until a turn has ended', () => {
  assert.equal(contextUse([]), null)
  assert.equal(contextUse([assistant(2, 10, 0)]), null)
  assert.equal(contextUse([result(200_000)]), null)
})

test('a DM is full at its compaction point, not the model window', () => {
  const evs = [assistant(2, 65_855, 0), result(1_000_000)]
  assert.deepEqual(contextUse(evs, 'dm'), { used: 65_857, window: 200_000, pct: 33 })
  // a smaller window than the compaction point still wins
  const small: SessionEvent = { kind: 'sdk', message: { type: 'result', subtype: 'success', modelUsage: { 'claude-x': { inputTokens: 1, contextWindow: 100_000 } } } }
  assert.deepEqual(contextUse([assistant(0, 0, 50_000), small], 'dm'), { used: 50_000, window: 100_000, pct: 50 })
})
