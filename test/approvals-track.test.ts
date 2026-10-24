/**
 * Track record (core/approvals/track.ts): your decisions on held sends,
 * counted. Fake clock throughout: time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionHistoryEntry, ActionKind, ActionRecord, ActionStatus } from '../core/actions/types.js'
import { QUICK_MS, type TrackInput, type TrackOutcome, judge, normalizeWhitespace, recipientOf, repoOf, trackRecord } from '../core/approvals/track.js'
import { readTrackInputs, readTrackRecord } from '../server/track-ops.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { ACTIONS_TRACK_INDEX, MIGRATIONS } from '../core/store/sqlite-migrations.js'

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0)
const S = 1_000
const MIN = 60 * S
const DAY = 86_400_000
const SLACK = 'mcp__claude_ai_Slack__slack_send_message'
const DRAFT = { channel_id: 'C01ENG', message: 'Deploy is done.\nAll green.' }

type Step = { at: number; event: string; actor?: ActionHistoryEntry['actor']; to?: ActionStatus; args?: Record<string, unknown> | null }

function held(
  id: string,
  o: {
    status: ActionStatus
    queuedAt?: number
    kind?: ActionKind
    tool?: string
    draft?: Record<string, unknown>
    /** what went out: defaults to the draft */
    sent?: Record<string, unknown>
    edits?: number
    steps?: Step[]
    /** leave out the `queued` history line (an older record) */
    noQueuedLine?: boolean
    settledAt?: number | null
    jobId?: string | null
    link?: string | null
    noQueue?: boolean
  },
): TrackInput {
  const queuedAt = o.queuedAt ?? T0
  const draft = o.draft ?? DRAFT
  const record: ActionRecord = {
    id,
    sessionId: 's1',
    sessionKind: 'chat',
    tool: o.tool ?? SLACK,
    kind: o.kind ?? 'message',
    summary: id,
    args: o.sent ?? draft,
    status: o.status,
    link: o.link ?? null,
    error: null,
    why: 'name verb',
    whyDetail: 'send',
    allowedBy: null,
    allowedDetail: null,
    jobId: o.jobId ?? null,
    teamRunId: null,
    itemId: null,
    groupKey: null,
    count: 1,
    calls: [id],
    attemptedAt: queuedAt,
    settledAt: o.settledAt ?? null,
    updatedAt: queuedAt,
    queue: o.noQueue
      ? null
      : { args: o.sent ?? draft, queuedAt, expiresAt: queuedAt + DAY, sendAt: null, note: null, edits: o.edits ?? 0, delivery: null, costUsd: null },
  }
  const history: ActionHistoryEntry[] = [
    ...(o.noQueuedLine ? [] : [{ actionId: id, at: queuedAt, actor: 'agent' as const, event: 'queued', from: null, to: 'needs_you' as const, note: null, args: draft }]),
    ...(o.steps ?? []).map((s) => ({ actionId: id, at: s.at, actor: s.actor ?? 'you', event: s.event, from: null, to: s.to ?? 'scheduled', note: null, args: s.args ?? null })),
  ]
  return { record, history }
}

const approve = (at: number, args?: Record<string, unknown>): Step => (args ? { at, event: 'edited and approved', args } : { at, event: 'approved' })

