/**
 * Whose turn (core/work/turn.ts): one table pins every item shape to exactly
 * one turn and one reason, every reason has a row, and the "you" turn is
 * checked against what today's Needs you tab shows, with each difference
 * listed and explained.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TURN_REASONS, TURN_REASON_LIST, TURN_TAB_LABEL, WHOSE_TURNS, turnOf, type TurnContext, type TurnReason, type WhoseTurn } from '../core/work/turn.js'
import { flowOf, type FlowSignals } from '../core/work/flow.js'
import { onNeeds } from '../core/junior/ledger.js'
import type { JuniorWork } from '../core/work/handoff.js'
import type { TaskSummary } from '../core/work/tasks.js'
import type { ScoredItem } from '../core/work/types.js'

const T0 = Date.parse('2026-10-22T08:00:00Z')

function item(over: Partial<ScoredItem> = {}, signals?: FlowSignals): ScoredItem {
  const base = {
    id: 'github:acme/web#1',
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
const handed = (stage: JuniorWork['stage'], over: Partial<JuniorWork> = {}) => ({ handoff: 'on' as const, junior: junior(stage, { readiness: { state: 'ready' }, ...over }) })

type Row = { name: string; item: ScoredItem; ctx?: TurnContext; want: TurnReason }

const ROWS: Row[] = [
  // off the open list
  { name: 'snoozed', item: item({ status: 'snoozed' }), want: 'snoozed' },
  { name: 'done', item: item({ status: 'done' }), want: 'closed' },
  { name: 'archived, Junior was paused on you', item: item({ status: 'archived', ...handed('needs-you') }), want: 'closed' },

  // holds until you answer
  { name: 'a chat on a prompt', item: item(manual), ctx: { blocked: true }, want: 'session-blocked' },
  { name: 'sends held, from the action queue', item: item(manual), ctx: { heldSends: 2 }, want: 'held-send' },
  { name: 'sends held, read off the flow', item: item(manual, { actions: { pending: 1, at: T0 } }), want: 'held-send' },
  { name: 'Junior paused on you', item: item({ ...manual, ...handed('needs-you') }), want: 'junior-asks' },
  { name: 'first pass ready', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking', ...handed('watching'), tasks: review('ready') }), want: 'first-pass-ready' },
  { name: 'first pass ready, you paused Junior since', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', handoff: 'paused', junior: junior('paused'), tasks: review('ready') }), want: 'first-pass-ready' },
  { name: 'team gate', item: item(manual, { team: { state: 'gate', at: T0 } }), want: 'junior-asks' },
  { name: 'team proposed', item: item(manual, { team: { state: 'proposed', at: T0 } }), want: 'junior-asks' },
  { name: 'team on a budget pause', item: item(manual, { team: { state: 'paused', at: T0 } }), want: 'junior-asks' },
  { name: 'goal plan ready', item: item(manual, { goal: { state: 'plan_ready', at: T0 } }), want: 'junior-asks' },
  { name: 'a session asks, read off the flow', item: item(manual, { session: { running: true, waiting: true, error: false, at: T0 } }), want: 'junior-asks' },
  { name: 'a task you own waits', item: item({ ...manual, tasks: tasks({ needsYou: 1 }) }), want: 'task-on-you' },
  { name: 'a brief failed', item: item(manual, { brief: { status: 'failed', at: T0 } }), want: 'broken' },
  { name: 'a session failed', item: item(manual, { session: { running: false, waiting: false, error: true, at: T0 } }), want: 'broken' },

  // Junior is busy
  { name: 'Junior runs a task', item: item({ ...manual, ...handed('working') }), want: 'junior-task' },
  { name: 'Junior fixes red CI on your PR', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), ...handed('working') }), want: 'junior-task' },
  { name: 'a dispatched session runs', item: item(manual, { session: { running: true, waiting: false, error: false, at: T0 } }), want: 'junior-run' },
  { name: 'a brief is being written', item: item(manual, { brief: { status: 'running', at: T0 } }), want: 'junior-run' },
  { name: 'a team runs', item: item(manual, { team: { state: 'running', at: T0 } }), want: 'junior-run' },
  { name: 'you said Junior has it', item: item(manual, { override: { turn: 'ai', at: T0 } }), want: 'set-with-junior' },

  // you said someone else has it
  { name: 'you said it waits on Niraj', item: item(manual, { override: { turn: 'others', note: 'Niraj to confirm', at: T0 } }), want: 'set-waiting' },

  // your PR's own state
  { name: 'your PR, CI red, handed off', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), ...handed('watching') }), want: 'junior-fixing' },
  { name: 'your PR, CI red, not handed off', item: item(ownPr('own-pr-open', { ciFailing: true })), want: 'ci-red' },
  { name: 'your PR, CI red, babysit switched off', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), ...handed('watching', { readiness: { state: 'watch-off', watch: 'babysit' } }) }), want: 'ci-red' },
  { name: 'your PR, CI red, you paused Junior', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), handoff: 'paused', junior: junior('paused') }), want: 'ci-red' },
  { name: 'your PR, approved', item: item(ownPr('own-pr-approved')), want: 'merge' },
  { name: 'your PR, approved, handed off', item: item({ ...ownPr('own-pr-approved'), ...handed('watching') }), want: 'merge' },
  { name: 'your PR, conflicts', item: item(ownPr('own-pr-conflicting')), want: 'conflicts' },
  { name: 'your PR, conflicts, handed off', item: item({ ...ownPr('own-pr-conflicting'), ...handed('watching') }), want: 'junior-fixing' },

  // a run finished
  { name: 'a session finished', item: item(manual, { session: { running: false, waiting: false, error: false, at: T0 } }), want: 'result-ready' },
  { name: 'a brief is ready', item: item(manual, { brief: { status: 'ready', at: T0 } }), want: 'result-ready' },
  { name: 'a team is done', item: item(manual, { team: { state: 'done', at: T0, toAccept: true } }), want: 'result-ready' },

  // someone else has the next move
  { name: 'Junior posted its review', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, ...handed('watching'), tasks: review('posted') }), want: 'review-posted' },
  { name: 'your PR waits on review', item: item(ownPr('own-pr-open')), want: 'reviewers' },
  { name: 'your PR, stale', item: item(ownPr('own-pr-stale')), want: 'reviewers' },
  { name: 'your PR waits on review, handed off', item: item({ ...ownPr('own-pr-open'), ...handed('watching') }), want: 'reviewers' },
  { name: 'you follow up on someone', item: item({ kind: 'job-hit', source: 'job', reason: 'found', ask: 'follow-up' }), want: 'follow-up' },
  { name: 'a team waits on the world', item: item(manual, { team: { state: 'waiting', at: T0 } }), want: 'world' },
  { name: 'a goal waits on the world', item: item(manual, { goal: { state: 'waiting_world', at: T0 } }), want: 'world' },

  // Junior watches it
  { name: 'review request handed off, before the first pass', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking', ...handed('watching') }), want: 'junior-watching' },

  // a person asked you
  { name: 'review requested', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking' }), want: 'person-asks' },
  { name: 'review request, Junior set it aside', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking', ...handed('watching'), tasks: review('skipped') }), want: 'person-asks' },
  { name: 'review request, review watch off', item: item({ kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking', ...handed('watching', { readiness: { state: 'watch-off', watch: 'review' } }) }), want: 'person-asks' },
  { name: 'changes requested on your PR', item: item({ kind: 'reply-needed', reason: 'asked', ask: 'reply', peopleWaiting: 1, group: 'blocking' }), want: 'person-asks' },
  { name: 'a Slack reply pending', item: item({ kind: 'slack-reply-pending', source: 'slack', reason: 'asked', ask: 'reply', peopleWaiting: 1, group: 'blocking' }), want: 'person-asks' },
  { name: 'a job found a question for you', item: item({ kind: 'job-hit', source: 'job', reason: 'found', ask: 'reply' }), want: 'person-asks' },

  // handed to Junior, nothing under way
  { name: 'handed in, Junior finished', item: item({ ...manual, ...handed('handed-in'), tasks: tasks({ lastDone: 'Fix lint ✓' }) }), want: 'handed-in' },
  { name: 'handed off, not picked up yet', item: item({ ...manual, handoff: 'on' }), want: 'handed-in' },

  // left with you
  { name: 'you paused Junior', item: item({ ...manual, handoff: 'paused', junior: junior('paused') }), want: 'paused' },
  { name: 'you paused Junior, its task stopped', item: item({ ...manual, handoff: 'paused', junior: junior('paused'), tasks: tasks({ needsYou: 1 }) }), want: 'paused' },
  { name: 'a goal is paused', item: item(manual, { goal: { state: 'paused', at: T0 } }), want: 'paused' },
  { name: 'your own to-do', item: item(manual), want: 'yours' },
  { name: 'a mention', item: item({ kind: 'mention' }), want: 'yours' },
  { name: 'a ticket assigned to you', item: item({ kind: 'ticket-assigned', source: 'linear', reason: 'assigned', ask: 'do', group: 'cycle' }), want: 'yours' },
  { name: 'a to-do you wrote with people on it', item: item({ ...manual, peopleWaiting: 2 }), want: 'yours' },
  { name: 'no flow at all', item: { ...item(manual), flow: undefined } as ScoredItem, want: 'yours' },
  { name: 'you said nobody has it', item: item(manual, { override: { turn: 'none', at: T0 } }), want: 'yours' },
]

test('every fixture maps to exactly one turn, and the expected reason', () => {
  for (const r of ROWS) {
    const got = turnOf(r.item, r.ctx)
    assert.equal(got.reason, r.want, r.name)
    assert.ok(WHOSE_TURNS.includes(got.turn), r.name)
    assert.equal(got.turn, TURN_REASONS[got.reason].turn, `${r.name}: the reason implies the turn`)
  }
})

test('turnOf is pure: same input, same answer, input untouched', () => {
  for (const r of ROWS) {
    const before = JSON.stringify(r.item)
    assert.deepEqual(turnOf(r.item, r.ctx), turnOf(r.item, r.ctx), r.name)
    assert.equal(JSON.stringify(r.item), before, r.name)
  }
})

test('reason codes are a closed union: every one has a fixture row, and each belongs to one turn', () => {
  const seen = new Set(ROWS.map((r) => r.want))
  for (const reason of TURN_REASON_LIST) assert.ok(seen.has(reason), `no fixture for ${reason}`)
  assert.equal(seen.size, TURN_REASON_LIST.length)
  for (const reason of TURN_REASON_LIST) {
    const { turn, text } = TURN_REASONS[reason]
    assert.ok(WHOSE_TURNS.includes(turn), reason)
    // copy rule: short, no "AI", no "24/7"
    assert.ok(text.split(/\s+/).length <= 15 && !/\bAI\b|24\/7/.test(text), reason)
  }
  // every turn has at least one reason
  for (const t of WHOSE_TURNS) assert.ok(TURN_REASON_LIST.some((r) => TURN_REASONS[r].turn === t), t)
})

test('the turns keep the Junior page tab labels', () => {
  assert.deepEqual(TURN_TAB_LABEL, { you: 'Needs you', junior: 'With Junior', others: 'Waiting' })
})

test("flow.ts's turn reads straight across when nothing else is known", () => {
  const across: Record<string, WhoseTurn> = { me: 'you', ai: 'junior', others: 'others' }
  let checked = 0
  for (const r of ROWS) {
    if (r.ctx || r.item.junior || r.item.tasks || r.item.handoff || r.item.status !== 'open' || !r.item.flow) continue
    const want = across[r.item.flow.turn]
    if (!want) continue // none: a paused goal or an override to "Nobody", read by the rules
    assert.equal(turnOf(r.item, r.ctx).turn, want, r.name)
    checked++
  }
  assert.ok(checked >= 20, `only ${checked} rows read across`)
})

/**
 * Today's Needs you tab: item rows where Junior waits on you (ledger.ts
 * `onNeeds`), and above them, from needs.ts, a session held on a prompt and
 * sends waiting for your OK.
 */
