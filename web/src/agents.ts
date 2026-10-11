/**
 * Folds a session's event log into the subagents it spawned — the agent cards,
 * the dock, the All agents menu and the agent view all read this. Pure and
 * memoisable, like `buildTranscript`.
 *
 * A subagent has no session of its own: it lives inside the main agent's
 * subprocess, and everything it does arrives on the same stream tagged with the
 * id of the tool_use that started it (`parent_tool_use_id`). Its lifecycle comes
 * from `task_*` system messages with task_type 'local_agent' — 'local_bash' is a
 * background shell, not an agent.
 */
import { isToolResultBlock, isToolUseBlock, type RawBlock, type SdkMessage, type SessionEvent } from '../../shared/protocol.js'

export type AgentState = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'

export type AgentRun = {
  /** The tool_use that started it — the key everywhere, and its events' `parent_tool_use_id`. */
  toolUseId: string
  /** The agent's own id (a task_id): what stopTask and SendMessage take. Unknown until it starts. */
  agentId?: string
  /** The agent that spawned this one; null when the main agent did. */
  parentToolUseId: string | null
  /** subagent_type — "Explore", "Plan", "general-purpose", a custom agent, or "skill" for a forked skill */
  type: string
  /** The few words the spawning agent gave it. */
  description: string
  /** The brief it was sent. */
  prompt?: string
  /** Running without the spawning agent waiting on it. */
  background: boolean
  state: AgentState
  startedAt?: number
  endedAt?: number
  /** Run length as the agent counts it — the fallback when a timestamp is missing. */
  durationMs?: number
  tokens?: number
  toolUses: number
  /** What it is doing now: the progress summary, else the CLI's line for its last tool call. */
  activity?: string
  /** What it handed back. */
  report?: string
  error?: string
  /** One of its tool calls is waiting on a permission prompt. */
  waiting: boolean
}

/** The tools that spawn a subagent. Newer CLIs call it Agent, older ones Task. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
/** How a subagent hands its report back — that call is the report, not a step of the work. */
export const HANDBACK_TOOL = 'SubagentHandback'

/** A task_notification whose summary only points elsewhere carries no report of its own. */
const POINTER_SUMMARY = /^This agent's report was delivered to you/

function settled(status: string | undefined): AgentState | null {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'stopped':
    case 'killed':
      return 'stopped'
    default:
      return null
  }
}

const isAgentTask = (m: SdkMessage) => m.task_type === 'local_agent' || (!m.task_type && !!m.subagent_type)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as RawBlock[])
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join('\n')
  }
  return ''
}

/**
 * The report in a finished agent's tool result, without the trailer the CLI
 * adds for the model (its agentId, how to resume it, usage) or the wrapper a
 * forked skill's result comes in.
 */
export function cleanReport(text: string): string {
  return text
    .replace(/^Skill "[^"]*" completed \(forked execution\)\.\s*(Result:\s*)?/, '')
    .replace(/\n*agentId: [\s\S]*$/, '')
    .replace(/\n*<usage>[\s\S]*?<\/usage>\s*$/, '')
    .trim()
}

