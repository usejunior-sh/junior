/**
 * A task session whose task is over becomes a chat (server/session/sessions.ts
 * chatAfterTask): revived at the chat's mode, not the headless 'gated' it was
 * made with. A running task, a Codex task and any other session stay as they are.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StoredSession } from '../core/store/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
process.env.JUNIOR_HOME = mkdtempSync(path.join(os.tmpdir(), 'junior-taskmode-'))
const { chatAfterTask } = await import('../server/session/sessions.js')

function runtime() {
  const saved: Array<[string, string | null]> = []
  const rt = {
    taskRuns: new Map(),
    rows: new Map(),
    store: { sessions: { setPermissionMode: async (id: string, mode: string | null) => void saved.push([id, mode]) } },
  } as unknown as WorkspaceRuntime
  return { rt, saved }
}

const row = (over: Partial<StoredSession> = {}) => ({ id: 's1', provider: 'claude', kind: 'task', permissionMode: 'gated', ...over }) as unknown as StoredSession

test('an ended Claude task session revives at auto, saved and cached', async () => {
  const { rt, saved } = runtime()
  const next = await chatAfterTask(rt, row())
  assert.equal(next.permissionMode, 'auto')
  assert.deepEqual(saved, [['s1', 'auto']])
  assert.equal(rt.rows.get('s1')?.permissionMode, 'auto')
})

test('a running task, a Codex task and a plain chat keep their mode', async () => {
  const { rt, saved } = runtime()
  rt.taskRuns.set('s1', {} as never)
  assert.equal((await chatAfterTask(rt, row())).permissionMode, 'gated')
  assert.equal((await chatAfterTask(rt, row({ id: 's2', provider: 'codex' } as never))).permissionMode, 'gated')
  assert.equal((await chatAfterTask(rt, row({ id: 's3', kind: 'chat' }))).permissionMode, 'gated')
  assert.deepEqual(saved, [])
})