const todayNeeds = (r: Row) => onNeeds(r.item) || !!r.ctx?.blocked || (r.ctx?.heldSends ?? 0) > 0

/**
 * Where turn "you" and today's Needs you disagree, and why. Each is on
 * purpose: Needs you today reads only Junior's hand-off state, while a turn
 * says who holds the ball whatever is holding it.
 */
const DIFFERENCES: Record<string, string> = {
  // closed items: the page gets open items only, so these never show today either
  'archived, Junior was paused on you': 'closed is nobody’s move; the page only lists open items',
  // flow-held asks: needs.ts shows the held session, gate or plan as its own line, not this item's row
  'sends held, read off the flow': 'needs.ts lists the held sends as their own line, not the item row',
  'team gate': 'needs.ts lists the gate as its own line, not the item row',
  'team proposed': 'needs.ts lists the plan as its own line, not the item row',
  'team on a budget pause': 'a budget pause waits on you; today no Needs you line shows it',
  'goal plan ready': 'a goal plan waits on you; needs.ts has no goal source yet',
  'a session asks, read off the flow': 'needs.ts lists the held session as its own line, not the item row',
  'a task you own waits': 'a task on you is yours; today Needs you reads only Junior’s hand-off state',
  'a brief failed': 'something broke and only you can restart it; today it sits in Up next',
  'a session failed': 'something broke and only you can restart it; today it sits in Up next',
  // your PR's own state
  'your PR, CI red, not handed off': 'nobody else will fix it; today it sits in Up next',
  'your PR, CI red, babysit switched off': 'Junior can’t run with the watch off; today it sits in Up next',
  'your PR, CI red, you paused Junior': 'you paused Junior, so the red CI is yours; today it sits in Up next',
  'your PR, approved': 'merging is yours; today it sits in Up next',
  'your PR, approved, handed off': 'merging is yours even when handed off; today it sits in With Junior',
  'your PR, conflicts': 'nobody else will fix it; today it sits in Up next',
  // a run finished
  'a session finished': 'a finished run waits for you to read it; today it sits in Up next',
  'a brief is ready': 'a ready brief waits for you to read it; today it sits in Up next',
  'a team is done': 'a done team waits for your accept; today it sits in Up next',
  // a person asked you
  'review requested': 'a person waits on you; today it sits in Up next under Someone is waiting',
  'review request, Junior set it aside': 'Junior set it aside, so the review is yours; today it sits in Up next',
  'review request, review watch off': 'Junior can’t review with the watch off; today it sits in Up next',
  'changes requested on your PR': 'a person waits on your reply; today it sits in Up next',
  'a Slack reply pending': 'a person waits on your reply; today it sits in Up next',
  'a job found a question for you': 'a person waits on your reply; today it sits in Up next',
  // left with you
  'you paused Junior': 'you paused Junior, so it’s yours; today it sits in With Junior',
  'you paused Junior, its task stopped': 'you paused Junior, so it’s yours; today it sits in With Junior',
  'a goal is paused': 'a paused goal moves only when you resume it; today it sits in Up next',
  'your own to-do': 'on your plate; today it sits in Up next',
  'a mention': 'on your plate; today it sits in Up next as FYI',
  'a ticket assigned to you': 'on your plate; today it sits in Up next',
  'a to-do you wrote with people on it': 'on your plate; today it sits in Up next',
  'no flow at all': 'on your plate; today it sits in Up next',
  'you said nobody has it': 'nobody else holds it, so it’s yours; today it sits in Up next',
}

test("turn 'you' matches today's Needs you, apart from the listed differences", () => {
  const names = new Set(ROWS.map((r) => r.name))
  for (const name of Object.keys(DIFFERENCES)) assert.ok(names.has(name), `stale difference: ${name}`)
  for (const r of ROWS) {
    const you = turnOf(r.item, r.ctx).turn === 'you'
    if (r.name in DIFFERENCES) assert.notEqual(you, todayNeeds(r), `listed as a difference but agrees: ${r.name}`)
    else assert.equal(you, todayNeeds(r), `unlisted difference: ${r.name}`)
  }
})

test('a quieted item is still your turn: "not useful" is attention, not turn', () => {
  const asks = item({ ...manual, ...handed('needs-you') })
  const quiet = { ...asks, notUseful: `${asks.updatedAt}|` }
  assert.equal(onNeeds(quiet), false)
  assert.deepEqual(turnOf(quiet), { turn: 'you', reason: 'junior-asks' })
})
