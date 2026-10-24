/**
 * The log file's write queue (server/log-writer.ts): lines are batched off the
 * hot path, land in order, and an exit flush writes what's left synchronously,
 * the batch still in flight included. Driven by a fake sink and a fake timer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLogWriter, groupByFile, type LogSink } from '../server/log-writer.js'
import { flushLogs, initLogFile, log } from '../server/log.js'

interface Call {
  kind: 'async' | 'sync'
  file: string
  text: string
}

/** A sink whose async appends resolve only when the test says so. */
function fakeSink() {
  const calls: Call[] = []
  const waiting: (() => void)[] = []
  let fail = false
  const sink: LogSink = {
    append(file, text) {
      calls.push({ kind: 'async', file, text })
      return new Promise((resolve, reject) => waiting.push(() => (fail ? reject(new Error('disk full')) : resolve())))
    },
    appendSync(file, text) {
      calls.push({ kind: 'sync', file, text })
    },
  }
  const settleAll = async () => {
    while (waiting.length) {
      waiting.shift()!()
      await new Promise((r) => setImmediate(r))
    }
  }
  return { sink, calls, settleAll, failNext: () => (fail = true) }
}

/** A timer the test fires by hand. */
function fakeTimer() {
  let pending: (() => void) | null = null
  let armed = 0
  return {
    schedule: (fn: () => void) => {
      pending = fn
      armed++
      return () => {
        pending = null
      }
    },
    fire() {
      const fn = pending
      pending = null
      fn?.()
    },
    get armed() {
      return armed
    },
    get isPending() {
      return pending !== null
    },
  }
}

const tick = () => new Promise((r) => setImmediate(r))

test('write only queues; nothing touches the sink until the timer fires', () => {
  const { sink, calls } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('a.jsonl', '1')
  w.write('a.jsonl', '2')
  assert.equal(calls.length, 0)
  assert.equal(w.pending(), 2)
  assert.equal(timer.armed, 1, 'one timer for the whole batch')
})

test('a batch is one append per file, lines in order', async () => {
  const { sink, calls, settleAll } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  for (const n of ['1', '2', '3']) w.write('a.jsonl', n)
  timer.fire()
  await tick()
  await settleAll()
  assert.deepEqual(calls, [{ kind: 'async', file: 'a.jsonl', text: '1\n2\n3\n' }])
  assert.equal(w.pending(), 0)
})

test('lines logged during a write wait for the next batch, after the first', async () => {
  const { sink, calls, settleAll } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('a.jsonl', '1')
  timer.fire()
  await tick()
  assert.equal(calls.length, 1, 'first batch in flight')
  w.write('a.jsonl', '2')
  w.write('a.jsonl', '3')
  assert.equal(calls.length, 1, 'no second append while one is in flight')
  await settleAll()
  assert.deepEqual(
    calls.map((c) => c.text),
    ['1\n', '2\n3\n'],
  )
})

test('a batch crossing midnight goes to each day file in order', async () => {
  const { sink, calls, settleAll } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('d1.jsonl', '1')
  w.write('d1.jsonl', '2')
  w.write('d2.jsonl', '3')
  timer.fire()
  await settleAll()
  assert.deepEqual(
    calls.map((c) => [c.file, c.text]),
    [
      ['d1.jsonl', '1\n2\n'],
      ['d2.jsonl', '3\n'],
    ],
  )
})

test('groupByFile keeps order and only merges neighbours', () => {
  assert.deepEqual(
    groupByFile([
      { file: 'a', line: '1' },
      { file: 'b', line: '2' },
      { file: 'a', line: '3' },
    ]),
    [
      { file: 'a', text: '1\n' },
      { file: 'b', text: '2\n' },
      { file: 'a', text: '3\n' },
    ],
  )
})

test('flushSync writes the queue synchronously and cancels the timer', () => {
  const { sink, calls } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('a.jsonl', '1')
  w.write('a.jsonl', '2')
  w.flushSync()
  assert.deepEqual(calls, [{ kind: 'sync', file: 'a.jsonl', text: '1\n2\n' }])
  assert.equal(timer.isPending, false)
  assert.equal(w.pending(), 0)
})

test('flushSync rewrites the batch still in flight, ahead of the queue', async () => {
  const { sink, calls } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('a.jsonl', '1')
  timer.fire()
  await tick()
  w.write('a.jsonl', '2')
  // process.exit now: the async append of "1" may never finish.
  w.flushSync()
  assert.deepEqual(calls, [
    { kind: 'async', file: 'a.jsonl', text: '1\n' },
    { kind: 'sync', file: 'a.jsonl', text: '1\n2\n' },
  ])
})

test('a failed append drops that batch and the next one still goes out', async () => {
  const { sink, calls, settleAll, failNext } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('a.jsonl', '1')
  failNext()
  timer.fire()
  await settleAll()
  w.write('a.jsonl', '2')
  timer.fire()
  await tick()
  assert.equal(calls.at(-1)!.text, '2\n')
})

test('flush() writes now without waiting for the timer', async () => {
  const { sink, calls, settleAll } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule })
  w.write('a.jsonl', '1')
  const done = w.flush()
  await tick()
  await settleAll()
  await done
  assert.equal(calls.length, 1)
  assert.equal(timer.isPending, false)
})

test('the queue is capped while the disk is slow; the oldest lines go first', () => {
  const { sink, calls } = fakeSink()
  const timer = fakeTimer()
  const w = createLogWriter({ sink, schedule: timer.schedule, maxPending: 2 })
  for (const n of ['1', '2', '3']) w.write('a.jsonl', n)
  w.flushSync()
  assert.equal(calls[0]!.text, '2\n3\n')
})

test('log() reaches the day file through the queue', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-log-'))
  try {
    initLogFile(dir)
    log('info', 'test', 'first')
    log('warn', 'test', 'second', { n: 2 })
    await flushLogs()
    const file = path.join(dir, `junior-${new Date().toISOString().slice(0, 10)}.jsonl`)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(
      lines.map((l) => l.message),
      ['first', 'second'],
    )
    assert.deepEqual(lines[1].fields, { n: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
