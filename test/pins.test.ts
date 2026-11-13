import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activePins, addPin, parsePins, PINS_MAX, pinsAppend, removePin, serializePins, type Pin } from '../core/junior/pins.js'

const at = (d: number, h = 10) => new Date(2026, 10, d, h).getTime()

test('a pin is today by default and lasts the local day', () => {
  const { pins, pin, existed } = addPin([], { text: '  Dev is failing.\nThe tenant migration did not run. ' }, at(13, 9))
  assert.equal(existed, false)
  assert.equal(pin.scope, 'today')
  assert.equal(pin.text, 'Dev is failing. The tenant migration did not run.')
  assert.equal(activePins(pins, at(13, 23)).length, 1)
  assert.equal(activePins(pins, at(14, 1)).length, 0)
})

test('an always pin outlives the day, oldest first', () => {
  let pins: Pin[] = []
  pins = addPin(pins, { text: 'Onboarding belongs to another team', scope: 'always' }, at(10)).pins
  pins = addPin(pins, { text: 'Dev is failing' }, at(13)).pins
  assert.deepEqual(activePins(pins, at(13, 12)).map((p) => p.text), ['Onboarding belongs to another team', 'Dev is failing'])
  assert.deepEqual(activePins(pins, at(20)).map((p) => p.text), ['Onboarding belongs to another team'])
})

test('the same words twice keep one pin, and always wins', () => {
  const a = addPin([], { text: 'Dev is failing' }, at(13, 9))
  const b = addPin(a.pins, { text: 'dev is  failing.', scope: 'always' }, at(13, 10))
  assert.equal(b.existed, true)
  assert.equal(b.pins.length, 1)
  assert.equal(b.pin.id, a.pin.id)
  assert.equal(b.pin.scope, 'always')
})

test('adding sweeps expired pins and holds the list to the cap', () => {
  let pins = addPin([], { text: 'yesterday' }, at(12)).pins
  pins = addPin(pins, { text: 'today' }, at(13)).pins
  assert.deepEqual(pins.map((p) => p.text), ['today'])
  for (let i = 0; i < PINS_MAX + 5; i++) pins = addPin(pins, { text: `rule ${i}`, scope: 'always' }, at(13) + i).pins
  assert.equal(pins.length, PINS_MAX)
  assert.ok(!pins.some((p) => p.text === 'today'), 'a today pin goes before an always one')
})

test('bad text is refused', () => {
  assert.throws(() => addPin([], { text: '   ' }, at(13)), /needs text/)
  assert.throws(() => addPin([], { text: 'x'.repeat(301) }, at(13)), /at most 300/)
})

test('removePin takes one off, and says when there is none', () => {
  const { pins, pin } = addPin([], { text: 'Dev is failing' }, at(13))
  assert.deepEqual(removePin(pins, pin.id).pins, [])
  assert.throws(() => removePin(pins, 'p-nope-0'), /no pin/)
})

test('the file round-trips, and a bad row is dropped with a reason', () => {
  const { pins } = addPin([], { text: 'Dev is failing' }, at(13))
  assert.deepEqual(parsePins(serializePins(pins)), { pins, errors: [] })
  const bad = JSON.stringify({ pins: [...pins, { ...pins[0], id: 'p-x-1', colour: 'red' }, { id: 'p-x-2', text: 'y', scope: 'soon', createdAt: 1 }, { ...pins[0] }] })
  const r = parsePins(bad)
  assert.equal(r.pins.length, 1)
  assert.deepEqual(r.errors.map((e) => e.replace(/^pin \d+: /, '')), ['unknown key "colour"', 'scope: today or always', `id "${pins[0].id}" is used twice`])
  assert.deepEqual(parsePins('{').errors, ['pins.json is not valid JSON'])
  assert.deepEqual(parsePins('{"x":1}').errors, ['pins.json holds no list of pins'])
})

test('the prompt block lists each pin with its scope and id, and nothing adds nothing', () => {
  assert.equal(pinsAppend([]), '')
  const { pins } = addPin([], { text: 'Dev is failing' }, at(13))
  const block = pinsAppend(pins)
  assert.match(block, /## Pinned notes/)
  assert.match(block, new RegExp(`- Dev is failing \\(today; ${pins[0].id}\\)`))
})
