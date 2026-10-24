/**
 * Waiting on others (core/work/nudge.ts): the threshold in working days, the
 * per-person cooldown on a fake clock, and the nudge text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cooldownEndsAt, dueNudges, itemName, nudgeDueAt, nudgeText, refOf, type WaitingItem } from '../core/work/nudge.js'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
// 2026-10-23 is a Friday.
const FRI = at(2026, 10, 23, 10, 0)
const HOUR = 3_600_000

const pr = (n: number, people: Array<[string, number]>, extra: Partial<WaitingItem> = {}): WaitingItem => ({
  id: `github:acme/app#${n}`,
  title: `PR ${n}`,
  waitingOn: people.map(([person, since]) => ({ person, since })),
  ...extra,
})

test('weekends do not count toward the threshold', () => {
  const item = pr(3235, [['ana', FRI]])
  // Friday + 2 working days is Tuesday 10:00, same time of day
  assert.equal(nudgeDueAt(FRI), at(2026, 10, 27, 10))
  assert.deepEqual(dueNudges([item], at(2026, 10, 25, 23)), [], 'Sunday night: 0 working days')
  assert.deepEqual(dueNudges([item], at(2026, 10, 26, 18)), [], 'Monday: 1 working day')
  assert.deepEqual(dueNudges([item], at(2026, 10, 27, 9, 59)), [], 'Tuesday before 10:00')
  const due = dueNudges([item], at(2026, 10, 27, 10))
  assert.equal(due.length, 1)
  assert.equal(due[0]!.person, 'ana')
  assert.equal(due[0]!.workingDays, 2)
  // a wait started on a Saturday counts from Monday
  const sat = pr(1, [['bo', at(2026, 10, 24, 12)]])
  assert.deepEqual(dueNudges([sat], at(2026, 10, 27, 11)), [])
  assert.equal(dueNudges([sat], at(2026, 10, 27, 12)).length, 1)
})

test('the threshold is an option', () => {
  const item = pr(1, [['ana', at(2026, 10, 20, 10)]]) // Tuesday
  const thu = at(2026, 10, 22, 10)
  assert.equal(dueNudges([item], thu).length, 1)
  assert.equal(dueNudges([item], thu, { thresholdWorkingDays: 3 }).length, 0)
  assert.equal(dueNudges([item], at(2026, 10, 23, 10), { thresholdWorkingDays: 3 }).length, 1)
})

test('cooldown per person on a fake clock, across items', () => {
  const mon = at(2026, 10, 19, 9)
  const items = [pr(1, [['ana', mon]]), pr(2, [['bo', mon]])]
  const thu = at(2026, 10, 22, 9)
  assert.equal(dueNudges(items, thu).length, 2)
  const sent = [{ person: '@Ana', at: thu, itemId: items[0]!.id }]
  // ana was just nudged; bo still due
  assert.deepEqual(dueNudges(items, thu + HOUR, {}, sent).map((n) => n.person), ['bo'])
  assert.deepEqual(dueNudges(items, thu + 23 * HOUR + 59 * 60_000, {}, sent).map((n) => n.person), ['bo'])
  // 24 hours later ana is due again
  assert.deepEqual(dueNudges(items, thu + 24 * HOUR, {}, sent).map((n) => n.person), ['ana', 'bo'])
  // a nudge on another item still counts for the person
  const later = pr(3, [['ana', mon]])
  assert.deepEqual(dueNudges([later], thu + HOUR, {}, sent), [])
  // the newest nudge wins, and the window is an option
  const two = [...sent, { person: 'ana', at: thu - 48 * HOUR }]
  assert.equal(cooldownEndsAt('ana', two), thu + 24 * HOUR)
  assert.deepEqual(dueNudges(items, thu + 2 * HOUR, { cooldownHours: 1 }, sent).map((n) => n.person), ['ana', 'bo'])
  assert.equal(cooldownEndsAt('cy', sent), 0)
})

test('one nudge per person, for the longest wait; the rest ride along', () => {
  const items = [
    pr(10, [['ana', at(2026, 10, 15, 9)]]),
    pr(11, [['ana', at(2026, 10, 12, 9)], ['bo', at(2026, 10, 16, 9)]]),
    pr(12, [['ANA', at(2026, 10, 14, 9)]]),
  ]
  const due = dueNudges(items, FRI)
  assert.deepEqual(due.map((n) => [n.person, n.item.id]), [
    ['ana', 'github:acme/app#11'],
    ['bo', 'github:acme/app#11'],
  ])
  assert.deepEqual(due[0]!.alsoWaiting, ['github:acme/app#12', 'github:acme/app#10'])
  assert.deepEqual(due[1]!.alsoWaiting, [])
})

test('skips you, bots, blank names and bad start times', () => {
  const mon = at(2026, 10, 19, 9)
  const item = pr(1, [
    ['@me', mon],
    ['dependabot[bot]', mon],
    ['  ', mon],
    ['future', FRI + HOUR],
    ['nan', Number.NaN],
    ['ana', mon],
  ])
  assert.deepEqual(dueNudges([item], FRI, { me: 'Me' }).map((n) => n.person), ['ana'])
})

test('nudge text names the item in at most two sentences', () => {
  const sentences = (s: string) => s.split(/[.?!](?:\s|$)/).filter((x) => x.trim()).length
  const withBlocks = nudgeText({ id: 'github:acme/app#3235', title: 'Fix login redirect', blocks: 'release-4.2' }, 'ana')
  assert.equal(withBlocks, 'Hi @ana, could you look at #3235 (Fix login redirect)? It blocks release-4.2.')
  assert.equal(sentences(withBlocks), 2)

  const plain = nudgeText({ id: 'linear:NOV-456', title: 'Rate limits on export' }, '@bo')
  assert.equal(plain, 'Hi @bo, could you look at NOV-456 (Rate limits on export)?')
  assert.equal(sentences(plain), 1)

  // a messy title can't add sentences or lines
  const messy = nudgeText(
    { id: 'manual:x', title: 'Ship it. Then tell QA!\nAlso the very long tail of this title that goes on and on', blocks: 'the demo. Really.' },
    '<@U123>',
  )
  assert.ok(messy.startsWith('Hi <@U123>, could you look at "Ship it Then tell QA Also'), messy)
  assert.ok(!messy.includes('\n'))
  assert.equal(sentences(messy), 2, messy)
  assert.ok(messy.length < 160)
})

test('item names and refs', () => {
  assert.equal(refOf('github:acme/app#7'), '#7')
  assert.equal(refOf('linear:NOV-9'), 'NOV-9')
  assert.equal(refOf('slack:C1/123.456'), null)
  assert.equal(itemName({ id: 'slack:C1/1', title: 'Deploy question' }), '"Deploy question"')
  assert.equal(itemName({ id: 'x', title: '', ref: 'PR 5' }), 'PR 5')
})
