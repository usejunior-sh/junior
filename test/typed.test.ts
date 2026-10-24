import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitTyped } from '../web/src/typed.js'

const line = ['Morning, Sam.', ' What are we working on?']

test('splitTyped: nothing typed keeps the whole line as the hidden rest', () => {
  assert.deepEqual(splitTyped(line, 0), [['', 'Morning, Sam.'], ['', ' What are we working on?']])
})

test('splitTyped: inside the greeting, the question is all rest', () => {
  assert.deepEqual(splitTyped(line, 4), [['Morn', 'ing, Sam.'], ['', ' What are we working on?']])
})

test('splitTyped: at the boundary, the greeting is done and the question not started', () => {
  assert.deepEqual(splitTyped(line, 13), [['Morning, Sam.', ''], ['', ' What are we working on?']])
})

test('splitTyped: inside the question', () => {
  assert.deepEqual(splitTyped(line, 18), [['Morning, Sam.', ''], [' What', ' are we working on?']])
})

test('splitTyped: fully typed (or past the end) leaves no rest', () => {
  const full = [['Morning, Sam.', ''], [' What are we working on?', '']]
  assert.deepEqual(splitTyped(line, 37), full)
  assert.deepEqual(splitTyped(line, 99), full)
})

test('splitTyped: every split joins back to the full line', () => {
  const whole = line.join('')
  for (let n = 0; n <= whole.length; n++) {
    const parts = splitTyped(line, n)
    assert.equal(parts.map(([t, r]) => t + r).join(''), whole)
    assert.equal(parts.map(([t]) => t).join(''), whole.slice(0, n))
  }
})