// One row per shape. `ms` is queued → decided; null where there's no decision.
const ROWS: Array<{ name: string; input: TrackInput; outcome: TrackOutcome | null; ms?: number | null }> = [
  { name: 'approved unchanged after a real look', input: held('a', { status: 'succeeded', steps: [approve(T0 + 30 * S)] }), outcome: 'as-drafted', ms: 30 * S },
  { name: 'approved in 1.5s is quick', input: held('b', { status: 'succeeded', steps: [approve(T0 + 1_500)] }), outcome: 'quick', ms: 1_500 },
  { name: 'approved at exactly 2s is a real look', input: held('c', { status: 'scheduled', steps: [approve(T0 + QUICK_MS)] }), outcome: 'as-drafted', ms: QUICK_MS },
  {
    name: 'edited words before approving',
    input: held('d', { status: 'succeeded', sent: { ...DRAFT, message: 'Deploy is done. All green, thanks Ani.' }, edits: 1, steps: [approve(T0 + 2 * MIN, { ...DRAFT, message: 'Deploy is done. All green, thanks Ani.' })] }),
    outcome: 'edited',
    ms: 2 * MIN,
  },
  {
    name: 'whitespace-only edit is not an edit',
    input: held('e', { status: 'succeeded', sent: { ...DRAFT, message: '  Deploy is done.   All green.\n\n' }, edits: 1, steps: [approve(T0 + MIN, { ...DRAFT, message: '  Deploy is done.   All green.\n\n' })] }),
    outcome: 'as-drafted',
    ms: MIN,
  },
  {
    name: 'whitespace-only edit, approved fast, is quick',
    input: held('e2', { status: 'succeeded', sent: { ...DRAFT, message: 'Deploy is done. All green. ' }, edits: 1, steps: [approve(T0 + 900, { ...DRAFT, message: 'Deploy is done. All green. ' })] }),
    outcome: 'quick',
    ms: 900,
  },
  {
    name: 'an edit with no original on file falls back to the edit count',
    input: held('f', { status: 'succeeded', edits: 1, noQueuedLine: true, steps: [approve(T0 + MIN)] }),
    outcome: 'edited',
    ms: MIN,
  },
  { name: 'rejected', input: held('g', { status: 'rejected', settledAt: T0 + 5 * S, steps: [{ at: T0 + 5 * S, event: 'rejected', to: 'rejected' }] }), outcome: 'rejected', ms: 5 * S },
  { name: 'rejected with no history: settling is the decision', input: held('g2', { status: 'rejected', settledAt: T0 + 7 * S, noQueuedLine: true }), outcome: 'rejected', ms: 7 * S },
  { name: 'sent back with notes', input: held('h', { status: 'sent_back', settledAt: T0 + 40 * S, steps: [{ at: T0 + 40 * S, event: 'sent back', to: 'sent_back' }] }), outcome: 'sent-back', ms: 40 * S },
  {
    name: 'approved, undone, approved again: undone',
    input: held('i', { status: 'succeeded', steps: [approve(T0 + 10 * S), { at: T0 + 12 * S, event: 'undone', to: 'needs_you' }, approve(T0 + 20 * S)] }),
    outcome: 'undone',
    ms: 10 * S,
  },
  { name: 'undone and still waiting: undone', input: held('i2', { status: 'needs_you', steps: [approve(T0 + 10 * S), { at: T0 + 11 * S, event: 'undone', to: 'needs_you' }] }), outcome: 'undone', ms: 10 * S },
  { name: 'nobody answered: expired', input: held('j', { status: 'expired', settledAt: T0 + DAY, steps: [{ at: T0 + DAY, event: 'expired', actor: 'junior', to: 'expired' }] }), outcome: 'expired', ms: null },
  { name: 'still waiting on you', input: held('k', { status: 'needs_you' }), outcome: 'waiting', ms: null },
  { name: 'approved, dispatch failed: still your approval', input: held('l', { status: 'failed', steps: [approve(T0 + 9 * S)] }), outcome: 'as-drafted', ms: 9 * S },
  { name: 'recorded as it ran (no queue): nothing to judge', input: held('m', { status: 'succeeded', noQueue: true }), outcome: null },
]

for (const row of ROWS) {
  test(`judge: ${row.name}`, () => {
    const j = judge(row.input)
    if (row.outcome === null) return assert.equal(j, null)
    assert.ok(j)
    assert.equal(j.outcome, row.outcome)
    assert.equal(j.decisionMs, row.ms ?? null)
  })
}

test('the table has at least 10 rows, whitespace edits and quick approvals among them', () => {
  assert.ok(ROWS.length >= 10)
  assert.ok(ROWS.some((r) => r.name.includes('whitespace')))
  assert.ok(ROWS.some((r) => r.outcome === 'quick'))
})

test('normalizeWhitespace reaches nested strings and leaves the rest', () => {
  assert.deepEqual(normalizeWhitespace({ a: ' x \n y ', b: [' z  '], c: 3, d: null }), { a: 'x y', b: ['z'], c: 3, d: null })
})

test('counts every outcome once; total is decided records only', () => {
  const now = T0 + 2 * DAY
  const r = trackRecord(
    ROWS.map((x) => x.input),
    {},
    { now },
  )
  assert.equal(r.approvedAsDrafted, 4) // a, c, e, l
  assert.equal(r.quick, 2) // b, e2
  assert.equal(r.edited, 2) // d, f
  assert.equal(r.rejected, 2)
  assert.equal(r.sentBack, 1)
  assert.equal(r.undone, 2)
  assert.equal(r.expired, 1)
  assert.equal(r.waiting, 1)
  assert.equal(r.total, 13)
})

