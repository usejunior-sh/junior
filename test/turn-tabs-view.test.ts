/**
 * The three-tab layout's two pure helpers (core/work/turn-tabs.ts): the
 * pills' counts, and where an old Up next / Reviews / My PRs link lands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterCounts, openTurnTab, turnTabs, type TurnTab } from '../core/work/turn-tabs.js'
import { flowOf } from '../core/work/flow.js'
import type { ScoredItem } from '../core/work/types.js'

let n = 0
function item(over: Partial<ScoredItem> = {}): ScoredItem {
  const base = {
    id: `github:acme/web#${++n}`,
    source: 'github',
    kind: 'mention',
    title: 't',
    url: '',
    repo: 'acme/web',
    author: 'priya',
    peopleWaiting: 0,
    createdAt: '2026-10-22T08:00:00Z',
    updatedAt: '2026-10-22T08:00:00Z',
    status: 'open',
    score: 10,
    group: 'fyi',
    rankWhy: '',
    ask: 'read',
    reason: 'mentioned',
    ...over,
  } as ScoredItem
  return { ...base, flow: base.flow ?? flowOf(base) }
}

const reviewReq = { kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking' } as const
const empty = <T = ScoredItem>(): Record<TurnTab, T[]> => ({ needs: [], with: [], waiting: [] })

test('filterCounts counts each filter a row keeps; one row can count twice', () => {
  const rows = [item(reviewReq), item({ kind: 'own-pr-approved', reason: 'your-pr', ask: 'do' }), item()]
  assert.deepEqual(filterCounts(rows), { 'up-next': 3, reviews: 1, 'my-prs': 1 })
  assert.deepEqual(filterCounts([]), { 'up-next': 0, reviews: 0, 'my-prs': 0 })
})

test('turn tabs open as themselves, no filter', () => {
  for (const t of ['needs', 'with', 'waiting'] as const) assert.deepEqual(openTurnTab(t, empty()), { tab: t, filter: null })
})

test('an old filter tab opens on Needs you when the filter keeps rows there', () => {
  const tabs = turnTabs([item(reviewReq)]).tabs
  assert.equal(tabs.needs.length, 1)
  assert.deepEqual(openTurnTab('reviews', tabs), { tab: 'needs', filter: 'reviews' })
  assert.deepEqual(openTurnTab('up', tabs), { tab: 'needs', filter: 'up-next' })
})

test('empty on Needs you: the first tab, in order, where the filter keeps something', () => {
  const pr = item({ kind: 'own-pr-open', reason: 'your-pr', ask: 'do' })
  const tabs = { ...empty<ScoredItem>(), waiting: [pr] }
  assert.deepEqual(openTurnTab('prs', tabs), { tab: 'waiting', filter: 'my-prs' })
  const both = { needs: [], with: [pr], waiting: [pr] }
  assert.deepEqual(openTurnTab('prs', both), { tab: 'with', filter: 'my-prs' })
})

test('nowhere: Needs you with the filter on, so its empty line shows', () => {
  assert.deepEqual(openTurnTab('reviews', empty()), { tab: 'needs', filter: 'reviews' })
})
