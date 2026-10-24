/**
 * The hold (server/session/actions-hold.ts holdIfAction) fails closed, and
 * knows Junior's own servers by how they were registered, not by name
 * (core/actions/own.ts): a call it can't sort is held; a user's stdio server
 * called `browser` or `task` is held like any other; Junior's in-process
 * `browser` is free; an advance approval still lets a matching call go.
 * A fake runtime over a real SQLite store, no server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { isOwnHandIn, isOwnTool, NO_OWN_SERVERS, OWN_SERVER_NAMES, ownServersOf } from '../core/actions/own.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { unsortedAction } from '../core/actions/sort.js'
import { approvalFrom } from '../core/approvals/approvals.js'
import type { StoredSession } from '../core/store/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-hold-'))
process.env.JUNIOR_HOME = home
const { holdIfAction } = await import('../server/session/actions-hold.js')
const { openSqliteStore } = await import('../core/store/sqlite.js')

const SLACK = 'mcp__claude_ai_Slack__slack_send_message'

/** Junior's in-process servers as a session registers them, next to a user's stdio ones of the same names. */
const inProcess = (name: string) => createSdkMcpServer({ name, version: '0.0.0', tools: [] })
const chatServers = { junior: inProcess('junior'), browser: inProcess('browser') }

type Fixture = { rt: WorkspaceRuntime; row: StoredSession; sortThrows: { on: boolean } }

