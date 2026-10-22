/**
 * Actions, phase 2 (spec 7ce2f076): queue → approve → dispatch. The status
 * machine and its history, the args fence the dispatch run goes through, how
 * a dispatch ends, the card's words (titles, why it counted, the payload,
 * quick approve), and the store's one-shot claim. Time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DRY_RUN_MESSAGE,
  DispatchFence,
  QUEUE_TTL_MS,
  connectorState,
  dispatchDisallowed,
  dryRunDecision,
  UNDO_MS,
  argsEqual,
  canonJson,
  dispatchOutcome,
  dispatchPrompt,
  dueToExpire,
  dueToSend,
  heldEntry,
  heldRecord,
  holdable,
  move,
  queuedMessage,
  sendDelay,
  type ActionMove,
} from '../core/actions/queue.js'
import { countdownText, payloadOf, quickApprovable, shortActionId, tabOf } from '../core/actions/view.js'
import { countLine } from '../core/actions/count.js'
import { actionTitle, countedText } from '../core/actions/describe.js'
import { applyActionOps, joinHeldCall, recordFor, type TrackContext } from '../core/actions/track.js'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import type { ActionRecord, ActionStatus } from '../core/actions/types.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { flowOf } from '../core/work/flow.js'
import { inboxTabOf } from '../core/work/inbox-tabs.js'
import { askOf } from '../core/work/asks.js'
import type { WorkItem } from '../core/work/types.js'

const T0 = new Date(2026, 9, 13, 10).getTime()
const TOOL = 'mcp__claude_ai_Slack__slack_send_message'
const ARGS = { channel_id: 'C0123ABCD', text: 'Shipped: every action now lands in one list.' }

const ctx: TrackContext = { sessionId: 's1', sessionKind: 'job-run', permissionMode: null, jobId: 'w1', teamRunId: null, itemId: 'manual:1' }

function held(args: Record<string, unknown> = ARGS, tool = TOOL, at = T0): ActionRecord {
  const sorted = sortCall(tool, args, { rules: DEFAULT_RULES })
  assert.ok(sorted, `${tool} sorts as an action`)
  return heldRecord(recordFor(ctx, 'tu1', tool, args, sorted, at), args, at)
}

/** Apply a move that must succeed. */
function ok(rec: ActionRecord, m: ActionMove, now: number): ActionRecord {
  const r = move(rec, m, now)
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.next
}
const refused = (rec: ActionRecord, m: ActionMove, now: number): string => {
  const r = move(rec, m, now)
  assert.equal(r.ok, false, `${m.type} from ${rec.status} should be refused`)
  return r.ok ? '' : r.error
}

// ---------------------------------------------------------------------------
// The status machine
// ---------------------------------------------------------------------------

test('hold: a held call waits on you, full args kept, expiring in 24h', () => {
  const long = 'x'.repeat(5000)
  const a = held({ ...ARGS, text: long })
  assert.equal(a.status, 'needs_you')
  assert.equal(a.id, 's1:tu1')
  assert.equal(a.queue?.args.text, long, 'the args that go out are never trimmed')
  assert.notEqual(a.args.text, long, 'the display copy is')
  assert.equal(a.queue?.expiresAt, T0 + QUEUE_TTL_MS)
  assert.equal(a.queue?.sendAt, null)
  const e = heldEntry(a, a.queue!.args, T0)
  assert.deepEqual([e.actor, e.event, e.from, e.to], ['agent', 'queued', null, 'needs_you'])
  assert.equal(e.args?.text, long, 'the history keeps the original')
})

test('approve: due at once, no undo window', () => {
  const a = held()
  const r = move(a, { type: 'approve' }, T0 + 1000)
  assert.ok(r.ok)
  assert.equal(r.next.status, 'scheduled')
  assert.equal(r.next.queue?.sendAt, T0 + 1000)
  assert.deepEqual([r.entry.actor, r.entry.event, r.entry.from, r.entry.to], ['you', 'approved', 'needs_you', 'scheduled'])
  assert.equal(sendDelay(r.next, T0 + 1000), 0)
  assert.equal(dueToSend(r.next, T0 + 1000), true)
  assert.match(refused(r.next, { type: 'undo' }, T0 + 1000), /too late/)
})

