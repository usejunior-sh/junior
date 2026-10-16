/**
 * The power assertion (server/power.ts): one assertion for the daemon,
 * started by the first holder, ended by the last, respawned after it died.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PowerAssertion, type Assertion } from '../server/power.js'

function fake() {
  const children: { killed: boolean; exit: () => void }[] = []
  const spawn = (): Assertion => {
    let onExit = () => {}
    const c = { killed: false, exit: () => onExit() }
    children.push(c)
    return { kill: () => void (c.killed = true), once: (_e, cb) => void (onExit = cb) }
  }
  return { children, spawn }
}

test('held while anyone holds it; released by the last holder', () => {
  const f = fake()
  const p = new PowerAssertion(f.spawn)
  const a = p.hold('job r1')
  const b = p.hold('job r2')
  assert.equal(f.children.length, 1)
  assert.deepEqual(p.reasons, ['job r1', 'job r2'])
  a()
  assert.equal(p.held, true)
  assert.equal(f.children[0].killed, false)
  b()
  assert.equal(p.held, false)
  assert.equal(f.children[0].killed, true)
})

test('releasing twice lets go once', () => {
  const f = fake()
  const p = new PowerAssertion(f.spawn)
  const a = p.hold('job r1')
  const b = p.hold('job r2')
  a()
  a()
  assert.equal(p.held, true, 'the second holder still holds it')
  b()
  assert.equal(p.held, false)
})

test('an assertion that died is respawned by the next hold', () => {
  const f = fake()
  const p = new PowerAssertion(f.spawn)
  p.hold('job r1')
  f.children[0].exit()
  assert.equal(p.held, false)
  p.hold('job r2')
  assert.equal(f.children.length, 2)
  assert.equal(p.held, true)
})

test('no assertion off macOS (spawn gives nothing) — holding still works', () => {
  const p = new PowerAssertion(() => null)
  const r = p.hold('job r1')
  assert.equal(p.held, false)
  assert.deepEqual(p.reasons, ['job r1'])
  r()
  assert.deepEqual(p.reasons, [])
})