export function buildAgents(
  events: readonly SessionEvent[],
  timeOf: (ev: SessionEvent) => number | undefined = () => undefined,
): AgentRun[] {
  const runs = new Map<string, AgentRun>()
  const byAgentId = new Map<string, AgentRun>()
  // Every tool call seen so far → which agent made it and which tool it was,
  // so a run first met at its task_started (a forked skill) still knows both.
  const callers = new Map<string, { parent: string | null; name: string }>()
  // Tool calls counted from the stream; task_progress's own count wins when it is higher.
  const counted = new Map<string, number>()
  // Unanswered permission prompts → the agent that asked.
  const asking = new Map<string, string>()

  const ensure = (id: string): AgentRun => {
    let r = runs.get(id)
    if (!r) {
      const caller = callers.get(id)
      r = {
        toolUseId: id,
        parentToolUseId: caller?.parent ?? null,
        type: caller?.name === 'Skill' ? 'skill' : 'general-purpose',
        description: '',
        background: false,
        state: 'running',
        toolUses: 0,
        waiting: false,
      }
      runs.set(id, r)
    }
    return r
  }
  const usage = (r: AgentRun, u: SdkMessage['usage']) => {
    if (!u) return
    if (typeof u.total_tokens === 'number') r.tokens = u.total_tokens
    if (typeof u.tool_uses === 'number') r.toolUses = Math.max(r.toolUses, u.tool_uses)
    if (typeof u.duration_ms === 'number') r.durationMs = u.duration_ms
  }
  const find = (m: SdkMessage) =>
    (m.tool_use_id ? runs.get(m.tool_use_id) : undefined) ?? (m.task_id ? byAgentId.get(m.task_id) : undefined)
  const finish = (r: AgentRun, state: AgentState, at: number | undefined) => {
    r.state = state
    r.endedAt = at ?? r.endedAt
  }

  for (const ev of events) {
    const at = timeOf(ev)
    if (ev.kind === 'permission_request') {
      if (ev.agentId) asking.set(ev.id, ev.agentId)
      continue
    }
    if (ev.kind === 'permission_resolved') {
      asking.delete(ev.id)
      continue
    }
    // A fresh subprocess: nothing the last one was running survived it. (Not
    // the SDK's init — that arrives at the start of every turn, same process.)
    if (ev.kind === 'subprocess') {
      for (const r of runs.values()) if (r.state === 'running') finish(r, 'interrupted', at)
      asking.clear()
      continue
    }
    if (ev.kind !== 'sdk') continue
    const m = ev.message

    if (m.type === 'system') {
      switch (m.subtype) {
        case 'task_started': {
          if (!m.tool_use_id || !isAgentTask(m)) break
          const r = ensure(m.tool_use_id)
          if (m.task_id) {
            r.agentId = m.task_id
            byAgentId.set(m.task_id, r)
          }
          r.type = m.subagent_type || r.type
          r.description = m.description || r.description
          r.prompt = m.prompt || r.prompt
          if (typeof m.is_backgrounded === 'boolean') r.background = m.is_backgrounded
          r.startedAt ??= at
          // Written to after it finished: SendMessage resumes it, and it runs again.
          if (r.state !== 'running') {
            r.state = 'running'
            r.endedAt = undefined
            r.error = undefined
          }
          break
        }
        case 'task_progress': {
          const r = find(m)
          if (!r) break
          usage(r, m.usage)
          r.activity = m.summary || m.description || r.activity
          break
        }
        case 'task_updated': {
          const r = m.task_id ? byAgentId.get(m.task_id) : undefined
          if (!r || !m.patch) break
          if (typeof m.patch.is_backgrounded === 'boolean') r.background = m.patch.is_backgrounded
          if (m.patch.error) r.error = m.patch.error
          const s = settled(m.patch.status)
          if (s && r.state === 'running') finish(r, s, at)
          break
        }
        case 'task_notification': {
          const r = find(m)
          if (!r) break
          usage(r, m.usage)
          const s = settled(m.status)
          if (s) finish(r, s, at)
          const handback = m.handback_report?.text?.trim()
          if (handback) r.report = handback
          else if (!r.report && m.summary && !POINTER_SUMMARY.test(m.summary) && m.summary !== r.description) r.report = m.summary
          break
        }
      }
      continue
    }

    if (m.type !== 'assistant' && m.type !== 'user') continue
    const parent = m.parent_tool_use_id ?? null
    const inside = parent ? runs.get(parent) : undefined
    for (const b of m.message?.content ?? []) {
      if (m.type === 'assistant' && isToolUseBlock(b)) {
        callers.set(b.id, { parent, name: b.name })
        if (AGENT_TOOLS.has(b.name)) {
          const r = ensure(b.id)
          r.type = str(b.input.subagent_type) || r.type
          r.description = str(b.input.description) || r.description
          r.prompt = str(b.input.prompt) || r.prompt
          if (b.input.run_in_background === true) r.background = true
          r.startedAt ??= at
        }
        if (inside) {
          if (b.name === HANDBACK_TOOL) {
            const text = str(b.input.message).trim()
            if (text) inside.report = text
          } else {
            const n = (counted.get(inside.toolUseId) ?? 0) + 1
            counted.set(inside.toolUseId, n)
            inside.toolUses = Math.max(inside.toolUses, n)
          }
        }
      } else if (m.type === 'user' && isToolResultBlock(b)) {
        const r = runs.get(b.tool_use_id)
        if (!r) continue
        const text = resultText(b.content)
        const id = /agentId: ([\w-]+)/.exec(text)?.[1]
        if (id && !r.agentId) {
          r.agentId = id
          byAgentId.set(id, r)
        }
        // A background agent's tool result is only its launch receipt; it ends later, by notification.
        if (/^Async agent launched/.test(text)) {
          r.background = true
          continue
        }
        if (b.is_error === true) {
          r.error = r.error ?? cleanReport(text)
          if (r.state === 'running') finish(r, 'failed', at)
        } else {
          if (!r.report) r.report = cleanReport(text) || undefined
          if (r.state === 'running') finish(r, 'done', at)
        }
      }
    }
  }

  for (const agentId of asking.values()) {
    const r = byAgentId.get(agentId)
    if (r) r.waiting = true
  }
  return [...runs.values()]
}

/** What to call an agent in one line: the words it was given, else its type. */
export const agentLabel = (r: AgentRun): string => r.description || r.type

/** The agents above this one, outermost first — the breadcrumb between Main and it. */
export function agentAncestors(runs: readonly AgentRun[], r: AgentRun): AgentRun[] {
  const out: AgentRun[] = []
  const seen = new Set<string>()
  let p = r.parentToolUseId
  while (p && !seen.has(p)) {
    seen.add(p)
    const up = runs.find((x) => x.toolUseId === p)
    if (!up) break
    out.unshift(up)
    p = up.parentToolUseId
  }
  return out
}

/** How long it ran, or has been running. */
export function agentElapsedMs(r: AgentRun, now: number): number | undefined {
  if (r.startedAt === undefined) return r.durationMs
  if (r.endedAt !== undefined) return r.endedAt - r.startedAt
  if (r.state === 'running') return now - r.startedAt
  return r.durationMs
}

/** Who started it, in words: "main", or the agent that spawned it. */
export function spawnerOf(runs: readonly AgentRun[], r: AgentRun): string {
  const up = r.parentToolUseId ? runs.find((x) => x.toolUseId === r.parentToolUseId) : undefined
  return up ? agentLabel(up) : 'main'
}
