/**
 * The attention split (core/junior/attention.ts), the open-cycle rule it
 * shares with the store (core/work/state.ts), and the `surfaced` /
 * `not-useful` events in the item store. Fake clock throughout: dates are
 * built in local time, so weekends are weekends wherever the test runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  addWorkdays,
  ATTENTION_BUCKETS,
  ATTENTION_RULES,
  attentionSplit,
  type AttentionBucket,
  type AttentionEvent,
  type AttentionInput,
  type AttentionItem,
  needsYouVia,
  waitText,
} from '../core/junior/attention.js'
import { itemCycles, surfacedThisCycle, type ItemEventKind } from '../core/work/state.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { ITEM_EVENTS_AT_INDEX, MIGRATIONS } from '../core/store/sqlite-migrations.js'
import type { Store } from '../core/store/types.js'
import type { ScoredItem, WorkItem } from '../core/work/types.js'
import { readAttentionSplit, recordSurfaced, waitingSinceOf } from '../server/attention-ops.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 2026-10-<day> at h:m, local time. Oct 19 2026 is a Monday. */
const at = (day: number, h = 10, m = 0) => new Date(2026, 9, day, h, m).getTime()
const WEEK = at(19, 0)
const NEXT_WEEK = at(26, 0)
const LAST_WEEK = at(12, 0)

const ev = (when: number, event: ItemEventKind, actor = 'system'): AttentionEvent => ({ at: when, actor, event })
const item = (events: AttentionEvent[], waitingSince: number | null = null, id = 'x'): AttentionItem => ({ id, waitingSince, events })

type Row = {
  name: string
  input: AttentionInput
  week?: number
  now?: number
  /** the bucket item `x` lands in this week; null = no row */
  bucket: AttentionBucket | null
  reason?: RegExp
  open?: number
  cycles?: number
}

