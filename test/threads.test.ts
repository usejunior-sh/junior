/**
 * Threads and agent rows (core/junior/threads.ts): which sessions the sidebar
 * lists, in what order, and what each agent's row says.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentStatus, openThreads, pinnedThreads, READY_FOR_MS, threadReportLine, threadState, waitingThreads, type ThreadSession } from '../core/junior/threads.js'

const NOW = 1_800_000_000_000
const dm: ThreadSession = { id: 'dm', title: 'Junior', kind: 'dm', status: 'idle', updatedAt: NOW }
const s = (id: string, more: Partial<ThreadSession> = {}): ThreadSession => ({ id, title: id, status: 'idle', updatedAt: NOW - 60_000, ...more })

test('state: waiting beats working beats error', () => {
  assert.equal(threadState(s('a', { waiting: true, status: 'running' })), 'you')
  assert.equal(threadState(s('a', { status: 'running' })), 'working')
  assert.equal(threadState(s('a', { workflows: 1 })), 'working')
  assert.equal(threadState(s('a', { status: 'error' })), 'stopped')
  assert.equal(threadState(s('a')), 'ready')
  assert.equal(threadState(s('a', { teamRun: { role: 'lead', state: 'gate' } })), 'you')
})

test('open threads: what Junior started stays 12 hours; your own chats only while live', () => {
  const rows = [
    dm,
    s('mine-idle'),
    s('mine-busy', { status: 'running' }),
    s('jr-ready', { startedBy: 'dm', agent: 'reviewer' }),
    s('jr-old', { startedBy: 'dm', updatedAt: NOW - READY_FOR_MS - 1 }),
    s('jr-stopped-old', { startedBy: 'dm', status: 'error', updatedAt: NOW - READY_FOR_MS - 1 }),
    s('jr-asks', { startedBy: 'dm', waiting: true, waitingOn: 'AskUserQuestion', updatedAt: NOW - 3_600_000 }),
    s('brief', { kind: 'brief', status: 'running' }),
    s('worker', { status: 'running', teamRun: { role: 'worker' } }),
  ]
  const t = openThreads(rows, NOW)
  assert.deepEqual(
    t.map((x) => [x.id, x.state]),
    [
      ['jr-asks', 'you'],
      ['jr-stopped-old', 'stopped'],
      ['mine-busy', 'working'],
      ['jr-ready', 'ready'],
    ],
  )
  assert.equal(t[0].question, true)
  assert.equal(t[0].fromJunior, true)
  assert.equal(t[3].agent, 'reviewer')
  assert.equal(t.find((x) => x.id === 'mine-busy')?.fromJunior, false)
})

test('agent status: you, then working, then what it is for', () => {
  const rows = [
    s('r1', { agent: 'reviewer', waiting: true, waitingOn: 'AskUserQuestion' }),
    s('r2', { agent: 'reviewer', status: 'running' }),
    s('b1', { agent: 'babysitter', status: 'running' }),
    s('b2', { agent: 'babysitter', status: 'running' }),
    s('w1', { agent: 'writer', waiting: true, waitingOn: 'Bash' }),
  ]
  assert.deepEqual(agentStatus('reviewer', rows, 'Reviews'), { state: 'you', line: '1 question for you', threads: 2 })
  assert.deepEqual(agentStatus('babysitter', rows, 'Babysits'), { state: 'working', line: 'Working on 2 threads', threads: 2 })
  assert.deepEqual(agentStatus('writer', rows, 'Writes'), { state: 'you', line: '1 thing for you', threads: 1 })
  assert.deepEqual(agentStatus('explainer', rows, 'Explains'), { state: 'idle', line: 'Explains', threads: 0 })
  // its own chat is not a thread
  assert.deepEqual(agentStatus('debugger', [s('d', { kind: 'dm', agent: 'debugger', status: 'running' })], 'Debugs'), { state: 'working', line: 'Replying to you', threads: 0 })
})

test('thread report line: first sentence, plain, cut long', () => {
  assert.equal(threadReportLine('Reviewer', 'Review members.ts', 'Nothing in `members.ts` is **broken** today. Two risks follow.'), 'Reviewer replied in "Review members.ts": Nothing in members.ts is broken today.')
  assert.equal(threadReportLine('Babysitter', 'Get #482 green', ''), 'Babysitter replied in "Get #482 green".')
  const long = threadReportLine('R', 't', 'x'.repeat(400))
  assert.ok(long.endsWith('…') && long.length < 220)
})

test('waiting threads: every agent, Junior and job runs, held or with sends waiting; never a DM', () => {
  const rows = [
    { ...dm, waiting: true },
    s('reviewer-dm', { kind: 'dm', agent: 'reviewer' }),
    s('jr-asks', { startedBy: 'dm', waiting: true, waitingOn: 'AskUserQuestion', updatedAt: NOW - 3_600_000 }),
    s('job-sends', { startedBy: 'reviewer-dm', agent: 'reviewer', jobId: 'babysit', updatedAt: NOW - 1_000 }),
    s('junior-sends', { updatedAt: NOW - 2_000 }),
    s('quiet', { startedBy: 'dm' }),
  ]
  const t = waitingThreads(rows, new Set(['job-sends', 'junior-sends', 'jr-asks', 'reviewer-dm', 'gone']), NOW)
  assert.deepEqual(
    t.map((x) => [x.id, x.state, x.agent ?? null, x.job, x.fromJunior]),
    [
      ['job-sends', 'you', 'reviewer', true, true],
      ['junior-sends', 'you', null, false, false],
      ['jr-asks', 'you', null, false, true],
    ],
  )
  assert.equal(t[2]!.question, true)
})

test('pinned threads: every agent, finished ones stay, a needs row reads as yours; DMs never', () => {
  const rows = [
    { ...dm, pinned: true },
    s('done', { pinned: true, startedBy: 'dm', agent: 'reviewer', updatedAt: NOW - READY_FOR_MS - 1 }),
    s('asks', { pinned: true, waiting: true, waitingOn: 'AskUserQuestion' }),
    s('send', { pinned: true, updatedAt: NOW - 1_000 }),
    s('loose'),
    s('worker', { pinned: true, teamRun: { role: 'worker' } }),
  ]
  const pinned = pinnedThreads(rows, new Set(['send']))
  assert.deepEqual(pinned.map((t) => [t.id, t.state]), [['send', 'you'], ['asks', 'you'], ['done', 'ready']])
  assert.equal(pinned[2].agent, 'reviewer')
  assert.equal(pinned[1].question, true)
})
