/**
 * The source registry (shared/sources.ts): a descriptor per known source, the
 * neutral one for any other string, and the core/junior lines that read
 * capabilities off it instead of comparing ids.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKnownSource, KNOWN_SOURCES, linkForRef, NEUTRAL_SOURCE, sourceLabel, sourceOf, sourceRef } from '../shared/sources.js'
import { shortRef } from '../core/junior/today.js'
import { offerFor, sourceWord, canDoFill, type OfferItem } from '../core/junior/offers.js'
import { handoffReadiness } from '../core/work/handoff.js'
import { identityFromUrl } from '../server/jobs/scan-mcp.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { WorkItem } from '../core/work/types.js'

test('sourceOf: a known id gets its own descriptor, anything else the neutral one', () => {
  const gh = sourceOf('github')
  assert.equal(gh.id, 'github')
  assert.equal(gh.known, true)
  assert.equal(gh.label, 'GitHub')
  assert.equal(gh.icon, 'pr')
  assert.equal(gh.watches, true)

  const sentry = sourceOf('sentry')
  assert.equal(sentry.known, false)
  assert.equal(sentry.id, 'sentry')
  assert.equal(sentry.label, 'Sentry')
  // everything but its name is the neutral descriptor's
  for (const k of ['icon', 'shape', 'noun', 'yours', 'watches', 'playbook', 'canReply', 'reply', 'ref', 'link'] as const) {
    assert.equal(sentry[k], NEUTRAL_SOURCE[k], k)
  }
  assert.equal(sentry.icon, 'dot')
  assert.equal(sentry.canReply, false)
  assert.equal(sourceOf('sentry'), sentry, 'repeat lookups return the same descriptor')
})

test('sourceOf: empty, missing and odd ids still get a usable descriptor', () => {
  for (const id of ['', undefined, null]) {
    const d = sourceOf(id)
    assert.equal(d.known, false)
    assert.equal(d.label, 'Source')
    assert.equal(d.from, 'a source')
  }
  // inherited object keys are not sources
  assert.equal(sourceOf('toString').known, false)
  assert.equal(sourceOf('__proto__').known, false)
  assert.equal(isKnownSource('constructor'), false)
})

test('the known table: one descriptor each, id matches the key', () => {
  for (const id of KNOWN_SOURCES) {
    const d = sourceOf(id)
    assert.equal(d.id, id)
    assert.equal(d.known, true)
    assert.equal(d.canReply, d.reply !== null, `${id}: canReply and reply agree`)
  }
  assert.deepEqual(
    KNOWN_SOURCES.filter((s) => sourceOf(s).canReply),
    ['slack'],
  )
  assert.deepEqual(
    KNOWN_SOURCES.filter((s) => sourceOf(s).yours),
    ['manual'],
  )
  assert.equal(sourceOf('slack').playbook, 'answer')
  assert.equal(sourceOf('pagerduty').playbook, 'investigate')
})

test('sourceLabel: an MCP server name, read as words', () => {
  const rows: [string, string][] = [
    ['sentry', 'Sentry'],
    ['pager-duty', 'Pager Duty'],
    ['claude_ai.notion', 'Claude Ai Notion'],
    ['  ', 'Source'],
  ]
  for (const [id, want] of rows) assert.equal(sourceLabel(id), want, id)
})

test('ref parsers and link builders', () => {
  assert.equal(sourceRef({ id: 'github:acme/api#478', source: 'github', repo: 'acme/api', url: '' }), '#478')
  assert.equal(sourceRef({ id: 'linear:NOV-140', source: 'linear', repo: 'NOV', url: '' }), 'NOV-140')
  assert.equal(sourceRef({ id: 'slack:x', source: 'slack', repo: 'api', url: '' }), '#api')
  assert.equal(sourceRef({ id: 'slack:x', source: 'slack', repo: '', url: '' }), 'Slack')
  // a job-filed PR keeps its github: id: the id's own parser still reads it
  assert.equal(sourceRef({ id: 'github:acme/api#9', source: 'job', repo: '', url: '' }), '#9')
  assert.equal(sourceRef({ id: 'sentry:ABC-1', source: 'sentry', repo: '', url: '' }), null)

  assert.equal(linkForRef('github:acme/api#478'), 'https://github.com/acme/api/issues/478')
  assert.equal(linkForRef('linear:NOV-140'), 'https://linear.app/issue/NOV-140')
  assert.equal(linkForRef('web:example.com/a'), 'https://example.com/a')
  assert.equal(linkForRef('slack:C1/p1'), null)
  assert.equal(linkForRef('sentry:ABC-1'), null)
  assert.equal(linkForRef('no-prefix'), null)
})

test('shortRef: an unknown source reads as its home, then its name', () => {
  assert.equal(shortRef({ id: 'sentry:1', source: 'sentry', repo: 'api-prod', url: '' }), 'api-prod')
  assert.equal(shortRef({ id: 'sentry:1', source: 'sentry', repo: '', url: '' }), 'Sentry')
  assert.equal(shortRef({ id: 'sentry:1', source: 'sentry', repo: '', url: 'https://github.com/a/b/pull/7' }), '#7')
  // known sources keep their old fallback
  assert.equal(shortRef({ id: 'web:1', source: 'web', repo: '', url: '' }), 'web')
})

const offer = (over: Partial<OfferItem>): OfferItem => ({
  id: 'x:1',
  title: 'Can you check the rollout plan?',
  url: 'https://example.com/1',
  source: 'slack',
  kind: 'slack-mention',
  repo: 'api',
  author: 'Priya',
  score: 50,
  ask: 'reply',
  createdAt: new Date(0).toISOString(),
  ...over,
})

test('offers: the reply line follows canReply', () => {
  const slack = offerFor(offer({}), 0)
  assert.match(slack.detail, /nothing is posted until you send it/)
  assert.match(slack.say, /Nothing gets posted until I send it/)

  const sentry = offerFor(offer({ source: 'sentry', id: 'sentry:1', repo: 'api-prod' }), 0)
  assert.equal(sentry.title, 'Draft a reply to Priya on api-prod')
  assert.match(sentry.detail, /you copy it and send it/)
  assert.match(sentry.say, /copy it and send it myself/)
  assert.equal(sentry.because, 'Sentry')
})

test('sourceWord: the same words as before for known sources', () => {
  assert.deepEqual(
    ['github', 'slack', 'linear', 'manual', 'job', 'web', 'rollbar'].map(sourceWord),
    ['GitHub', 'Slack', 'Linear', 'Your to-do', 'A job', 'The web', 'Rollbar'],
  )
})

test('canDoFill: tickets and repos by shape, not by id', () => {
  const f = canDoFill(
    [
      offer({ id: 'linear:NOV-1', source: 'linear', kind: 'ticket-assigned', ask: 'read', repo: 'NOV' }),
      offer({ id: 'github:acme/api#3', source: 'github', kind: 'review-requested', ask: 'read', repo: 'acme/api' }),
      offer({ id: 'sentry:1', source: 'sentry', kind: 'job-hit', ask: 'read', repo: 'api-prod' }),
    ],
    [],
    false,
  )
  assert.deepEqual(f.takes, ['NOV-1'])
  assert.deepEqual(f.repos, ['acme/api'])
})

test('handoffReadiness: only a source the watches read is supported', () => {
  const on = { babysit: true, review: true }
  assert.deepEqual(handoffReadiness({ reason: 'your-pr', source: 'github' }, on), { state: 'ready' })
  assert.equal(handoffReadiness({ reason: 'your-pr', source: 'sentry' }, on).state, 'unsupported')
  assert.deepEqual(handoffReadiness({ reason: 'asked', source: 'sentry' }, on), { state: 'ready' })
})

test('identityFromUrl: bare refs get their link from the descriptor', () => {
  assert.equal(identityFromUrl('acme/api#12')?.url, 'https://github.com/acme/api/issues/12')
  assert.equal(identityFromUrl('NOV-12')?.url, 'https://linear.app/issue/NOV-12')
})

test('rows with old and new source values both load', async () => {
  const store = openSqliteStore(':memory:')
  const now = new Date().toISOString()
  const base = { kind: 'job-hit', title: 't', url: 'https://example.com', repo: '', author: '', peopleWaiting: 0, createdAt: now, updatedAt: now } as const
  const items: WorkItem[] = [
    { ...base, id: 'github:acme/api#1', source: 'github' },
    { ...base, id: 'slack:C1-1', source: 'slack' },
    { ...base, id: 'linear:NOV-1', source: 'linear' },
    { ...base, id: 'web:example.com', source: 'web' },
    { ...base, id: 'job:m:1', source: 'job', kind: 'digest' },
    { ...base, id: 'sentry:ABC-1', source: 'sentry' },
  ]
  for (const it of items) await store.items.upsert(it)
  const back = new Map((await store.items.listAll()).map((i) => [i.id, i.source]))
  for (const it of items) assert.equal(back.get(it.id), it.source, it.id)
  assert.equal(sourceOf(back.get('sentry:ABC-1')).known, false)
})
