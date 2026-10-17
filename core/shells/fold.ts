/**
 * Folds a session's event log into the shell commands it ran. The Bash pill's
 * clock and the dock's background rows read this. Pure and memoisable, like
 * `buildAgents`.
 *
 * A Bash call that runs for more than a moment becomes a task: `task_started`
 * with task_type 'local_bash' and the call's tool_use id, then `task_updated` /
 * `task_notification` until it settles. A background one (`run_in_background`,
 * a timeout, or moved there mid-run) answers its tool_use straight away with a
 * receipt, so the call looks finished while the shell keeps going, and only
 * the notification says how it ended. The CLI doesn't stream a shell's output
 * to us; a background shell writes it to `outputFile`.
 */
import { isToolResultBlock, isToolUseBlock, type SdkMessage, type SessionEvent } from '../../shared/protocol.js'

export type ShellState = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'

export type ShellRun = {
  /** The Bash call that started it. */
  toolUseId: string
  /** The task id: what stopTask takes. Unknown until the shell becomes a task. */
  taskId?: string
  /** The agent whose call it was; null for the main agent. */
  parentToolUseId: string | null
  description: string
  command: string
  /** The call has returned and the shell runs on without anyone waiting. */
  background: boolean
  state: ShellState
  startedAt?: number
  endedAt?: number
  exitCode?: number
  /** Where a background shell writes its output. */
  outputFile?: string
}

/**
 * The tool_result a background shell answers its call with. A receipt, not
 * its output. Only believed when its ID is the task the CLI started for that
 * call: a foreground command can print this text too.
 */
const RECEIPT =
  /^Command (?:running in background with ID: |did not complete within its \S+ timeout and was moved to the background \(ID: )([\w-]+)/
const OUTPUT_AT = /Output is being written to: (\S+?\/tasks\/([\w-]+)\.output)\b/

function settled(status: string | undefined): ShellState | null {
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

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && c.type === 'text' ? str(c.text) : '')).join('\n')
  return ''
}

export function buildShells(
  events: readonly SessionEvent[],
  timeOf: (ev: SessionEvent) => number | undefined = () => undefined,
): ShellRun[] {
  const runs = new Map<string, ShellRun>()
  const byTaskId = new Map<string, ShellRun>()

  const finish = (r: ShellRun, state: ShellState, at: number | undefined) => {
    r.state = state
    r.endedAt = at ?? r.endedAt
  }
  const find = (m: SdkMessage) => (m.tool_use_id ? runs.get(m.tool_use_id) : undefined) ?? (m.task_id ? byTaskId.get(m.task_id) : undefined)

  for (const ev of events) {
    const at = timeOf(ev)
    // A fresh subprocess: no shell the last one started survived it.
    if (ev.kind === 'subprocess') {
      for (const r of runs.values()) if (r.state === 'running') finish(r, 'interrupted', at)
      continue
    }
    if (ev.kind !== 'sdk') continue
    const m = ev.message

    if (m.type === 'system') {
      switch (m.subtype) {
        case 'task_started': {
          if (m.task_type !== 'local_bash' || !m.tool_use_id) break
          const r = runs.get(m.tool_use_id)
          if (!r) break
          if (m.task_id) {
            r.taskId = m.task_id
            byTaskId.set(m.task_id, r)
          }
          r.description = m.description || r.description
          if (m.is_backgrounded === true) r.background = true
          break
        }
        case 'task_updated': {
          const r = m.task_id ? byTaskId.get(m.task_id) : undefined
          if (!r || !m.patch) break
          if (m.patch.is_backgrounded === true) r.background = true
          const s = settled(m.patch.status)
          if (s && r.state === 'running') finish(r, s, at)
          break
        }
        case 'task_notification': {
          const r = find(m)
          if (!r) break
          if (m.output_file && outputOf(m.output_file, r.taskId)) r.outputFile = m.output_file
          const code = /exit code (-?\d+)/.exec(str(m.summary))?.[1]
          if (code !== undefined) r.exitCode = Number(code)
          const s = settled(m.status)
          if (s && r.state === 'running') finish(r, s, at)
          break
        }
      }
      continue
    }

    if (m.type !== 'assistant' && m.type !== 'user') continue
    for (const b of m.message?.content ?? []) {
      if (m.type === 'assistant' && isToolUseBlock(b)) {
        if (b.name !== 'Bash') continue
        runs.set(b.id, {
          toolUseId: b.id,
          parentToolUseId: m.parent_tool_use_id ?? null,
          description: str(b.input.description),
          command: str(b.input.command),
          background: b.input.run_in_background === true,
          state: 'running',
          startedAt: at,
        })
      } else if (m.type === 'user' && isToolResultBlock(b)) {
        const r = runs.get(b.tool_use_id)
        if (!r || r.state !== 'running') continue
        const text = resultText(b.content)
        const receipt = RECEIPT.exec(text)?.[1]
        if (receipt && receipt === r.taskId) {
          r.background = true
          const out = OUTPUT_AT.exec(text)
          if (out && out[2] === r.taskId) r.outputFile = out[1]
          continue
        }
        // A foreground call's result is the end of it; its notification may follow and changes nothing.
        finish(r, b.is_error === true ? 'failed' : 'done', at)
      }
    }
  }
  return [...runs.values()]
}

/** A shell's output file, if `path` is where task `taskId` would write one. */
function outputOf(path: string, taskId: string | undefined): boolean {
  return !!taskId && path.startsWith('/') && !path.includes('/../') && path.endsWith(`/tasks/${taskId}.output`)
}

/** How long it ran, or has been running. */
export function shellElapsedMs(r: ShellRun, now: number): number | undefined {
  if (r.startedAt === undefined) return undefined
  if (r.endedAt !== undefined) return r.endedAt - r.startedAt
  return r.state === 'running' ? now - r.startedAt : undefined
}

/** What to call a shell in one line: the description the model gave it, else its command. */
export const shellLabel = (r: ShellRun): string => r.description || r.command
