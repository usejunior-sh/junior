import type { EffortLevel } from './session.js'

// ---------------------------------------------------------------------------
// Connectors (GET /api/connectors)
//
// The claude.ai connectors + local MCP servers a session will load, probed by
// spawning a throwaway SDK query with the same options real sessions use and
// reading its init message. HTTP rather than WS: it is request/response data.
// ---------------------------------------------------------------------------

export type ConnectorSource = 'claude.ai' | 'local'

/** Where Claude Code found the server (job-spec.md, item 1). */
export type ConnectorScope = 'claudeai' | 'user' | 'local' | 'project' | 'plugin' | 'managed' | 'unknown'

export type ConnectorTool = {
  /** bare tool name, e.g. "notion-search" */
  name: string
  /** the allowlist name, e.g. "mcp__claude_ai_Notion__notion-search" */
  fullName: string
  description?: string
  /** from the server's own annotations; absent = the server did not say */
  readOnly?: boolean
  destructive?: boolean
  /** false = the tool stays on this machine (a local browser, an editor) */
  openWorld?: boolean
}

export type Connector = {
  /** Display name — "claude.ai " prefix already stripped for claude.ai ones. */
  name: string
  /** the server name as Claude Code reports it ("claude.ai Slack") — what grants key on */
  server: string
  status: string
  source: ConnectorSource
  scope: ConnectorScope
  error?: string
  /** empty unless connected */
  tools: ConnectorTool[]
}

export type ConnectorsResponse =
  | {
      ok: true
      probedAt: number
      connectors: Connector[]
      cwd?: string
      /** local-scope servers configured for OTHER folders — usable once the job runs there */
      elsewhere?: Array<{ name: string; folder: string }>
    }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Models (GET /api/models)
//
// What this machine's Claude Code will actually run, asked of the SDK itself
// (supportedModels()) rather than hardcoded — the catalog changes under us,
// and an org policy can shrink it. Same shape of probe as the connectors one.
// ---------------------------------------------------------------------------

export type ModelOption = {
  /** What to pass as `model` — an alias ('sonnet') or a wire id. */
  id: string
  /** The wire id `id` resolves to; lets a reported model match its alias row. */
  resolvedModel?: string
  /** "Opus (1M context)" */
  name: string
  /** One line under the name in the picker. */
  description: string
  /** Effort levels this model accepts; empty when it has no effort control. */
  efforts: EffortLevel[]
  /** Whether this model can be run in fast mode at all. */
  supportsFastMode?: boolean
}

export type ModelsResponse =
  | { ok: true; probedAt: number; models: ModelOption[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Slash commands (GET /api/commands?cwd=…)
//
// What `/` offers in a composer: Claude Code's own commands plus whatever the
// user, the project and its plugins define. Asked of the SDK
// (supportedCommands()) for the same reason the model catalog is — it moves
// under us — but keyed by *folder* rather than by workspace, because a
// project's .claude/commands and .claude/skills only exist under that project.
// ---------------------------------------------------------------------------

export type SlashCommandInfo = {
  /** the name without the leading slash — `review`, or `novus:ux-review` */
  name: string
  /** the one line under the name in the picker */
  description: string
  /** what it takes after the name, e.g. `<file>`; empty when it takes nothing */
  argumentHint: string
  /** other names that resolve here (`/cost` and `/stats` both mean `/usage`) */
  aliases?: string[]
}

export type CommandsResponse =
  /** `cwd` is the folder the server resolved the query to — `~` expanded, path
   *  made absolute. It is what `commands_changed` frames are keyed by, so a
   *  client holds on to it rather than to the folder it asked about. */
  | { ok: true; cwd: string; probedAt: number; commands: SlashCommandInfo[] }
  | { ok: false; error: string }
