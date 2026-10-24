/**
 * Every workspace has a default project. One that has
 * none, created from the CLI, or from before projects were required, gets
 * Junior's first message on the Junior page, which adds projects. This gate
 * defers to it: it asks for a folder only once that message was skipped this
 * session (web/src/onboarding.ts). "Not now" is kept per workspace: once
 * onboarding has run, it doesn't ask again on the next open.
 */
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ProjectsResponse } from '../../../shared/protocol.js'
import { defaultProjectGateOpen } from '../../../core/junior/onboarding-gate.js'
import { FolderField, folderName } from './ProjectsTab.js'
import { useProjectGateDismissed } from '../onboarding.js'
import { useReturnFocus } from '../ui/returnFocus.js'

type Props = {
  workspaceId: string
  /** hold off while another modal (onboarding) has the screen */
  suspended: boolean
  /** Junior's first message was skipped this session: until then it asks, not this dialog */
  onboardingSkipped: boolean
}

export function DefaultProjectGate({ workspaceId, suspended, onboardingSkipped }: Props) {
  const [missing, setMissing] = useState(false)
  const [dismissed, dismiss] = useProjectGateDismissed(workspaceId)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Re-asked whenever another modal closes or the first message is skipped:
  // either may have just set one.
  useEffect(() => {
    if (!workspaceId || suspended || !onboardingSkipped) return
    let live = true
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (live && b.ok) setMissing(b.projects.length === 0)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [workspaceId, suspended, onboardingSkipped])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: folderName(folder.trim()), path: folder.trim(), makeDefault: true }),
      })
      const body = (await res.json()) as ProjectsResponse
      if (body.ok) setMissing(false)
      else setError(body.error)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const open = defaultProjectGateOpen({ missing, dismissed, suspended, onboardingSkipped })
  const returnFocus = useReturnFocus(open)

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content className="uiDialog projModal projGate" onCloseAutoFocus={returnFocus}>
          <Dialog.Title asChild>
            <h3>Pick a default project</h3>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="wsIntro">
              Sessions, terminals and jobs in this workspace start in its default project. Pick the folder you
              work in most. You can add more projects, or change the default, in Settings → Projects.
            </p>
          </Dialog.Description>

          <label>Folder</label>
          <FolderField value={folder} onChange={setFolder} onError={setError} autoFocus />
          <p className="projGateHint">It won't ask again. Add one in Settings → Projects.</p>
          {error && <div className="projError">{error}</div>}

          <div className="row">
            <Dialog.Close asChild>
              <button type="button" className="cancel">
                Not now
              </button>
            </Dialog.Close>
            <button type="button" className="go" disabled={saving || !folder.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Use this folder'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