test('edit then approve: the edited args go out, the edit is counted and in the history', () => {
  const a = held()
  const edited = { ...ARGS, text: 'Shipped — one list for every action.' }
  const r = move(a, { type: 'approve', args: edited }, T0 + 500)
  assert.ok(r.ok)
  assert.deepEqual(r.next.queue?.args, edited)
  assert.equal(r.next.queue?.edits, 1)
  assert.equal(r.entry.event, 'edited and approved')
  assert.deepEqual(r.entry.args, edited)
  // The same args, reordered, is not an edit.
  const same = move(a, { type: 'approve', args: { text: ARGS.text, channel_id: ARGS.channel_id } }, T0 + 500)
  assert.ok(same.ok)
  assert.equal(same.next.queue?.edits, 0)
  assert.equal(same.entry.event, 'approved')
})

test('send back needs notes; reject keeps its reason; neither from anywhere but needs you', () => {
  const a = held()
  assert.match(refused(a, { type: 'send_back', notes: '   ' }, T0), /notes/)
  const sb = ok(a, { type: 'send_back', notes: 'Too long — one line.' }, T0 + 1)
  assert.equal(sb.status, 'sent_back')
  assert.equal(sb.queue?.note, 'Too long — one line.')
  assert.equal(sb.queue?.delivery, null)
  const rj = ok(a, { type: 'reject', reason: 'not now' }, T0 + 1)
  assert.equal(rj.status, 'rejected')
  assert.equal(rj.queue?.note, 'not now')
  assert.equal(ok(a, { type: 'reject', reason: '' }, T0).queue?.note, null)
  const sched = ok(a, { type: 'approve' }, T0)
  refused(sched, { type: 'send_back', notes: 'x' }, T0 + 1)
  refused(sched, { type: 'reject', reason: 'x' }, T0 + 1)
  refused(rj, { type: 'approve' }, T0 + 2)
})

test('expiry: only past its time, and an expired one can no longer be approved', () => {
  const a = held()
  assert.equal(dueToExpire(a, T0 + QUEUE_TTL_MS - 1), false)
  assert.equal(dueToExpire(a, T0 + QUEUE_TTL_MS), true)
  refused(a, { type: 'expire' }, T0 + 10)
  assert.equal(ok(a, { type: 'expire' }, T0 + QUEUE_TTL_MS).status, 'expired')
  assert.match(refused(a, { type: 'approve' }, T0 + QUEUE_TTL_MS + 1), /expired/)
})

test('claim → settle: only when due; outcomes; retry from failed or unknown, never from sent', () => {
  const s = ok(held(), { type: 'approve' }, T0)
  assert.equal(dueToSend(s, T0), true)
  const sending = ok(s, { type: 'claim' }, T0 + UNDO_MS)
  assert.equal(sending.status, 'sending')
  refused(sending, { type: 'undo' }, T0 + UNDO_MS)
  const sent = ok(sending, { type: 'settle', status: 'succeeded', link: 'https://x.slack.com/archives/C1/p1', costUsd: 0.01 }, T0 + UNDO_MS + 3000)
  assert.equal(sent.status, 'succeeded')
  assert.equal(sent.link, 'https://x.slack.com/archives/C1/p1')
  assert.equal(sent.allowedBy, 'prompt')
  assert.equal(sent.queue?.costUsd, 0.01)
  refused(sent, { type: 'retry' }, T0 + 99_000)
  const failed = ok(sending, { type: 'settle', status: 'failed', error: 'channel_not_found' }, T0 + UNDO_MS + 1)
  assert.equal(failed.error, 'channel_not_found')
  const again = ok(failed, { type: 'retry' }, T0 + 60_000)
  assert.equal(again.status, 'scheduled')
  assert.equal(again.error, null)
  assert.equal(again.queue?.sendAt, T0 + 60_000 + UNDO_MS)
  const unknown = ok(sending, { type: 'settle', status: 'unknown', error: 'died' }, T0 + UNDO_MS + 1)
  assert.equal(ok(unknown, { type: 'retry' }, T0 + 70_000).status, 'scheduled')
})

