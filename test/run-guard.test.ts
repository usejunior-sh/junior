/**
 * Run guard (core/job/run-guard.ts): the sleep watch that tells a slept
 * run from a slow one, how a run's status is settled for sleep, and the
 * hard stop that ends a run whose stream never closes. Time is an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HardStop, SLEEP_TICK_MS, SleepWatch, settleRunStatus, untilStopped } from '../core/job/run-guard.js'

const T0 = new Date(2026, 9, 16, 3).getTime()
const MIN = 60_000

function ticking(watch: SleepWatch, from: number, to: number): void {
  for (let t = from; t <= to; t += SLEEP_TICK_MS) watch.tick(t)
}

test('sleep watch: steady ticks are no sleep; a long silence is', () => {
  const w = new SleepWatch()
  ticking(w, T0, T0 + 10 * MIN)
  assert.equal(w.sleptBetween(T0, T0 + 10 * MIN), 0)
  // Asleep 40 minutes, then ticking again.
  ticking(w, T0 + 50 * MIN, T0 + 55 * MIN)
  assert.equal(w.sleptBetween(T0, T0 + 55 * MIN), 40 * MIN)
  // Only the part inside the run counts.
  assert.equal(w.sleptBetween(T0 + 30 * MIN, T0 + 55 * MIN), 20 * MIN)
  assert.equal(w.sleptBetween(T0 + 51 * MIN, T0 + 55 * MIN), 0)
})

test('sleep watch: a gap still open (run ends at wake, before the next tick) counts', () => {
  const w = new SleepWatch()
  ticking(w, T0, T0 + MIN)
  assert.equal(w.sleptBetween(T0, T0 + 20 * MIN), 19 * MIN)
  // A short stall (a busy loop) is not sleep.
  assert.equal(w.sleptBetween(T0, T0 + MIN + 20_000), 0)
})

test('settle: ok and skipped keep their status; a run that lost a minute or more to sleep is slept', () => {
  assert.deepEqual(settleRunStatus('ok', 90 * MIN), { status: 'ok' })
  assert.deepEqual(settleRunStatus('skipped', 90 * MIN), { status: 'skipped' })
  assert.deepEqual(settleRunStatus('timeout', 30_000, 'timed out after 10m'), { status: 'timeout', error: 'timed out after 10m' })
  assert.deepEqual(settleRunStatus('timeout', 42 * MIN, 'timed out after 10m'), {
    status: 'slept',
    error: 'the Mac slept 42 min during the run — timed out after 10m',
  })
  assert.equal(settleRunStatus('interrupted', 5 * MIN).status, 'slept')
  assert.equal(settleRunStatus('failed', MIN).error, 'the Mac slept 1 min during the run')
})

test('untilStopped: passes everything through when the source ends', async () => {
  async function* three() {
    yield 1
    yield 2
    yield 3
  }
  const got: number[] = []
  for await (const n of untilStopped(three(), new Promise(() => {}))) got.push(n)
  assert.deepEqual(got, [1, 2, 3])
})

test('untilStopped: a hung source is ended by the stop, and told to return', async () => {
  let returned = false
  let n = 0
  const hung: AsyncIterable<number> = {
    [Symbol.asyncIterator]: () => ({
      next() {
        return n++ === 0 ? Promise.resolve({ done: false, value: 1 }) : new Promise<IteratorResult<number>>(() => {})
      },
      return() {
        returned = true
        return new Promise<IteratorResult<number>>(() => {}) // never answers either
      },
    }),
  }
  let stop!: () => void
  const stopped = new Promise<void>((r) => (stop = r))
  const got: number[] = []
  await assert.rejects(
    (async () => {
      for await (const n of untilStopped(hung, stopped)) {
        got.push(n)
        setTimeout(stop, 5)
      }
    })(),
    HardStop,
  )
  assert.deepEqual(got, [1])
  assert.equal(returned, true)
})
