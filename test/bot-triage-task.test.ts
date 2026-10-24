/**
 * Bot threads on a handed-off PR become one triage task (plan item
 * bot-triage-task): the grouping in the watch, the triage task's hand-in
 * (verdicts, fix tasks, the line), its prompt, and the tick end to end
 * against a real sqlite store and a fake GitHub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrThread } from '../core/babysit/ci.js'
import {
  afterDecision,
  batchBotThreads,
  decide,
  MAX_TRIAGE_THREADS,
  newBabysitWatch,
  TRIAGE_BOT_STEP,
  triageResult,
  triageTask,
  triageThreadsOf,
  type BabysitEvent,
} from '../core/babysit/watch.js'
import { triagePrompt } from '../core/babysit/brief.js'
import { heldBy } from '../core/work/handoff.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { ItemTask } from '../core/work/tasks.js'
import { babysitTickOp, type BabysitDeps } from '../server/babysit/watch.js'

const thread = (over: Partial<PrThread> = {}): PrThread => ({ id: 'T1', author: 'coderabbitai', isBot: true, resolved: false, path: 'src/api.ts', body: '_🧹 Nitpick_\n\nRename `x` to `count`.', url: 'https://gh/t1', ...over })
const ctx = { base: 'main', isDraft: false, reviewer: null }
const evOf = (t: PrThread): BabysitEvent => ({ kind: 'bot_thread', thread: t })

test('three new review-bot threads are grouped into one triage event, where the first stood', () => {
  const evs: BabysitEvent[] = [
    { kind: 'checks_failed', sha: 's1', check: { name: 'lint', status: 'failure', id: 'c', runId: 1, url: null, conclusion: 'FAILURE' } },
    evOf(thread({ id: 'T1' })),
    { kind: 'human_thread', thread: thread({ id: 'H1', author: 'priya', isBot: false }) },
    evOf(thread({ id: 'T2', author: 'cursor', body: '### Bug: off by one' })),
    evOf(thread({ id: 'T3', author: 'copilot-pull-request-reviewer[bot]', body: 'Consider a const here.' })),
  ]
  const out = batchBotThreads(evs, newBabysitWatch())
  assert.deepEqual(out.map((e) => e.kind), ['checks_failed', 'bot_triage', 'human_thread'])
  const tri = out[1]
  assert.ok(tri?.kind === 'bot_triage')
  assert.deepEqual(tri.threads.map((t) => t.id), ['T1', 'T2', 'T3'])
})

test("another bot's thread, a thread already taken, and one that came back are not triaged", () => {
  const w = { ...newBabysitWatch(), botThreads: ['T1'] }
  const cameBack = thread({ id: 'T9', body: 'Unused variable', author: 'cursor' })
  const w2 = afterDecision(w, evOf(cameBack), decide(evOf(cameBack), newBabysitWatch(), ctx))
  const out = batchBotThreads([evOf(thread({ id: 'T1' })), evOf(thread({ id: 'S1', author: 'sonarcloud' })), evOf(thread({ id: 'T10', body: 'Unused variable', author: 'cursor' }))], w2)
  assert.deepEqual(out.map((e) => e.kind), ['bot_thread', 'bot_thread', 'bot_thread'])
  // and decide keeps their old paths: taken = nothing, sonarcloud = a fix task, came back = you
  assert.equal(decide(out[0]!, w2, ctx).do, 'none')
  const sonar = decide(out[1]!, w2, ctx)
  assert.ok(sonar.do === 'task' && sonar.task.step === 'fix-thread')
  const back = decide(out[2]!, w2, ctx)
  assert.ok(back.do === 'task' && back.stuck && back.task.owner === 'you')
})

test('one triage task per batch, capped; the watch takes every thread in it', () => {
  const many = Array.from({ length: MAX_TRIAGE_THREADS + 3 }, (_, i) => evOf(thread({ id: `T${i}`, body: `comment ${'x'.repeat(i)}` })))
  const out = batchBotThreads(many, newBabysitWatch())
  assert.equal(out.length, 1)
  const ev = out[0]!
  assert.ok(ev.kind === 'bot_triage' && ev.threads.length === MAX_TRIAGE_THREADS, 'the rest wait for the next poll')
  const d = decide(ev, newBabysitWatch(), ctx)
  assert.ok(d.do === 'task')
  assert.equal(d.task.step, TRIAGE_BOT_STEP)
  assert.equal(d.task.owner, 'junior')
  assert.equal(d.task.title, `Triage ${MAX_TRIAGE_THREADS} bot comments`)
  const w = afterDecision(newBabysitWatch(), ev, d)
  assert.equal(w.botThreads?.length, MAX_TRIAGE_THREADS)
  assert.equal(w.botPrints.length, MAX_TRIAGE_THREADS)
  // next poll: the 20 taken are left alone, the 3 left over make the next batch
  const next = batchBotThreads(many, w)
  const batches = next.filter((e) => e.kind === 'bot_triage')
  assert.ok(batches.length === 1 && batches[0]!.kind === 'bot_triage' && batches[0]!.threads.length === 3)
  assert.ok(next.filter((e) => e.kind === 'bot_thread').every((e) => decide(e, w, ctx).do === 'none'))
})

test('the triage task names the bot and file for one comment, and its key is the set of threads', () => {
  const one = triageTask([thread()])
  assert.equal(one.title, 'Triage coderabbitai comment on api.ts')
  assert.equal(one.whyDetail, '1 new comment from coderabbitai')
  const a = triageTask([thread({ id: 'A' }), thread({ id: 'B', author: 'cursor' })])
  const b = triageTask([thread({ id: 'B', author: 'cursor' }), thread({ id: 'A' })])
  assert.equal(a.key, b.key, 'same threads, same key: a batch read twice adds one task')
  assert.notEqual(a.key, triageTask([thread({ id: 'A' })]).key)
  assert.equal(a.whyDetail, '2 new comments from coderabbitai, Bugbot')
  const back = triageThreadsOf(a.input)
  assert.deepEqual(back.map((t) => [t.id, t.bot, t.rule]), [['A', 'CodeRabbit', 'nitpick'], ['B', 'Bugbot', 'nitpick']])
})

test('a triage task is a watch step: it runs only on a PR you handed off', () => {
  assert.equal(heldBy(TRIAGE_BOT_STEP, undefined), 'not handed off')
  assert.equal(heldBy(TRIAGE_BOT_STEP, 'paused'), 'you paused it')
  assert.equal(heldBy(TRIAGE_BOT_STEP, 'on'), null)
})

test('verdicts: fix becomes a fix task, replies stay on the task, unsure and malformed are fixes', () => {
  const threads = triageThreadsOf(triageTask([thread({ id: 'A' }), thread({ id: 'B' }), thread({ id: 'C' }), thread({ id: 'D' }), thread({ id: 'E' }), thread({ id: 'F' })]).input)
  const r = triageResult(threads, [
    { threadId: 'A', verdict: 'fix', why: 'real bug' },
    { threadId: 'B', verdict: 'wont-fix', reply: 'Out of scope for this PR.' },
    { threadId: 'C', verdict: 'Incorrect', reply: 'x is used on line 40.' },
    { threadId: 'D', verdict: 'unsure' },
    { threadId: 'E', verdict: 'incorrect' }, // no reply: a fix
    { threadId: 'nope', verdict: 'wont-fix', reply: 'not a thread here' },
    'garbage',
    // F: left out, a fix
  ])
  assert.deepEqual(r.verdicts.map((v) => [v.threadId, v.verdict]), [['A', 'fix'], ['B', 'wont-fix'], ['C', 'incorrect'], ['D', 'fix'], ['E', 'fix'], ['F', 'fix']])
  assert.deepEqual(r.fixes.map((f) => [f.step, f.key, f.owner]), [['fix-thread', 'thread:A', 'junior'], ['fix-thread', 'thread:D', 'junior'], ['fix-thread', 'thread:E', 'junior'], ['fix-thread', 'thread:F', 'junior']])
  assert.equal(r.fixes[0]!.input?.triage, 'real bug')
  assert.equal(r.fixes[0]!.input?.body, threads[0]!.body)
  const b = r.verdicts[1]!
  assert.ok(b.verdict === 'wont-fix' && b.reply === 'Out of scope for this PR.')
  assert.equal(r.summary, "4 to fix, 1 won't fix, 1 incorrect")
  // nothing handed in at all: every thread is a fix
  assert.equal(triageResult(threads, []).fixes.length, 6)
})

test('the triage prompt lists each thread id, reads only, and asks for submit_triage', () => {
  const spec = triageTask([thread({ id: 'PRRT_a' }), thread({ id: 'PRRT_b', author: 'cursor', path: null })])
  const t: ItemTask = { id: 't1', itemId: 'github:acme/api#12', title: spec.title, owner: 'junior', state: 'running', why: 'event', step: spec.step, input: spec.input, attempts: 1, createdAt: 0 }
  const p = triagePrompt(t, { repo: 'acme/api', number: 12, url: 'https://github.com/acme/api/pull/12', headRef: 'feat/x', baseRef: 'main' }, undefined, { diff: '+const x = 1' })
  assert.match(p, /`PRRT_a`/)
  assert.match(p, /`PRRT_b`/)
  assert.match(p, /CodeRabbit on src\/api\.ts \(nitpick\)/)
  assert.match(p, /Change nothing/)
  assert.match(p, /submit_triage/)
  assert.match(p, /Unsure\? Pick `fix`/)
  assert.match(p, /\+const x = 1/)
  assert.doesNotMatch(p, /git push/)
})

// ---------------------------------------------------------------------------
// The tick, end to end.

const T0 = Date.parse('2026-10-24T12:00:00Z')

const botThread = (id: string, login: string, body: string) => ({ id, isResolved: false, path: 'src/a.ts', comments: { nodes: [{ url: `https://gh/${id}`, body, author: { __typename: 'Bot', login } }] } })

const prNode = (number: number, threads: unknown[]) => ({
  __typename: 'PullRequest', number, title: `PR ${number}`, url: `https://github.com/acme/api/pull/${number}`, isDraft: false,
  createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T11:00:00Z', state: 'OPEN',
  repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } }, author: { login: 'samar' },
  headRefOid: `sha${number}`, headRefName: `feat/${number}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [] }, reviews: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', databaseId: 1, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null, checkSuite: { workflowRun: { databaseId: 9 } } }] } } } }] },
  reviewThreads: { nodes: threads },
})

async function harness(fn: (h: { store: Store; deps: BabysitDeps; nodes: unknown[]; added: ItemTask[]; handed: Set<number> }) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-bot-triage-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const nodes: unknown[] = []
  const added: ItemTask[] = []
  const handed = new Set<number>()
  const deps: BabysitDeps = {
    store,
    source: {
      login: async () => 'samar',
      search: async () => ({ data: { prs: { nodes } } }),
      failedLog: async () => '',
      rerun: async () => {},
      mainRuns: async () => [],
    },
    repos: async () => ['acme/api'],
    upsertItem: async (item) => {
      await store.items.upsert(item)
      const n = Number(item.id.split('#')[1])
      if (handed.has(n) && !(await store.items.get(item.id))?.handoff) await store.items.setFields(item.id, { handoff: 'on' })
    },
    reviewerFor: async () => null,
    added: (t) => void added.push(t),
    log: () => {},
  }
  try {
    await fn({ store, deps, nodes, added, handed })
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('three bot threads on one handed-off PR produce one triage task, once', () =>
  harness(async ({ store, deps, nodes, added, handed }) => {
    handed.add(40)
    nodes.push(prNode(40, [botThread('T1', 'coderabbitai', '_🧹 Nitpick_ rename'), botThread('T2', 'cursor', '### Bug: off by one'), botThread('T3', 'greptile-apps', 'Missing null check')]))
    assert.equal((await babysitTickOp(deps, T0, true))?.added, 1)
    const tasks = await store.tasks.list('github:acme/api#40')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]!.step, TRIAGE_BOT_STEP)
    assert.equal(tasks[0]!.title, 'Triage 3 bot comments')
    assert.deepEqual(triageThreadsOf(tasks[0]!.input).map((t) => t.id), ['T1', 'T2', 'T3'])
    assert.equal(added.length, 1)
    // the next poll sees the same threads: nothing more
    assert.equal((await babysitTickOp(deps, T0 + 60_000, true))?.added, 0)
    assert.equal((await store.tasks.list('github:acme/api#40')).length, 1)
  }))

test('no triage task on a PR without handoff on', () =>
  harness(async ({ store, deps, nodes, added }) => {
    nodes.push(prNode(41, [botThread('T1', 'coderabbitai', 'nit'), botThread('T2', 'cursor', 'bug'), botThread('T3', 'copilot', 'hmm')]))
    assert.equal((await babysitTickOp(deps, T0, true))?.added, 0)
    assert.equal((await store.tasks.list('github:acme/api#41')).length, 0)
    assert.equal(added.length, 0)
  }))