test('moves refuse a record that was never queued', () => {
  const sorted = sortCall(TOOL, ARGS, { rules: DEFAULT_RULES })!
  const ran = { ...recordFor(ctx, 'tu9', TOOL, ARGS, sorted, T0), status: 'succeeded' as ActionStatus }
  assert.match(refused(ran, { type: 'retry' }, T0), /recorded as it ran/)
})

// ---------------------------------------------------------------------------
// The dispatch fence and outcome
// ---------------------------------------------------------------------------

test('args equality: deep, key order free, values exact', () => {
  assert.equal(argsEqual({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 }), true)
  assert.equal(argsEqual({ a: [1, 2] }, { a: [2, 1] }), false)
  assert.equal(argsEqual({ a: 'x ' }, { a: 'x' }), false)
  assert.equal(argsEqual({ a: 1 }, { a: '1' }), false)
  assert.equal(argsEqual({ a: 1, b: undefined }, { a: 1 }), true)
  assert.equal(canonJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('fence: the one tool, the approved args, once — anything else denied', () => {
  const f = new DispatchFence(TOOL, ARGS)
  assert.equal(f.decide('Bash', { command: 'ls' }).allow, false)
  assert.equal(f.decide('mcp__other__send', ARGS).allow, false)
  const changed = f.decide(TOOL, { ...ARGS, text: 'reworded' })
  assert.equal(changed.allow, false)
  assert.match(!changed.allow ? changed.reason : '', /differ.*\(text\)/)
  assert.equal(f.allowed, false)
  assert.deepEqual(f.decide(TOOL, { text: ARGS.text, channel_id: ARGS.channel_id }, 'tu-ok'), { allow: true })
  assert.equal(f.allowed, true)
  assert.equal(f.allowedCall, 'tu-ok')
  const twice = f.decide(TOOL, ARGS)
  assert.equal(twice.allow, false)
  assert.match(!twice.allow ? twice.reason : '', /exactly once/)
})

test('dispatch outcome: nothing let through = failed; through without a result = unknown', () => {
  assert.deepEqual(dispatchOutcome({ allowed: false, connector: 'missing', noTool: true }, 'claude_ai_Slack'), {
    status: 'failed',
    link: null,
    error: 'connector not connected: claude_ai_Slack',
  })
  assert.equal(dispatchOutcome({ allowed: false, connector: 'failed' }, 's').error, 'connector not connected: s')
  const none = dispatchOutcome({ allowed: false, connector: 'listed', denials: ['the arguments differ'] }, 's')
  assert.equal(none.status, 'failed')
  assert.match(none.error ?? '', /did not make the call — the arguments differ/)
  const lost = dispatchOutcome({ allowed: true, connector: 'listed', runError: 'timed out after 3m' }, 's')
  assert.equal(lost.status, 'unknown')
  assert.match(lost.error ?? '', /check before retrying/)
  assert.deepEqual(dispatchOutcome({ allowed: true, connector: 'listed', result: { isError: true, text: 'channel_not_found' } }, 's'), {
    status: 'failed',
    link: null,
    error: 'channel_not_found',
  })
  assert.deepEqual(dispatchOutcome({ allowed: true, connector: null, result: { isError: false, text: '{"ok":true,"permalink":"https://a.slack.com/archives/C1/p2"}' } }, 's'), {
    status: 'succeeded',
    link: 'https://a.slack.com/archives/C1/p2',
    error: null,
  })
})

test('P0 regression: a pending claude.ai connector is not "not connected"', () => {
  // claude.ai connectors start pending and their tools are deferred: neither is a missing connector.
  const init = { tools: ['ToolSearch'], mcp_servers: [{ name: 'claude.ai Slack', status: 'pending' }, { name: 'linear', status: 'connected' }, { name: 'gh', status: 'failed' }] }
  assert.equal(connectorState(init, TOOL), 'pending')
  assert.equal(connectorState(init, 'mcp__linear__save_issue'), 'connected')
  assert.equal(connectorState(init, 'mcp__gh__create'), 'failed')
  assert.equal(connectorState(init, 'mcp__notion__create_page'), 'missing')
  assert.equal(connectorState({ tools: [TOOL] }, TOOL), 'listed')
  assert.equal(connectorState({ tools: [] }, TOOL), null)
  // The run said no-tool while the connector was pending: failed, safe to retry — but not "not connected".
  const slow = dispatchOutcome({ allowed: false, connector: 'pending', noTool: true }, 'claude_ai_Slack')
  assert.equal(slow.status, 'failed')
  assert.doesNotMatch(slow.error ?? '', /not connected/)
  assert.match(slow.error ?? '', /still connecting.*nothing was sent/)
  assert.doesNotMatch(dispatchOutcome({ allowed: false, connector: 'connected', noTool: true }, 's').error ?? '', /not connected/)
})

test('P0 regression: ToolSearch passes the fence and never counts as the one call', () => {
  const f = new DispatchFence(TOOL, ARGS)
  assert.deepEqual(f.decide('ToolSearch', { query: `select:${TOOL}` }), { allow: true })
  assert.equal(f.allowed, false)
  assert.deepEqual(f.decide(TOOL, ARGS, 'tu-1'), { allow: true })
  assert.deepEqual(f.decide('ToolSearch', { query: 'select:x' }), { allow: true })
  assert.equal(f.decide(TOOL, ARGS).allow, false, 'still once')
  assert.equal(f.allowedCall, 'tu-1')
  assert.ok(dispatchPrompt(TOOL, ARGS).startsWith(`First call ToolSearch with query \`select:${TOOL}\``))
})

test('P2 regression: the dispatch run loads only the action’s server', () => {
  assert.deepEqual(dispatchDisallowed(['claude.ai Slack', 'claude.ai Gmail', 'linear', 'linear', 'chrome-devtools'], TOOL), [
    'mcp__chrome-devtools',
    'mcp__claude_ai_Gmail',
    'mcp__linear',
  ])
  assert.deepEqual(dispatchDisallowed([], TOOL), [])
})

test('P1 regression: a dry run refuses what counts as an action, passes the rest', () => {
  assert.deepEqual(dryRunDecision(null), { allow: true })
  const d = dryRunDecision({ summary: 'Slack send message: hi' })
  assert.equal(d.allow, false)
  assert.equal(!d.allow && d.reason, DRY_RUN_MESSAGE)
  assert.match(DRY_RUN_MESSAGE, /^dry run: this would be queued for approval/)
})

test('dispatch prompt and the queued message carry the tool, the exact args and the short id', () => {
  const p = dispatchPrompt(TOOL, ARGS)
  assert.ok(p.includes(TOOL))
  assert.ok(p.includes(JSON.stringify(ARGS, null, 2)))
  const m = queuedMessage('s1:tu1')
  assert.ok(m.startsWith(`Queued for the user's approval as action #${shortActionId('s1:tu1')}.`))
  assert.match(m, /sent exactly as written once approved/)
  assert.match(m, /Don't retry or work around it/)
})

// ---------------------------------------------------------------------------
// The card's words
// ---------------------------------------------------------------------------

test('short id: stable, six characters', () => {
  assert.equal(shortActionId('s1:tu1'), shortActionId('s1:tu1'))
  assert.notEqual(shortActionId('s1:tu1'), shortActionId('s1:tu2'))
  assert.match(shortActionId('s1:tu1'), /^[0-9a-z]{6}$/)
})

test('tabs: needs you · scheduled · sent · stopped', () => {
  const tabs = (['needs_you', 'scheduled', 'sending', 'succeeded', 'attempted', 'failed', 'denied', 'rejected', 'expired', 'unknown', 'sent_back'] as ActionStatus[]).map(tabOf)
  assert.deepEqual(tabs, ['needs_you', 'scheduled', 'scheduled', 'sent', 'sent', 'stopped', 'stopped', 'stopped', 'stopped', 'stopped', 'stopped'])
})

test('quick approve: only for what is cheap to take back', () => {
  assert.deepEqual(
    (['ticket', 'post', 'update', 'message', 'email', 'comment', 'pr', 'merge', 'push', 'release', 'other'] as const).filter(quickApprovable),
    ['ticket', 'post', 'update'],
  )
})

test('payload: the readable fields, title first; JSON when there are none', () => {
  const p = payloadOf({ channel_id: 'C1', text: 'hello' })
  assert.deepEqual(p.fields, [{ key: 'text', text: 'hello' }])
  assert.deepEqual(p.target, [{ key: 'channel_id', text: 'C1' }])
  assert.equal(p.json, null)
  const t = payloadOf({ description: 'Steps to reproduce…', title: 'Scheduler skips a slot', team: 'NOV' })
  assert.deepEqual(t.fields.map((f) => f.key), ['title', 'description'])
  const j = payloadOf({ id: 7, labels: ['a'] })
  assert.deepEqual(j.fields, [])
  assert.equal(j.json, JSON.stringify({ id: 7, labels: ['a'] }, null, 2))
})

const rec = (over: Partial<ActionRecord>): ActionRecord => ({
  ...recordFor(ctx, 'x', 'Bash', {}, { kind: 'other', why: 'bash pattern', whyDetail: null, summary: '' }, T0),
  ...over,
})

test('titles say what happened, never "Action"', () => {
  assert.equal(
    actionTitle(rec({ kind: 'pr', status: 'succeeded', summary: 'gh pr create: stage + turn on work items', link: 'https://github.com/usejunior-sh/junior/pull/2' })),
    'Opened PR #2 · stage + turn on work items',
  )
  assert.equal(actionTitle(rec({ kind: 'push', status: 'succeeded', summary: 'git push origin feat/x', groupKey: 'push:s1:feat/x' })), 'Pushed feat/x')
  assert.equal(
    actionTitle(rec({ kind: 'ticket', status: 'succeeded', tool: 'mcp__linear__save_issue', summary: 'Save issue: Fix the scheduler', args: { title: 'Fix the scheduler' }, link: 'https://linear.app/novus/issue/PX-197/fix-the-scheduler' })),
    'Created PX-197 · Fix the scheduler',
  )
  assert.equal(actionTitle(rec({ kind: 'comment', status: 'failed', summary: 'gh pr comment 2784' })), 'Comment on PR #2784')
  assert.equal(
    actionTitle(rec({ kind: 'message', status: 'needs_you', tool: TOOL, summary: 'Slack send message: hi', args: { channel_id: 'C0123ABCD', text: 'The scheduler skips the first slot' } })),
    'Send a message · The scheduler skips the first slot',
  )
  assert.equal(
    actionTitle(rec({ kind: 'post', status: 'needs_you', tool: 'mcp__typefully__schedule_post', summary: 'Schedule post: Shipped', args: { text: 'Shipped a thing' } })),
    'Schedule a post · Shipped a thing',
  )
  assert.equal(actionTitle(rec({ kind: 'other', status: 'succeeded', summary: 'gh api -X POST repos/o/r/labels' })), 'gh api -X POST repos/o/r/labels')
})

test('counted: plain words, never the pattern grammar', () => {
  assert.equal(countedText(rec({ tool: 'Bash', why: 'bash pattern', whyDetail: 'git push !--dry-run|-n', args: { command: 'git add -A && git push -u origin feat' } })), 'matches `git push`')
  assert.equal(countedText(rec({ tool: 'Bash', why: 'bash pattern', whyDetail: 'npm|pnpm|yarn|bun publish', args: { command: 'pnpm publish --access public' } })), 'matches `pnpm publish`')
  // The command clipped away: the pattern's own first words, flags left out.
  assert.equal(countedText(rec({ tool: 'Bash', why: 'bash pattern', whyDetail: 'gh pr comment|review', args: {} })), 'matches `gh pr comment`')
  assert.equal(countedText(rec({ tool: 'Bash', why: 'bash pattern', whyDetail: 'git push !--dry-run|-n, gh pr create', args: { command: 'git push && gh pr create --fill' } })), 'matches `git push` and `gh pr create`')
  assert.equal(countedText(rec({ tool: TOOL, why: 'name verb', whyDetail: 'send' })), '“send” in the tool name')
  assert.equal(countedText(rec({ tool: TOOL, why: 'annotation', whyDetail: 'destructive' })), 'the server marks it destructive')
  assert.equal(countedText(rec({ tool: TOOL, why: 'unknown', whyDetail: null })), 'an unknown tool — counted to be safe')
})

// ---------------------------------------------------------------------------
// Flow: a pending action is the item's "my turn"
// ---------------------------------------------------------------------------

test('flow: an action waiting on approval puts the item on my turn, in Ready for your approval', () => {
  const item: WorkItem = {
    id: 'github:o/r#1',
    source: 'github',
    kind: 'review-requested',
    title: 't',
    url: '',
    repo: 'o/r',
    author: '',
    peopleWaiting: 1,
    createdAt: new Date(T0 - 86_400_000).toISOString(),
    updatedAt: new Date(T0 - 86_400_000).toISOString(),
    ingestedAt: T0 - 86_400_000,
    status: 'open',
  } as WorkItem
  const running = flowOf(item, { session: { running: true, waiting: false, error: false, at: T0 - 1000 }, actions: { pending: 1, at: T0 } })
  assert.deepEqual([running.stage, running.turn, running.next], ['review', 'me', 'approve action'])
  // A review request is a human ask (People waiting), but a queued action outranks it.
  assert.equal(inboxTabOf({ ...item, ask: askOf(item), score: 1, flow: running }, T0), 'needs')
  const none = flowOf(item, { session: { running: true, waiting: false, error: false, at: T0 - 1000 }, actions: { pending: 0, at: T0 } })
  assert.equal(none.turn, 'ai')
  // An override older than the action gives way to it.
  const o = flowOf(item, { override: { turn: 'others', at: T0 - 5000 }, actions: { pending: 2, at: T0 } })
  assert.equal(o.next, 'approve action')
})

// ---------------------------------------------------------------------------
// The store: one claim wins; history in order; the tracker leaves a held call alone
// ---------------------------------------------------------------------------

function freshStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'junior-actions-q-'))
  return openSqliteStore(path.join(dir, 'junior.db'))
}

test('store: queue state round-trips; a claim moves a due row once', async () => {
  const store = freshStore()
  const a = held({ ...ARGS, text: 'y'.repeat(3000) })
  await store.actions.put(a)
  const back = await store.actions.get(a.id)
  assert.deepEqual(back?.queue, a.queue)
  assert.equal((await store.actions.list({ status: ['needs_you'] })).length, 1)
  const s = ok(a, { type: 'approve' }, T0)
  await store.actions.put(s)
  const due = T0 + UNDO_MS
  const [first, second] = await Promise.all([
    store.actions.claim(a.id, 'scheduled', 'sending', due, { dueBy: due }),
    store.actions.claim(a.id, 'scheduled', 'sending', due, { dueBy: due }),
  ])
  assert.deepEqual([first, second].sort(), [false, true])
  assert.equal((await store.actions.get(a.id))?.status, 'sending')
  await store.close()
})

test('store: history is append-only, oldest first, per action', async () => {
  const store = freshStore()
  const a = held()
  await store.actions.put(a)
  await store.actions.addHistory(heldEntry(a, a.queue!.args, T0))
  const r = move(a, { type: 'approve', args: { ...ARGS, text: 'v2' } }, T0 + 1)
  assert.ok(r.ok)
  await store.actions.addHistory(r.entry)
  const h = (await store.actions.history([a.id, 'nope'])).get(a.id)!
  assert.deepEqual(h.map((e) => e.event), ['queued', 'edited and approved'])
  assert.equal(h[0].args?.text, ARGS.text)
  assert.equal(h[1].args?.text, 'v2')
  await store.close()
})

test('track: the "queued" refusal never settles a held record', async () => {
  const store = freshStore()
  const a = held()
  await store.actions.put(a)
  await applyActionOps(store.actions, [
    { op: 'attempt', record: { ...a, status: 'attempted', queue: null } },
    {
      op: 'settle',
      sessionId: 's1',
      toolUseId: 'tu1',
      patch: { status: 'failed', link: null, error: queuedMessage(a.id), allowedBy: null, allowedDetail: null, settledAt: T0 + 5 },
    },
  ])
  const after = await store.actions.get(a.id)
  assert.equal(after?.status, 'needs_you')
  assert.equal(after?.error, null)
  await store.close()
})

test('P2 regression: a repeated held call joins the waiting action — no phantom row', async () => {
  const store = freshStore()
  const a = held()
  await store.actions.put(a)
  const sorted = sortCall(TOOL, ARGS, { rules: DEFAULT_RULES })!
  // The repeat's message was recorded before the hook answered: a phantom attempt.
  await applyActionOps(store.actions, [{ op: 'attempt', record: recordFor(ctx, 'tu2', TOOL, ARGS, sorted, T0 + 10) }])
  assert.equal((await store.actions.list()).length, 2)
  const joined = await joinHeldCall(store.actions, 's1', 'tu2', a.id)
  assert.deepEqual(joined?.calls, ['tu1', 'tu2'])
  assert.deepEqual((await store.actions.list()).map((r) => r.id), [a.id])
  // Its "queued" refusal then settles nothing, and a third repeat (hook first) adds no row either.
  await applyActionOps(store.actions, [
    { op: 'settle', sessionId: 's1', toolUseId: 'tu2', patch: { status: 'failed', link: null, error: 'queued', allowedBy: null, allowedDetail: null, settledAt: T0 + 11 } },
  ])
  await joinHeldCall(store.actions, 's1', 'tu3', a.id)
  await applyActionOps(store.actions, [{ op: 'attempt', record: recordFor(ctx, 'tu3', TOOL, ARGS, sorted, T0 + 12) }])
  const all = await store.actions.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].status, 'needs_you')
  assert.deepEqual(all[0].calls, ['tu1', 'tu2', 'tu3'])
  await store.close()
})