async function withHold(fn: (f: Fixture) => Promise<void>) {
  const dir = mkdtempSync(path.join(home, 'ws-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const sortThrows = { on: false }
  const rt = {
    meta: { id: 'ws-test' },
    store,
    clients: new Set(),
    taskRuns: new Map(),
    sessionTeam: new Map(),
    teamRuns: new Map(),
    sessionItem: new Map(),
    ruleAllowed: new Map(),
    heldCalls: new Map(),
    actionChain: Promise.resolve(),
    actionsDirty: null,
    inboxCache: null,
    connectorCache: null,
    folderProbes: new Map(),
    actionsFile: {
      current: () => {
        if (sortThrows.on) throw new Error('actions file unreadable')
        return { rules: DEFAULT_RULES }
      },
    },
  } as unknown as WorkspaceRuntime
  const row = { id: 'chat-1', provider: 'claude', kind: 'chat', cwd: dir, permissionMode: 'auto', jobId: null } as unknown as StoredSession
  try {
    await fn({ rt, row, sortThrows })
    await rt.actionChain
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const held = (d: { allow: boolean; reason?: string }) => !d.allow && /Queued for the user's approval/.test(d.reason ?? '')

// ── identity, pure ──────────────────────────────────────────────────────────

test('own servers: only the ones registered in-process under one of Junior’s names', () => {
  const own = ownServersOf({
    ...chatServers,
    // A user's stdio servers that happen to share Junior's names.
    task: { type: 'stdio', command: 'my-task-server' },
    team: { command: 'node', args: ['team.js'] },
    // What a config file can say: `type: 'sdk'`, but no live instance.
    goal: { type: 'sdk', name: 'goal', instance: {} },
    // An in-process server under a name that isn't Junior's.
    notes: inProcess('notes'),
  })
  assert.deepEqual([...own].sort(), ['browser', 'junior'])
  assert.deepEqual([...ownServersOf(undefined)], [])
})

test('isOwnTool is false for a user server named task, browser or junior', () => {
  const own = ownServersOf({ task: { type: 'stdio', command: 'x' }, browser: { type: 'http', url: 'http://x' }, junior: { type: 'stdio', command: 'junior-mcp' } })
  assert.equal(own.size, 0)
  for (const t of ['mcp__task__create_task', 'mcp__browser__browser_act', 'mcp__junior__create_work_item']) assert.equal(isOwnTool(t, own), false, t)
  assert.equal(isOwnTool('mcp__browser__browser_act', ownServersOf(chatServers)), true)
  assert.equal(isOwnTool('Bash', OWN_SERVER_NAMES), false)
})

test('an old hand-in record hides from sends; a held call to a same-named server shows', () => {
  assert.equal(isOwnHandIn({ tool: 'mcp__task__submit_task', queue: null }), true)
  assert.equal(isOwnHandIn({ tool: 'mcp__task__create_task', queue: { args: {} } }), false)
  assert.equal(isOwnHandIn({ tool: SLACK, queue: null }), false)
})

test('a call the sort couldn’t judge counts as an unknown action', () => {
  assert.deepEqual(unsortedAction('mcp__acme__frob', {}), { kind: 'other', why: 'unknown', whyDetail: null, summary: 'Frob' })
  assert.equal(unsortedAction('Bash', { command: 'curl -X POST https://x' }).summary, 'curl -X POST https://x')
})

// ── the hold ────────────────────────────────────────────────────────────────

test('hold: a sort that throws on an MCP call holds it, never allows it', async () => {
  await withHold(async ({ rt, row, sortThrows }) => {
    sortThrows.on = true
    const d = await holdIfAction(rt, row, 'mcp__acme__frob_widget', { id: 7 }, { toolUseId: 'tu-1', own: ownServersOf(chatServers) })
    assert.ok(held(d), JSON.stringify(d))
    await rt.actionChain
    const rec = await rt.store.actions.byCall(row.id, 'tu-1')
    assert.equal(rec?.status, 'needs_you')
    assert.equal(rec?.why, 'unknown')
    assert.deepEqual(rec?.queue?.args, { id: 7 })
  })
})

test('hold: a chat’s shell command the sort can’t judge is held too', async () => {
  await withHold(async ({ rt, row, sortThrows }) => {
    sortThrows.on = true
    const d = await holdIfAction(rt, row, 'Bash', { command: 'curl -X POST https://example.com/hook' }, { toolUseId: 'tu-2', own: NO_OWN_SERVERS })
    assert.ok(held(d), JSON.stringify(d))
  })
})

test('hold: a user’s stdio server named browser is held for a write tool', async () => {
  await withHold(async ({ rt, row }) => {
    // The session registered only `junior` in-process; `browser` is the user's.
    const own = ownServersOf({ junior: inProcess('junior'), browser: { type: 'stdio', command: 'my-browser-mcp' } })
    const d = await holdIfAction(rt, row, 'mcp__browser__browser_act', { action: 'click', uid: 3 }, { toolUseId: 'tu-3', own })
    assert.ok(held(d), JSON.stringify(d))
    const task = await holdIfAction(rt, row, 'mcp__task__create_task', { title: 'x' }, { toolUseId: 'tu-4', own })
    assert.ok(held(task), JSON.stringify(task))
  })
})

test('hold: Junior’s in-process browser and junior servers are free', async () => {
  await withHold(async ({ rt, row }) => {
    const own = ownServersOf(chatServers)
    assert.deepEqual(await holdIfAction(rt, row, 'mcp__browser__browser_act', { action: 'click', uid: 3 }, { toolUseId: 'tu-5', own }), { allow: true })
    assert.deepEqual(await holdIfAction(rt, row, 'mcp__junior__create_work_item', { title: 'x' }, { toolUseId: 'tu-6', own }), { allow: true })
    await rt.actionChain
    assert.equal((await rt.store.actions.list()).length, 0, 'nothing recorded for a free call')
  })
})

test('hold: an advance approval still covers a matching call', async () => {
  await withHold(async ({ rt, row }) => {
    const r = approvalFrom({ what: 'slack-dm', who: { id: 'U04ANI', name: 'Anirudha' }, why: 'PR-ready pings' }, { id: 'a1b2c3d4-0000', now: Date.now(), sessionId: null, proposalId: null })
    assert.ok(r.ok)
    await rt.store.approvals.put(r.approval)
    const own = ownServersOf(chatServers)
    const d = await holdIfAction(rt, row, SLACK, { channel_id: 'U04ANI', message: 'The PR is ready' }, { toolUseId: 'tu-7', own })
    assert.equal(d.allow, true)
    assert.match(d.allow ? (d.sure ?? '') : '', /Approved in advance by the user: DM Anirudha on Slack/)
    assert.equal((await rt.store.approvals.get(r.approval.id))?.uses, 1)
    // Anyone else is still held.
    const other = await holdIfAction(rt, row, SLACK, { channel_id: 'U09DREW', message: 'hi' }, { toolUseId: 'tu-8', own })
    assert.ok(held(other), JSON.stringify(other))
  })
})

test.after(() => rmSync(home, { recursive: true, force: true }))
