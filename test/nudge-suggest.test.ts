/**
 * Due nudges are suggestions (plan item nudge-suggest): the Junior page marks
 * Waiting items with a due nudge and creates nothing; the babysit tick only
 * notes who was asked and since when; "Draft nudge" makes one task on you;
 * nothing goes out without your Send or an advance approval you wrote; the
 * route comes from the source descriptor (no reply route = Copy text); and a
 * nudge that went out starts the cooldown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { approvalFrom, type AdvanceApproval } from '../core/approvals/approvals.js'
import type { ApprovedSend } from '../core/playbooks/send.js'
import { NUDGE_STEP, NUDGES_SENT_KEY, nudgeMarks, nudgeRoute, nudgeSentWith, nudgesSentFrom, nudgeTask, pickWait, requestedSince, waitingOf } from '../core/work/nudge-suggest.js'
import type { ScoredItem } from '../core/work/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-nudge-'))
process.env.JUNIOR_HOME = home
process.env.JUNIOR_NO_NOTIFY = '1'
const { openSqliteStore } = await import('../core/store/sqlite.js')
const { draftNudgeOp, nudgeMarksOp, sendNudgeOp } = await import('../server/tasks/nudge.js')
const { BABYSIT_WATCH_KEY, babysitTickOp } = await import('../server/babysit/watch.js')

const DAY = 86_400_000
// Wednesday, Oct 21 2026, noon local
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime()

const item = (over: Partial<ScoredItem> & { id: string }): ScoredItem =>
  ({
    source: 'github',
    kind: 'own-pr-open',
    title: 'Add retries',
    url: 'https://github.com/acme/api/pull/12',
    repo: 'acme/api',
    author: 'samar',
    peopleWaiting: 0,
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
    score: 1,
    group: 'cycle',
    rankWhy: '',
    ask: 'read',
    reason: 'your-pr',
    status: 'open',
    ...over,
  }) as ScoredItem

const PR = item({ id: 'github:acme/api#12', seen: { red: [], bots: 0, people: 0, rebase: null, draft: false, reviewers: [{ login: 'ana', since: NOW - 7 * DAY }] } })
const SLACK = item({
  id: 'slack:C0123ABCD:1729500000.000100',
  source: 'slack',
  kind: 'job-hit',
  ask: 'follow-up',
  title: 'Is the 4.2 checklist final?',
  url: 'https://acme.slack.com/archives/C0123ABCD/p1729500000000100',
  repo: 'eng',
  author: 'priya',
  reason: 'asked',
  flow: { stage: 'new', turn: 'others', since: NOW - 6 * DAY },
})

// ── who an item waits on ─────────────────────────────────────────────────

test('waitingOf: your PR waits on the reviewers asked; a follow-up on its author; your turn names nobody', () => {
  assert.deepEqual(waitingOf(PR), [{ person: 'ana', since: NOW - 7 * DAY }])
  assert.deepEqual(waitingOf(SLACK), [{ person: 'priya', since: NOW - 6 * DAY }])
  // CI red: your move, not theirs
  assert.deepEqual(waitingOf({ ...PR, ciFailing: true }), [])
  // a session on a prompt holds it with you
  assert.deepEqual(waitingOf(PR, { blocked: true }), [])
  // a PR with nobody asked yet names nobody
  assert.deepEqual(waitingOf({ ...PR, seen: { ...PR.seen!, reviewers: [] } }), [])
})

test('nudgeMarks: past the threshold only, one per person, cooldown honoured, and the route from the source', () => {
  const fresh = item({ id: 'github:acme/api#13', seen: { red: [], bots: 0, people: 0, rebase: null, draft: false, reviewers: [{ login: 'bo', since: NOW - 3_600_000 }] } })
  const marks = nudgeMarks([PR, SLACK, fresh], NOW)
  assert.deepEqual(Object.keys(marks).sort(), [PR.id, SLACK.id].sort())
  assert.equal(marks[PR.id]!.person, 'ana')
  assert.equal(marks[PR.id]!.since, NOW - 7 * DAY)
  assert.equal(marks[PR.id]!.workingDays, 5)
  // GitHub has no reply route of Junior's: Copy text. Slack replies in the thread.
  assert.deepEqual(marks[PR.id]!.route, { send: false })
  assert.deepEqual(marks[SLACK.id]!.route, { send: true, via: 'slack-thread', lands: 'in the Slack thread' })
  // nudged an hour ago: cooling down
  assert.equal(nudgeMarks([PR], NOW, {}, [{ person: '@Ana', at: NOW - 3_600_000 }])[PR.id], undefined)
  // a closed item is never marked
  assert.deepEqual(nudgeMarks([{ ...PR, status: 'done' }], NOW), {})
})

test('nudgeRoute: a source without a reply route offers Copy text, any MCP source included', () => {
  assert.deepEqual(nudgeRoute('slack'), { send: true, via: 'slack-thread', lands: 'in the Slack thread' })
  for (const s of ['github', 'linear', 'web', 'job', 'manual', 'sentry', 'pagerduty', '']) assert.deepEqual(nudgeRoute(s), { send: false }, s)
})

test('nudgeTask: one task on you, waiting, with the drafted text and the route', () => {
  const spec = nudgeTask(PR, { person: '@ana', since: NOW - 7 * DAY }, NOW)
  assert.equal(spec.owner, 'you')
  assert.equal(spec.state, 'waiting')
  assert.equal(spec.step, NUDGE_STEP)
  assert.equal(spec.title, 'Nudge ana')
  assert.equal(spec.input.person, 'ana')
  assert.equal(spec.input.route, null)
  assert.match(spec.input.text, /^Hi @ana, could you look at #12 \(Add retries\)\?$/)
  assert.equal(nudgeTask(SLACK, { person: 'priya', since: 1 }, NOW).input.route, 'slack-thread')
})

test('pickWait: the person you named, else the longest wait', () => {
  const waits = [{ person: 'bo', since: 5 }, { person: 'ana', since: 2 }]
  assert.equal(pickWait(waits)?.person, 'ana')
  assert.equal(pickWait(waits, '@BO')?.person, 'bo')
  assert.equal(pickWait(waits, 'cy'), null)
})

test('requestedSince: a request keeps the time it was first seen; a new one starts now; a dropped one goes', () => {
  const a = requestedSince(undefined, ['ana'], 100)
  assert.deepEqual(a, [{ login: 'ana', since: 100 }])
  assert.deepEqual(requestedSince(a, ['Ana', 'bo'], 200), [{ login: 'Ana', since: 100 }, { login: 'bo', since: 200 }])
  assert.deepEqual(requestedSince(a, [], 200), [])
})

test('the sent list: junk reads as nothing, old entries go', () => {
  assert.deepEqual(nudgesSentFrom('nope'), [])
  assert.deepEqual(nudgesSentFrom([{ person: 'ana', at: 5 }, { person: '', at: 1 }, { at: 3 }]), [{ person: 'ana', at: 5 }])
  const list = nudgeSentWith([{ person: 'old', at: NOW - 40 * DAY }], { person: 'ana', at: NOW }, NOW)
  assert.deepEqual(list.map((s) => s.person), ['ana'])
})

// ── the server side, over a real sqlite store ─────────────────────────────

async function withRuntime(fn: (rt: WorkspaceRuntime) => Promise<void>) {
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
  try {
    for (const i of [PR, SLACK]) {
      const { score: _s, group: _g, rankWhy: _r, ask: _a, reason: _re, flow: _f, seen: _se, status: _st, ...w } = i
      await store.items.upsert({ ...w, ...(i.source === 'slack' ? { ask: 'follow-up' } : {}) })
    }
    await fn(rt)
  } finally {
    await rt.actionChain
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const fakeSend = (calls: ApprovedSend[], ok = true) => async (_rt: WorkspaceRuntime, want: ApprovedSend) => {
  calls.push(want)
  return ok ? { called: true, link: 'https://acme.slack.com/archives/C0123ABCD/p1', error: null } : { called: false, link: null, error: 'Slack said no' }
}

const items = (...xs: ScoredItem[]) => async () => xs
const allTasks = async (rt: WorkspaceRuntime) => [...(await rt.store.tasks.list(PR.id)), ...(await rt.store.tasks.list(SLACK.id))]

function channelApproval(channel: string): AdvanceApproval {
  const r = approvalFrom({ what: 'slack-post', who: { id: channel, name: '#eng' }, why: 'nudges' }, { id: 'cd34ef56-nudge', now: 1, sessionId: null, proposalId: null })
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.approval
}

test('the Junior page’s marks create nothing: no task, no draft', () =>
  withRuntime(async (rt) => {
    const marks = await nudgeMarksOp(rt, [PR, SLACK], { now: NOW, me: 'samar' })
    assert.equal(Object.keys(marks).length, 2)
    assert.equal((await allTasks(rt)).length, 0)
    assert.equal(await rt.store.config.get(NUDGES_SENT_KEY), null)
  }))

test('the babysit tick notes who was asked and since when, and adds no nudge task, handed off or not', async () => {
  const dir = mkdtempSync(path.join(home, 'tick-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const node = (reviewers: string[]) => ({
    __typename: 'PullRequest', number: 12, title: 'Add retries', url: 'https://github.com/acme/api/pull/12', isDraft: false,
    createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T11:00:00Z', state: 'OPEN',
    repository: { nameWithOwner: 'acme/api', defaultBranchRef: { name: 'main' } }, author: { login: 'samar' },
    headRefOid: 'abc', headRefName: 'feat/12', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: { nodes: reviewers.map((login) => ({ requestedReviewer: { __typename: 'User', login } })) }, reviews: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null, checkSuite: { workflowRun: { databaseId: 9 } } }] } } } }] },
    reviewThreads: { nodes: [] },
  })
  let nodes = [node(['ana'])]
  let handed = false
  const deps = {
    store,
    source: { login: async () => 'samar', search: async () => ({ data: { prs: { nodes } } }), failedLog: async () => '', rerun: async () => {}, mainRuns: async () => [] },
    repos: async () => ['acme/api'],
    upsertItem: async (i: Parameters<typeof store.items.upsert>[0]) => {
      await store.items.upsert(i)
      if (handed) await store.items.setFields(i.id, { handoff: 'on' })
    },
    reviewerFor: async () => 'ana',
    added: () => {},
    log: () => {},
  }
  try {
    await babysitTickOp(deps, NOW - 7 * DAY, true)
    const seen = async () => (await store.config.get<{ prs: Record<string, { seen?: { reviewers?: unknown } }> }>(BABYSIT_WATCH_KEY))?.prs[PR.id]?.seen?.reviewers
    assert.deepEqual(await seen(), [{ login: 'ana', since: NOW - 7 * DAY }])
    // a week on, handed off: the request keeps its time, a new one starts now, and still no nudge task
    handed = true
    nodes = [node(['ana', 'bo'])]
    await babysitTickOp(deps, NOW, true)
    assert.deepEqual(await seen(), [{ login: 'ana', since: NOW - 7 * DAY }, { login: 'bo', since: NOW }])
    assert.equal((await store.tasks.list(PR.id)).filter((t) => t.step === NUDGE_STEP).length, 0)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Draft nudge on a GitHub PR: one task on you, nothing sent; again returns the same task; Send refuses, Mark sent starts the cooldown', () =>
  withRuntime(async (rt) => {
    const calls: ApprovedSend[] = []
    const t = await draftNudgeOp(rt, { itemId: PR.id }, { items: items(PR), send: fakeSend(calls) })
    assert.equal(t.owner, 'you')
    assert.equal(t.state, 'waiting')
    assert.equal(t.step, NUDGE_STEP)
    assert.match(String(t.input?.text), /Hi @ana/)
    assert.equal(calls.length, 0)
    const again = await draftNudgeOp(rt, { itemId: PR.id }, { items: items(PR), send: fakeSend(calls) })
    assert.equal(again.id, t.id)
    assert.equal((await allTasks(rt)).length, 1)

    await assert.rejects(sendNudgeOp(rt, t.id, {}, fakeSend(calls)), /copy the text/)
    assert.equal(calls.length, 0)
    assert.equal(await rt.store.config.get(NUDGES_SENT_KEY), null)

    const done = await sendNudgeOp(rt, t.id, { byHand: true }, fakeSend(calls))
    assert.equal(done.state, 'done')
    assert.equal(calls.length, 0)
    const sent = nudgesSentFrom(await rt.store.config.get(NUDGES_SENT_KEY))
    assert.deepEqual(sent.map((s) => [s.person, s.itemId]), [['ana', PR.id]])
    // the cooldown now holds the mark back
    assert.deepEqual(await nudgeMarksOp(rt, [PR], { now: Date.now() }), {})
  }))

test('Draft nudge on a Slack follow-up waits for you; your Send posts your edit in the thread, logs it, and starts the cooldown', () =>
  withRuntime(async (rt) => {
    const calls: ApprovedSend[] = []
    const t = await draftNudgeOp(rt, { itemId: SLACK.id }, { items: items(SLACK), send: fakeSend(calls) })
    assert.equal(t.state, 'waiting')
    assert.equal(t.input?.route, 'slack-thread')
    assert.equal(calls.length, 0)

    const done = await sendNudgeOp(rt, t.id, { text: 'Hi @priya, is the 4.2 checklist final? It blocks the release.' }, fakeSend(calls))
    assert.equal(done.state, 'done')
    assert.deepEqual(calls, [{ channel: 'C0123ABCD', threadTs: '1729500000.000100', message: 'Hi @priya, is the 4.2 checklist final? It blocks the release.' }])
    await rt.actionChain
    const recs = (await rt.store.actions.list()).filter((r) => r.sessionId === `task-${t.id}`)
    assert.equal(recs.length, 1)
    assert.equal(recs[0]!.allowedBy, 'prompt')
    assert.equal(recs[0]!.status, 'succeeded')
    assert.deepEqual(nudgesSentFrom(await rt.store.config.get(NUDGES_SENT_KEY)).map((s) => s.person), ['priya'])
    await assert.rejects(sendNudgeOp(rt, t.id, {}, fakeSend(calls)), /only a waiting nudge/)
  }))

test('a send that fails keeps the nudge waiting and starts no cooldown', () =>
  withRuntime(async (rt) => {
    const calls: ApprovedSend[] = []
    const t = await draftNudgeOp(rt, { itemId: SLACK.id }, { items: items(SLACK), send: fakeSend(calls) })
    await assert.rejects(sendNudgeOp(rt, t.id, {}, fakeSend(calls, false)), /Slack said no/)
    assert.equal((await rt.store.tasks.get(t.id))?.state, 'waiting')
    assert.equal(await rt.store.config.get(NUDGES_SENT_KEY), null)
  }))

test('an approval you wrote for the channel sends the drafted nudge alone, recorded as allowed by your rule', () =>
  withRuntime(async (rt) => {
    await rt.store.approvals.put(channelApproval('C0123ABCD'))
    const calls: ApprovedSend[] = []
    const t = await draftNudgeOp(rt, { itemId: SLACK.id }, { items: items(SLACK), send: fakeSend(calls) })
    assert.equal(t.state, 'done')
    assert.equal(calls.length, 1)
    await rt.actionChain
    const recs = (await rt.store.actions.list()).filter((r) => r.sessionId === `task-${t.id}`)
    assert.equal(recs[0]?.allowedBy, 'rule')
    assert.equal((await rt.store.approvals.list())[0]?.uses, 1)
  }))

test('Draft nudge refuses an item nobody can be named on, and a person it does not wait on', () =>
  withRuntime(async (rt) => {
    const mine = item({ id: 'manual:1', source: 'manual', kind: 'manual', reason: 'yours' as ScoredItem['reason'] })
    await assert.rejects(draftNudgeOp(rt, { itemId: mine.id }, { items: items(mine) }), /can’t tell who/)
    await assert.rejects(draftNudgeOp(rt, { itemId: PR.id, person: 'zed' }, { items: items(PR) }), /isn't waiting on zed/)
    await assert.rejects(draftNudgeOp(rt, { itemId: 'nope' }, { items: items(PR) }), /no open item/)
    assert.equal((await allTasks(rt)).length, 0)
  }))