const ROWS: Row[] = [
  {
    name: 'never reached you: closed by the system, nothing from you',
    input: { items: [item([ev(at(19), 'created'), ev(at(20), 'done')])] },
    bucket: 'never-reached',
    reason: /without reaching you/,
  },
  {
    name: 'one look: reached Needs you, you approved the send as drafted',
    input: {
      items: [item([ev(at(19), 'created'), ev(at(19, 11), 'surfaced'), ev(at(20), 'done')])],
      sends: [{ itemId: 'x', outcome: 'as-drafted', at: at(19, 12) }],
    },
    bucket: 'one-look',
    reason: /approved a send/,
  },
  {
    name: 'one look: approving, then marking it done, is one look',
    input: {
      items: [item([ev(at(19), 'created'), ev(at(19, 11), 'surfaced'), ev(at(19, 13), 'done', 'user')])],
      sends: [{ itemId: 'x', outcome: 'quick', at: at(19, 12) }],
    },
    bucket: 'one-look',
  },
  {
    name: 'one look: a close alone (dismiss) is one look',
    input: { items: [item([ev(at(19), 'created'), ev(at(19, 11), 'surfaced'), ev(at(19, 12), 'archived', 'user')])] },
    bucket: 'one-look',
    reason: /you closed it/,
  },
  {
    name: 'one look: handed off (time unknown), never reached Needs you, Junior closed it',
    input: { items: [item([ev(at(19), 'created'), ev(at(21), 'done', 'agent')])], handoffs: [{ itemId: 'x', at: null }] },
    bucket: 'one-look',
    reason: /handed it off/,
  },
  {
    name: 'your work: you edited a send',
    input: {
      items: [item([ev(at(19), 'created'), ev(at(19, 11), 'surfaced'), ev(at(20), 'done')])],
      sends: [{ itemId: 'x', outcome: 'edited', at: at(19, 12) }],
    },
    bucket: 'your-work',
    reason: /edited a send/,
  },
  {
    name: 'your work: a task of yours is done on it',
    input: {
      items: [item([ev(at(19), 'created'), ev(at(20), 'done', 'user')])],
      tasks: [{ itemId: 'x', owner: 'you', state: 'done', endedAt: at(20, 9) }],
    },
    bucket: 'your-work',
    reason: /task/,
  },
  {
    name: 'your work: it took more than one look (snooze, then a turn set, then done)',
    input: {
      items: [item([ev(at(19), 'created'), ev(at(19, 11), 'surfaced'), ev(at(19, 12), 'snoozed', 'user'), ev(at(20), 'woken'), ev(at(20, 11), 'flow-set', 'user'), ev(at(20, 12), 'done', 'user')])],
    },
    bucket: 'your-work',
    reason: /2 looks/,
  },
  {
    name: 'missed: a person waited two days before it reached Needs you',
    input: { items: [item([ev(at(19), 'created'), ev(at(21), 'surfaced'), ev(at(21, 11), 'done', 'user')], at(19))] },
    bucket: 'missed',
    reason: /waited 2d before it reached you/,
  },
  {
    name: 'missed: still open, never reached you, the wait is past a working day',
    input: { items: [item([ev(at(20), 'created')], at(20))] },
    now: at(22, 12),
    bucket: 'missed',
    reason: /hasn't reached you/,
    open: 0,
  },
  {
    name: 'not missed: asked Friday 17:00, reached you Monday 09:00 (the weekend does not count)',
    input: { items: [item([ev(at(23, 17), 'created'), ev(at(26, 9), 'surfaced'), ev(at(26, 10), 'done', 'user')], at(23, 17))] },
    week: NEXT_WEEK,
    now: at(28),
    bucket: 'one-look',
  },
  {
    name: 'not missed: you answered from Up next within the day; it closed days later',
    input: {
      items: [item([ev(at(19), 'created'), ev(at(22), 'done')], at(19))],
      sends: [{ itemId: 'x', outcome: 'as-drafted', at: at(19, 14) }],
    },
    bucket: 'one-look',
  },
  {
    name: 'no events: nothing to count',
    input: { items: [item([])] },
    bucket: null,
    open: 0,
  },
  {
    name: 'reopened in the same week: two cycles, one row, the one that took more of you',
    input: { items: [item([ev(at(19), 'created'), ev(at(19, 12), 'done'), ev(at(20), 'reopened'), ev(at(20, 1), 'surfaced'), ev(at(20, 2), 'done', 'user')])] },
    bucket: 'one-look',
    cycles: 2,
  },
  {
    name: 'reopened: the cycle closed last week is not counted again',
    input: { items: [item([ev(at(13), 'created'), ev(at(14), 'done', 'user'), ev(at(20), 'reopened'), ev(at(21), 'done')])] },
    bucket: 'never-reached',
    cycles: 1,
  },
  {
    name: 'spanning two weeks, seen from the first: open, not counted yet',
    input: { items: [item([ev(at(22), 'created'), ev(at(22, 11), 'surfaced'), ev(at(27), 'done', 'user')])] },
    bucket: null,
    open: 1,
  },
  {
    name: 'spanning two weeks, seen from the second: counted where it closed',
    input: { items: [item([ev(at(22), 'created'), ev(at(22, 11), 'surfaced'), ev(at(27), 'done', 'user')])] },
    week: NEXT_WEEK,
    now: at(30),
    bucket: 'one-look',
  },
  {
    name: 'missed last week and closed this week: counted only in the week it was missed',
    input: { items: [item([ev(at(15), 'created'), ev(at(19, 9), 'surfaced'), ev(at(19, 10), 'done', 'user')], at(15))] },
    bucket: null,
  },
  {
    name: 'missed last week, as seen from last week',
    input: { items: [item([ev(at(15), 'created'), ev(at(19, 9), 'surfaced'), ev(at(19, 10), 'done', 'user')], at(15))] },
    week: LAST_WEEK,
    bucket: 'missed',
  },
  {
    name: 'a close after now has not happened yet',
    input: { items: [item([ev(at(19), 'created'), ev(at(24), 'done')])] },
    now: at(21),
    bucket: null,
    open: 1,
  },
  {
    name: 'a snooze and its wake stay in one cycle',
    input: { items: [item([ev(at(19), 'created'), ev(at(19, 11), 'surfaced'), ev(at(19, 12), 'snoozed', 'user'), ev(at(20), 'reopened', 'user'), ev(at(20, 1), 'done')])] },
    bucket: 'your-work',
    cycles: 1,
  },
]

for (const row of ROWS) {
  test(`split: ${row.name}`, () => {
    const s = attentionSplit(row.input, row.week ?? WEEK, row.now ?? (row.week ?? WEEK) + 7 * DAY)
    const mine = s.items.filter((r) => r.itemId === 'x')
    assert.ok(mine.length <= 1, 'an item has at most one row a week')
    assert.equal(mine[0]?.bucket ?? null, row.bucket, JSON.stringify(s.items))
    if (row.reason) assert.match(mine[0]!.reason, row.reason)
    if (row.open !== undefined) assert.equal(s.open, row.open)
    if (row.cycles !== undefined) assert.equal(mine[0]?.cycles, row.cycles)
    // the counts are the rows
    assert.equal(ATTENTION_BUCKETS.reduce((n, b) => n + s.counts[b], 0), s.items.length)
  })
}

