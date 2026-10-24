/**
 * The Junior page's Ledger (core/junior/ledger.ts): which rows each pill tab
 * shows, in what order, and the one-word state Junior writes on each.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageHot, cantWatchOf, juniorState, readyOf, ledgerCount, ledgerProgress, ledgerRows, NOT_USEFUL_HOLD_MAX_MS, NOT_USEFUL_NOTICE_MS, NOT_USEFUL_UNDO_MS, personWaits, quieted, quietKey, watchOffOf } from '../core/junior/ledger.js'
import { capText, capsFrom, markWatchOn, turnOnTitle, usd, withAnswer } from '../core/junior/watch-off.js'
import type { HandoffReadiness, WorkStage } from '../core/work/handoff.js'
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

// ---------- a handed-off PR whose watch is off (handoff-readiness-ui) ----------

type Review = NonNullable<NonNullable<ScoredItem['tasks']>['review']>
const tasksWith = (state: Review['state']): ScoredItem['tasks'] => ({ line: null, running: false, queued: 0, needsYou: 0, next: null, lastDone: null, review: { state, verdict: null, line: null } })
const OFF_BABYSIT: HandoffReadiness = { state: 'watch-off', watch: 'babysit' }
const OFF_REVIEW: HandoffReadiness = { state: 'watch-off', watch: 'review' }
const READY: HandoffReadiness = { state: 'ready' }
const CANT: HandoffReadiness = { state: 'unsupported', why: 'Junior babysits GitHub PRs only' }
const myPr = (stage: WorkStage, readiness: HandoffReadiness | undefined, over: Partial<ScoredItem> = {}) =>
  item('pr', { kind: 'own-pr-open', reason: 'your-pr', handoff: 'on', junior: { stage, ...(readiness ? { readiness } : {}) }, ...over })
const reviewPr = (stage: WorkStage, readiness: HandoffReadiness | undefined, state?: Review['state']) =>
  item('rv', { kind: 'review-requested', reason: 'review-requested', handoff: 'on', junior: { stage, ...(readiness ? { readiness } : {}) }, ...(state ? { tasks: tasksWith(state) } : {}) })

test('watch off: the state column says so, never "Babysitting"; the right rows win over it', () => {
  const rows: [string, ScoredItem, string, boolean][] = [
    ['babysit off, watching', myPr('watching', OFF_BABYSIT), 'Babysitting off', true],
    ['babysit on, watching', myPr('watching', READY), 'Babysitting', true],
    ['no readiness yet (old snapshot)', myPr('watching', undefined), 'Babysitting', true],
    ['babysit off, you paused it', myPr('paused', OFF_BABYSIT, { handoff: 'paused' }), 'Paused', true],
    ['babysit off, needs you', myPr('needs-you', OFF_BABYSIT), 'Paused on you', false],
    ['babysit off, a task running', myPr('working', OFF_BABYSIT), 'Working', false],
    ['review off, nothing queued', reviewPr('watching', OFF_REVIEW), 'Reviews off', true],
    ['review off, a pass queued behind the switch', reviewPr('working', OFF_REVIEW, 'queued'), 'Reviews off', true],
    ['review off, reading now', reviewPr('working', OFF_REVIEW, 'reviewing'), 'Reading', false],
    ['review off, first pass ready', reviewPr('needs-you', OFF_REVIEW, 'ready'), 'Paused on you', false],
    ['review off, posted', reviewPr('handed-in', OFF_REVIEW, 'posted'), 'Posted', true],
    ['review off, failed', reviewPr('working', OFF_REVIEW, 'failed'), 'Stuck', false],
    ['review on, queued', reviewPr('working', READY, 'queued'), 'Queued', true],
    ['not from GitHub, babysit', myPr('watching', CANT, { source: 'manual' }), 'Can’t babysit', true],
    ['not from GitHub, review', reviewPr('watching', { state: 'unsupported', why: 'x' }), 'Can’t review', true],
  ]
  for (const [name, i, text, quiet] of rows) assert.deepEqual(juniorState(i), { text, quiet }, name)
})

test('watch off is never orange-worthy: a switched-off row waits on no one', () => {
  const i = myPr('watching', OFF_BABYSIT, { group: 'blocking' })
  assert.equal(juniorState(i).quiet, true)
  assert.deepEqual(ledgerRows([i], 'needs'), [])
})

test('watchOffOf and cantWatchOf: only a handed-off row, idle behind the switch', () => {
  assert.equal(watchOffOf(myPr('watching', OFF_BABYSIT)), 'babysit')
  assert.equal(watchOffOf(myPr('watching', OFF_BABYSIT, { handoff: undefined })), null)
  assert.equal(watchOffOf(myPr('watching', READY)), null)
  assert.equal(watchOffOf(reviewPr('working', OFF_REVIEW, 'queued')), 'review')
  assert.equal(watchOffOf(reviewPr('working', OFF_REVIEW, 'reviewing')), null)
  assert.equal(cantWatchOf(myPr('watching', CANT)), 'babysit')
  assert.equal(cantWatchOf(myPr('watching', OFF_BABYSIT)), null)
})

test('the cap and the Turn on title: dollars from the settings, or a pointer when unknown', () => {
  assert.equal(usd(20), '$20')
  assert.equal(usd(1.5), '$1.50')
  const caps = { perDayUsd: 20, perReviewUsd: 1 }
  assert.equal(capText('babysit', caps), 'Up to $20 a day')
  assert.equal(capText('review', caps), 'Up to $1 a review, $20 a day')
  assert.equal(capText('babysit', null), null)
  assert.equal(turnOnTitle('babysit', caps), 'Turns on babysitting for every PR you hand off. Up to $20 a day, set in Settings → Automations.')
  assert.equal(turnOnTitle('review', caps), 'Turns on first-pass reviews for every PR you hand off. Up to $1 a review, $20 a day.')
  assert.equal(turnOnTitle('babysit', null), 'Turns on babysitting for every PR you hand off. Limits are in Settings → Automations.')
  assert.ok(!turnOnTitle('review', null).includes('undefined'))
  assert.deepEqual(capsFrom({ ok: true, settings: { budget: { perTaskUsd: 3, perDayUsd: 20, perReviewUsd: 1 } } }), caps)
  assert.equal(capsFrom({ ok: false, error: 'nope' }), null)
  assert.equal(capsFrom({ ok: true, settings: { budget: { perDayUsd: 'x', perReviewUsd: 1 } } }), null)
  assert.equal(capsFrom(null), null)
})

test('the hand-off answer reads "off" before the refetch lands; the snapshot wins after', () => {
  const justHanded = item('pr', { kind: 'own-pr-open', reason: 'your-pr', handoff: 'on' })
  const a = withAnswer(justHanded, { pr: OFF_BABYSIT })
  assert.equal(juniorState(a).text, 'Babysitting off')
  assert.equal(withAnswer(justHanded, { pr: READY }), justHanded)
  assert.equal(withAnswer(justHanded, {}), justHanded)
  const settled = myPr('watching', READY)
  assert.equal(juniorState(withAnswer(settled, { pr: OFF_BABYSIT })).text, 'Babysitting')
  assert.equal(withAnswer({ ...justHanded, handoff: 'paused' as const }, { pr: OFF_BABYSIT }).junior, undefined)
})

test('turning a watch on clears "off" from its rows only', () => {
  const rows = [myPr('watching', OFF_BABYSIT), reviewPr('watching', OFF_REVIEW), fyi]
  const after = markWatchOn(rows, 'babysit')
  assert.deepEqual(after.map((i) => juniorState(i).text), ['Babysitting', 'Reviews off', ''])
  assert.equal(after[2], fyi)
  assert.equal(rows[0]!.junior!.readiness!.state, 'watch-off', 'the input is not mutated')
})

// ---------------------------------------------------------------------------
// "Not useful": off Needs you until something new happens on the item
// ---------------------------------------------------------------------------

const readyTasks = { line: null, running: false, queued: 0, needsYou: 0, next: null, lastDone: null, review: { state: 'ready' as const, verdict: null, line: null } }
const askTasks = (id: string) => ({ line: null, running: false, queued: 0, needsYou: 1, next: { id, title: 'Which branch?', owner: 'you' as const }, lastDone: null })

test('not useful: a quieted item leaves Needs you, reads in Up next, and drops the counts', () => {
  const ready = item('ready', { kind: 'review-requested', reason: 'review-requested', group: 'blocking', score: 100, peopleWaiting: 1, tasks: readyTasks })
  const marked = { ...ready, notUseful: quietKey(ready) }
  assert.equal(quieted(marked), true)
  assert.equal(quieted(ready), false, 'an unmarked item is unaffected')
  assert.deepEqual(ledgerRows([marked, paused, ticket], 'needs').map((i) => i.id), ['paused'])
  assert.deepEqual(ledgerRows([marked, paused, ticket], 'up').map((i) => i.id), ['ready', 'ticket'])
  assert.deepEqual(ledgerCount([marked, paused, ticket], 'needs'), { n: 1, hot: 1 })
  // moved, not hidden; nothing marked shows orange anywhere
  assert.equal(ledgerCount([marked, paused, ticket], 'up').hot, 0)
  assert.equal(ageHot(ready), true)
  assert.equal(ageHot(marked), false)
  const pausedMarked = { ...paused, notUseful: quietKey(paused) }
  assert.deepEqual(ledgerCount([pausedMarked], 'with'), { n: 1, hot: 0 })
  assert.deepEqual(ledgerCount([pausedMarked], 'needs'), { n: 0, hot: 0 })
})

test('not useful: the row comes back when a comment, commit or message lands (updatedAt moves)', () => {
  const asked = { ...paused, tasks: askTasks('t1') }
  const marked = { ...asked, notUseful: quietKey(asked) }
  assert.deepEqual(ledgerRows([marked], 'needs'), [])
  const commented = { ...marked, updatedAt: '2026-10-22T09:15:00Z' }
  assert.equal(quieted(commented), false)
  assert.deepEqual(ledgerRows([commented], 'needs').map((i) => i.id), ['paused'])
  assert.deepEqual(ledgerRows([commented], 'up'), [])
})

test('not useful: the row comes back when Junior waits on you for a different task', () => {
  const asked = { ...paused, tasks: askTasks('t1') }
  const marked = { ...asked, notUseful: quietKey(asked) }
  assert.equal(quieted({ ...marked, tasks: askTasks('t1') }), true)
  assert.equal(quieted({ ...marked, tasks: askTasks('t2') }), false)
  assert.deepEqual(ledgerRows([{ ...marked, tasks: askTasks('t2') }], 'needs').map((i) => i.id), ['paused'])
  // a first pass that became ready is new too
  const ready = item('r', { kind: 'review-requested', reason: 'review-requested', group: 'blocking', tasks: { ...readyTasks, review: { ...readyTasks.review, state: 'reviewing' as const } } })
  assert.equal(quieted({ ...ready, notUseful: quietKey(ready), tasks: readyTasks }), false)
})

test('not useful: an Undo on screen is always one the server takes', () => {
  // the notice shows 5 s untouched, and hover or focus never holds it past the cap
  assert.equal(NOT_USEFUL_NOTICE_MS, 5_000)
  assert.ok(NOT_USEFUL_HOLD_MAX_MS >= NOT_USEFUL_NOTICE_MS)
  // the cap ends well inside the server's window: slack for the round trip and a slow clock
  assert.ok(NOT_USEFUL_UNDO_MS - NOT_USEFUL_HOLD_MAX_MS >= 5_000)
})

// ---------- readiness on the row (ready-because-ui) ----------

const gate = (ready: boolean) =>
  ({
    ready,
    sha: 'abc1234',
    checks: [
      { id: 'ci', ok: true, label: 'CI green', evidence: '2 checks passed on abc1234.', url: 'https://github.com/acme/web/pull/1/checks' },
      { id: 'threads', ok: ready, label: ready ? '0 threads' : '1 thread open', evidence: ready ? 'No review threads.' : 'Open: priya on db.ts.', url: 'https://github.com/acme/web/pull/1' },
      { id: 'mergeable', ok: true, label: 'no conflicts', evidence: 'Merges cleanly into main.', url: 'https://github.com/acme/web/pull/1' },
      { id: 'behind', ok: true, label: 'up to date', evidence: 'Not behind main.', url: 'https://github.com/acme/web/pull/1' },
    ],
  }) as const
const seenWith = (ready: boolean) => ({ red: [], bots: 0, people: ready ? 0 : 1, rebase: null, draft: false, ready: gate(ready) }) as unknown as ScoredItem['seen']

test('readyOf: the gate on your own PR only, once the watch has read it', () => {
  const mine = item('pr', { kind: 'own-pr-open', reason: 'your-pr', seen: seenWith(true) })
  assert.equal(readyOf(mine)?.ready, true)
  assert.equal(readyOf({ ...mine, seen: undefined }), null)
  assert.equal(readyOf({ ...mine, reason: 'review-requested' }), null)
})

test('juniorState: a watched PR with a read gate carries it, with the full line for the row label', () => {
  const pr = item('pr', { kind: 'own-pr-open', reason: 'your-pr', handoff: 'on', junior: { stage: 'watching' } })
  const ready = juniorState({ ...pr, seen: seenWith(true) })
  assert.equal(ready.text, 'Ready because: CI green · 0 threads · no conflicts · up to date')
  assert.equal(ready.quiet, false)
  assert.equal(ready.ready?.ready, true)
  const left = juniorState({ ...pr, seen: seenWith(false) })
  assert.equal(left.text, 'Not ready: 1 thread open')
  assert.equal(left.quiet, true)
  // before the first read: the word it always said
  assert.deepEqual(juniorState(pr), { text: 'Babysitting', quiet: true })
  // paused, needs you and a first pass still win over the gate
  assert.deepEqual(juniorState({ ...pr, handoff: 'paused', seen: seenWith(true) }), { text: 'Paused', quiet: true })
  assert.deepEqual(juniorState({ ...pr, junior: { stage: 'needs-you' }, seen: seenWith(false) }), { text: 'Paused on you', quiet: false })
  assert.equal(juniorState({ ...pr, junior: { stage: 'working' }, seen: seenWith(true) }).ready, undefined)
  // not handed off: no pill, the suggestion's word
  assert.equal(juniorState({ ...pr, handoff: undefined, junior: undefined, seen: seenWith(true), suggestion: { playbook: 'babysit', head: '', would: '', tier: 2 } }).text, 'Can babysit')
})
