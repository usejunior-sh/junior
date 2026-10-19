/**
 * Folds a session's event log into the Ultracode workflows it ran. The
 * transcript's workflow card, the dock, the run panel and the server's
 * running-work count all read this. Pure and memoisable, like `buildShells`.
 *
 * A Workflow call answers straight away with a receipt (`tool_use_result`
 * status 'async_launched', carrying the run id and where its files are), and
 * the run goes on in the background as a 'local_workflow' task. Every few
 * task_progress frames carry `workflow_progress`, a full snapshot of the run's
 * phases and agents, so the latest one is the run's state. task_updated /
 * task_notification say how it ended.
 */
import {
  isToolResultBlock,
  isToolUseBlock,
  type RawBlock,
  type SdkMessage,
  type SessionEvent,
  type WorkflowAgent,
  type WorkflowAgentState,
  type WorkflowProgressEntry,
  type WorkflowRun,
  type WorkflowState,
} from '../../shared/protocol.js'

export const WORKFLOW_TOOL = 'Workflow'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A task status as a run's end state; null while it still runs. */
export function settled(status: string | undefined): WorkflowState | null {
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

export function agentState(state: string | undefined, startedAt: number | undefined): WorkflowAgentState {
  switch (state) {
    // The CLI says 'start' from the moment it queues an agent: only a start time says it got a slot.
    case 'start':
    case 'started':
      return startedAt ? 'running' : 'queued'
    case 'running':
    case 'progress':
      return 'running'
    case 'done':
    case 'completed':
    case 'cached':
      return 'done'
    case 'error':
    case 'failed':
      return 'failed'
    case 'skipped':
    case 'stopped':
    case 'killed':
    case 'aborted':
      return 'stopped'
    case 'queued':
    case 'pending':
      return 'queued'
    default:
      return startedAt ? 'running' : 'queued'
  }
}

/** meta.name / meta.description out of a script, for the card before the CLI names the run. */
export function scriptMeta(script: string): { name?: string; description?: string } {
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? script.slice(0, 2000)
  const field = (k: string) => new RegExp(`\\b${k}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(meta)?.[2]
  return { name: field('name'), description: field('description') }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as RawBlock[]).map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n')
  }
  return ''
}

type Receipt = { taskId?: string; runId?: string; workflowName?: string; summary?: string; transcriptDir?: string; scriptPath?: string; sessionUrl?: string }

/** A launch receipt: a local run ('async_launched'), or one sent to a cloud session ('remote_launched'). */
function receiptOf(m: SdkMessage): Receipt | null {
  const r = m.tool_use_result
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  if (o.status === 'remote_launched') return { taskId: str(o.taskId) || undefined, workflowName: str(o.workflowName) || undefined, summary: str(o.summary) || undefined, sessionUrl: str(o.sessionUrl) || undefined }
  if (o.status !== 'async_launched' || (o.taskType !== undefined && o.taskType !== 'local_workflow')) return null
  return {
    taskId: str(o.taskId) || undefined,
    runId: str(o.runId) || undefined,
    workflowName: str(o.workflowName) || undefined,
    summary: str(o.summary) || undefined,
    transcriptDir: str(o.transcriptDir) || undefined,
    scriptPath: str(o.scriptPath) || undefined,
  }
}

/** The receipt as text, for CLIs that send no structured result. */
function receiptFromText(text: string): Receipt | null {
  if (!/^Workflow launched in background/.test(text)) return null
  const line = (k: string) => new RegExp(`^${k}: (.+)$`, 'm').exec(text)?.[1]?.trim()
  // The task id rides on the first line: "Workflow launched in background. Task ID: <id>".
  return { taskId: /\bTask ID: (\S+)/.exec(text)?.[1], runId: line('Run ID'), summary: line('Summary'), transcriptDir: line('Transcript dir'), scriptPath: line('Script file') }
}

function agentsOf(snapshot: WorkflowProgressEntry[], prev: WorkflowAgent[]): { phases: WorkflowRun['phases']; agents: WorkflowAgent[] } {
  const phases: WorkflowRun['phases'] = []
  const agents: WorkflowAgent[] = []
  const before = new Map(prev.map((a) => [a.index, a]))
  for (const e of snapshot) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'workflow_phase') {
      phases.push({ index: e.index, title: str(e.title), ...(e.detail ? { detail: e.detail } : {}) })
    } else if (e.type === 'workflow_agent') {
      const old = before.get(e.index)
      const tool = str(e.lastToolName)
      const what = str(e.lastToolSummary)
      agents.push({
        index: e.index,
        label: str(e.label) || old?.label || `agent ${e.index}`,
        phaseIndex: num(e.phaseIndex),
        phase: str(e.phaseTitle) || undefined,
        agentId: str(e.agentId) || old?.agentId,
        model: str(e.model) || old?.model,
        state: agentState(e.state, num(e.startedAt)),
        queuedAt: num(e.queuedAt),
        startedAt: num(e.startedAt),
        lastProgressAt: num(e.lastProgressAt),
        attempt: num(e.attempt),
        tokens: num(e.tokens),
        toolCalls: num(e.toolCalls),
        durationMs: num(e.durationMs),
        promptPreview: str(e.promptPreview) || old?.promptPreview,
        resultPreview: str(e.resultPreview) || undefined,
        activity: tool && what ? `${tool} · ${what}` : what || undefined,
        error: str(e.error) || undefined,
      })
    }
  }
  return { phases, agents }
}

/** One `workflow_progress` snapshot on its own: what a run's state file keeps as `workflowProgress`. */
export const progressSnapshot = (snapshot: WorkflowProgressEntry[]) => agentsOf(snapshot, [])

export function buildWorkflows(
  events: readonly SessionEvent[],
  timeOf: (ev: SessionEvent) => number | undefined = () => undefined,
): WorkflowRun[] {
  const runs = new Map<string, WorkflowRun>()
  const byTaskId = new Map<string, WorkflowRun>()

  const bind = (r: WorkflowRun, taskId: string | undefined) => {
    if (!taskId) return
    r.taskId = taskId
    byTaskId.set(taskId, r)
  }
  const finish = (r: WorkflowRun, state: WorkflowState, at: number | undefined) => {
    r.state = state
    r.endedAt = at ?? r.endedAt
    delete r.awaitingOk
    // An agent can't outlive its run: whatever was still going ended with it.
    const left: WorkflowAgentState = state === 'interrupted' ? 'interrupted' : 'stopped'
    for (const a of r.agents) if (a.state === 'running' || a.state === 'queued') a.state = left
  }
  // The CLI registered the run: it is going now, not waiting on a prompt. Its clock starts here.
  const launch = (r: WorkflowRun, at: number | undefined) => {
    if (r.launched) return
    r.launched = true
    r.startedAt = at ?? r.startedAt
    delete r.awaitingOk
  }
  // Permission prompts not yet answered: prompt id → the tool_use it asks about.
  const pending = new Map<string, string>()
  const asking = (toolUseId: string) => [...pending.values()].includes(toolUseId)
  const find = (m: SdkMessage) => (m.task_id ? byTaskId.get(m.task_id) : undefined) ?? (m.tool_use_id ? runs.get(m.tool_use_id) : undefined)

  for (const ev of events) {
    const at = timeOf(ev)
    // A fresh subprocess: no run the last one started survived it.
    if (ev.kind === 'subprocess') {
      for (const r of runs.values()) if (r.state === 'running') finish(r, 'interrupted', at)
      continue
    }
    if (ev.kind === 'permission_request') {
      // Older logs carry no toolUseId: a main-agent Workflow prompt can only be about the newest unlaunched run.
      const target = ev.toolUseId ?? (ev.toolName === WORKFLOW_TOOL && !ev.agentId ? [...runs.values()].reverse().find((r) => !r.launched && r.state === 'running')?.toolUseId : undefined)
      if (!target) continue
      pending.set(ev.id, target)
      const r = runs.get(target)
      if (r && !r.launched && r.state === 'running') r.awaitingOk = true
      continue
    }
    if (ev.kind === 'permission_resolved') {
      const target = pending.get(ev.id)
      if (!pending.delete(ev.id) || asking(target!)) continue
      const r = runs.get(target!)
      if (r) delete r.awaitingOk
      continue
    }
    if (ev.kind !== 'sdk') continue
    const m = ev.message

    if (m.type === 'system') {
      switch (m.subtype) {
        case 'task_started': {
          if (m.task_type !== 'local_workflow') break
          const r = (m.tool_use_id ? runs.get(m.tool_use_id) : undefined) ?? (m.task_id ? byTaskId.get(m.task_id) : undefined)
          if (!r) break
          bind(r, m.task_id)
          launch(r, at)
          r.name = m.workflow_name || r.name
          r.summary = m.description || r.summary
          break
        }
        case 'task_progress': {
          const r = find(m)
          if (!r) break
          if (Array.isArray(m.workflow_progress)) Object.assign(r, agentsOf(m.workflow_progress, r.agents))
          const u = m.usage
          if (u) {
            r.tokens = Math.max(r.tokens, u.total_tokens ?? 0)
            r.toolUses = Math.max(r.toolUses, u.tool_uses ?? 0)
            r.durationMs = u.duration_ms ?? r.durationMs
          }
          break
        }
        case 'task_updated': {
          const r = m.task_id ? byTaskId.get(m.task_id) : undefined
          if (!r || !m.patch) break
          if (m.patch.error) r.error = m.patch.error
          const s = settled(m.patch.status)
          if (s && r.state === 'running') finish(r, s, num(m.patch.end_time) ?? at)
          break
        }
        case 'task_notification': {
          const r = find(m)
          if (!r) break
          const u = m.usage
          if (u) {
            r.tokens = Math.max(r.tokens, u.total_tokens ?? 0)
            r.toolUses = Math.max(r.toolUses, u.tool_uses ?? 0)
            r.durationMs = u.duration_ms ?? r.durationMs
          }
          const s = settled(m.status)
          if (s === 'failed' && m.summary) r.error = r.error ?? m.summary
          if (s && r.state === 'running') finish(r, s, at)
          break
        }
      }
      continue
    }

    if (m.type !== 'assistant' && m.type !== 'user') continue
    for (const b of m.message?.content ?? []) {
      if (m.type === 'assistant' && isToolUseBlock(b)) {
        if (b.name !== WORKFLOW_TOOL || runs.has(b.id)) continue
        const meta = scriptMeta(str(b.input.script))
        runs.set(b.id, {
          toolUseId: b.id,
          name: meta.name || str(b.input.name) || 'workflow',
          summary: meta.description || '',
          parentToolUseId: m.parent_tool_use_id ?? null,
          state: 'running',
          launched: false,
          ...(at !== undefined ? { requestedAt: at } : {}),
          phases: [],
          agents: [],
          tokens: 0,
          toolUses: 0,
          ...(str(b.input.scriptPath) ? { scriptPath: str(b.input.scriptPath) } : {}),
          // The prompt can land in the log before the call it asks about.
          ...(asking(b.id) ? { awaitingOk: true } : {}),
        })
      } else if (m.type === 'user' && isToolResultBlock(b)) {
        const r = runs.get(b.tool_use_id)
        if (!r || r.taskId && r.runId) continue
        const text = resultText(b.content)
        const receipt = receiptOf(m) ?? receiptFromText(text)
        if (receipt && b.is_error !== true) {
          bind(r, receipt.taskId)
          launch(r, at)
          r.runId = receipt.runId ?? r.runId
          r.name = receipt.workflowName || r.name
          r.summary = receipt.summary || r.summary
          r.transcriptDir = receipt.transcriptDir ?? r.transcriptDir
          r.scriptPath = receipt.scriptPath ?? r.scriptPath
          if (receipt.sessionUrl) r.sessionUrl = receipt.sessionUrl
          continue
        }
        // No receipt: the launch was refused (a denied prompt, a script error) and nothing runs.
        if (r.state === 'running' && !r.taskId) {
          delete r.awaitingOk
          r.state = 'failed'
          r.endedAt = at
          r.error = text.trim().slice(0, 2000) || 'The workflow did not start.'
        }
      }
    }
  }
  return [...runs.values()]
}

/** Runs still going. */
export const runningWorkflows = (runs: readonly WorkflowRun[]) => runs.filter((r) => r.state === 'running')

/**
 * How long a run has gone on, or went on, from when the CLI launched it (the
 * wait on a permission prompt doesn't count). A settled run takes the CLI's
 * own duration when it sent one. Undefined for a run that never launched.
 */
export function workflowElapsedMs(r: WorkflowRun, now: number): number | undefined {
  if (r.state !== 'running' && r.durationMs !== undefined) return r.durationMs
  if (r.startedAt === undefined) return r.durationMs
  if (r.endedAt !== undefined) return Math.max(0, r.endedAt - r.startedAt)
  return r.state === 'running' ? Math.max(0, now - r.startedAt) : r.durationMs
}

/** Agents by state, for "3 of 7 done". */
export function agentCounts(r: WorkflowRun): Record<WorkflowAgentState, number> & { total: number } {
  const c = { queued: 0, running: 0, done: 0, failed: 0, stopped: 0, interrupted: 0, total: r.agents.length }
  for (const a of r.agents) c[a.state] += 1
  return c
}

/** The phase work is happening in now: the last phase with a running agent, else the last one started. */
export function currentPhase(r: WorkflowRun): WorkflowRun['phases'][number] | undefined {
  const running = r.agents.filter((a) => a.state === 'running' && a.phaseIndex !== undefined)
  const idx = running.length ? Math.max(...running.map((a) => a.phaseIndex!)) : Math.max(0, ...r.agents.map((a) => a.phaseIndex ?? 0))
  return r.phases.find((p) => p.index === idx) ?? r.phases[r.phases.length - 1]
}

/** meta.phases out of a script (title + detail), for the approval card before anything runs. */
export function scriptPhases(script: string): Array<{ title: string; detail?: string }> {
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? script.slice(0, 4000)
  const start = /\bphases\s*:\s*\[/.exec(meta)
  if (!start) return []
  // The array's text up to its closing bracket, skipping brackets inside strings.
  let depth = 1
  let quote = ''
  let end = -1
  for (let i = start.index + start[0].length; i < meta.length && end < 0; i++) {
    const c = meta[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) end = i
  }
  if (end < 0) return []
  const body = meta.slice(start.index + start[0].length, end)
  const field = (src: string, k: string) => new RegExp(`\\b${k}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(src)?.[2]
  const out: Array<{ title: string; detail?: string }> = []
  for (const m of body.matchAll(/\{((?:[^{}'"`]|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)*)\}/g)) {
    const title = field(m[1], 'title')
    if (!title) continue
    const detail = field(m[1], 'detail')
    out.push(detail ? { title, detail } : { title })
  }
  return out
}
