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
import { buildShells, type ShellRun } from '../../core/shells/fold.js'
import { WORKFLOW_TOOL } from '../../core/workflows/fold.js'
import { WorkflowTurns } from '../../core/workflows/tasks.js'
import { costStep, type CostMark } from '../../core/usage/turn-cost.js'
import {
  ARTIFACT_TOOLS,
  parseArtifactResult,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  type ArtifactToolResult,
  type FileRef,
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
  /** the tool_use id: what an action record names its call by */
  id?: string
  name: string
  input: Record<string, unknown>
  result?: ToolResult
  /** When the call was made and when its result came back (ms epoch), if known. */
  startedAt?: number
  endedAt?: number
  /** Bash only: the shell it ran: still running after the call returned, if it went to the background. */
  shell?: ShellRun
}

export type ThinkingItem = { key: string; kind: 'thinking'; text: string }

/** The in-process junior MCP's two publishing tools: a session declares an artifact by calling one. */
export const ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set(ARTIFACT_TOOLS.map((leaf) => `mcp__junior__${leaf}`))
/** A task's hand-ins that save an artifact on the item answer with the same envelope, so they fold into a card too. */
const HAND_IN_ARTIFACT_TOOLS: ReadonlySet<string> = new Set(['submit_brief', 'submit_plan', 'submit_review'].map((leaf) => `mcp__task__${leaf}`))

/** How much of a body the card keeps for its preview. */
export const ARTIFACT_BODY_KEEP = 4000

/** One published artifact, drawn as a card where Junior made it; later calls on the same id in the turn fold in. */
export type ArtifactItem = {
  /** key of the FIRST call folded into the card (`c<i>.<j>`), so it stays mounted */
  key: string
  kind: 'artifact'
  /** the latest call folded in: its input and result */
  call: ToolItem
  /** what the latest successful call published; undefined while the call is still out */
  pub?: ArtifactToolResult
  /** the first call folded in created it: "New", else "Updated" */
  created: boolean
  /** calls folded into this card, >= 1 */
  calls: number
  /** text to preview: the input.body of the latest folded call that sent one, cut at 4000 chars */
  body?: string
}

/** Did main pass a relayed message on, and as written? Unknown until its SendMessage call shows up. */
export type RelayDelivery = 'verbatim' | 'reworded'

export type TranscriptItem =
  | {
      key: string
      kind: 'user'
      text: string
      images?: ImageAttachment[]
      files?: FileRef[]
      mentions?: ResolvedMention[]
      from?: string
      /** the session that sent it, when one did */
      fromSession?: string
      /** sent in Goal mode */
      mode?: 'goal'
      /** In an agent's view: this was written to the agent and relayed through main. */
      relayed?: { delivery?: RelayDelivery; sent?: string }
    }
  /** In the main transcript: a message the user wrote to a subagent. One quiet line, not a bubble. */
  | { key: string; kind: 'relay'; text: string; relay: AgentRelay; delivery?: RelayDelivery }
  /** An Agent/Task call: the subagent it started, drawn as one card. */
  | { key: string; kind: 'agent'; toolUseId: string }
  /** A Workflow call: the Ultracode run it launched, drawn as one card (core/workflows/fold.ts). */
  | { key: string; kind: 'workflow'; toolUseId: string }
  | { key: string; kind: 'assistant'; text: string }
  | ThinkingItem
  | { key: string; kind: 'error'; text: string }
  | {
      key: string
      kind: 'meta'
      text: string
      /** 1-based turn this marker ends: one per result */
      turn?: number
      /** The server's changeset this marker closes (its turn seq), for the files line. Absent = it closes none. */
      changes?: number
      /** a turn's end, without the frame: "32.2s · 9 turns · $0.8007", for Junior's sign-off */
      stats?: string
      /** how long the turn took, for Junior's "Done in 32s" */
      ms?: number
      /** Workflow agents spent while this turn was open: its cost (cumulative at the result) includes some of theirs. */
      workflowSpend?: boolean
    }
  | { key: string; kind: 'init'; model?: string; toolCount: number; servers: McpServerInfo[]; mcpTools: string[] }
  /** What a local command (`/usage`, `/context`) printed, not the model talking. */
  | { key: string; kind: 'command'; text: string }
  | ToolItem
  | ArtifactItem
  /** A run of back-to-back tool calls (and the thinking between them), drawn as one row. */
  | { key: string; kind: 'toolGroup'; members: Array<ToolItem | ThinkingItem> }
  | {
      key: string
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      /** why it asks, in words (the browser gate's "Open app.pendo.io as Work?") */
      description?: string
      canAlwaysAllow?: boolean
      effect?: ToolEffect
      resolved?: PermissionBehavior | 'expired'
      /** AskUserQuestion only: what the user picked, for the replayed card. */
      answers?: QuestionAnswers
      /** A subagent's call: that agent's id. */
      agentId?: string
      /** A workflow agent's call: its run's task id. */
      workflowTaskId?: string
    }

