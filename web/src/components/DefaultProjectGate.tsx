/**
 * Every workspace has a default project. One that has
 * none, skipped onboarding, created from the CLI, or from before projects
 * were required, is asked for a folder when it opens. "Later" puts it off
 * for this page load; the next open asks again.
 */
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { ProjectsResponse } from '../../../shared/protocol.js'
import { FolderField, folderName } from './ProjectsTab.js'

type Props = {
  workspaceId: string
  /** hold off while another modal (onboarding) has the screen */
  suspended: boolean
}

export function DefaultProjectGate({ workspaceId, suspended }: Props) {
  const [missing, setMissing] = useState(false)
  const [later, setLater] = useState(false)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Re-asked whenever another modal closes: onboarding may have just set one.
  useEffect(() => {
    if (!workspaceId || suspended) return
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
  }, [workspaceId, suspended])

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

  const open = missing && !later && !suspended

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
