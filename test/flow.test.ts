/**
 * Stage and turn (core/work/flow.ts) and the inbox tabs (core/work/inbox-tabs.ts).
 * Time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowOf, isStuck, type FlowSignals } from '../core/work/flow.js'
import { OPEN_TABS, inboxTabOf, inboxTabs, type OpenTab, type TabItem } from '../core/work/inbox-tabs.js'
import { labelOf } from '../core/work/labels.js'
import type { WorkItem } from '../core/work/types.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = new Date(2026, 9, 12, 15).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'manual:1',
    source: 'manual',
    kind: 'manual',
    title: 't',
    url: '',
    repo: '',
    author: '',
    peopleWaiting: 0,
    createdAt: iso(NOW - 3 * DAY),
    updatedAt: iso(NOW - 3 * DAY),
    ingestedAt: NOW - 3 * DAY,
    status: 'open',
    ...over,
  }
}

const flow = (i: WorkItem, s?: FlowSignals) => {
  const f = flowOf(i, s)
  return `${f.stage}/${f.turn}${f.ask ? ` (${f.ask})` : ''}${f.broken ? ` !${f.broken}` : ''}`
}

test('the table: created → briefing → ready → working → review → done', () => {
  const i = item()
  assert.equal(flow(i), 'new/me')
  assert.equal(flow(i, { brief: { status: 'queued', at: NOW - 5 * 60_000 } }), 'briefing/ai')
  assert.equal(flow(i, { brief: { status: 'running', at: NOW - 60_000 } }), 'briefing/ai')
  assert.equal(flow(i, { brief: { status: 'ready', at: NOW - 60_000 } }), 'ready/me (read brief)')
  const brief = { status: 'ready' as const, at: NOW - HOUR }
  assert.equal(flow(i, { brief, session: { running: true, waiting: false, error: false, at: NOW } }), 'working/ai')
  assert.equal(flow(i, { brief, session: { running: false, waiting: false, error: false, at: NOW } }), 'review/me (review result)')
  assert.equal(flow({ ...i, status: 'done' }, { brief }), 'done/none')
  assert.equal(flow({ ...i, status: 'archived' }), 'done/none')
})

test('a session waiting on a permission prompt is my turn', () => {
  assert.equal(flow(item(), { session: { running: true, waiting: true, error: false, at: NOW } }), 'working/me (answer the session)')
})

test('a re-brief after a dispatch takes the item back to briefing', () => {
  const s: FlowSignals = {
    session: { running: false, waiting: false, error: false, at: NOW - HOUR },
    brief: { status: 'running', at: NOW },
  }
  assert.equal(flow(item(), s), 'briefing/ai')
})

test('failures are flagged, not hidden', () => {
  assert.equal(flow(item(), { brief: { status: 'failed', at: NOW } }), 'new/me !brief failed')
  assert.equal(flow(item(), { session: { running: false, waiting: false, error: true, at: NOW } }), 'review/me (review result) !session failed')
})

test('your own PRs read from GitHub: reviewers, approval, conflicts, red CI', () => {
  const pr = (kind: WorkItem['kind'], ciFailing = false) => item({ id: 'github:o/r#1', source: 'github', kind, ciFailing })
  assert.equal(flow(pr('own-pr-open')), 'review/others')
  assert.equal(flow(pr('own-pr-stale')), 'review/others')
  assert.equal(flow(pr('own-pr-approved')), 'review/me (merge)')
  assert.equal(flow(pr('own-pr-conflicting')), 'review/me (resolve conflicts)')
  assert.equal(flow(pr('own-pr-open', true)), 'review/me (fix CI) !CI failing')
  // red CI outranks "session finished, review the result"
  assert.equal(
    flow(pr('own-pr-open', true), { session: { running: false, waiting: false, error: false, at: NOW } }),
    'review/me (fix CI) !CI failing',
  )
})

test('a follow-up waits on someone else', () => {
  assert.equal(flow(item({ source: 'slack', kind: 'job-hit', ask: 'follow-up' })), 'new/others')
})

test('team runs: proposed, gate, running, paused, done', () => {
  const t = (state: NonNullable<FlowSignals['team']>['state']) => flow(item(), { team: { state, at: NOW } })
  assert.equal(t('proposed'), 'ready/me (approve the team)')
  assert.equal(t('gate'), 'working/me (approve the step)')
  assert.equal(t('running'), 'working/ai')
  assert.equal(t('paused'), 'working/me (resume the team) !team paused')
  assert.equal(t('done'), 'review/me (review result)')
  // a stopped run hands back to the session rules
  assert.equal(flow(item(), { team: { state: 'stopped', at: NOW } }), 'new/me')
})

test('an override holds until something newer happens to the item', () => {
  const override = { turn: 'others' as const, note: 'Niraj to confirm the copy', at: NOW - HOUR }
  const f = flowOf(item(), { override })
  assert.equal(f.turn, 'others')
  assert.equal(f.stage, 'new')
  assert.equal(f.overridden, true)
  assert.equal(f.note, 'Niraj to confirm the copy')
  assert.equal(f.since, override.at)
  // a brief that starts afterwards takes over
  assert.equal(flow(item(), { override, brief: { status: 'running', at: NOW } }), 'briefing/ai')
  // one that started before doesn't
  assert.equal(flowOf(item(), { override, brief: { status: 'ready', at: NOW - 2 * HOUR } }).turn, 'others')
  // done is done, whatever the override says
  assert.equal(flow(item({ status: 'done' }), { override }), 'done/none')
  // an override onto my turn names the ask for its stage
  assert.equal(flow(item(), { override: { stage: 'ready', turn: 'me', at: NOW } }), 'ready/me (dispatch)')
})

test('stuck: waiting on others for more than two days', () => {
  const f = flowOf(item({ source: 'slack', kind: 'job-hit', ask: 'follow-up', updatedAt: iso(NOW - 3 * DAY) }))
  assert.equal(isStuck(f, NOW), true)
  assert.equal(isStuck(flowOf(item({ source: 'slack', kind: 'job-hit', ask: 'follow-up', updatedAt: iso(NOW - DAY) })), NOW), false)
})

// ---------------------------------------------------------------------------
// The inbox tabs
// ---------------------------------------------------------------------------

function scored(over: Partial<WorkItem> = {}, signals?: FlowSignals, score = 50): TabItem & { title: string } {
  const i = item(over)
  return { ...i, label: labelOf(i), score, flow: flowOf(i, signals) }
}

const startOfToday = new Date(2026, 9, 12).getTime()
const running = { running: true, waiting: false, error: false, at: NOW }

test('the table: each item lands in the first tab that matches', () => {
  const cases: [string, TabItem, OpenTab][] = [
    ['a session on a prompt', scored({}, { session: { ...running, waiting: true } }), 'needs'],
    ['a team step to approve', scored({}, { team: { state: 'gate', at: NOW } }), 'needs'],
    ['an action to approve', scored({}, { actions: { pending: 1, at: NOW } }), 'needs'],
    ['red CI, even with reviewers', scored({ source: 'github', kind: 'own-pr-open', ciFailing: true }), 'needs'],
    ['a failed brief', scored({}, { brief: { status: 'failed', at: NOW } }), 'needs'],
    ['overdue, set by you', scored({ dueAt: startOfToday - DAY, dueSource: 'you' }), 'due'],
    ['a review due today beats people waiting', scored({ source: 'github', kind: 'review-requested', dueAt: startOfToday, dueSource: 'explicit' }), 'due'],
    ['a review request, no day set', scored({ source: 'github', kind: 'review-requested', author: 'ani' }), 'people'],
    ['a Slack reply', scored({ source: 'slack', kind: 'slack-reply-pending' }), 'people'],
    ['arrived an hour ago', scored({ ingestedAt: NOW - HOUR, createdAt: iso(NOW - HOUR) }), 'new'],
    ['a brief is ready', scored({}, { brief: { status: 'ready', at: NOW - HOUR } }), 'ready'],
    ['a team waits for approval', scored({}, { team: { state: 'proposed', at: NOW } }), 'ready'],
    ['briefing', scored({ ingestedAt: NOW - HOUR }, { brief: { status: 'running', at: NOW } }), 'ai'],
    ['a session running', scored({}, { session: running }), 'ai'],
    ['a session finished', scored({}, { session: { ...running, running: false } }), 'review'],
    ['your PR, approved', scored({ source: 'github', kind: 'own-pr-approved' }), 'review'],
    ['your PR, with reviewers', scored({ source: 'github', kind: 'own-pr-open' }), 'others'],
    ['set to others by you', scored({}, { override: { turn: 'others', at: NOW } }), 'others'],
    ['new, three days old', scored(), 'backlog'],
    ['a due day the AI holds stays in AI working', scored({ dueAt: startOfToday, dueSource: 'you' }, { session: running }), 'ai'],
  ]
  for (const [name, i, tab] of cases) assert.equal(inboxTabOf(i, NOW), tab, name)
})

test('a label default is a bucket, not a deadline', () => {
  // review's default due is "today", but nobody set a day: a person waiting, not overdue
  assert.equal(inboxTabOf(scored({ source: 'github', kind: 'review-requested' }), NOW), 'people')
})

test('blocked sessions: under their row, or a row of their own; counts add up', () => {
  const a = scored({ id: 'manual:a' })
  const b = { ...scored({ id: 'github:o/r#1', source: 'github', kind: 'own-pr-open' }), linked: [{ id: 'linear:K-1' }] }
  const sessions = [
    { id: 's1', itemId: 'manual:a', updatedAt: NOW - HOUR },
    { id: 's2', itemId: 'linear:K-1', updatedAt: NOW }, // folded into b's row
    { id: 's3', updatedAt: NOW }, // no item
    { id: 's4', itemId: 'manual:snoozed', updatedAt: NOW }, // its item isn't open
  ]
  const t = inboxTabs([a, b], sessions, NOW)
  assert.deepEqual(t.tabs.get('needs')!.map((e) => e.item.id), ['manual:a', 'github:o/r#1'])
  assert.deepEqual(t.sessionsByRow.get('github:o/r#1')!.map((s) => s.id), ['s2'])
  assert.deepEqual(t.orphans.map((s) => s.id), ['s3', 's4'])
  assert.equal(t.counts.needs, 4)
  assert.equal(OPEN_TABS.reduce((n, k) => n + t.tabs.get(k)!.length, 0), 2) // each row once
})

test('people waiting: oldest first; due: earliest first', () => {
  const a = scored({ id: 'slack:c/a', source: 'slack', kind: 'slack-reply-pending', createdAt: iso(NOW - DAY) }, undefined, 90)
  const b = scored({ id: 'slack:c/b', source: 'slack', kind: 'slack-reply-pending', createdAt: iso(NOW - 3 * DAY) }, undefined, 10)
  const d1 = scored({ id: 'manual:d1', dueAt: startOfToday, dueSource: 'you' }, undefined, 90)
  const d2 = scored({ id: 'manual:d2', dueAt: startOfToday - 2 * DAY, dueSource: 'you' }, undefined, 10)
  const t = inboxTabs([a, b, d1, d2], [], NOW)
  assert.deepEqual(t.tabs.get('people')!.map((e) => e.item.id), ['slack:c/b', 'slack:c/a'])
  assert.deepEqual(t.tabs.get('due')!.map((e) => e.item.id), ['manual:d2', 'manual:d1'])
})

test('badges: new, updated, and a stuck wait', () => {
  const fresh = scored({ id: 'manual:f', ingestedAt: NOW - HOUR, createdAt: iso(NOW - HOUR) })
  const updated = scored({ id: 'manual:u', updatedAt: iso(NOW - HOUR) })
  const stuck = scored({ id: 'github:o/r#6', source: 'github', kind: 'own-pr-stale', updatedAt: iso(NOW - 4 * DAY) })
  const t = inboxTabs([fresh, updated, stuck], [], NOW)
  assert.equal(t.tabs.get('new')![0]!.badge, 'new')
  assert.equal(t.tabs.get('backlog')![0]!.badge, 'updated')
  assert.equal(t.tabs.get('others')![0]!.stuck, true)
})

// ---------------------------------------------------------------------------
// The store: every move lands in the item's event log
// ---------------------------------------------------------------------------

test('recorded flows and overrides are logged on the item', async () => {
  const { openSqliteStore } = await import('../core/store/sqlite.js')
  const store = openSqliteStore(':memory:')
  try {
    const id = await store.items.createManual({ id: 'manual:flow', title: 'Ship it' })
    await store.items.recordFlow(id, { stage: 'new', turn: 'me' })
    await store.items.recordFlow(id, { stage: 'new', turn: 'me' }) // unchanged: nothing
    await store.items.recordFlow(id, { stage: 'briefing', turn: 'ai' })
    await store.items.setFlowOverride(id, { turn: 'others', note: 'Niraj', at: NOW }, 'user')
    await store.items.setFlowOverride(id, null, 'user')
    const events = (await store.items.events(id)).map((e) => e.event)
    // the first recording is a baseline, not a move
    assert.deepEqual(events, ['created', 'moved', 'flow-set', 'flow-set'])
    const moved = (await store.items.events(id))[1]!
    assert.deepEqual(moved.detail, { from: { stage: 'new', turn: 'me' }, to: { stage: 'briefing', turn: 'ai' } })
    const state = await store.items.flowState()
    assert.deepEqual(state.get(id), { stage: 'briefing', turn: 'ai', override: null })

    assert.equal(await store.items.countDoneSince(Date.now() - 1000), 0)
    await store.items.transition(id, { status: 'done', actor: 'user' })
    assert.equal(await store.items.countDoneSince(Date.now() - 1000), 1)
  } finally {
    await store.close()
  }
})

test('deleted: archived by a Delete, until archived again or reopened', async () => {
  const { openSqliteStore } = await import('../core/store/sqlite.js')
  const store = openSqliteStore(':memory:')
  try {
    const del = await store.items.createManual({ id: 'manual:del', title: 'Gone' })
    const arc = await store.items.createManual({ id: 'manual:arc', title: 'Parked' })
    await store.items.transition(del, { status: 'archived', actor: 'user', detail: { reason: 'deleted by user' } })
    await store.items.transition(arc, { status: 'archived', actor: 'user' })
    assert.deepEqual([...(await store.items.deletedIds())], ['manual:del'])
    // reopened and archived plainly: an archive, not a delete any more
    await store.items.transition(del, { status: 'open', actor: 'user' })
    assert.deepEqual([...(await store.items.deletedIds())], [])
    await store.items.transition(del, { status: 'archived', actor: 'user' })
    assert.deepEqual([...(await store.items.deletedIds())], [])
  } finally {
    await store.close()
  }
})