export type TranscriptScope = {
  /** Fold only what this subagent did (its Agent tool_use id). Unset = the main agent. */
  scope?: string | null
  /** The session's agents (buildAgents), which calls started one, and whose prompt is whose. */
  agents?: readonly AgentRun[]
  /** The session's shells (buildShells); folded from `events` when not given. */
  shells?: readonly ShellRun[]
  /**
   * How many events come before `events[0]` (a paged log's `firstSeq - 1`).
   * Keys count from here, so prepending an older page keeps every item's key.
   */
  base?: number
  /**
   * `events` starts partway through the log (older pages not loaded yet).
   * Whatever the fold works out from the start is left off: the opening init
   * card, the first turn's cost (costs are cumulative) and which changeset a
   * turn closes (counted from the session's first message).
   */
  midway?: boolean
}

/** The event an item was folded from: every key carries its event's index in the whole log (`u12`, `a12.0`, `ga12.0`). */
export const eventIndexOf = (item: TranscriptItem): number => Number(/\d+/.exec(item.key)?.[0] ?? 0)

export function buildTranscript(
  events: readonly SessionEvent[],
  timeOf: (ev: SessionEvent) => number | undefined = () => undefined,
  { scope = null, agents = [], shells, base = 0, midway = false }: TranscriptScope = {},
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // The SDK sends init at the start of every turn, so only the first one is
  // drawn. A revival is marked by Junior's own `subprocess` event instead, and
  // the init that follows it names the model the new process runs.
  let initSeen = midway
  let resumed = false
  // A result's total_cost_usd is cumulative, so a turn's own cost is the step
  // from the last one. A revival may carry the counters on or start them over:
  // costStep tells which, and a subprocess marked fresh surely starts over.
  let costSeen: CostMark | null = null
  // Midway, the first result's cumulative cost would read as one turn's: no
  // figure until a step can be taken (or a fresh subprocess starts the count).
  let costBlind = midway
  let turnSeq = 0
  // Changesets are counted the way the server counts them (live-session.ts):
  // your message opens one unless one is open, and a result closes it, unless
  // a Workflow run holds it (WorkflowTurns): one still going, or one that ended
  // in this turn, whose wake-up turn then closes it. Or the subprocess ending
  // does. A turn with no message (a wake-up) opens none.
  let changeSeq = 0
  let changeOpen = false
  let changeHeld = false
  const wfTurns = new WorkflowTurns()
  // Workflow agents' spend lands in whichever result follows it. A turn says
  // its cost may include theirs when its window saw their token count grow, or
  // when it closed with a run still going: an agent's call can land in the
  // result before any progress frame reports it (and the log thins those frames).
  // A task_notification repeats the final total, so it is never growth.
  const workflowTasks = new Set<string>()
  const wfTokens = new Map<string, number>()
  let wfSpent = false
  // Items are rebuilt on every append, so late-arriving results and permission
  // verdicts are patched onto the item objects created earlier in this pass.
  const toolsById = new Map<string, ToolItem>()
  const permsById = new Map<string, Extract<TranscriptItem, { kind: 'permission' }>>()
  const agentCalls = new Set(agents.map((a) => a.toolUseId))
  const shellsById = new Map((shells ?? buildShells(events, timeOf)).map((r) => [r.toolUseId, r]))
  const scopedAgentId = scope ? agents.find((a) => a.toolUseId === scope)?.agentId : undefined
  // Relayed messages waiting for main's SendMessage, oldest first, matched by
  // recipient, whatever view is being built (the call itself is main's).
  const relays: Array<{ agentId: string; text: string; mark: (d: RelayDelivery, sent: string) => void }> = []

  events.forEach((ev, at) => {
    const i = base + at
    switch (ev.kind) {
      case 'local_user': {
        if (!changeOpen) {
          changeOpen = true
          changeSeq += 1
        }
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
        if (!scope) items.push({ key: `u${i}`, kind: 'user', text: ev.text, images: ev.images, ...(ev.files?.length ? { files: ev.files } : {}), mentions: ev.mentions, from: ev.from, ...(ev.fromSession ? { fromSession: ev.fromSession } : {}), ...(ev.mode ? { mode: ev.mode } : {}) })
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
        if (ev.fresh) {
          costSeen = null
          costBlind = false
        }
        // The old subprocess took its runs with it, and closed the changeset they held.
        wfTurns.clear()
        if (changeHeld) changeOpen = changeHeld = false
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
          description: ev.description,
          canAlwaysAllow: ev.canAlwaysAllow,
          effect: ev.effect,
          agentId: ev.agentId,
          ...(ev.workflowTaskId ? { workflowTaskId: ev.workflowTaskId } : {}),
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
        wfTurns.note(m)
        if (m.type === 'system' && m.task_id) {
          if (m.subtype === 'task_started' && m.task_type === 'local_workflow') workflowTasks.add(m.task_id)
          const used = m.usage?.total_tokens
          if (workflowTasks.has(m.task_id) && typeof used === 'number' && used > (wfTokens.get(m.task_id) ?? 0)) {
            wfTokens.set(m.task_id, used)
            wfSpent = true
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
              // in-process Junior server always wins its name, so a same-named
              // entry from ~/.claude that failed is the status being shown
              // while the working tools are right there in the list.
              mcpTools: (m.tools ?? []).filter((t) => t.startsWith('mcp__')),
            })
          }
        } else if (m.type === 'system' && m.subtype === 'local_command_output') {
          // A command the CLI answers by itself, `/usage`, `/context`. Without
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
            } else if (isToolUseBlock(b) && b.name === WORKFLOW_TOOL) {
              items.push({ key: `c${i}.${j}`, kind: 'workflow', toolUseId: b.id })
            } else if (isToolUseBlock(b) && b.name === HANDBACK_TOOL) {
              // The agent's report: its view shows it as the hand-back card, not as a step.
            } else if (isToolUseBlock(b)) {
              const item = {
                key: `c${i}.${j}`,
                kind: 'tool' as const,
                id: b.id,
                name: b.name,
                input: b.input,
                startedAt: timeOf(ev),
                shell: shellsById.get(b.id),
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
          const blind = costBlind && costSeen === null
          const step = costStep(m, costSeen)
          costSeen = step.seen
          const cost = typeof m.total_cost_usd === 'number' && !blind ? ` · $${step.delta.toFixed(4)}` : ''
          const secs = ((m.duration_ms ?? 0) / 1000).toFixed(1)
          turnSeq += 1
          const hold = wfTurns.holdAtResult()
          changeHeld = changeOpen && hold
          const closes = changeOpen && !changeHeld
          if (closes) changeOpen = false
          const stats = `${secs}s · ${m.num_turns ?? 0} turns${cost}`
          items.push({
            key: `r${i}`,
            kind: 'meta',
            turn: turnSeq,
            text: `— turn done · ${stats} —`,
            stats,
            ms: m.duration_ms ?? undefined,
            ...(wfSpent || wfTurns.running.size > 0 ? { workflowSpend: true } : {}),
            ...(closes && !midway ? { changes: changeSeq } : {}),
          })
          wfSpent = false
        }
        break
      }
    }
  })

  return groupToolRuns(foldArtifacts(items))
}

