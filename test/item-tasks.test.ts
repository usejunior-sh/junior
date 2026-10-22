/**
 * Tasks on items and the item's own fields (reason · label · parent ·
 * playbook · memory), against a real sqlite store in a temp dir, plus the
 * pure rules in core/work/tasks.ts and fields.ts. Time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { WorkItem } from '../core/work/types.js'
import { memoryBlock, reasonOf } from '../core/work/fields.js'
import { canMove, progressLine, reviewState, taskSummary, type ItemTask } from '../core/work/tasks.js'
import { scoreItem } from '../core/work/score.js'

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-tasks-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    await fn(store)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const pr = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'github:acme/api#12',
  source: 'github',
  kind: 'own-pr-open',
  title: 'Add retries',
  url: 'https://github.com/acme/api/pull/12',
  repo: 'acme/api',
  author: 'samar',
  peopleWaiting: 0,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...over,
})

const T0 = 1_792_000_000_000

test('a task is added queued, and the same key on the same item adds nothing', () =>
  withStore(async ({ tasks }) => {
    const a = await tasks.add({ itemId: 'i1', title: 'Fix lint', owner: 'junior', why: 'event', whyDetail: 'CI red: lint', key: 'checks_failed@abc', step: 'fix-ci', input: { checks: ['lint'] } }, T0)
    assert.ok(a)
    assert.equal(a.state, 'queued')
    assert.equal(a.attempts, 0)
    assert.deepEqual(a.input, { checks: ['lint'] })
    assert.equal(await tasks.add({ itemId: 'i1', title: 'Fix lint again', owner: 'junior', why: 'event', key: 'checks_failed@abc' }, T0 + 1), null)
    // same key, other item: its own task; no key: never collides
    assert.ok(await tasks.add({ itemId: 'i2', title: 'Fix lint', owner: 'junior', why: 'event', key: 'checks_failed@abc' }, T0 + 2))
    assert.ok(await tasks.add({ itemId: 'i1', title: 'Look at the flaky test', owner: 'you', why: 'you' }, T0 + 3))
    assert.ok(await tasks.add({ itemId: 'i1', title: 'And this', owner: 'you', why: 'you' }, T0 + 4))
    assert.deepEqual((await tasks.list('i1')).map((t) => t.title), ['Fix lint', 'Look at the flaky test', 'And this'])
    assert.equal((await tasks.byKey('i1', 'checks_failed@abc'))?.id, a.id)
  }))

test('moves follow the rules: start stamps and counts, finish stamps, finished never moves', () =>
  withStore(async ({ tasks }) => {
    const t = (await tasks.add({ itemId: 'i1', title: 'Fix lint', owner: 'junior', why: 'event' }, T0))!
    const run = await tasks.move(t.id, 'running', { sessionId: 's1', model: 'opus' }, T0 + 10)
    assert.deepEqual([run?.state, run?.startedAt, run?.attempts, run?.sessionId, run?.model], ['running', T0 + 10, 1, 's1', 'opus'])
    await tasks.addCost(t.id, 0.4)
    await tasks.addCost(t.id, 0.35)
    const done = await tasks.move(t.id, 'done', { output: { summary: 'removed the unused import', sha: 'def' } }, T0 + 20)
    assert.equal(done?.endedAt, T0 + 20)
    assert.deepEqual(done?.output, { summary: 'removed the unused import', sha: 'def' })
    assert.ok(Math.abs((done?.costUsd ?? 0) - 0.75) < 1e-9)
    // a late result can't revive it
    assert.equal(await tasks.move(t.id, 'running', {}, T0 + 30), null)
    assert.equal((await tasks.get(t.id))?.state, 'done')
    assert.equal(await tasks.move('nope', 'done', {}, T0), null)
  }))

test('a stopped task stays stopped; queued can be skipped', () =>
  withStore(async ({ tasks }) => {
    const t = (await tasks.add({ itemId: 'i1', title: 'Rebase on main', owner: 'junior', why: 'event' }, T0))!
    await tasks.move(t.id, 'running', {}, T0 + 1)
    assert.ok(await tasks.move(t.id, 'stopped', { error: 'stopped by you' }, T0 + 2))
    assert.equal(await tasks.move(t.id, 'done', {}, T0 + 3), null)
    const u = (await tasks.add({ itemId: 'i1', title: 'Request Anirudha', owner: 'you', why: 'playbook', state: 'waiting' }, T0))!
    assert.equal(u.state, 'waiting')
    assert.equal((await tasks.move(u.id, 'skipped', {}, T0 + 4))?.state, 'skipped')
  }))

test('running tasks left by a stopped daemon go back to the queue', () =>
  withStore(async ({ tasks }) => {
    const a = (await tasks.add({ itemId: 'i1', title: 'Fix lint', owner: 'junior', why: 'event' }, T0))!
    const b = (await tasks.add({ itemId: 'i2', title: 'Fix tests', owner: 'junior', why: 'event' }, T0 + 1))!
    await tasks.move(a.id, 'running', {}, T0 + 2)
    assert.deepEqual(await tasks.requeueRunning(), [a.id])
    assert.deepEqual((await tasks.inState(['queued'])).map((t) => t.id), [a.id, b.id])
    assert.deepEqual(await tasks.inState([]), [])
  }))

test('fields and memory are the user’s: a rescan keeps them', () =>
  withStore(async ({ items }) => {
    await items.upsert(pr())
    await items.setFields('github:acme/api#12', { label: 'bug', playbook: 'babysit', parent: 'manual:epic' })
    await items.setPlan('github:acme/api#12', 'Keep it green; Anirudha reviews.')
    await items.addDecision('github:acme/api#12', { at: T0, by: 'junior', text: 'Lint fixes go in their own commit.' })
    await items.upsert(pr({ title: 'Add retries (v2)', updatedAt: '2026-10-21T10:00:00.000Z', ciFailing: true }))
    const it = (await items.get('github:acme/api#12'))!
    assert.equal(it.title, 'Add retries (v2)')
    assert.deepEqual([it.label, it.playbook, it.parent], ['bug', 'babysit', 'manual:epic'])
    assert.equal(it.memory?.plan, 'Keep it green; Anirudha reviews.')
    assert.deepEqual(it.memory?.decisions.map((d) => d.text), ['Lint fixes go in their own commit.'])
    // null clears, absent leaves alone; clearing the plan keeps the decisions
    await items.setFields('github:acme/api#12', { parent: null })
    await items.setPlan('github:acme/api#12', null)
    const after = (await items.get('github:acme/api#12'))!
    assert.equal(after.parent, undefined)
    assert.equal(after.label, 'bug')
    assert.equal(after.memory?.plan, undefined)
    assert.equal(after.memory?.decisions.length, 1)
    await assert.rejects(items.setFields('nope', { label: 'bug' }))
  }))

test('reason: stored wins, else the kind’s; scoring carries it', () => {
  assert.equal(reasonOf(pr()), 'your-pr')
  assert.equal(reasonOf(pr({ kind: 'own-pr-conflicting' })), 'your-pr')
  assert.equal(reasonOf(pr({ kind: 'review-requested' })), 'review-requested')
  assert.equal(reasonOf(pr({ kind: 'slack-reply-pending' })), 'asked')
  assert.equal(reasonOf(pr({ kind: 'manual' })), 'you-added')
  assert.equal(reasonOf(pr({ kind: 'job-hit' })), 'found')
  assert.equal(reasonOf(pr({ kind: 'job-hit', reason: 'assigned' })), 'assigned')
  assert.equal(scoreItem(pr(), T0).reason, 'your-pr')
})

const task = (title: string, state: ItemTask['state']): ItemTask => ({ id: title, itemId: 'i', title, owner: 'junior', state, why: 'event', attempts: 0, createdAt: 0 })

test('the row line: n of m, then what is happening', () => {
  assert.equal(progressLine([]), null)
  assert.equal(progressLine([task('Fix lint', 'done'), task('Fix Bugbot comment', 'running'), task('Request Anirudha', 'queued')]), '1 of 3 · fixing Bugbot comment')
  assert.equal(progressLine([task('Fix lint', 'done'), task('Request Anirudha', 'waiting')]), '1 of 2 · waiting on you: Request Anirudha')
  assert.equal(progressLine([task('Fix lint', 'failed')]), '0 of 1 · stuck: Fix lint')
  assert.equal(progressLine([task('Fix lint', 'done'), task('Rebase on main', 'queued')]), '1 of 2 · next: Rebase on main')
  assert.equal(progressLine([task('Fix lint', 'done'), task('Old', 'skipped')]), '1 of 1')
})

test('state rules', () => {
  assert.ok(canMove('queued', 'running'))
  assert.ok(canMove('running', 'queued'))
  assert.ok(!canMove('waiting', 'running'))
  assert.ok(!canMove('done', 'queued'))
})

test('memory reads as a prompt section, empty when there is nothing', () => {
  assert.equal(memoryBlock(undefined), '')
  assert.equal(memoryBlock({ decisions: [] }), '')
  const b = memoryBlock({ plan: 'Keep it green.', decisions: [{ at: Date.UTC(2026, 9, 21), by: 'you', text: 'No force-push.' }] })
  assert.match(b, /### Plan\nKeep it green\./)
  assert.match(b, /- 2026-10-21 \(you\): No force-push\./)
})

test('the summary: progress, what waits on you, the last thing done', () => {
  const t = (title: string, state: ItemTask['state'], createdAt: number, over: Partial<ItemTask> = {}): ItemTask => ({ ...task(title, state), id: title, createdAt, ...over })
  assert.equal(taskSummary([]), null)
  const s = taskSummary([
    t('Fix lint', 'failed', 1, { error: 'over budget' }),
    t('Fix lint', 'done', 2, { endedAt: 5, output: { summary: 'removed the unused import' } }),
    t('Request anirudha', 'waiting', 6, { owner: 'you', step: 'request-review' }),
  ])!
  assert.equal(s.lastDone, 'Fix lint ✓ · removed the unused import')
  assert.equal(s.needsYou, 1, 'a failure before the last done no longer needs you')
  assert.deepEqual(s.next, { id: 'Request anirudha', title: 'Request anirudha', owner: 'you', step: 'request-review' })
  assert.equal(s.line, '1 of 3 · waiting on you: Request anirudha')
  const busy = taskSummary([t('Fix lint', 'running', 1), t('Rebase on main', 'queued', 2)])!
  assert.deepEqual([busy.running, busy.queued, busy.needsYou], [true, 1, 0])
})

test('a review’s state: queued, reviewing, ready with its verdict, posted, read again', () => {
  const t = (id: string, state: ItemTask['state'], createdAt: number, over: Partial<ItemTask> = {}): ItemTask => ({ ...task(id, state), id, createdAt, ...over })
  const pass = (state: ItemTask['state'], over: Partial<ItemTask> = {}) => t('p1', state, 1, { step: 'review', ...over })
  const ready = { summary: 'Request changes · 2 comments · Never expires', verdict: 'request_changes' as const }
  assert.equal(reviewState([t('Fix lint', 'done', 1)]), null)
  assert.deepEqual(reviewState([pass('queued')]), { state: 'queued', verdict: null, line: null })
  assert.deepEqual(reviewState([pass('running')]), { state: 'reviewing', verdict: null, line: null })
  assert.deepEqual(reviewState([pass('failed')]), { state: 'failed', verdict: null, line: null })
  const post = (state: ItemTask['state'], over: Partial<ItemTask> = {}) => t('post', state, 2, { owner: 'you', step: 'post-review', key: 'post:p1', ...over })
  assert.deepEqual(reviewState([pass('done', { output: ready }), post('waiting')]), { state: 'ready', verdict: 'request_changes', line: ready.summary })
  assert.deepEqual(reviewState([pass('done', { output: ready }), post('done', { output: { summary: 'Posted: Comment · 1 comment', verdict: 'comment' } })]), { state: 'posted', verdict: 'comment', line: 'Posted: Comment · 1 comment' })
  assert.deepEqual(reviewState([pass('done', { output: ready }), post('skipped'), t('p2', 'queued', 3, { step: 'review' })]), { state: 'queued', verdict: 'request_changes', line: ready.summary })
  assert.equal(taskSummary([pass('done', { output: ready }), post('waiting')])!.review?.state, 'ready')
})
