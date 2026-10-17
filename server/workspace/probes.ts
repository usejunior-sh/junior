import os from 'node:os'
import type { Connector, ConnectorScope, EffortLevel, SlashCommandInfo } from '../../shared/protocol.js'
import type { McpStatus, ProviderId } from '../providers/types.js'
import { mcpToolName } from '../../core/job/tools.js'
import { log } from '../log.js'
import { providerFor } from '../providers/registry.js'
import { type CommandProbe, type ConnectorProbe, type ModelProbe, WorkspaceRuntime } from './runtime.js'
import { folderMcpServers } from '../jobs/preview.js'
import { expandHome } from '../folders.js'
import { broadcast } from '../ws/send.js'

export const FOLDER_PROBE_TTL_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// Connectors: what a session will actually load, learned the honest way — by
// spawning a throwaway query with the SAME options real sessions use and
// asking it via the mcpServerStatus() control request (no user message, no
// API turn). `claude mcp list` has no machine output, and the config files
// under ~/.claude are private formats; this is the SDK's own structured
// answer to "which servers connected". Per-workspace: two auth backends
// genuinely have different connectors, so each runtime probes with its own env.
// ---------------------------------------------------------------------------
const CLAUDE_AI_PREFIX = 'claude.ai '

const SCOPES: ConnectorScope[] = ['claudeai', 'user', 'local', 'project', 'plugin', 'managed']

/** One server as the SDK reports it → our Connector, tools and all (job-spec.md, item 1). */
function toConnector(srv: McpStatus, scopeOverride?: ConnectorScope): Connector {
  const claudeAi = srv.name.startsWith(CLAUDE_AI_PREFIX)
  const scope: ConnectorScope =
    scopeOverride ?? (claudeAi ? 'claudeai' : SCOPES.includes(srv.scope as ConnectorScope) ? (srv.scope as ConnectorScope) : 'unknown')
  return {
    name: claudeAi ? srv.name.slice(CLAUDE_AI_PREFIX.length) : srv.name,
    server: srv.name,
    status: srv.status,
    source: claudeAi ? 'claude.ai' : 'local',
    scope,
    ...(srv.error ? { error: srv.error } : {}),
    tools: (srv.tools ?? []).map((t) => {
      const full = t.name.startsWith('mcp__') ? t.name : mcpToolName(srv.name, t.name)
      return {
        name: full.slice(full.lastIndexOf('__') + 2),
        fullName: full,
        ...(t.description ? { description: t.description.slice(0, 400) } : {}),
        ...(t.annotations?.readOnly !== undefined ? { readOnly: t.annotations.readOnly } : {}),
        ...(t.annotations?.destructive !== undefined ? { destructive: t.annotations.destructive } : {}),
        ...(t.annotations?.openWorld !== undefined ? { openWorld: t.annotations.openWorld } : {}),
      }
    }),
  }
}

/**
 * Probe which MCP servers connect. With no folder: the user-level view
 * (Settings), from the home folder. With a folder: exactly what a job run in
 * that folder loads — the user's servers plus the folder's project and local
 * servers, passed explicitly (never by loading the project's settings/hooks).
 */
export function probeConnectors(rt: WorkspaceRuntime, cwd?: string): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  const inFlight = cwd ? rt.folderProbeInFlight.get(cwd) : rt.connectorInFlight
  if (inFlight) return inFlight
  const run = (async () => {
    const folder = cwd ? await folderMcpServers(rt, cwd) : null
    try {
      const statuses = await rt.provider.mcpStatus(
        folder
          ? { cwd: cwd!, env: rt.env, servers: folder.servers }
          : { cwd: os.homedir(), env: rt.env }, // user-level view; no project .mcp.json in the way
      )
      const connectors = statuses
        .map((srv) => toConnector(srv, folder?.scopes.get(srv.name)))
        .sort((a, b) => a.name.localeCompare(b.name))
      const probe: ConnectorProbe = { probedAt: Date.now(), connectors }
      if (cwd) rt.folderProbes.set(cwd, probe)
      else rt.connectorCache = probe
      log('info', 'connectors', `probed${cwd ? ` ${cwd}` : ''}: ${connectors.length} server(s), ${connectors.filter((c) => c.status === 'connected').length} connected`, { workspace: rt.meta.id })
      return probe
    } finally {
      if (cwd) rt.folderProbeInFlight.delete(cwd)
      else rt.connectorInFlight = null
    }
  })()
  if (cwd) rt.folderProbeInFlight.set(cwd, run)
  else rt.connectorInFlight = run
  return run
}

// ---------------------------------------------------------------------------
// Models: which models this workspace's Claude Code will actually run. Asked of
// the SDK (supportedModels()) rather than hardcoded — the catalog moves, an
// org policy can shrink it, and an api-key workspace may see a different list
// than a subscription one. Same throwaway-subprocess shape as the connector
// probe, and the answer is stable enough to cache for the process. Cached per
// agent: a chat can run on another one (Codex), whose list is its own.
// ---------------------------------------------------------------------------
export function probeModels(rt: WorkspaceRuntime, provider: ProviderId = rt.meta.provider): Promise<ModelProbe> {
  const inFlight = rt.modelInFlight.get(provider)
  if (inFlight) return inFlight
  const run = (async () => {
    try {
      const models = await providerFor(provider).models({ cwd: os.homedir(), env: rt.envFor(provider) })
      const probe = { probedAt: Date.now(), models }
      rt.modelCache.set(provider, probe)
      log('info', 'models', `probed ${provider}: ${models.length} model(s) available`, { workspace: rt.meta.id })
      return probe
    } finally {
      rt.modelInFlight.delete(provider)
    }
  })()
  rt.modelInFlight.set(provider, run)
  return run
}

