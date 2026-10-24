/**
 * Focus hours (core/work/focus.ts): the filter lets through people waiting
 * past the threshold and prod-red items only; windows read in local time,
 * including ones that run past midnight; the wire shape parses strictly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeFocus,
  endFocus,
  focusFilter,
  focusFrom,
  focusWords,
  getsThrough,
  inFocus,
  inWindow,
  parseClock,
  parseDays,
  readFocus,
  type FocusHours,
  type FocusItem,
} from '../core/work/focus.js'

// Local time on purpose: focus windows are the Mac's clock. Oct 2026: the 19th is a Monday.
const local = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()
const MON = 19
const SAT = 24
const SUN = 25

const weekdayMorning: FocusHours = { windows: [{ days: [1, 2, 3, 4, 5], start: 9 * 60, end: 12 * 60 }], waitMinutes: 60 }

const NOW = local(MON, 10)
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const item = (over: Partial<FocusItem> = {}): FocusItem => ({ source: 'github', peopleWaiting: 0, updatedAt: ago(5), ...over })

test('the filter lets through people waiting past the threshold and prod-red only', () => {
  const rows = {
    personLong: item({ peopleWaiting: 1, updatedAt: ago(90) }),
    personExactly: item({ peopleWaiting: 2, updatedAt: ago(60) }),
    personShort: item({ peopleWaiting: 1, updatedAt: ago(20) }),
    nobodyOld: item({ updatedAt: ago(600) }),
    urgent: item({ source: 'linear', priority: 1 }),
    high: item({ source: 'linear', priority: 2 }),
    pager: item({ source: 'PagerDuty' }),
    incidentIo: item({ source: 'incident.io' }),
    sentryPlain: item({ source: 'sentry' }),
    myTodo: item({ source: 'manual', peopleWaiting: 1, updatedAt: ago(600) }),
    badTime: item({ peopleWaiting: 1, updatedAt: 'not a date' }),
  }
  const list = Object.values(rows)
  const { through, held } = focusFilter(list, { waitMinutes: 60, now: NOW })
  const name = (x: FocusItem) => Object.entries(rows).find(([, v]) => v === x)![0]
  assert.deepEqual(through.map(name), ['personLong', 'personExactly', 'urgent', 'pager', 'incidentIo', 'badTime'])
  assert.deepEqual(held.map(name), ['personShort', 'nobodyOld', 'high', 'sentryPlain', 'myTodo'])
  assert.equal(through.length + held.length, list.length)

  assert.equal(getsThrough(rows.urgent, 60, NOW), 'prod-red')
  assert.equal(getsThrough(rows.personLong, 60, NOW), 'person-waiting')
  assert.equal(getsThrough(rows.personShort, 60, NOW), null)
  // a threshold of 0: anyone waiting gets through
  assert.equal(getsThrough(rows.personShort, 0, NOW), 'person-waiting')
})

test('inFocus: weekday window, edges and weekends', () => {
  assert.deepEqual(inFocus(weekdayMorning, local(MON, 9)), { until: local(MON, 12) })
  assert.deepEqual(inFocus(weekdayMorning, local(MON, 11, 59)), { until: local(MON, 12) })
  assert.equal(inFocus(weekdayMorning, local(MON, 8, 59)), null)
  assert.equal(inFocus(weekdayMorning, local(MON, 12)), null)
  assert.equal(inFocus(weekdayMorning, local(SAT, 10)), null)
  assert.equal(inFocus(null, NOW), null)
  assert.equal(inFocus({ windows: [], waitMinutes: 60 }, NOW), null)
})

test('a window past midnight belongs to the day it starts', () => {
  const lateFri = { days: [5], start: 22 * 60, end: 2 * 60 }
  assert.equal(inWindow(lateFri, local(SAT - 1, 23)), local(SAT, 2))
  assert.equal(inWindow(lateFri, local(SAT, 1, 30)), local(SAT, 2))
  assert.equal(inWindow(lateFri, local(SAT, 2)), null)
  assert.equal(inWindow(lateFri, local(SAT, 23)), null)
  assert.equal(inWindow(lateFri, local(SUN, 1)), null)
})

test('overlapping windows run to the latest end', () => {
  const f: FocusHours = { windows: [{ days: [1], start: 9 * 60, end: 11 * 60 }, { days: [1], start: 10 * 60, end: 13 * 60 }], waitMinutes: 30 }
  assert.deepEqual(inFocus(f, local(MON, 10, 30)), { until: local(MON, 13) })
})

test('End focus skips the rest of this window only', () => {
  const ended = endFocus(weekdayMorning, local(MON, 10))
  assert.equal(ended.endedUntil, local(MON, 12))
  assert.equal(inFocus(ended, local(MON, 11)), null)
  assert.deepEqual(inFocus(ended, local(MON + 1, 9, 30)), { until: local(MON + 1, 12) })
  // out of focus it changes nothing
  assert.equal(endFocus(weekdayMorning, local(SAT, 10)), weekdayMorning)
})

test('clocks and days parse the way people say them', () => {
  assert.equal(parseClock('9'), 540)
  assert.equal(parseClock('09:30'), 570)
  assert.equal(parseClock('9am'), 540)
  assert.equal(parseClock('12pm'), 720)
  assert.equal(parseClock('12am'), 0)
  assert.equal(parseClock('5:15 PM'), 17 * 60 + 15)
  assert.equal(parseClock('24:00'), 0)
  assert.equal(parseClock('25'), null)
  assert.equal(parseClock('9:75'), null)
  assert.equal(parseClock('13pm'), null)
  assert.equal(parseClock('noonish'), null)

  assert.deepEqual(parseDays('weekdays'), [1, 2, 3, 4, 5])
  assert.deepEqual(parseDays(['mon', 'Wednesday', 'fri']), [1, 3, 5])
  assert.deepEqual(parseDays(['tues', 'thurs']), [2, 4])
  assert.deepEqual(parseDays('every day'), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(parseDays(['weekends', 'mon']), [0, 1, 6])
  assert.equal(parseDays('mongoose'), null)
  assert.equal(parseDays('mo'), null)
  assert.equal(parseDays([]), null)
})

test('focusFrom: "focus 9–12 on weekdays", strict on the rest', () => {
  const ok = focusFrom({ windows: [{ days: 'weekdays', start: '9', end: '12' }] })
  assert.deepEqual(ok, { ok: true, value: weekdayMorning })
  assert.equal(describeFocus(ok.ok ? ok.value : null), 'Focus 9:00–12:00 on weekdays. During focus, only people waiting 1h or more and prod-red items reach Needs you.')

  assert.deepEqual(focusFrom({ windows: [] }), { ok: true, value: null })
  assert.equal(focusFrom({}).ok, false)
  assert.equal(focusFrom({ windows: [{ days: 'weekdays', start: '9', end: '9:00' }] }).ok, false)
  assert.equal(focusFrom({ windows: [{ days: 'someday', start: '9', end: '12' }] }).ok, false)
  assert.equal(focusFrom({ windows: [{ days: 'mon', start: '9', end: 'later' }] }).ok, false)
  assert.equal(focusFrom({ windows: [{ days: 'mon', start: '9', end: '12' }], waitMinutes: -5 }).ok, false)
  const custom = focusFrom({ windows: [{ days: ['sat'], start: '22:00', end: '1am' }], waitMinutes: 120 })
  assert.deepEqual(custom, { ok: true, value: { windows: [{ days: [6], start: 1320, end: 60 }], waitMinutes: 120 } })
  assert.equal(describeFocus(custom.ok ? custom.value : null), 'Focus 22:00–1:00 on Sat. During focus, only people waiting 2h or more and prod-red items reach Needs you.')
})

test('readFocus keeps good windows and drops the rest', () => {
  assert.equal(readFocus(null), null)
  assert.equal(readFocus({ windows: 'no' }), null)
  assert.deepEqual(readFocus({ windows: [{ days: [5, 1, 1], start: 540, end: 720 }, { days: [], start: 0, end: 60 }, { days: [1], start: 99999, end: 1 }], waitMinutes: 'x', endedUntil: 5 }), {
    windows: [{ days: [1, 5], start: 540, end: 720 }],
    waitMinutes: 60,
    endedUntil: 5,
  })
})

test('focusWords: the halo line, the foot line and the empty state', () => {
  const until = local(MON, 12)
  const three = focusWords(until, 3)
  assert.equal(three.clock, '12:00')
  assert.equal(three.waiting, '3 waiting')
  assert.equal(three.foot, 'Quiet until 12:00. 3 wait for you then.')
  assert.equal(three.empty, 'Nothing needs you before 12:00.')
  assert.equal(three.ended, 'Focus ended. 3 back on Needs you.')
  assert.equal(focusWords(until, 1).foot, 'Quiet until 12:00. 1 waits for you then.')
  const none = focusWords(local(MON, 9, 30), 0)
  assert.equal(none.clock, '9:30')
  assert.equal(none.waiting, 'nothing waiting')
  assert.equal(none.foot, null)
})
