/**
 * What triage knows about Claude Code's own files, kept out of the SDK seam so
 * it loads without the SDK (teams.ts, workspaces.ts, tests): how a workspace's
 * auth becomes spawn env (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR), where its
 * config and transcripts live (~/.claude.json, ~/.claude/projects), and the
 * tool names an agent file's "can" stands for. `claude.ts` hands these out as
 * the adapter's `auth`, `discovery` and `agentTools`.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentCan } from '../../shared/protocol.js'
import type { AgentTools, ConfiguredMcp, ProviderAuth, SpawnEnv } from './types.js'

export const CLAUDE_API_KEY_VAR = 'ANTHROPIC_API_KEY'

/**
 * The env overrides a workspace's auth spawns with. `undefined` for `inherit`
 * (the SDK resolves ~/.claude on its own), and for an api-key workspace with
 * no key stored yet.
 */
export function claudeAuthEnv(auth: ProviderAuth): Record<string, string> | undefined {
  if (auth.backend === 'api-key') return auth.apiKey ? { [CLAUDE_API_KEY_VAR]: auth.apiKey } : undefined
  if (auth.backend === 'config-dir') return { CLAUDE_CONFIG_DIR: auth.dir }
  return undefined
}

export const claudeLoginCommand = (dir: string) => `CLAUDE_CONFIG_DIR=${dir} claude /login`

/** The config dir a spawn with `env` uses, when one is set; unset = the defaults. */
const configDirOf = (env: SpawnEnv): string | undefined => env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || undefined

/** ~/.claude.json, or `.claude.json` inside the config dir when one is set. */
const claudeJsonFile = (env: SpawnEnv): string => {
  const dir = configDirOf(env)
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json')
}

/** Where a spawn with `env` writes its transcripts. */
export const claudeTranscriptDir = (env: SpawnEnv): string =>
  path.join(configDirOf(env) ?? path.join(os.homedir(), '.claude'), 'projects')

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)

/**
 * Who a spawn with `env` is signed in as, from `.claude.json`'s `oauthAccount`:
 * no subprocess, so cheap enough for a label. `null` when nobody is.
 * `claude_max` reads as "Max".
 */
export async function claudeSignedIn(env: SpawnEnv): Promise<{ email?: string; plan?: string } | null> {
  const account = objectOf((await readJson(claudeJsonFile(env)))?.oauthAccount)
  if (!account) return null
  const email = typeof account.emailAddress === 'string' ? account.emailAddress : undefined
  const type = typeof account.organizationType === 'string' ? account.organizationType.replace(/^claude_/, '') : ''
  const plan = type ? type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : undefined
  return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) }
}

/**
 * MCP servers from Claude Code's config files: the folder's shared `.mcp.json`
 * and every folder's private (local-scope) servers from `.claude.json`.
 */
export async function claudeConfiguredMcp({ cwd, env }: { cwd: string; env: SpawnEnv }): Promise<ConfiguredMcp> {
  const [project, claudeJson] = await Promise.all([readJson(path.join(cwd, '.mcp.json')), readJson(claudeJsonFile(env))])
  const local: ConfiguredMcp['local'] = {}
  for (const [folder, p] of Object.entries(objectOf(claudeJson?.projects) ?? {})) {
    const servers = objectOf(objectOf(p)?.mcpServers)
    if (servers) local[folder] = servers
  }
  return { project: objectOf(project?.mcpServers) ?? {}, local }
}

/**
 * One MCP server from the user's own ~/.claude.json, as a plain config to pass
 * through. Always the machine's file, whatever the workspace's auth.
 */
export function claudeUserMcpServer(name: string): Record<string, unknown> | null {
  try {
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
    return cfg.mcpServers?.[name] ?? null
  } catch {
    return null
  }
}

// Agent files: Claude Code's tool names behind each "can"

/** What each "can" grants. Anything in this table an agent doesn't get is disallowed at spawn. */
export const CAN_TOOLS: Record<AgentCan, string[]> = {
  read: ['Read', 'Grep', 'Glob'],
  edit: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  run: ['Bash'],
  web: ['WebSearch', 'WebFetch'],
  // Not a built-in: the browser pane's own tools while Triage.app hosts them,
  // else the user's chrome-devtools MCP server: loaded only for agents allowed
  // it (every other connector is left out, see strictMcpConfig at spawn).
  browser: ['mcp__browser', 'mcp__chrome-devtools'],
}
/** Built-in tools a "can" governs; browser is an MCP server, handled by loading it or not. */
const GATED_TOOLS = (['read', 'edit', 'run', 'web'] as const).flatMap((c) => CAN_TOOLS[c])

/**
 * The only built-in tools a team member's subprocess is given at all. Everything
 * else Claude Code ships (subagents, skills, notebooks, …) stays out of the tool
 * list. Each schema is re-read on every call (.docs/teams-cost.md).
 */
export function builtinToolsFor(can: AgentCan[], opts: { ask?: boolean } = {}): string[] {
  return [...new Set(['TodoWrite', ...(opts.ask ? ['AskUserQuestion'] : []), ...GATED_TOOLS.filter((t) => toolsFor(can).includes(t))])]
}

export const toolsFor = (can: AgentCan[]): string[] => can.flatMap((c) => CAN_TOOLS[c])
export const disallowedFor = (can: AgentCan[]): string[] => {
  const allowed = new Set(toolsFor(can))
  return GATED_TOOLS.filter((t) => !allowed.has(t))
}

/** An agent file's "can" as a Claude Code subprocess's tool lists and servers. */
export function claudeAgentTools(can: AgentCan[]): AgentTools {
  const browser = can.includes('browser') ? claudeUserMcpServer('chrome-devtools') : null
  return {
    tools: builtinToolsFor(can),
    disallowedTools: disallowedFor(can),
    ...(browser ? { mcpServers: { 'chrome-devtools': browser } } : {}),
  }
}
