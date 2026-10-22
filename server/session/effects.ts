import type { PermissionUpdate } from '../providers/types.js'
import type { ToolEffect } from '../../shared/protocol.js'
import { READ_VERBS, wordsOf, WRITE_VERBS } from '../../core/actions/sort.js'

/**
 * A permission rule the SDK suggested, pinned to this session. Every variant
 * of PermissionUpdate carries a `destination`, so this is a blanket rewrite,
 * nothing an "Always allow" click produces may reach a settings file.
 */
export const sessionScoped = (u: PermissionUpdate): PermissionUpdate => ({ ...u, destination: 'session' })

// Effect classifier: the heart of 'gated' mode.
//
// Before a tool runs, we place it on a blast-radius scale (read / local-write /
// external-write) so 'gated' can wave through reads and still stop on anything
// that writes. Two rules keep it safe:
//   1. Unknown ⇒ write. Only a call we can *prove* is a read runs unattended;
//      everything else prompts, so a newly connected tool is gated by default.
//   2. Any write verb wins over any read verb. A connector call is a read only
//      when its name signals a read and signals no write, so a mutating tool
//      can never sneak through on a "get"/"list" substring.
// Classification is by tool *name*, per tool, never per MCP server: Slack read
// and Slack send share one connector but must land on opposite sides.

/** Built-in tools whose only effect is reading. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])
/** Our own MCP tools that only read (the inbox, the artifacts index), never prompt for these. */
/** Junior's own team tools: they record and route, and the team card is the approval, never a prompt. */
export const TEAM_TOOLS = new Set([
  'mcp__junior__list_teams',
  'mcp__junior__propose_team',
  'mcp__junior__split_step',
  'mcp__junior__revise_plan',
  'mcp__junior__submit_step',
  'mcp__junior__goal_verdict',
  'mcp__junior__goal_unstick',
  'mcp__junior__ask_you',
  'mcp__team__submit_step',
])
/** Starting and messaging other chats: local work, since each chat's own sends stay held. Never a prompt. */
export const SESSION_TOOLS = new Set(['mcp__junior__start_session', 'mcp__junior__message_session'])
export const JUNIOR_READ_TOOLS = new Set([
  'mcp__junior__list_work_items',
  'mcp__junior__get_work_item',
  'mcp__junior__get_session_context',
  'mcp__junior__get_workspace',
  'mcp__junior__list_artifacts',
  'mcp__junior__read_artifact',
  'mcp__junior__goal_get',
  'mcp__junior__goal_list',
  'mcp__junior__get_today',
  // Other chats, by name (server/session/spawn-ops.ts): reading where they stand.
  'mcp__junior__read_session',
  'mcp__junior__list_sessions',
  // Advance approvals: listing reads, proposing only shows a card. Only the user's Add makes one.
  'mcp__junior__list_approvals',
  'mcp__junior__propose_approval',
])

// Verb tokens that mark a connector call's intent: READ_VERBS / WRITE_VERBS
// and wordsOf live in core/actions/sort.ts, which sorts outbound actions by
// the same words, so the prompt's effect and the Actions page never disagree.

export function classifyEffect(toolName: string): ToolEffect {
  // Our own inbox: reading it is harmless; every other junior tool writes local
  // SQLite (create/edit/upsert/resolve).
  if (JUNIOR_READ_TOOLS.has(toolName)) return 'read'
  if (toolName.startsWith('mcp__junior__')) return 'local-write'

  if (READ_TOOLS.has(toolName)) return 'read'
  // TodoWrite is the session's own scratch list. No effect past this session.
  if (toolName === 'TodoWrite') return 'read'

  // Connector (MCP) tools reach outside this machine unless they are plainly a
  // read. `mcp__<server>__<leaf>`: classify by the leaf's verbs (rule 2).
  if (toolName.startsWith('mcp__')) {
    const words = wordsOf(toolName.slice(toolName.lastIndexOf('__') + 2))
    const isRead = words.some((w) => READ_VERBS.has(w)) && !words.some((w) => WRITE_VERBS.has(w))
    return isRead ? 'read' : 'external-write'
  }

  // Everything else built in (Write/Edit/MultiEdit/NotebookEdit and Bash)
  // touches this machine. Bash can be read-only, but its command cannot be
  // classified safely from here, so it is a write and asks.
  return 'local-write'
}
