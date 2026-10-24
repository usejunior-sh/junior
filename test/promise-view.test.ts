/**
 * How a promise row reads (core/work/promise-view.ts) and its next move
 * (core/work/next.ts): who's owed leads, never "Answer Dev"; the due rides in
 * the reasons, orange-worthy only once late. Times are local, so the day
 * words don't move with the machine's zone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { owedName, promiseDue, promiseSays, promiseVerb, quoted, saidWhen } from '../core/work/promise-view.js'
import { MAX_WORDS, NEXT_VERBS, nextMove, wordCount } from '../core/work/next.js'
import { flowOf } from '../core/work/flow.js'
import type { ScoredItem } from '../core/work/types.js'

// Thursday Oct 22, 2026, 10:00 local
const NOW = new Date(2026, 9, 22, 10, 0).getTime()
const day = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime()

test('the due as words: today, tomorrow, a weekday, a date, and late', () => {
  assert.equal(promiseDue(undefined, NOW), null)
  assert.equal(promiseDue(NaN, NOW), null)
  assert.deepEqual(promiseDue(day(22), NOW), { days: 0, overdue: false, reason: 'due today', cell: 'Due today', line: 'Today' })
  // a due with a time still counts by its day
  assert.equal(promiseDue(day(22, 17), NOW)?.reason, 'due today')
  assert.equal(promiseDue(day(23), NOW)?.cell, 'Due tomorrow')
  assert.equal(promiseDue(day(27), NOW)?.reason, 'due Tue')
  assert.equal(promiseDue(day(27), NOW)?.cell, 'Due Tue')
  assert.equal(promiseDue(new Date(2026, 10, 3).getTime(), NOW)?.reason, 'due Nov 3')
  const late = promiseDue(day(21), NOW)!
  assert.deepEqual(late, { days: -1, overdue: true, reason: 'overdue 1d', cell: 'Overdue 1d', line: 'Wed, 1 day late' })
  assert.equal(promiseDue(day(19), NOW)?.line, 'Mon, 3 days late')
  // earlier today is not late: due is a day
  assert.equal(promiseDue(day(22, 9), NOW)?.overdue, false)
})

test('who is owed, as the row names them', () => {
  assert.equal(owedName(undefined), null)
  assert.equal(owedName('  '), null)
  assert.equal(owedName('@dev'), 'dev')
  assert.equal(owedName('Dev Patel'), 'Dev')
  assert.equal(owedName('<@U04AB|dev>'), 'dev')
  assert.equal(promiseVerb('Dev Patel'), 'Owed to Dev')
  assert.equal(promiseVerb(''), 'Your promise')
})

test("Junior's line on the open card", () => {
  assert.equal(promiseSays('Dev', null), 'You told Dev you would.')
  assert.equal(promiseSays('Dev', promiseDue(day(22), NOW)), "You told Dev you would. It's due today.")
  assert.equal(promiseSays('Dev', promiseDue(day(21), NOW)), "You told Dev you would. It's 1 day late.")
  assert.equal(promiseSays(undefined, promiseDue(day(20), NOW)), "You said you would. It's 2 days late.")
  assert.equal(promiseSays('Dev', promiseDue(day(27), NOW)), 'You told Dev you would.')
})

test('when you said it, and the quote in curly quotes', () => {
  assert.equal(saidWhen(day(20, 16, 12), NOW), 'Tue 4:12 pm')
  assert.equal(saidWhen(day(22, 0, 5), NOW), 'Thu 12:05 am')
  assert.equal(saidWhen(day(12, 9, 0), NOW), 'Oct 12, 9:00 am')
  assert.equal(quoted("I'll look at it tomorrow"), '“I\'ll look at it tomorrow”')
  assert.equal(quoted('"on it"'), '“on it”')
})

function promiseItem(over: Partial<ScoredItem> = {}): ScoredItem {
  const base = {
    id: 'promise:slack:C1/p2~0011223344556677',
    source: 'slack',
    kind: 'promise',
    title: "I'll look at the retry fix tomorrow",
    url: 'https://slack.com/archives/C1/p2',
    repo: '#eng-api',
    author: 'Dev',
    peopleWaiting: 1,
    createdAt: new Date(day(20, 16, 12)).toISOString(),
    updatedAt: new Date(day(20, 16, 12)).toISOString(),
    status: 'open',
    score: 60,
    group: 'blocking',
    rankWhy: '',
    ask: 'do',
    reason: 'assigned',
    promise: { quote: "I'll look at the retry fix tomorrow", thread: 'slack:C1/p2', owedTo: 'Dev', saidAt: day(20, 16, 12), dueAt: day(21, 17) },
    dueAt: day(21),
    ...over,
  } as ScoredItem
  return { ...base, flow: base.flow ?? flowOf(base) }
}

test('a promise row leads with who is owed, never "Answer Dev"', () => {
  const m = nextMove(promiseItem(), {}, NOW)
  assert.equal(m.verb, 'Owed to Dev')
  assert.equal(m.reasons[0], 'overdue 1d')
  assert.match(m.text, /^Owed to Dev · overdue 1d/)
  assert.ok(NEXT_VERBS.has(m.text.split(' ')[0]!))
  assert.ok(wordCount(m.text) <= MAX_WORDS)

  const mine = nextMove(promiseItem({ author: '', peopleWaiting: 0, dueAt: undefined, promise: { quote: 'on it', thread: 'slack:C1/p2', saidAt: day(20) } }), {}, NOW)
  assert.equal(mine.verb, 'Your promise')
  assert.ok(!mine.reasons.some((r) => r.startsWith('due') || r.startsWith('overdue')))
  assert.ok(NEXT_VERBS.has(mine.text.split(' ')[0]!))

  // snoozed: it leaves your hands, and the due goes with it
  const later = nextMove(promiseItem({ status: 'snoozed' }), {}, NOW)
  assert.ok(!later.reasons.some((r) => r.startsWith('overdue')))
})
