/**
 * The workspace modal (.docs/workspaces.md), one component, two entrances:
 *
 *   create, "New workspace…" from the sidebar switcher: identity (name,
 *                 colour, default project folder, every workspace has one,
 *                 decision 549a251e) → Claude auth → verify
 *   onboarding, first run: Claude auth, checked in place. The default workspace
 *                 keeps its born name "Default" and the first colour, both
 *                 editable in Settings → Workspace; projects come from
 *                 Junior's first message on the Junior page, so day one
 *                 asks only what Junior can't guess.
 *
 * Editing an existing workspace lives on the settings page (Workspace and
 * Claude auth tabs), which shares these cards.
 *
 * Claude auth is three cards, the tradeoffs spelled out on each; the check is
 * a live probe with the workspace's own env, said as Junior (VerifyLine), so
 * a workspace is never left silently broken: jobs fail in the background,
 * auth must be proven in the foreground. Onboarding shows that line under
 * the cards, no separate step; the dialog is modal, so it runs before any
 * chat can start. Skip for now stays the user's explicit call.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectsResponse, Workspace, WorkspaceAuthBackend, WorkspaceResponse } from '../../../shared/protocol.js'
import { store } from '../store.js'
import { usePersona } from '../junior.js'
import { FolderField, folderName } from './ProjectsTab.js'
import { AuthCards, ColorPicker, VerifyLine, verifyWorkspace, WORKSPACE_COLORS, type VerifyState } from './workspaceAuth.js'

export type WorkspaceModalMode = { kind: 'create' } | { kind: 'onboarding'; workspace: Workspace }

type Props = {
  mode: WorkspaceModalMode | null
  onClose: () => void
}

type Step = 'identity' | 'auth' | 'verify'

const STEPS: Record<WorkspaceModalMode['kind'], [Step, string][]> = {
  create: [
    ['identity', 'Name & project'],
    ['auth', 'Claude auth'],
    ['verify', 'Verify'],
  ],
  // one step: the check lands under the cards, so no step chips
  onboarding: [['auth', 'Claude login']],
}

/** The probe answered, and Claude can't be reached with this login. */
const verifyFailed = (v: VerifyState): boolean => v !== null && v !== 'probing' && (!v.ok || !v.authOk)

