import type { SlashCommandInfo } from './catalog.js'
import type { FastModeDisabledReason, FastModeState } from './session.js'

// Agent SDK payloads
//
// The server forwards Agent SDK messages verbatim. Rather than mirror the SDK's
// full type surface into the browser (it is a node-only package), these types
// describe exactly the subset the UI reads. Everything else stays untyped and
// is ignored. Widen these as the UI starts reading more.

/** A content block as it arrives on the wire: `type` plus unknown extras. */
export type RawBlock = { type: string } & Record<string, unknown>

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | RawBlock[] | unknown
  is_error?: boolean
}

export const isTextBlock = (b: RawBlock): b is RawBlock & TextBlock =>
  b.type === 'text' && typeof b.text === 'string'

export const isThinkingBlock = (b: RawBlock): b is RawBlock & ThinkingBlock =>
  b.type === 'thinking' && typeof b.thinking === 'string'

export const isToolUseBlock = (b: RawBlock): b is RawBlock & ToolUseBlock =>
  b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'

export const isToolResultBlock = (b: RawBlock): b is RawBlock & ToolResultBlock =>
  b.type === 'tool_result' && typeof b.tool_use_id === 'string'

export type McpServerInfo = { name: string; status: string }

/** A `stream_event`'s inner Anthropic streaming event (deltas only, for now). */
export type StreamEvent = {
  type: string
  delta?: { type: string; text?: string }
}

/** The subset of an SDK message the UI reads. */
export type SdkMessage = {
  type: string
  subtype?: string
  /** Claude Code's own session id: present on every SDK message. */
  session_id?: string
  model?: string
  tools?: string[]
  mcp_servers?: McpServerInfo[]
  message?: { role?: string; content?: RawBlock[] }
  event?: StreamEvent
  total_cost_usd?: number
  duration_ms?: number
  num_turns?: number
  /** result only: cumulative for the subprocess, like total_cost_usd */
  duration_api_ms?: number
  is_error?: boolean
  /** result only: cumulative use per model since the subprocess's counters started */
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>
  /** Carried on init and result messages; the session's fast-mode reality. */
  fast_mode_state?: FastModeState
  fast_mode_disabled_reason?: FastModeDisabledReason
  /** init only: the `/` commands whose UX needs a real terminal, we hide them. */
  terminal_slash_commands?: string[]
  /** `commands_changed` only: the replacement list, to be swapped in whole. */
  commands?: SlashCommandInfo[]
  /** `local_command_output` only: what a command like /usage printed. */
  content?: string
  /**
   * Set on assistant/user messages produced inside a subagent: the id of the
   * Agent/Task tool_use that started it. Null (or absent) = the main agent.
   */
  parent_tool_use_id?: string | null
  /** `task_*` system messages (a subagent, a background shell, …) */
  task_id?: string
  tool_use_id?: string
  /** `task_started`: 'local_agent' is a subagent; 'local_bash' a shell command */
  task_type?: string
  description?: string
  subagent_type?: string
  prompt?: string
  is_backgrounded?: boolean
  spawn_depth?: number
  /** `task_progress` / `task_notification`: what the task has used so far */
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  last_tool_name?: string
  /** `task_progress`: a one-line status; `task_notification`: how it ended */
  summary?: string
  /** `task_notification` */
  status?: string
  /** `task_notification` for a shell: where its output went ('' for a foreground one) */
  output_file?: string
  /** `task_notification`: the report a subagent handed back with SubagentHandback */
  handback_report?: { text?: string }
  /** `task_updated`: the fields that changed */
  patch?: { status?: string; is_backgrounded?: boolean; error?: string }
}
