import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight, Workflow } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { PermissionBehavior } from '../../../../shared/protocol.js'
import { scriptMeta, scriptPhases } from '../../../../core/workflows/fold.js'
import type { TranscriptItem } from '../../transcript.js'
import { JuniorLabel } from '../JuniorLabel.js'

type Permission = Extract<TranscriptItem, { kind: 'permission' }>

type Props = {
  item: Permission
  onRespond: (requestId: string, behavior: PermissionBehavior) => void
  /** Junior is the one asking (false: a subagent, named by the wrapper around the card) */
  junior?: boolean
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * A Workflow launch waiting for your OK, read as the run it would start: its
 * name, what it is for, its phases, and the script on demand. Once answered it
 * folds to one line, so a long script never sits in the transcript.
 */
export const WorkflowApproval = memo(function WorkflowApproval({ item, onRespond, junior = true }: Props) {
  const script = str(item.input?.script)
  const scriptPath = str(item.input?.scriptPath)
  const meta = useMemo(() => scriptMeta(script), [script])
  const phases = useMemo(() => scriptPhases(script), [script])
  const name = meta.name || str(item.input?.name) || 'workflow'
  const [open, setOpen] = useState(false)

  if (item.resolved) {
    const ok = item.resolved === 'allow' || item.resolved === 'allow_always'
    const state = ok ? 'allow' : item.resolved === 'deny' ? 'deny' : 'expired'
    const label = ok ? '✓ Run approved' : state === 'deny' ? '✕ Not run' : '— Expired'
    return (
      <div className={`perm wfApprove done ${state}`}>
        <Workflow size={13} className="wfMark" aria-hidden="true" />
        <span className={`verdict ${state}`}>{label}</span>
        <span className="wfapSep" aria-hidden="true">·</span>
        <span className="wfapName" title={meta.description || name}>{name}</span>
      </div>
    )
  }

  const headId = `wfa-${item.id}`
  return (
    <div className="perm wfApprove" role="group" aria-labelledby={headId}>
      <div className="q" id={headId}>
        {junior ? (
          <JuniorLabel mood="needs" say="I’ll wait for your OK before I start this run">
            {' '}wants to run a workflow
          </JuniorLabel>
        ) : (
          <span>Wants to run a workflow</span>
        )}
        <Workflow size={14} className="wfMark" aria-hidden="true" />
      </div>
      <div className="wfapWhat">
        <span className="wfapName">{name}</span>
        {meta.description && <p className="wfapDesc">{meta.description}</p>}
      </div>
      {phases.length > 0 && (
        <ol className="wfapPhases" aria-label="Phases">
          {phases.map((p, i) => (
            <li key={i}>
              <span className="wfapNum" aria-hidden="true">{i + 1}</span>
              <span className="wfapPt">{p.title}</span>
              {p.detail && <span className="wfapPd">{p.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {script ? (
        <Collapsible.Root open={open} onOpenChange={setOpen} className="wfapScript">
          <Collapsible.Trigger asChild>
            <button type="button" className="wfapToggle">
              <ChevronRight size={12} className="chev" aria-hidden="true" />
              {open ? 'Hide the script' : 'Show the script'}
              <span className="wfapLines">{script.split('\n').length} lines</span>
            </button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre className="well wfapWell" tabIndex={0} aria-label="Workflow script">{script}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      ) : (
        scriptPath && <div className="wfapPath" title={scriptPath}>{scriptPath}</div>
      )}
      <p className="wfapNote">Runs many agents. Costs more than a normal turn.</p>
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => onRespond(item.id, 'allow')}>
          Run it
        </button>
        <button type="button" className="btn" onClick={() => onRespond(item.id, 'deny')}>
          Don’t run
        </button>
      </div>
    </div>
  )
})
