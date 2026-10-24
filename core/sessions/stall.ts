/**
 * A stall watchdog for chat turns. Job runs have one (server/jobs/queue.ts);
 * a chat turn that hangs used to sit there forever with no signal.
 *
 * Pure: every function takes the time as an argument. `stallVerdict` says
 * whether one open turn is ok, slow or stalled, from how long it has been
 * quiet and what it is waiting on. `TurnWatch` folds a turn's events into
 * the inputs and decides when to say so, once per turn. LiveSession owns the
 * timer and the transcript notice. Nothing here ever stops a subprocess: a
 * stalled turn is the user's call.
 */
import { humanSpan } from '../job/schedule.js'
import type { SdkMessage } from '../../shared/protocol.js'

export type StallState = 'ok' | 'slow' | 'stalled'

/** A tool call the agent made whose result hasn't come back yet. */
export type RunningTool = { id: string; name: string; input?: unknown; since: number }

export type StallInput = {
  /** when the turn last heard anything from the agent (any SDK message, stream deltas included) */
  lastEventAt: number
  now: number
  /** tool calls still out, oldest first */
  tools: readonly RunningTool[]
  /** a permission prompt or question is waiting on the user: the ball is theirs, never a stall */
  waitingOnUser?: boolean
  /** of the quiet time, how much the Mac spent asleep (server/power.ts sleepWatch) */
  sleptMs?: number
}

export type StallVerdict = {
  state: StallState
  /** quiet time, minus sleep */
  quietMs: number
  /** quiet past this is stalled */
  boundMs: number
  /** the tool the bound came from, when one is running */
  tool?: string
}

/** How often LiveSession checks an open turn. */
export const STALL_TICK_MS = 30_000
/** No tool out: the model is thinking or writing, and streams as it goes. */
export const THINKING_BOUND_MS = 5 * 60_000
/** A tool out, of no known kind: Bash's own default timeout is 2 min, its max 10. */
export const TOOL_BOUND_MS = 10 * 60_000
/** Tools that wait on purpose: a subagent, a Workflow run, a monitor, a wait. */
export const LONG_TOOL_BOUND_MS = 30 * 60_000
/** Past its own timeout, how long a tool may take to come back. */
export const TIMEOUT_GRACE_MS = 2 * 60_000
/** No bound is ever longer than this, whatever a tool's input asks for. */
export const MAX_BOUND_MS = 2 * 3_600_000

/** Tools that are expected to be quiet for a long time. */
const LONG_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'Monitor', 'TaskOutput', 'BashOutput', 'AgentOutputTool'])

/** An MCP tool whose name says it waits (`mcp__x__wait_for`, `…__await_run`, `…__sleep`). */
const waitsByName = (name: string): boolean => {
  if (!name.startsWith('mcp__')) return false
  const last = name.split('__').pop() ?? ''
  return /(^|_)(wait|await|sleep|poll)(_|$)/i.test(last) || /^wait/i.test(last)
}

/** A timeout the tool's own input asks for, in ms. Bash, Monitor and most wait tools take `timeout` in ms. */
const inputTimeoutMs = (input: unknown): number | null => {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const key of ['timeout', 'timeout_ms', 'timeoutMs']) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return null
}

/** How long one tool may be quiet before its turn counts as stalled. */
export function toolBoundMs(tool: Pick<RunningTool, 'name' | 'input'>): number {
  const base = LONG_TOOLS.has(tool.name) || waitsByName(tool.name) ? LONG_TOOL_BOUND_MS : TOOL_BOUND_MS
  const asked = inputTimeoutMs(tool.input)
  const fromInput = asked == null ? 0 : asked + TIMEOUT_GRACE_MS
  return Math.min(MAX_BOUND_MS, Math.max(base, fromInput))
}

/**
 * Is this open turn ok, slow or stalled? Slow is past half its bound, stalled
 * is past the bound. With several tools out (parallel calls), the most
 * patient one sets the bound: the turn waits for all of them.
 */
export function stallVerdict(i: StallInput): StallVerdict {
  const quietMs = Math.max(0, i.now - i.lastEventAt - Math.max(0, i.sleptMs ?? 0))
  let boundMs = THINKING_BOUND_MS
  let tool: string | undefined
  for (const t of i.tools) {
    const b = toolBoundMs(t)
    if (tool === undefined || b > boundMs) {
      boundMs = b
      tool = t.name
    }
  }
  const state: StallState = i.waitingOnUser ? 'ok' : quietMs > boundMs ? 'stalled' : quietMs > boundMs / 2 ? 'slow' : 'ok'
  return { state, quietMs, boundMs, ...(tool ? { tool } : {}) }
}

/** The transcript line for a stalled turn. Says what it waits on, and that nothing was stopped. */
export function stallNotice(v: StallVerdict): string {
  const span = humanSpan(v.quietMs)
  return v.tool
    ? `Junior has waited on ${v.tool} for ${span} with no word back. It may be stuck. Press Stop to end the turn, or keep waiting.`
    : `No word from Junior for ${span}. It may be stuck. Press Stop to end the turn, or keep waiting.`
}

/** The tool_use ids a message's tool_result blocks answer. */
export function toolResultIds(m: SdkMessage): string[] {
  const content = m.message?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const b of content) if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(b.tool_use_id)
  return ids
}

/**
 * One session's watch over its open turn. Fed by the event pump, asked by a
 * timer. `check` says `notify` at most once per turn, the first time the turn
 * is stalled; a turn that wakes up and stalls again doesn't say it twice.
 */
export class TurnWatch {
  private openSince: number | null = null
  private lastEventAt = 0
  private readonly tools = new Map<string, RunningTool>()
  private noticed = false

  get open(): boolean {
    return this.openSince !== null
  }

  /** When the open turn last heard from the agent (or from the user, after a prompt). */
  get lastHeardAt(): number {
    return this.lastEventAt
  }

  /** A turn opened. A turn already open stays the same turn (the user sent again mid-turn). */
  begin(now: number): void {
    if (this.openSince !== null) return
    this.openSince = now
    this.lastEventAt = now
    this.tools.clear()
    this.noticed = false
  }

  /** Anything heard from the agent. Tool calls start their clock; tool results stop it. */
  heard(now: number, ev?: { toolCalls?: readonly { id: string; name: string; input?: unknown }[]; record?: SdkMessage }): void {
    this.lastEventAt = Math.max(this.lastEventAt, now)
    for (const c of ev?.toolCalls ?? []) this.tools.set(c.id, { id: c.id, name: c.name, input: c.input, since: now })
    if (ev?.record) for (const id of toolResultIds(ev.record)) this.tools.delete(id)
  }

  /** The turn ended (a result, or the subprocess went). */
  end(): void {
    this.openSince = null
    this.tools.clear()
  }

  /** Where the open turn stands, and whether to tell the user now. A closed turn is always ok. */
  check(now: number, opts: { waitingOnUser?: boolean; sleptMs?: number } = {}): { verdict: StallVerdict; notify: boolean } {
    if (this.openSince === null) return { verdict: { state: 'ok', quietMs: 0, boundMs: THINKING_BOUND_MS }, notify: false }
    // While a prompt waits on the user the clock doesn't run: it starts again when they answer.
    if (opts.waitingOnUser) this.lastEventAt = Math.max(this.lastEventAt, now)
    const verdict = stallVerdict({ lastEventAt: this.lastEventAt, now, tools: [...this.tools.values()], ...opts })
    const notify = verdict.state === 'stalled' && !this.noticed
    if (notify) this.noticed = true
    return { verdict, notify }
  }
}
