/**
 * Won't fix and Incorrect replies wait for the user (plan item
 * bot-triage-send): a finished triage's non-fix verdicts become one task on
 * the user; the send path posts only on the user's Send or an advance
 * approval they wrote; each reply is its own log record; the user's approved
 * verdicts feed the tally. The pure half (core/babysit/bot-replies.ts), then
 * the send path (server/tasks/bot-replies.ts) over a real sqlite store with
 * GitHub stood in for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { approvalFrom, BOT_REPLY_TOOL, matchApproval, type AdvanceApproval } from '../core/approvals/approvals.js'
import {
  BOT_REPLY_STEP,
  BOT_TALLY_KEY,
  botRepliesOf,
  replyEditsFrom,
  replyPlan,
  repliesTask,
  SEND_BOT_REPLIES_STEP,
  sendCommandLine,
  sentLine,
  tallyFrom,
  tallyWith,
  verdictRecords,
  type BotReply,
} from '../core/babysit/bot-replies.js'
import { tallyFor, type Tally, type Verdict } from '../core/babysit/bot-triage.js'
import type { TriageThread } from '../core/babysit/watch.js'
import type { WorkItem } from '../core/work/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-bot-replies-'))
process.env.JUNIOR_HOME = home
process.env.JUNIOR_NO_NOTIFY = '1'
const { openSqliteStore } = await import('../core/store/sqlite.js')
const { sendBotRepliesOp, botRepliesUnderApproval } = await import('../server/tasks/bot-replies.js')

const thread = (id: string, over: Partial<TriageThread> = {}): TriageThread => ({
  id,
  author: 'coderabbitai',
  isBot: true,
  resolved: false,
  path: `src/${id.toLowerCase()}.ts`,
  body: '_🧹 Nitpick_\n\nRename `x` to `count`.',
  url: `https://gh/${id}`,
  bot: 'CodeRabbit',
  rule: 'nitpick',
  message: 'Rename `x` to `count`.',
  ...over,
})

const THREADS = [thread('T1'), thread('T2'), thread('T3', { author: 'cursor', bot: 'Bugbot', rule: 'bug' }), thread('T4')]
const VERDICTS: Verdict[] = [
  { threadId: 'T1', verdict: 'fix' },
  { threadId: 'T2', verdict: 'wont-fix', reply: 'Keeping `x`: it matches the paper.' },
  { threadId: 'T3', verdict: 'incorrect', reply: 'The null case is handled in `load()` above.', why: 'guarded upstream' },
  { threadId: 'T4', verdict: 'wont-fix', reply: "Out of scope for this PR, it's tracked in #88." },
]

const repliesOf = (): BotReply[] => botRepliesOf(repliesTask('tri1', THREADS, VERDICTS)!.input)

// ── the task on you ─────────────────────────────────────────────────────────

test('a triage’s non-fix verdicts become one task on you, waiting, with the drafted text per thread', () => {
  const spec = repliesTask('tri1', THREADS, VERDICTS)
  assert.ok(spec)
  assert.equal(spec.owner, 'you')
  assert.equal(spec.state, 'waiting')
  assert.equal(spec.step, SEND_BOT_REPLIES_STEP)
  assert.equal(spec.key, 'bot-replies:tri1')
  assert.equal(spec.title, 'Send 3 bot replies')
  assert.equal(spec.whyDetail, "2 won't fix, 1 incorrect")
  const replies = botRepliesOf(spec.input)
  assert.deepEqual(
    replies.map((r) => [r.threadId, r.verdict, r.bot, r.reply]),
    [
      ['T2', 'wont-fix', 'CodeRabbit', 'Keeping `x`: it matches the paper.'],
      ['T3', 'incorrect', 'Bugbot', 'The null case is handled in `load()` above.'],
      ['T4', 'wont-fix', 'CodeRabbit', "Out of scope for this PR, it's tracked in #88."],
    ],
  )
  // one bot: named in the title
  assert.equal(repliesTask('tri2', THREADS, [VERDICTS[1]!])!.title, 'Send 1 reply to CodeRabbit')
})

test('every verdict a fix, or verdicts for threads the triage never carried: no task', () => {
  assert.equal(repliesTask('tri1', THREADS, [{ threadId: 'T1', verdict: 'fix' }]), null)
  assert.equal(repliesTask('tri1', THREADS, [{ threadId: 'T9', verdict: 'wont-fix', reply: 'no' }]), null)
})

test('a malformed reply on the task is dropped when read back, never sent', () => {
  const read = botRepliesOf({ replies: [{ threadId: 'T1', verdict: 'fix', reply: 'x' }, { threadId: 'T2', verdict: 'wont-fix', reply: '  ' }, { threadId: 'T3', verdict: 'incorrect', reply: 'ok' }, 'junk'] })
  assert.deepEqual(read.map((r) => r.threadId), ['T3'])
})

// ── the send path's decision ────────────────────────────────────────────────

test('under a rule, a reply no approval covers never goes out: it waits for you', () => {
  const plan = replyPlan(repliesOf(), [], { by: 'rule', covers: () => null })
  assert.equal(plan.sends.length, 0)
  assert.equal(plan.fixes.length, 0)
  assert.deepEqual(plan.waiting.map((r) => r.threadId), ['T2', 'T3', 'T4'])
})

test('under a rule, only the covered bot’s replies go, as Junior drafted them; edits are ignored', () => {
  const edits = replyEditsFrom({ threads: [{ threadId: 'T2', reply: 'changed', verdict: 'fix' }] })
  const plan = replyPlan(repliesOf(), [], { by: 'rule', covers: (r) => (r.author === 'coderabbitai' ? 'a1' : null) }, edits)
  assert.deepEqual(plan.sends.map((s) => [s.reply.threadId, s.allowedBy, s.approvalId, s.body]), [
    ['T2', 'rule', 'a1', 'Keeping `x`: it matches the paper.'],
    ['T4', 'rule', 'a1', "Out of scope for this PR, it's tracked in #88."],
  ])
  assert.deepEqual(plan.waiting.map((r) => r.threadId), ['T3'])
})

test('your Send: your text wins, a verdict you turn into Fix is a fix not a reply, handled threads are skipped', () => {
  const edits = replyEditsFrom({ threads: [{ threadId: 'T3', verdict: 'fix' }, { threadId: 'T4', reply: '  Later, in #88.  ', verdict: 'incorrect' }, { threadId: 'T2', verdict: 'maybe' }] })
  const plan = replyPlan(repliesOf(), ['T2'], { by: 'you' }, edits)
  assert.deepEqual(plan.sends.map((s) => [s.reply.threadId, s.verdict, s.body, s.allowedBy]), [['T4', 'incorrect', 'Later, in #88.', 'you']])
  assert.deepEqual(plan.fixes.map((r) => r.threadId), ['T3'])
  // an unknown verdict leaves Junior's standing
  assert.equal(replyPlan(repliesOf(), [], { by: 'you' }, edits).sends.find((s) => s.reply.threadId === 'T2')?.verdict, 'wont-fix')
})

test('an empty reply you wrote is refused before anything is claimed', () => {
  assert.throws(() => replyPlan(repliesOf(), [], { by: 'you' }, replyEditsFrom({ threads: [{ threadId: 'T2', reply: '   ' }] })), /empty/)
})

test('the log record’s command is the send word for word, quotes escaped', () => {
  const line = sendCommandLine('PRRT_1', "it's fine")
  assert.match(line, /addPullRequestReviewThreadReply/)
  assert.match(line, /-f id=PRRT_1/)
  assert.match(line, /'body=it'\\''s fine'/)
  assert.match(line, /&& gh api graphql .*resolveReviewThread/)
})

test('the task’s line', () => {
  assert.equal(sentLine(3, 0, 0, 0), 'Sent 3 replies')
  assert.equal(sentLine(1, 0, 0, 0), 'Sent 1 reply')
  assert.equal(sentLine(2, 1, 0, 0), 'Sent 2 replies, 1 to fix')
  assert.equal(sentLine(1, 0, 2, 0), 'Sent 1 of 3: 2 failed')
  assert.equal(sentLine(2, 0, 0, 1), 'Sent 2 of 3: 1 wait for you')
  assert.equal(sentLine(0, 2, 0, 0), '2 threads to fix, no replies')
})

// ── the tally ───────────────────────────────────────────────────────────────

test('approved verdicts update the tally: yours count, a rule’s don’t, a change counts as changed', () => {
  const replies = repliesOf()
  const mine = replyPlan(replies, [], { by: 'you' }, replyEditsFrom({ threads: [{ threadId: 'T3', verdict: 'fix' }, { threadId: 'T4', verdict: 'incorrect' }] }))
  let tally: Tally = tallyWith({}, verdictRecords('Acme/API', mine.sends, mine.fixes))
  const cr = tallyFor(tally, 'acme/api', 'CodeRabbit', 'nitpick')!
  assert.deepEqual([cr['wont-fix'], cr.incorrect, cr.fix, cr.total, cr.changed], [1, 1, 0, 2, 1])
  const bb = tallyFor(tally, 'acme/api', 'Bugbot', 'bug')!
  assert.deepEqual([bb.fix, bb.total, bb.changed], [1, 1, 1])

  const ruled = replyPlan(replies, [], { by: 'rule', covers: () => 'a1' })
  const after = tallyWith(tally, verdictRecords('acme/api', ruled.sends, ruled.fixes))
  assert.deepEqual(after, tally)

  // it round-trips through config, and junk reads as nothing
  tally = tallyFrom(JSON.parse(JSON.stringify(tally)))
  assert.equal(tallyFor(tally, 'acme/api', 'CodeRabbit', 'nitpick')?.total, 2)
  assert.deepEqual(tallyFrom({ x: { repo: 'a', bot: 'Nobody', rule: 'r', fix: 1 } }), {})
  assert.deepEqual(tallyFrom('nope'), {})
})

// ── advance approvals ───────────────────────────────────────────────────────

function botApproval(login: string, when?: { playbook: string; step: string }): AdvanceApproval {
  const r = approvalFrom({ what: 'bot-reply', who: { id: login, name: 'CodeRabbit' }, why: 'nits', ...(when ? { when: { kind: 'playbook', ...when } } : {}) }, { id: `ab12cd34-${login}`, now: 1, sessionId: null, proposalId: null })
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.approval
}

test('a bot-reply approval names the bot by login ([bot] dropped) and covers only that bot, at its step', () => {
  const a = botApproval('coderabbitai[bot]', BOT_REPLY_STEP)
  assert.equal(a.who.id, 'coderabbitai')
  const ctx = { playbook: BOT_REPLY_STEP }
  assert.equal(matchApproval([a], BOT_REPLY_TOOL, { bot: 'coderabbitai[bot]' }, ctx, 2)?.id, a.id)
  assert.equal(matchApproval([a], BOT_REPLY_TOOL, { bot: 'CodeRabbitAI' }, ctx, 2)?.id, a.id)
  assert.equal(matchApproval([a], BOT_REPLY_TOOL, { bot: 'cursor' }, ctx, 2), null)
  assert.equal(matchApproval([a], BOT_REPLY_TOOL, { bot: 'coderabbitai' }, {}, 2), null)
  // never a Bash call: the agent can't borrow it
  assert.equal(matchApproval([a], 'Bash', { command: 'gh api graphql -f id=PRRT_1' }, ctx, 2), null)
})

// ── the send path, end to end ───────────────────────────────────────────────

const ITEM: WorkItem = {
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
}

async function withRuntime(fn: (rt: WorkspaceRuntime, calls: string[][]) => Promise<void>) {
  const dir = mkdtempSync(path.join(home, 'ws-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = {
    meta: { id: 'ws-test' },
    store,
    clients: new Set(),
    heldCalls: new Map(),
    ruleAllowed: new Map(),
    actionChain: Promise.resolve(),
    actionsDirty: null,
    inboxCache: null,
  } as unknown as WorkspaceRuntime
  const calls: string[][] = []
  try {
    await store.items.upsert(ITEM)
    await fn(rt, calls)
  } finally {
    await rt.actionChain
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const fakeGh = (calls: string[][], failThread?: string) => async (args: string[]) => {
  calls.push(args)
  const id = args.find((a) => a.startsWith('id='))?.slice(3)
  if (failThread && id === failThread && args.some((a) => a.includes('addPullRequestReviewThreadReply'))) throw new Error('gh api failed: 502')
  return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: `https://github.com/acme/api/pull/12#c-${id}` } } } })
}

async function addRepliesTask(rt: WorkspaceRuntime) {
  const spec = repliesTask('tri1', THREADS, VERDICTS)!
  const t = await rt.store.tasks.add({ ...spec, itemId: ITEM.id }, Date.now())
  assert.ok(t)
  assert.equal(t.state, 'waiting')
  return t
}

const replyCalls = (calls: string[][]) => calls.filter((c) => c.some((a) => a.includes('addPullRequestReviewThreadReply')))
const taskRecords = async (rt: WorkspaceRuntime, taskId: string) => (await rt.store.actions.list()).filter((r) => r.sessionId === `task-${taskId}`)

test('with no approval, nothing posts on its own: the task waits, GitHub is never called', () =>
  withRuntime(async (rt, calls) => {
    const t = await addRepliesTask(rt)
    assert.equal(await botRepliesUnderApproval(rt, t, fakeGh(calls)), false)
    assert.equal(calls.length, 0)
    assert.equal((await rt.store.tasks.get(t.id))?.state, 'waiting')
    assert.equal((await taskRecords(rt, t.id)).length, 0)
  }))

test('your Send posts each reply, resolves each thread, one log record per reply, and the tally learns', () =>
  withRuntime(async (rt, calls) => {
    const t = await addRepliesTask(rt)
    const done = await sendBotRepliesOp(rt, t.id, { threads: [{ threadId: 'T4', reply: 'Tracked in #88.' }] }, fakeGh(calls))
    assert.equal(done.state, 'done')
    assert.equal(done.output?.summary, 'Sent 3 replies')
    assert.deepEqual([...(done.output?.handled ?? [])].sort(), ['T2', 'T3', 'T4'])
    assert.equal(replyCalls(calls).length, 3)
    assert.equal(calls.filter((c) => c.some((a) => a.includes('resolveReviewThread'))).length, 3)
    assert.ok(replyCalls(calls).some((c) => c.includes('body=Tracked in #88.')))

    await rt.actionChain
    const recs = await taskRecords(rt, t.id)
    assert.equal(recs.length, 3)
    assert.ok(recs.every((r) => r.status === 'succeeded' && r.allowedBy === 'prompt' && r.kind === 'comment'))
    assert.ok(recs.some((r) => r.link === 'https://github.com/acme/api/pull/12#c-T3'))

    const tally = tallyFrom(await rt.store.config.get(BOT_TALLY_KEY))
    assert.equal(tallyFor(tally, 'acme/api', 'CodeRabbit', 'nitpick')?.['wont-fix'], 2)
    assert.equal(tallyFor(tally, 'acme/api', 'Bugbot', 'bug')?.incorrect, 1)

    // sent once: a second Send is refused
    await assert.rejects(sendBotRepliesOp(rt, t.id, {}, fakeGh(calls)), /only waiting/)
  }))

test('a verdict you turn into Fix adds a fix task on Junior and posts nothing on that thread', () =>
  withRuntime(async (rt, calls) => {
    const t = await addRepliesTask(rt)
    await sendBotRepliesOp(rt, t.id, { threads: [{ threadId: 'T3', verdict: 'fix' }] }, fakeGh(calls))
    assert.ok(!replyCalls(calls).some((c) => c.includes('id=T3')))
    const fix = (await rt.store.tasks.list(ITEM.id)).find((x) => x.key === 'thread:T3')
    assert.equal(fix?.owner, 'junior')
    assert.equal(fix?.step, 'fix-thread')
  }))

test('a reply that fails keeps the task waiting with the rest handled; Send again posts only what is left', () =>
  withRuntime(async (rt, calls) => {
    const t = await addRepliesTask(rt)
    const after = await sendBotRepliesOp(rt, t.id, {}, fakeGh(calls, 'T3'))
    assert.equal(after.state, 'waiting')
    assert.match(after.error ?? '', /502/)
    assert.deepEqual([...(after.output?.handled ?? [])].sort(), ['T2', 'T4'])
    await rt.actionChain
    const recs = await taskRecords(rt, t.id)
    assert.deepEqual(recs.map((r) => r.status).sort(), ['failed', 'succeeded', 'succeeded'])

    calls.length = 0
    const done = await sendBotRepliesOp(rt, t.id, {}, fakeGh(calls))
    assert.equal(done.state, 'done')
    assert.deepEqual(replyCalls(calls).map((c) => c.find((a) => a.startsWith('id='))), ['id=T3'])
  }))

test('an approval you wrote for one bot sends that bot’s replies alone; the rest wait; the tally skips them', () =>
  withRuntime(async (rt, calls) => {
    await rt.store.approvals.put(botApproval('coderabbitai', BOT_REPLY_STEP))
    const t = await addRepliesTask(rt)
    assert.equal(await botRepliesUnderApproval(rt, t, fakeGh(calls)), false)
    assert.deepEqual(replyCalls(calls).map((c) => c.find((a) => a.startsWith('id='))), ['id=T2', 'id=T4'])
    const after = (await rt.store.tasks.get(t.id))!
    assert.equal(after.state, 'waiting')
    assert.deepEqual(after.output?.handled, ['T2', 'T4'])
    await rt.actionChain
    const recs = await taskRecords(rt, t.id)
    assert.equal(recs.length, 2)
    assert.ok(recs.every((r) => r.allowedBy === 'rule' && /reply to CodeRabbit/.test(r.allowedDetail ?? '')))
    assert.deepEqual(tallyFrom(await rt.store.config.get(BOT_TALLY_KEY)), {})
    assert.equal((await rt.store.approvals.list())[0]?.uses, 2)
  }))
