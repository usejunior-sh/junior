/**
 * A turn's own cost from cumulative result totals (core/usage/turn-cost.ts),
 * across revivals that may or may not carry the counters on. Numbers are
 * from real results in the prod log and the /tmp/ucprobe run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carriesOn, costMark, costStep, lastResultMark } from '../core/usage/turn-cost.js'
import type { SdkMessage, SessionEvent } from '../shared/protocol.js'

const result = (total: number, extra: Partial<SdkMessage> = {}): SdkMessage => ({ type: 'result', subtype: 'success', total_cost_usd: total, ...extra })
const usage = (input: number, output: number, read: number, write: number) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write })

test('a mark reads the total, API time and every model’s tokens', () => {
  const m = costMark(result(0.0966, { duration_api_ms: 8986, modelUsage: { 'claude-sonnet-5-5': usage(4, 293, 32545, 34583) } }))
  assert.deepEqual(m, { total: 0.0966, apiMs: 8986, tokens: { 'claude-sonnet-5-5': 67425 } })
  // a crash's zeroed total says nothing about spend
  assert.equal(costMark(result(0, { subtype: 'error_during_execution', is_error: true })), null)
  assert.equal(costMark({ type: 'result', subtype: 'success' }), null)
  assert.equal(costMark({ type: 'assistant' }), null)
})

test('the last result the log kept is where a resume may carry on from', () => {
  const log = (...events: SessionEvent[]) => events.map((event) => ({ event }))
  const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
  assert.equal(lastResultMark([]), null)
  assert.equal(lastResultMark(log(sdk(result(0.4955)), { kind: 'subprocess' }, sdk(result(0.5635)), { kind: 'notice', text: 'x' }))?.total, 0.5635)
  assert.equal(lastResultMark(log(sdk(result(43.83)), sdk(result(0, { subtype: 'error_during_execution', is_error: true }))))?.total, 43.83)
})

test('within a subprocess, a turn costs the step from the last total', () => {
  const a = costStep(result(0.0966, { duration_api_ms: 8986, modelUsage: { s: usage(4, 293, 32545, 34583) } }), null)
  assert.equal(a.delta, 0.0966)
  const b = costStep(result(0.1028, { duration_api_ms: 10551, modelUsage: { s: usage(8, 337, 67128, 35499) } }), a.seen)
  assert.ok(Math.abs(b.delta - 0.0062) < 1e-9)
})

test('a resume that carried the counters on counts only the step', () => {
  const seen = costMark(result(43.83, { duration_api_ms: 900_000, modelUsage: { o: usage(10, 5000, 900_000, 80_000) } }))
  const s = costStep(result(44.64, { duration_api_ms: 920_000, modelUsage: { o: usage(12, 5200, 950_000, 81_000) } }), seen)
  assert.ok(Math.abs(s.delta - 0.81) < 1e-9)
})

test('a resume that started over counts its whole total, even when it is higher than the last', () => {
  // 698be0c2: 4.117 -> 4.608 while API time fell 896232 -> 844511: a fresh count
  const seen = costMark(result(4.1169, { duration_api_ms: 896_232 }))!
  const next = costMark(result(4.6076, { duration_api_ms: 844_511 }))!
  assert.equal(carriesOn(next, seen), false)
  assert.equal(costStep(result(4.6076, { duration_api_ms: 844_511 }), seen).delta, 4.6076)
  // a model's tokens falling says the same
  const was = costMark(result(0.4, { modelUsage: { s: usage(10, 100, 5000, 2000) } }))
  assert.equal(costStep(result(0.9, { modelUsage: { s: usage(5, 400, 1000, 2000) } }), was).delta, 0.9)
  // and a model the last result had, missing now
  assert.equal(costStep(result(0.9, { modelUsage: { t: usage(5, 400, 1000, 9000) } }), was).delta, 0.9)
})

test('a drop is a restart; no usable total moves nothing', () => {
  const seen = costMark(result(103.75))
  assert.equal(costStep(result(3.04), seen).delta, 3.04)
  assert.deepEqual(costStep(result(0, { subtype: 'error_during_execution', is_error: true }), seen), { delta: 0, seen })
  assert.deepEqual(costStep({ type: 'result', subtype: 'success' }, seen), { delta: 0, seen })
})