// ---------------------------------------------------------------------------
// Re-validation fixes
// ---------------------------------------------------------------------------

test('fix 1: a claude.ai connector missing from init is not "not connected" unless the run found no tool', () => {
  const slack = 'claude_ai_Slack'
  const quiet = dispatchOutcome({ allowed: false, connector: 'missing', denials: [] }, slack)
  assert.equal(quiet.status, 'failed')
  assert.doesNotMatch(quiet.error ?? '', /not connected/)
  assert.equal(dispatchOutcome({ allowed: false, connector: 'missing', noTool: true }, slack).error, `connector not connected: ${slack}`)
  assert.equal(dispatchOutcome({ allowed: false, connector: 'failed' }, slack).error, `connector not connected: ${slack}`)
  // Any other server missing from the run is genuinely absent.
  assert.equal(dispatchOutcome({ allowed: false, connector: 'missing' }, 'linear').error, 'connector not connected: linear')
})

test('fix 2: countdowns read at any length', () => {
  assert.equal(countdownText(9_000), 'in 9s')
  assert.equal(countdownText(8_100), 'in 9s', 'rounded up')
  assert.equal(countdownText(60_000), 'in 1m')
  assert.equal(countdownText(250_000), 'in 4m 10s')
  assert.equal(countdownText((2 * 3600 + 58 * 60) * 1000), 'in 2h 58m')
  assert.equal(countdownText(6 * 3600 * 1000), 'in 6h')
  assert.equal(countdownText((3 * 86_400 + 4 * 3600) * 1000), 'in 3d 4h')
  assert.equal(countdownText(-5), 'in 0s')
})

