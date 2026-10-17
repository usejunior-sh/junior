import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { Workspace, WorkspaceProvider, ProviderStatus, WorkspaceAuthBackend, WorkspaceResponse, ProviderVerifyResponse } from '../../../../shared/protocol.js'
import { store } from '../../store.js'
import { authTitle, AuthCards } from '../workspaceAuth.js'
import { PROVIDER_LABEL, ProviderIcon } from '../ProviderIcon.js'
import { accountLine, ProviderUsage } from '../ProviderUsage.js'
import { useProviderStatus, loadProviderStatus, invalidateProviderStatus } from '../../providerStatus.js'
import { SaveRow, Section } from './shared.js'

// ---------------------------------------------------------------------------
// Providers — every agent triage knows: connected or not, how it signs in,
// and what its own account says about the plan.
// ---------------------------------------------------------------------------

export function ProvidersTab({ workspace }: { workspace: Workspace }) {
  const status = useProviderStatus(workspace.id)
  const connected = workspace.providers.filter((p) => p.connected).length
  return (
    <Section
      title={`${connected} of ${workspace.providers.length} connected`}
      hint={
        <>
          The primary agent runs everything — chats, jobs, briefs and team workers. Any other you connect is offered in the
          model picker when you start a chat. Plan windows and spend come from each agent’s own account.
        </>
      }
    >
      <div className="provList">
        {workspace.providers.map((p) => (
          <ProviderRow key={p.id} workspace={workspace} provider={p} status={status.providers?.find((s) => s.id === p.id)} loading={status.loading} />
        ))}
      </div>
      {status.error && <div className="msg error">{status.error}</div>}
      <div className="setActions">
        <button type="button" className="btn" disabled={status.loading} onClick={() => void loadProviderStatus(workspace.id, true)}>
          <RefreshCw size={12} aria-hidden="true" /> {status.loading ? 'Reading accounts…' : 'Refresh usage'}
        </button>
        {status.at > 0 && <span className="provChecked">checked {new Date(status.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      </div>
    </Section>
  )
}

type Verify = { phase: 'checking' } | { phase: 'done'; ok: boolean; error?: string } | null

function ProviderRow({
  workspace,
  provider,
  status,
  loading,
}: {
  workspace: Workspace
  provider: WorkspaceProvider
  status: ProviderStatus | undefined
  loading: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [backend, setBackend] = useState<WorkspaceAuthBackend>(provider.authBackend ?? 'inherit')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [verify, setVerify] = useState<Verify>(null)
  const label = PROVIDER_LABEL[provider.id]

  const dirty = !provider.connected || backend !== provider.authBackend || apiKey.trim() !== ''
  const needsKey = backend === 'api-key' && !apiKey.trim() && !(backend === provider.authBackend && provider.apiKeyHint)

  async function put(body: Record<string, unknown>) {
    const res = await fetch(`/api/providers?workspace=${encodeURIComponent(workspace.id)}&provider=${provider.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const out = (await res.json()) as WorkspaceResponse
    if (!out.ok) throw new Error(out.error)
    await store.refreshWorkspaces()
    invalidateProviderStatus()
    void loadProviderStatus(workspace.id, true)
  }

  async function runVerify() {
    setVerify({ phase: 'checking' })
    try {
      const res = await fetch(`/api/providers/verify?workspace=${encodeURIComponent(workspace.id)}&provider=${provider.id}`, { method: 'POST' })
      const out = (await res.json()) as ProviderVerifyResponse
      setVerify(out.ok ? { phase: 'done', ok: out.authOk, error: out.authError } : { phase: 'done', ok: false, error: out.error })
    } catch (err) {
      setVerify({ phase: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      await put({ authBackend: backend, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      setApiKey('')
      setEditing(false)
      if (backend !== 'inherit') void runVerify()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    setSaving(true)
    setError('')
    try {
      await put({ connected: false })
      setEditing(false)
      setVerify(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const state = !provider.connected ? 'off' : status && !status.ok ? 'bad' : status ? 'ok' : 'unknown'
  return (
    <div className={`provRow${provider.connected ? '' : ' off'}`}>
      <div className="provHead">
        <span className="provIcon">
          <ProviderIcon provider={provider.id} size={16} />
        </span>
        <span className="provName">
          {label}
          {provider.primary && <span className="provTag">primary</span>}
        </span>
        <span className={`provState ${state}`}>
          <i aria-hidden="true" />
          {state === 'off' ? 'Not connected' : state === 'bad' ? 'Needs attention' : state === 'ok' ? 'Connected' : 'Checking…'}
        </span>
        <span className="provWho" title={status ? accountLine(status) : undefined}>
          {provider.connected ? (status ? accountLine(status) : '') : provider.primary ? '' : 'Run chats on it too'}
        </span>
        <span className="provActions">
          {provider.connected ? (
            <button type="button" className="btn ghost sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              {editing ? 'Close' : authTitle(provider.authBackend ?? 'inherit', provider.id)}
            </button>
          ) : (
            <button type="button" className="btn sm" onClick={() => setEditing(true)} disabled={editing}>
              Connect
            </button>
          )}
        </span>
      </div>

      {provider.connected && !editing && (
        <div className="provBody">
          {status ? <ProviderUsage status={status} /> : loading ? <div className="provNone">Reading the account…</div> : null}
          {provider.authBackend === 'config-dir' && status && !status.ok && (
            <div className="provLogin">
              One-time login for this workspace’s own account — run in a terminal:
              <code className="wsLoginCmd">{provider.loginCommand}</code>
            </div>
          )}
          {verify && (
            <div className={`provVerify ${verify.phase === 'checking' ? '' : verify.ok ? 'ok' : 'bad'}`}>
              {verify.phase === 'checking'
                ? `Checking ${label} signs in…`
                : verify.ok
                  ? `${label} signed in with this workspace’s auth.`
                  : (verify.error ?? `${label} couldn’t sign in.`)}
            </div>
          )}
        </div>
      )}

      {editing && (
        <div className="provEdit">
          <AuthCards
            provider={provider.id}
            value={backend}
            onChange={setBackend}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            apiKeyHint={backend === provider.authBackend ? provider.apiKeyHint : null}
          />
          {backend === 'config-dir' && (
            <p className="hint">
              After saving, run the one-time login it shows in a terminal{provider.primary ? '' : ' — until then chats on it won’t start'}.
            </p>
          )}
          <SaveRow
            dirty={dirty && !needsKey}
            saving={saving}
            saved={false}
            error={error}
            onSave={() => void save()}
            label={provider.connected ? 'Save' : `Connect ${label}`}
          >
            {provider.connected && (
              <button type="button" className="btn" disabled={verify?.phase === 'checking'} onClick={() => void runVerify()}>
                {verify?.phase === 'checking' ? 'Checking…' : 'Check it works'}
              </button>
            )}
            {provider.connected && !provider.primary && (
              <button type="button" className="btn ghost danger" disabled={saving} onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
            {!provider.connected && (
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </SaveRow>
          {provider.primary && (
            <p className="hint">
              Auth is applied when a {label} subprocess starts: saving a change stops this workspace’s live sessions, and the next
              message revives each one with the new credentials.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
