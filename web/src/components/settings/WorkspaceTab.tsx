import * as Switch from '@radix-ui/react-switch'
import { useState } from 'react'
import type { Workspace, WorkspaceResponse, WorkspacesResponse } from '../../../../shared/protocol.js'
import { store } from '../../store.js'
import { ColorPicker, authTitle } from '../workspaceAuth.js'
import { Row, SaveRow, Section, useSavedFlash, useWorkspaceSettings } from './shared.js'

// Workspace: identity, watches, default, delete.

export function WorkspaceTab({ workspace }: { workspace: Workspace }) {
  const [name, setName] = useState(workspace.name)
  const [color, setColor] = useState(workspace.color)
  const [description, setDescription] = useState(workspace.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, flashSaved] = useSavedFlash()

  const dirty =
    name.trim() !== workspace.name || color !== workspace.color || description.trim() !== (workspace.description ?? '')

  async function save() {
    if (!name.trim()) return setError('a workspace needs a name')
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/workspaces?id=${encodeURIComponent(workspace.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), color, description: description.trim() }),
      })
      const body = (await res.json()) as WorkspaceResponse
      if (!body.ok) throw new Error(body.error)
      await store.refreshWorkspaces()
      flashSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function makeDefault() {
    const res = await fetch('/api/workspaces/default', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: workspace.id }),
    })
    const body = (await res.json()) as WorkspacesResponse
    if (body.ok) await store.refreshWorkspaces()
  }

  return (
    <>
      <Section title="Identity" hint="The name and colour are the ambient signal for which world you are in.">
        <div className="setField">
          <label htmlFor="ws-name">Name</label>
          <input
            id="ws-name"
            type="text"
            value={name}
            placeholder="e.g. Work, Personal"
            onChange={(e) => setName(e.target.value)}
          />
          <label>Colour</label>
          <ColorPicker value={color} onChange={setColor} />
          <label htmlFor="ws-desc">Description</label>
          <input
            id="ws-desc"
            type="text"
            value={description}
            placeholder="What lives in this workspace"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <SaveRow dirty={dirty} saving={saving} saved={saved} error={error} onSave={() => void save()} />
      </Section>

      <WatchesSection />

      <Section title="Default workspace" hint="The workspace the daemon, the CLI, and a fresh browser open when none is named.">
        <Row
          label={workspace.isDefault ? 'This is the default workspace' : 'Make this the default'}
          hint={
            workspace.isDefault
              ? 'To change it, open another workspace’s settings and make that one the default.'
              : 'Nothing moves — only which workspace opens first.'
          }
        >
          {!workspace.isDefault && (
            <button type="button" className="btn" onClick={() => void makeDefault()}>
              Make default
            </button>
          )}
        </Row>
      </Section>

      <Section title="Details">
        <div className="setKv">
          <span className="k">id</span>
          <span className="v">{workspace.id}</span>
        </div>
        <div className="setKv">
          <span className="k">created</span>
          <span className="v">{new Date(workspace.createdAt).toLocaleString()}</span>
        </div>
        <div className="setKv">
          <span className="k">Claude auth</span>
          <span className="v">{authTitle(workspace.authBackend)}</span>
        </div>
      </Section>

      {!workspace.isDefault && (
        <Section
          title="Remove this workspace"
          hint="Unregisters it from Junior. Its folder — database, secrets, logs — stays on disk; nothing is deleted."
        >
          <DeleteWorkspaceButton workspace={workspace} />
        </Section>
      )}
    </>
  )
}

/** What Junior watches here on its own, one switch each. Jobs have their own switch, under Sources. */
function WatchesSection() {
  const { settings, error, save } = useWorkspaceSettings()
  const rows = [
    {
      field: 'babysitEnabled',
      label: 'PR babysitting',
      on: 'Junior watches your PRs. It fixes CI, comments and rebases on the ones you hand off.',
      off: 'Junior doesn’t watch your PRs. Fixes already queued wait until you switch it on.',
    },
    {
      field: 'reviewsEnabled',
      label: 'First-pass reviews',
      on: 'Junior watches PRs that ask for your review. It reviews the ones you hand off.',
      off: 'Junior doesn’t watch review requests. Reviews already queued wait until you switch it on.',
    },
  ] as const
  return (
    <Section title="Watches" hint="What Junior watches here on its own. New workspaces start with each one off. Jobs have their own switch, under Sources.">
      {rows.map((r) => (
        <Row key={r.field} label={r.label} hint={settings?.[r.field] ? r.on : r.off}>
          <Switch.Root
            className="uiSwitch"
            checked={settings?.[r.field] ?? false}
            disabled={!settings}
            onCheckedChange={(on) => void save({ [r.field]: on })}
            aria-label={r.label}
          >
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </Row>
      ))}
      {error && <div className="msg error">{error}</div>}
    </Section>
  )
}

/** Delete = unregister; the workspace's files stay on disk. Confirmed inline. */
function DeleteWorkspaceButton({ workspace }: { workspace: Workspace }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!confirming) {
    return (
      <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
        Remove workspace…
      </button>
    )
  }
  return (
    <div className="setActions">
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void fetch(`/api/workspaces?id=${encodeURIComponent(workspace.id)}`, { method: 'DELETE' })
            .then((r) => r.json() as Promise<WorkspacesResponse>)
            .then((b) => {
              // The socket for this workspace is closed server-side; land on the default.
              if (b.ok) store.switchWorkspace(b.defaultId)
              else setError(b.error)
            })
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Removing…' : `Really remove “${workspace.name}”?`}
      </button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Keep it
      </button>
      {error && <span className="setErr">{error}</span>}
    </div>
  )
}
