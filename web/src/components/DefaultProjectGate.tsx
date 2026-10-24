/**
 * Every workspace has a default project. One that has
 * none, created from the CLI, or from before projects were required, gets
 * Junior's first message on the Junior page, which adds projects. This gate
 * defers to it: it asks for a folder only once that message was skipped this
 * session (web/src/onboarding.ts). "Later" puts it off for this page load;
 * the next open asks again.
 */
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ProjectsResponse } from '../../../shared/protocol.js'
import { defaultProjectGateOpen } from '../../../core/junior/onboarding-gate.js'
import { FolderField, folderName } from './ProjectsTab.js'

type Props = {
  workspaceId: string
  /** hold off while another modal (onboarding) has the screen */
  suspended: boolean
  /** Junior's first message was skipped this session: until then it asks, not this dialog */
  onboardingSkipped: boolean
}

export function DefaultProjectGate({ workspaceId, suspended, onboardingSkipped }: Props) {
  const [missing, setMissing] = useState(false)
  const [later, setLater] = useState(false)
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

  const open = defaultProjectGateOpen({ missing, later, suspended, onboardingSkipped })

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && setLater(true)}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content asChild>
          <dialog open className="projModal projAddDialog">
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
            {error && <div className="projError">{error}</div>}

            <div className="row">
              <Dialog.Close asChild>
                <button type="button" className="cancel">
                  Later
                </button>
              </Dialog.Close>
              <button type="button" className="go" disabled={saving || !folder.trim()} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Use this folder'}
              </button>
            </div>
          </dialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
