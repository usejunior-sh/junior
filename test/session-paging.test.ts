/**
 * Reading a session's log a page at a time (core/store/event-page.ts and
 * SqliteEvents.readPage). Chained pages must rebuild the full log in order,
 * stay within `limit`, start on a turn when they can, and never split a
 * tool_use from its tool_result unless one call spans the whole page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { clampPageLimit, cutPage, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../core/store/event-page.js'
import type { EventPage, StoredEvent } from '../core/store/types.js'
import type { SessionEvent } from '../shared/protocol.js'

// Synthetic events

const user = (text: string): SessionEvent => ({ kind: 'local_user', text })
const init = (): SessionEvent => ({ kind: 'sdk', message: { type: 'system', subtype: 'init', session_id: 'sdk-1' } })
const said = (text: string, parent: string | null = null): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const call = (id: string, name = 'Bash', parent: string | null = null): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } },
})
const result = (id: string, parent: string | null = null): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
})
const done = (): SessionEvent => ({ kind: 'sdk', message: { type: 'result', subtype: 'success' } })

/** A small deterministic PRNG, so the log is the same every run. */
function rng(seed: number) {
  let s = seed >>> 0
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s % n
  }
}

/**
 * About 5,000 events of believable turns: tool calls, a few in parallel,
 * subagent Task runs whose messages sit between the call and its result,
 * one turn far longer than a page, and a notice or two between turns.
 */
function syntheticLog(total = 5000): SessionEvent[] {
  const r = rng(42)
  const out: SessionEvent[] = []
  let id = 0
  let turn = 0
  let longTurnDone = false
  while (out.length < total) {
    turn++
    out.push(user(`turn ${turn}`), init())
    // One turn of ~800 events: longer than a 300-event page, no turn start inside.
    const steps = !longTurnDone && out.length > 2000 ? 260 : 1 + r(12)
    if (steps === 260) longTurnDone = true
    for (let s = 0; s < steps; s++) {
      const kind = r(10)
      if (kind < 6) {
        const t = `t${id++}`
        out.push(call(t), result(t))
      } else if (kind < 8) {
        // Two calls in flight at once: both results after both calls.
        const a = `t${id++}`
        const b = `t${id++}`
        out.push(call(a), call(b), result(a), result(b))
      } else {
        // A subagent: its messages nest between the Task call and its result.
        const task = `t${id++}`
        out.push(call(task, 'Task'))
        const inner = 1 + r(steps === 260 ? 4 : 30)
        for (let k = 0; k < inner; k++) {
          const t = `t${id++}`
          out.push(call(t, 'Read', task), result(t, task))
        }
        out.push(said('subagent done', task), result(task))
      }
      if (r(4) === 0) out.push(said('thinking out loud'))
    }
    out.push(said(`turn ${turn} done`), done())
    if (r(5) === 0) out.push({ kind: 'notice', text: 'a stage began' })
  }
  return out.slice(0, total)
}

// Store helpers

