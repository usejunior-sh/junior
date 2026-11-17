import assert from 'node:assert/strict'
import test from 'node:test'
import { askFocusWaiting, focusWaitingAsks, focusWaitingIn, subscribeFocusWaiting, wantsFocusWaiting } from '../web/src/focusWaiting.js'

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
  assert.equal(focusWaitingIn('thread1', { querySelector: () => null } as unknown as Element), false)
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
  const root = { querySelector: (sel: string) => ((asked = sel), card) } as unknown as Element
  askFocusWaiting('thread2')
  assert.equal(focusWaitingIn('thread2', root), true)
  assert.match(asked, /\.astub\.need/)
  assert.match(asked, /\.perm:has\(\.actions\)/)
  assert.deepEqual(calls, ['scroll:center', 'remove:waitFlash', 'add:waitFlash'])
  assert.equal(wantsFocusWaiting('thread2'), false)
  assert.equal(focusWaitingIn('thread2', root), false)
})