const OK_CREATED = /^ok: created (\S+) at (.+)$/
const OK_UPDATED = /^ok: updated (.+)$/

/** What a call published, read from its result: the JSON envelope, else the older `ok: …` line, else null. */
function publishedBy(t: ToolItem): ArtifactToolResult | null {
  const text = t.result?.text.trim() ?? ''
  const pub = parseArtifactResult(text)
  if (pub) return pub
  // Logs written before the envelope say `ok: created <id> at <path>` or `ok: updated <path>`:
  // no version, and an update's id is in its input. They were all markdown.
  const made = OK_CREATED.exec(text)
  const edited = made ? null : OK_UPDATED.exec(text)
  const path = made?.[2] ?? edited?.[1]
  const id = made?.[1] ?? (typeof t.input.id === 'string' ? t.input.id : '')
  if (!path || !id) return null
  const title = typeof t.input.title === 'string' && t.input.title ? t.input.title : basename(path)
  return { junior: 'artifact', action: made ? 'created' : 'updated', id, title, format: 'md', version: 0, size: 0, history: true, path, abs: '' }
}

/**
 * Turns each successful write_artifact / update_artifact call into an artifact
 * card. A call still out is a card without `pub` (it may be waiting on your OK); a failed
 * one stays a tool card; a result nothing can read stays one too. Calls on the
 * same id with no message of yours or Junior's between them are one card, its
 * position and key those of the first call, showing the latest.
 */
