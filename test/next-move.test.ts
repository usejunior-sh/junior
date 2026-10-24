/**
 * Next move (core/work/next.ts): one table pins each rule to a row, rows that
 * match two rules show the first one wins, every line is verb first and 15
 * words or fewer, and the owner always agrees with whose turn it is.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_WORDS, NEXT_RULES, NEXT_VERBS, byTurnThenScore, nextMove, nextMoveLine, ownerLabel, wordCount, type NextAction, type NextContext, type NextOwner } from '../core/work/next.js'
import { turnOf } from '../core/work/turn.js'
import { flowOf, type FlowSignals } from '../core/work/flow.js'
import type { JuniorWork } from '../core/work/handoff.js'
import type { TaskSummary } from '../core/work/tasks.js'
import type { ItemKind, ScoredItem, WorkSource } from '../core/work/types.js'

const T0 = Date.parse('2026-10-22T08:00:00Z')
const NOW = T0 + 2 * 86_400_000 + 3 * 3_600_000 // 2d 3h later

function item(over: Partial<ScoredItem> = {}, signals?: FlowSignals): ScoredItem {
  const base = {
    id: 'github:acme/web#1',
    source: 'github',
    kind: 'mention',
    title: 't',
    url: '',
    repo: 'acme/web',
    author: 'Priya',
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
const handed = (stage: JuniorWork['stage'], over: Partial<JuniorWork> = {}) => ({ handoff: 'on' as const, junior: junior(stage, { readiness: { state: 'ready' }, ...over }) })

const manual = { source: 'manual', kind: 'manual', reason: 'you-added', ask: 'do', author: 'me' } as const
const ownPr = (kind: ItemKind, over: Partial<ScoredItem> = {}) => ({ kind, reason: 'your-pr' as const, ask: 'do' as const, author: 'me', ...over })
const reviewReq = { kind: 'review-requested', reason: 'review-requested', ask: 'review', peopleWaiting: 1, group: 'blocking' } as const
const slackReply = { source: 'slack', kind: 'slack-reply-pending', reason: 'mentioned', ask: 'reply', repo: '#release', peopleWaiting: 1 } as const

const you: NextOwner = { kind: 'you' }
const jr: NextOwner = { kind: 'junior' }
const person = (name: string | null): NextOwner => ({ kind: 'person', name })

type Row = { name: string; item: ScoredItem; ctx?: NextContext; want: NextAction; owner: NextOwner; text: string }

/**
 * One dedicated row per rule, in the rule order: the simplest item that
 * lands on it. FIRST_MATCH below holds the order itself.
 */
const RULE_ROWS: Row[] = [
  { name: 'decide: a chat waits on your answer', item: item(manual), ctx: { blocked: true }, want: 'decide', owner: you, text: "Answer Junior's chat · open 2d" },
  { name: 'reply: Priya waits in Slack, blocking a release', item: item(slackReply), ctx: { blocks: 'release-4.2' }, want: 'reply', owner: you, text: 'Answer Priya · waited 2d · blocks release-4.2' },
  { name: 'changes: requested on your PR', item: item(ownPr('reply-needed', { reason: 'your-pr', ask: 'reply' })), want: 'changes', owner: you, text: 'Address the requested changes · open 2d' },
  { name: 'conflict: your PR conflicts', item: item(ownPr('own-pr-conflicting')), want: 'conflict', owner: you, text: 'Resolve conflicts · open 2d' },
  { name: 'ci: your PR is red, nobody on it', item: item(ownPr('own-pr-open', { ciFailing: true })), want: 'ci', owner: you, text: 'Fix red CI · open 2d' },
  { name: 'review: Priya asked for your review', item: item(reviewReq), want: 'review', owner: you, text: "Review Priya's PR · waited 2d" },
  { name: 'merge: approved, unmerged', item: item(ownPr('own-pr-approved')), want: 'merge', owner: you, text: 'Merge your PR · open 2d' },
  { name: 'result: a brief is ready', item: item(manual, { brief: { status: 'ready', at: T0 } }), want: 'result', owner: you, text: 'Read the brief · open 2d' },
  { name: 'fix: a brief failed', item: item(manual, { brief: { status: 'failed', at: T0 } }), want: 'fix', owner: you, text: 'Retry the brief · open 2d' },
  { name: 'resume: you paused Junior', item: item({ ...manual, handoff: 'paused', junior: junior('paused') }), want: 'resume', owner: you, text: 'Resume Junior, or do it yourself · open 2d' },
  { name: 'wait: your PR waits on reviewers', item: item(ownPr('own-pr-open')), want: 'wait', owner: person(null), text: 'Wait on reviewers · waiting 2d' },
  { name: 'do: a ticket assigned to you', item: item({ source: 'linear', kind: 'ticket-assigned', reason: 'assigned', ask: 'do', priority: 1 }), want: 'do', owner: you, text: 'Work the ticket · open 2d · urgent' },
]

