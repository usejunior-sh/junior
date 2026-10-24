/**
 * Your own promises in text (core/work/promises.ts). Local time throughout,
 * against a fixed Friday 10:30 reference; the clock is never read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPromise, detectPromises } from '../core/work/promises.js'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
// 2026-10-23 is a Friday.
const FRI = at(2026, 10, 23, 10, 30)

test('promises the user made are found, with the quote', () => {
  const cases: string[] = [
    "I'll look tomorrow",
    'Will fix in a follow-up.',
    'Good catch, will fix in a follow-up',
    "I'll take a look at this after lunch",
    'I will review it by EOD',
    "I'm going to rebase this onto main tonight",
    "Thanks! I'll get back to you on Monday",
    'On it!',
    '@dev on it',
    "I'll send the doc over this afternoon",
    "We'll ship the fix in the next release",
    "I'll check if the build passes and let you know",
    'Will do.',
    "Let me look into it tomorrow morning",
    "I owe Dev a review",
    "Sure, I'll also go ahead and update the README",
    'I’ll circle back after standup', // curly apostrophe
    "Added it to my list.",
    "I'll dig into the flaky test next week",
    "I'm gonna fix the CI step today",
    'Leave it with me.',
  ]
  for (const text of cases) {
    const hit = detectPromise(text, true, FRI)
    assert.ok(hit, `expected a promise in: ${text}`)
    assert.ok(text.includes(hit.quote), `quote for: ${text}`)
  }
})

test('text that is not a promise is left alone', () => {
  const cases: string[] = [
    "Will you look tomorrow?",
    "Can you take a look at this?",
    'Should I fix it in a follow-up',
    'Want me to review this one?',
    "Maybe I'll look tomorrow",
    "I'll probably fix it next week",
    "I'll fix it if CI is red again",
    "I'll try to look today",
    "I won't get to it today",
    "I don't think I'll get to it this week",
    "I fixed it yesterday",
    "Dev will look at it tomorrow",
    "I'll be out tomorrow",
    "Let me know when it's ready",
    "Let me check",
    "LGTM, thanks!",
    "I have too much on my plate",
    "I owe you one",
    '> I\'ll look tomorrow\nthis was the plan last week',
    'Run `I will fix` to see the bug',
    'He said "I\'ll fix it tomorrow" and then left',
    "It will fix itself once the cache clears",
    "I'd look at the logs first",
    "Not sure I'll have time to review today",
    '```\n// I\'ll fix this later\n```',
  ]
  for (const text of cases) {
    assert.equal(detectPromise(text, true, FRI), null, `expected no promise in: ${text}`)
  }
})

test('the quote is the promise sentence, exactly as written', () => {
  assert.equal(detectPromise("Thanks! I'll get back to you on Monday", true, FRI)?.quote, "I'll get back to you on Monday")
  assert.equal(detectPromise('I’ll circle back after standup', true, FRI)?.quote, 'I’ll circle back after standup')
  assert.equal(detectPromise("I'll fix `parseWhen` tomorrow", true, FRI)?.quote, "I'll fix `parseWhen` tomorrow")
})

test('only text the user wrote is read', () => {
  assert.equal(detectPromise("I'll look tomorrow", false, FRI), null)
  assert.equal(detectPromise('Will fix in a follow-up', false, FRI), null)
  assert.deepEqual(detectPromises("I'll look tomorrow. I'll fix it today.", false, FRI), [])
  assert.ok(detectPromise("I'll look tomorrow", true, FRI))
})

test('the due time comes from the promise sentence', () => {
  const due = (text: string) => detectPromise(text, true, FRI)?.due?.at
  assert.equal(due("I'll look tomorrow"), at(2026, 10, 24, 9))
  assert.equal(due('I will review it by EOD'), at(2026, 10, 23, 17))
  assert.equal(due("Thanks! I'll get back to you on Monday"), at(2026, 10, 26, 9))
  assert.equal(due("I'll send the doc over this afternoon"), at(2026, 10, 23, 14))
  assert.equal(due("I'm gonna fix the CI step today"), at(2026, 10, 23, 17))
  assert.equal(due("I'll finish it and send it this week"), at(2026, 10, 23, 17))
  assert.equal(due("I'll fix it after 2 working days"), at(2026, 10, 27, 9))
  assert.equal(due('Will fix in a follow-up'), undefined)
  // A ref number is not a time.
  assert.equal(due("I'll review #3 tomorrow"), at(2026, 10, 24, 9))
})

test('who the promise is owed to', () => {
  const owed = (text: string, replyTo?: string) => detectPromise(text, true, FRI, { replyTo })?.owedTo
  assert.equal(owed('I owe Dev a review'), 'Dev')
  assert.equal(owed("I'll get back to Priya tomorrow"), 'Priya')
  assert.equal(owed("I'll let Sam know once it's merged"), 'Sam')
  assert.equal(owed("@maria I'll look tomorrow"), 'maria')
  assert.equal(owed("<@U024BE7LH|dev> on it"), 'dev')
  assert.equal(owed("Dev, I'll take this one"), 'Dev')
  assert.equal(owed("Thanks Dev, I'll fix it on Monday"), 'Dev')
  assert.equal(owed("I'll get back to you on Monday", 'alex'), 'alex')
  assert.equal(owed("I'll get back to you on Monday"), undefined)
  assert.equal(owed('Will fix in a follow-up', 'octocat'), 'octocat')
  // Days and acknowledgements are not people.
  assert.equal(owed("Sure, I'll send it to Monday's sync"), undefined)
})

test('every promise in a longer message, in order', () => {
  const text = "Thanks for the review.\nI'll fix the nits today. The flaky test I'll dig into next week.\nAnything else?"
  const hits = detectPromises(text, true, FRI)
  assert.deepEqual(hits.map((h) => h.quote), ["I'll fix the nits today.", "The flaky test I'll dig into next week."])
})

test('bad input is not a promise', () => {
  assert.equal(detectPromise('', true, FRI), null)
  assert.equal(detectPromise('   \n  ', true, FRI), null)
  assert.equal(detectPromise("I'll look tomorrow", true, Number.NaN), null)
  assert.equal(detectPromise(undefined as unknown as string, true, FRI), null)
})
