/**
 * The permission path (server/session/live-session.ts requestPermission) after
 * the old goals engine was unwired from it: a plain chat, a team worker, a
 * team lead and a babysit task session get the same decisions they got
 * before, and a session the retired engine left behind (kind 'goal') can only
 * read. The method runs on a fake session (row + runtime + an askUser stub),
 * so nothing spawns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StoredSession } from '../core/store/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-perm-'))
process.env.JUNIOR_HOME = home
const { LiveSession } = await import('../server/session/live-session.js')
const { sessionVeto } = await import('../server/session/actions-hold.js')

type Decision = 'allow' | 'deny' | 'ask'
const CWD = path.join(home, 'project')
const SLACK = 'mcp__claude_ai_Slack__slack_send_message'

function runtime(): WorkspaceRuntime {
  return {
    meta: { id: 'ws-test' },
    taskRuns: new Map(),
    sessionTeam: new Map(),
    teamRuns: new Map(),
  } as unknown as WorkspaceRuntime
}

const row = (id: string, over: Partial<StoredSession> = {}) =>
  ({ id, provider: 'claude', kind: 'chat', cwd: CWD, permissionMode: 'auto', jobId: null, ...over }) as unknown as StoredSession

/** Call the real requestPermission on a fake session; a prompt to the user reads as 'ask'. */
async function decide(rt: WorkspaceRuntime, r: StoredSession, toolName: string, input: Record<string, unknown> = {}): Promise<Decision> {
  const fake = { rt, row: r, askUser: async () => ({ behavior: 'ask' }) }
  const method = (LiveSession.prototype as unknown as { requestPermission: (...a: unknown[]) => Promise<{ behavior: string }> }).requestPermission
  const res = await method.call(fake, toolName, input, {})
  return res.behavior as Decision
}

/** A team run with one read-only worker and one change worker, led by `lead`. */
function withTeam(rt: WorkspaceRuntime, permissions?: 'ask' | 'local') {
  const run = {
    id: 'run-1',
    leadSessionId: 'lead',
    recipe: {
      steps: [
        { id: 'look', output: 'notes' },
        { id: 'build', output: 'change' },
      ],
    },
    workers: [
      { sessionId: 'reader', stepId: 'look', agent: 'Explorer' },
      { sessionId: 'builder', stepId: 'build', agent: 'Builder' },
    ],
    agents: [],
    card: { steps: [], ...(permissions ? { permissions } : {}) },
    checkCmds: ['npm test'],
  }
  rt.teamRuns.set(run.id, run as never)
  for (const s of ['lead', 'reader', 'builder']) rt.sessionTeam.set(s, run.id)
}

test('plain chat: reads and its own inbox reads run, a read-only shell runs, the rest asks', async () => {
  const rt = runtime()
  const chat = row('chat-1')
  assert.equal(await decide(rt, chat, 'Read', { file_path: 'a.ts' }), 'allow')
  assert.equal(await decide(rt, chat, 'mcp__junior__list_work_items'), 'allow')
  assert.equal(await decide(rt, chat, 'mcp__junior__propose_team'), 'allow')
  assert.equal(await decide(rt, chat, 'Bash', { command: 'git status' }), 'allow')
  assert.equal(await decide(rt, chat, 'Bash', { command: 'rm -rf build' }), 'ask')
  assert.equal(await decide(rt, chat, 'mcp__junior__create_work_item'), 'ask')
  assert.equal(await decide(rt, chat, 'ExitPlanMode', { plan: 'p' }), 'ask')
  assert.equal(await decide(rt, chat, SLACK), 'ask')
})

test('plain chat at default mode: a read-only shell still asks', async () => {
  const rt = runtime()
  assert.equal(await decide(rt, row('chat-2', { permissionMode: 'default' }), 'Bash', { command: 'git status' }), 'ask')
})