test('fix 7: the Today line says how many failed', () => {
  assert.equal(countLine([{ kind: 'pr', n: 1 }, { kind: 'push', n: 4 }], 1), 'Today: 1 PR, 4 pushes · 1 failed')
  assert.equal(countLine([], 2), 'Today: nothing has gone out yet · 2 failed')
  assert.equal(countLine([{ kind: 'pr', n: 1 }], 0), 'Today: 1 PR')
})

test('fix 8: a redraft is a ledger row of its own, counted in the day’s spend', async () => {
  const store = freshStore()
  await store.jobRuns.insert({ jobId: 'w1', slot: T0, trigger: 'scheduled', status: 'ok', sessionId: 's1', startedAt: T0, endedAt: T0 + 1, costUsd: 0.2 })
  await store.jobRuns.insert({ jobId: 'w1', slot: T0 + 5000, trigger: 'redraft', status: 'running', sessionId: 's1', startedAt: T0 + 5000 })
  await store.jobRuns.finish('w1', T0 + 5000, { status: 'ok', sessionId: 's1', endedAt: T0 + 9000, costUsd: 0.05 })
  const rows = await store.jobRuns.list('w1')
  assert.deepEqual(rows.map((r) => [r.trigger, r.status]), [['redraft', 'ok'], ['scheduled', 'ok']])
  assert.ok(Math.abs((await store.jobRuns.spentSince('w1', T0 - 1)) - 0.25) < 1e-9)
  await store.close()
})

