/**
 * The provider seam: everything triage asks of a coding agent, as one
 * interface. Claude Code (via the Agent SDK) is the only adapter today
 * (`claude.ts`); a second one implements this file, never the call sites.
 *
 * Specs say what triage wants (a folder, a model, which tools, a veto on every
 * tool call); each adapter decides how its agent is told. What comes back is
 * `ProviderEvent`: each adapter folds its own stream into it, so the server
 * reads one shape whatever the agent. A few shapes are still Claude's own —
 * MCP server configs and the permission result — and are named here so
 * callers import them from the seam, not from the SDK.
 */
import type {
  McpServerConfig,
  McpServerStatus,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentCan,
  EffortLevel,
  FastModeDisabledReason,
  FastModeState,
  ImageMediaType,
  ModelOption,
  PermissionMode,
  SdkMessage,
  WorkspaceAuthBackend,
} from '../../shared/protocol.js'

export type ProviderId = 'claude'

/**
 * What an adapter can do beyond the bare interface. A caller that needs one
 * asks `missingCapabilities` (capabilities.ts) before using it, rather than
 * finding out from a method that quietly does nothing.
 */
export type Capability =
  /** continue the agent's own session after its process is gone */
  | 'resume'
  /** stop a turn mid-flight and keep the session */
  | 'interrupt'
  /** switch model inside a live session */
  | 'setModel'
  /** ask triage before a tool runs (SessionSpec.approve) */
  | 'toolApproval'
  /** host an MCP server inside triage's own process */
  | 'inProcessMcp'
  /** a veto that runs before every tool call (RunSpec.veto) */
  | 'hooks'
  /** token deltas as well as whole messages */
  | 'streamDeltas'

export type Capabilities = Readonly<Record<Capability, boolean>>

/** Fast mode as the agent says it is really serving — and why not, when it isn't. */
export type FastModeVerdict = { state?: FastModeState; reason?: FastModeDisabledReason }

/** A tool call the agent made, as the server reads it (which files a turn touched). */
export type ToolCall = { id: string; name: string; input: unknown }

/**
 * One event out of a running agent, normalised by its adapter. The server
 * reads the kind and its fields; `record` is the message as the transcript
 * keeps it (protocol's `SdkMessage`, triage's own shape), persisted as an
 * `sdk` session event for every kind but `stream`.
 */
export type ProviderEvent = {
  record: SdkMessage
  /** set when this event says what fast mode is doing */
  fastMode?: FastModeVerdict
} & (
  /** the agent is up: its own session id (the key for resume) and what it runs */
  | { kind: 'started'; sessionId?: string; model?: string; terminalCommands?: string[] }
  /** an in-flight piece of a message — broadcast live, never persisted */
  | { kind: 'stream' }
  /** a committed turn message (the agent's, or a tool result fed back to it) */
  | { kind: 'message'; role: 'assistant' | 'user'; toolCalls: ToolCall[] }
  /** the agent's `/` commands changed mid-run: the whole new list */
  | { kind: 'commands'; commands: CommandEntry[] }
  /**
   * A turn finished. `costUsd` is cumulative for the agent's process;
   * `overBudget` = it stopped because maxBudgetUsd ran out.
   */
  | { kind: 'result'; ok: boolean; overBudget: boolean; text: string; costUsd?: number; tokens: number }
  /** anything else the transcript shows (task progress, notices, …) */
  | { kind: 'other' }
)

/** MCP servers handed to a run, by name. */
export type McpServers = Record<string, McpServerConfig>

/** One MCP server as the agent reports it after connecting. */
export type McpStatus = McpServerStatus

export type { PermissionResult, PermissionUpdate }

/** Spawn-time environment overrides (workspace auth); undefined = inherit. */
export type SpawnEnv = Record<string, string> | undefined

/** One user turn into a live session: text and images, in order. */
export type UserTurn = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  >
}

/** A slash command as the agent lists it. */
export type CommandEntry = { name: string; description: string; argumentHint: string; aliases?: string[] }

/** What the agent passes along with a tool call it wants approved. */
export type ToolApprovalContext = {
  title?: string
  description?: string
  /** "don't ask again" rules the agent proposes, replayed on allow-always */
  suggestions?: PermissionUpdate[]
  /** the subagent making the call, when it isn't the main agent */
  agentID?: string
}

/** Asked before a tool runs that the session's mode doesn't already decide. */
export type ToolApproval = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolApprovalContext,
) => Promise<PermissionResult>

/** A veto on every tool call, run before the call and before any allow rule. */
export type ToolVeto = (toolName: string, input: unknown) => { allow: true } | { allow: false; reason: string }