export function WorkspaceModal({ mode, onClose }: Props) {
  const persona = usePersona()
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>('identity')

  // identity
  const [name, setName] = useState('')
  const [color, setColor] = useState(WORKSPACE_COLORS[0])
  const [description, setDescription] = useState('')
  // the default project's folder (create only: onboarding leaves projects to Junior's first message)
  const [folder, setFolder] = useState('')
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
  // focus lands on the primary button when a check's answer arrives
  const primary = useRef<HTMLButtonElement>(null)

  // (Re)seed the form each time the modal opens.
  useEffect(() => {
    if (!mode) return
    const ws = mode.kind === 'create' ? null : mode.workspace
    setStep(STEPS[mode.kind][0][0])
    setName('')
    setColor(WORKSPACE_COLORS[0])
    setDescription('')
    setFolder('')
    setFolderError(null)
    setAuthBackend(ws?.authBackend ?? 'inherit')
    setApiKey('')
    setTarget(ws)
    setSaving(false)
    setError('')
    probeSeq.current++
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

  // A late answer from a check the user has since edited away must not land.
  const probeSeq = useRef(0)
  const runVerify = useCallback((id: string) => {
    const seq = ++probeSeq.current
    setVerify('probing')
    void verifyWorkspace(id).then((r) => {
      if (seq === probeSeq.current) setVerify(r)
    })
  }, [])

  // Editing the cards after a check clears the line: it spoke for the old choice.
  const editAuth = useCallback((b: WorkspaceAuthBackend) => {
    probeSeq.current++
    setVerify(null)
    setAuthBackend(b)
  }, [])
  const editKey = useCallback((k: string) => {
    probeSeq.current++
    setVerify(null)
    setApiKey(k)
  }, [])

  const settled = verify !== null && verify !== 'probing'
  useEffect(() => {
    if (settled) primary.current?.focus()
  }, [settled])

  /** Persist identity (create only) + auth, then move to the verify step. */
  const save = useCallback(async () => {
    if (!mode) return
    setSaving(true)
    setError('')
    try {
      const auth = { authBackend, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
      // Onboarding sends the login only: the PUT leaves name, colour and description as they are.
      const payload =
        mode.kind === 'onboarding' ? auth : { name: name.trim(), color, description: description.trim(), ...auth }
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
      if (mode.kind === 'create' && folder.trim()) {
        const pr = await fetch(`/api/projects?workspace=${encodeURIComponent(body.workspace.id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: folderName(folder.trim()), path: folder.trim(), makeDefault: true }),
        })
        const pb = (await pr.json()) as ProjectsResponse
        if (!pb.ok) throw new Error(`Default project: ${pb.error}`)
        setFolder('') // set: a retry edits the workspace without adding the project twice
      }
      if (mode.kind === 'create') setStep('verify')
      runVerify(body.workspace.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(mode.kind === 'onboarding' ? `Couldn't save. ${msg}` : msg)
    } finally {
      setSaving(false)
    }
  }, [mode, target, name, color, description, folder, authBackend, apiKey, runVerify])

  if (!mode) {
    return <dialog ref={dialog} className="wsModal" onClose={onClose} />
  }

  const heading = mode.kind === 'onboarding' ? 'Set up Junior on this Mac' : 'New workspace'
  const needsKey = authBackend === 'api-key' && !apiKey.trim() && !(target?.apiKeyHint && mode.kind !== 'create')

  return (
    <dialog
      ref={dialog}
      className="wsModal"
      onClose={close}
      onClick={(e) => e.target === dialog.current && close()}
    >
      <h3>{heading}</h3>
      {mode.kind === 'onboarding' && (
        <p className="wsIntro">
          {persona.name} runs Claude with a login on this Mac. Pick which one. You can rename this workspace later.
        </p>
      )}

      {STEPS[mode.kind].length > 1 && (
        <div className="wsSteps" aria-hidden="true">
          {STEPS[mode.kind].map(([s, label], i) => (
            <span key={s} className={`wsStep${step === s ? ' active' : ''}`}>
              {i + 1}. {label}
            </span>
          ))}
        </div>
      )}

      {step === 'identity' && mode.kind === 'create' && (
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
            <button type="button" className="cancel" onClick={close}>
              Cancel
            </button>
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
            onChange={editAuth}
            apiKey={apiKey}
            onApiKeyChange={editKey}
            apiKeyHint={mode.kind === 'create' ? null : target?.apiKeyHint}
          />
          {error && <div className="msg error">{error}</div>}
          {mode.kind === 'onboarding' && target && (verify !== null || target.authBackend === authBackend) ? (
            <VerifyLine
              workspace={target}
              state={verify}
              footer={
                <div className="row">
                  {verify === null || verify === 'probing' ? (
                    <>
                      <button type="button" className="cancel" onClick={finishOnboarding}>
                        Skip for now
                      </button>
                      <button
                        type="button"
                        className="go"
                        disabled={saving || needsKey || verify === 'probing'}
                        onClick={() => void save()}
                      >
                        {verify === 'probing' ? 'Checking…' : saving ? 'Saving…' : 'Save and check'}
                      </button>
                    </>
                  ) : verifyFailed(verify) ? (
                    <>
                      <button type="button" className="cancel" onClick={finishOnboarding}>
                        Finish anyway
                      </button>
                      <button ref={primary} type="button" className="go" onClick={() => runVerify(target.id)}>
                        Try again
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="jrRef" onClick={() => runVerify(target.id)}>
                        Check again
                      </button>
                      <button ref={primary} type="button" className="go" onClick={finishOnboarding}>
                        Finish
                      </button>
                    </>
                  )}
                </div>
              }
            />
          ) : (
            <div className="row">
              {mode.kind === 'onboarding' ? (
                <button type="button" className="cancel" onClick={finishOnboarding}>
                  Skip for now
                </button>
              ) : (
                <button type="button" className="cancel" onClick={() => setStep('identity')}>
                  Back
                </button>
              )}
              <button type="button" className="go" disabled={saving || needsKey} onClick={() => void save()}>
                {saving ? 'Saving…' : mode.kind === 'create' ? 'Create & verify' : 'Save and check'}
              </button>
            </div>
          )}
        </>
      )}

      {step === 'verify' && mode.kind === 'create' && target && (
        <VerifyLine
          workspace={target}
          state={verify}
          footer={
            <div className="row">
              {verify !== null && verify !== 'probing' && (
                <button type="button" className="jrRef" onClick={() => runVerify(target.id)}>
                  {verifyFailed(verify) ? 'Try again' : 'Check again'}
                </button>
              )}
              <button type="button" className="cancel" onClick={() => store.switchWorkspace(target.id)}>
                Switch to it
              </button>
              <button ref={primary} type="button" className="go" disabled={verify === 'probing'} onClick={close}>
                {verify === 'probing' ? 'Checking…' : 'Done'}
              </button>
            </div>
          }
        />
      )}
    </dialog>
  )
}
