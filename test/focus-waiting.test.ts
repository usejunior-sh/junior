import assert from 'node:assert/strict'
import test from 'node:test'
import { askFocusWaiting, focusWaitingAsks, focusWaitingIn, heldCallPath, nextStep, subscribeFocusWaiting, wantsFocusWaiting } from '../web/src/focusWaiting.js'

test('focus waiting: an ask is for one session, wakes listeners, and lapses', () => {
  let heard = 0
  const off = subscribeFocusWaiting(() => heard++)
  const before = focusWaitingAsks()
  askFocusWaiting('thread1')
  off()
  assert.equal(heard, 1)
  assert.equal(focusWaitingAsks(), before + 1)
  assert.equal(wantsFocusWaiting('thread1'), true)
  assert.equal(wantsFocusWaiting('other'), false)
  // no card rendered yet: the ask stays for the next render
  assert.equal(focusWaitingIn('thread1', { querySelector: () => null }), false)
  assert.equal(wantsFocusWaiting('thread1'), true)
  assert.equal(wantsFocusWaiting('thread1', Date.now() + 60_000), false)
})

test('focus waiting: the first waiting card is scrolled to and flashed, once', () => {
  const calls: string[] = []
  const card = {
    scrollIntoView: (o: { block: string }) => calls.push(`scroll:${o.block}`),
    classList: { add: (c: string) => calls.push(`add:${c}`), remove: (c: string) => calls.push(`remove:${c}`) },
    offsetWidth: 0,
    addEventListener: () => {},
  }
  let asked = ''
  const root = { querySelector: (sel: string) => ((asked = sel), card) }
  askFocusWaiting('thread2')
  assert.equal(focusWaitingIn('thread2', root), true)
  assert.match(asked, /\.astub\.need/)
  assert.match(asked, /\.perm:has\(\.actions\)/)
  assert.deepEqual(calls, ['scroll:center', 'remove:waitFlash', 'add:waitFlash'])
  assert.equal(wantsFocusWaiting('thread2'), false)
  assert.equal(focusWaitingIn('thread2', root), false)
})

const use = (id: string, parent: string | null) => ({ kind: 'sdk', message: { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } } })

test('held call path: main, a subagent, a subagent of a subagent, not loaded yet', () => {
  const events = [use('agentA', null), use('agentB', 'agentA'), use('bashMain', null), use('bashA', 'agentA'), use('bashB', 'agentB'), { kind: 'user', text: 'hi' }]
  assert.deepEqual(heldCallPath(events, ['bashMain']), [])
  assert.deepEqual(heldCallPath(events, ['bashA']), ['agentA'])
  assert.deepEqual(heldCallPath(events, ['older', 'bashB']), ['agentA', 'agentB'])
  assert.equal(heldCallPath(events, ['older']), null)
})

test('next step: look here, open the next subagent down, or not this view', () => {
  assert.deepEqual(nextStep([], null), { look: true })
  assert.deepEqual(nextStep(['agentA'], null), { open: 'agentA' })
  assert.deepEqual(nextStep(['agentA'], 'agentA'), { look: true })
  assert.deepEqual(nextStep(['agentA', 'agentB'], 'agentA'), { open: 'agentB' })
  assert.equal(nextStep(['agentA'], 'other'), null)
  assert.equal(nextStep([], 'agentA'), null)
})
