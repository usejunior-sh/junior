import type { WorkflowAgent, WorkflowAgentState, WorkflowRun, WorkflowState } from '../../../../shared/protocol.js'
import { currentPhase } from '../../../../core/workflows/fold.js'

export const STATE_LABEL: Record<WorkflowState | WorkflowAgentState, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
}

const GLYPH: Record<WorkflowAgentState, string> = { queued: '○', running: '', done: '✓', failed: '✕', stopped: '■', interrupted: '–' }

/** A run's or an agent's state: a pulsing dot while it runs, a glyph after. */
export function WfState({ state, label = true }: { state: WorkflowState | WorkflowAgentState; label?: boolean }) {
  return (
    <span className={`wfState ${state}`}>
      {state === 'running' ? <span className="dot live" aria-hidden="true" /> : <span className="wfGlyph" aria-hidden="true">{GLYPH[state]}</span>}
      {label ? STATE_LABEL[state] : <span className="sr-only">{STATE_LABEL[state]}</span>}
    </span>
  )
}

/** A Workflow call the CLI hasn't launched yet: it waits on your OK, or is about to start. */
export const unlaunched = (r: WorkflowRun) => r.state === 'running' && !r.launched

/** What an unlaunched run says instead of "running". */
export const pendingLabel = (r: WorkflowRun) => (r.awaitingOk ? 'Waiting for your OK' : 'Starting…')

/** The quiet line where an unlaunched run's progress will go. */
export const pendingNote = (r: WorkflowRun) => (r.awaitingOk ? 'Nothing runs until you allow it.' : 'The run is about to start.')

/** A run's state, or for an unlaunched one, what it waits on: no pulsing dot, nothing runs yet. */
export function RunState({ run, label = true }: { run: WorkflowRun; label?: boolean }) {
  if (!unlaunched(run)) return <WfState state={run.state} label={label} />
  const text = pendingLabel(run)
  return (
    <span className="wfState queued pending">
      <span className="wfGlyph" aria-hidden="true">{GLYPH.queued}</span>
      {label ? text : <span className="sr-only">{text}</span>}
    </span>
  )
}

export const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k tok` : `${n} tok`)

export const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`)

/** "claude-haiku-5-5" → "haiku"; anything else without its vendor prefix. */
export function modelShort(model: string | undefined): string {
  if (!model) return ''
  return /haiku|sonnet|opus|fable/i.exec(model)?.[0].toLowerCase() ?? model.replace(/^claude-/, '')
}

export const firstLine = (s: string | undefined) => s?.trim().split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? ''

export type PhaseState = 'done' | 'on' | 'todo' | 'failed' | 'stopped'

/**
 * Each phase as a chip: done, the one work is in now, still to come, or ended
 * badly. A phase whose agents all stopped running isn't done unless they
 * returned: it's done when every agent did, or some did and the run went past
 * it (or finished). Otherwise it failed if an agent failed, else it was stopped.
 */
export function phaseStates(r: WorkflowRun): Map<number, PhaseState> {
  const on = r.state === 'running' ? currentPhase(r)?.index : undefined
  const out = new Map<number, PhaseState>()
  for (const p of r.phases) {
    const passed = r.state === 'done' || (on !== undefined && p.index < on)
    const mine = r.agents.filter((a) => a.phaseIndex === p.index)
    let st: PhaseState
    if (p.index === on || mine.some((a) => a.state === 'running')) st = 'on'
    else if (!mine.length) st = passed ? 'done' : 'todo'
    else if (mine.some((a) => a.state === 'queued')) st = 'todo'
    else {
      const ok = mine.filter((a) => a.state === 'done').length
      st = ok === mine.length || (ok > 0 && passed) ? 'done' : mine.some((a) => a.state === 'failed') ? 'failed' : 'stopped'
    }
    out.set(p.index, st)
  }
  return out
}

/** "Phase 2 of 3 · Verify", or null before the script names a phase. */
export function phaseLine(r: WorkflowRun): string | null {
  const p = currentPhase(r)
  if (!p) return null
  const n = r.phases.findIndex((x) => x.index === p.index) + 1
  return `Phase ${n} of ${r.phases.length} · ${p.title}`
}

/** Agents grouped under their phase, in order; agents the script put in no phase come last. */
export function byPhase(r: WorkflowRun): Array<{ key: string; title: string; agents: WorkflowAgent[] }> {
  const groups = r.phases.map((p) => ({ key: `p${p.index}`, title: p.title, agents: r.agents.filter((a) => a.phaseIndex === p.index) }))
  const known = new Set(r.phases.map((p) => p.index))
  const loose = r.agents.filter((a) => a.phaseIndex === undefined || !known.has(a.phaseIndex))
  if (loose.length) groups.push({ key: 'loose', title: r.phases.length ? 'Other agents' : 'Agents', agents: loose })
  return groups
}

/** How long an agent has run, or ran. */
export function agentElapsed(a: WorkflowAgent, now: number): number | undefined {
  if (a.durationMs !== undefined && a.state !== 'running') return a.durationMs
  if (a.startedAt === undefined) return a.durationMs
  if (a.state === 'running') return Math.max(0, now - a.startedAt)
  return a.lastProgressAt !== undefined ? Math.max(0, a.lastProgressAt - a.startedAt) : a.durationMs
}

/** What an agent row says under its label: what it's doing, what went wrong, or what it returned. */
export function agentLine(a: WorkflowAgent): string {
  if (a.state === 'running') return a.activity ?? 'starting…'
  if (a.state === 'failed') return firstLine(a.error) || 'failed'
  if (a.state === 'queued') return 'waiting for a slot'
  return firstLine(a.resultPreview) || STATE_LABEL[a.state]
}
