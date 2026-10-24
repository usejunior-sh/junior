/**
 * The Claude login check, said as Junior (core/junior/verify-copy.ts): one
 * row per state the dialog can be in, with the exact words it shows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectorsLine, modelsMeta, verifyCopy } from '../core/junior/verify-copy.js'
import type { WorkspaceVerifyResponse } from '../shared/protocol.js'

const model = (name: string) => ({ id: name.toLowerCase(), name, description: '' }) as never
const conn = (source: string, status = 'connected') => ({ name: 'x', server: 'x', status, source, scope: 'user', tools: [] }) as never

const ok = (over: Partial<Extract<WorkspaceVerifyResponse, { ok: true }>> = {}): WorkspaceVerifyResponse => ({
  ok: true,
  models: [model('Opus'), model('Sonnet'), model('Haiku')],
  connectors: [],
  slackConnected: false,
  authOk: true,
  ...over,
})

test('nothing yet, and checking', () => {
  assert.deepEqual(verifyCopy(null, 'inherit'), { kind: 'idle' })
  const c = verifyCopy('probing', 'api-key')
  assert.equal(c.kind, 'checking')
  assert.equal(c.kind === 'checking' && c.line, 'Checking I can reach Claude…')
  assert.equal(c.kind === 'checking' && c.mood, 'think')
})

test('ok line names the login or the key', () => {
  const rows: [Parameters<typeof verifyCopy>[1], string][] = [
    ['inherit', 'I can reach Claude with your login.'],
    ['config-dir', 'I can reach Claude with your login.'],
    ['api-key', 'I can reach Claude with your API key.'],
  ]
  for (const [backend, line] of rows) {
    const c = verifyCopy(ok({ slackConnected: true }), backend)
    assert.equal(c.kind, 'ok', backend)
    if (c.kind !== 'ok') continue
    assert.equal(c.line, line, backend)
    assert.equal(c.mood, 'done')
    assert.equal(c.meta, '3 models · Opus · Sonnet · Haiku')
  }
})

test('models meta', () => {
  assert.equal(modelsMeta([]), 'No models listed yet.')
  assert.equal(modelsMeta(['Opus']), '1 model · Opus')
  assert.equal(modelsMeta(['A', 'B', 'C', 'D']), '4 models · A · B · C')
})

test('connectors line reports what the probe saw', () => {
  const rows: [boolean, string[], Parameters<typeof verifyCopy>[1], string][] = [
    [true, [], 'inherit', 'I can see Slack too.'],
    [false, ['claude.ai', 'claude.ai'], 'inherit', "I can't see Slack. 2 other connectors are live."],
    [false, ['claude.ai'], 'config-dir', "I can't see Slack. 1 other connector is live."],
    [false, ['user'], 'api-key', 'No Slack with an API key. GitHub through gh still works.'],
    [false, [], 'inherit', "I can't see any claude.ai connectors yet."],
  ]
  for (const [slack, sources, backend, line] of rows) {
    assert.equal(connectorsLine({ slackConnected: slack, connectors: sources.map((s) => conn(s)) }, backend), line)
  }
  // a claude.ai connector that isn't connected doesn't count
  assert.equal(connectorsLine({ slackConnected: false, connectors: [conn('claude.ai', 'failed')] }, 'inherit'), "I can't see any claude.ai connectors yet.")
})

test('errors say why and how to fix it, per backend', () => {
  const auth = verifyCopy(ok({ authOk: false, authError: 'Invalid API key · 401' }), 'api-key')
  assert.equal(auth.kind, 'error')
  if (auth.kind === 'error') {
    assert.equal(auth.line, "I can't reach Claude yet. Here's why.")
    assert.equal(auth.reason, 'Invalid API key · 401')
    assert.equal(auth.fix, 'Check the key above, then try again.')
    assert.equal(auth.mood, 'stuck')
    assert.equal(auth.showLoginCommand, false)
  }
  const probe = verifyCopy({ ok: false, error: 'spawn failed' }, 'config-dir')
  assert.equal(probe.kind === 'error' && probe.reason, 'spawn failed')
  assert.equal(probe.kind === 'error' && probe.fix, 'Run this once in a terminal, then try again.')
  assert.equal(probe.kind === 'error' && probe.showLoginCommand, true)
  const blank = verifyCopy(ok({ authOk: false }), 'inherit')
  assert.equal(blank.kind === 'error' && blank.reason, 'No reason came back.')
  assert.equal(blank.kind === 'error' && blank.fix, 'Sign in once with `claude` in a terminal, then try again.')
})
