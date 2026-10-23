/**
 * The supervisor (server/supervise.ts): background work that fails is logged
 * with its area and workspace and never reaches the process; an uncaught
 * exception exits only when no session is mid-turn.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupervisor, decide, fireAndLog, originOf } from '../server/supervise.js'
import { recentLogs } from '../server/log.js'

const rt = { meta: { id: 'ws-test' } }
const settle = () => new Promise((r) => setImmediate(r))

test('a rejected promise is logged with its area and workspace, and does not throw', async () => {
  const area = `area-${Math.random().toString(36).slice(2)}`
  assert.doesNotThrow(() => fireAndLog(rt, area, Promise.reject(new Error('boom'))))
  await settle()
  const hits = recentLogs({ subsystem: area })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.level, 'error')
  assert.match(hits[0]!.message, /boom/)
  assert.equal(hits[0]!.fields?.workspace, 'ws-test')
})

test('a thunk that throws synchronously is logged, not thrown', async () => {
  const area = `area-${Math.random().toString(36).slice(2)}`
  assert.doesNotThrow(() =>
    fireAndLog(rt, area, () => {
      throw new Error('sync')
    }),
  )
  await settle()
  assert.match(recentLogs({ subsystem: area })[0]!.message, /sync/)
})

test('a thunk that rejects, and a non-Error reason, are logged', async () => {
  const area = `area-${Math.random().toString(36).slice(2)}`
  fireAndLog(null, area, async () => {
    throw 'plain string'
  })
  await settle()
  const [hit] = recentLogs({ subsystem: area })
  assert.match(hit!.message, /plain string/)
  assert.equal(hit!.fields?.workspace, undefined)
})

test('work that succeeds logs nothing', async () => {
  const area = `area-${Math.random().toString(36).slice(2)}`
  fireAndLog(rt, area, Promise.resolve(42))
  fireAndLog(rt, area, () => undefined)
  await settle()
  assert.equal(recentLogs({ subsystem: area }).length, 0)
})

test('a rejection keeps the daemon running, mid-turn or not', () => {
  assert.equal(decide('rejection', 0), 'keep-running')
  assert.equal(decide('rejection', 3), 'keep-running')
})

test('an exception exits when idle and waits for the turns otherwise', () => {
  assert.equal(decide('exception', 0), 'exit')
  assert.equal(decide('exception', 1), 'wait-for-turns')
})

test('originOf names the first frame in our own code and its area', () => {
  const root = '/repo'
  const stack = [
    'Error: x',
    '    at Object.fn (node:internal/process/task_queues:95:5)',
    '    at thing (/repo/node_modules/ws/lib/x.js:1:1)',
    '    at pumpOnce (/repo/server/tasks/runner.ts:393:7)',
    '    at /repo/server/index.ts:10:1',
  ].join('\n')
  assert.deepEqual(originOf(stack, root), { where: 'server/tasks/runner.ts:393', area: 'tasks' })
  assert.deepEqual(originOf('Error: y\n    at file:///repo/server/index.ts:12:3', root), { where: 'server/index.ts:12', area: 'index' })
  assert.deepEqual(originOf('Error: z\n    at f (/repo/dist/core/work/score.js:4:2)', root), { where: 'core/work/score.ts:4', area: 'work' })
  assert.equal(originOf('Error: w\n    at f (/elsewhere/a.js:1:1)', root), null)
  assert.equal(originOf(undefined, root), null)
})

test('an uncaught exception with no turn running exits at once', () => {
  const exits: number[] = []
  const sup = createSupervisor({ midTurn: () => 0, exit: (c) => exits.push(c) })
  sup.onException(new Error('idle crash'))
  assert.deepEqual(exits, [1])
  assert.equal(sup.health(), null)
})

test('an uncaught exception mid-turn marks unhealthy and exits once the turns end', async () => {
  const exits: number[] = []
  let turns = 2
  const sup = createSupervisor({ midTurn: () => turns, exit: (c) => exits.push(c), pollMs: 5, now: () => 1000 })
  sup.onException(new Error('busy crash'))
  assert.deepEqual(exits, [])
  assert.deepEqual(sup.health(), { since: 1000, reason: 'busy crash' })
  sup.onException(new Error('second'))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(exits, [], 'still mid-turn: no exit')
  turns = 0
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(exits, [1], 'exits once, after the turns end')
})

test('a count that throws counts as mid-turn: nothing is cut off', () => {
  const exits: number[] = []
  const sup = createSupervisor({
    midTurn: () => {
      throw new Error('no count')
    },
    exit: (c) => exits.push(c),
    pollMs: 60_000,
  })
  sup.onException(new Error('crash'))
  assert.deepEqual(exits, [])
  assert.ok(sup.health())
})

test('an unhandled rejection is logged and the daemon keeps running', () => {
  const exits: number[] = []
  const sup = createSupervisor({ midTurn: () => 0, exit: (c) => exits.push(c) })
  sup.onRejection(new Error('stray rejection'))
  assert.deepEqual(exits, [])
  assert.ok(recentLogs({ q: 'stray rejection' }).some((e) => e.level === 'error'))
})
