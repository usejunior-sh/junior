/**
 * Plain-words times (shared/when.ts). Local time throughout, so every date
 * here is built with the local Date constructor against a fixed reference.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addWorkingDays, isWorkingDay, parseWhen, timeLabel, whenLabel, workingDaysBetween } from '../shared/when.js'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
// 2026-10-23 is a Friday.
const FRI = at(2026, 10, 23, 10, 30)
const SAT = at(2026, 10, 24, 11, 0)
const WED = at(2026, 10, 21, 10, 30)

const when = (text: string, ref = FRI) => parseWhen(text, ref)?.at ?? null

test('phrases parse to the expected time against a fixed Friday 10:30', () => {
  const cases: Array<[string, number]> = [
    ['till Tuesday 9am', at(2026, 10, 27, 9)],
    ['tomorrow', at(2026, 10, 24, 9)],
    ['tomorrow 3pm', at(2026, 10, 24, 15)],
    ['in 2 hours', at(2026, 10, 23, 12, 30)],
    ['in 30 minutes', at(2026, 10, 23, 11)],
    ['30 min', at(2026, 10, 23, 11)],
    ['Monday', at(2026, 10, 26, 9)],
    ['until monday morning', at(2026, 10, 26, 9)],
    ['next Friday at noon', at(2026, 10, 30, 12)],
    ['Oct 30', at(2026, 10, 30, 9)],
    ['Nov 3 at 2pm', at(2026, 11, 3, 14)],
    ['9am', at(2026, 10, 24, 9)],
    ['noon', at(2026, 10, 23, 12)],
    ['tonight', at(2026, 10, 23, 20)],
    ['this evening', at(2026, 10, 23, 18)],
    ['in a week', at(2026, 10, 30, 9)],
    ['after 2 working days', at(2026, 10, 27, 9)],
    ['in 3 business days', at(2026, 10, 28, 9)],
    ['next working day', at(2026, 10, 26, 9)],
    ['after 2 working days at 3pm', at(2026, 10, 27, 15)],
    ['eod', at(2026, 10, 23, 17)],
    ['by end of day', at(2026, 10, 23, 17)],
    ['end of the week', at(2026, 10, 23, 17)],
  ]
  for (const [text, expected] of cases) {
    const got = when(text)
    assert.equal(got === null ? null : new Date(got).toString(), new Date(expected).toString(), text)
  }
})

test("'after 2 working days' on a Friday lands on Tuesday", () => {
  const r = parseWhen('after 2 working days', FRI)
  assert.ok(r)
  assert.equal(new Date(r.at).getDay(), 2)
  assert.equal(r.at, at(2026, 10, 27, 9))
  assert.equal(r.text, 'after 2 working days')
})

test('working days skip the weekend from a Saturday too', () => {
  assert.equal(when('after 2 working days', SAT), at(2026, 10, 27, 9))
  assert.equal(when('next business day', SAT), at(2026, 10, 26, 9))
  assert.equal(when('in one working day', WED), at(2026, 10, 22, 9))
})

test('unparseable text returns null', () => {
  for (const text of ['', '   ', 'soon', 'whenever', 'asdf', 'I will fix it in a follow-up', 'after 0 working days']) {
    assert.equal(parseWhen(text, FRI), null, JSON.stringify(text))
  }
})

test('a time already past returns null; a passed weekday means next week', () => {
  assert.equal(parseWhen('today', FRI), null)
  assert.equal(parseWhen('yesterday', FRI), null)
  // "friday" on a Friday after 9:00 is next Friday
  assert.equal(when('friday'), at(2026, 10, 30, 9))
  // before 9:00 it is still today
  assert.equal(when('friday', at(2026, 10, 23, 8)), at(2026, 10, 23, 9))
})

test('end of day after 17:00 rolls to the next working day', () => {
  assert.equal(when('eod', at(2026, 10, 23, 18)), at(2026, 10, 26, 17))
  assert.equal(when('cob', at(2026, 10, 21, 18)), at(2026, 10, 22, 17))
  assert.equal(when('eow', at(2026, 10, 23, 18)), at(2026, 10, 30, 17))
  assert.equal(when('end of week', WED), at(2026, 10, 23, 17))
})

test('a phrase inside a sentence is found, the earliest one wins', () => {
  const r = parseWhen("I'll look at it tomorrow afternoon, promise", FRI)
  assert.ok(r)
  assert.equal(r.at, at(2026, 10, 24, 14))
  assert.equal(r.text, 'tomorrow afternoon')
  assert.equal(when('will fix after 2 working days or by Nov 3'), at(2026, 10, 27, 9))
})

test('options move the default and end-of-day hours', () => {
  assert.equal(parseWhen('tomorrow', FRI, { defaultHour: 8 })?.at, at(2026, 10, 24, 8))
  assert.equal(parseWhen('eod', FRI, { endOfDayHour: 18 })?.at, at(2026, 10, 23, 18))
  assert.equal(parseWhen('tomorrow', new Date(FRI))?.at, at(2026, 10, 24, 9))
})

test('labels read in local time from the reference day', () => {
  const t9 = timeLabel(at(2026, 10, 24, 9))
  assert.equal(parseWhen('tomorrow', FRI)?.label, `Tomorrow ${t9}`)
  assert.equal(whenLabel(at(2026, 10, 23, 15), FRI), `Today ${timeLabel(at(2026, 10, 23, 15))}`)
  const tue = at(2026, 10, 27, 9)
  assert.equal(whenLabel(tue, FRI), `${new Date(tue).toLocaleDateString(undefined, { weekday: 'long' })} ${timeLabel(tue)}`)
  const nov = at(2026, 11, 3, 14)
  assert.equal(
    whenLabel(nov, FRI),
    `${new Date(nov).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${timeLabel(nov)}`,
  )
  const next = at(2027, 1, 5, 9)
  assert.match(whenLabel(next, FRI), /2027/)
})

test('working-day helpers', () => {
  assert.equal(isWorkingDay(FRI), true)
  assert.equal(isWorkingDay(SAT), false)
  assert.equal(addWorkingDays(FRI, 1), at(2026, 10, 26, 10, 30))
  assert.equal(addWorkingDays(FRI, 5), at(2026, 10, 30, 10, 30))
  assert.equal(addWorkingDays(FRI, 0), FRI)
  assert.equal(workingDaysBetween(FRI, at(2026, 10, 26, 10, 30)), 1)
  assert.equal(workingDaysBetween(FRI, at(2026, 10, 25, 23)), 0)
  assert.equal(workingDaysBetween(WED, at(2026, 10, 27, 9)), 4)
  assert.equal(workingDaysBetween(FRI, WED), 0)
})
