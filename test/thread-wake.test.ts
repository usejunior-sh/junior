/**
 * Thread reports wake the DM that started them (core/junior/thread-wake.ts):
 * whether a report wakes, how reports fold into one wake, and the loop guard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowAnswer,
  blockedText,
  closeReportTurn,
  coalesce,
  decideWake,
  isQuietReply,
  MAX_WAKES_PER_HOUR,
  newGuard,
  noteAnswer,
  noteUserInThread,
  openReportTurn,
  QUIET_REPLY,
  reportsUp,
  type ThreadReport,
  wakeFrom,
  wakeMessage,
} from '../core/junior/thread-wake.js'

const NOW = 1_800_000_000_000
const r = (threadId: string, more: Partial<ThreadReport> = {}): ThreadReport => ({ threadId, title: `T ${threadId}`, who: 'Reviewer', state: 'done', text: 'Done.', at: NOW, ...more })

test('decide: only a DM wakes', () => {
  assert.deepEqual(decideWake('chat', r('a'), newGuard(), NOW), { wake: false, why: 'not started from a DM' })
  assert.deepEqual(decideWake(undefined, r('a'), newGuard(), NOW).wake, false)
  assert.deepEqual(decideWake('dm', r('a'), newGuard(), NOW), { wake: true, answer: true })
})

test('decide: blocked wakes but is never answerable', () => {
  assert.deepEqual(decideWake('dm', r('a', { state: 'blocked' }), newGuard(), NOW), { wake: true, answer: false })
})

test('decide: a reply to the parent\'s own answer wakes without an answer', () => {
  const g = newGuard()
  g.autoPending.add('a')
  assert.deepEqual(decideWake('dm', r('a'), g, NOW), { wake: true, answer: false })
  assert.deepEqual(decideWake('dm', r('b'), g, NOW), { wake: true, answer: true })
})

test('decide: the hourly cap skips, and old wakes fall off', () => {
  const g = newGuard()
  g.wakes = Array.from({ length: MAX_WAKES_PER_HOUR }, () => NOW - 60_000)
  assert.equal(decideWake('dm', r('a'), g, NOW).wake, false)
  g.wakes = Array.from({ length: MAX_WAKES_PER_HOUR }, () => NOW - 3_600_001)
  assert.equal(decideWake('dm', r('a'), g, NOW).wake, true)
})

test('coalesce: one per thread, latest wins, oldest first', () => {
  const out = coalesce([r('b', { at: NOW + 1 }), r('a', { state: 'blocked', at: NOW }), r('a', { state: 'done', at: NOW + 2 })])
  assert.deepEqual(
    out.map((x) => [x.threadId, x.state]),
    [
      ['b', 'done'],
      ['a', 'done'],
    ],
  )
})

test('loop guard: one auto-answer per report, none for the reply to it', () => {
  const g = newGuard()
  // A report wakes the DM; it may answer thread a once.
  openReportTurn(g, [r('a')], new Set(['a']), NOW)
  const first = allowAnswer(g, 'a')
  assert.deepEqual(first, { ok: true, auto: true })
  noteAnswer(g, 'a')
  assert.equal(allowAnswer(g, 'a').ok, false)
  // A thread the report didn't name is an ordinary message.
  assert.deepEqual(allowAnswer(g, 'other'), { ok: true, auto: false })
  closeReportTurn(g)
  // Thread a replies to that answer: it wakes, but it can't be answered.
  const d = decideWake('dm', r('a', { at: NOW + 10 }), g, NOW + 10)
  assert.deepEqual(d, { wake: true, answer: false })
  openReportTurn(g, [r('a')], new Set(), NOW + 10)
  assert.equal(allowAnswer(g, 'a').ok, false)
  closeReportTurn(g)
  // Its next report is answerable again: the mark was spent on that wake.
  assert.deepEqual(decideWake('dm', r('a'), g, NOW + 20), { wake: true, answer: true })
  // Outside a report turn, the DM may message any thread (the user asked it to).
  assert.deepEqual(allowAnswer(g, 'a'), { ok: true, auto: false })
})

test('loop guard: the user writing in the thread clears the mark', () => {
  const g = newGuard()
  g.autoPending.add('a')
  noteUserInThread(g, 'a')
  assert.deepEqual(decideWake('dm', r('a'), g, NOW), { wake: true, answer: true })
})

test('wake message: who, state, words, the quiet rule, and who may be answered', () => {
  const text = wakeMessage([r('a', { title: 'Review #512', text: 'Two bugs found. Want me to fix them?' }), r('b', { title: 'Get #498 green', who: 'Babysitter', state: 'blocked', text: 'a question for the user: Push now?' })], new Set(['a']))
  assert.match(text, /^\[Report from 2 threads you started\. It is not the user/)
  assert.match(text, /Thread "Review #512" \(Reviewer\): done/)
  assert.match(text, /Two bugs found\. Want me to fix them\?/)
  assert.match(text, /Thread "Get #498 green" \(Babysitter\): blocked on a question for the user: Push now\?/)
  assert.ok(text.includes(`reply exactly ${QUIET_REPLY} and nothing else`))
  const [, a, b] = text.split('\n\n')
  assert.match(a, /You may answer this thread yourself, once\./)
  assert.match(b, /Do not message this thread/)
  assert.equal(wakeFrom([r('a', { title: 'Review #512' })]), 'Reviewer · Review #512')
  assert.equal(wakeFrom([r('a'), r('b')]), '2 threads')
})

test('quiet reply: trimmed, any case', () => {
  assert.ok(isQuietReply('  (quiet)\n'))
  assert.ok(isQuietReply('(QUIET)'))
  assert.ok(!isQuietReply('(quiet) but also this'))
})

test('blocked text: a question with its options, or the prompt', () => {
  assert.equal(blockedText('AskUserQuestion', { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }), 'a question for the user: Which branch? (options: main / dev)')
  assert.equal(blockedText('Bash', {}, 'Run git push', undefined), 'a permission prompt for Bash: Run git push')
  assert.equal(blockedText('Edit', {}), 'a permission prompt for Edit')
})

test('reports up: only a turn the DM sent, not one the user typed in the thread', () => {
  assert.ok(reportsUp('dm-1', 'dm-1'), 'start_session / message_session from the DM')
  assert.ok(!reportsUp('dm-1', undefined), 'the user typing in the thread')
  assert.ok(!reportsUp('dm-1', 'other-chat'), 'another chat messaging the thread')
  assert.ok(!reportsUp(undefined, undefined), 'not a thread')
  // The last message in wins: user, then the DM again, reports; DM, then the user, does not.
  const turn = (froms: (string | undefined)[]) => froms.reduce<boolean>((_, f) => reportsUp('dm-1', f), false)
  assert.ok(turn([undefined, 'dm-1']))
  assert.ok(!turn(['dm-1', undefined]))
})
