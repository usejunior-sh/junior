/**
 * One card to approve bot replies (plan item bot-triage-card): the card's pure
 * half (core/babysit/bot-card.ts) and the thread's line, carried from GitHub's
 * answer to the card's file:line.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimOf, edited, emptyRows, fileLine, fileOf, firstLine, plainClaim, retryLine, rowsLeft, sendBody, sendLabel, startPicks, tally } from '../core/babysit/bot-card.js'
import { botRepliesOf, repliesTask, replyEditsFrom, replyPlan, type BotReply } from '../core/babysit/bot-replies.js'
import { snapshotFrom } from '../core/babysit/snapshot.js'
import { triageThreadsOf, triageTask, type TriageThread } from '../core/babysit/watch.js'

const reply = (id: string, over: Partial<BotReply> = {}): BotReply => ({
  threadId: id,
  author: 'coderabbitai[bot]',
  bot: 'CodeRabbit',
  rule: 'nitpick',
  path: `src/${id.toLowerCase()}.ts`,
  line: 42,
  url: `https://gh/${id}`,
  message: 'Use a stricter type than any here',
  body: '_Nitpick_\n\nUse a stricter type than any here.',
  verdict: 'wont-fix',
  reply: 'Keeping the any: it is the raw webhook body.\nTyped one layer up.',
  ...over,
})

const R = [reply('A'), reply('B', { verdict: 'incorrect', reply: 'row.user is NOT NULL.' }), reply('C')]

test('fileLine: file:line, the file alone, or the bot when there is no file', () => {
  assert.equal(fileLine(reply('A')), 'a.ts:42')
  assert.equal(fileLine(reply('A', { line: undefined })), 'a.ts')
  assert.equal(fileLine(reply('A', { path: null })), 'CodeRabbit')
  assert.equal(fileLine(reply('A', { path: null, bot: null, author: 'cursor[bot]' })), 'Bugbot')
  assert.equal(fileOf(reply('A', { path: 'deep/dir/x.tsx' })), 'x.tsx')
  assert.equal(fileOf(reply('A', { path: null })), 'CodeRabbit’s comment')
})

test('claimOf: the triage message, else the comment made plain', () => {
  assert.equal(claimOf(reply('A')), 'Use a stricter type than any here')
  assert.equal(claimOf(reply('A', { message: ' ', body: '**Bug**\n<!-- x -->Null deref on `row.user`' })), 'Bug. Null deref on row.user')
  assert.equal(plainClaim('a'.repeat(20), 10), `${'a'.repeat(9)}…`)
})

test('firstLine: the first non-empty line', () => {
  assert.equal(firstLine('\n\n  hello \nworld'), 'hello')
  assert.equal(firstLine(''), '')
})

test('sendLabel: the button counts replies and fixes', () => {
  assert.equal(sendLabel({ replies: 3, fixes: 0 }), 'Send 3 replies')
  assert.equal(sendLabel({ replies: 1, fixes: 0 }), 'Send 1 reply')
  assert.equal(sendLabel({ replies: 2, fixes: 1 }), 'Send 2 replies · 1 to fix')
  assert.equal(sendLabel({ replies: 0, fixes: 2 }), 'Hand 2 to Junior to fix')
})

test('untouched card: nothing changed goes on the wire, and every reply goes as Junior drafted it', () => {
  const picks = startPicks(R)
  const body = sendBody('t1', R, picks)
  assert.deepEqual(body, { id: 't1', threads: [] })
  assert.deepEqual(tally(R, picks), { replies: 3, fixes: 0 })
  const plan = replyPlan(R, [], { by: 'you' }, replyEditsFrom(body))
  assert.deepEqual(plan.sends.map((s) => s.body), R.map((r) => r.reply))
})

test('an edited reply is what goes out; a flip to Fix sends only the verdict', () => {
  const picks = startPicks(R)
  picks.A = { ...picks.A!, reply: '  My own words.  ' }
  picks.C = { ...picks.C!, verdict: 'fix', reply: 'ignored edit' }
  picks.B = { ...picks.B!, verdict: 'wont-fix' }
  assert.equal(edited(R[0]!, picks.A), true)
  assert.equal(edited(R[1]!, picks.B), false)
  const body = sendBody('t1', R, picks)
  assert.deepEqual(body.threads, [
    { threadId: 'A', reply: 'My own words.' },
    { threadId: 'B', verdict: 'wont-fix' },
    { threadId: 'C', verdict: 'fix' },
  ])
  assert.deepEqual(tally(R, picks), { replies: 2, fixes: 1 })
  const plan = replyPlan(R, [], { by: 'you' }, replyEditsFrom(body))
  assert.deepEqual(plan.sends.map((s) => [s.reply.threadId, s.body, s.verdict]), [
    ['A', 'My own words.', 'wont-fix'],
    ['B', 'row.user is NOT NULL.', 'wont-fix'],
  ])
  assert.deepEqual(plan.fixes.map((r) => r.threadId), ['C'])
})

test('an empty reply blocks the send unless that row is Fix', () => {
  const picks = startPicks(R)
  picks.B = { ...picks.B!, reply: '   ' }
  assert.deepEqual(emptyRows(R, picks), ['B'])
  picks.B = { ...picks.B!, verdict: 'fix' }
  assert.deepEqual(emptyRows(R, picks), [])
})

test('partly sent: handled rows drop out of the count and the body', () => {
  const left = rowsLeft(R, ['A'])
  assert.deepEqual(left.map((r) => r.threadId), ['B', 'C'])
  const picks = startPicks(R)
  picks.A = { ...picks.A!, reply: 'late edit' }
  assert.deepEqual(sendBody('t1', left, picks).threads, [])
  assert.equal(sendLabel(tally(left, picks)), 'Send 2 replies')
  assert.equal(retryLine(1, 'HTTP 502.'), '1 reply didn’t go out: HTTP 502. Send again to retry.')
})

test('the thread line rides from GitHub to the card', () => {
  const snap = snapshotFrom({ repo: 'o/r', number: 1 }, {
    data: { repository: { pullRequest: { url: 'u', state: 'OPEN', commits: { nodes: [] }, reviewThreads: { nodes: [
      { id: 'T1', isResolved: false, path: 'src/a.ts', line: 7, comments: { nodes: [{ url: 'x', body: 'b', author: { __typename: 'Bot', login: 'coderabbitai' } }] } },
      { id: 'T2', isResolved: false, path: 'src/b.ts', line: null, comments: { nodes: [{ url: 'y', body: 'b', author: { __typename: 'Bot', login: 'coderabbitai' } }] } },
    ] } } } },
  })
  assert.equal(snap.threads[0]!.line, 7)
  assert.equal('line' in snap.threads[1]!, false)

  const task = triageTask(snap.threads)
  const threads = triageThreadsOf(task.input) as TriageThread[]
  assert.equal(threads.find((t) => t.id === 'T1')!.line, 7)
  assert.equal(threads.find((t) => t.id === 'T2')!.line, undefined)

  const replies = repliesTask('tri', threads, [
    { threadId: 'T1', verdict: 'wont-fix', reply: 'no' },
    { threadId: 'T2', verdict: 'incorrect', reply: 'nope' },
  ])!
  const back = botRepliesOf(replies.input)
  assert.equal(back[0]!.line, 7)
  assert.equal(back[1]!.line, undefined)
  assert.equal(fileLine(back[0]!), 'a.ts:7')
  assert.equal(fileLine(back[1]!), 'b.ts')
  assert.equal(botRepliesOf({ replies: [{ ...back[0], line: -3 }] })[0]!.line, undefined)
})
