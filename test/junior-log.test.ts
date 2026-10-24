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
  tool: 'Bash',
  kind: 'message',
  summary: 'Slack message to Anirudha',
  args: { command: 'gh pr comment 3235 -R acme/api --body "Fixed."' },
  groupKey: null,
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
    jobLine({ sessionId: 'j1', title: 'Sentry junior', status: 'ok', matches: 2, at: 400 }),
  ]
  assert.deepEqual(logPage(lines, 'all', null, 10).lines.map((l) => l.at), [400, 300, 200, 110])
  assert.deepEqual(logPage(lines, 'sent', null, 10).lines.map((l) => l.id), ['send:s1:t1'])
  const p1 = logPage(lines, 'all', null, 2)
  assert.equal(p1.more, true)
  assert.deepEqual(logPage(lines, 'all', p1.lines.at(-1)!.at, 2).lines.map((l) => l.at), [200, 110])
  assert.equal(latestAt(lines), 400)
  assert.equal(jobLine({ sessionId: 'j', title: 'x', status: 'failed', at: 1 }).tone, 'red')
})

test('a send line carries its impact line only when it reached someone, may have, or still could', () => {
  const sent = actionLine(act({ kind: 'comment' }), null)
  assert.equal(sent.impact, 'Comment on acme/api#3235 · as you · can edit or delete, not unsend')
  const held = actionLine(act({ status: 'needs_you', allowedBy: null, settledAt: null }), null)
  assert.equal(held.impact, 'Comment on acme/api#3235 · as you · can edit or delete, not unsend')
  for (const status of ['rejected', 'failed', 'denied', 'expired', 'sent_back'] as const) {
    assert.equal(actionLine(act({ status }), null).impact, undefined, status)
  }
})

test('the impact line reads what went out: the held args (your edit), not the trimmed record', () => {
  const edited = actionLine(
    act({ tool: 'mcp__claude_ai_Slack__slack_send_message', args: { channel_id: 'C1', text: 'x' }, queue: { args: { channel_id: '#payments', text: 'x' } } }),
    null,
  )
  assert.match(edited.impact ?? '', /#payments/)
  assert.match(edited.impact ?? '', / · as you/)
})

test('task and job lines carry no impact line', () => {
  assert.equal(taskLine({ id: 'k1', itemId: 'i', title: 'Fix lint', owner: 'junior', state: 'done', endedAt: 200 })?.impact, undefined)
  assert.equal(jobLine({ sessionId: 'j1', title: 'Sentry junior', status: 'ok', at: 400 }).impact, undefined)
})
