/**
 * Paged replay over the socket: the `subscribe` / `session_events_before`
 * frames as server/ws/parse.ts validates them, and what server/ws/history.ts
 * sends a socket for each. A paged open sends one page, not the whole log;
 * chained earlier pages rebuild it; a plain subscribe is unchanged.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { parseClientMessage } from '../server/ws/parse.js'
import { replaySession, type ReplayRuntime } from '../server/ws/history.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../core/store/event-page.js'
import type { ClientMessage, ServerMessage, SessionEvent } from '../shared/protocol.js'

// Parsing

test('parse: a plain subscribe stays plain', () => {
  assert.deepEqual(parseClientMessage({ type: 'subscribe', sessionId: 's1' }), { type: 'subscribe', sessionId: 's1' })
  // A flag that isn't exactly true, and a limit without paging, are dropped.
  assert.deepEqual(parseClientMessage({ type: 'subscribe', sessionId: 's1', paged: 'yes', limit: 10 }), { type: 'subscribe', sessionId: 's1' })
  assert.deepEqual(parseClientMessage({ type: 'subscribe', sessionId: 's1', paged: 1 }), { type: 'subscribe', sessionId: 's1' })
  assert.equal(parseClientMessage({ type: 'subscribe' }), null)
  assert.equal(parseClientMessage({ type: 'subscribe', sessionId: 7 }), null)
})

test('parse: a paged subscribe keeps a sane limit', () => {
  assert.deepEqual(parseClientMessage({ type: 'subscribe', sessionId: 's1', paged: true }), { type: 'subscribe', sessionId: 's1', paged: true })
  assert.deepEqual(parseClientMessage({ type: 'subscribe', sessionId: 's1', paged: true, limit: 50 }), {
    type: 'subscribe',
    sessionId: 's1',
    paged: true,
    limit: 50,
  })
  // Clamped and floored; junk falls back to the store's default (no limit on the frame).
  const limitOf = (limit: unknown) => (parseClientMessage({ type: 'subscribe', sessionId: 's', paged: true, limit }) as { limit?: number }).limit
  assert.equal(limitOf(10.9), 10)
  assert.equal(limitOf(0), 1)
  assert.equal(limitOf(-5), 1)
  assert.equal(limitOf(1e9), MAX_PAGE_LIMIT)
  assert.equal(limitOf('50'), undefined)
  assert.equal(limitOf(Number.NaN), undefined)
  assert.equal(limitOf(Number.POSITIVE_INFINITY), undefined)
  assert.equal(limitOf(null), undefined)
})

test('parse: session_events_before needs a session and a whole seq cursor', () => {
  assert.deepEqual(parseClientMessage({ type: 'session_events_before', sessionId: 's1', beforeSeq: 301 }), {
    type: 'session_events_before',
    sessionId: 's1',
    beforeSeq: 301,
  })
  assert.deepEqual(parseClientMessage({ type: 'session_events_before', sessionId: 's1', beforeSeq: 301, limit: 20, extra: 'x' }), {
    type: 'session_events_before',
    sessionId: 's1',
    beforeSeq: 301,
    limit: 20,
  })
  for (const beforeSeq of [undefined, null, '301', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
    assert.equal(parseClientMessage({ type: 'session_events_before', sessionId: 's1', beforeSeq }), null, `beforeSeq ${String(beforeSeq)}`)
  }
  assert.equal(parseClientMessage({ type: 'session_events_before', beforeSeq: 5 }), null)
  assert.equal(parseClientMessage({ type: 'session_events_before', sessionId: ['s1'], beforeSeq: 5 }), null)
})

// Replay over a fake socket

/** A socket that records what it was sent. `readyState` 1 is OPEN. */
function fakeSocket() {
  const frames: ServerMessage[] = []
  const ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data) as ServerMessage) }
  return { ws: ws as unknown as WebSocket, frames }
}

const user = (text: string): SessionEvent => ({ kind: 'local_user', text })
const said = (text: string): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const call = (id: string): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } },
})
const result = (id: string): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
})

/** `turns` turns of a user line, a tool call and its result, and a reply: 4 events each. */
function log(turns: number): SessionEvent[] {
  const out: SessionEvent[] = []
  for (let t = 0; t < turns; t++) out.push(user(`turn ${t}`), call(`c${t}`), result(`c${t}`), said(`done ${t}`))
  return out
}

type TestRuntime = ReplayRuntime & { rows: Set<string>; previews: Map<string, { events: SessionEvent[] }> }

