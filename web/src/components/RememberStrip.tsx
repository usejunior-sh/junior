import * as RadioGroup from '@radix-ui/react-radio-group'
import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { pathHint, savedCopy, type RememberScope } from '../../../shared/remember.js'

export type RememberProject = { id: string; name: string }

/** The strip's state: asking (confirm, saving) or done (saved, already there). */
export type RememberUi =
  | { phase: 'confirm' | 'saving'; line: string; scope: RememberScope; tooLong: boolean; error?: string }
  | { phase: 'saved'; scope: RememberScope; projectName?: string; already: boolean; openError?: string }

type Props = {
  ui: RememberUi
  /** The composer's project; without one, the project target is off. */
  project: RememberProject | null
  onScope: (scope: RememberScope) => void
  onSave: () => void
  onCancel: () => void
  onClose: () => void
  onOpen: () => void
}

/**
 * `/remember`'s confirm, inside the prompt box where attachments show: the
 * line, where it goes (this project or the workspace), Cancel and Save.
 * Nothing is written before Save. No dialog: the line stays beside the box it
 * came from. After Save the same strip says where the line went.
 */
export function RememberStrip({ ui, project, onScope, onSave, onCancel, onClose, onOpen }: Props) {
  const save = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const asking = ui.phase !== 'saved'
  const labelId = useId()

  // Focus moves to Save when the strip opens (to Cancel when Save can't be pressed).
  // A failed save puts it back on Save, so Enter retries.
  const opened = ui.phase === 'confirm'
  const blocked = asking && ui.tooLong
  const failed = asking ? ui.error : undefined
  useEffect(() => {
    if (!opened) return
    ;(blocked ? cancel : save).current?.focus()
  }, [opened, blocked, failed])

  if (ui.phase === 'saved') {
    return (
      <div className="rememberStrip done" role="status" aria-live="polite">
        <span className="rsDot" aria-hidden="true" />
        <span className="rsText">
          {ui.openError ? `Couldn't open the file. ${ui.openError}` : ui.already ? 'Junior already has that line.' : savedCopy(ui.scope, ui.projectName)}
        </span>
        <button type="button" className="linkBtn rsOpen" onClick={onOpen}>
          Open file
        </button>
        <button type="button" className="rsClose" aria-label="Close" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const saving = ui.phase === 'saving'
  const scope: RememberScope = project ? ui.scope : 'workspace'
  return (
    <div
      className="rememberStrip"
      role="group"
      aria-label="Remember"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !saving) {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="rsLine">
        <span className="rsDot" aria-hidden="true" />
        <span className="rsKicker">Remember</span>
        <span className="rsWords">{ui.line}</span>
      </div>
      <div className="rsRow">
        <span className="rsLabel" id={labelId}>
          Save to
        </span>
        <RadioGroup.Root
          className="seg rsSeg"
          aria-labelledby={labelId}
          value={scope}
          onValueChange={(v) => onScope(v as RememberScope)}
          disabled={saving}
        >
          <RadioGroup.Item
            value="project"
            className={`segBtn${scope === 'project' ? ' active' : ''}`}
            disabled={!project || saving}
            title={project ? undefined : 'This chat has no project.'}
          >
            {project ? `This project · ${project.name}` : 'This project'}
          </RadioGroup.Item>
          <RadioGroup.Item value="workspace" className={`segBtn${scope === 'workspace' ? ' active' : ''}`}>
            Workspace
          </RadioGroup.Item>
        </RadioGroup.Root>
        <span className="rsActs">
          <button type="button" ref={cancel} className="btn sm" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            ref={save}
            className="btn sm primary"
            onClick={onSave}
            disabled={saving || ui.tooLong}
            aria-busy={saving || undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </div>
      {ui.tooLong ? (
        <div className="rsHint warn">Keep it to one line, under 500 characters.</div>
      ) : (
        <div className="rsHint">{pathHint(scope)}</div>
      )}
      {ui.error && (
        <div className="msg error" role="alert">
          Couldn't save. {ui.error}
        </div>
      )}
    </div>
  )
}
