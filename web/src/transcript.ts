/**
 * Folds a session's event log into a flat list of renderable items.
 *
 * Pure and memoisable: the events array only ever grows by append, so this runs
 * once per committed event, not once per token. Tool results arrive in a later
 * `user` message than the `tool_use` that produced them, so they are stitched
 * back onto their card here rather than in a component.
 *
 * Subagents share the log: whatever one does carries the id of the Agent call
 * that started it (`parent_tool_use_id`). The main transcript leaves those out
 * and draws each Agent call as one card; an agent's own view is this same fold
 * with `scope` set to that call, so it only keeps what the agent did.
 */
import { AGENT_TOOLS, HANDBACK_TOOL, type AgentRun } from './agents.js'
import {
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  type ImageAttachment,
  type AgentRelay,
  type ResolvedMention,
  type McpServerInfo,
  type PermissionBehavior,
  type QuestionAnswers,
  type RawBlock,
  type SessionEvent,
  type ToolEffect,
} from '../../shared/protocol.js'

export type ToolResult = { text: string; isError: boolean }

export type ToolItem = {
  key: string
  kind: 'tool'
  name: string
  input: Record<string, unknown>
  result?: ToolResult
  /** When the call was made and when its result came back (ms epoch), if known. */
  startedAt?: number
  endedAt?: number
}

export type ThinkingItem = { key: string; kind: 'thinking'; text: string }

/** Did main pass a relayed message on, and as written? Unknown until its SendMessage call shows up. */
export type RelayDelivery = 'verbatim' | 'reworded'

export type TranscriptItem =
  | {
      key: string
      kind: 'user'
      text: string
      images?: ImageAttachment[]
      mentions?: ResolvedMention[]
      from?: string
      /** In an agent's view: this was written to the agent and relayed through main. */
      relayed?: { delivery?: RelayDelivery; sent?: string }
    }
  /** In the main transcript: a message the user wrote to a subagent — one quiet line, not a bubble. */
  | { key: string; kind: 'relay'; text: string; relay: AgentRelay; delivery?: RelayDelivery }
  /** An Agent/Task call: the subagent it started, drawn as one card. */
  | { key: string; kind: 'agent'; toolUseId: string }
  | { key: string; kind: 'assistant'; text: string }
  | ThinkingItem
  | { key: string; kind: 'error'; text: string }
  | { key: string; kind: 'meta'; text: string; /** 1-based turn this marker ends, for the changeset line */ turn?: number }
  | { key: string; kind: 'init'; model?: string; toolCount: number; servers: McpServerInfo[]; mcpTools: string[] }
  /** What a local command (`/usage`, `/context`) printed — not the model talking. */
  | { key: string; kind: 'command'; text: string }
  | ToolItem
  /** A run of back-to-back tool calls (and the thinking between them), drawn as one row. */
  | { key: string; kind: 'toolGroup'; members: Array<ToolItem | ThinkingItem> }
  | {
      key: string
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      canAlwaysAllow?: boolean
      effect?: ToolEffect
      resolved?: PermissionBehavior | 'expired'
      /** AskUserQuestion only: what the user picked, for the replayed card. */
      answers?: QuestionAnswers
      /** A subagent's call: that agent's id. */
      agentId?: string
    }

export type TranscriptScope = {
  /** Fold only what this subagent did (its Agent tool_use id). Unset = the main agent. */
  scope?: string | null
  /** The session's agents (buildAgents) — which calls started one, and whose prompt is whose. */
  agents?: readonly AgentRun[]
}