/** Items that match more than one rule: the earlier rule wins. */
const FIRST_MATCH: Row[] = [
  // decide beats reply: a send Junior drafted for Priya waits for your OK
  { name: 'decide over reply', item: item(slackReply), ctx: { heldSends: 2 }, want: 'decide', owner: you, text: 'Approve 2 sends · waited 2d' },
  // decide beats review: Junior's first pass waits, the review is still Priya's ask
  { name: 'decide over review', item: item({ ...reviewReq, ...handed('watching'), tasks: review('ready') }), want: 'decide', owner: you, text: "Check Junior's first pass · waited 2d" },
  // reply beats review: a job hit whose run picked reply, on a PR thread
  { name: 'reply over the fallback ask', item: item({ kind: 'job-hit', ask: 'reply', reason: 'found', peopleWaiting: 1 }), want: 'reply', owner: you, text: 'Answer Priya · waited 2d' },
  // changes beats ci: changes requested and CI red
  { name: 'changes over ci', item: item(ownPr('reply-needed', { reason: 'your-pr', ask: 'reply', ciFailing: true })), want: 'changes', owner: you, text: 'Address the requested changes · open 2d · CI red too' },
  // conflict beats ci: your PR conflicts and is red; turn.ts calls it ci-red
  { name: 'conflict over ci', item: item(ownPr('own-pr-conflicting', { ciFailing: true })), want: 'conflict', owner: you, text: 'Resolve conflicts · open 2d · CI red too' },
  // ci beats merge: approved but red
  { name: 'ci over merge', item: item(ownPr('own-pr-approved', { ciFailing: true })), want: 'ci', owner: you, text: 'Fix red CI · open 2d' },
  // review beats resume: you paused Junior, the review is still yours
  { name: 'review over resume', item: item({ ...reviewReq, handoff: 'paused', junior: junior('paused') }), want: 'review', owner: you, text: "Review Priya's PR · waited 2d · Junior paused" },
  // reply beats fix: a brief failed on a Slack reply; the reply is still owed
  { name: 'reply over fix', item: item(slackReply, { brief: { status: 'failed', at: T0 } }), want: 'reply', owner: you, text: 'Answer Priya · waited 2d · brief failed' },
  // wait beats every ask rule: you said it waits on Niraj
  { name: 'wait over reply, when someone else has it', item: item(slackReply, { override: { turn: 'others', note: 'Niraj to confirm the copy', at: T0 } }), want: 'wait', owner: person(null), text: 'Wait on Niraj to confirm the copy · waiting 2d' },
]