test('the fixture table has a row per bucket rule, and the rules end in a catch-all', () => {
  assert.ok(ROWS.length >= 12)
  for (const b of ATTENTION_BUCKETS) assert.ok(ROWS.some((r) => r.bucket === b), b)
  assert.equal(ATTENTION_RULES[0]!.bucket, 'missed')
  assert.equal(ATTENTION_RULES[ATTENTION_RULES.length - 1]!.bucket, 'your-work')
})

test('every item lands in exactly one bucket: all fixtures at once, every closed cycle counted once over the weeks', () => {
  // the table's inputs side by side, each under its own id
  const items: AttentionItem[] = []
  const sends: NonNullable<AttentionInput['sends']>[number][] = []
  const tasks: NonNullable<AttentionInput['tasks']>[number][] = []
  const handoffs: NonNullable<AttentionInput['handoffs']>[number][] = []
  ROWS.forEach((r, n) => {
    const id = `i${n}`
    for (const i of r.input.items) items.push({ ...i, id })
    for (const s of r.input.sends ?? []) sends.push({ ...s, itemId: id })
    for (const t of r.input.tasks ?? []) tasks.push({ ...t, itemId: id })
    for (const h of r.input.handoffs ?? []) handoffs.push({ ...h, itemId: id })
  })
  const input = { items, sends, tasks, handoffs }
  const now = at(31)
  const weeks = [at(5, 0), at(12, 0), WEEK, NEXT_WEEK]
  const seen = new Map<string, number>()
  for (const w of weeks) {
    const s = attentionSplit(input, w, now)
    assert.equal(new Set(s.items.map((r) => r.itemId)).size, s.items.length, 'one row per item per week')
    for (const r of s.items) {
      assert.ok(ATTENTION_BUCKETS.includes(r.bucket))
      seen.set(r.itemId, (seen.get(r.itemId) ?? 0) + r.cycles)
    }
  }
  // every cycle that closed (or was missed) in these weeks counts exactly once across them
  for (const i of items) {
    const cycles = itemCycles(i.events.filter((e) => e.at <= now)).filter((c) => c.end || i.waitingSince !== null)
    assert.equal(seen.get(i.id) ?? 0, cycles.length, i.id)
  }
})

// Interrupt precision.

const surfacedAt = at(19, 9)
const reached = (id: string, extra: AttentionEvent[] = []) => item([ev(at(19, 8), 'created'), ev(surfacedAt, 'surfaced'), ...extra], null, id)

test('interrupt precision: acted on counts for; snoozed, not useful and unopened count against', () => {
  const input: AttentionInput = {
    items: [
      reached('approved', [ev(at(19, 12), 'done')]),
      reached('closed', [ev(at(20), 'done', 'user')]),
      reached('snoozed', [ev(at(19, 10), 'snoozed', 'user'), ev(at(21), 'woken'), ev(at(21, 1), 'done', 'user')]),
      reached('not-useful', [ev(at(19, 10), 'not-useful', 'user'), ev(at(19, 11), 'done', 'user')]),
      reached('unopened'),
      reached('closed-alone', [ev(at(19, 10), 'done')]),
      reached('late', [ev(at(23), 'done', 'user')]),
      // never reached Needs you: not an interruption
      item([ev(at(19), 'created'), ev(at(19, 1), 'done', 'user')], null, 'quiet'),
    ],
    sends: [{ itemId: 'approved', outcome: 'as-drafted', at: at(19, 11) }],
  }
  const p = attentionSplit(input, WEEK, at(26)).interruptPrecision
  assert.equal(p.acted, 2)
  assert.equal(p.total, 7)
  assert.equal(p.pending, 0)
  assert.equal(p.value, 2 / 7)
  const why = Object.fromEntries(p.misses.map((m) => [m.itemId, m.why]))
  assert.deepEqual(why, { snoozed: 'snoozed', 'not-useful': 'not-useful', unopened: 'unopened', 'closed-alone': 'unopened', late: 'unopened' })
})

test('interrupt precision: a not-useful mark counts against even after you acted', () => {
  const input: AttentionInput = { items: [reached('a', [ev(at(19, 10), 'flow-set', 'user'), ev(at(19, 11), 'not-useful', 'user')])] }
  const p = attentionSplit(input, WEEK, at(26)).interruptPrecision
  assert.deepEqual(p.misses, [{ itemId: 'a', why: 'not-useful' }])
  assert.equal(p.value, 0)
})

