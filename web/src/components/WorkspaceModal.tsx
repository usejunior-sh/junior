/**
 * The workspace modal (.docs/workspaces.md), one component, two entrances:
 *
 *   create, "New workspace…" from the sidebar switcher
 *   onboarding, first run: the same flow, introducing the concept and
 *                 configuring the default workspace
 *
 * Editing an existing workspace lives on the settings page (Workspace and
 * Claude auth tabs), which shares these cards and the verify panel.
 *
 * Three steps: identity (name, colour, default project folder, every
 * workspace has one, decision 549a251e) → Claude auth (three cards, the
 * tradeoffs spelled out on each) → verify (a live probe with the workspace's own env, so a workspace
 * is never left silently broken, jobs fail in the background, auth must be
 * proven in the foreground).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectsResponse, Workspace, WorkspaceAuthBackend, WorkspaceResponse } from '../../../shared/protocol.js'
import { store } from '../store.js'
import { FolderField, folderName } from './ProjectsTab.js'
import { AuthCards, ColorPicker, VerifyPanel, verifyWorkspace, WORKSPACE_COLORS, type VerifyState } from './workspaceAuth.js'

export type WorkspaceModalMode = { kind: 'create' } | { kind: 'onboarding'; workspace: Workspace }

type Props = {
  mode: WorkspaceModalMode | null
  onClose: () => void
}

type Step = 'identity' | 'auth' | 'verify'

export function WorkspaceModal({ mode, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>('identity')

  // identity
  const [name, setName] = useState('')
  const [color, setColor] = useState(WORKSPACE_COLORS[0])
  const [description, setDescription] = useState('')
  // the default project's folder; onboarding an existing workspace starts from its current default
  const [folder, setFolder] = useState('')
  const [currentDefault, setCurrentDefault] = useState('')
  const [folderError, setFolderError] = useState<string | null>(null)
  // auth
  const [authBackend, setAuthBackend] = useState<WorkspaceAuthBackend>('inherit')
  const [apiKey, setApiKey] = useState('')
  // the workspace being verified: the created one, or the onboarded default
  const [target, setTarget] = useState<Workspace | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // verify
  const [verify, setVerify] = useState<VerifyState>(null)

  // (Re)seed the form each time the modal opens.
  useEffect(() => {
    if (!mode) return
    const ws = mode.kind === 'create' ? null : mode.workspace
    setStep('identity')
    // The default workspace is born "Default": onboarding asks for a real name.
    setName(ws && ws.name !== 'Default' ? ws.name : '')
    setColor(ws?.color ?? WORKSPACE_COLORS[0])
    setDescription(ws?.description ?? '')
    setFolder('')
    setCurrentDefault('')
    setFolderError(null)
    if (ws) {
      void fetch(`/api/projects?workspace=${encodeURIComponent(ws.id)}`)
        .then((r) => r.json() as Promise<ProjectsResponse>)
        .then((b) => {
          const d = b.ok ? b.projects.find((p) => p.isDefault) : undefined
          if (!d) return
          setCurrentDefault(d.path)
          setFolder((f) => f || d.path)
        })
        .catch(() => {})
    }
    setAuthBackend(ws?.authBackend ?? 'inherit')
    setApiKey('')
    setTarget(ws)
    setSaving(false)
    setError('')
    setVerify(null)
  }, [mode])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (mode && !el.open) el.showModal()
    if (!mode && el.open) el.close()
  }, [mode])

  const finishOnboarding = useCallback(() => {
    void fetch('/api/workspaces/onboarded', { method: 'POST' }).finally(() => {
      store.markOnboarded()
      void store.refreshWorkspaces()
      onClose()
    })
  }, [onClose])

  const close = useCallback(() => {
    // Onboarding is once-per-install: closing it (Escape, backdrop, Skip)
    // counts as "skip": it must not reappear on every load.
    if (mode?.kind === 'onboarding') finishOnboarding()
    else {
      void store.refreshWorkspaces()
      onClose()
    }
  }, [mode, onClose, finishOnboarding])

  const runVerify = useCallback((id: string) => {
    setVerify('probing')
    void verifyWorkspace(id).then(setVerify)
  }, [])

  /** Persist identity + auth, then move to the verify step. */
  const save = useCallback(async () => {
    if (!mode) return
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: name.trim(),
        color,
        description: description.trim(),
        authBackend,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }
      // Once created, a retry (say the folder was refused) edits it rather than creating a second.
      const url = target ? `/api/workspaces?id=${encodeURIComponent(target.id)}` : '/api/workspaces'
      const res = await fetch(url, {
        method: target ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as WorkspaceResponse
      if (!body.ok) throw new Error(body.error)
      setTarget(body.workspace)
      if (folder.trim() && folder.trim() !== currentDefault) {
        const pr = await fetch(`/api/projects?workspace=${encodeURIComponent(body.workspace.id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: folderName(folder.trim()), path: folder.trim(), makeDefault: true }),
        })
        const pb = (await pr.json()) as ProjectsResponse
        if (!pb.ok) throw new Error(`Default project: ${pb.error}`)
        setCurrentDefault(folder.trim())
      }
      setStep('verify')
      runVerify(body.workspace.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [mode, target, name, color, description, folder, currentDefault, authBackend, apiKey, runVerify])

  if (!mode) {
    return <dialog ref={dialog} className="wsModal" onClose={onClose} />
  }

  const heading = mode.kind === 'onboarding' ? 'Welcome to Junior — set up your workspace' : 'New workspace'
  const needsKey = authBackend === 'api-key' && !apiKey.trim() && !(target?.apiKeyHint && mode.kind !== 'create')

  return (
    <dialog
      ref={dialog}
      className="wsModal"
      onClose={close}
      onClick={(e) => e.target === dialog.current && close()}
    >
      <h3>{heading}</h3>
      {mode.kind === 'onboarding' && step === 'identity' && (
        <p className="wsIntro">
          A workspace keeps its projects, inbox, jobs, and Claude account separate — work and
          personal never share a pile. This sets up your first one; more can be added any time from
          the sidebar.
        </p>
      )}

      <div className="wsSteps" aria-hidden="true">
        {(['identity', 'auth', 'verify'] as Step[]).map((s, i) => (
          <span key={s} className={`wsStep${step === s ? ' active' : ''}`}>
            {i + 1}. {s === 'identity' ? 'Name & project' : s === 'auth' ? 'Claude auth' : 'Verify'}
          </span>
        ))}
      </div>

      {step === 'identity' && (
        <>
          <label>Name</label>
          <input
            autoFocus
            value={name}
            placeholder="e.g. Work, Personal"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && folder.trim()) setStep('auth')
            }}
          />
          <label>Color</label>
          <ColorPicker value={color} onChange={setColor} />
          <label>
            Default project <span className="hint">· the folder sessions, terminals and jobs start in</span>
          </label>
          <FolderField value={folder} onChange={setFolder} onError={setFolderError} />
          {folderError && <div className="projError">{folderError}</div>}
          <label>Description (optional)</label>
          <input
            value={description}
            placeholder="What lives in this workspace"
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="row">
            {mode.kind === 'onboarding' ? (
              <button type="button" className="cancel" onClick={finishOnboarding}>
                Skip for now
              </button>
            ) : (
              <button type="button" className="cancel" onClick={close}>
                Cancel
              </button>
            )}
            <button type="button" className="go" disabled={!name.trim() || !folder.trim()} onClick={() => setStep('auth')}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 'auth' && (
        <>
          <AuthCards
            value={authBackend}
            onChange={setAuthBackend}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            apiKeyHint={mode.kind === 'create' ? null : target?.apiKeyHint}
          />
          {error && <div className="msg error">{error}</div>}
          <div className="row">
            <button type="button" className="cancel" onClick={() => setStep('identity')}>
              Back
            </button>
            <button type="button" className="go" disabled={saving || needsKey} onClick={() => void save()}>
              {saving ? 'Saving…' : mode.kind === 'create' ? 'Create & verify' : 'Save & verify'}
            </button>
          </div>
        </>
      )}

      {step === 'verify' && target && (
        <VerifyPanel
          workspace={target}
          state={verify}
          onRecheck={() => runVerify(target.id)}
          footer={
            <div className="row">
              {mode.kind === 'create' && (
                <button type="button" className="cancel" onClick={() => store.switchWorkspace(target.id)}>
                  Switch to it
                </button>
              )}
              <button
                type="button"
                className="go"
                onClick={mode.kind === 'onboarding' ? finishOnboarding : close}
              >
                {mode.kind === 'onboarding' ? 'Finish' : 'Done'}
              </button>
            </div>
          }
        />
      )}
    </dialog>
  )
}
