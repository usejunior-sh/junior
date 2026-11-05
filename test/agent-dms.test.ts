/**
 * Agents' DMs (core/junior/dms.ts): each agent's one long-running chat on the
 * Agents page. The key rule that finds it, the wire flag that asks for it, and
 * the system prompt that tells the agent it is in one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JUNIOR_DM, dmAgent, dmKey, findDm } from '../core/junior/dms.js'
import { juniorSessionAppend } from '../shared/juniorContext.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
process.env.JUNIOR_HOME = mkdtempSync(path.join(os.tmpdir(), 'junior-dms-'))
const { parseClientMessage } = await import('../server/ws/parse.js')

const rows = [
  { id: 'a', kind: 'chat', agent: 'junior:explainer' },
  { id: 'b', kind: 'dm', agent: 'junior:explainer' },
  { id: 'c', kind: 'dm' },
  { id: 'd', kind: 'chat' },
]

test('dm keys: Junior has no agent, every other agent is its name', () => {
  assert.equal(dmKey(undefined), JUNIOR_DM)
  assert.equal(dmKey(null), JUNIOR_DM)
  assert.equal(dmKey('junior:explainer'), 'junior:explainer')
  assert.equal(dmAgent(JUNIOR_DM), undefined)
  assert.equal(dmAgent('junior:explainer'), 'junior:explainer')
})

test('findDm: only a dm-kind session with the same agent counts', () => {
  assert.equal(findDm(rows, 'junior:explainer')?.id, 'b')
  assert.equal(findDm(rows, JUNIOR_DM)?.id, 'c')
  assert.equal(findDm(rows, 'junior:reviewer'), undefined)
  assert.equal(findDm([{ id: 'x', kind: 'chat' }], JUNIOR_DM), undefined)
})

test('create_session carries dm only when it is exactly true', () => {
  const base = { type: 'create_session', title: 't', cwd: '' }
  assert.equal((parseClientMessage({ ...base, dm: true }) as { dm?: boolean }).dm, true)
  assert.equal((parseClientMessage({ ...base, dm: 'yes' }) as { dm?: boolean }).dm, undefined)
  assert.equal((parseClientMessage(base) as { dm?: boolean }).dm, undefined)
})

test('a DM is told it is one, and keeps what a chat gets', () => {
  const id = { sessionId: 's', workspaceId: 'w', workspaceName: 'W', artifactsRoot: '/a' }
  const dm = juniorSessionAppend('dm', id)
  const chat = juniorSessionAppend('chat', id)
  assert.match(dm, /This chat is a DM/)
  assert.doesNotMatch(chat, /This chat is a DM/)
  // a DM can still set up jobs and goals, like any chat
  assert.match(dm, /A job is a standing assignment/)
})