export function buildTranscript(
  events: readonly SessionEvent[],
  timeOf: (ev: SessionEvent) => number | undefined = () => undefined,
  { scope = null, agents = [] }: TranscriptScope = {},
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // The SDK sends init at the start of every turn, so only the first one is
  // drawn. A revival is marked by triage's own `subprocess` event instead, and
  // the init that follows it names the model the new process runs.
  let initSeen = false
  let resumed = false
  // A result's total_cost_usd is cumulative for its subprocess, so a turn's own
  // cost is the step from the last one. A new subprocess starts from zero.
  let costSeen = 0
  // Turns are counted the way the server counts them: one per `result`, so a
  // marker can be matched to the snapshot pair that bracketed it.
  let turnSeq = 0
  // Items are rebuilt on every append, so late-arriving results and permission
  // verdicts are patched onto the item objects created earlier in this pass.
  const toolsById = new Map<string, ToolItem>()
  const permsById = new Map<string, Extract<TranscriptItem, { kind: 'permission' }>>()
  const agentCalls = new Set(agents.map((a) => a.toolUseId))
  const scopedAgentId = scope ? agents.find((a) => a.toolUseId === scope)?.agentId : undefined
  // Relayed messages waiting for main's SendMessage, oldest first — matched by
  // recipient, whatever view is being built (the call itself is main's).
  const relays: Array<{ agentId: string; text: string; mark: (d: RelayDelivery, sent: string) => void }> = []

  events.forEach((ev, i) => {
    switch (ev.kind) {
      case 'local_user': {
        if (ev.relay) {
          let mark: (d: RelayDelivery, sent: string) => void = () => {}
          if (!scope) {
            const item = { key: `u${i}`, kind: 'relay' as const, text: ev.text, relay: ev.relay } as Extract<TranscriptItem, { kind: 'relay' }>
            items.push(item)
            mark = (d) => (item.delivery = d)
          } else if (scope === ev.relay.toolUseId) {
            const relayed: { delivery?: RelayDelivery; sent?: string } = {}
            items.push({ key: `u${i}`, kind: 'user', text: ev.text, relayed })
            mark = (d, sent) => Object.assign(relayed, { delivery: d, sent })
          }
          relays.push({ agentId: ev.relay.agentId, text: ev.text, mark })
          break
        }
        if (!scope) items.push({ key: `u${i}`, kind: 'user', text: ev.text, images: ev.images, mentions: ev.mentions, from: ev.from })
        break
      }
      case 'error':
        if (!scope) items.push({ key: `e${i}`, kind: 'error', text: ev.message })
        break
      case 'notice':
        if (!scope) items.push({ key: `n${i}`, kind: 'meta', text: `— ${ev.text} —` })
        break
      case 'subprocess':
        resumed = true
        costSeen = 0
        break
      case 'permission_request': {
        // Main shows every prompt (that's where the reader usually is); an agent's view, only its own.
        if (scope && (!scopedAgentId || ev.agentId !== scopedAgentId)) break
        const item = {
          key: `p${i}`,
          kind: 'permission' as const,
          id: ev.id,
          toolName: ev.toolName,
          input: ev.input,
          title: ev.title,
          canAlwaysAllow: ev.canAlwaysAllow,
          effect: ev.effect,
          agentId: ev.agentId,
        }
        permsById.set(ev.id, item)
        items.push(item)
        break
      }
      case 'permission_resolved': {
        const item = permsById.get(ev.id)
        if (item) {
          item.resolved = ev.behavior
          item.answers = ev.answers
        }
        break
      }
      case 'sdk': {
        const m = ev.message
        // Main's relay call, wherever this view is: did the message go through as written?
        if (m.type === 'assistant' && relays.length) {
          for (const b of m.message?.content ?? []) {
            if (!isToolUseBlock(b) || b.name !== 'SendMessage') continue
            const at = relays.findIndex((r) => r.agentId === b.input.to)
            if (at === -1) continue
            const [r] = relays.splice(at, 1)
            const sent = typeof b.input.message === 'string' ? b.input.message : ''
            r.mark(sent.trim() === r.text.trim() ? 'verbatim' : 'reworded', sent)
          }
        }
        // A subagent's messages belong to its own view; main's, to main's.
        if ((m.type === 'assistant' || m.type === 'user') && (m.parent_tool_use_id ?? null) !== scope) break
        if (scope && m.type !== 'assistant' && m.type !== 'user') break
        if (m.type === 'system' && m.subtype === 'init') {
          if (initSeen) {
            if (resumed) items.push({ key: `i${i}`, kind: 'meta', text: `— session resumed · ${m.model ?? '?'} —` })
            resumed = false
          } else {
            initSeen = true
            items.push({
              key: `i${i}`,
              kind: 'init',
              model: m.model,
              toolCount: m.tools?.length ?? 0,
              servers: m.mcp_servers ?? [],
              // Which servers actually put tools on the table. The status a
              // server reports and the tools a session got can disagree: the
              // in-process triage server always wins its name, so a same-named
              // entry from ~/.claude that failed is the status being shown
              // while the working tools are right there in the list.
              mcpTools: (m.tools ?? []).filter((t) => t.startsWith('mcp__')),
            })
          }
        } else if (m.type === 'system' && m.subtype === 'local_command_output') {
          // A command the CLI answers by itself — `/usage`, `/context`. Without
          // this the message would send and visibly do nothing, which is
          // exactly what someone tries a command picker on first.
          if (m.content?.trim()) items.push({ key: `lc${i}`, kind: 'command', text: m.content })
        } else if (m.type === 'assistant') {
          for (const [j, b] of (m.message?.content ?? []).entries()) {
            if (isTextBlock(b) && b.text.trim()) {
              items.push({ key: `a${i}.${j}`, kind: 'assistant', text: b.text })
            } else if (isThinkingBlock(b) && b.thinking) {
              items.push({ key: `t${i}.${j}`, kind: 'thinking', text: truncate(b.thinking, 400) })
            } else if (isToolUseBlock(b) && (agentCalls.has(b.id) || AGENT_TOOLS.has(b.name))) {
              items.push({ key: `c${i}.${j}`, kind: 'agent', toolUseId: b.id })
            } else if (isToolUseBlock(b) && b.name === HANDBACK_TOOL) {
              // The agent's report — its view shows it as the hand-back card, not as a step.
            } else if (isToolUseBlock(b)) {
              const item = {
                key: `c${i}.${j}`,
                kind: 'tool' as const,
                name: b.name,
                input: b.input,
                startedAt: timeOf(ev),
              }
              toolsById.set(b.id, item)
              items.push(item)
            }
          }
        } else if (m.type === 'user') {
          for (const b of m.message?.content ?? []) {
            if (!isToolResultBlock(b)) continue
            const item = toolsById.get(b.tool_use_id)
            if (!item) continue
            item.result = { text: resultText(b.content), isError: b.is_error === true }
            item.endedAt = timeOf(ev)
          }
        } else if (m.type === 'result') {
          // A drop means a new subprocess the log never marked (one from before the marker existed).
          const total = m.total_cost_usd
          const turnCost = total == null ? null : total >= costSeen ? total - costSeen : total
          if (total != null) costSeen = total
          const cost = turnCost != null ? ` · $${turnCost.toFixed(4)}` : ''
          const secs = ((m.duration_ms ?? 0) / 1000).toFixed(1)
          turnSeq += 1
          items.push({
            key: `r${i}`,
            kind: 'meta',
            turn: turnSeq,
            text: `— turn done · ${secs}s · ${m.num_turns ?? 0} turns${cost} —`,
          })
        }
        break
      }
    }
  })

  return groupToolRuns(items)
}

