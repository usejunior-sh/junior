/**
 * The snooze menu's typed field (core/work/snooze.ts readSnooze /
 * snoozeToSave). Local time throughout, against a fixed reference.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSnooze, snoozeToSave } from '../core/work/snooze.js'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
// 2026-10-23 is a Friday.
const FRI = at(2026, 10, 23, 10, 30)

test('blank text reads as empty: no line, nothing to save', () => {
  assert.deepEqual(readSnooze('', FRI), { kind: 'empty' })
  assert.deepEqual(readSnooze('   ', FRI), { kind: 'empty' })
})

test('plain words read as the time Snooze will save, with its label', () => {
  const r = readSnooze('till tue 9am', FRI)
  assert.equal(r.kind, 'time')
  if (r.kind !== 'time') return
  assert.equal(r.at, at(2026, 10, 27, 9))
  assert.match(r.label, /^Tuesday /)

  const w = readSnooze('after 2 working days', FRI)
  assert.equal(w.kind, 'time')
  if (w.kind === 'time') assert.equal(new Date(w.at).getDay(), 2) // Friday + 2 working days = Tuesday
})

test('text with no time in it, or only a past time, reads as unread', () => {
  assert.deepEqual(readSnooze('banana', FRI), { kind: 'unread' })
  assert.deepEqual(readSnooze('yesterday 9am', FRI), { kind: 'unread' })
})

test('snoozeToSave keeps the shown time while it is ahead', () => {
  const shown = readSnooze('tomorrow', FRI)
  assert.equal(snoozeToSave('tomorrow', shown, FRI + 60_000), at(2026, 10, 24, 9))
})

test('snoozeToSave reads again once the shown time has passed, else gives up', () => {
  const shown = readSnooze('in 1 hour', FRI)
  assert.equal(shown.kind, 'time')
  const later = FRI + 2 * 3_600_000
  assert.equal(snoozeToSave('in 1 hour', shown, later), later + 3_600_000)
  assert.equal(snoozeToSave('banana', shown, later), null)
  assert.equal(snoozeToSave('banana', { kind: 'unread' }, FRI), null)
})
