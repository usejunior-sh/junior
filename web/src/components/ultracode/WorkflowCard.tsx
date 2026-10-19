import { Workflow } from 'lucide-react'
import type { WorkflowRun } from '../../../../shared/protocol.js'
import { agentCounts, workflowElapsedMs } from '../../../../core/workflows/fold.js'
import { useMergedRun } from '../../app/useWorkflows.js'
import { formatDuration } from '../../transcript.js'
import { useNow } from '../Agents.js'
import { RunState, money, pendingNote, phaseStates, tok, unlaunched } from './shared.js'

/** The phases as a chip chain: done ✓, the one work is in now, still to come. */
export function PhaseChips({ run }: { run: WorkflowRun }) {
  if (!run.phases.length) return null
  const states = phaseStates(run)
  return (
    <span className="wfPhases">
      {run.phases.map((p, i) => {
        const st = states.get(p.index) ?? 'todo'
        return (
          <span key={p.index} className="wfPhaseWrap">
            {i > 0 && <span className="wfArrow" aria-hidden="true">→</span>}
            <span className={`wfPhase ${st}`} title={p.detail}>
              {st === 'done' && <span className="wfTick" aria-hidden="true">✓</span>}
              {st === 'failed' && <span className="wfCross" aria-hidden="true">✕</span>}
              {st === 'stopped' && <span className="wfHalt" aria-hidden="true">■</span>}
              {st === 'on' && <span className="dot live sm" aria-hidden="true" />}
              {p.title}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/** "5 of 9 agents done · 1 failed", over a bar that fills as they finish. */
export function AgentProgress({ run }: { run: WorkflowRun }) {
  const c = agentCounts(run)
  if (!c.total) return null
  const ended = c.done + c.failed + c.stopped + c.interrupted
  const extra = [c.failed ? `${c.failed} failed` : '', c.running ? `${c.running} running` : '', c.stopped + c.interrupted ? `${c.stopped + c.interrupted} stopped` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="wfProgress">
      <span className="wfBar" role="progressbar" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={ended} aria-label="Agents finished">
        <span className="ok" style={{ width: `${(c.done / c.total) * 100}%` }} />
        <span className="bad" style={{ width: `${(c.failed / c.total) * 100}%` }} />
      </span>
      <span className="wfCount">
        {c.done} of {c.total} agents done{extra ? ` · ${extra}` : ''}
      </span>
    </span>
  )
}

/**
 * The card a Workflow call becomes in the transcript: the run's name, its
 * state and clock, its phases, how many agents are done, and what it cost.
 * The whole card opens the run panel.
 */
export function WorkflowCard({ sessionId, run: live, onOpen }: { sessionId: string; run: WorkflowRun | undefined; onOpen?: (toolUseId: string) => void }) {
  const { run, detail } = useMergedRun(sessionId, live)
  const now = useNow(!!run && run.state === 'running' && run.launched)
  if (!run) return null
  const refused = run.state === 'failed' && !run.taskId
  const waiting = unlaunched(run)
  const ms = waiting ? undefined : workflowElapsedMs(run, now)
  const nums = [run.tokens ? tok(run.tokens) : '', detail && (detail.costUsd > 0 || run.state !== 'running') ? money(detail.costUsd) : ''].filter(Boolean).join(' · ')
  return (
    <button type="button" className={`wfCard ${run.state}`} onClick={() => onOpen?.(run.toolUseId)} disabled={!onOpen} title={onOpen ? 'Open the run' : undefined}>
      <span className="wfRow">
        <Workflow size={13} className="wfMark" aria-hidden="true" />
        <span className="wfName">{run.name}</span>
        <span className="wfSum">{run.summary}</span>
        <span className="wfEnd">
          <RunState run={run} />
          {ms !== undefined && <span className="wfNums">{formatDuration(ms)}</span>}
        </span>
      </span>
      {refused ? (
        <span className="wfErr">The workflow didn’t start. {run.error}</span>
      ) : waiting ? (
        <span className="wfFoot">
          <span className="wfCount">{pendingNote(run)}</span>
        </span>
      ) : (
        <>
          <PhaseChips run={run} />
          <span className="wfFoot">
            <AgentProgress run={run} />
            {nums && <span className="wfNums">{nums}</span>}
          </span>
          {run.state === 'failed' && run.error && <span className="wfErr">{run.error}</span>}
        </>
      )}
    </button>
  )
}
