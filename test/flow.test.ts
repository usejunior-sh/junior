/**
 * Stage and turn (core/work/flow.ts) and the Today view (core/work/today.ts).
 * Time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowOf, isStuck, type FlowSignals } from '../core/work/flow.js'
import { inTurnTab, todaySectionOf, todaySections, type TodayItem } from '../core/work/today.js'
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
// Today
// ---------------------------------------------------------------------------

function scored(over: Partial<WorkItem> = {}, signals?: FlowSignals, score = 50): TodayItem & { title: string } {
  const i = item(over)
  return { ...i, label: labelOf(i), score, flow: flowOf(i, signals) }
}

const startOfToday = new Date(2026, 9, 12).getTime()

test('each item lands in its highest section', () => {
  const due = scored({ id: 'manual:due', dueAt: startOfToday - DAY, dueSource: 'you' })
  const review = scored({ id: 'github:o/r#2', source: 'github', kind: 'review-requested', author: 'ani', dueAt: startOfToday, dueSource: 'explicit' })
  const asked = scored({ id: 'slack:c/1', source: 'slack', kind: 'slack-reply-pending', author: 'niraj' })
  const ready = scored({ id: 'manual:ready' }, { brief: { status: 'ready', at: NOW - HOUR } })
  const red = scored({ id: 'github:o/r#3', source: 'github', kind: 'own-pr-open', ciFailing: true })
  const fresh = scored({ id: 'manual:fresh', ingestedAt: NOW - HOUR, createdAt: iso(NOW - HOUR), updatedAt: iso(NOW - HOUR) })
  const old = scored({ id: 'manual:old' })
  const ai = scored({ id: 'manual:ai', ingestedAt: NOW - HOUR }, { brief: { status: 'running', at: NOW } })

  assert.equal(todaySectionOf(due, NOW), 'due')
  assert.equal(todaySectionOf(review, NOW), 'due') // due beats people waiting
  assert.equal(todaySectionOf(asked, NOW), 'waiting')
  assert.equal(todaySectionOf(ready, NOW), 'approval')
  assert.equal(todaySectionOf(red, NOW), 'broke')
  assert.equal(todaySectionOf(fresh, NOW), 'fresh')
  assert.equal(todaySectionOf(old, NOW), null) // my turn, but nothing new: My turn tab, not Today
  assert.equal(todaySectionOf(ai, NOW), null) // the AI has it

  const secs = todaySections([old, fresh, red, ready, asked, review, due, ai], NOW)
  assert.deepEqual([...secs.keys()], ['due', 'waiting', 'approval', 'broke', 'fresh'])
  assert.equal(secs.get('fresh')![0]!.badge, 'new')
})

test('a label default is a bucket, not a deadline', () => {
  // review's default due is "today", but nobody set a day: it is a person waiting, not overdue
  const r = scored({ id: 'github:o/r#4', source: 'github', kind: 'review-requested', author: 'ani' })
  assert.equal(todaySectionOf(r, NOW), 'waiting')
})

test('people waiting: oldest first', () => {
  const a = scored({ id: 'slack:c/a', source: 'slack', kind: 'slack-reply-pending', createdAt: iso(NOW - DAY) }, undefined, 90)
  const b = scored({ id: 'slack:c/b', source: 'slack', kind: 'slack-reply-pending', createdAt: iso(NOW - 3 * DAY) }, undefined, 10)
  assert.deepEqual(todaySections([a, b], NOW).get('waiting')!.map((e) => e.item.id), ['slack:c/b', 'slack:c/a'])
})

test('a wait on others shows up only once it is stuck, flagged for a nudge', () => {
  const waiting = scored({ id: 'github:o/r#5', source: 'github', kind: 'own-pr-open', updatedAt: iso(NOW - DAY) })
  const stuck = scored({ id: 'github:o/r#6', source: 'github', kind: 'own-pr-stale', updatedAt: iso(NOW - 4 * DAY) })
  assert.equal(todaySectionOf(waiting, NOW), null)
  const secs = todaySections([waiting, stuck], NOW)
  assert.equal(secs.get('broke')![0]!.item.id, 'github:o/r#6')
  assert.equal(secs.get('broke')![0]!.stuck, true)
})

test('updated: an older item with fresh activity', () => {
  const u = scored({ id: 'manual:u', updatedAt: iso(NOW - HOUR) })
  assert.equal(todaySections([u], NOW).get('fresh')![0]!.badge, 'updated')
})

test('turn tabs filter by turn', () => {
  const me = scored({ id: 'manual:me' })
  const ai = scored({ id: 'manual:ai' }, { brief: { status: 'running', at: NOW } })
  const others = scored({ id: 'github:o/r#7', source: 'github', kind: 'own-pr-open' })
  const all = [me, ai, others]
  assert.deepEqual(all.filter((i) => inTurnTab(i, 'mine')).map((i) => i.id), ['manual:me'])
  assert.deepEqual(all.filter((i) => inTurnTab(i, 'ai')).map((i) => i.id), ['manual:ai'])
  assert.deepEqual(all.filter((i) => inTurnTab(i, 'others')).map((i) => i.id), ['github:o/r#7'])
  assert.equal(all.filter((i) => inTurnTab(i, 'all')).length, 3)
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