/** An interactive session: fed turn by turn, steered while it runs. */
export type SessionSpec = {
  cwd: string
  env?: SpawnEnv
  /** text appended to the agent's own system prompt (survives resume) */
  systemAppend?: string
  mcpServers: McpServers
  /** load only `mcpServers` — none of the user's other connectors or plugins */
  strictMcp?: boolean
  /** the only built-in tools the agent gets */
  tools?: string[]
  /** tools the agent never gets */
  disallowedTools?: string[]
  /** unset = the agent's own default */
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  /** extra inline settings, adapter-specific (e.g. a compaction window) */
  settings?: Record<string, unknown>
  /** a hard stop: the agent ends the run past this spend */
  maxBudgetUsd?: number
  permissionMode?: PermissionMode | null
  /** the agent's own session id to continue */
  resume?: string
  approve: ToolApproval
}

/** A live session's handle: its message stream plus the controls. */
export interface AgentSession extends AsyncIterable<ProviderEvent> {
  setModel(model: string | undefined): Promise<void>
  setEffort(effort: EffortLevel | null): Promise<void>
  /** off clears the opt-in rather than writing false */
  setFastMode(on: boolean): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  commands(): Promise<CommandEntry[]>
  interrupt(): Promise<void>
  /** stop one subagent */
  stopTask(taskId: string): Promise<void>
  /** hand a foreground subagent to the background */
  backgroundTask(toolUseId: string): Promise<void>
}

/** One headless prompt run to completion (watches, scans, drafts). */
export type RunSpec = {
  prompt: string
  cwd?: string
  env?: SpawnEnv
  abort?: AbortController
  model?: string
  /** load the user's own settings (connectors, plugins); false = none at all */
  userConfig?: boolean
  /** the only built-in tools the agent gets */
  tools?: string[]
  /** tools that run without asking */
  allowedTools?: string[]
  disallowedTools?: string[]
  /** never ask: anything not allowed is refused */
  unattended?: boolean
  veto?: ToolVeto
  mcpServers?: McpServers
  maxBudgetUsd?: number
  /** token deltas as well as whole messages */
  streamDeltas?: boolean
}

/**
 * A workspace's auth as the adapter reads it: the backend, plus what triage
 * keeps for it on disk (the stored key; the workspace's private config dir).
 */
export type ProviderAuth =
  | { backend: Extract<WorkspaceAuthBackend, 'inherit'> }
  | { backend: Extract<WorkspaceAuthBackend, 'api-key'>; apiKey?: string }
  | { backend: Extract<WorkspaceAuthBackend, 'config-dir'>; dir: string }

/** MCP servers the agent's own config files declare, raw (env refs unexpanded). */
export type ConfiguredMcp = {
  /** the folder's shared file, checked in with the project */
  project: Record<string, unknown>
  /** private per-folder servers, keyed by absolute folder path */
  local: Record<string, Record<string, unknown>>
}

/** An agent file's "can" as the agent's own tool lists, plus any MCP server it needs (raw config, passed through). */
export type AgentTools = { tools: string[]; disallowedTools: string[]; mcpServers?: Record<string, Record<string, unknown>> }

/** A throwaway look at what the agent sees in a folder. */
export type ProbeSpec = { cwd: string; env?: SpawnEnv }

export interface Provider {
  readonly id: ProviderId
  readonly label: string
  readonly capabilities: Capabilities
  /** how a workspace logs this agent in */
  readonly auth: {
    /** the env var an API key is read from — and stored under in the workspace's .env */
    readonly apiKeyVar: string
    /** spawn-env overrides for `auth`, merged over process.env; undefined = inherit */
    env(auth: ProviderAuth): Record<string, string> | undefined
    /** the one-time interactive login into a workspace's private config `dir` */
    loginCommand(dir: string): string
  }
  /** what the agent's own config on disk says, read without spawning it */
  readonly discovery: {
    /** MCP servers its config files declare for `cwd` and every other folder */
    configuredMcp(spec: { cwd: string; env: SpawnEnv }): Promise<ConfiguredMcp>
    /** where a spawn with `env` writes its transcripts */
    transcriptDir(env: SpawnEnv): string
  }
  /** an agent file's "can" (teams) as this agent's tool names */
  agentTools(can: AgentCan[]): AgentTools
  /** a long-lived session over `input`; ends when `input` closes */
  openSession(input: AsyncIterable<UserTurn>, spec: SessionSpec): AgentSession
  run(spec: RunSpec): AsyncIterable<ProviderEvent>
  /**
   * The MCP servers a run in `cwd` would load, once connected. With `servers`,
   * exactly those plus the user's own; without, everything the folder's
   * settings bring in.
   */
  mcpStatus(spec: ProbeSpec & { servers?: McpServers }): Promise<McpStatus[]>
  models(spec: ProbeSpec): Promise<ModelOption[]>
  commands(spec: ProbeSpec): Promise<CommandEntry[]>
  /** a real round-trip, proving the auth in `env` works */
  checkAuth(env: SpawnEnv): Promise<{ ok: boolean; error?: string }>
}
