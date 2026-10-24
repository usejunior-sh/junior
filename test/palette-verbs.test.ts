// The ⌘K palette's verbs and list (web/src/itemVerbs.ts) and the item in
// focus (web/src/selection.ts): pure, so they load without the client stores.
import test from 'node:test'
import assert from 'node:assert/strict'
import { filterCommands, handedOffLine, handOffOf, heldSends, moreLine, pauseOf, sectionsOf, sendsHint, verbErrorLine, verbsOf, type ItemVerb } from '../web/src/itemVerbs.js'
import { focusedItemId } from '../web/src/selection.js'

type I = Parameters<typeof verbsOf>[0]
const item = (over: Partial<I> = {}): I => ({ source: 'github', reason: 'mentioned', label: undefined, ...over }) as I
const ids = (vs: ItemVerb[]) => vs.map((v) => v.id)

test('an item not with Junior: hand off first, then snooze, open, done', () => {
  assert.deepEqual(ids(verbsOf(item())), ['handoff', 'snooze', 'open', 'done'])
})

test('each verb carries its Junior page key, except Approve send', () => {
  const vs = verbsOf(item({ suggestion: { playbook: 'babysit' } as I['suggestion'] }), 2)
  assert.deepEqual(
    vs.map((v) => [v.id, v.key]),
    [
      ['handoff', 'h'],
      ['snooze', 's'],
      ['not-now', 'x'],
      ['approve', undefined],
      ['open', 'o'],
      ['done', 'd'],
    ],
  )
  assert.equal(vs.find((v) => v.id === 'approve')?.hint, '2 sends wait')
})

test('the hand-off word and playbook follow the row (primaryOf)', () => {
  assert.deepEqual(handOffOf(item({ reason: 'your-pr' })), { word: 'Babysit' })
  assert.deepEqual(handOffOf(item({ reason: 'review-requested' })), { word: 'First pass' })
  assert.deepEqual(handOffOf(item({ suggestion: { playbook: 'review' } as I['suggestion'] })), { word: 'First pass' })
  assert.deepEqual(handOffOf(item({ suggestion: { playbook: 'answer' } as I['suggestion'] })), { playbook: 'answer', word: 'Hand off' })
  assert.deepEqual(handOffOf(item({ label: 'bug' })), { playbook: 'debug-fix', word: 'Hand off' })
  // the plain word shows no hint
  assert.equal(verbsOf(item({ label: 'bug' }))[0]!.hint, undefined)
  assert.equal(verbsOf(item({ reason: 'your-pr' }))[0]!.hint, 'Babysit')
})

test('with Junior: no hand-off; pause while working, resume once paused', () => {
  const working = item({ handoff: 'on', junior: { stage: 'working' } as I['junior'] })
  assert.equal(handOffOf(working), null)
  assert.deepEqual(ids(verbsOf(working)), ['snooze', 'pause', 'open', 'done'])
  const paused = item({ handoff: 'paused', junior: { stage: 'paused' } as I['junior'] })
  assert.equal(pauseOf(paused), 'resume')
  assert.deepEqual(ids(verbsOf(paused)), ['snooze', 'resume', 'open', 'done'])
  // handed off, nothing under way yet: neither
  assert.equal(pauseOf(item({ handoff: 'on' })), null)
  assert.equal(handOffOf(item({ handoff: 'on' })), null)
  // Junior has a stage on it without a hand-off: no hand-off verb
  assert.equal(handOffOf(item({ junior: { stage: 'watching' } as I['junior'] })), null)
})

test('Approve send shows only with sends held, below the hand-off', () => {
  assert.ok(!ids(verbsOf(item(), 0)).includes('approve'))
  const vs = ids(verbsOf(item(), 1))
  assert.ok(vs.indexOf('approve') > vs.indexOf('handoff'))
  assert.equal(sendsHint(1), '1 send waits')
  assert.equal(sendsHint(3), '3 sends wait')
})

test('held sends: the count and the oldest one’s chat', () => {
  assert.deepEqual(heldSends([]), { count: 0, sessionId: null })
  assert.deepEqual(
    heldSends([
      { status: 'needs_you', sessionId: 'new', attemptedAt: 30 },
      { status: 'succeeded', sessionId: 'done', attemptedAt: 5 },
      { status: 'needs_you', sessionId: 'old', attemptedAt: 10 },
    ]),
    { count: 2, sessionId: 'old' },
  )
})

test('status lines', () => {
  assert.equal(handedOffLine('Fix flaky auth test'), 'Handed off: Fix flaky auth test.')
  assert.equal(handedOffLine('Ship it.'), 'Handed off: Ship it.')
  assert.equal(handedOffLine('x', { state: 'watch-off', watch: 'babysit' }), 'Handed off. Babysitting is off, so nothing runs yet.')
  assert.equal(handedOffLine('x', { state: 'watch-off', watch: 'review' }), 'Handed off. Reviews are off, so nothing runs yet.')
  assert.equal(verbErrorLine('no such item'), 'No such item.')
  assert.equal(verbErrorLine(''), 'That didn’t go through.')
  assert.equal(verbErrorLine(null), 'That didn’t go through.')
})

test('the list: substring over label + hint, section order kept, 50 per section', () => {
  const order = ['This item', 'Actions', 'Work items'] as const
  type S = (typeof order)[number]
  const cmds: { id: string; section: S; label: string; hint?: string }[] = [
    { id: 'w1', section: 'Work items', label: 'Bump node', hint: 'acme/web' },
    { id: 'a1', section: 'Actions', label: 'New chat', hint: 'n' },
    { id: 'v1', section: 'This item', label: 'Hand off to Junior' },
  ]
  assert.deepEqual(filterCommands(cmds, '', order).map((c) => c.id), ['v1', 'a1', 'w1'])
  assert.deepEqual(filterCommands(cmds, 'ACME', order).map((c) => c.id), ['w1'])
  const many = Array.from({ length: 88 }, (_, n) => ({ id: `w${n}`, section: 'Work items' as S, label: `t${n}` }))
  const groups = sectionsOf(filterCommands([...cmds, ...many], '', order))
  assert.deepEqual(groups.map((g) => g.section), ['This item', 'Actions', 'Work items'])
  const work = groups[2]!
  assert.equal(work.rows.length, 50)
  assert.equal(work.more, 39)
  assert.equal(moreLine(work.more), '39 more. Type to narrow.')
})

test('the item in focus: item page, then the open chat’s item, then the cursor', () => {
  const sessions = [{ id: 's1', itemId: 'gh:acme/api#1' }, { id: 's2' }]
  assert.equal(focusedItemId({ page: 'item', id: 'gh:x#2' }, sessions, 'cur'), 'gh:x#2')
  assert.equal(focusedItemId({ page: 'session', id: 's1' }, sessions, 'cur'), 'gh:acme/api#1')
  assert.equal(focusedItemId({ page: 'session', id: 's2' }, sessions, 'cur'), null)
  assert.equal(focusedItemId({ page: 'junior' }, sessions, 'cur'), 'cur')
  assert.equal(focusedItemId({ page: 'inbox' }, sessions, null), null)
})