// ---------------------------------------------------------------------------
// Held outbound Bash (goals M0): `git push` / `gh pr create` in a held session
// are Actions too — sorted, held, and dispatched as the one approved command.

test('outbound Bash sorts as an action and is holdable; local Bash is not an action', () => {
  assert.equal(holdable('Bash'), true)
  assert.equal(holdable(TOOL), true)
  assert.equal(holdable('Write'), false)
  assert.ok(sortCall('Bash', { command: 'git push origin feat/x' }, { rules: DEFAULT_RULES }))
  assert.ok(sortCall('Bash', { command: 'gh pr create --title x --body y' }, { rules: DEFAULT_RULES }))
  assert.equal(sortCall('Bash', { command: 'git status' }, { rules: DEFAULT_RULES }), null)
  // Inside a loop, a branch or a substitution, a push is still a push.
  for (const command of ['for b in a c; do git push origin $b; done', 'if true; then gh pr create --fill; fi', 'echo $(git push)', 'echo "`git push`"']) {
    assert.equal(sortCall('Bash', { command }, { rules: DEFAULT_RULES })?.kind != null, true, command)
  }
  const looped = held({ command: 'for b in a c; do git push origin $b; done' }, 'Bash')
  assert.equal(looped.status, 'needs_you')
  assert.equal(looped.kind, 'push')
})