function withStore(fn: (store: ReturnType<typeof openSqliteStore>) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-paging-'))
    try {
      await fn(openSqliteStore(path.join(dir, 'junior.db')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

async function seed(store: ReturnType<typeof openSqliteStore>, id: string, events: SessionEvent[]) {
  await store.sessions.create({ id, title: 'long', cwd: '/tmp', projectId: null })
  for (let i = 0; i < events.length; i++) await store.events.append(id, i + 1, events[i])
}

/** Every page from the end back to the start, newest page first. */
async function allPages(store: ReturnType<typeof openSqliteStore>, id: string, limit: number): Promise<EventPage[]> {
  const pages: EventPage[] = []
  let beforeSeq: number | undefined
  for (;;) {
    const page = await store.events.readPage(id, { beforeSeq, limit })
    pages.push(page)
    if (!page.hasEarlier) return pages
    assert.ok(page.events.length > 0, 'a page with earlier events is never empty')
    beforeSeq = page.events[0].seq
    assert.ok(pages.length < 10_000, 'paging terminates')
  }
}

function toolIds(e: StoredEvent): { uses: string[]; results: string[] } {
  const uses: string[] = []
  const results: string[] = []
  if (e.event.kind === 'sdk') {
    for (const b of e.event.message.message?.content ?? []) {
      if (b.type === 'tool_use') uses.push(b.id as string)
      if (b.type === 'tool_result') results.push(b.tool_use_id as string)
    }
  }
  return { uses, results }
}

/** Check one chain of pages against the full log; returns how each page was cut. */
function checkPages(pages: EventPage[], full: StoredEvent[], limit: number): Record<string, number> {
  // Oldest page first, concatenated, is the whole log in order.
  const chronological = [...pages].reverse()
  const rebuilt = chronological.flatMap((p) => p.events)
  assert.deepEqual(rebuilt.map((e) => e.seq), full.map((e) => e.seq))
  assert.deepEqual(rebuilt, full)

  const counts: Record<string, number> = {}
  const pageOfUse = new Map<string, number>()
  chronological.forEach((p, i) => {
    counts[p.boundary] = (counts[p.boundary] ?? 0) + 1
    assert.ok(p.events.length <= limit, `page of ${p.events.length} > limit ${limit}`)
    if (i === 0) {
      assert.equal(p.boundary, 'log-start')
      assert.equal(p.hasEarlier, false)
    } else {
      assert.notEqual(p.boundary, 'log-start')
      assert.equal(p.hasEarlier, true)
    }
    if (p.boundary === 'turn') assert.equal(p.events[0].event.kind, 'local_user', 'a turn page starts on a turn')
    for (const e of p.events) {
      const { uses, results } = toolIds(e)
      for (const u of uses) pageOfUse.set(u, i)
      for (const r of results) {
        const at = pageOfUse.get(r)
        assert.ok(at !== undefined, `result ${r} has its call earlier in the log`)
        // A call and its result on different pages: only a hard cut does that,
        // and it is the cut that started the page holding the result. Older
        // pages wholly inside a top-level call can't see it, so they may not.
        if (at !== i) assert.equal(p.boundary, 'hard', `tool ${r} split by a ${p.boundary} cut`)
      }
    }
  })
  return counts
}

// Tests

test('synthetic log: 5,000 events with the shapes paging must respect', () => {
  const log = syntheticLog()
  assert.equal(log.length, 5000)
  assert.ok(log.filter((e) => e.kind === 'local_user').length > 50)
})

test('readPage: chained pages rebuild a 5,000-event log, whole turns, no split tool calls', withStore(async (store) => {
  await seed(store, 's1', syntheticLog())
  const full = await store.events.read('s1')
  assert.equal(full.length, 5000)

  const counts = checkPages(await allPages(store, 's1', 300), full, 300)
  assert.ok((counts.turn ?? 0) > 5, 'most pages cut on a turn')
  assert.ok((counts.tool ?? 0) >= 1, 'the long turn is cut between tool calls')
  assert.equal(counts.hard ?? 0, 0, 'no 300-event page needs a hard cut')
}))

test('readPage: other page sizes chain to the same log', withStore(async (store) => {
  await seed(store, 's1', syntheticLog())
  const full = await store.events.read('s1')
  for (const limit of [1, 7, 50, 1000, 4999, 5000, 9000]) {
    checkPages(await allPages(store, 's1', limit), full, Math.min(limit, MAX_PAGE_LIMIT))
  }
}))

test('readPage: the default page is the newest events, ending at the log end', withStore(async (store) => {
  await seed(store, 's1', syntheticLog())
  const page = await store.events.readPage('s1')
  assert.ok(page.events.length <= DEFAULT_PAGE_LIMIT && page.events.length > 0)
  assert.equal(page.events.at(-1)!.seq, 5000)
  assert.equal(page.hasEarlier, true)
}))

test('readPage: an empty or unknown session is one empty page', withStore(async (store) => {
  await store.sessions.create({ id: 'empty', title: 'e', cwd: '/tmp', projectId: null })
  for (const id of ['empty', 'nope']) {
    assert.deepEqual(await store.events.readPage(id), { events: [], hasEarlier: false, boundary: 'log-start' })
  }
}))

test('readPage: a short log is one page that reaches the start', withStore(async (store) => {
  await seed(store, 's1', [user('hi'), init(), call('a'), result('a'), said('done'), done()])
  const page = await store.events.readPage('s1', { limit: 6 })
  assert.equal(page.events.length, 6)
  assert.equal(page.boundary, 'log-start')
  assert.equal(page.hasEarlier, false)
  // beforeSeq bounds the page; nothing at or after it comes back.
  const older = await store.events.readPage('s1', { beforeSeq: 4, limit: 10 })
  assert.deepEqual(older.events.map((e) => e.seq), [1, 2, 3])
}))

test('read: unchanged, the full log or everything after a seq, in order', withStore(async (store) => {
  const log = syntheticLog(600)
  await seed(store, 's1', log)
  const full = await store.events.read('s1')
  assert.deepEqual(full.map((e) => e.event), log)
  assert.deepEqual(full.map((e) => e.seq), log.map((_, i) => i + 1))
  const tail = await store.events.read('s1', 590)
  assert.deepEqual(tail.map((e) => e.seq), [591, 592, 593, 594, 595, 596, 597, 598, 599, 600])
  assert.deepEqual(await store.events.read('s1', 600), [])
}))

test('cutPage: the oldest turn start wins', () => {
  const w = [said('tail of an older turn'), done(), user('one'), call('a'), result('a'), user('two'), said('x')]
  assert.deepEqual(cutPage(w, false), { start: 2, boundary: 'turn' })
  assert.deepEqual(cutPage(w, true), { start: 0, boundary: 'log-start' })
})

test('cutPage: a turn start inside a tool call is not a cut', () => {
  // A relayed message can land while a subagent still runs.
  const w = [call('task', 'Task'), user('relay'), said('inner', 'task'), result('task'), user('next'), said('y')]
  assert.deepEqual(cutPage(w, false), { start: 4, boundary: 'turn' })
})

test('cutPage: inside one long turn, cut between tool calls', () => {
  const w = [result('older'), call('a'), result('a'), call('b'), result('b')]
  // Index 0 closes a call from an earlier page, so it can't start the page.
  assert.deepEqual(cutPage(w, false), { start: 1, boundary: 'tool' })
  const parallel = [call('a'), call('b'), result('a'), result('b'), said('z')]
  assert.deepEqual(cutPage(parallel, false), { start: 0, boundary: 'tool' })
  // Cuts between a call and its result are skipped.
  const mid = [result('older'), call('a'), said('waiting'), result('a'), said('after')]
  assert.deepEqual(cutPage(mid, false), { start: 1, boundary: 'tool' })
})

test('cutPage: a window wholly inside a subagent run is a hard cut', () => {
  // Neither the Task call nor its result is here, only what its subagent wrote.
  const w = [call('i', 'Read', 'task'), result('i', 'task'), said('still going', 'task')]
  assert.deepEqual(cutPage(w, false), { start: 0, boundary: 'hard' })
  // Once the Task's result is past, cuts are safe again, and a turn start wins.
  const after = [said('inner', 'task'), result('task'), said('done'), user('next')]
  assert.deepEqual(cutPage(after, false), { start: 3, boundary: 'turn' })
  const noTurn = [said('inner', 'task'), result('task'), said('done'), done()]
  assert.deepEqual(cutPage(noTurn, false), { start: 2, boundary: 'tool' })
})

test('cutPage: a call spanning the whole window is a hard cut', () => {
  const w = [said('inner', 'task'), call('i', 'Read', 'task'), result('i', 'task'), result('task')]
  assert.deepEqual(cutPage(w, false), { start: 0, boundary: 'hard' })
  assert.deepEqual(cutPage([], false), { start: 0, boundary: 'log-start' })
})

test('clampPageLimit: whole numbers in range, default for junk', () => {
  assert.equal(clampPageLimit(undefined), DEFAULT_PAGE_LIMIT)
  assert.equal(clampPageLimit(Number.NaN), DEFAULT_PAGE_LIMIT)
  assert.equal(clampPageLimit(0), 1)
  assert.equal(clampPageLimit(-5), 1)
  assert.equal(clampPageLimit(12.9), 12)
  assert.equal(clampPageLimit(1e9), MAX_PAGE_LIMIT)
})