test('interrupt precision: too early to say is pending, and nothing settled is null', () => {
  const p = attentionSplit({ items: [reached('a')] }, WEEK, at(20, 9)).interruptPrecision
  assert.equal(p.pending, 1)
  assert.equal(p.total, 0)
  assert.equal(p.value, null)
  // three days on, with nothing from you, it was left unopened
  assert.deepEqual(attentionSplit({ items: [reached('a')] }, WEEK, at(22, 9)).interruptPrecision.misses, [{ itemId: 'a', why: 'unopened' }])
})

test('interrupt precision counts in the week it reached you', () => {
  const input: AttentionInput = { items: [reached('a', [ev(at(26, 9), 'done', 'user')])] }
  assert.equal(attentionSplit(input, WEEK, at(31)).interruptPrecision.total, 1)
  assert.equal(attentionSplit(input, NEXT_WEEK, at(31)).interruptPrecision.total, 0)
})

// Helpers.

test('addWorkdays skips the weekend; a weekend start counts from Monday', () => {
  assert.equal(addWorkdays(at(19, 10), 1), at(20, 10))
  assert.equal(addWorkdays(at(23, 17), 1), at(26, 17)) // Friday → Monday
  assert.equal(addWorkdays(at(24, 10), 1), at(27, 0)) // Saturday → Monday 00:00 + 1 day
  assert.equal(addWorkdays(at(19, 10), 0), at(19, 10))
  assert.equal(waitText(26 * HOUR), '26h')
  assert.equal(waitText(3 * DAY), '3d')
})

test('itemCycles: created, closes, reopens; snoozes stay inside a cycle', () => {
  const log = [ev(1, 'created'), ev(2, 'snoozed'), ev(3, 'woken'), ev(4, 'done'), ev(5, 'updated'), ev(6, 'reopened'), ev(7, 'surfaced')]
  const cycles = itemCycles(log)
  assert.equal(cycles.length, 2)
  assert.equal(cycles[0]!.end?.at, 4)
  assert.deepEqual(cycles[0]!.events.map((e) => e.at), [1, 2, 3, 4, 5])
  assert.equal(cycles[1]!.end, null)
  assert.equal(surfacedThisCycle(log), true)
  assert.equal(surfacedThisCycle(log.slice(0, 6)), false)
  // an older log with no `created` starts its first cycle at its first event
  assert.equal(itemCycles([ev(1, 'updated'), ev(2, 'done')]).length, 1)
})

// The store and the writer.

const pr = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'github:acme/api#12',
  source: 'github',
  kind: 'review-requested',
  title: 'Add retries',
  url: 'https://github.com/acme/api/pull/12',
  repo: 'acme/api',
  author: 'ana',
  peopleWaiting: 1,
  createdAt: new Date(at(19, 9)).toISOString(),
  updatedAt: new Date(at(19, 9)).toISOString(),
  ...over,
})

const scored = (w: WorkItem, over: Partial<ScoredItem> = {}): ScoredItem =>
  ({ ...w, status: 'open', score: 1, group: 'cycle', rankWhy: '', ask: 'review', reason: 'review-requested', ...over }) as ScoredItem