test('a held push is its own action and keeps its command whole', () => {
  const cmd = 'git push -u origin feat/goals-and-teams'
  const rec = held({ command: cmd, description: 'Push the branch' }, 'Bash')
  assert.equal(rec.status, 'needs_you')
  assert.equal(rec.groupKey, null)
  assert.equal(rec.args.command, cmd)
})

test('Bash dispatch fence: the approved command, in the foreground, once', () => {
  const cmd = 'gh pr create --title "Goals" --body "M0"'
  const f = new DispatchFence('Bash', { command: cmd, description: 'Open the PR' })
  assert.equal(f.decide('Bash', { command: `${cmd} --draft` }).allow, false)
  assert.equal(f.decide('Bash', { command: cmd, run_in_background: true }).allow, false)
  assert.equal(f.decide(TOOL, ARGS).allow, false)
  assert.equal(f.allowed, false)
  // Its own description and timeout are the run's to write.
  assert.deepEqual(f.decide('Bash', { command: cmd, description: 'Create pull request', timeout: 60_000 }, 'tu-b'), { allow: true })
  assert.equal(f.allowedCall, 'tu-b')
  assert.equal(f.decide('Bash', { command: cmd }).allow, false, 'once')
  const p = dispatchPrompt('Bash', { command: cmd })
  assert.ok(p.includes(cmd))
  assert.doesNotMatch(p, /ToolSearch/)
})

