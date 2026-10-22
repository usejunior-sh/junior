/**
 * Hand-offs, Phase 1 (core/work/handoff.ts, core/junior/suggest.ts,
 * core/work/snooze.ts): the runner's gate, where an item stands with Junior,
 * what gets suggested and why, the snooze times, and the store keeping the
 * hand-off through ingestion and waking a snooze when the item changes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { babysitLine, bySuggestion, suggestionFor, type SuggestInput } from '../core/junior/suggest.js'
import { sectionOf } from '../core/junior/sections.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { handedOff, heldBy, juniorWork, legacyHandoffs, openedPr, PAUSED_ERROR, prItemIn, watchOf } from '../core/work/handoff.js'
import { snoozeClock, snoozeUntil } from '../core/work/snooze.js'
import { shouldReopen } from '../core/work/state.js'
import type { ItemTask } from '../core/work/tasks.js'
import type { WorkItem } from '../core/work/types.js'

type T = Pick<ItemTask, 'owner' | 'state' | 'step' | 'createdAt' | 'output'>
const task = (step: string, state: ItemTask['state'], over: Partial<T> = {}): T => ({ owner: 'junior', state, step, createdAt: 1, ...over })

test('the gate: a watch task runs only on a PR you handed off; nothing runs on a paused item', () => {
  assert.equal(heldBy('fix-ci', undefined), 'not handed off')
  assert.equal(heldBy('review', undefined), 'not handed off')
  assert.equal(heldBy('fix-ci', 'on'), null)
  assert.equal(heldBy('rebase', 'paused'), PAUSED_ERROR)
  // a playbook you started is a hand-off in itself; a pause still holds it
  assert.equal(heldBy('debug-plan', undefined), null)
  assert.equal(heldBy('debug-fix', 'paused'), PAUSED_ERROR)
})

test('the watch switches: a task from a watch waits on its switch; one you asked for never does', () => {
  assert.equal(watchOf({ step: 'fix-ci', why: 'event' }), 'babysit')
  assert.equal(watchOf({ step: 'rebase', why: 'event' }), 'babysit')
  assert.equal(watchOf({ step: 'fix-thread', why: 'event' }), 'babysit')
  assert.equal(watchOf({ step: 'review', why: 'playbook' }), 'review')
  // a retry or a resume is you asking: no switch holds it
  assert.equal(watchOf({ step: 'fix-ci', why: 'you' }), null)
  // posting a review you approved, a playbook step, a task with no step
  assert.equal(watchOf({ step: 'post-review', why: 'event' }), null)
  assert.equal(watchOf({ step: 'debug-plan', why: 'playbook' }), null)
  assert.equal(watchOf({ why: 'junior' }), null)
})

test('handed off: you said so, or Junior has a task of its own still open', () => {
  assert.equal(handedOff(undefined, []), false)
  assert.equal(handedOff(undefined, [task('fix-ci', 'done')]), false)
  assert.equal(handedOff(undefined, [task('fix-ci', 'queued')]), true)
  assert.equal(handedOff(undefined, [task('request-review', 'waiting', { owner: 'you' })]), false)
  assert.equal(handedOff('paused', []), true)
})

test('where it stands: paused, needs you, working, watching, handed in', () => {
  assert.equal(juniorWork(undefined, [], true), null)
  assert.equal(juniorWork('paused', [task('fix-ci', 'stopped')], true)?.stage, 'paused')
  assert.equal(juniorWork('on', [task('fix-ci', 'running')], true)?.stage, 'working')
  assert.equal(juniorWork('on', [task('request-review', 'waiting', { owner: 'you' })], true)?.stage, 'needs-you')
  assert.equal(juniorWork('on', [task('fix-ci', 'done')], true)?.stage, 'watching')
  assert.equal(juniorWork('on', [task('investigate', 'done')], false)?.stage, 'handed-in')
  // a failure after the last thing Junior finished is a question for you; an older one isn't
  assert.equal(juniorWork('on', [task('fix-ci', 'failed', { createdAt: 5 }), task('rebase', 'done', { createdAt: 3 })], true)?.stage, 'needs-you')
  assert.equal(juniorWork('on', [task('fix-ci', 'failed', { createdAt: 2 }), task('rebase', 'done', { createdAt: 3 })], true)?.stage, 'watching')
})

test('the debug-fix pipeline: plan → approve → work → draft PR → babysit', () => {
  const at = (ts: T[], prHanded = false) => juniorWork('on', ts, false, prHanded)?.pipeline
  assert.deepEqual(at([task('debug-plan', 'running')]), { done: 0, at: 'junior' })
  assert.deepEqual(at([task('debug-plan', 'done'), task('approve-plan', 'waiting', { owner: 'you' })]), { done: 1, at: 'you' })
  assert.deepEqual(at([task('debug-plan', 'done'), task('approve-plan', 'done', { owner: 'you' }), task('debug-fix', 'running')]), { done: 2, at: 'junior' })
  const url = 'Opened https://github.com/acme/web/pull/3318 as a draft'
  const fixed = [task('debug-plan', 'done'), task('approve-plan', 'done', { owner: 'you' }), task('debug-fix', 'done', { output: { summary: url } })]
  assert.deepEqual(at(fixed), { done: 3, at: 'you' })
  // the PR waits on your call to babysit it
  assert.equal(juniorWork('on', fixed, false)?.stage, 'needs-you')
  assert.deepEqual(at(fixed, true), { done: 5, at: null })
  assert.equal(juniorWork('on', fixed, false, true)?.stage, 'handed-in')
  assert.equal(openedPr(fixed), 'github:acme/web#3318')
  assert.equal(juniorWork('on', fixed, false)?.pr, 'github:acme/web#3318')
  assert.equal(prItemIn('no link here'), null)
  // not a debug-fix: no pipeline
  assert.equal(at([task('investigate', 'running')]), undefined)
})

test('the switch-over keeps handed off only what Junior was already working', () => {
  const tasks = new Map<string, Pick<ItemTask, 'owner' | 'step'>[]>([
    ['pr-worked', [{ owner: 'junior', step: 'fix-ci' }]],
    ['pr-mine-only', [{ owner: 'you', step: 'request-review' }]],
    ['rev-passed', [{ owner: 'junior', step: 'review' }]],
  ])
  const items = [
    { id: 'pr-worked', reason: 'your-pr' },
    { id: 'pr-mine-only', reason: 'your-pr' },
    { id: 'pr-untouched', reason: 'your-pr' },
    { id: 'rev-passed', reason: 'review-requested' },
    { id: 'pr-paused', reason: 'your-pr', handoff: 'paused' as const },
  ]
  assert.deepEqual(legacyHandoffs(items, tasks, { babysit: true, reviews: true }), ['pr-worked', 'rev-passed'])
  assert.deepEqual(legacyHandoffs(items, tasks, { babysit: true, reviews: false }), ['pr-worked'])
  assert.deepEqual(legacyHandoffs(items, tasks, { babysit: false, reviews: false }), [])
})

const seen = (over = {}) => ({ red: [] as string[], bots: 0, people: 0, rebase: null, draft: false, ...over })
const input = (over: Omit<Partial<SuggestInput>, 'item'> & { item?: Partial<SuggestInput['item']> } = {}): SuggestInput => ({
  juniorBusy: false,
  reviewed: false,
  juniorPr: false,
  rule: null,
  ...over,
  item: { reason: 'your-pr', kind: 'own-pr-open', updatedAt: '2026-10-22T09:00:00Z', peopleWaiting: 0, ...over.item },
})

test('your PR is suggested when there is something to fix, and says what', () => {
  assert.equal(babysitLine(seen({ red: ['lint', 'unit'], bots: 2 })), 'Fix lint, unit and answer 2 bot comments.')
  assert.equal(babysitLine(seen({ rebase: 'conflict' })), 'Resolve the conflict.')
  assert.equal(babysitLine(seen()), null)
  const s = suggestionFor(input({ seen: seen({ red: ['lint'] }) }))
  assert.deepEqual(s, { playbook: 'babysit', head: 'I’d babysit it', would: 'Fix lint.', tier: 2 })
  // green with nothing to do, a draft you opened, handed off, or Junior on it: no
  assert.equal(suggestionFor(input({ seen: seen() })), null)
  assert.equal(suggestionFor(input({ seen: seen({ red: ['lint'], draft: true }) })), null)
  assert.equal(suggestionFor(input({ seen: seen({ red: ['lint'] }), item: { handoff: 'paused' } })), null)
  assert.equal(suggestionFor(input({ seen: seen({ red: ['lint'] }), juniorBusy: true })), null)
  // before the watch has read it: what the item says
  assert.equal(suggestionFor(input({ item: { ciFailing: true } }))?.would, 'Fix the red checks.')
  // Junior's own draft: babysit it, even green
  assert.equal(suggestionFor(input({ seen: seen({ draft: true }), juniorPr: true }))?.tier, 3)
})

test('"not this one" holds until the item changes', () => {
  const red = { seen: seen({ red: ['lint'] }) }
  assert.equal(suggestionFor(input({ ...red, item: { notNow: '2026-10-22T09:00:00Z' } })), null)
  assert.ok(suggestionFor(input({ ...red, item: { notNow: '2026-10-21T09:00:00Z' } })))
})

test('a review request is suggested until a first pass exists; other items follow their rule', () => {
  const rev = input({ item: { reason: 'review-requested', kind: 'review-requested' } })
  assert.deepEqual(suggestionFor(rev), { playbook: 'review', head: 'I’d do a first pass', would: 'Read the diff, run it, draft notes for you.', tier: 1 })
  assert.equal(suggestionFor({ ...rev, reviewed: true }), null)
  const bug = input({ item: { reason: 'assigned', kind: 'ticket-assigned' }, rule: { playbook: 'debug-fix', start: 'suggest' } })
  assert.deepEqual([suggestionFor(bug)?.playbook, suggestionFor(bug)?.tier], ['debug-fix', 4])
  const asked = input({ item: { reason: 'asked', kind: 'slack-reply-pending', peopleWaiting: 1 }, rule: { playbook: 'answer', start: 'suggest' } })
  assert.equal(suggestionFor(asked)?.tier, 1)
  // an FYI rule, or no rule: nothing
  assert.equal(suggestionFor(input({ item: { reason: 'mentioned', kind: 'mention' }, rule: { playbook: null, start: 'suggest' } })), null)
  assert.equal(suggestionFor(input({ item: { reason: 'found', kind: 'job-hit' } })), null)
})

test('the order: people waiting, red PRs, Junior’s drafts, the rest; score within', () => {
  const rows = [
    { id: 'rule', score: 90, suggestion: { tier: 4 as const } },
    { id: 'red', score: 50, suggestion: { tier: 2 as const } },
    { id: 'ask-low', score: 10, suggestion: { tier: 1 as const } },
    { id: 'ask-high', score: 70, suggestion: { tier: 1 as const } },
  ]
  assert.deepEqual(rows.sort(bySuggestion).map((r) => r.id), ['ask-high', 'ask-low', 'red', 'rule'])
})

test('snooze times: hours exact, days at 9:00 that morning', () => {
  const now = new Date(2026, 9, 21, 10, 12).getTime() // Wed 21 Oct, 10:12 local
  assert.equal(snoozeUntil('1h', now), now + 3_600_000)
  assert.equal(snoozeUntil('4h', now), now + 4 * 3_600_000)
  assert.equal(snoozeUntil('1d', now), new Date(2026, 9, 22, 9, 0).getTime())
  assert.equal(snoozeUntil('3d', now), new Date(2026, 9, 24, 9, 0).getTime())
  assert.equal(snoozeClock(snoozeUntil('4h', now), now), '14:12')
  assert.equal(snoozeClock(snoozeUntil('1d', now), now), 'Thu 9:00')
})

test('a snooze ends early when the source changes; archived never reopens', () => {
  assert.equal(shouldReopen('snoozed', 200, 100), true)
  assert.equal(shouldReopen('snoozed', 50, 100), false)
  assert.equal(shouldReopen('archived', 200, 100), false)
})

test('the store keeps a hand-off through ingestion, and wakes a snoozed item that changed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-handoff-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    const item: WorkItem = {
      id: 'github:acme/api#9', source: 'github', kind: 'own-pr-open', title: 'PR 9', url: 'https://github.com/acme/api/pull/9',
      repo: 'acme/api', author: 'samar', peopleWaiting: 0, createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T11:00:00Z',
    }
    await store.items.upsert(item)
    await store.items.setFields(item.id, { handoff: 'on', notNow: item.updatedAt })
    await store.items.upsert({ ...item, title: 'PR 9, renamed', updatedAt: '2026-10-21T12:00:00Z' })
    const got = await store.items.get(item.id)
    assert.deepEqual([got?.title, got?.handoff, got?.notNow], ['PR 9, renamed', 'on', '2026-10-21T11:00:00Z'])
    await store.items.setFields(item.id, { handoff: null, notNow: null })
    assert.equal((await store.items.get(item.id))?.handoff, undefined)

    await store.items.transition(item.id, { status: 'snoozed', actor: 'user', snoozeUntil: Date.now() + 86_400_000 })
    // nothing newer: still snoozed
    await store.items.upsert({ ...item, updatedAt: '2026-10-21T12:00:00Z' })
    assert.equal((await store.items.get(item.id))?.status, 'snoozed')
    // a comment lands after the snooze: back in the inbox
    await store.items.upsert({ ...item, updatedAt: new Date(Date.now() + 60_000).toISOString() })
    const back = await store.items.get(item.id)
    assert.deepEqual([back?.status, back?.returned], ['open', true])
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the Junior page tab an item sits on: one per reason; a to-do waits in the inbox until started', () => {
  assert.equal(sectionOf({ reason: 'your-pr' }), 'prs')
  assert.equal(sectionOf({ reason: 'review-requested' }), 'reviews')
  assert.equal(sectionOf({ reason: 'asked' }), 'people')
  assert.equal(sectionOf({ reason: 'mentioned' }), 'fyi')
  assert.equal(sectionOf({ reason: 'assigned' }), 'work')
  assert.equal(sectionOf({ reason: 'you-added' }), null)
  assert.equal(sectionOf({ reason: 'found', handoff: 'on' }), 'work')
  assert.equal(sectionOf({ reason: 'you-added', flow: { stage: 'working', turn: 'me' } as never }), 'work')
})
