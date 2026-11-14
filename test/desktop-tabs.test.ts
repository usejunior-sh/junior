/**
 * Junior.app's workspace tabs as data (desktop/src/tabs-model.ts): one tab
 * per workspace across windows, last tab closes the window, background tabs
 * sleep. Fake clock throughout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TabsModel } from '../desktop/src/tabs-model.js'

const MIN = 60_000

function two() {
  const m = new TabsModel()
  m.addWindow(1, ['lab', 'pendo'], 'lab', 0)
  m.addWindow(2, ['rb'], 'rb', 0)
  return m
}

test('opening a new workspace adds it after the front tab and brings it forward', () => {
  const m = two()
  assert.deepEqual(m.open(1, 'acme', 1), { winId: 1, added: true })
  assert.deepEqual(m.stateFor(1, {}).tabs.map((t) => t.id), ['lab', 'acme', 'pendo'])
  assert.equal(m.stateFor(1, {}).active, 'acme')
})

test('a workspace opens in one tab only: opening it again goes to the window that has it', () => {
  const m = two()
  assert.deepEqual(m.open(1, 'rb', 1), { winId: 2, added: false })
  assert.equal(m.stateFor(1, {}).tabs.length, 2)
})

test('a new window never takes a workspace another window has', () => {
  const m = two()
  m.addWindow(3, ['rb', 'acme'], 'rb', 0)
  assert.deepEqual(m.stateFor(3, {}).tabs.map((t) => t.id), ['acme'])
  assert.equal(m.stateFor(3, {}).active, 'acme')
})

test('closing the front tab hands over to its neighbour; the last tab closes the window', () => {
  const m = two()
  m.open(1, 'acme', 1) // lab, acme, pendo
  assert.deepEqual(m.close(1, 'acme', 2), { closeWindow: false })
  assert.equal(m.stateFor(1, {}).active, 'pendo')
  m.close(1, 'pendo', 3)
  assert.equal(m.stateFor(1, {}).active, 'lab')
  assert.deepEqual(m.close(1, 'lab', 4), { closeWindow: true })
})

test('moving a tab out of a window and back', () => {
  const m = two()
  assert.deepEqual(m.move('pendo', 2, 1), { from: 1, emptied: false })
  assert.deepEqual(m.stateFor(2, {}).tabs.map((t) => t.id), ['rb', 'pendo'])
  assert.equal(m.stateFor(2, {}).active, 'pendo')
  assert.deepEqual(m.move('rb', 1, 2), { from: 2, emptied: false })
  assert.deepEqual(m.move('pendo', 1, 3), { from: 2, emptied: true })
  assert.equal(m.move('pendo', 1, 4), null, 'already there')
})

test('elsewhere lists the other windows, counts pass through', () => {
  const s = two().stateFor(1, { rb: 2 })
  assert.deepEqual(s.elsewhere, [{ id: 'rb', windowId: 2 }])
  assert.deepEqual(s.counts, { rb: 2 })
})

test('background tabs sleep after their time out of sight, the front one never', () => {
  const m = two()
  m.activate(1, 'pendo', 10 * MIN) // lab leaves the front at 10 min
  assert.deepEqual(m.sleepers(39 * MIN, 30 * MIN), [])
  assert.deepEqual(m.sleepers(40 * MIN, 30 * MIN), [{ winId: 1, id: 'lab' }])
  m.windows.get(1)!.tabs[0].asleep = true
  assert.deepEqual(m.sleepers(50 * MIN, 30 * MIN), [])
  m.activate(1, 'lab', 51 * MIN)
  assert.equal(m.windows.get(1)!.tabs[0].asleep, false, 'showing it wakes it')
})

test('step wraps, nth counts every tab and 9 is the last', () => {
  const m = two()
  m.open(1, 'acme', 1) // lab, acme, pendo, front acme
  assert.equal(m.step(1, 1), 'pendo')
  m.activate(1, 'pendo', 2)
  assert.equal(m.step(1, 1), 'lab')
  assert.equal(m.step(1, -1), 'acme')
  assert.equal(m.nth(1, 2), 'acme')
  assert.equal(m.nth(1, 9), 'pendo')
  assert.equal(m.nth(1, 5), null)
})

test('switching swaps a workspace into the tab in its place, unless it is open already', () => {
  const m = two()
  m.activate(1, 'pendo', 1)
  assert.equal(m.swap(1, 'pendo', 'acme', 2), true)
  assert.deepEqual(m.stateFor(1, {}).tabs.map((t) => t.id), ['lab', 'acme'])
  assert.equal(m.stateFor(1, {}).active, 'acme')
  assert.equal(m.swap(1, 'acme', 'rb', 3), false)
  assert.equal(m.swap(1, 'acme', 'lab', 3), false)
  assert.deepEqual(m.stateFor(1, {}).tabs.map((t) => t.id), ['lab', 'acme'])
})

test('a tab whose workspace changed under it is renamed, unless that one is open already', () => {
  const m = two()
  assert.equal(m.rename(1, 'pendo', 'acme'), 'renamed')
  assert.equal(m.rename(1, 'acme', 'rb'), 'duplicate')
})

test('save keeps order and front tab, drops empty windows', () => {
  const m = two()
  m.addWindow(3, [], '', 0)
  assert.deepEqual(m.save([2, 1, 3]), [
    { tabs: ['rb'], active: 'rb' },
    { tabs: ['lab', 'pendo'], active: 'lab' },
  ])
})
