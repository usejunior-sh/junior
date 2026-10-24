/**
 * Message status (core/work/status.ts): one table of real-looking messages
 * from GitHub, Slack, Linear, a job's filed item and a generic MCP source,
 * each pinned to one status and one reason. Positives must ask you; the
 * negatives are the near misses a loose rule would ping you for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MESSAGE_STATUSES,
  STATUS_REASONS,
  STATUS_REASON_LIST,
  latestStatus,
  mentionsIn,
  messageOf,
  plainText,
  statusOf,
  type Me,
  type StatusReason,
} from '../core/work/status.js'
import { turnOf } from '../core/work/turn.js'

const ME: Me = { handles: ['samar', 'U07SAMAR'] }

// The shapes, as each source writes them.
const gh = (body: string, login = 'priya', extra: Record<string, unknown> = {}) => ({ id: 1, body, user: { login, type: 'User' }, html_url: 'https://github.com/acme/web/pull/1#c1', ...extra })
const ghBot = (body: string, login: string) => ({ id: 2, body, user: { login, type: 'Bot' } })
const ghReviewRequest = { event: 'review_requested', actor: { login: 'priya' }, requested_reviewer: { login: 'samar' } }
const slack = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'message', user: 'U02PRIYA', text, ts: '1729760000.000100', channel: 'C01WEB', ...extra })
const slackDm = (text: string, extra: Record<string, unknown> = {}) => slack(text, { channel: 'D01PRIYA', channel_type: 'im', ...extra })
const jobItem = (ask: string, extra: Record<string, unknown> = {}) => ({ id: 'job:mentions:1', source: 'job', kind: 'job-hit', title: 'Can you look at the outage?', why: 'asked in #ops', author: 'niraj', ask, ...extra })
const linear = (body: string, name = 'Priya') => ({ id: 'c-1', body, user: { id: '0f6c…', name, displayName: name.toLowerCase() } })
const mcp = (content: string, extra: Record<string, unknown> = {}) => ({ content, from: 'niraj', ...extra })

type Row = { name: string; raw: unknown; opts?: { source?: string; direct?: boolean }; want: StatusReason }

const POSITIVE: Row[] = [
  // GitHub
  { name: 'gh: mention + take a look', raw: gh('@samar can you take a look at the migration before Friday?'), want: 'approval-ask' },
  { name: 'gh: mention + question', raw: gh('@samar does this need a feature flag?'), want: 'direct-question' },
  { name: 'gh: PTAL', raw: gh('Addressed the nits. @samar PTAL'), want: 'approval-ask' },
  { name: 'gh: question on your own PR, no mention', raw: gh('Why did you pick a mutex here?'), opts: { direct: true }, want: 'direct-question' },
  { name: 'gh: ok to merge?', raw: gh('@samar ok to merge once CI is green?'), want: 'approval-ask' },
  { name: 'gh: review requested event', raw: ghReviewRequest, want: 'review-request' },
  { name: 'gh: let me know', raw: gh('@samar let me know if the new schema works for you.'), want: 'direct-request' },
  // Slack
  { name: 'slack: DM question', raw: slackDm('hey, got a minute to pair on the flaky test?'), want: 'direct-question' },
  { name: 'slack: mention + could you approve', raw: slack('<@U07SAMAR> could you approve the deploy to prod'), want: 'approval-ask' },
  { name: 'slack: labelled mention + wdyt', raw: slack('<@U07SAMAR|samar> wdyt about moving standup to 10'), want: 'direct-request' },
  { name: 'slack: DM sign-off', raw: slackDm('need your sign-off on the Q4 doc'), want: 'approval-ask' },
  { name: 'slack: question emoji', raw: slack('<@U07SAMAR> :question: is staging down for you too'), want: 'direct-question' },
  { name: 'slack: a question in a link label', raw: slack('<@U07SAMAR> notes: <https://acme.dev/x?y=1|why is it slow?>'), want: 'direct-question' },
  { name: 'slack: can I merge?', raw: slackDm('tests pass now. can I merge this?'), want: 'approval-ask' },
  // a job's filed item, or a scanner's
  { name: 'job: ask reply', raw: jobItem('reply'), want: 'source-asks' },
  { name: 'job: ask decide', raw: jobItem('decide'), want: 'approval-request' },
  { name: 'job: ask review', raw: jobItem('review'), want: 'review-request' },
  { name: 'item: review requested', raw: { id: 'github:acme/web#9', source: 'github', kind: 'review-requested', title: 'Add retries', author: 'priya' }, want: 'review-request' },
  { name: 'item: Slack reply pending', raw: { id: 'slack:C01:1', source: 'slack', kind: 'slack-reply-pending', title: 'Deploy window', author: 'niraj' }, want: 'source-asks' },
  // Linear, and any other MCP source
  { name: 'linear: can you confirm', raw: linear('@samar can you confirm the repro steps'), opts: { source: 'linear' }, want: 'direct-request' },
  { name: 'mcp: listed mention + question', raw: mcp('Is the rollback safe to run now?', { mentions: ['samar'] }), opts: { source: 'pagerduty' }, want: 'direct-question' },
]

const NEGATIVE: Row[] = [
  // GitHub
  { name: 'gh: thanks, merged', raw: gh('Thanks @samar, merged!'), want: 'no-ask' },
  { name: 'gh: question to everyone, not you', raw: gh('Can you all review this before Friday?'), want: 'not-addressed' },
  { name: 'gh: bot login, mentions you', raw: gh('@samar would you like to rebase?', 'dependabot[bot]'), want: 'bot' },
  { name: 'gh: bot type', raw: ghBot('Can you add tests for the uncovered lines?', 'codecov'), opts: { direct: true }, want: 'bot' },
  { name: 'gh: your own comment', raw: gh('@priya can you look again?', 'samar'), want: 'own-message' },
  { name: 'gh: says no action needed', raw: gh('@samar FYI only: the API changed. Can ignore. No action needed.'), want: 'says-fyi' },
  { name: 'gh: the question is quoted', raw: gh('> @samar can you review?\n\nDone, reviewed it.'), want: 'not-addressed' },
  { name: 'gh: a ? inside a URL', raw: gh('@samar see https://example.com/search?q=foo for context'), want: 'no-ask' },
  { name: 'gh: a ? inside code', raw: gh('@samar the fix is `x ?? y` plus\n```ts\nconst a = b?.c\n```'), want: 'no-ask' },
  { name: 'gh: an email, not a mention', raw: gh('ping priya@samar.dev, can she help?'), want: 'not-addressed' },
  { name: 'gh: a team that only starts with your name', raw: gh('@samar-team can you review?'), want: 'not-addressed' },
  { name: 'gh: approved, past tense', raw: gh('@samar approved by legal.'), want: 'no-ask' },
  // Slack
  { name: 'slack: @here, not you', raw: slack('<!here> can someone restart the runner?'), want: 'not-addressed' },
  { name: 'slack: a bot DM', raw: slackDm('Your deploy finished. Can you rate it?', { bot_id: 'B01DEPLOY', subtype: 'bot_message' }), want: 'bot' },
  { name: 'slack: thanks', raw: slack('<@U07SAMAR> shipped the fix, thanks!'), want: 'no-ask' },
  { name: 'slack: DM just fyi', raw: slackDm('just fyi, out tomorrow. can you believe the weather'), want: 'says-fyi' },
  { name: 'slack: no need to reply', raw: slack('<@U07SAMAR> no need to reply, the doc is updated'), want: 'says-fyi' },
  { name: 'slack: lgtm, no question', raw: slack('<@U07SAMAR> lgtm'), want: 'no-ask' },
  // a job's filed item: its title is a summary, never read
  { name: 'job: ask read', raw: jobItem('read'), want: 'empty' },
  { name: 'job: ask follow-up', raw: jobItem('follow-up'), want: 'empty' },
  { name: 'item: a GitHub mention', raw: { id: 'github:acme/web#3', source: 'github', kind: 'mention', title: 'Why does CI fail on main?', author: 'priya' }, want: 'empty' },
  // Linear, and any other MCP source
  { name: 'linear: a status note', raw: linear('@samar moved this to In Progress.'), opts: { source: 'linear' }, want: 'no-ask' },
  { name: 'slack: curly apostrophe, nothing needed', raw: slack('<@U07SAMAR> you don’t need to review, can merge myself'), want: 'says-fyi' },
  { name: 'mcp: no text', raw: mcp(''), opts: { source: 'sentry' }, want: 'empty' },
  { name: 'mcp: not addressed', raw: mcp('New error in checkout: TypeError. Can anyone look?'), opts: { source: 'sentry' }, want: 'not-addressed' },
]

const sourceOf = (r: Row) => messageOf(r.raw, r.opts).source

test('each fixture gets its expected status and reason', () => {
  for (const r of [...POSITIVE, ...NEGATIVE]) {
    const got = statusOf(messageOf(r.raw, r.opts), ME)
    assert.equal(got.reason, r.want, r.name)
    assert.equal(got.status, STATUS_REASONS[r.want].status, `${r.name}: the reason implies the status`)
  }
})

test('at least 12 positives and 12 negatives, across at least three source shapes', () => {
  const pos = POSITIVE.filter((r) => STATUS_REASONS[r.want].status !== 'fyi')
  const neg = NEGATIVE
  assert.equal(pos.length, POSITIVE.length, 'every positive asks')
  assert.ok(neg.every((r) => STATUS_REASONS[r.want].status === 'fyi'), 'every negative is an FYI')
  assert.ok(pos.length >= 12, `${pos.length} positives`)
  assert.ok(neg.length >= 12, `${neg.length} negatives`)
  const posSources = new Set(pos.map(sourceOf))
  const negSources = new Set(neg.map(sourceOf))
  for (const s of ['github', 'slack', 'job']) {
    assert.ok(posSources.has(s), `no positive from ${s}`)
    assert.ok(negSources.has(s), `no negative from ${s}`)
  }
  assert.ok(posSources.size >= 3 && negSources.size >= 3)
})

test('the reasons are a closed union: each has a fixture and belongs to one status', () => {
  const seen = new Set([...POSITIVE, ...NEGATIVE].map((r) => r.want))
  for (const reason of STATUS_REASON_LIST) {
    assert.ok(seen.has(reason), `no fixture for ${reason}`)
    const { status, text } = STATUS_REASONS[reason]
    assert.ok(MESSAGE_STATUSES.includes(status), reason)
    // copy rule: short, no "AI", no "24/7"
    assert.ok(text.split(/\s+/).length <= 15 && !/\bAI\b|24\/7/.test(text), reason)
  }
})

test('statusOf is pure: same input, same answer, input untouched', () => {
  for (const r of [...POSITIVE, ...NEGATIVE]) {
    const msg = messageOf(r.raw, r.opts)
    const before = JSON.stringify(msg)
    assert.deepEqual(statusOf(msg, ME), statusOf(msg, ME), r.name)
    assert.equal(JSON.stringify(msg), before, r.name)
  }
})

test('an ask with a link "for reference" is still an ask', () => {
  assert.equal(statusOf(messageOf(gh('@samar can you review? The spec is linked for reference.')), ME).reason, 'approval-ask')
})

test('your handles match whatever their case', () => {
  assert.equal(statusOf(messageOf(gh('@Samar does this need a flag?')), ME).status, 'question')
  assert.equal(statusOf(messageOf(gh('@samar does this need a flag?')), { handles: ['SAMAR'] }).status, 'question')
  // nobody to match: nothing is addressed to you
  assert.equal(statusOf(messageOf(gh('@samar does this need a flag?')), { handles: [] }).reason, 'not-addressed')
})

test('mentions: GitHub logins and teams, Slack ids and labels, never broadcasts or emails', () => {
  assert.deepEqual(mentionsIn('cc @priya @acme/web-team and @niraj.'), ['priya', 'acme/web-team', 'niraj'])
  assert.deepEqual(mentionsIn('<@U07SAMAR|samar> and <@U02PRIYA>'), ['U07SAMAR', 'samar', 'U02PRIYA'])
  assert.deepEqual(mentionsIn('@here @channel @everyone <!channel>'), [])
  assert.deepEqual(mentionsIn('mail priya@acme.dev'), [])
})

test('plainText drops quotes, code and links, keeps a Slack link label', () => {
  const t = plainText('> old: can you?\nnew line `a?b` see https://x.dev/?q=1 and <https://y.dev/?z|the doc>')
  assert.ok(!t.includes('old'))
  assert.ok(!t.includes('?'), t)
  assert.ok(t.includes('the doc'))
})

test('messageOf reads the shape each source writes', () => {
  assert.deepEqual(messageOf(gh('hi')), { source: 'github', text: 'hi', author: 'priya' })
  assert.deepEqual(messageOf(slackDm('hi')), { source: 'slack', text: 'hi', author: 'U02PRIYA', direct: true })
  assert.deepEqual(messageOf(ghReviewRequest), { source: 'github', text: '', author: 'priya', asks: 'review' })
  assert.deepEqual(messageOf(jobItem('reply')), { source: 'job', text: '', author: 'niraj', asks: 'question' })
  assert.deepEqual(messageOf(linear('hi'), { source: 'linear' }), { source: 'linear', text: 'hi', author: 'Priya' })
  assert.deepEqual(messageOf('a bare string'), { source: 'unknown', text: 'a bare string' })
  assert.deepEqual(messageOf(null), { source: 'unknown', text: '' })
})

test('the newest message decides; no messages is an FYI', () => {
  const ask = statusOf(messageOf(gh('@samar does this need a flag?')), ME)
  const thanks = statusOf(messageOf(gh('Thanks @samar, merged!')), ME)
  assert.equal(latestStatus([]), 'fyi')
  assert.equal(latestStatus([thanks, ask]), 'question')
  assert.equal(latestStatus([ask, thanks]), 'fyi')
})

test('every FYI fixture, fed to turnOf, leaves an item that is not yours where it was', () => {
  const waiting = {
    id: 'github:acme/web#1', source: 'github', kind: 'own-pr-open', title: 't', url: '', repo: 'acme/web', author: 'samar',
    peopleWaiting: 0, createdAt: '2026-10-22T08:00:00Z', updatedAt: '2026-10-22T08:00:00Z', status: 'open',
  } as const
  const base = turnOf(waiting)
  assert.equal(base.turn, 'others')
  for (const r of NEGATIVE) {
    const s = statusOf(messageOf(r.raw, r.opts), ME)
    assert.deepEqual(turnOf(waiting, { message: s.status }), base, r.name)
  }
  for (const r of POSITIVE) {
    const s = statusOf(messageOf(r.raw, r.opts), ME)
    assert.deepEqual(turnOf(waiting, { message: s.status }), { turn: 'you', reason: 'person-asks' }, r.name)
  }
})

test('no model call in the path: status.ts imports only its own pure neighbours', () => {
  const src = readFileSync(new URL('../core/work/status.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['./asks.js', './types.js'])
  assert.ok(!/claude|anthropic|query\(|fetch\(/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
})