/** More shapes: owners, names and reasons. */
const MORE: Row[] = [
  { name: 'Junior fixes red CI on your PR', item: item({ ...ownPr('own-pr-open', { ciFailing: true }), ...handed('watching') }), want: 'ci', owner: jr, text: 'Fix red CI · with Junior' },
  // red only where main is red too: nothing to do here, and nothing orange
  {
    name: 'red on main too, handed off',
    item: item({ ...ownPr('own-pr-open', { ciFailing: true, seen: { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false, mainRed: [{ check: 'lint', url: null, sha: null, at: null }] } }), ...handed('watching') }),
    want: 'wait',
    owner: person(null),
    text: 'Leave it · main is red too · not yours · waiting 2d',
  },
  { name: 'Junior resolves conflicts on your PR', item: item({ ...ownPr('own-pr-conflicting'), ...handed('working') }), want: 'conflict', owner: jr, text: 'Resolve conflicts · with Junior' },
  { name: 'Junior starts a first pass', item: item({ ...reviewReq, ...handed('watching') }), want: 'review', owner: jr, text: "Review Priya's PR · with Junior" },
  { name: 'review posted, the author has it', item: item({ ...reviewReq, ...handed('watching'), tasks: review('posted') }), want: 'wait', owner: person('Priya'), text: 'Wait on Priya · review posted · waiting 2d' },
  { name: 'a follow-up', item: item({ kind: 'job-hit', ask: 'follow-up', reason: 'found', author: '@niraj' }), want: 'wait', owner: person('niraj'), text: 'Wait on niraj · waiting 2d' },
  { name: 'a goal waits on the world', item: item(manual, { goal: { state: 'waiting_world', at: T0 } }), want: 'wait', owner: person(null), text: 'Wait on an outside change · waiting 2d' },
  { name: 'snoozed', item: item({ ...slackReply, status: 'snoozed' }), want: 'wait', owner: person(null), text: 'Leave it · snoozed' },
  { name: 'Junior works your to-do', item: item({ ...manual, ...handed('working') }), want: 'do', owner: jr, text: 'Work on the to-do · with Junior' },
  // merging is yours: while Junior works an approved PR, the row says Junior works it
  { name: 'Junior works an approved PR', item: item({ ...ownPr('own-pr-approved'), ...handed('working') }), want: 'do', owner: jr, text: 'Work on your PR · with Junior' },
  { name: 'a team waits for your OK', item: item(manual, { team: { state: 'proposed', at: T0 } }), want: 'decide', owner: you, text: 'Approve the team · open 2d' },
  { name: 'a goal plan to review', item: item(manual, { goal: { state: 'plan_ready', at: T0 } }), want: 'decide', owner: you, text: "Review Junior's plan · open 2d" },
  { name: 'Junior paused on you', item: item({ ...manual, ...handed('needs-you') }), want: 'decide', owner: you, text: 'Answer Junior · open 2d' },
  { name: 'a reviewer to pick', item: item({ ...manual, tasks: tasks({ needsYou: 1, next: { id: 't', title: 'Request a reviewer', step: 'request-review', owner: 'you' } }) }), want: 'decide', owner: you, text: 'Pick a reviewer · open 2d' },
  { name: 'a job asks you to decide', item: item({ kind: 'job-hit', ask: 'decide', reason: 'found', peopleWaiting: 3 }), want: 'decide', owner: you, text: 'Decide for Priya · waited 2d · 3 waiting' },
  { name: 'a session finished', item: item(manual, { session: { running: false, waiting: false, error: false, at: T0 } }), want: 'result', owner: you, text: "Review Junior's work · open 2d" },
  { name: 'a session failed', item: item(manual, { session: { running: false, waiting: false, error: true, at: T0 } }), want: 'fix', owner: you, text: 'Check the failed chat · open 2d' },
  { name: 'a mention, a few hours old', item: item({ updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(), createdAt: new Date(NOW - 3 * 3_600_000).toISOString() }), want: 'do', owner: you, text: "Read Priya's mention · open 3h" },
  { name: 'a digest, just now', item: item({ kind: 'digest', source: 'job', ask: 'read', updatedAt: new Date(NOW).toISOString(), createdAt: new Date(NOW).toISOString() }), want: 'do', owner: you, text: 'Read the digest' },
  { name: 'a long blocker name is clipped', item: item(slackReply), ctx: { blocks: 'the very long release train name' }, want: 'reply', owner: you, text: 'Answer Priya · waited 2d · blocks the very long' },
]

const ALL = [...RULE_ROWS, ...FIRST_MATCH, ...MORE]

test('each rule lands on its own dedicated row', () => {
  assert.deepEqual(
    RULE_ROWS.map((r) => r.want),
    NEXT_RULES.map((r) => r.action),
    'one row per rule, in the rule order',
  )
  for (const r of RULE_ROWS) {
    const m = nextMove(r.item, r.ctx, NOW)
    assert.equal(m.action, r.want, r.name)
  }
})

test('the first match wins when an item fits two rules', () => {
  for (const r of FIRST_MATCH) assert.equal(nextMove(r.item, r.ctx, NOW).action, r.want, r.name)
})

test('every row: action, owner and line', () => {
  for (const r of ALL) {
    const m = nextMove(r.item, r.ctx, NOW)
    assert.equal(m.action, r.want, r.name)
    assert.deepEqual(m.owner, r.owner, r.name)
    assert.equal(m.text, r.text, r.name)
  }
})

test("the owner agrees with whose turn it is, so a row's move and its tab never disagree", () => {
  const kindOf = { you: 'you', junior: 'junior', others: 'person' } as const
  for (const r of ALL) {
    const m = nextMove(r.item, r.ctx, NOW)
    assert.deepEqual(m.turn, turnOf(r.item, r.ctx), r.name)
    assert.equal(m.owner.kind, kindOf[m.turn.turn], r.name)
  }
})