/**
 * A session's model choice, checked against its agent's list where that list
 * is the whole truth. Claude also takes aliases and ids it doesn't list, so its
 * choice passes as sent. For Codex, an id it doesn't list is refused (null) —
 * `turn/start` would fail on it — and an effort the model doesn't take is
 * dropped to the model's default.
 */
export async function checkModelChoice(
  rt: WorkspaceRuntime,
  provider: ProviderId,
  model: string | null,
  effort: EffortLevel | null,
): Promise<{ model: string | null; effort: EffortLevel | null } | null> {
  if (provider === 'claude' || model === null) return { model, effort }
  const probe = rt.modelCache.get(provider) ?? (await probeModels(rt, provider))
  const option = probe.models.find((m) => m.id === model)
  if (!option) return null
  return { model, effort: effort && option.efforts.includes(effort) ? effort : null }
}

// ---------------------------------------------------------------------------
// Slash commands: what `/` offers in the composer. Asked of the SDK
// (supportedCommands()) like the model catalog, but keyed by *folder* rather
// than by workspace — a project's .claude/commands, .claude/skills and its
// plugins' skills only exist under that project.
//
// Two fill paths, and the cheap one covers the common case: a live session's
// subprocess already knows the list, so it hands it over at init for free and
// pushes a fresh one when skills are discovered mid-run. Only a draft tab —
// which has no subprocess yet — pays for a throwaway probe, and only on the
// first `/` typed against that folder.
// ---------------------------------------------------------------------------

/**
 * Commands whose UX is bound to a real terminal. The SDK tags these per
 * session (`terminal_slash_commands` on the init message) and tells remote
 * hosts to hide them — but the tag rides the message stream, so a probe with
 * no turn never sees it. Until this workspace has run one session, this list
 * stands in; the first init replaces it wholesale rather than merging, so a
 * stale guess here can only ever be wrong until a session starts.
 */
const TERMINAL_ONLY_FALLBACK = [
  'exit',
  'quit',
  'statusline',
  'vim',
  'ide',
  'terminal-setup',
  'install-github-app',
  'upgrade',
  'login',
  'logout',
]

/** The SDK's command shape is our wire shape; drop the empty optional. */
export const toCommandInfo = (c: {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}): SlashCommandInfo => ({
  name: c.name,
  description: c.description,
  argumentHint: c.argumentHint,
  ...(c.aliases?.length ? { aliases: c.aliases } : {}),
})

/** Hide what a browser can't drive, and give the picker a stable order. */
export function usableCommands(rt: WorkspaceRuntime, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const hidden = new Set(rt.terminalCommands ?? TERMINAL_ONLY_FALLBACK)
  return commands.filter((c) => !hidden.has(c.name)).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Record what a subprocess reported for a folder and tell every composer
 * pointed at it. Replace, never merge: the SDK's `commands_changed` contract
 * is that the payload is the whole truth, and a command can be deleted.
 */
export function noteCommands(rt: WorkspaceRuntime, cwd: string, commands: SlashCommandInfo[]): CommandProbe {
  // Keyed by the resolved folder, so a session's absolute cwd and a draft
  // tab's `~/Code/thing` are one entry rather than two.
  const key = expandHome(cwd)
  // The cache holds the subprocess's answer verbatim and `usableCommands`
  // runs on the way out, so the terminal set learned by a session starting
  // later still applies to a folder probed before it.
  const probe: CommandProbe = { probedAt: Date.now(), commands }
  rt.commandCache.set(key, probe)
  broadcast(rt, { type: 'commands_changed', cwd: key, commands: usableCommands(rt, commands) })
  return probe
}

/**
 * The list for a folder with no live session — one throwaway subprocess, the
 * same shape as the model probe, cached for the life of the process. Shared
 * per folder while in flight so a fast typist can't spawn two.
 */
export function probeCommands(rt: WorkspaceRuntime, cwd: string): Promise<CommandProbe> {
  const running = rt.commandInFlight.get(cwd)  // callers pass the resolved folder
  if (running) return running
  const job = (async () => {
    try {
      const probe = noteCommands(rt, cwd, (await rt.provider.commands({ cwd, env: rt.env })).map(toCommandInfo))
      log('info', 'commands', `probed ${probe.commands.length} command(s)`, { workspace: rt.meta.id })
      return probe
    } finally {
      rt.commandInFlight.delete(cwd)
    }
  })()
  rt.commandInFlight.set(cwd, job)
  return job
}

/**
 * A REAL auth check: one trivial headless turn with the workspace's env. The
 * model catalog (supportedModels) is static and "succeeds" on a bogus key, so
 * the verify step must actually reach the API to prove a key or login works.
 * Costs one minimal turn; only run for api-key / config-dir on explicit verify.
 */
export function probeAuth(rt: WorkspaceRuntime): Promise<{ ok: boolean; error?: string }> {
  return rt.provider.checkAuth(rt.env)
}
