/**
 * What Junior says in the sidebar (core/junior/say.ts): one row per state, in
 * priority order, plus the ties that matter (needs you beats stuck).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { juniorSays, waitedFor, type SaySignals } from '../core/junior/say.js'

const NOW = new Date(2026, 10, 13, 9, 2).getTime()
const base: SaySignals = { you: 'Samar', needs: [], stuck: null, working: 0, now: NOW }
const min = (m: number) => NOW - m * 60_000

test('two or more needs: orange count, then the team', () => {
  const s = juniorSays({ ...base, needs: [{ title: 'a', since: min(40) }, { title: 'b' }, { title: 'c' }], working: 4 })
  assert.equal(s.kind, 'needs')
  assert.equal(s.mood, 'needs')
  assert.equal(s.lead, 'Three things need you.')
  assert.equal(s.rest, 'Four more are with the team.')
})

test('two needs and nothing running: says how long the oldest waited', () => {
  const s = juniorSays({ ...base, needs: [{ title: 'a', since: min(40) }, { title: 'b', since: min(5) }] })
  assert.equal(s.lead, 'Two things need you.')
  assert.equal(s.rest, 'The oldest has waited 40 minutes.')
})

test('one question from an agent: names the agent and the thread', () => {
  const s = juniorSays({ ...base, needs: [{ title: 'Review #512', question: true, from: 'Reviewer' }] })
  assert.deepEqual(s, { kind: 'one', mood: 'needs', lead: 'Reviewer has a question', rest: 'on Review #512.' })
  assert.equal(juniorSays({ ...base, needs: [{ title: 'Review #512', question: true }] }).lead, 'A question waits for you')
})

test('one send: names what waits', () => {
  const s = juniorSays({ ...base, needs: [{ title: 'PR #486 waits for your OK' }] })
  assert.equal(s.lead, 'One thing needs you:')
  assert.equal(s.rest, 'PR #486 waits for your OK.')
})

test('needs you outranks stuck', () => {
  assert.equal(juniorSays({ ...base, needs: [{ title: 'x' }], stuck: { title: 'Babysitter stopped on #498' } }).kind, 'one')
})

test('stuck, with and without a title', () => {
  assert.deepEqual(juniorSays({ ...base, stuck: { title: 'Babysitter stopped on #498' } }), { kind: 'stuck', mood: 'stuck', rest: 'Babysitter stopped on #498. Take a look?' })
  assert.equal(juniorSays({ ...base, stuck: {} }).rest, 'Something stopped and needs a look.')
})

test('ready for you: after stuck, before handed off; never orange, never "done"', () => {
  assert.deepEqual(juniorSays({ ...base, ready: [{ title: 'Review #477' }] }), { kind: 'ready', mood: 'done', rest: 'Review #477 is ready for you to look at.' })
  assert.equal(juniorSays({ ...base, ready: [{ title: 'a' }, { title: 'b' }] }).rest, 'Two threads are ready for you to look at.')
  assert.equal(juniorSays({ ...base, ready: [{ title: 'a' }], stuck: {} }).kind, 'stuck')
  assert.equal(juniorSays({ ...base, ready: [{ title: 'a' }], handedOff: { to: 'A', title: 'b' } }).kind, 'ready')
})

test('just handed off: no orange, thinking face', () => {
  const s = juniorSays({ ...base, handedOff: { to: 'Reviewer', title: '#512' }, working: 2 })
  assert.deepEqual(s, { kind: 'handedOff', mood: 'think', rest: 'Got it. Reviewer has #512 now.' })
})

test('working: nothing needs you, counts the team', () => {
  assert.equal(juniorSays({ ...base, working: 1 }).rest, 'Nothing needs you. The team is on one thing.')
  assert.equal(juniorSays({ ...base, working: 3 }).rest, 'Nothing needs you. The team is on three things.')
})

test('greeting on the first open, by time of day', () => {
  assert.equal(juniorSays({ ...base, firstOpenToday: true }).rest, 'Good morning, Samar. Nothing needs you yet.')
  assert.equal(juniorSays({ ...base, you: null, firstOpenToday: true, now: new Date(2026, 10, 13, 18, 0).getTime() }).rest, 'Good evening. Nothing needs you yet.')
})

test('all clear', () => {
  assert.deepEqual(juniorSays(base), { kind: 'clear', mood: 'hello', rest: 'All clear. Nothing needs you.' })
})

test('only needs-you lines carry orange', () => {
  const states: SaySignals[] = [{ ...base, stuck: {} }, { ...base, ready: [{ title: 'x' }] }, { ...base, working: 2 }, { ...base, firstOpenToday: true }, base, { ...base, handedOff: { to: 'A', title: 'b' } }]
  for (const s of states) assert.equal(juniorSays(s).lead, undefined)
})

test('waitedFor', () => {
  assert.equal(waitedFor(NOW - 30_000, NOW), null)
  assert.equal(waitedFor(min(1), NOW), '1 minute')
  assert.equal(waitedFor(min(120), NOW), '2 hours')
  assert.equal(waitedFor(min(60 * 49), NOW), '2 days')
})
