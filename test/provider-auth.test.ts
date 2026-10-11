/**
 * A workspace is a provider plus its auth (server/workspaces.ts), and the
 * Claude adapter turns that auth into spawn env (server/providers/claude-config.ts).
 * Pins the migration of registries from before providers and that each auth
 * backend resolves to exactly the env it always did.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// TRIAGE_DIR is fixed when state.ts loads, so the root is set before the import.
const home = mkdtempSync(path.join(os.tmpdir(), 'triage-auth-'))
process.env.TRIAGE_HOME = home
delete process.env.TRIAGE_DB
delete process.env.CLAUDE_CONFIG_DIR
const ws = await import('../server/workspaces.js')
type WorkspaceRegistry = import('../server/workspaces.js').WorkspaceRegistry
const { claude } = await import('../server/providers/claude.js')

const legacy = {
  version: 1,
  defaultId: 'personal',
  onboarded: true,
  workspaces: [
    { id: 'personal', name: 'Personal', color: '#7aa2f7', authBackend: 'inherit', createdAt: 1 },
    { id: 'work', name: 'Work', color: '#ff8800', description: 'the day job', authBackend: 'api-key', createdAt: 2 },
    { id: 'side', name: 'Side', color: '#00aa66', authBackend: 'config-dir', createdAt: 3 },
  ],
}

test('a registry from before providers migrates to claude, keeping everything else', () => {
  writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify(legacy))
  const reg = ws.loadRegistry()
  assert.deepEqual(reg, { ...legacy, workspaces: legacy.workspaces.map((w) => ({ ...w, provider: 'claude' })) })
  // Written back, so the file says it too; a second load changes nothing.
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'workspaces.json'), 'utf8')), reg)
  assert.deepEqual(ws.loadRegistry(), reg)
  assert.equal(ws.migrateProviders(reg), false)
})

test('an unknown provider id falls back to claude', () => {
  const reg = { ...legacy, workspaces: [{ ...legacy.workspaces[0], provider: 'nope' }] } as unknown as WorkspaceRegistry
  assert.equal(ws.migrateProviders(reg), true)
  assert.equal(reg.workspaces[0].provider, 'claude')
})

test('a workspace naming codex is put back on claude — codex is picked per session', () => {
  const reg = { ...legacy, workspaces: [{ ...legacy.workspaces[0], provider: 'codex' }] } as unknown as WorkspaceRegistry
  assert.equal(ws.migrateProviders(reg), true)
  assert.equal(reg.workspaces[0].provider, 'claude')
})

test('inherit spawns with no overrides', () => {
  const meta = { ...legacy.workspaces[0], authBackend: 'inherit' as const, provider: 'claude' as const }
  assert.equal(ws.envOverridesFor(meta), undefined)
  assert.equal(ws.spawnEnvFor(meta), undefined)
})

test('api-key spawns with ANTHROPIC_API_KEY from the workspace .env, written as before', () => {
  const meta = { ...legacy.workspaces[1], authBackend: 'api-key' as const, provider: 'claude' as const }
  assert.equal(ws.envOverridesFor(meta), undefined, 'no key stored yet')
  ws.writeApiKey(meta, 'sk-ant-test-1234')
  const file = path.join(home, 'workspaces', 'work', '.env')
  assert.equal(readFileSync(file, 'utf8'), 'ANTHROPIC_API_KEY=sk-ant-test-1234\n')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(ws.envOverridesFor(meta), { ANTHROPIC_API_KEY: 'sk-ant-test-1234' })
  assert.equal(ws.apiKeyHint(meta), '…1234')
  const env = ws.spawnEnvFor(meta)!
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test-1234')
  assert.equal(env.PATH, process.env.PATH, 'merged over process.env')
})

test('config-dir spawns with CLAUDE_CONFIG_DIR at the workspace claude/ dir, created', () => {
  const meta = { ...legacy.workspaces[2], authBackend: 'config-dir' as const, provider: 'claude' as const }
  const dir = path.join(home, 'workspaces', 'side', 'claude')
  assert.deepEqual(ws.envOverridesFor(meta), { CLAUDE_CONFIG_DIR: dir })
  assert.ok(existsSync(dir))
  assert.equal(ws.workspaceAuthDir(meta), dir)
  assert.equal(ws.loginCommandFor(meta), `CLAUDE_CONFIG_DIR=${dir} claude /login`)
  assert.equal(claude.discovery.transcriptDir({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, 'projects'))
  assert.equal(claude.discovery.transcriptDir(undefined), path.join(os.homedir(), '.claude', 'projects'))
})

test('configured MCP: the folder .mcp.json and every folder private servers from .claude.json', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-cfg-'))
  const cwd = path.join(dir, 'proj')
  mkdirSync(cwd)
  writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'x' } } }))
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ projects: { [cwd]: { mcpServers: { mine: { command: 'y' } } }, '/elsewhere': { mcpServers: { other: { command: 'z' } } }, '/empty': {} } }),
  )
  assert.deepEqual(await claude.discovery.configuredMcp({ cwd, env: { CLAUDE_CONFIG_DIR: dir } }), {
    project: { shared: { command: 'x' } },
    local: { [cwd]: { mine: { command: 'y' } }, '/elsewhere': { other: { command: 'z' } } },
  })
  assert.deepEqual(await claude.discovery.configuredMcp({ cwd: path.join(dir, 'none'), env: { CLAUDE_CONFIG_DIR: path.join(dir, 'none') } }), {
    project: {},
    local: {},
  })
})

test('agent tools: a "can" as Claude Code tool names', () => {
  assert.deepEqual(claude.agentTools(['read']), {
    tools: ['TodoWrite', 'Read', 'Grep', 'Glob'],
    disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebSearch', 'WebFetch'],
  })
  assert.deepEqual(claude.agentTools(['read', 'edit', 'run', 'web']).disallowedTools, [])
})