function foldArtifacts(items: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  const open = new Map<string, { card: ArtifactItem; epoch: number }>()
  // Bumped by anything that breaks a stretch of work apart: prose, a message, a turn's end.
  let epoch = 0
  for (const it of items) {
    if (it.kind === 'assistant' || it.kind === 'user' || it.kind === 'relay' || (it.kind === 'meta' && it.turn)) epoch += 1
    if (it.kind !== 'tool' || !(ARTIFACT_TOOL_NAMES.has(it.name) || HAND_IN_ARTIFACT_TOOLS.has(it.name))) {
      out.push(it)
      continue
    }
    const created = !it.name.endsWith('update_artifact')
    const sent = typeof it.input.body === 'string' ? it.input.body : undefined
    const body = sent === undefined ? undefined : sent.slice(0, ARTIFACT_BODY_KEEP)
    if (!it.result) {
      out.push({ key: it.key, kind: 'artifact', call: it, created, calls: 1, ...(body !== undefined ? { body } : {}) })
      continue
    }
    if (it.result.isError) {
      out.push(it)
      continue
    }
    const pub = publishedBy(it)
    if (!pub) {
      out.push(it)
      continue
    }
    const hit = open.get(pub.id)
    if (hit && hit.epoch === epoch) {
      const card = hit.card
      // An old log's update names no title: keep the one the card already has.
      const untitled = pub.version === 0 && !(typeof it.input.title === 'string' && it.input.title)
      card.call = it
      card.pub = untitled && card.pub ? { ...pub, title: card.pub.title } : pub
      card.calls += 1
      // A later call that sent a file instead leaves the old body stale: the card reads the file's text.
      if (body !== undefined) card.body = body
      else if (typeof it.input.from === 'string') delete card.body
      continue
    }
    const card: ArtifactItem = { key: it.key, kind: 'artifact', call: it, pub, created, calls: 1, ...(body !== undefined ? { body } : {}) }
    open.set(pub.id, { card, epoch })
    out.push(card)
  }
  return out
}

/** Edit-shaped tools stay a card of their own: the diff is the point of them. */
const UNFOLDED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Folds each run of back-to-back tool calls into one `toolGroup`, so the prose
 * between runs is what the eye lands on. Thinking inside a run folds with it;
 * anything else, text, a permission prompt, an edit, ends the run. A run with
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
 * A tool call as one readable line: the tool, what it touched, and, for MCP
 * tools, which server it came from. Bash leads with the `description` the
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
 * How long a set of calls took, first call made to last result back, model
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
