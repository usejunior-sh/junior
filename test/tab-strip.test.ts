/**
 * The workspace tab strip's overflow rule (web/src/tabStrip.ts): short first,
 * then the least recently shown fold, never the front tab or one that needs you.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitTabs, monograms, MORE_W, stepTab, TAB_FULL, TAB_MONO, TAB_SHORT, type StripTab } from '../web/src/tabStrip.js'

const tab = (id: string, lastActive: number, count = 0): StripTab => ({ id, lastActive, count })
const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id, i) => tab(id, i))

test('everything fits at full width', () => {
  assert.deepEqual(fitTabs(nine.slice(0, 3), 'a', 3 * TAB_FULL), { shown: ['a', 'b', 'c'], folded: [], short: false })
})

test('short width before folding', () => {
  assert.deepEqual(fitTabs(nine.slice(0, 3), 'a', 3 * TAB_SHORT), { shown: ['a', 'b', 'c'], folded: [], short: true })
})

test('least recently shown fold first, strip order kept', () => {
  const fit = fitTabs(nine, 'a', MORE_W + 4 * TAB_SHORT)
  assert.deepEqual(fit.shown, ['a', 'g', 'h', 'i'])
  assert.deepEqual(fit.folded, ['b', 'c', 'd', 'e', 'f'])
})

test('a tab that needs you never folds, even past the slots', () => {
  const tabs = nine.map((t) => (t.id === 'b' || t.id === 'c' ? { ...t, count: 2 } : t))
  const fit = fitTabs(tabs, 'a', MORE_W + 2 * TAB_SHORT)
  assert.deepEqual(fit.shown, ['a', 'b', 'c'])
  assert.ok(!fit.folded.includes('b'))
})

test('the front tab stays even when it is the oldest', () => {
  const fit = fitTabs(nine, 'a', MORE_W + TAB_SHORT)
  assert.deepEqual(fit.shown, ['a'])
})

test('stepTab wraps both ways', () => {
  assert.equal(stepTab(['a', 'b', 'c'], 'c', 1), 'a')
  assert.equal(stepTab(['a', 'b', 'c'], 'a', -1), 'c')
})

test('names hidden: tiles fit many more before folding, never short', () => {
  assert.deepEqual(fitTabs(nine, 'a', 9 * TAB_MONO, true), { shown: nine.map((t) => t.id), folded: [], short: false })
  const fit = fitTabs(nine, 'a', MORE_W + 4 * TAB_MONO, true)
  assert.equal(fit.shown.length, 4)
  assert.equal(fit.short, false)
})

test('monograms: initials, first letter and next consonant, clashes move on', () => {
  const m = monograms([
    { id: 'lab', name: 'Lab' },
    { id: 'td', name: 'Triage Dev' },
    { id: 'nv', name: 'Novus' },
    { id: 'tdd', name: 'Tidy' },
    { id: 'x', name: 'x' },
    { id: 'e', name: 'Ea' },
  ])
  assert.deepEqual(m, { lab: 'LB', td: 'TD', nv: 'NV', tdd: 'TI', x: 'X', e: 'EA' })
})
