/**
 * Fewer tabs, same words (core/work/turn-tabs.ts): a table pins each fixture
 * shape to one of Needs you · With Junior · Waiting and the filters it keeps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEDGER_TAB_ROUTE,
  TURN_FILTERS,
  TURN_FILTER_TITLE,
  TURN_TABS,
  TURN_TAB_TITLE,
  filterRows,
  filtersOf,
  tabOf,
  turnTabs,
  type TurnFilter,
  type TurnTab,
} from '../core/work/turn-tabs.js'
import { flowOf, type FlowSignals } from '../core/work/flow.js'
import { ledgerRows, quietKey, type LedgerTab } from '../core/junior/ledger.js'
import type { TurnContext } from '../core/work/turn.js'
import type { JuniorWork } from '../core/work/handoff.js'
import type { TaskSummary } from '../core/work/tasks.js'
import type { ScoredItem } from '../core/work/types.js'

const T0 = Date.parse('2026-10-22T08:00:00Z')

let n = 0
function item(over: Partial<ScoredItem> = {}, signals?: FlowSignals): ScoredItem {
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
  return { ...base, flow: base.flow ?? flowOf(base, signals) }
}

const tasks = (over: Partial<TaskSummary> = {}): TaskSummary => ({ line: null, running: false, queued: 0, needsYou: 0, next: null, lastDone: null, ...over })
const review = (state: NonNullable<TaskSummary['review']>['state']) => tasks({ review: { state, verdict: null, line: null } })
const junior = (stage: JuniorWork['stage'], over: Partial<JuniorWork> = {}): JuniorWork => ({ stage, ...over })

const manual = { source: 'manual', kind: 'manual', reason: 'you-added', ask: 'do' } as const
const ownPr = (kind: ScoredItem['kind'], over: Partial<ScoredItem> = {}) => ({ kind, reason: 'your-pr' as const, ask: 'do' as const, ...over })
const reviewReq = { kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking' } as const
const handed = (stage: JuniorWork['stage'], over: Partial<JuniorWork> = {}) => ({ handoff: 'on' as const, junior: junior('watching', { readiness: { state: 'ready' }, ...over, stage }) })

type Row = { name: string; item: ScoredItem; ctx?: TurnContext; tab: TurnTab; filters: TurnFilter[] }

const ROWS: Row[] = [
  // Needs you
  { name: 'a chat on a prompt', item: item(manual), ctx: { blocked: true }, tab: 'needs', filters: ['up-next'] },
  { name: 'sends held', item: item(manual), ctx: { heldSends: 1 }, tab: 'needs', filters: ['up-next'] },
  { name: 'Junior paused on you', item: item({ ...manual, ...handed('needs-you') }), tab: 'needs', filters: [] },
  { name: 'first pass ready on a review', item: item({ ...reviewReq, ...handed('watching'), tasks: review('ready') }), tab: 'needs', filters: ['reviews'] },
  { name: 'review requested, not handed off', item: item(reviewReq), tab: 'needs', filters: ['up-next', 'reviews'] },
  { name: 'review request, Junior set it aside', item: item({ ...reviewReq, ...handed('watching'), tasks: review('skipped') }), tab: 'needs', filters: ['up-next', 'reviews'] },
  { name: 'your PR, CI red, not handed off', item: item(ownPr('own-pr-open', { ciFailing: true })), tab: 'needs', filters: ['up-next', 'my-prs'] },
  { name: 'your PR, approved', item: item(ownPr('own-pr-approved')), tab: 'needs', filters: ['up-next', 'my-prs'] },
  { name: 'your PR, conflicts', item: item(ownPr('own-pr-conflicting')), tab: 'needs', filters: ['up-next', 'my-prs'] },
  { name: 'your PR, Junior paused on you', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), ...handed('needs-you') }), tab: 'needs', filters: ['my-prs'] },
  { name: 'a Slack reply pending', item: item({ kind: 'slack-reply-pending', source: 'slack', reason: 'asked', ask: 'reply', peopleWaiting: 1, group: 'blocking' }), tab: 'needs', filters: ['up-next'] },
  { name: 'a message asks you a question', item: item({ kind: 'mention' }), ctx: { message: 'question' }, tab: 'needs', filters: ['up-next'] },
  { name: 'a session finished', item: item(manual, { session: { running: false, waiting: false, error: false, at: T0 } }), tab: 'needs', filters: ['up-next'] },
  { name: 'your own to-do', item: item(manual), tab: 'needs', filters: ['up-next'] },
  { name: 'a mention', item: item({ kind: 'mention' }), tab: 'needs', filters: ['up-next'] },
  { name: 'a digest', item: item({ kind: 'digest', source: 'job', reason: 'found' }), tab: 'needs', filters: [] },
  { name: 'you paused Junior', item: item({ ...manual, handoff: 'paused', junior: junior('paused') }), tab: 'needs', filters: ['up-next'] },

  // With Junior
  { name: 'Junior runs a task', item: item({ ...manual, ...handed('working') }), tab: 'with', filters: ['up-next'] },
  { name: 'Junior fixes red CI on your PR', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), ...handed('watching') }), tab: 'with', filters: ['up-next', 'my-prs'] },
  { name: 'your PR conflicts, handed off', item: item({ ...ownPr('own-pr-conflicting'), ...handed('watching') }), tab: 'with', filters: ['up-next', 'my-prs'] },
  { name: 'review request handed off, before the first pass', item: item({ ...reviewReq, ...handed('watching') }), tab: 'with', filters: ['up-next', 'reviews'] },
  { name: 'a dispatched session runs', item: item(manual, { session: { running: true, waiting: false, error: false, at: T0 } }), tab: 'with', filters: ['up-next'] },
  { name: 'you said Junior has it', item: item(manual, { override: { turn: 'ai', at: T0 } }), tab: 'with', filters: ['up-next'] },
  { name: 'handed off, not picked up yet', item: item({ ...manual, handoff: 'on' }), tab: 'with', filters: ['up-next'] },

  // Waiting
  { name: 'your PR waits on review', item: item(ownPr('own-pr-open')), tab: 'waiting', filters: ['up-next', 'my-prs'] },
  { name: 'your PR, stale', item: item(ownPr('own-pr-stale')), tab: 'waiting', filters: ['up-next', 'my-prs'] },
  { name: 'your PR, red only where main is red too', item: item({ ...ownPr('own-pr-open', { ciFailing: true, seen: { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false, mainRed: [{ check: 'lint', url: null, sha: null, at: null }] } }), ...handed('watching') }), tab: 'waiting', filters: ['up-next', 'my-prs'] },
  { name: 'Junior posted its review', item: item({ ...reviewReq, ...handed('watching'), tasks: review('posted') }), tab: 'waiting', filters: ['up-next', 'reviews'] },
  { name: 'you said it waits on Niraj', item: item(manual, { override: { turn: 'others', note: 'Niraj', at: T0 } }), tab: 'waiting', filters: ['up-next'] },
  { name: 'you follow up on someone', item: item({ kind: 'job-hit', source: 'job', reason: 'found', ask: 'follow-up' }), tab: 'waiting', filters: ['up-next'] },
  { name: 'a team waits on the world', item: item(manual, { team: { state: 'waiting', at: T0 } }), tab: 'waiting', filters: ['up-next'] },
]

test('every fixture lands in exactly one of the three tabs, with its filters', () => {
  for (const r of ROWS) {
    const got = tabOf(r.item, r.ctx)
    assert.equal(got.tab, r.tab, r.name)
    assert.ok(TURN_TABS.includes(got.tab), r.name)
    assert.deepEqual(filtersOf(r.item), r.filters, r.name)
  }
  // the table reaches every tab and every filter
  for (const t of TURN_TABS) assert.ok(ROWS.some((r) => r.tab === t), `no fixture for ${t}`)
  for (const f of TURN_FILTERS) assert.ok(ROWS.some((r) => r.filters.includes(f)), `no fixture for ${f}`)
})

test('turnTabs puts each item in exactly one tab, so the counts add up', () => {
  const ctx = new Map(ROWS.map((r) => [r.item.id, r.ctx]))
  const got = turnTabs(ROWS.map((r) => r.item), (i) => ctx.get(i.id))
  const all = TURN_TABS.flatMap((t) => got.tabs[t].map((i) => i.id))
  assert.equal(all.length, ROWS.length)
  assert.equal(new Set(all).size, ROWS.length)
  for (const r of ROWS) assert.ok(got.tabs[r.tab].some((i) => i.id === r.item.id), r.name)
  for (const t of TURN_TABS) assert.equal(got.counts[t], got.tabs[t].length)
  assert.equal(got.needsCount, got.counts.needs)
})

test('Reviews and My PRs keep their filter inside the tab they land in, and match today\'s tabs', () => {
  const items = ROWS.map((r) => r.item)
  const ctx = new Map(ROWS.map((r) => [r.item.id, r.ctx]))
  const got = turnTabs(items, (i) => ctx.get(i.id))
  const pairs: [TurnFilter, LedgerTab][] = [['reviews', 'reviews'], ['my-prs', 'prs'], ['up-next', 'up']]
  for (const [filter, ledger] of pairs) {
    const acrossTabs = TURN_TABS.flatMap((t) => filterRows(got.tabs[t], filter).map((i) => i.id)).sort()
    const today = ledgerRows(items, ledger).map((i) => i.id).sort()
    assert.deepEqual(acrossTabs, today, filter)
  }
  // a review and a PR land in more than one tab, and keep the filter in each
  for (const f of ['reviews', 'my-prs'] as const) {
    const tabs = new Set(ROWS.filter((r) => r.filters.includes(f)).map((r) => r.tab))
    assert.ok(tabs.size >= 2, `${f} spans only ${[...tabs].join(', ')}`)
  }
  assert.equal(filterRows(got.tabs.needs, null).length, got.tabs.needs.length)
})

test('an item marked not useful stays in Needs you, sorts last and leaves the count', () => {
  const quiet = item({ ...manual, score: 99, updatedAt: '2026-10-22T09:00:00Z' })
  const marked = { ...quiet, notUseful: quietKey(quiet) }
  const loud = item({ ...manual, score: 1 })
  const got = turnTabs([marked, loud])
  assert.deepEqual(got.tabs.needs.map((i) => i.id), [loud.id, marked.id])
  assert.equal(got.counts.needs, 2)
  assert.equal(got.needsCount, 1)
  // something new on it: it counts again
  const newer = { ...marked, updatedAt: '2026-10-22T10:00:00Z' }
  assert.equal(turnTabs([newer, loud]).needsCount, 2)
})

test('within a tab, rows read highest score first', () => {
  const a = item({ ...manual, score: 3 })
  const b = item({ ...manual, score: 7 })
  const c = item(ownPr('own-pr-open', { score: 1 }))
  const d = item(ownPr('own-pr-stale', { score: 5 }))
  const got = turnTabs([a, b, c, d])
  assert.deepEqual(got.tabs.needs.map((i) => i.id), [b.id, a.id])
  assert.deepEqual(got.tabs.waiting.map((i) => i.id), [d.id, c.id])
  assert.deepEqual(got.tabs.with, [])
})

test('the labels are unchanged from today\'s tabs', () => {
  assert.deepEqual(TURN_TAB_TITLE, { needs: 'Needs you', with: 'With Junior', waiting: 'Waiting' })
  assert.deepEqual(TURN_FILTER_TITLE, { 'up-next': 'Up next', reviews: 'Reviews', 'my-prs': 'My PRs' })
})

test('every old ledger tab still resolves to a tab, and a filter where it became one', () => {
  for (const [old, route] of Object.entries(LEDGER_TAB_ROUTE)) {
    assert.ok(TURN_TABS.includes(route.tab), old)
    if (route.filter) assert.ok(TURN_FILTERS.includes(route.filter), old)
  }
  for (const t of TURN_TABS) assert.deepEqual(LEDGER_TAB_ROUTE[t], { tab: t })
})

test('tabOf is pure: same input, same answer, input untouched', () => {
  for (const r of ROWS) {
    const before = JSON.stringify(r.item)
    assert.deepEqual(tabOf(r.item, r.ctx), tabOf(r.item, r.ctx), r.name)
    assert.equal(JSON.stringify(r.item), before, r.name)
  }
})