test('team worker: read-only git and the checks run; local work runs at the card level; a connector send asks', async () => {
  const rt = runtime()
  withTeam(rt)
  const reader = row('reader', { permissionMode: 'gated' })
  const builder = row('builder', { permissionMode: 'acceptEdits' })
  assert.equal(await decide(rt, reader, 'Bash', { command: 'git log -5' }), 'allow')
  assert.equal(await decide(rt, reader, 'Bash', { command: 'npm test' }), 'allow')
  assert.equal(await decide(rt, builder, 'Bash', { command: 'npm test 2>&1 | tail -20' }), 'allow')
  assert.equal(await decide(rt, builder, 'Edit', { file_path: 'src/a.ts' }), 'allow')
  assert.equal(await decide(rt, builder, 'Bash', { command: 'npm install left-pad' }), 'allow')
  assert.equal(await decide(rt, builder, SLACK), 'ask')
  assert.equal(await decide(rt, builder, 'mcp__junior__submit_step'), 'allow')
})

test("team worker on an 'ask' card: local work asks, read-only git and checks still run", async () => {
  const rt = runtime()
  withTeam(rt, 'ask')
  const builder = row('builder', { permissionMode: 'acceptEdits' })
  assert.equal(await decide(rt, builder, 'Edit', { file_path: 'src/a.ts' }), 'ask')
  assert.equal(await decide(rt, builder, 'Bash', { command: 'npm test' }), 'allow')
  assert.equal(await decide(rt, row('reader', { permissionMode: 'gated' }), 'Bash', { command: 'git diff' }), 'allow')
})

test("team lead: decided by its own mode, like a chat", async () => {
  const rt = runtime()
  withTeam(rt)
  const lead = row('lead')
  assert.equal(await decide(rt, lead, 'Edit', { file_path: 'src/a.ts' }), 'ask')
  assert.equal(await decide(rt, lead, 'Bash', { command: 'git status' }), 'allow')
  assert.equal(await decide(rt, lead, 'Bash', { command: 'npm install x' }), 'ask')
})

test('task session: headless; edits inside its folder, the shell and its hand-in run; the rest is refused', async () => {
  const rt = runtime()
  rt.taskRuns.set('task-1', {} as never)
  const task = row('task-1', { permissionMode: 'gated' })
  assert.equal(await decide(rt, task, 'Edit', { file_path: 'src/a.ts' }), 'allow')
  assert.equal(await decide(rt, task, 'Write', { file_path: path.join(CWD, 'b.ts') }), 'allow')
  assert.equal(await decide(rt, task, 'Edit', { file_path: '../elsewhere/a.ts' }), 'deny')
  assert.equal(await decide(rt, task, 'Bash', { command: 'npm install x' }), 'allow')
  assert.equal(await decide(rt, task, 'mcp__task__submit_task'), 'allow')
  assert.equal(await decide(rt, task, 'Read', { file_path: 'a.ts' }), 'allow')
  assert.equal(await decide(rt, task, SLACK), 'deny')
})

test("a session the retired goals engine left (kind 'goal'): reads and read-only git only", async () => {
  const rt = runtime()
  const old = row('goal-1', { kind: 'goal', permissionMode: 'gated' } as Partial<StoredSession>)
  assert.equal(await decide(rt, old, 'Read', { file_path: 'a.ts' }), 'allow')
  assert.equal(await decide(rt, old, 'Bash', { command: 'git status' }), 'allow')
  assert.equal(await decide(rt, old, 'Bash', { command: 'npm install x' }), 'deny')
  assert.equal(await decide(rt, old, 'Edit', { file_path: 'src/a.ts' }), 'deny')
  assert.equal(await decide(rt, old, 'mcp__junior__goal_propose_plan'), 'deny')
  assert.equal(await decide(rt, old, SLACK), 'deny')
})

test('the veto: chats, team workers and task sessions get one; an old goal session is fenced read-only', async () => {
  const rt = runtime()
  withTeam(rt)
  rt.taskRuns.set('task-1', {} as never)
  const none = new Set<string>()
  assert.ok(sessionVeto(rt, row('chat-1'), none).veto)
  assert.ok(sessionVeto(rt, row('builder', { permissionMode: 'acceptEdits' }), none).veto)
  assert.ok(sessionVeto(rt, row('task-1', { kind: 'task' } as Partial<StoredSession>), none).veto)
  const veto = sessionVeto(rt, row('goal-1', { kind: 'goal' } as Partial<StoredSession>), none).veto
  assert.ok(veto)
  const d = await veto('Edit', { file_path: path.join(CWD, 'a.ts') }, {})
  assert.equal(d.allow, false)
})
