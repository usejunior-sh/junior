/**
 * Usage by login (core/usage/logins.ts, server/usage/login-ledger.ts): which
 * login paid for each transcript line. The config dir decides between
 * claude.ai logins; a start junior noted moves a session onto an API key from
 * that moment on, and a key is one login however many workspaces share it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UsageEntry } from '../core/usage/ledger.js'
import { byLogin, loginOf, loginTotals, MACHINE_LOGIN, timelines, type LoginStart } from '../core/usage/logins.js'

const home = await mkdtemp(join(tmpdir(), 'usage-logins-'))
process.env.JUNIOR_HOME = home
const { keyLogin, noteClaudeStart, notedStarts, startKey, UNKNOWN_KEY } = await import('../server/usage/login-ledger.js')

const MAIN = '/home/.claude/projects'
const PERSONAL = '/ws/personal/claude/projects'
const roots = new Map([
  [MAIN, MACHINE_LOGIN],
  [PERSONAL, 'dir:personal'],
])

const entry = (over: Partial<UsageEntry>): UsageEntry => ({
  ts: 0,
  model: 'claude-sonnet-4-5',
  key: `${Math.random()}`,
  cwd: '/repo',
  sessionId: 's1',
  fast: false,
  subagent: false,
  root: MAIN,
  input: 1000,
  output: 1000,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  ...over,
})

test('a session junior never started stays with its config dir', () => {
  const none = timelines([])
  assert.equal(loginOf(entry({ root: MAIN }), none, roots), MACHINE_LOGIN)
  assert.equal(loginOf(entry({ root: PERSONAL }), none, roots), 'dir:personal')
  assert.equal(loginOf(entry({ root: '/elsewhere' }), none, roots), MACHINE_LOGIN)
})

test('a session moved onto a key is on the key from that start on', () => {
  const starts: LoginStart[] = [
    { sessionId: 's1', at: 2000, key: 'key:abc' },
    { sessionId: 's1', at: 1000 },
  ]
  const t = timelines(starts)
  assert.equal(loginOf(entry({ ts: 1500 }), t, roots), MACHINE_LOGIN)
  assert.equal(loginOf(entry({ ts: 2500 }), t, roots), 'key:abc')
  // Stamped before any start: the first one decides.
  assert.equal(loginOf(entry({ ts: 500 }), t, roots), MACHINE_LOGIN)
  // Another session is untouched.
  assert.equal(loginOf(entry({ ts: 2500, sessionId: 's2' }), t, roots), MACHINE_LOGIN)
})

test('entries split by login, with totals per login', () => {
  const t = timelines([{ sessionId: 'k', at: 0, key: 'key:abc' }])
  const groups = byLogin(
    [entry({ sessionId: 'k', ts: 10 }), entry({ sessionId: 'k', ts: 20 }), entry({ root: PERSONAL, sessionId: 'p' })],
    t,
    roots,
  )
  assert.deepEqual([...groups.keys()].sort(), ['dir:personal', 'key:abc'])
  const k = loginTotals(groups.get('key:abc')!)
  assert.equal(k.messages, 2)
  assert.equal(k.tokens, 4000)
  assert.ok(k.cost > 0)
})

test('a claude.ai login is not a key; one key is one login', () => {
  assert.equal(startKey('none', 'sk-ant-xyz'), undefined)
  assert.equal(startKey('/login managed key', undefined), undefined)
  const a = startKey('ANTHROPIC_API_KEY', 'sk-ant-api03-aaaa1234')
  assert.equal(a?.id, keyLogin('sk-ant-api03-aaaa1234').id)
  assert.equal(a?.hint, '…1234')
  assert.notEqual(a?.id, keyLogin('sk-ant-api03-bbbb1234').id)
  assert.equal(startKey('ANTHROPIC_API_KEY', undefined)?.id, UNKNOWN_KEY)
  assert.equal(startKey('apiKeyHelper', 'sk-ant-xyz')?.id, UNKNOWN_KEY)
})

test('the ledger keeps a fingerprint of the key, never the key', async () => {
  const secret = 'sk-ant-api03-SECRET-9876'
  await noteClaudeStart({ type: 'system', session_id: 'sess-key', apiKeySource: 'ANTHROPIC_API_KEY' } as object, secret)
  await noteClaudeStart({ session_id: 'sess-login', apiKeySource: 'none' }, undefined)
  await noteClaudeStart({ apiKeySource: 'none' }, undefined) // no session id: nothing to note
  const noted = await notedStarts()
  assert.equal(noted.length, 2)
  assert.equal(noted[0].key, keyLogin(secret).id)
  assert.equal(noted[0].hint, '…9876')
  assert.equal(noted[1].key, undefined)
  const raw = await readFile(join(home, 'usage-logins.jsonl'), 'utf8')
  assert.ok(!raw.includes(secret))
})