function withRuntime(fn: (rt: TestRuntime, store: ReturnType<typeof openSqliteStore>) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-replay-'))
    try {
      const store = openSqliteStore(path.join(dir, 'junior.db'))
      const rt: TestRuntime = { rows: new Set<string>(), previews: new Map<string, { events: SessionEvent[] }>(), store }
      await fn(rt, store)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

async function seed(rt: { rows: Set<string> }, store: ReturnType<typeof openSqliteStore>, id: string, events: SessionEvent[]) {
  await store.sessions.create({ id, title: 'long', cwd: '/tmp', projectId: null })
  for (let i = 0; i < events.length; i++) await store.events.append(id, i + 1, events[i])
  rt.rows.add(id)
}

/** Parse a raw frame the way the socket does, then replay it. */
async function replay(rt: ReplayRuntime, ws: WebSocket, raw: unknown) {
  const msg = parseClientMessage(raw) as ClientMessage
  assert.ok(msg && (msg.type === 'subscribe' || msg.type === 'session_events_before'))
  await replaySession(rt, ws, msg)
}

test(
  'a paged open sends one page, not the full log',
  withRuntime(async (rt, store) => {
    const full = log(500) // 2,000 events
    await seed(rt, store, 's1', full)
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 's1', paged: true })
    assert.equal(frames.length, 1)
    const h = frames[0]
    assert.equal(h.type, 'history')
    if (h.type !== 'history') return
    assert.ok(h.events.length > 0 && h.events.length <= DEFAULT_PAGE_LIMIT, `page of ${h.events.length}`)
    assert.ok(h.events.length < full.length)
    assert.equal(h.hasEarlier, true)
    assert.equal(h.times?.length, h.events.length)
    // The newest events, starting on a turn.
    assert.deepEqual(h.events, full.slice(full.length - h.events.length))
    assert.equal(h.events[0].kind, 'local_user')
    assert.equal(h.firstSeq, full.length - h.events.length + 1)
  }),
)

test(
  'earlier pages chained from firstSeq rebuild the whole log',
  withRuntime(async (rt, store) => {
    const full = log(60) // 240 events
    await seed(rt, store, 's1', full)
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 's1', paged: true, limit: 50 })
    const first = frames[0]
    assert.ok(first.type === 'history')
    if (first.type !== 'history') return
    const pages: SessionEvent[][] = [first.events]
    let hasEarlier = first.hasEarlier === true
    let cursor = first.firstSeq
    while (hasEarlier) {
      assert.ok(cursor !== undefined)
      await replay(rt, ws, { type: 'session_events_before', sessionId: 's1', beforeSeq: cursor, limit: 50 })
      const p = frames[frames.length - 1]
      assert.equal(p.type, 'session_events_page')
      if (p.type !== 'session_events_page') return
      assert.equal(p.sessionId, 's1')
      assert.equal(p.beforeSeq, cursor)
      assert.ok(p.events.length > 0 && p.events.length <= 50)
      assert.equal(p.times.length, p.events.length)
      pages.unshift(p.events)
      hasEarlier = p.hasEarlier
      cursor = p.firstSeq
      assert.ok(pages.length < 100, 'paging terminates')
    }
    assert.deepEqual(pages.flat(), full)
    assert.ok(pages.length >= 5)
  }),
)

test(
  'a plain subscribe still sends the whole log',
  withRuntime(async (rt, store) => {
    const full = log(100)
    await seed(rt, store, 's1', full)
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 's1' })
    assert.equal(frames.length, 1)
    const h = frames[0]
    assert.ok(h.type === 'history')
    if (h.type !== 'history') return
    assert.deepEqual(h.events, full)
    assert.equal(h.times?.length, full.length)
    assert.equal('hasEarlier' in h, false)
    assert.equal('firstSeq' in h, false)
  }),
)

test(
  'a short session pages to the whole log with nothing earlier',
  withRuntime(async (rt, store) => {
    const full = log(3)
    await seed(rt, store, 's1', full)
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 's1', paged: true })
    const h = frames[0]
    assert.ok(h.type === 'history' && h.hasEarlier === false && h.firstSeq === 1)
    if (h.type === 'history') assert.deepEqual(h.events, full)
  }),
)

test(
  'an empty session pages to an empty history with no cursor',
  withRuntime(async (rt, store) => {
    await seed(rt, store, 'empty', [])
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 'empty', paged: true })
    assert.deepEqual(frames, [{ type: 'history', sessionId: 'empty', events: [], times: [], hasEarlier: false }])
  }),
)

test(
  'a dry run is sent whole, and asking it for earlier gets an empty page',
  withRuntime(async (rt) => {
    const events = log(2)
    rt.previews.set('preview-1', { events })
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 'preview-1', paged: true })
    assert.deepEqual(frames[0], { type: 'history', sessionId: 'preview-1', events, hasEarlier: false })
    await replay(rt, ws, { type: 'session_events_before', sessionId: 'preview-1', beforeSeq: 5 })
    assert.deepEqual(frames[1], { type: 'session_events_page', sessionId: 'preview-1', beforeSeq: 5, events: [], times: [], hasEarlier: false })
  }),
)

test(
  "another workspace's session answers nothing but an empty page",
  withRuntime(async (rt, store) => {
    // In the store but not this runtime's rows: never replayed to this socket.
    await store.sessions.create({ id: 'elsewhere', title: 'x', cwd: '/tmp', projectId: null })
    for (let i = 0; i < 8; i++) await store.events.append('elsewhere', i + 1, log(2)[i])
    const { ws, frames } = fakeSocket()
    await replay(rt, ws, { type: 'subscribe', sessionId: 'elsewhere', paged: true })
    assert.equal(frames.length, 0)
    await replay(rt, ws, { type: 'session_events_before', sessionId: 'elsewhere', beforeSeq: 9 })
    assert.deepEqual(frames, [{ type: 'session_events_page', sessionId: 'elsewhere', beforeSeq: 9, events: [], times: [], hasEarlier: false }])
  }),
)

test(
  'a closed socket is sent nothing',
  withRuntime(async (rt, store) => {
    await seed(rt, store, 's1', log(2))
    const frames: string[] = []
    const ws = { readyState: 3, send: (d: string) => frames.push(d) } as unknown as WebSocket
    await replaySession(rt, ws, { type: 'subscribe', sessionId: 's1', paged: true })
    assert.equal(frames.length, 0)
  }),
)
