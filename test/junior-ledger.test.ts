/**
 * The Junior page's Ledger (core/junior/ledger.ts): which rows each pill tab
 * shows, in what order, and the one-word state Junior writes on each.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { juniorState, ledgerCount, ledgerProgress, ledgerRows, personWaits } from '../core/junior/ledger.js'
import type { ScoredItem } from '../core/work/types.js'

const item = (id: string, over: Partial<ScoredItem> = {}): ScoredItem =>
  ({
    id,
    source: 'github',
    kind: 'mention',
    title: id,
    url: '',
    repo: 'acme/web',
    author: 'niraj',
    peopleWaiting: 0,
    createdAt: '2026-10-22T08:00:00Z',
    updatedAt: '2026-10-22T08:00:00Z',
    score: 10,
    group: 'fyi',
    rankWhy: '',
    ask: 'read',
    reason: 'mentioned',
    ...over,
  }) as ScoredItem

const review = item('review', { kind: 'review-requested', reason: 'review-requested', group: 'blocking', score: 100, peopleWaiting: 1 })
const stale = item('stale', { kind: 'own-pr-conflicting', reason: 'your-pr', group: 'blocked-stale', score: 70 })
const ticket = item('ticket', { kind: 'ticket-assigned', reason: 'assigned', group: 'cycle', score: 50 })
const fyi = item('fyi', { score: 30 })
const digest = item('digest', { kind: 'digest', score: 99 })
const paused = item('paused', { kind: 'manual', reason: 'you-added', group: 'cycle', score: 45, handoff: 'on', junior: { stage: 'needs-you' } })
const openPr = item('open-pr', { kind: 'own-pr-open', reason: 'your-pr', group: 'fyi', score: 15 })

test('Up next: the scorer groups in order, by score inside each, no digests', () => {
  const rows = ledgerRows([fyi, ticket, digest, stale, review, openPr], 'up').map((i) => i.id)
  assert.deepEqual(rows, ['review', 'stale', 'ticket', 'fyi', 'open-pr'])
})

test('Needs you is Junior waiting on you, and those leave Up next; no orange age for them', () => {
  const ready = { ...review, id: 'ready', tasks: { line: null, running: false, queued: 0, needsYou: 0, next: null, lastDone: null, review: { state: 'ready' as const, verdict: null, line: null } } }
  assert.deepEqual(ledgerRows([ticket, paused, review, ready], 'needs').map((i) => i.id), ['ready', 'paused'])
  assert.deepEqual(ledgerRows([ticket, paused, review, ready], 'up').map((i) => i.id), ['review', 'ticket'])
  assert.equal(personWaits(paused), false)
  assert.equal(personWaits(review), true)
})

test('tabs: reviews, my PRs, with Junior, waiting on others', () => {
  const all = [review, stale, ticket, fyi, paused, openPr]
  assert.deepEqual(ledgerRows(all, 'reviews').map((i) => i.id), ['review'])
  assert.deepEqual(ledgerRows(all, 'prs').map((i) => i.id), ['stale', 'open-pr'])
  assert.deepEqual(ledgerRows(all, 'with').map((i) => i.id), ['paused'])
  assert.deepEqual(ledgerRows(all, 'waiting').map((i) => i.id), ['open-pr'])
  assert.deepEqual(ledgerCount(all, 'needs'), { n: 1, hot: 1 })
  assert.deepEqual(ledgerCount(all, 'up'), { n: 5, hot: 1 })
  assert.deepEqual(ledgerCount(all, 'with'), { n: 1, hot: 1 })
})

test("Junior's state: paused, needs you, review stages, suggestion, nothing", () => {
  assert.deepEqual(juniorState(paused), { text: 'Paused on you', quiet: false })
  assert.deepEqual(juniorState({ ...review, handoff: 'paused' }), { text: 'Paused', quiet: true })
  assert.equal(juniorState({ ...review, tasks: { line: null, running: false, queued: 0, needsYou: 0, next: null, lastDone: null, review: { state: 'ready', verdict: 'approve', line: null } } }).text, 'First pass ready')
  assert.equal(juniorState({ ...stale, junior: { stage: 'watching' } }).text, 'Babysitting')
  assert.equal(juniorState({ ...stale, suggestion: { playbook: 'babysit', head: '', would: '', tier: 2 } }).text, 'Can babysit')
  assert.deepEqual(juniorState(fyi), { text: '', quiet: true })
})

test('progress: only a working pipeline draws a bar', () => {
  assert.equal(ledgerProgress({ ...ticket, junior: { stage: 'working', pipeline: { done: 2, at: 'junior' } } }), 0.4)
  assert.equal(ledgerProgress({ ...ticket, junior: { stage: 'watching', pipeline: { done: 5, at: null } } }), null)
  assert.equal(ledgerProgress(ticket), null)
})
