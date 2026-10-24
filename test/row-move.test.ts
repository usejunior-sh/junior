/**
 * The Ledger row's first line (core/junior/row-move.ts): the served move
 * while it matches the item, else one made in the browser; the age and
 * "with Junior" split off the line; ⏎ takes the verb only where it finishes
 * the move. And Needs you's own rows (core/junior/needs.ts) lead with a move.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageWords, enterVerb, moveKey, rowLabel, rowMove, servedMoves, type RowMove } from '../core/junior/row-move.js'
import { needsMove, needsMoveText, needsRows, sendsSubject } from '../core/junior/needs.js'
import { MAX_WORDS, NEXT_VERBS, nextMove, wordCount } from '../core/work/next.js'
import { flowOf } from '../core/work/flow.js'
import type { TaskSummary } from '../core/work/tasks.js'
import type { ScoredItem } from '../core/work/types.js'

const T0 = Date.parse('2026-10-22T08:00:00Z')
const HOUR = 3_600_000
const NOW = T0 + 2 * 86_400_000 + 3 * HOUR // 2d 3h later

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  const base = {
    id: 'slack:#eng#1',
    source: 'slack',
    kind: 'slack-reply-pending',
    title: 'Is the 4.2 release checklist final?',
    url: '',
    repo: '#eng-platform',
    author: 'Priya Shah',
    peopleWaiting: 1,
    createdAt: '2026-10-22T08:00:00Z',
    updatedAt: '2026-10-22T08:00:00Z',
    status: 'open',
    score: 10,
    group: 'blocking',
    rankWhy: '',
    ask: 'reply',
    reason: 'mentioned',
    ...over,
  } as ScoredItem
  return { ...base, flow: base.flow ?? flowOf(base) }
}

const tasks = (over: Partial<TaskSummary> = {}): TaskSummary => ({ line: null, running: false, queued: 0, needsYou: 0, next: null, lastDone: null, ...over })

test('a reply: the verb names the person, the age leaves the line for the age column', () => {
  const i = item({ peopleWaiting: 2, priority: 1 })
  const line = rowMove(i, undefined, NOW)!
  assert.equal(line.verb, 'Answer Priya')
  assert.deepEqual(line.reasons, ['2 waiting', 'urgent'])
  assert.equal(line.age, '2d')
  assert.equal(line.ageWords, 'Waited 2 days')
  assert.equal(line.text, 'Answer Priya · waited 2d · 2 waiting · urgent')
  assert.equal(line.withJunior, false)
})

test('age words per prefix, singular and plural', () => {
  assert.equal(ageWords('waited 2d'), 'Waited 2 days')
  assert.equal(ageWords('open 1h'), 'Open 1 hour')
  assert.equal(ageWords('waiting 1d'), 'Waiting 1 day')
  assert.equal(ageWords('waiting 5h'), 'Waiting 5 hours')
  assert.equal(ageWords('urgent'), null)
  assert.equal(ageWords('2 waiting'), null)
})

test('under an hour: no age on the line, the column keeps its own', () => {
  const recent = new Date(NOW - 20 * 60_000).toISOString()
  const i = item({ createdAt: recent, updatedAt: recent })
  const line = rowMove(i, undefined, NOW)!
  assert.equal(line.age, null)
  assert.equal(line.ageWords, null)
})

test('"with Junior" leaves the reasons; the row shows it only on a phone', () => {
  const i = item({ source: 'github', kind: 'own-pr-open', reason: 'your-pr', ask: 'do', author: 'me', peopleWaiting: 0, ciFailing: true, handoff: 'on', junior: { stage: 'working' } })
  const line = rowMove(i, undefined, NOW)!
  assert.equal(line.withJunior, true)
  assert.ok(!line.reasons.includes('with Junior'))
  assert.match(line.text, /with Junior/)
})

test('the served move wins while its key matches the item', () => {
  const i = item()
  const served: RowMove = { action: 'decide', verb: 'Approve 2 sends', reasons: ['waited 2d'], text: 'Approve 2 sends · waited 2d', key: moveKey(i), ctx: { heldSends: 2 } }
  const line = rowMove(i, served, NOW)!
  assert.equal(line.verb, 'Approve 2 sends')
  assert.equal(line.age, '2d')
  assert.deepEqual(line.reasons, [])
})

test('a stale served move: the row makes its own, keeping the served context', () => {
  const i = item()
  const served: RowMove = { action: 'reply', verb: 'Old words', reasons: [], text: 'Old words', key: 'stale', ctx: { heldSends: 3 } }
  const line = rowMove(i, served, NOW)!
  assert.equal(line.verb, 'Approve 3 sends')
  // Junior moved on the item without the source changing: the key changes too
  const before = moveKey(i)
  assert.notEqual(moveKey({ ...i, tasks: tasks({ review: { state: 'ready', verdict: null, line: null } }) }), before)
  assert.notEqual(moveKey({ ...i, junior: { stage: 'needs-you' } }), before)
  assert.notEqual(moveKey({ ...i, handoff: 'paused' }), before)
  assert.equal(moveKey({ ...i }), before)
})

test('no served move: made in the browser, same as the server would without context', () => {
  const i = item()
  const line = rowMove(i, undefined, NOW)!
  assert.equal(line.text, nextMove(i, {}, NOW).text)
})

test('an empty served verb on a matching key: no line, the row falls back to its title', () => {
  const i = item()
  assert.equal(rowMove(i, { action: 'do', verb: '  ', reasons: [], text: '', key: moveKey(i) }, NOW), null)
})

test('only the reasons that fit in the line show', () => {
  const i = item()
  const reasons = ['waited 2d', 'one two three four five', 'six seven eight nine ten']
  const served: RowMove = { action: 'reply', verb: 'Answer Priya', reasons, text: 'Answer Priya · waited 2d · one two three four five', key: moveKey(i) }
  assert.deepEqual(rowMove(i, served, NOW)!.reasons, ['one two three four five'])
})

test('servedMoves: one per item, context only where the server knows something', () => {
  const a = item({ id: 'a' })
  const b = item({ id: 'b' })
  const moves = servedMoves([a, b], (id) => (id === 'a' ? { blocked: true, heldSends: 0 } : undefined), NOW)
  assert.deepEqual(Object.keys(moves).sort(), ['a', 'b'])
  assert.equal(moves.a!.verb, "Answer Junior's chat")
  assert.deepEqual(moves.a!.ctx, { blocked: true, heldSends: 0 })
  assert.equal(moves.b!.verb, 'Answer Priya')
  assert.equal(moves.b!.ctx, undefined)
  assert.equal(moves.a!.key, moveKey(a))
  // the row takes it as served
  assert.equal(rowMove(a, moves.a, NOW)!.verb, "Answer Junior's chat")
})

test('⏎ takes the verb only where pressing it finishes the move', () => {
  const rows: [Parameters<typeof enterVerb>[0], boolean, ReturnType<typeof enterVerb>][] = [
    [{ action: 'decide', verb: "Check Junior's first pass" }, false, { label: "Check Junior's first pass", does: 'open' }],
    [{ action: 'result', verb: 'Read the brief' }, false, { label: 'Read the brief', does: 'open' }],
    [{ action: 'result', verb: "Review Junior's work" }, false, { label: "Review Junior's work", does: 'open' }],
    [{ action: 'fix', verb: 'Check what broke' }, false, { label: 'Check what broke', does: 'open' }],
    [{ action: 'fix', verb: 'Check the failed chat' }, false, { label: 'Check the failed chat', does: 'open' }],
    [{ action: 'resume', verb: 'Resume Junior, or do it yourself' }, true, { label: 'Resume Junior', does: 'resume' }],
    // unchanged: ⏎ can't finish these
    [{ action: 'reply', verb: 'Answer Priya' }, false, null],
    [{ action: 'result', verb: "Accept the team's result" }, false, null],
    [{ action: 'fix', verb: 'Retry the brief' }, false, null],
    [{ action: 'decide', verb: 'Approve 2 sends' }, false, null],
    // a pause that isn't a hand-off's: ⏎ doesn't resume it
    [{ action: 'resume', verb: 'Resume Junior, or do it yourself' }, false, null],
    [null, false, null],
  ]
  for (const [move, paused, want] of rows) assert.deepEqual(enterVerb(move, paused), want, `${move?.action} ${move?.verb}`)
})

test('the first-pass row: the move and ⏎ agree', () => {
  const i = item({ source: 'github', kind: 'review-requested', reason: 'review-requested', ask: 'review', author: 'niraj', handoff: 'on', junior: { stage: 'watching', readiness: { state: 'ready' } }, tasks: tasks({ review: { state: 'ready', verdict: null, line: null } }) })
  const line = rowMove(i, undefined, NOW)!
  assert.equal(line.verb, "Check Junior's first pass")
  assert.deepEqual(enterVerb(line, false), { label: "Check Junior's first pass", does: 'open' })
})

test('the accessible name: each part a sentence, empty parts dropped', () => {
  assert.equal(rowLabel(['Answer Priya · waited 2d · urgent', 'Is the 4.2 release checklist final?', 'Can take', null, '#eng-platform']), 'Answer Priya · waited 2d · urgent. Is the 4.2 release checklist final?. Can take. #eng-platform.')
  assert.equal(rowLabel(['Fix red CI', '', '  ', 'acme/api#88.']), 'Fix red CI. acme/api#88.')
})

// Needs you's own rows

const NEED_NOW = T0
const needs = () =>
  needsRows(
    {
      blocked: [
        { id: 'q', title: 'Fix the flake', waitingOn: 'AskUserQuestion', at: NEED_NOW - 1 * HOUR },
        { id: 'p', title: 'Fix the auth test flake', waitingOn: 'mcp__junior__Bash', at: NEED_NOW - 2 * HOUR },
        { id: 'u', title: 'Tidy the docs', at: NEED_NOW - 3 * HOUR },
      ],
      teams: [
        { runId: 'r1', leadSessionId: 'l1', label: 'Retries', goal: 'Rate-limit webhook retries', state: 'proposed', steps: 4, team: 'Build', budgetUsd: 3, at: NEED_NOW - 4 * HOUR },
        { runId: 'r2', leadSessionId: 'l2', label: 'Sleep', goal: '', state: 'gate', steps: 3, team: null, budgetUsd: 5, reason: 'review the diff before the push goes out to the shared branch today', at: NEED_NOW - 5 * HOUR },
        { runId: 'r3', leadSessionId: 'l3', label: 'Cache', goal: 'Cache', state: 'revision', steps: 2, team: null, budgetUsd: 1, reason: 'one more step for tests', at: NEED_NOW - 6 * HOUR },
        { runId: 'r4', leadSessionId: 'l4', label: 'Goalless', goal: '', state: 'proposed', steps: 1, team: null, budgetUsd: 1, at: NEED_NOW - 7 * HOUR },
      ],
      sends: [
        { sessionId: 's1', origin: 'the Babysit job', titles: ['PR #486'], at: NEED_NOW - 8 * HOUR },
        { sessionId: 's2', origin: 'the Babysit job', titles: ['PR #486', 'a reply to Marcus', 'a comment'], at: NEED_NOW - 9 * HOUR },
      ],
    },
    NEED_NOW,
  )

test('Needs you rows lead with a move over what they are about', () => {
  const got = needs().map((r) => [r.key, needsMoveText(r.move), r.subject])
  assert.deepEqual(got, [
    ['session:u', "Answer Junior's chat", 'Tidy the docs'],
    ['session:p', "Answer Junior's chat · Permission: Bash", 'Fix the auth test flake'],
    ['session:q', "Answer Junior's question", 'Fix the flake'],
    ['plan:r4', "Review Junior's plan · 1 step", 'Goalless'],
    ['revision:r3', "Review Junior's plan change · one more step for tests", 'Cache'],
    ['gate:r2', 'Approve the team step · review the diff before the push goes out…', 'Sleep'],
    ['plan:r1', "Review Junior's plan · 4 steps · Build", 'Rate-limit webhook retries'],
    ['sends:s2', 'Approve 3 sends · from the Babysit job', 'PR #486 and 2 more'],
    ['sends:s1', 'Approve the send · from the Babysit job', 'PR #486'],
  ])
})

test('every Needs you move: a known verb first, 15 words or fewer, no banned words', () => {
  for (const r of needs()) {
    const line = needsMoveText(r.move)
    assert.ok(r.move.verb.length > 0)
    assert.ok(NEXT_VERBS.has(line.split(' ')[0]!), line)
    assert.ok(wordCount(line) <= MAX_WORDS, line)
    assert.doesNotMatch(line, /\bAI\b|24\/7|walk away/i)
  }
})

test('needsMove drops reasons from the end until the line fits', () => {
  const long = 'a b c d e f g h'
  assert.deepEqual(needsMove('Approve the send', [long, long, null, '']), { verb: 'Approve the send', reasons: [long] })
  assert.deepEqual(needsMove('Answer Junior', []), { verb: 'Answer Junior', reasons: [] })
})

test('sendsSubject: the sends, without "wait for your OK"', () => {
  assert.equal(sendsSubject([]), 'A send')
  assert.equal(sendsSubject(['PR #486']), 'PR #486')
  assert.equal(sendsSubject(['PR #486', 'a reply to Marcus']), 'PR #486 and a reply to Marcus')
  assert.equal(sendsSubject(['PR #486', 'a', 'b']), 'PR #486 and 2 more')
})
