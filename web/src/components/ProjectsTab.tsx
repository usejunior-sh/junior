import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FolderOpen, MoreHorizontal } from 'lucide-react'
import type { PickFolderResponse, Project, ProjectsResponse, JobsResponse } from '../../../shared/protocol.js'
import { onThisMac } from '../device.js'
import { projectColor } from '../tabs.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; projects: Project[] }
  | { phase: 'error'; message: string }

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * The Projects settings tab. Adding or removing a project is a one-time act of
 * setup, so it lives here rather than in the rail; the frequent affordance,
 * "start a session in project X", is the composer's ProjectPicker.
 *
 * One project is the default: where work lands when nothing names a project.
 * It can be replaced, never removed.
 */
export function ProjectsTab() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [adding, setAdding] = useState(false)
  // A failed action keeps the list on screen and says why above it.
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      const body = (await res.json()) as ProjectsResponse
      if (body.ok) setState({ phase: 'ready', projects: body.projects })
      else setState({ phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(p: Project) {
    // Jobs run only in their project; removing it pauses them.
    const wb = (await fetch('/api/jobs')
      .then((r) => r.json())
      .catch(() => null)) as JobsResponse | null
    const using = wb?.ok ? wb.jobs.filter((w) => w.projectId === p.id) : []
    if (using.length && !confirm(`Remove “${p.name}”? ${using.length === 1 ? 'This job' : `These ${using.length} jobs`} will pause until you pick another project:\n\n${using.map((w) => `· ${w.title}`).join('\n')}`)) return
    const res = await fetch(`/api/projects?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' })
    const body = (await res.json()) as ProjectsResponse
    setActionError(body.ok ? null : body.error)
    if (body.ok) setState({ phase: 'ready', projects: body.projects })
  }

  async function makeDefault(p: Project) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, makeDefault: true }),
    })
    const body = (await res.json()) as ProjectsResponse
    setActionError(body.ok ? null : body.error)
    if (body.ok) setState({ phase: 'ready', projects: body.projects })
  }

  return (
    <section className="setSection">
      {state.phase === 'loading' && <div className="pickerLoading">Loading…</div>}
      {state.phase === 'error' && <div className="msg error">{state.message}</div>}
      {actionError && <div className="msg error">{actionError}</div>}

      {state.phase === 'ready' && (
        <>
          {state.projects.length > 0 ? (
            <div className="projList">
              {state.projects.map((p) => (
                <div key={p.id} className="projRow">
                  <span className="projName">
                    <span className="pdot" style={{ background: projectColor(p.id) }} aria-hidden="true" />
                    {p.name}
                    {p.isDefault && <span className="projDefault">default</span>}
                  </span>
                  <span className="projRepo">{p.repo || '—'}</span>
                  <span className="projPath" title={p.path}>
                    {tilde(p.path)}
                  </span>
                  {p.isDefault ? (
                    <span className="projActionsGap" aria-hidden="true" />
                  ) : (
                    <Menu>
                      <MenuTrigger asChild>
                        <button className="projDelete" title="Project actions" aria-label={`Actions for ${p.name}`}>
                          <MoreHorizontal size={14} aria-hidden="true" />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuItem onSelect={() => void makeDefault(p)}>Make default</MenuItem>
                        <MenuItem className="danger" onSelect={() => void remove(p)}>
                          Remove project
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="projEmpty">No projects yet — add the folders you work in.</div>
          )}
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add a project
          </button>
        </>
      )}

      <AddProjectModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(projects) => setState({ phase: 'ready', projects })}
      />
    </section>
  )
}

function AddProjectModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: (projects: Project[]) => void
}) {
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Reseed each time the modal opens.
  useEffect(() => {
    if (!open) return
    setName('')
    setRepo('')
    setPath('')
    setError(null)
    setSaving(false)
  }, [open])

  async function add() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), repo: repo.trim(), path: path.trim() }),
      })
      const body = (await res.json()) as ProjectsResponse
      if (body.ok) {
        onAdded(body.projects)
        onClose()
      } else {
        setError(body.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        {/*
          A <dialog> element only for the styling. Every `dialog …` rule in
          styles/*.css applies. Radix owns the behaviour, because this opens
          *inside* the settings dialog and only its layer stack gets Esc and
          the focus trap right for a nested modal.
        */}
        <Dialog.Content asChild aria-describedby={undefined}>
          <dialog open className="projModal projAddDialog">
            <Dialog.Title asChild>
              <h3>Add a project</h3>
            </Dialog.Title>

            <label>Name</label>
            <input
              autoFocus
              placeholder="e.g. junior"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            <label>Repo (optional)</label>
            <input
              placeholder="owner/name"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />

            <label>Folder</label>
            <FolderField
              value={path}
              onChange={(p) => {
                setPath(p)
                // A folder with no name yet? Suggest the folder's basename.
                setName((n) => n || folderName(p))
              }}
              onError={setError}
            />

            {error && <div className="projError">{error}</div>}

            <div className="row">
              <Dialog.Close asChild>
                <button type="button" className="cancel">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="go"
                disabled={saving || !name.trim() || !path.trim()}
                onClick={() => void add()}
              >
                {saving ? 'Adding…' : 'Add project'}
              </button>
            </div>
          </dialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const folderName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || ''

/**
 * A project folder: the OS-native chooser on this Mac (the server shells out
 * to it. A browser can't read absolute paths), a typed path from a phone.
 */
export function FolderField({
  value,
  onChange,
  onError,
  autoFocus,
}: {
  value: string
  onChange: (path: string) => void
  onError: (message: string | null) => void
  autoFocus?: boolean
}) {
  const [picking, setPicking] = useState(false)

  async function pickFolder() {
    setPicking(true)
    onError(null)
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' })
      const body = (await res.json()) as PickFolderResponse
      if (!body.ok) onError(body.error)
      else if (!('cancelled' in body)) onChange(body.path)
    } catch (err) {
      onError(String(err))
    } finally {
      setPicking(false)
    }
  }

  return onThisMac() ? (
    <div className="projPickRow">
      <button type="button" className="projPick" autoFocus={autoFocus} disabled={picking} onClick={() => void pickFolder()}>
        <FolderOpen size={14} aria-hidden="true" />
        {picking ? 'Choosing…' : value ? 'Change folder…' : 'Select folder…'}
      </button>
      <span className={`projPickPath${value ? '' : ' empty'}`} title={value}>
        {value ? tilde(value) : 'No folder selected'}
      </span>
    </div>
  ) : (
    <input
      placeholder="~/Code/project"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
