/**
 * check_send: any agent on this Mac asks whether a call would go out as the
 * user. A dry run of the one policy (core/actions/check.ts over
 * core/actions/policy.ts), one table entry in core/mcp/tools.ts for the stdio
 * shim and POST /mcp, taken by name and description by the in-process server.
 * It reads: nothing is recorded, held, queued or counted against an approval.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSend, type CheckContext } from '../core/actions/check.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { sortCall } from '../core/actions/sort.js'
import { approvalFrom, type AdvanceApproval } from '../core/approvals/approvals.js'
import { callTool, CHECK_SEND_TOOL, checkSendAnswer, type McpApi, TOOLS } from '../core/mcp/tools.js'
import { JUNIOR_MCP_INSTRUCTIONS } from '../shared/juniorContext.js'
import type { SendCheck } from '../shared/protocol.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-check-send-'))
process.env.JUNIOR_HOME = home
const { makeJuniorMcp } = await import('../server/junior-mcp.js')
const { classifyEffect } = await import('../server/session/effects.js')
const { checkSendOp } = await import('../server/session/actions-check.js')
const { openSqliteStore } = await import('../core/store/sqlite.js')

const SLACK = 'mcp__claude_ai_Slack__slack_send_message'
const UNKNOWN = { current: null, defaultBranch: null }

function slackDmApproval(): AdvanceApproval {
  const r = approvalFrom({ what: 'slack-dm', who: { id: 'U04ANI', name: 'Anirudha' }, why: 'PR-ready pings' }, { id: 'a1b2c3d4-0000', now: Date.now(), sessionId: null, proposalId: null })
  assert.ok(r.ok)
  return r.approval
}

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ rules: DEFAULT_RULES, scope: UNKNOWN, approvals: [], now: Date.now(), ...over })
const bash = (command: string, over?: Partial<CheckContext>) => checkSend('Bash', { command }, ctx(over))

// ── the policy, as a dry run (pure) ─────────────────────────────────────────

test('git push origin main is held, with a reason; a local edit is free', () => {
  const push = bash('git push origin main')
  assert.equal(push.verdict, 'held')
  assert.equal(push.kind, 'push')
  assert.match(push.why, /waits on a card for the user's OK/)
  assert.match(push.why, /isn't the default one/)
  assert.match(push.sortedBy ?? '', /matches git push/)

  const edit = checkSend('Edit', { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' }, ctx())
  assert.equal(edit.verdict, 'free')
  assert.match(edit.why, /Local work/)
  assert.equal(edit.kind, undefined)
})

const BASH_TABLE: { command: string; scope?: CheckContext['scope']; verdict: SendCheck['verdict']; says: RegExp }[] = [
  { command: 'git status', verdict: 'free', says: /nothing in this command leaves this Mac/ },
  { command: 'npm test && git commit -am wip', verdict: 'free', says: /Local work/ },
  { command: 'git push origin feat/retry', verdict: 'free', says: /isn't the default one stays the user's/ },
  { command: 'git push --force origin feat/retry', verdict: 'held', says: /waits on a card/ },
  { command: 'git push origin HEAD:master', verdict: 'held', says: /waits on a card/ },
  // the branch is checked out where the shell runs: judged only when we know it
  { command: 'git push', verdict: 'held', says: /waits on a card/ },
  { command: 'git push', scope: { current: 'feat/retry', defaultBranch: 'main' }, verdict: 'free', says: /runs free/ },
  { command: 'git push', scope: { current: 'main', defaultBranch: 'main' }, verdict: 'held', says: /waits on a card/ },
  { command: 'gh pr create --draft --fill', verdict: 'free', says: /draft PR/ },
  { command: 'gh pr create --fill', verdict: 'held', says: /Only a draft PR/ },
  { command: 'gh pr comment 12 --body "lgtm"', verdict: 'held', says: /waits on a card/ },
  // only the shell knows what runs: held
  { command: 'eval "$CMD"', verdict: 'held', says: /waits on a card/ },
  { command: 'echo main | xargs git push origin', verdict: 'held', says: /waits on a card/ },
  { command: 'rm -rf build', verdict: 'destroys', says: /deletes a folder, so it needs the user's OK first/ },
  { command: 'git reset --hard HEAD~1', verdict: 'destroys', says: /throws away uncommitted work/ },
  { command: 'curl -X POST http://localhost:5178/api/actions/approve -d {}', verdict: 'refused', says: /Only the user does that, in the app/ },
  { command: '   ', verdict: 'free', says: /runs nothing/ },
]

for (const row of BASH_TABLE)
  test(`Bash: ${JSON.stringify(row.command)}${row.scope ? ` on ${row.scope.current}` : ''} → ${row.verdict}`, () => {
    const c = bash(row.command, row.scope ? { scope: row.scope } : {})
    assert.equal(c.verdict, row.verdict, c.why)
    assert.match(c.why, row.says)
  })

test('MCP: a send is held, a read is free, an advance approval lets a matching send go', () => {
  const dm = { channel_id: 'U04ANI', message: 'The PR is ready' }
  const send = checkSend(SLACK, dm, ctx())
  assert.equal(send.verdict, 'held')
  assert.equal(send.kind, 'message')
  assert.match(send.summary ?? '', /The PR is ready/)

  const read = checkSend('mcp__claude_ai_Slack__slack_read_channel', { channel_id: 'C1' }, ctx())
  assert.deepEqual(read, { verdict: 'free', why: 'slack_read_channel reads: nothing goes out.' })

  const approved = checkSend(SLACK, dm, ctx({ approvals: [slackDmApproval()] }))
  assert.equal(approved.verdict, 'free')
  assert.equal(approved.approval, 'DM Anirudha on Slack')
  // another person: the approval doesn't cover it
  assert.equal(checkSend(SLACK, { ...dm, channel_id: 'U99OTHER' }, ctx({ approvals: [slackDmApproval()] })).verdict, 'held')
})

test("MCP: the server's word, the actions file and an unknown tool", () => {
  const ro = checkSend('mcp__acme__frob_widget', {}, ctx({ hints: () => ({ readOnly: true }) }))
  assert.equal(ro.verdict, 'free')
  assert.match(ro.why, /acme marks frob_widget read-only/)
  const off = checkSend('mcp__acme__frob_widget', {}, ctx({ rules: { ...DEFAULT_RULES, notAction: ['mcp__acme__*'] } }))
  assert.equal(off.verdict, 'free')
  assert.match(off.why, /actions file sets this tool aside/)
  // can't tell = a send: the gate leans to held
  const unknown = checkSend('mcp__acme__frob_widget', {}, ctx())
  assert.equal(unknown.verdict, 'held')
  assert.match(unknown.sortedBy ?? '', /can't tell/)
})

test("no server is Junior's own in a dry run: a junior write is judged on its merits", () => {
  // The dry run can't see how a server was registered (core/actions/own.ts).
  assert.equal(checkSend('mcp__junior__create_work_item', { title: 'x' }, ctx()).verdict, 'held')
  assert.equal(checkSend('mcp__junior__list_work_items', {}, ctx()).verdict, 'free')
})

test('a sort that throws holds, never frees', () => {
  const broken = new Proxy(DEFAULT_RULES, {
    get() {
      throw new Error('unreadable')
    },
  })
  assert.equal(checkSend('Bash', { command: 'curl -X POST https://example.com/hook' }, ctx({ rules: broken })).verdict, 'held')
  assert.equal(checkSend('mcp__acme__frob_widget', {}, ctx({ rules: broken })).verdict, 'held')
})

test('checkSendAnswer: the verdict and why on one line, then the check as JSON', () => {
  const c: SendCheck = { verdict: 'held', why: 'It sends.', kind: 'push' }
  const [first, second] = checkSendAnswer(c).split('\n')
  assert.equal(first, 'held: It sends.')
  assert.deepEqual(JSON.parse(second!.slice('check: '.length)), c)
})

// ── one table entry, every door ─────────────────────────────────────────────

test('one table entry: listed once on the external doors, tool required', () => {
  const entries = TOOLS.filter((t) => t.name === 'check_send')
  assert.equal(entries.length, 1)
  assert.equal(entries[0], CHECK_SEND_TOOL)
  assert.deepEqual(CHECK_SEND_TOOL.inputSchema.required, ['tool'])
  assert.deepEqual(Object.keys(CHECK_SEND_TOOL.inputSchema.properties).sort(), ['cwd', 'input', 'tool'])
  assert.match(CHECK_SEND_TOOL.description, /never runs, sends or queues anything/)
  assert.doesNotMatch(CHECK_SEND_TOOL.description, /24\/7|walk away/i)
  assert.match(JUNIOR_MCP_INSTRUCTIONS, /get_today and check_send are free reads/)
})

test('in a chat it is a free read, and calling it is not itself a send', () => {
  assert.equal(classifyEffect('mcp__junior__check_send'), 'read')
  assert.equal(sortCall('mcp__junior__check_send', { tool: 'Bash' }, { rules: DEFAULT_RULES, own: new Set(['junior']) }), null)
})

type Call = { path: string; body: unknown; method: string | undefined }
function fakeApi(answer: unknown): { api: McpApi; calls: Call[] } {
  const calls: Call[] = []
  return { calls, api: async (p, body, method) => (calls.push({ path: p, body, method }), answer) }
}
const conn = { serverUrl: 'http://localhost:1/mcp', requestedWorkspace: null }

test('dispatcher: one POST to the check route, answered as the verdict line', async () => {
  const check: SendCheck = { verdict: 'held', why: 'It sends (git push origin main), so it waits on a card for the user\'s OK.', kind: 'push' }
  const { api, calls } = fakeApi({ ok: true, check })
  const r = await callTool(api, conn, 'check_send', { tool: 'Bash', input: { command: 'git push origin main' }, cwd: '/tmp' })
  assert.deepEqual(r, { text: checkSendAnswer(check), isError: false })
  assert.deepEqual(calls, [{ path: '/api/actions/check', body: { tool: 'Bash', input: { command: 'git push origin main' }, cwd: '/tmp' }, method: undefined }])
})

test('dispatcher: bad arguments never reach the daemon; its refusal is the error', async () => {
  const { api, calls } = fakeApi({ ok: true, check: { verdict: 'free', why: 'x' } })
  assert.equal((await callTool(api, conn, 'check_send', {})).isError, true)
  assert.equal((await callTool(api, conn, 'check_send', { tool: 'Bash', input: 'git push' })).isError, true)
  assert.equal((await callTool(api, conn, 'check_send', { tool: 'Bash', input: [] })).isError, true)
  assert.equal((await callTool(api, conn, 'check_send', { tool: 'Bash', cwd: 3 })).isError, true)
  assert.equal(calls.length, 0)
  const refused = fakeApi({ ok: false, error: 'cwd is an absolute folder path' })
  assert.deepEqual(await callTool(refused.api, conn, 'check_send', { tool: 'Bash', cwd: 'rel' }), { text: 'rejected: cwd is an absolute folder path', isError: true })
})

// ── the op: reads only ──────────────────────────────────────────────────────

type Registered = { description?: string; handler?: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }

function git(dir: string, ...args: string[]) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
}

test('the op and the in-process tool change nothing: no record, no held call, no approval use', async () => {
  const dir = mkdtempSync(path.join(home, 'ws-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const chain = Promise.resolve()
  const rt = {
    meta: { id: 'ws-test' },
    store,
    clients: new Set(),
    heldCalls: new Map(),
    ruleAllowed: new Map(),
    actionChain: chain,
    actionTimers: new Map(),
    connectorCache: null,
    folderProbes: new Map(),
    inboxCache: null,
    actionsFile: { current: () => ({ rules: DEFAULT_RULES, errors: [] }) },
  } as unknown as WorkspaceRuntime
  try {
    const approval = slackDmApproval()
    await store.approvals.put(approval)

    // a repo on a feature branch, and one on main
    const feat = path.join(dir, 'feat-repo')
    const main = path.join(dir, 'main-repo')
    for (const d of [feat, main]) {
      mkdirSync(d)
      git(d, 'init', '-q', '-b', 'main')
      git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    }
    git(feat, 'checkout', '-q', '-b', 'feat/retry')

    const calls: [unknown, SendCheck['verdict']][] = [
      [{ tool: 'Bash', input: { command: 'git push origin main' } }, 'held'],
      [{ tool: 'Bash', input: { command: 'git push' }, cwd: feat }, 'free'],
      [{ tool: 'Bash', input: { command: 'git push' }, cwd: main }, 'held'],
      [{ tool: 'Bash', input: { command: 'git push' } }, 'held'],
      [{ tool: 'Edit', input: { file_path: '/tmp/x' } }, 'free'],
      [{ tool: SLACK, input: { channel_id: 'U04ANI', message: 'ready' } }, 'free'],
      [{ tool: SLACK, input: { channel_id: 'C0GENERAL', message: 'ready' } }, 'held'],
      [{ tool: 'Bash', input: { command: 'rm -rf build' } }, 'destroys'],
    ]
    for (const [raw, want] of calls) assert.equal((await checkSendOp(rt, raw)).verdict, want, JSON.stringify(raw))

    await assert.rejects(checkSendOp(rt, {}), /need the tool name/)
    await assert.rejects(checkSendOp(rt, { tool: 'Bash', input: 'git push' }), /JSON object/)
    await assert.rejects(checkSendOp(rt, { tool: 'Bash', input: { command: 'git push' }, cwd: 'relative/dir' }), /absolute folder/)
    await assert.rejects(checkSendOp(rt, { tool: 'Bash', input: { command: 'git push' }, cwd: path.join(dir, 'nope') }), /no such folder/)

    // the in-process door: same name and description, same answer
    const server = makeJuniorMcp(rt, 'chat-1') as unknown as { instance: { _registeredTools: Record<string, Registered> } }
    const t = server.instance._registeredTools['check_send']
    assert.ok(t?.handler, 'check_send is registered in-process')
    assert.equal(t.description, CHECK_SEND_TOOL.description)
    const res = await t.handler({ tool: 'Bash', input: { command: 'git push origin main' } }, {})
    assert.notEqual(res.isError, true, res.content[0]?.text)
    assert.match(res.content[0]!.text, /^held: It sends \(.*\), so it waits on a card for the user's OK\./)
    const bad = await t.handler({ tool: '' }, {})
    assert.equal(bad.isError, true)

    // nothing changed
    assert.deepEqual(await store.actions.list({ limit: 100 }), [])
    assert.equal(rt.heldCalls.size, 0)
    assert.equal(rt.ruleAllowed.size, 0)
    assert.equal(rt.actionChain, chain, 'nothing was put on the action chain')
    const after = await store.approvals.get(approval.id)
    assert.equal(after?.uses, 0)
    assert.equal(after?.lastUsedAt, null)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an actions file it cannot read holds every call it would sort', async () => {
  const dir = mkdtempSync(path.join(home, 'ws-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = {
    meta: { id: 'ws-test' },
    store,
    connectorCache: null,
    folderProbes: new Map(),
    actionsFile: {
      current: () => {
        throw new Error('unreadable')
      },
    },
  } as unknown as WorkspaceRuntime
  try {
    for (const raw of [{ tool: 'Bash', input: { command: 'git status' } }, { tool: SLACK, input: {} }]) {
      const c = await checkSendOp(rt, raw)
      assert.equal(c.verdict, 'held', raw.tool)
      assert.match(c.why, /couldn't read its actions file/)
    }
    // a built-in local tool is never sorted: still free
    assert.equal((await checkSendOp(rt, { tool: 'Edit', input: {} })).verdict, 'free')
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