/** Edit-shaped tools stay a card of their own: the diff is the point of them. */
const UNFOLDED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Folds each run of back-to-back tool calls into one `toolGroup`, so the prose
 * between runs is what the eye lands on. Thinking inside a run folds with it;
 * anything else — text, a permission prompt, an edit — ends the run. A run with
 * no tool call in it (thinking alone) is left as it was.
 *
 * Runs only ever grow at their end, so keying a group by its first member keeps
 * it mounted (and its open/closed state intact) as calls stream in.
 */
function groupToolRuns(items: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  let run: Array<ToolItem | ThinkingItem> = []
  const flush = () => {
    if (run.some((m) => m.kind === 'tool')) out.push({ key: `g${run[0].key}`, kind: 'toolGroup', members: run })
    else out.push(...run)
    run = []
  }
  for (const item of items) {
    if (item.kind === 'thinking' || (item.kind === 'tool' && !UNFOLDED.has(item.name))) {
      run.push(item)
    } else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as RawBlock[])
      .map((c) => (isTextBlock(c) ? c.text : `[${c.type}]`))
      .join('\n')
  }
  return JSON.stringify(content)
}

/** The one-line hint shown next to a tool name in the collapsed card. */
export function toolHint(input: Record<string, unknown>): string {
  const v = firstString(input, ['description', 'command', 'file_path', 'pattern', 'url', 'query'])
  return v ? ' — ' + truncate(v, 80) : ''
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

/** `list_pages` / `getJiraIssue` → "List pages" / "Get jira issue". */
function humanize(leaf: string): string {
  const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A tool call as one readable line: the tool, what it touched, and — for MCP
 * tools — which server it came from. Bash leads with the `description` the
 * model wrote for it; the raw command is one click away.
 */
export function toolLine(name: string, input: Record<string, unknown>): { verb: string; target: string; server?: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) {
    return { verb: humanize(mcp[2]), target: truncate(firstString(input, Object.keys(input)), 80), server: mcp[1].replace(/^claude_ai_/, '') }
  }
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : null
      const limit = typeof input.limit === 'number' ? input.limit : null
      const range = offset != null ? ` ${offset}–${limit != null ? offset + limit - 1 : ''}` : ''
      return { verb: name, target: basename(s('file_path')) + range }
    }
    case 'Grep':
    case 'Glob':
      return { verb: name, target: `${s('pattern')}${s('path') ? ` in ${basename(s('path'))}` : ''}` }
    case 'TodoWrite':
      return { verb: name, target: Array.isArray(input.todos) ? `${input.todos.length} todos` : '' }
    default:
      return { verb: name, target: truncate(firstString(input, ['description', 'command', 'query', 'url', 'skill', 'file_path', 'pattern']), 80) }
  }
}

/**
 * How long a set of calls took, first call made to last result back — model
 * time between calls included, since that is the wait the reader sat through.
 * Empty when any end is unknown (a dry run's replayed history, a call still out).
 */
export function toolsDuration(tools: readonly ToolItem[]): string {
  const starts = tools.map((t) => t.startedAt)
  const ends = tools.map((t) => t.endedAt)
  if (!tools.length || starts.some((t) => t === undefined) || ends.some((t) => t === undefined)) return ''
  return formatDuration(Math.max(...(ends as number[])) - Math.min(...(starts as number[])))
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

/** A short tally of what a call returned, where one is cheap and honest. */
export function toolResultNote(item: ToolItem): string {
  if (!item.result) return ''
  if (item.result.isError) return 'failed'
  if (!['Read', 'Bash', 'Grep'].includes(item.name)) return ''
  const n = item.result.text.split('\n').filter((l) => l.trim()).length
  return n ? `${n} ${n === 1 ? 'line' : 'lines'}` : 'no output'
}
