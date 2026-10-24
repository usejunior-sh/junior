/**
 * hand_off_work_item on every MCP door: one table entry in core/mcp/tools.ts
 * that the stdio shim and POST /mcp list as-is, and the in-process server
 * (server/junior-mcp.ts) takes its name, description and answer from. The
 * answer always carries readiness; a watch that is off is reported, never
 * switched on. The note lands in the item's decisions, which every task reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callTool, HAND_OFF_TOOL, handOffAnswer, type McpApi, TOOLS } from '../core/mcp/tools.js'
import { HAND_OFF_NOTE_MAX, handoffNote, type HandoffReadiness } from '../core/work/handoff.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { WorkItem } from '../core/work/types.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-mcp-handoff-'))
process.env.JUNIOR_HOME = home
// Loaded first on purpose: junior-mcp → handoff-ops → the watches → the task
// runner, which registers its hooks as it loads (server/babysit/hooks.ts).
const { makeJuniorMcp } = await import('../server/junior-mcp.js')
const { classifyEffect } = await import('../server/session/effects.js')
const { BRIEF_DISALLOWED_TOOLS } = await import('../server/session/brief-tools.js')
const { watchesOn } = await import('../server/settings-ops.js')

const conn = { serverUrl: 'http://localhost:1/mcp', requestedWorkspace: null }
type Call = { path: string; body: unknown; method: string | undefined }

/** A fake daemon: records every call, answers with `answer`. */
function fakeApi(answer: unknown): { api: McpApi; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    api: async (p, body, method) => {
      calls.push({ path: p, body, method })
      return answer
    },
  }
}

test('one table entry: listed once on the external doors, id required, note optional', () => {
  const entries = TOOLS.filter((t) => t.name === 'hand_off_work_item')
  assert.equal(entries.length, 1)
  assert.equal(entries[0], HAND_OFF_TOOL)
  assert.deepEqual(HAND_OFF_TOOL.inputSchema.required, ['id'])
  assert.deepEqual(Object.keys(HAND_OFF_TOOL.inputSchema.properties).sort(), ['id', 'note'])
  assert.match(HAND_OFF_TOOL.inputSchema.properties.note.description, new RegExp(String(HAND_OFF_NOTE_MAX)))
  // it says what happens when a watch is off, and that the user turns it on
  assert.match(HAND_OFF_TOOL.description, /Settings → Automations/)
  assert.doesNotMatch(HAND_OFF_TOOL.description, /24\/7|walk away/i)
})