async function withStore(fn: (store: Store, file: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'junior-attention-'))
  const file = path.join(dir, 'junior.db')
  const store = openSqliteStore(file)
  try {
    await fn(store, file)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const kinds = async (store: Store, id: string) => (await store.items.events(id)).map((e) => e.event)

test('surfaced and not-useful round-trip through the item store', () =>
  withStore(async (store) => {
    const id = pr().id
    await store.items.upsert(pr())
    assert.deepEqual(await store.items.markSurfaced([{ id, detail: { via: 'junior' } }], at(19, 10)), [id])
    assert.equal(await store.items.note(id, 'not-useful', 'user', at(19, 11), { from: 'needs' }), true)
    assert.equal(await store.items.note('nope', 'not-useful', 'user', at(19, 11)), false)
    const evs = await store.items.events(id)
    const s = evs.find((e) => e.event === 'surfaced')!
    assert.deepEqual([s.at, s.actor, s.detail], [at(19, 10), 'system', { via: 'junior' }])
    const n = evs.find((e) => e.event === 'not-useful')!
    assert.deepEqual([n.at, n.actor, n.detail], [at(19, 11), 'user', { from: 'needs' }])
    // a note doesn't move the status
    assert.equal((await store.items.get(id))?.status, 'open')
    // by window: [since, until)
    const win = await store.items.eventsBetween(at(19, 10), at(19, 11))
    assert.deepEqual(win.map((e) => [e.itemId, e.event]), [[id, 'surfaced']])
  }))

test('surfaced is written once per open cycle', () =>
  withStore(async (store) => {
    const id = pr().id
    await store.items.upsert(pr())
    const mark = (t: number) => store.items.markSurfaced([{ id }, { id }], t)
    assert.deepEqual(await mark(at(19, 10)), [id], 'twice in one call is once')
    assert.deepEqual(await mark(at(19, 11)), [], 'already surfaced this cycle')
    // a snooze and its end stay in the cycle
    await store.items.transition(id, { status: 'snoozed', actor: 'user', snoozeUntil: at(20) })
    assert.deepEqual(await mark(at(19, 12)), [], 'snoozed is not open')
    await store.items.transition(id, { status: 'open', actor: 'user' })
    assert.deepEqual(await mark(at(19, 13)), [], 'same cycle after a snooze')
    // closed: not open, nothing written
    await store.items.transition(id, { status: 'done', actor: 'user' })
    assert.deepEqual(await mark(at(19, 14)), [])
    // reopened: a new cycle, surfaced once more
    await store.items.transition(id, { status: 'open', actor: 'user' })
    assert.deepEqual(await mark(at(19, 15)), [id])
    assert.deepEqual(await mark(at(19, 16)), [])
    assert.equal((await kinds(store, id)).filter((k) => k === 'surfaced').length, 2)
  }))

test('recordSurfaced marks only what is on Needs you, once per cycle', () =>
  withStore(async (store) => {
    const waits = pr({ id: 'github:acme/api#1' })
    const quiet = pr({ id: 'github:acme/api#2' })
    const blocked = pr({ id: 'github:acme/api#3' })
    for (const w of [waits, quiet, blocked]) await store.items.upsert(w)
    const ranked = [
      scored(waits, { handoff: 'on', junior: { stage: 'needs-you' } as ScoredItem['junior'] }),
      scored(quiet),
      scored(blocked, { flow: { stage: 'review', turn: 'me', next: 'approve action', since: at(19) } }),
    ]
    assert.equal(needsYouVia(ranked[0]!, at(19, 10)), 'junior')
    assert.equal(needsYouVia(ranked[1]!, at(19, 10)), null)
    assert.equal(needsYouVia(ranked[2]!, at(19, 10)), 'inbox')
    assert.deepEqual(await recordSurfaced(store.items, ranked, at(19, 10)), [waits.id, blocked.id])
    assert.deepEqual(await recordSurfaced(store.items, ranked, at(19, 11)), [])
    assert.deepEqual((await store.items.events(blocked.id)).find((e) => e.event === 'surfaced')?.detail, { via: 'inbox' })
    assert.deepEqual(await kinds(store, quiet.id), ['created'])
  }))

test('readAttentionSplit reads the store into the split; a read writes nothing', () =>
  withStore(async (store) => {
    const id = pr().id
    await store.items.upsert(pr())
    await store.items.markSurfaced([{ id }], Date.now())
    await store.items.transition(id, { status: 'done', actor: 'user' })
    const now = Date.now()
    // the store stamps transitions with the real clock: the week is the one around now
    const before = await kinds(store, id)
    const s = await readAttentionSplit(store, now - 3 * DAY, now + 1)
    assert.equal(s.items.length, 1)
    assert.equal(s.items[0]!.bucket, 'one-look')
    assert.equal(s.interruptPrecision.acted, 1)
    assert.deepEqual(await kinds(store, id), before)
    assert.deepEqual(await store.approvals.list(), [])
  }))

test('waitingSinceOf: a person asking waits from when they asked; your own to-do has nobody', () => {
  assert.equal(waitingSinceOf(pr()), at(19, 9))
  assert.equal(waitingSinceOf(pr({ kind: 'own-pr-open', peopleWaiting: 0 })), null)
  assert.equal(waitingSinceOf(pr({ source: 'manual', kind: 'manual', peopleWaiting: 0 })), null)
})

test('the item_events time index migration exists and is idempotent', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'junior-attention-idx-'))
  const file = path.join(dir, 'junior.db')
  try {
    await openSqliteStore(file).close()
    await openSqliteStore(file).close()
    assert.ok(MIGRATIONS.includes(ITEM_EVENTS_AT_INDEX))
    const db = new DatabaseSync(file)
    try {
      db.exec(ITEM_EVENTS_AT_INDEX)
      assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_item_events_at'`).all().length, 1)
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM item_events WHERE at >= 0 AND at < 10').all() as { detail: string }[]
      assert.ok(plan.some((p) => p.detail.includes('idx_item_events_at')), JSON.stringify(plan))
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