test('a dispatched push links to the pushed branch', () => {
  const out = 'To github.com:usejunior-sh/junior.git\n * [new branch]      feat/x -> feat/x\n'
  const o = dispatchOutcome({ allowed: true, connector: null, result: { isError: false, text: out } }, 'Bash', { bash: true, push: true })
  assert.equal(o.status, 'succeeded')
  assert.equal(o.link, 'https://github.com/usejunior-sh/junior/tree/feat/x')
})

test('settledMessage: a chat hears how its approved action ended', async () => {
  const { settledMessage } = await import('../core/actions/queue.js')
  const base = { id: 's1:toolu_abcdef123', summary: 'Slack message to Anirudha', link: null, error: null, queue: null }
  const sent = settledMessage({ ...base, status: 'succeeded', link: 'https://slack.com/archives/D1/p2' })
  assert.match(sent, /approved and sent: https:\/\/slack\.com\/archives\/D1\/p2/)
  assert.match(sent, /Carry on/)
  const edited = settledMessage({ ...base, status: 'succeeded', queue: { edits: 1 } as never })
  assert.match(edited, /their version/)
  assert.match(settledMessage({ ...base, status: 'failed', error: 'channel_not_found' }), /failed: channel_not_found\. Don't retry/)
  assert.match(settledMessage({ ...base, status: 'unknown', error: 'timed out' }), /can't tell whether it went out/)
})