/** Every combination of the fields the rules read, for the line rules. */
function* shapes(): Generator<{ item: ScoredItem; ctx: NextContext }> {
  const kinds: ItemKind[] = ['review-requested', 'reply-needed', 'own-pr-approved', 'own-pr-conflicting', 'own-pr-stale', 'own-pr-open', 'mention', 'slack-reply-pending', 'slack-mention', 'ticket-assigned', 'job-hit', 'digest', 'manual', 'fyi']
  const sources: WorkSource[] = ['github', 'slack', 'linear', 'job', 'manual']
  const asks = ['review', 'reply', 'decide', 'do', 'follow-up', 'read', 'stale-ask']
  const signals: (FlowSignals | undefined)[] = [
    undefined,
    { brief: { status: 'ready', at: T0 } },
    { brief: { status: 'failed', at: T0 } },
    { session: { running: true, waiting: true, error: false, at: T0 } },
    { session: { running: false, waiting: false, error: true, at: T0 } },
    { team: { state: 'gate', at: T0 } },
    { goal: { state: 'paused', at: T0 } },
    { override: { turn: 'others', note: 'Niraj to confirm the copy and the date before Friday afternoon', at: T0 } },
  ]
  const extras: Partial<ScoredItem>[] = [{}, { ...handed('watching') }, { ...handed('working') }, { handoff: 'paused', junior: junior('paused') }, { ciFailing: true, priority: 1, peopleWaiting: 4, isDraft: true }, { status: 'snoozed' }, { tasks: review('ready') }]
  const ctxs: NextContext[] = [{}, { blocked: true }, { heldSends: 3 }, { blocks: 'release-4.2 and the hotfix train' }]
  for (const kind of kinds)
    for (const source of sources)
      for (const ask of asks)
        for (const s of signals)
          for (const extra of extras) {
            const ctx = ctxs[(kind.length + source.length + ask.length) % ctxs.length]!
            yield { item: item({ kind, source, ask: ask as ScoredItem['ask'], author: 'Priya Shah-Verma', ...extra }, s), ctx }
          }
}

test('every line is verb first and 15 words or fewer, on every shape', () => {
  let n = 0
  const actions = new Set<NextAction>()
  for (const { item: i, ctx } of shapes()) {
    const m = nextMove(i, ctx, NOW)
    const first = m.text.split(/\s+/)[0]!
    assert.ok(NEXT_VERBS.has(first), `not verb first: "${m.text}"`)
    assert.ok(wordCount(m.text) <= MAX_WORDS, `too long: "${m.text}"`)
    assert.ok(m.text.startsWith(m.verb.split(/\s+/).slice(0, MAX_WORDS).join(' ')), `verb dropped: "${m.text}"`)
    assert.ok(!/\bAI\b|24\/7|walk away/i.test(m.text), m.text)
    actions.add(m.action)
    n++
  }
  assert.ok(n > 10_000, `only ${n} shapes`)
  // the generator reaches every rule
  for (const r of NEXT_RULES) assert.ok(actions.has(r.action), `no shape reached ${r.action}`)
})

test('the line drops reasons from the end, never the verb', () => {
  assert.equal(nextMoveLine('Answer Priya', ['waited 2d', 'blocks release-4.2']), 'Answer Priya · waited 2d · blocks release-4.2')
  const long = nextMoveLine('Answer Priya', ['one two three four five', 'six seven eight nine ten', 'eleven twelve thirteen fourteen', 'two'])
  // 2 + 5 + 5 = 12 words; four more would make 16, so that part and all after it drop
  assert.equal(long, 'Answer Priya · one two three four five · six seven eight nine ten')
  assert.equal(wordCount(long), 12)
  assert.equal(nextMoveLine('a b c d e f g h i j k l m n o p q', ['x']).split(' ').length, 15)
  assert.equal(wordCount('Answer Priya · waited 2d · blocks release-4.2'), 6)
})

test('pure: same answer twice, the item untouched', () => {
  for (const r of ALL) {
    const before = JSON.stringify(r.item)
    assert.deepEqual(nextMove(r.item, r.ctx, NOW), nextMove(r.item, r.ctx, NOW), r.name)
    assert.equal(JSON.stringify(r.item), before, r.name)
  }
})

test('the score still orders rows within a turn', () => {
  const rows = [
    { id: 'a', turn: 'others' as const, score: 99 },
    { id: 'b', turn: 'you' as const, score: 20 },
    { id: 'c', turn: 'junior' as const, score: 50 },
    { id: 'd', turn: 'you' as const, score: 80 },
    { id: 'e', turn: 'you' as const, score: 80 },
  ]
  assert.deepEqual(rows.sort(byTurnThenScore).map((r) => r.id), ['d', 'e', 'b', 'c', 'a'])
})

test('owner labels', () => {
  assert.equal(ownerLabel(you), 'You')
  assert.equal(ownerLabel(jr), 'Junior')
  assert.equal(ownerLabel(person('Priya')), 'Priya')
  assert.equal(ownerLabel(person(null)), 'Others')
})

test('no model in the path: next.ts imports only the pure work core', () => {
  const src = readFileSync(new URL('../core/work/next.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  for (const i of imports) assert.match(i!, /^\.\/(asks|flow|turn|types)\.js$/, i)
})
