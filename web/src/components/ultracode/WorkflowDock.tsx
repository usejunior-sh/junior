import { Square } from 'lucide-react'
import type { WorkflowRun } from '../../../../shared/protocol.js'
import { agentCounts, workflowElapsedMs } from '../../../../core/workflows/fold.js'
import { formatDuration } from '../../transcript.js'
import { useNow } from '../Agents.js'
import { phaseLine } from './shared.js'

/**
 * Above the composer while a run is going: the Workflow call returned at once
 * and the turn that made it may be long over, so this says the work goes on.
 */
export function WorkflowDock({
  workflows,
  onDetails,
  onStop,
}: {
  workflows: readonly WorkflowRun[]
  onDetails: (toolUseId: string) => void
  onStop: (run: WorkflowRun) => void
}) {
  // A call still waiting on your OK isn't work going on yet: its card says so.
  const live = workflows.filter((r) => r.state === 'running' && r.launched)
  const now = useNow(live.length > 0)
  if (!live.length) return null
  return (
    <div className="agentDock wfDock" role="region" aria-label="Workflow runs">
      {live.map((r) => {
        const c = agentCounts(r)
        const phase = phaseLine(r)
        return (
          <div key={r.toolUseId} className="wfdRow">
            <span className="dot live" aria-hidden="true" />
            <span className="wfdName">{r.name}</span>
            {phase && <span className="wfdPhase">{phase}</span>}
            <span className="sp" />
            {c.total > 0 && (
              <span className="wfdNum">
                {c.done}/{c.total} agents
              </span>
            )}
            <span className="wfdNum wfdClock">{formatDuration(workflowElapsedMs(r, now) ?? 0)}</span>
            <button type="button" className="btn xs ghost" onClick={() => onDetails(r.toolUseId)}>
              Details
            </button>
            <button
              type="button"
              className="adStop"
              disabled={!r.taskId}
              onClick={() => onStop(r)}
              title="Stop this run and every agent in it"
              aria-label={`Stop ${r.name}`}
            >
              <Square size={9} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