const ANSWERS: { name: string; readiness: HandoffReadiness; says: RegExp }[] = [
  { name: 'ready', readiness: { state: 'ready' }, says: /^ok: handed github:a\/b#1 to Junior\. Junior is on it\.\n/ },
  { name: 'babysit off', readiness: { state: 'watch-off', watch: 'babysit' }, says: /babysitting is off, so nothing runs yet\. Tell the user.*Settings → Automations\. Don't turn it on yourself\./ },
  { name: 'reviews off', readiness: { state: 'watch-off', watch: 'review' }, says: /first-pass reviews are off, so nothing runs yet/ },
  { name: 'unsupported', readiness: { state: 'unsupported', why: 'Junior babysits GitHub PRs only' }, says: /nothing runs on it: Junior babysits GitHub PRs only\./ },
]

for (const row of ANSWERS)
  test(`handOffAnswer, ${row.name}: one sentence to act on, then readiness as JSON`, () => {
    const text = handOffAnswer('github:a/b#1', row.readiness)
    assert.match(text, row.says)
    const last = text.split('\n').at(-1)!
    assert.ok(last.startsWith('readiness: '))
    assert.deepEqual(JSON.parse(last.slice('readiness: '.length)), row.readiness)
  })

test('dispatcher: posts the hand-off with the note, answers with readiness', async () => {
  const { api, calls } = fakeApi({ ok: true, item: { id: 'github:a/b#1' }, readiness: { state: 'watch-off', watch: 'babysit' } })
  const r = await callTool(api, conn, 'hand_off_work_item', { id: 'github:a/b#1', note: 'the flaky test is in auth.spec' })
  assert.equal(r.isError, false)
  assert.deepEqual(calls, [{ path: '/api/handoff/start', body: { itemId: 'github:a/b#1', note: 'the flaky test is in auth.spec' }, method: undefined }])
  assert.equal(r.text, handOffAnswer('github:a/b#1', { state: 'watch-off', watch: 'babysit' }))
})

test('dispatcher: no note sends none; a missing id or a non-text note never reaches the daemon', async () => {
  const { api, calls } = fakeApi({ ok: true, readiness: { state: 'ready' } })
  await callTool(api, conn, 'hand_off_work_item', { id: 'manual:1' })
  assert.deepEqual(calls[0]!.body, { itemId: 'manual:1' })
  assert.deepEqual(await callTool(api, conn, 'hand_off_work_item', {}), { text: 'rejected: need a work-item id', isError: true })
  assert.equal((await callTool(api, conn, 'hand_off_work_item', { id: 'manual:1', note: 3 })).isError, true)
  assert.equal(calls.length, 1)
})

test("dispatcher: the daemon's refusal is the tool's error", async () => {
  const { api } = fakeApi({ ok: false, error: '"Investigate" is already on its way' })
  assert.deepEqual(await callTool(api, conn, 'hand_off_work_item', { id: 'manual:1' }), { text: 'rejected: "Investigate" is already on its way', isError: true })
})

test('create_work_item answers with the new id, which hand_off_work_item needs next', async () => {
  const { api } = fakeApi({ ok: true, id: 'manual:abc' })
  assert.deepEqual(await callTool(api, conn, 'create_work_item', { title: 'x' }), { text: 'ok: created manual:abc', isError: false })
})

const NOTES: [unknown, string | null][] = [
  [undefined, null],
  [null, null],
  ['', null],
  ['   \n ', null],
  ['  look at\n\nauth.spec  ', 'look at auth.spec'],
  ['x'.repeat(HAND_OFF_NOTE_MAX), 'x'.repeat(HAND_OFF_NOTE_MAX)],
  ['x'.repeat(HAND_OFF_NOTE_MAX + 20), `${'x'.repeat(HAND_OFF_NOTE_MAX - 1)}…`],
]

test('handoffNote: one line, folded and cut, blank is none, non-text refused', () => {
  for (const [raw, want] of NOTES) assert.equal(handoffNote(raw), want, JSON.stringify(raw))
  assert.throws(() => handoffNote(42), /one line of text/)
})

test('in a chat it is a write: it prompts, and a brief never sees it', () => {
  assert.equal(classifyEffect('mcp__junior__hand_off_work_item'), 'local-write')
  assert.ok(BRIEF_DISALLOWED_TOOLS.includes('mcp__junior__hand_off_work_item'))
})

type Registered = { description?: string; handler?: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }

test('in-process server: same name and description, hands off, keeps the note, reports the watch off and leaves it off', async () => {
  const dir = mkdtempSync(path.join(home, 'ws-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    const pr: WorkItem = {
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
    await store.items.upsert(pr)
    const rt = { meta: { id: 'ws-test' }, store, clients: new Set(), inboxCache: null } as never
    const server = makeJuniorMcp(rt, 'chat-1') as unknown as { instance: { _registeredTools: Record<string, Registered> } }
    const t = server.instance._registeredTools['hand_off_work_item']
    assert.ok(t?.handler, 'hand_off_work_item is registered in-process')
    assert.equal(t.description, HAND_OFF_TOOL.description)

    const res = await t.handler({ id: pr.id, note: 'only the retry path' }, {})
    assert.notEqual(res.isError, true, res.content[0]?.text)
    assert.equal(res.content[0]!.text, handOffAnswer(pr.id, { state: 'watch-off', watch: 'babysit' }))

    const after = (await store.items.get(pr.id))!
    assert.equal(after.handoff, 'on')
    assert.deepEqual(after.memory?.decisions.map((d) => [d.by, d.text]), [['you', 'Handed to Junior to babysit it. Note: only the retry path']])
    // reported, not fixed: the switch is still off
    assert.deepEqual(await watchesOn(rt), { babysit: false, review: false })

    const missing = await t.handler({ id: 'github:acme/api#999' }, {})
    assert.equal(missing.isError, true)
    assert.match(missing.content[0]!.text, /no such item/)
  } finally {
    // let the fire-and-forget poll the hand-off started settle before the store closes
    await new Promise((r) => setTimeout(r, 50))
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