test('streak: as-drafted in a row, newest first; quick and waiting neither add nor break', () => {
  const day = (n: number) => T0 + n * DAY
  const inputs = [
    held('old-edit', { status: 'succeeded', queuedAt: day(0), sent: { ...DRAFT, message: 'other' }, edits: 1, steps: [approve(day(0) + MIN, { ...DRAFT, message: 'other' })] }),
    held('s1', { status: 'succeeded', queuedAt: day(1), steps: [approve(day(1) + MIN)] }),
    held('quick', { status: 'succeeded', queuedAt: day(2), steps: [approve(day(2) + 500)] }),
    held('s2', { status: 'succeeded', queuedAt: day(3), steps: [approve(day(3) + MIN)] }),
    held('wait', { status: 'needs_you', queuedAt: day(4) }),
    held('s3', { status: 'succeeded', queuedAt: day(5), steps: [approve(day(5) + MIN)] }),
  ]
  const r = trackRecord(inputs, {}, { now: day(6) })
  assert.equal(r.streak, 3)
  assert.equal(r.quick, 1)
  // a rejection today ends it
  const r2 = trackRecord([...inputs, held('no', { status: 'rejected', queuedAt: day(6) - MIN, steps: [{ at: day(6) - 30 * S, event: 'rejected', to: 'rejected' }] })], {}, { now: day(6) })
  assert.equal(r2.streak, 0)
})

test('median decision time, and the newest decision', () => {
  const inputs = [10, 30, 50, 70].map((s, i) => held(`m${i}`, { status: 'succeeded', queuedAt: T0 + i * MIN, steps: [approve(T0 + i * MIN + s * S)] }))
  const r = trackRecord(inputs, {}, { now: T0 + DAY })
  assert.equal(r.medianDecisionMs, 40 * S)
  assert.equal(r.lastDecidedAt, T0 + 3 * MIN + 70 * S)
  assert.equal(trackRecord([], {}, { now: T0 }).medianDecisionMs, null)
})

test('a decision after now has not happened yet', () => {
  const r = trackRecord([held('future', { status: 'succeeded', steps: [approve(T0 + 10 * MIN)] })], {}, { now: T0 + 5 * MIN })
  assert.equal(r.total, 0)
  assert.equal(r.waiting, 1)
})

test('window: only records queued in the last windowMs', () => {
  const inputs = [held('old', { status: 'succeeded', queuedAt: T0 - 40 * DAY, steps: [approve(T0 - 40 * DAY + MIN)] }), held('new', { status: 'succeeded', queuedAt: T0 - DAY, steps: [approve(T0 - DAY + MIN)] })]
  assert.equal(trackRecord(inputs, {}, { now: T0, windowMs: 30 * DAY }).total, 1)
  assert.equal(trackRecord(inputs, {}, { now: T0 }).total, 2)
})

test('scope: kind, repo, recipient class, job', () => {
  const pr = (id: string, repo: string, jobId: string | null = null) =>
    held(id, { status: 'succeeded', kind: 'pr', tool: 'mcp__github__create_pull_request', draft: { owner: repo.split('/')[0], repo: repo.split('/')[1], title: 'Bump x' }, jobId, steps: [approve(T0 + MIN)] })
  const inputs = [
    pr('p1', 'Acme/web', 'deps'),
    pr('p2', 'acme/web', 'deps'),
    pr('p3', 'acme/api'),
    held('dm', { status: 'succeeded', draft: { channel_id: 'U04ANI', message: 'ready' }, steps: [approve(T0 + MIN)] }),
    held('post', { status: 'succeeded', steps: [approve(T0 + MIN)] }),
  ]
  const opts = { now: T0 + DAY }
  assert.equal(trackRecord(inputs, { kind: 'pr' }, opts).total, 3)
  assert.equal(trackRecord(inputs, { kind: 'pr', repo: 'ACME/web' }, opts).total, 2)
  assert.equal(trackRecord(inputs, { jobId: 'deps' }, opts).streak, 2)
  assert.equal(trackRecord(inputs, { recipient: 'person' }, opts).total, 1)
  assert.equal(trackRecord(inputs, { recipient: 'channel' }, opts).total, 1)
  assert.equal(trackRecord(inputs, { recipient: 'repo' }, opts).total, 3)
})

