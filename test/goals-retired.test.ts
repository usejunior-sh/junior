/**
 * The old goals engine is gone (retire-goals-delete). What used to reach it
 * now lands somewhere clear: `junior goal` prints one retired line and exits
 * 1, `--help` no longer lists it, the external MCP lists no goal_* tools, and
 * an old goal on an item no longer moves the item's flow.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callTool, TOOLS, type McpApi } from '../core/mcp/tools.js'
import { flowOf, type FlowSignals } from '../core/work/flow.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Run the `junior` CLI in a throwaway JUNIOR_HOME, so nothing touches ~/.junior. */
function junior(...args: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'goals-retired-'))
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'server/cli.ts'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, JUNIOR_HOME: path.join(home, 'home'), NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 30_000,
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('junior goal and junior goals print the retired line and exit 1', () => {
  for (const args of [['goal'], ['goal', 'list'], ['goals', 'create', 'x']]) {
    const r = junior(...args)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.err, /"goal" is retired\. Ask Junior for a goal in a chat\. It runs as a team\./, args.join(' '))
    assert.equal(r.out, '')
  }
})

test('junior --help lists add, not goal', () => {
  const r = junior('--help')
  assert.equal(r.code, 0)
  assert.match(r.out, /junior add <title>/)
  assert.doesNotMatch(r.out, /junior goal|Goals/)
  assert.match(r.out, /the workspace add acts in/)
})

test('the goal-only flags are gone; --workspace still parses', () => {
  for (const flag of ['--done-when', '--horizon', '--state']) {
    const r = junior('add', 'x', flag, 'y')
    assert.equal(r.code, 1, flag)
    assert.match(r.err, new RegExp(`unknown option ${flag}`), flag)
  }
  // --workspace still parses (checked on a command that never calls a server).
  const r = junior('goal', '--workspace', 'w')
  assert.doesNotMatch(r.err, /unknown option/)
  assert.match(r.err, /"goal" is retired/)
})

test('the external MCP lists no goal_* tools, and a stale call is an unknown tool', async () => {
  assert.deepEqual(TOOLS.filter((t) => t.name.startsWith('goal_')), [])
  const api: McpApi = async () => {
    throw new Error('no call should reach the API')
  }
  for (const name of ['goal_create', 'goal_list', 'goal_get', 'goal_propose_plan']) {
    assert.deepEqual(await callTool(api, { serverUrl: 'http://localhost:1', requestedWorkspace: null }, name, {}), { text: `unknown tool: ${name}`, isError: true })
  }
})

test('an old goal on an item no longer puts it on your turn', () => {
  const item = { id: 'manual:1', kind: 'manual', source: 'manual', status: 'open', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' } as never
  const stale = { goal: { state: 'plan_ready', at: 9 } } as unknown as FlowSignals
  const flow = flowOf(item, stale)
  assert.deepEqual(flow, flowOf(item))
  assert.notEqual(flow.next, 'review the plan')
})
