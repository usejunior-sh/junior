/**
 * Junior's log (core/junior/log.ts): sends, finished tasks and job runs in one
 * feed; Sent keeps only what left the machine, each with who allowed it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionLine, allowedOf, jobLine, latestAt, logPage, type LogAction, taskLine } from '../core/junior/log.js'

const act = (over: Partial<LogAction> = {}): LogAction => ({
  id: 's1:t1',
  sessionId: 's1',
  sessionKind: 'chat',
  kind: 'message',
  summary: 'Slack message to Anirudha',
  status: 'succeeded',
  link: 'https://acme.slack.com/archives/D1/p1',
  error: null,
  allowedBy: 'prompt',
  allowedDetail: null,
  itemId: null,
  attemptedAt: 100,
  settledAt: 110,
  updatedAt: 110,
  ...over,
})

test('who allowed a send, as the log says it', () => {
  assert.deepEqual(allowedOf(act()), { by: 'you', text: 'you' })
  assert.deepEqual(allowedOf(act({ allowedBy: 'rule', allowedDetail: 'DM Anirudha on Slack (#a1b2c3)' })), { by: 'rule', text: 'rule · DM Anirudha on Slack' })
  assert.deepEqual(allowedOf(act({ allowedBy: 'policy', allowedDetail: 'free: a push to your own branch' })), { by: 'free', text: 'free: a push to your own branch' })
  assert.deepEqual(allowedOf(act({ allowedBy: 'rule', allowedDetail: 'the job’s grants', sessionKind: 'job-run' })), { by: 'job', text: 'the job’s grants' })
})

test('a send line: sent only once it went out; the allowed-by only once settled', () => {
  const sent = actionLine(act({ allowedBy: 'rule', allowedDetail: 'DM Anirudha on Slack (#a1b2c3)' }), 'My chat')
  assert.equal(sent.sent, true)
  assert.equal(sent.state, 'sent')
  assert.equal(sent.allowed?.text, 'rule · DM Anirudha on Slack')
  assert.equal(sent.at, 110)
  const held = actionLine(act({ status: 'needs_you', allowedBy: null, settledAt: null, updatedAt: 105 }), null)
  assert.equal(held.sent, false)
  assert.equal(held.state, 'waiting on you')
  assert.equal(held.allowed, undefined)
})

test('tasks: Junior’s finished ones, not a reviewer request (its send is the line)', () => {
  const t = { id: 'k1', itemId: 'github:a/b#1', title: 'Fix lint', owner: 'junior', state: 'done' as const, endedAt: 200, output: { summary: 'removed unused import' } }
  assert.equal(taskLine(t)?.title, 'Fix lint: removed unused import')
  assert.equal(taskLine({ ...t, state: 'running' }), null)
  assert.equal(taskLine({ ...t, owner: 'you' }), null)
  assert.equal(taskLine({ ...t, step: 'request-review' }), null)
})

test('the page: newest first, Sent filters, before pages', () => {
  const lines = [
    actionLine(act(), null),
    actionLine(act({ id: 's1:t2', status: 'needs_you', settledAt: null, updatedAt: 300 }), null),
    taskLine({ id: 'k1', itemId: 'i', title: 'Fix lint', owner: 'junior', state: 'done', endedAt: 200 })!,
    jobLine({ sessionId: 'j1', title: 'Sentry triage', status: 'ok', matches: 2, at: 400 }),
  ]
  assert.deepEqual(logPage(lines, 'all', null, 10).lines.map((l) => l.at), [400, 300, 200, 110])
  assert.deepEqual(logPage(lines, 'sent', null, 10).lines.map((l) => l.id), ['send:s1:t1'])
  const p1 = logPage(lines, 'all', null, 2)
  assert.equal(p1.more, true)
  assert.deepEqual(logPage(lines, 'all', p1.lines.at(-1)!.at, 2).lines.map((l) => l.at), [200, 110])
  assert.equal(latestAt(lines), 400)
  assert.equal(jobLine({ sessionId: 'j', title: 'x', status: 'failed', at: 1 }).tone, 'red')
})
