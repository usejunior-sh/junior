/**
 * Close candidates (core/work/close.ts): which of your PRs Junior asks
 * "Close?" about, on a fake clock, and where they sit on the Ledger.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { keepOpenOp } from '../server/items-ops.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'
import { closeCandidate, closeMoreLabel, closeOrder, closePrompt, closeSays, closeState, closeGroupLabel, shortRef, supersededBy, type CloseInput } from '../core/work/close.js'
import { ageHot, closeRows, juniorState, ledgerCount, ledgerRows } from '../core/junior/ledger.js'
import { filterCounts, filtersOf } from '../core/work/turn-tabs.js'
import type { ScoredItem } from '../core/work/types.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-24T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

const pr = (over: Partial<CloseInput> = {}): CloseInput => ({ kind: 'own-pr-stale', reason: 'your-pr', updatedAt: ago(40), ...over })

test('quiet: 29 whole days is not yet, 30 is', () => {
  assert.equal(closeCandidate(pr({ updatedAt: ago(29) }), NOW), null)
  assert.equal(closeCandidate(pr({ updatedAt: new Date(NOW - 30 * DAY + 60_000).toISOString() }), NOW), null)
  assert.deepEqual(closeCandidate(pr({ updatedAt: ago(30) }), NOW), { why: 'quiet', days: 30 })
  assert.deepEqual(closeCandidate(pr({ updatedAt: ago(412) }), NOW), { why: 'quiet', days: 412 })
})

test('drafts and open PRs count; approved, handed off and other people’s PRs do not', () => {
  assert.deepEqual(closeCandidate(pr({ kind: 'own-pr-open' }), NOW), { why: 'quiet', days: 40 })
  assert.equal(closeCandidate(pr({ kind: 'own-pr-approved' }), NOW), null)
  assert.equal(closeCandidate(pr({ handoff: 'on' }), NOW), null)
  assert.deepEqual(closeCandidate(pr({ handoff: 'paused' }), NOW), { why: 'quiet', days: 40 })
  assert.equal(closeCandidate(pr({ reason: 'review-requested', kind: 'review-requested' }), NOW), null)
  assert.equal(closeCandidate(pr({ reason: undefined }), NOW), null)
})

test('kept open: no asking for 30 days, then it can come back', () => {
  assert.equal(closeCandidate(pr({ keptOpen: NOW - 10 * DAY }), NOW), null)
  assert.equal(closeCandidate(pr({ keptOpen: NOW - 10 * DAY }), NOW, '#3310'), null)
  assert.deepEqual(closeCandidate(pr({ keptOpen: NOW - 31 * DAY }), NOW), { why: 'quiet', days: 40 })
})

test('superseded needs no age; a bad time never suggests closing', () => {
  assert.deepEqual(closeCandidate(pr({ updatedAt: ago(2) }), NOW, '#3310'), { why: 'superseded', by: '#3310' })
  assert.equal(closeCandidate(pr({ updatedAt: 'not a date' }), NOW), null)
  assert.equal(closeCandidate(pr({ updatedAt: '' }), NOW), null)
})

test('supersededBy: a merged PR naming an open one, in its refs or its title', () => {
  const open = [
    { id: 'github:acme/web#3203', repo: 'acme/web' },
    { id: 'github:acme/web#3150', repo: 'acme/web' },
    { id: 'github:acme/docs#190', repo: 'acme/docs' },
  ]
  const merged = [
    { id: 'github:acme/web#3310', repo: 'acme/web', title: 'SSE inbox, replaces #3203', refs: [] },
    { id: 'github:acme/api#881', repo: 'acme/api', title: 'Move docs', refs: ['github:acme/docs#190'] },
    { id: 'github:acme/web#3400', repo: 'acme/web', title: 'Nothing to see' },
  ]
  const by = supersededBy(open, merged)
  assert.equal(by.get('github:acme/web#3203'), '#3310')
  assert.equal(by.get('github:acme/docs#190'), 'acme/api#881')
  assert.equal(by.has('github:acme/web#3150'), false)
  assert.equal(shortRef('slack:C1/123'), null)
})

test('order: replaced first, then the longest quiet', () => {
  const rows = [
    { id: 'a', close: { why: 'quiet' as const, days: 33 } },
    { id: 'b', close: { why: 'quiet' as const, days: 41 } },
    { id: 'c', close: { why: 'superseded' as const, by: '#3310' } },
  ]
  assert.deepEqual([...rows].sort(closeOrder).map((r) => r.id), ['c', 'b', 'a'])
})

test('copy: state, Junior’s line, the draft prefill and labels', () => {
  assert.equal(closeState({ why: 'quiet', days: 41 }), 'Quiet 41 days')
  assert.equal(closeState({ why: 'superseded', by: '#3310' }), 'Replaced by #3310')
  assert.match(closeSays({ why: 'quiet', days: 41 }), /^No one has touched this in 41 days\. Keep it, or I’ll draft/)
  assert.match(closeSays({ why: 'superseded', by: '#3310' }), /^#3310 merged and links here\./)
  assert.equal(closePrompt('acme/web#3150', { why: 'quiet', days: 41 }), 'Close acme/web#3150. It has been quiet for 41 days. Write a short, kind closing note first. Show it to me before anything goes out.')
  assert.match(closePrompt('acme/web#3203', { why: 'superseded', by: '#3310' }), /^Close acme\/web#3203\. #3310 replaced it\./)
  assert.equal(closeGroupLabel(1), 'Close? 1 quiet PR')
  assert.equal(closeGroupLabel(3), 'Close? 3 quiet PRs')
  assert.equal(closeMoreLabel(1), '1 more quiet PR')
  assert.equal(closeMoreLabel(14), '14 more quiet PRs')
})

const item = (id: string, over: Partial<ScoredItem> = {}): ScoredItem =>
  ({
    id,
    source: 'github',
    kind: 'own-pr-stale',
    title: id,
    url: '',
    repo: 'acme/web',
    author: 'me',
    peopleWaiting: 0,
    createdAt: ago(60),
    updatedAt: ago(1),
    score: 10,
    group: 'blocked-stale',
    rankWhy: '',
    ask: 'do',
    reason: 'your-pr',
    ...over,
  }) as ScoredItem

test('ledger: a candidate leaves My PRs, Up next and Waiting for the Close? group', () => {
  const live = item('live')
  const dead = item('dead', { updatedAt: ago(41), close: { why: 'quiet', days: 41 }, group: 'blocking' })
  const replaced = item('replaced', { close: { why: 'superseded', by: '#3310' } })
  const items = [live, dead, replaced]
  for (const tab of ['prs', 'up', 'waiting'] as const) assert.deepEqual(ledgerRows(items, tab).map((i) => i.id), ['live'], tab)
  assert.deepEqual(closeRows(items).map((i) => i.id), ['replaced', 'dead'])
  assert.deepEqual(ledgerCount(items, 'prs'), { n: 1, hot: 0 })
  // never orange, and the state column says why, in grey
  assert.equal(ageHot(dead), false)
  assert.deepEqual(juniorState(dead), { text: 'Quiet 41 days', quiet: true })
  assert.deepEqual(juniorState(replaced), { text: 'Replaced by #3310', quiet: true })
})

test('three tabs: a candidate keeps the My PRs filter but not Up next, and never counts on the pill', () => {
  const live = item('live')
  const dead = item('dead', { close: { why: 'quiet', days: 41 } })
  assert.deepEqual(filtersOf(dead), ['my-prs'])
  assert.deepEqual(filtersOf(live), ['up-next', 'my-prs'])
  assert.deepEqual(filterCounts([live, dead]), { 'up-next': 1, reviews: 0, 'my-prs': 1 })
})

test('Keep: stamps keptOpen and records a kept-open event by you; an unknown id is an error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-close-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = { store, meta: { id: 'test' }, clients: new Set(), inboxCache: null } as unknown as WorkspaceRuntime
  try {
    const id = 'github:acme/web#3150'
    await store.items.upsert({ id, source: 'github', kind: 'own-pr-stale', title: 'Try pnpm workspaces', url: '', repo: 'acme/web', author: 'me', peopleWaiting: 0, createdAt: ago(60), updatedAt: ago(41) })
    assert.equal(await keepOpenOp(rt, { id }, NOW), NOW)
    const got = await store.items.get(id)
    assert.equal(got?.keptOpen, NOW)
    assert.equal(closeCandidate({ ...got!, reason: 'your-pr' }, NOW + 29 * DAY), null)
    const ev = (await store.items.events(id)).at(-1)
    assert.equal(ev?.event, 'kept-open')
    assert.equal(ev?.actor, 'user')
    await assert.rejects(keepOpenOp(rt, { id: 'github:acme/web#1' }, NOW), /no such item/)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