test('repoOf and recipientOf read args, gh flags and links', () => {
  const base = { args: {}, link: null as string | null, tool: 'Bash' }
  assert.equal(repoOf({ ...base, args: { command: 'gh pr create -R Acme/Web --title x' } }), 'acme/web')
  assert.equal(repoOf({ ...base, args: { command: 'gh pr comment 4 --repo=acme/api --body hi' } }), 'acme/api')
  assert.equal(repoOf({ ...base, args: { command: 'gh pr comment 4' }, link: 'https://github.com/acme/web/pull/4#issuecomment-1' }), 'acme/web')
  assert.equal(repoOf({ ...base, tool: 'mcp__github__x', args: { repository: 'acme/web' } }), 'acme/web')
  assert.equal(repoOf(base), null)
  assert.equal(recipientOf({ ...base, args: { command: 'gh pr edit 4 --add-reviewer ani' } }), 'person')
  assert.equal(recipientOf({ ...base, tool: 'mcp__gmail__send_email', args: { to: 'a@b.c', body: 'x' } }), 'person')
  assert.equal(recipientOf({ ...base, tool: 'mcp__linear__save_issue', args: { title: 'x' } }), 'unknown')
})

// The store: the read, and the index migration.

const tmpStore = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'junior-track-'))
  return { file: path.join(dir, 'junior.db'), store: openSqliteStore(path.join(dir, 'junior.db')) }
}

async function putInput(store: ReturnType<typeof openSqliteStore>, i: TrackInput) {
  await store.actions.put(i.record)
  for (const e of i.history) await store.actions.addHistory(e)
}

test('held(): held records only, by kind and window, with history; nothing else is written', async () => {
  const { store } = tmpStore()
  try {
    await putInput(store, held('a', { status: 'succeeded', queuedAt: T0, steps: [approve(T0 + MIN)] }))
    await putInput(store, held('b', { status: 'succeeded', queuedAt: T0 + MIN, sent: { ...DRAFT, message: 'changed' }, edits: 1, steps: [approve(T0 + 2 * MIN, { ...DRAFT, message: 'changed' })] }))
    await putInput(store, held('ran', { status: 'succeeded', queuedAt: T0, noQueue: true }))
    await putInput(store, held('pr', { status: 'succeeded', kind: 'pr', queuedAt: T0, steps: [approve(T0 + MIN)] }))
    await putInput(store, held('old', { status: 'succeeded', queuedAt: T0 - 100 * DAY, steps: [approve(T0 - 100 * DAY + MIN)] }))

    const rows = await store.actions.held({ kind: 'message', since: T0 - DAY, until: T0 + DAY })
    assert.deepEqual(
      rows.map((r) => r.id),
      ['b', 'a'],
    )
    const inputs = await readTrackInputs(store.actions, { kind: 'message', since: T0 - DAY })
    assert.equal(inputs.find((i) => i.record.id === 'b')?.history.length, 2)

    const r = await readTrackRecord(store.actions, { kind: 'message' }, { now: T0 + DAY })
    assert.equal(r.total, 2)
    assert.equal(r.edited, 1)
    assert.equal(r.approvedAsDrafted, 1)
    assert.equal(r.streak, 0)

    // data only: no rule, approval or proposal comes out of a read
    assert.deepEqual(await store.approvals.list(), [])
  } finally {
    await store.close()
  }
})

test('the index migration exists and is idempotent', async () => {
  const { file, store } = tmpStore()
  await store.close()
  assert.ok(MIGRATIONS.includes(ACTIONS_TRACK_INDEX))
  // reopening runs ensureDurableSchema again over a DB that already has it
  const again = openSqliteStore(file)
  await again.close()
  const db = new DatabaseSync(file)
  try {
    db.exec(ACTIONS_TRACK_INDEX)
    db.exec(ACTIONS_TRACK_INDEX)
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_actions_kind_status_attempted'`).all()
    assert.equal(idx.length, 1)
    const cols = (db.prepare(`PRAGMA index_info(idx_actions_kind_status_attempted)`).all() as { name: string }[]).map((c) => c.name)
    assert.deepEqual(cols, ['kind', 'status', 'attempted_at'])
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM actions WHERE kind = 'pr' AND status IN ('succeeded') AND attempted_at >= 0`).all() as { detail: string }[]
    assert.ok(plan.some((p) => p.detail.includes('idx_actions_kind_status_attempted')), JSON.stringify(plan))
  } finally {
    db.close()
  }
})
