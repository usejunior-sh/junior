/**
 * The cited brief on an open Needs you card (core/junior/brief.ts
 * briefLines): one row per rule, the drop rule (no link, no line), the
 * Ready dedupe, Junior's words skipped, word caps and order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { briefLines, itemPageHref, type BriefItem } from '../core/junior/brief.js'

const NOW = new Date(2026, 9, 24, 12, 0).getTime()
const PR_URL = 'https://github.com/acme/api/pull/412'

function item(over: Partial<BriefItem> = {}): BriefItem {
  return {
    id: 'github:acme/api#412',
    source: 'github',
    reason: 'review-requested',
    author: 'priya',
    url: PR_URL,
    repo: 'acme/api',
    peopleWaiting: 1,
    updatedAt: '2026-10-24T10:00:00Z',
    ...over,
  }
}

const slackLink = (author: string, url = 'https://acme.slack.com/archives/C1/p1') => ({ id: `slack:${author}`, title: 'q', source: 'slack', url, repo: '#api', author })
const texts = (i: BriefItem, me: string | null = 'samar') => briefLines(i, me, NOW).map((l) => `${l.id}: ${l.text}`)

test('every line has at least one cite, and lines come in order', () => {
  const i = item({ returned: true, ciFailing: true, linked: [slackLink('dev')], peopleWaiting: 4 })
  const lines = briefLines(i, 'samar', NOW)
  assert.deepEqual(lines.map((l) => l.id), ['waiting', 'last', 'now'])
  for (const l of lines) assert.ok(l.cites.length >= 1 && l.cites.length <= 2, l.id)
  for (const l of lines) for (const c of l.cites) assert.ok(c.href.startsWith('https://') || c.href.startsWith('#/item/'), c.href)
})

test('Waiting: a review request, with a Slack asker and a count', () => {
  const [w] = briefLines(item({ linked: [slackLink('@dev')], peopleWaiting: 4 }), 'samar', NOW)
  assert.equal(w!.text, 'priya asked for your review. dev asked in Slack too. 2 more wait too.')
  assert.deepEqual(w!.cites.map((c) => [c.label, c.aria]), [['#412', 'Open #412 on GitHub'], ['Slack', 'Open the Slack thread']])
  assert.equal(texts(item({ peopleWaiting: 2 }))[0], 'waiting: priya asked for your review. 1 more waits too.')
})

test('Waiting: one rule per reason', () => {
  const slack = item({ id: 'slack:C1:1', source: 'slack', repo: 'api', reason: 'asked', author: '@lee', url: 'https://acme.slack.com/archives/C1/p1' })
  assert.deepEqual(texts(slack), ['waiting: lee asked you in #api.'])
  assert.equal(briefLines(slack, null, NOW)[0]!.cites[0]!.label, 'Slack')
  assert.deepEqual(texts(item({ reason: 'asked' })), ['waiting: priya is waiting on you.'])
  assert.deepEqual(texts(item({ reason: 'mentioned' })), ['waiting: priya mentioned you here.'])
  const lin = item({ id: 'linear:NOV-1', source: 'linear', reason: 'assigned', url: 'https://linear.app/acme/issue/NOV-1' })
  const [l] = briefLines(lin, 'samar', NOW)
  assert.equal(l!.text, "priya opened it. It's assigned to you.")
  assert.deepEqual([l!.cites[0]!.label, l!.cites[0]!.aria], ['Linear', 'Open in Linear'])
})

test('Waiting: a linked Slack asker stands in when nobody is named', () => {
  assert.deepEqual(texts(item({ reason: 'mentioned', author: '', linked: [slackLink('dev')] })), ['waiting: dev asked about this in Slack.'])
})

test('Waiting: omitted on your PR, a job find, your to-do, and your own ask', () => {
  for (const reason of ['your-pr', 'found', 'you-added'] as const) assert.deepEqual(texts(item({ reason, linked: [slackLink('dev')] })), [], reason)
  assert.deepEqual(texts(item({ author: 'samar' }), 'samar'), [])
  assert.deepEqual(texts(item({ author: '@Samar' }), 'samar'), [])
})

test('the drop rule: no https link, no line', () => {
  assert.deepEqual(texts(item({ url: '' })), [])
  assert.deepEqual(texts(item({ url: 'http://github.com/acme/api/pull/412' })), [])
  assert.deepEqual(texts(item({ url: 'javascript:alert(1)', returned: true })), [])
  // a bad Slack link drops that asker, not the line
  assert.deepEqual(texts(item({ linked: [slackLink('dev', 'slack://x')] })), ['waiting: priya asked for your review.'])
})

test('Last time: done and back, not useful and back', () => {
  assert.deepEqual(texts(item({ reason: 'your-pr', returned: true })), ['last: You marked it done. New activity brought it back.'])
  assert.deepEqual(texts(item({ reason: 'your-pr', notUseful: 'old|' })), ['last: You marked it not useful. Something new happened since.'])
  // still quiet: nothing new since the mark, so no line
  assert.deepEqual(texts(item({ reason: 'your-pr', notUseful: '2026-10-24T10:00:00Z|' })), [])
})

test('Last time: your newest decision, cut at 10 words; Junior decisions skipped', () => {
  const at = new Date(2026, 9, 20, 12).getTime()
  const memory = {
    decisions: [
      { at: at - 86_400_000, by: 'you' as const, text: 'older one' },
      { at, by: 'you' as const, text: 'keep the old retry count for now' },
      { at: at + 1000, by: 'junior' as const, text: 'I will rewrite the whole module' },
    ],
  }
  const [l] = briefLines(item({ reason: 'your-pr', memory }), 'samar', NOW)
  assert.equal(l!.text, 'Oct 20, you decided: keep the old retry count for now.')
  assert.deepEqual(l!.cites, [{ label: 'notes', href: itemPageHref('github:acme/api#412'), external: false, aria: 'Open its notes in Junior' }])

  const long = { decisions: [{ at, by: 'you' as const, text: 'one two three four five six seven eight nine ten eleven twelve' }] }
  const [c] = briefLines(item({ reason: 'your-pr', memory: long }), 'samar', NOW)
  assert.equal(c!.text, 'Oct 20, you decided: one two three four five six seven eight nine ten…')
  assert.equal(c!.full, 'Oct 20, you decided: one two three four five six seven eight nine ten eleven twelve.')

  const lastYear = { decisions: [{ at: new Date(2025, 2, 3, 12).getTime(), by: 'you' as const, text: 'ship it' }] }
  assert.equal(briefLines(item({ reason: 'your-pr', memory: lastYear }), 'samar', NOW)[0]!.text, 'Mar 3, 2025, you decided: ship it.')

  const onlyJunior = { decisions: [{ at, by: 'junior' as const, text: 'model words' }] }
  assert.deepEqual(texts(item({ reason: 'your-pr', memory: onlyJunior })), [])
})

test("Last time: Junior's last finished task, title only, cut at 8 words", () => {
  const tasks = { total: 1, done: 1, needsYou: 0, next: null, lastDone: 'Fix lint ✓ · rewrote the config in a model summary' }
  const [l] = briefLines(item({ reason: 'your-pr', tasks: tasks as unknown as BriefItem['tasks'] }), 'samar', NOW)
  assert.equal(l!.text, 'Last finished: Fix lint.')
  assert.equal(l!.cites[0]!.label, 'tasks')
  const long = { ...tasks, lastDone: 'a b c d e f g h i j ✓' }
  assert.equal(briefLines(item({ reason: 'your-pr', tasks: long as unknown as BriefItem['tasks'] }), 'samar', NOW)[0]!.text, 'Last finished: a b c d e f g h…')
})

test('Now: main red first, verbatim, with its run', () => {
  const seen = { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false, mainRed: [{ check: 'lint', url: 'https://github.com/acme/api/actions/runs/9', sha: '9f8e7d6aaaa', at: new Date(NOW - 2 * 3_600_000).toISOString() }] }
  const [n] = briefLines(item({ reason: 'your-pr', seen }), 'samar', NOW)
  assert.equal(n!.text, 'lint failed on main too, at 9f8e7d6, 2h ago.')
  assert.deepEqual([n!.cites[0]!.label, n!.cites[0]!.aria], ["main's run", "Open main's run for lint on GitHub"])
})

test('Now: red checks, CI failing, conflict; checks link only on a PR url', () => {
  const seen = (red: string[], rebase: 'conflict' | null = null) => ({ red, bots: 0, people: 0, rebase, draft: false })
  assert.deepEqual(texts(item({ reason: 'your-pr', seen: seen(['lint']) })), ['now: lint is red on this PR.'])
  assert.deepEqual(texts(item({ reason: 'your-pr', seen: seen(['lint', 'test']) })), ['now: 2 checks are red on this PR.'])
  const [c] = briefLines(item({ reason: 'your-pr', ciFailing: true }), 'samar', NOW)
  assert.equal(c!.text, 'CI is failing on this PR.')
  assert.equal(c!.cites[0]!.href, `${PR_URL}/checks`)
  assert.deepEqual(texts(item({ reason: 'your-pr', ciFailing: true, url: 'https://github.com/acme/api/issues/412' })), [])
  assert.deepEqual(texts(item({ reason: 'your-pr', seen: seen([], 'conflict') })), ['now: It has merge conflicts with its base.'])
})

test('Now: omitted when the Ready line shows, unless main is red', () => {
  const ready = { ready: false } as unknown as NonNullable<NonNullable<BriefItem['seen']>['ready']>
  assert.deepEqual(texts(item({ reason: 'your-pr', ciFailing: true, seen: { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false, ready } })), [])
  // a review request has no Ready line: CI still shows
  assert.deepEqual(texts(item({ ciFailing: true, peopleWaiting: 0 })).at(-1), 'now: CI is failing on this PR.')
})

test('an older item with no memory, seen or tasks gives fewer lines, never a throw', () => {
  const bare = { id: 'x', source: 'mcp-thing', reason: 'found', author: '', url: '', repo: '', peopleWaiting: 0, updatedAt: '' } as BriefItem
  assert.deepEqual(briefLines(bare, null, NOW), [])
})

test('every sentence is 15 words or fewer', () => {
  const i = item({ returned: true, ciFailing: true, linked: [slackLink('dev')], peopleWaiting: 9 })
  for (const l of briefLines(i, 'samar', NOW)) for (const s of l.text.split(/(?<=[.!?…])\s+/)) assert.ok(s.split(/\s+/).length <= 15, s)
})
