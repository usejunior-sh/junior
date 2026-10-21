/**
 * The item page's verdict (core/work/verdict.ts): one scenario per row, from
 * the two items the redesign was drawn on (#3235, Niraj's Slack ask) plus the
 * edges: a fresh to-do, a done item, a send held on its own, others' turn.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verdictOf, type Verdict, type VerdictItem, type VerdictTask } from '../core/work/verdict.js'

const pr: VerdictItem = { kind: 'own-pr-open', source: 'github', author: 'samarkundal-pendo', status: 'open' }
const ask: VerdictItem = { kind: 'job-hit', ask: 'do', source: 'slack', author: 'Nirajsinh Rajput', status: 'open' }
const todo: VerdictItem = { kind: 'manual', source: 'manual', author: '', status: 'open' }

const jr = (state: VerdictTask['state'], step = 'fix-thread', title = 'Fix Bugbot comment on api.ts'): VerdictTask => ({ owner: 'junior', state, step, title })
const you = (step: string, title = 'Send reply to Niraj'): VerdictTask => ({ owner: 'you', state: 'waiting', step, title })

type Row = [name: string, item: VerdictItem, tasks: VerdictTask[], held: number, want: Partial<Verdict>, chats?: { total: number; running: number }]

const ROWS: Row[] = [
  // #3235, the three states of the mockup
  ['PR: two questions, one fix running', pr, [jr('waiting'), jr('waiting'), jr('running'), jr('done')], 0,
    { turn: 'you', needs: 2, say: 'Two things need your call.', sub: 'Junior is handling the rest.', tab: 'needs', handedOff: true }],
  ['PR: answered, Junior still fixing', pr, [jr('done'), jr('done'), jr('running', 'fix-thread', 'Fix Bugbot comment on incoming.ts')], 0,
    { turn: 'junior', needs: 0, sub: 'Working on: Fix Bugbot comment on incoming.ts.', tab: 'sessions' }],
  ['PR: green, pick a reviewer', pr, [jr('done'), you('request-review', 'Request a reviewer')], 0,
    { turn: 'ready', needs: 1, say: 'Ready for review. Pick a reviewer.', tab: 'needs' }],
  // Niraj's ask, before and after the hand-off
  ['ask: nobody has it', ask, [], 0,
    { turn: 'you', needs: 1, say: 'Nirajsinh is waiting on you.', sub: 'Hand it to Junior, or do it yourself.', tab: 'needs', handedOff: false }],
  ['ask: Junior drafting', ask, [jr('running', 'answer', 'Draft a reply to Niraj')], 0,
    { turn: 'junior', tab: 'sessions', handedOff: true }],
  ['ask: draft ready', ask, [jr('done', 'answer'), you('send-reply')], 0,
    { turn: 'you', needs: 1, say: 'Junior’s draft is ready. Read it, then send.', sub: 'Nothing goes out until you press Send.', tab: 'needs' }],
  // the edges
  ['to-do: fresh', todo, [], 0, { turn: 'you', needs: 1, say: 'This one’s yours. Nobody’s on it.', tab: 'needs' }],
  ['PR: nobody watching', pr, [], 0, { say: 'Your PR. Junior isn’t watching it.', tab: 'needs' }],
  ['a send held, nothing else', todo, [jr('done', 'debug-fix')], 1, { turn: 'you', needs: 1, say: 'One send waits for your OK.', sub: 'Nothing else is moving.' }],
  ['a held send plus a question', ask, [jr('waiting', 'investigate')], 2, { needs: 3, say: 'Three things need your call.' }],
  ['done', { ...pr, status: 'done' }, [jr('waiting')], 0, { turn: 'idle', needs: 0, say: 'Done.', tab: 'activity' }],
  ['others’ turn, not handed off', { ...ask, flow: { stage: 'review', turn: 'others', since: 0 } }, [], 0,
    { turn: 'others', say: 'Waiting on Nirajsinh.', tab: 'needs', needs: 0 }],
  ['a dispatched chat working, no tasks', { ...todo, flow: { stage: 'working', turn: 'ai', since: 0 } }, [], 0,
    { turn: 'junior', handedOff: true, tab: 'sessions', sub: 'You’ll hear from it if something needs you.' }],
  ['Junior finished, nothing waits', pr, [jr('done'), jr('failed')], 0,
    { turn: 'idle', say: 'Junior’s done for now. Nothing needs you.', tab: 'sessions' }],
  // chats dispatched on the item count as handing it off
  ['to-do: a team ran on it, brief ready', { ...todo, flow: { stage: 'ready', turn: 'me', next: 'read brief', since: 0 } }, [], 0,
    { turn: 'you', handedOff: true, needs: 0, say: 'The brief is ready. Read it.', sub: 'Nothing else is moving.', tab: 'needs' }, { total: 2, running: 0 }],
  ['to-do: a chat mid-turn', todo, [], 0, { turn: 'junior', handedOff: true, tab: 'sessions' }, { total: 1, running: 1 }],
  ['to-do: Junior’s chat asked you', { ...todo, flow: { stage: 'working', turn: 'me', next: 'answer the session', since: 0 } }, [], 0,
    { say: 'Junior asked you something in its chat.', tab: 'sessions' }, { total: 1, running: 1 }],
  ['own PR, CI red, nobody watching', { ...pr, flow: { stage: 'review', turn: 'me', next: 'fix CI', broken: 'CI failing', since: 0 } }, [], 0,
    { say: 'CI is failing.', needs: 1, sub: 'Hand it to Junior, or do it yourself.', tab: 'needs' }],
]

for (const [name, item, tasks, held, want, chats] of ROWS) {
  test(`verdict: ${name}`, () => {
    const got = verdictOf(item, tasks, held, chats)
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k as keyof Verdict], v, `${name}: ${k}`)
  })
}

test('verdict: skipped and stopped tasks neither wait nor hand off on their own', () => {
  const got = verdictOf(ask, [{ owner: 'you', state: 'skipped', step: 'send-reply', title: 'x' }], 0)
  assert.equal(got.handedOff, false)
  assert.equal(got.say, 'Nirajsinh is waiting on you.')
})
