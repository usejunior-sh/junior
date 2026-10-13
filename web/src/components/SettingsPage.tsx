/**
 * The settings page (`#/settings/<tab>`) — it takes the place of the panel and
 * the tabbed main area: a tab list down the left, one pane on the right. Every
 * tab is a destination in its own right: `openSettings('providers')` (or the
 * hash) lands on it with nothing to click through, which is what a "Fix" link
 * needs. Close and Esc go back to the page settings was opened from.
 *
 * Workspace-scoped tabs (Workspace · Claude auth · Sources · Projects) write to the
 * server; browser-scoped ones (Sessions · Shortcuts) write to localStorage.
 */
import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import * as Tabs from '@radix-ui/react-tabs'
import {
  Activity,
  Bot,
  BotMessageSquare,
  Cable,
  Check,
  Folder,
  Gauge,
  Info,
  Keyboard,
  MessagesSquare,
  Palette,
  Plug,
  RefreshCw,
  ScrollText,
  Settings2,
  Smartphone,
  Sparkles,
  SwatchBook,
  Users,
  Wallet,
  WandSparkles,
  X,
  type LucideProps,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type {
  ConnectorsResponse,
  PlaybookResponse,
  PlaybooksResponse,
  SettingsResponse,
  SystemResponse,
  WorkspaceSettings,
  SystemStatus,
  ProviderStatus,
  ProviderVerifyResponse,
  Workspace,
  WorkspaceAuthBackend,
  WorkspaceProvider,
  WorkspaceResponse,
  WorkspacesResponse,
} from '../../../shared/protocol.js'
import { FAST_MODE_BLURB, modelSupportsFastMode } from '../fastMode.js'
import { SHORTCUTS } from '../keys.js'
import { findModel, reloadModels, saveModelPrefs, useModelStore, useModels, usePickableModels } from '../models.js'
import { KIND_LABEL } from '../itemUi.js'
import { Select, SelectItem } from '../ui/Select.js'
import { readSessionDefaults, writeSessionDefaults, type SessionDefaults } from '../sessionDefaults.js'
import {
  APPEARANCE_DEFAULTS,
  chooseTheme,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  resolveTheme,
  useAppearance,
  writeAppearance,
  type ThemeMode,
} from '../appearance.js'
import { findTheme, THEMES, type Theme, type ThemeScheme } from '../themes.js'
import { closeSettings, SETTINGS_TABS, setSettingsTab, type SettingsTab } from '../settings.js'
import { anyDialogOpen, isTypingTarget } from '../keys.js'
import { store } from '../store.js'
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'
import { ConnectorsPanel } from './Connectors.js'
import { McpTab } from './McpTab.js'
import { PhoneTab } from './PhoneTab.js'
import { ProjectsTab } from './ProjectsTab.js'
import { TeamsTab } from './TeamsTab.js'
import { LibraryTab } from './LibraryTab.js'
import { RepoScopeEditor } from './RepoScope.js'
import { UsageTab } from './UsageTab.js'
import { ActivityTab, LogsTab, type SystemTab } from './SystemModal.js'
import { AuthCards, authTitle, ColorPicker } from './workspaceAuth.js'
import { PROVIDER_LABEL, ProviderIcon } from './ProviderIcon.js'
import { accountLine, ProviderUsage } from './ProviderUsage.js'
import { invalidateProviderStatus, loadProviderStatus, useProviderStatus } from '../providerStatus.js'

const ICONS: Record<SettingsTab, ComponentType<LucideProps>> = {
  workspace: Settings2,
  providers: Bot,
  sources: Plug,
  projects: Folder,
  models: Gauge,
  briefs: Sparkles,
  skills: WandSparkles,
  agents: BotMessageSquare,
  teams: Users,
  connectors: Plug,
  mcp: Cable,
  activity: Activity,
  usage: Wallet,
  logs: ScrollText,
  appearance: Palette,
  themes: SwatchBook,
  sessions: MessagesSquare,
  shortcuts: Keyboard,
  phone: Smartphone,
  about: Info,
}

type Props = {
  workspace: Workspace | null
  /** The tab in front — the route's. */
  tab: SettingsTab
  /** Open the system sheet (status · activity · logs) — leaves settings first. */
  onOpenSystem: (tab: SystemTab) => void
}

export function SettingsPage({ workspace, tab, onOpenSystem }: Props) {
  const meta = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0]
  // A read-out tab fills the pane and gets a Refresh button; the nonce it
  // drives resets per tab, so arriving somewhere never counts as a refresh.
  const fill = meta.fill === true
  const [nonce, setNonce] = useState(0)
  useEffect(() => setNonce(0), [tab])
  // On a phone the tab list is a sideways strip: keep the open tab in view.
  useEffect(() => {
    requestAnimationFrame(() =>
      document.querySelector('.settingsTab[data-state="active"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }),
    )
  }, [tab])
  // Esc leaves settings — but not from a field (it would throw away an edit)
  // or while a menu, select or dialog inside it is the thing Esc should close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e) || anyDialogOpen()) return
      closeSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const openSystem = useCallback(
    (t: SystemTab) => {
      closeSettings()
      onOpenSystem(t)
    },
    [onOpenSystem],
  )

  return (
        <div className="settings">
          <Tabs.Root
            value={tab}
            onValueChange={(v) => setSettingsTab(v as SettingsTab)}
            orientation="vertical"
            className="settingsTabs"
          >
            <nav className="settingsNav">
              <div className="settingsNavHead">
                <h1 className="title">Settings</h1>
                {workspace && (
                  <div className="settingsNavWs" title={`Workspace: ${workspace.name}`}>
                    <span className="wsDot" style={{ background: workspace.color }} aria-hidden="true" />
                    <span className="name">{workspace.name}</span>
                  </div>
                )}
              </div>
              <Tabs.List aria-label="Settings sections" className="settingsList">
                <div className="settingsNavGroup">This workspace</div>
                {SETTINGS_TABS.filter((t) => t.group === 'workspace').map((t) => (
                  <NavTab key={t.id} id={t.id} label={t.label} />
                ))}
                <div className="settingsNavGroup">Diagnostics</div>
                {SETTINGS_TABS.filter((t) => t.group === 'diagnostics').map((t) => (
                  <NavTab key={t.id} id={t.id} label={t.label} />
                ))}
                <div className="settingsNavGroup">This browser</div>
                {SETTINGS_TABS.filter((t) => t.group === 'app').map((t) => (
                  <NavTab key={t.id} id={t.id} label={t.label} />
                ))}
              </Tabs.List>
              <div className="settingsNavFoot">
                <kbd>Esc</kbd> goes back
              </div>
            </nav>

            <div className="settingsPane">
              <header className="settingsHead">
                <div>
                  <h2>{meta.label}</h2>
                  <p>{meta.sub}</p>
                </div>
                <span className="settingsHeadRight">
                  {fill && (
                    <button type="button" className="iconBtn" title="Refresh" aria-label="Refresh" onClick={() => setNonce((n) => n + 1)}>
                      <RefreshCw size={13} aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="iconBtn settingsClose" title="Close (Esc)" aria-label="Close settings" onClick={closeSettings}>
                    <X size={15} aria-hidden="true" />
                  </button>
                </span>
              </header>
              <div className={`settingsBody${fill ? ' fill' : ''}`}>
                <div className="inner">
                  <Tabs.Content value="workspace">
                    {workspace ? <WorkspaceTab key={workspace.id} workspace={workspace} /> : <Loading />}
                  </Tabs.Content>
                  <Tabs.Content value="providers">
                    {workspace?.providers ? (
                      <ProvidersTab key={workspace.id} workspace={workspace} />
                    ) : workspace ? (
                      <div className="msg">Restart the triage server to manage providers — it is still running an older build.</div>
                    ) : (
                      <Loading />
                    )}
                  </Tabs.Content>
                  <Tabs.Content value="sources">
                    <SourcesTab />
                  </Tabs.Content>
                  <Tabs.Content value="projects">
                    <ProjectsTab />
                  </Tabs.Content>
                  <Tabs.Content value="models">
                    <ModelsTab />
                  </Tabs.Content>
                  <Tabs.Content value="briefs">
                    <BriefsTab />
                  </Tabs.Content>
                  <Tabs.Content value="skills" className="settingsFill">
                    <LibraryTab kind="skill" refreshNonce={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="agents" className="settingsFill">
                    <LibraryTab kind="agent" refreshNonce={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="teams">
                    <TeamsTab />
                  </Tabs.Content>
                  <Tabs.Content value="connectors" className="settingsFill">
                    <ConnectorsPanel refreshNonce={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="mcp">
                    <McpTab workspace={workspace} />
                  </Tabs.Content>
                  <Tabs.Content value="activity" className="settingsFill">
                    <ActivityTab key={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="usage" className="settingsFill">
                    <UsageTab refreshNonce={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="logs" className="settingsFill">
                    <LogsTab key={nonce} />
                  </Tabs.Content>
                  <Tabs.Content value="appearance">
                    <AppearanceTab />
                  </Tabs.Content>
                  <Tabs.Content value="themes">
                    <ThemesTab />
                  </Tabs.Content>
                  <Tabs.Content value="sessions">
                    <SessionsTab />
                  </Tabs.Content>
                  <Tabs.Content value="shortcuts">
                    <ShortcutsTab />
                  </Tabs.Content>
                  <Tabs.Content value="phone">
                    <PhoneTab />
                  </Tabs.Content>
                  <Tabs.Content value="about">
                    <AboutTab onOpenSystem={openSystem} />
                  </Tabs.Content>
                </div>
              </div>
            </div>
          </Tabs.Root>
        </div>
  )
}

function NavTab({ id, label }: { id: SettingsTab; label: string }) {
  const Icon = ICONS[id]
  return (
    <Tabs.Trigger value={id} className="settingsTab">
      <Icon size={15} aria-hidden="true" />
      {label}
    </Tabs.Trigger>
  )
}

const Loading = () => <div className="pickerLoading">Loading…</div>

// ---------------------------------------------------------------------------
// Building blocks — a section with a heading, and a row: label left, control right.
// ---------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="setSection">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setRow">
      <div className="lbl">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  )
}

/** A save button plus a fading "Saved" — one idiom for every form here. */
function SaveRow({
  dirty,
  saving,
  saved,
  error,
  onSave,
  label = 'Save',
  children,
}: {
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string
  onSave: () => void
  label?: string
  children?: ReactNode
}) {
  return (
    <>
      {error && <div className="msg error">{error}</div>}
      <div className="setActions">
        <button type="button" className="btn primary" disabled={!dirty || saving} onClick={onSave}>
          {saving ? 'Saving…' : label}
        </button>
        {saved && !dirty && <span className="saved">Saved</span>}
        {children}
      </div>
    </>
  )
}

function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved])
  return [saved, () => setSaved(true)]
}

// ---------------------------------------------------------------------------
// Workspace — identity, default, delete.
// ---------------------------------------------------------------------------

function WorkspaceTab({ workspace }: { workspace: Workspace }) {
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
          hint="Unregisters it from triage. Its folder — database, secrets, logs — stays on disk; nothing is deleted."
        >
          <DeleteWorkspaceButton workspace={workspace} />
        </Section>
      )}
    </>
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

// ---------------------------------------------------------------------------
// Providers — every agent triage knows: connected or not, how it signs in,
// and what its own account says about the plan.
// ---------------------------------------------------------------------------

function ProvidersTab({ workspace }: { workspace: Workspace }) {
  const status = useProviderStatus(workspace.id)
  const connected = workspace.providers.filter((p) => p.connected).length
  return (
    <Section
      title={`${connected} of ${workspace.providers.length} connected`}
      hint={
        <>
          The primary agent runs everything — chats, watches, briefs and team workers. Any other you connect is offered in the
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

// ---------------------------------------------------------------------------
// Sources — GitHub scope, connectors.
// ---------------------------------------------------------------------------

function SourcesTab() {
  const [connectors, setConnectors] = useState<{ total: number; connected: number; slack: boolean } | 'loading' | 'error'>(
    'loading',
  )
  useEffect(() => {
    // The server hands back its cached probe; no subprocess is started for this.
    void fetch('/api/connectors')
      .then((r) => r.json() as Promise<ConnectorsResponse>)
      .then((b) => {
        if (!b.ok) return setConnectors('error')
        const live = b.connectors.filter((c) => c.status === 'connected')
        setConnectors({
          total: b.connectors.length,
          connected: live.length,
          slack: live.some((c) => /slack/i.test(c.name)),
        })
      })
      .catch(() => setConnectors('error'))
  }, [])

  return (
    <>
      <Section
        title="GitHub repos"
        hint="The GitHub source only pulls from the repos checked here, and the scope is per workspace. Nothing checked means no GitHub items in this inbox."
      >
        <RepoScopeEditor onSaved={() => {}} />
      </Section>

      <WatchesSwitchSection />

      <Section
        title="Slack and connectors"
        hint="Slack watches run through the claude.ai Slack connector on this workspace’s Claude login. Connectors are managed at claude.ai and in ~/.claude; this is the read-out."
      >
        <Row
          label="Connectors a session can reach"
          hint={
            connectors === 'loading'
              ? 'Reading the last probe…'
              : connectors === 'error'
                ? 'The probe could not be read.'
                : `${connectors.connected} of ${connectors.total} connected · Slack ${connectors.slack ? 'connected' : 'not connected'}`
          }
        >
          <button type="button" className="btn" onClick={() => setSettingsTab('connectors')}>
            See connectors
          </button>
        </Row>
      </Section>
    </>
  )
}

/** The workspace's server-side knobs (GET/PUT /api/settings), shared by two tabs. */
function useWorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => (b.ok ? setSettings(b.settings) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])
  const save = useCallback(async (patch: Partial<WorkspaceSettings>) => {
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const b = (await res.json()) as SettingsResponse
      if (b.ok) setSettings(b.settings)
      else setError(b.error)
    } catch (e) {
      setError(String(e))
    }
  }, [])
  return { settings, error, save }
}

/** The global watches switch — off by default in 0.7 (.docs/next-version.md) — and default run limits. */
function WatchesSwitchSection() {
  const { settings, error, save } = useWorkspaceSettings()
  const [timeoutMin, setTimeoutMin] = useState('')
  const [budget, setBudget] = useState('')
  useEffect(() => {
    if (!settings) return
    setTimeoutMin(String(Math.round(settings.watchTimeoutMs / 60_000)))
    setBudget(settings.watchBudgetUsd != null ? String(settings.watchBudgetUsd) : '')
  }, [settings])
  const saveTimeout = () => {
    const n = Number(timeoutMin)
    if (Number.isFinite(n) && n >= 1 && n <= 60 && settings && Math.round(n * 60_000) !== settings.watchTimeoutMs) void save({ watchTimeoutMs: Math.round(n * 60_000) })
  }
  const saveBudget = () => {
    const b = budget.trim() ? Number(budget) : null
    if (b === null || (Number.isFinite(b) && b > 0 && b <= 100)) void save({ watchBudgetUsd: b })
  }
  return (
    <Section
      title="Watches"
      hint="Scheduled scans that file work items on their own. Off by default: add items by hand or by pasting a link, and switch this on once the briefs you queue by hand have earned it."
    >
      <Row label="Run watches on a schedule" hint={settings?.watchesEnabled ? 'Due watches run every minute tick.' : 'The scheduler skips every watch. “Run now” on a watch still works.'}>
        <Switch.Root
          className="uiSwitch"
          checked={settings?.watchesEnabled ?? false}
          disabled={!settings}
          onCheckedChange={(on) => void save({ watchesEnabled: on })}
          aria-label="Run watches on a schedule"
        >
          <Switch.Thumb className="uiSwitchThumb" />
        </Switch.Root>
      </Row>
      <Row label="Default timeout" hint="Minutes a watch run may take before it is stopped and recorded as timed out. A watch can set its own.">
        <input className="setNum" inputMode="numeric" value={timeoutMin} disabled={!settings} onChange={(e) => setTimeoutMin(e.target.value)} onBlur={saveTimeout} aria-label="Default watch timeout in minutes" />
      </Row>
      <Row label="Default budget per run" hint="Dollars a watch run may spend before it stops. Blank = no cap. A watch can set its own.">
        <input className="setNum" inputMode="decimal" value={budget} placeholder="none" disabled={!settings} onChange={(e) => setBudget(e.target.value)} onBlur={saveBudget} aria-label="Default watch budget in dollars" />
      </Row>
      {error && <div className="msg error">{error}</div>}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Models — which models the pickers offer, and ids Claude Code doesn't list.
// ---------------------------------------------------------------------------

function ModelsTab() {
  const { catalog, hidden, custom, status, error } = useModelStore()
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const hiddenSet = new Set(hidden)

  const save = async (patch: Parameters<typeof saveModelPrefs>[0]) => setMsg(await saveModelPrefs(patch))
  const toggle = (id: string, show: boolean) =>
    save({ hiddenModels: show ? hidden.filter((h) => h !== id) : [...hidden, id] })
  const refresh = async () => {
    setBusy(true)
    await reloadModels(true)
    setBusy(false)
  }
  const addCustom = async () => {
    const id = draft.trim()
    if (!id) return
    if (findModel(catalog, id) || custom.includes(id)) return setMsg(`“${id}” is already in the list.`)
    await save({ customModels: [...custom, id] })
    setDraft('')
  }

  return (
    <>
      <Section
        title="Shown in the model picker"
        hint="Turn off the models you never use. A hidden model stays available to a session already on it, and models Claude Code adds later show up on their own."
      >
        {status === 'error' && (
          <div className="msg error">
            Could not load Claude Code’s model list{error ? `: ${error}` : ''}.
            {catalog.length > 0 && ' Showing the last list that loaded.'}
          </div>
        )}
        {catalog.map((m) => (
          <Row key={m.id} label={m.name} hint={m.description}>
            <Switch.Root
              className="uiSwitch"
              checked={!hiddenSet.has(m.id)}
              onCheckedChange={(on) => void toggle(m.id, on)}
              aria-label={`Show ${m.name} in the model picker`}
            >
              <Switch.Thumb className="uiSwitchThumb" />
            </Switch.Root>
          </Row>
        ))}
        <Row label="Model list" hint="Asked of Claude Code itself, so it follows the installed SDK. Check again after updating it.">
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={13} aria-hidden="true" /> {busy ? 'Checking…' : 'Check again'}
          </button>
        </Row>
      </Section>
      <Section
        title="Custom model ids"
        hint="For a model Claude Code doesn’t list yet, e.g. claude-opus-5-5. It is passed to Claude Code as typed, with no effort control."
      >
        {custom.map((id) => (
          <Row key={id} label={id}>
            <Switch.Root
              className="uiSwitch"
              checked={!hiddenSet.has(id)}
              onCheckedChange={(on) => void toggle(id, on)}
              aria-label={`Show ${id} in the model picker`}
            >
              <Switch.Thumb className="uiSwitchThumb" />
            </Switch.Root>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void save({ customModels: custom.filter((c) => c !== id), hiddenModels: hidden.filter((h) => h !== id) })}
            >
              Remove
            </button>
          </Row>
        ))}
        <Row label="Add a model id">
          <input
            className="setNum"
            style={{ width: 240 }}
            placeholder="claude-opus-5-5"
            value={draft}
            aria-label="Custom model id"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addCustom()}
          />
          <button type="button" className="btn" disabled={!draft.trim()} onClick={() => void addCustom()}>
            Add
          </button>
        </Row>
        {msg && <div className="msg error">{msg}</div>}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Briefs — the daily cap, the default model, and the two prose files per kind.
// ---------------------------------------------------------------------------

function BriefsTab() {
  const { settings, error, save } = useWorkspaceSettings()
  const models = useModels()
  const pickable = usePickableModels(settings?.briefsDefaultModel ?? undefined)
  const [cap, setCap] = useState<string>('')
  useEffect(() => {
    if (settings) setCap(String(settings.briefsDailyCap))
  }, [settings])

  return (
    <>
      <Section
        title="Running briefs"
        hint="A brief is a playbook run against one work item that writes a markdown document beside it. Runs queue in order, one at a time, and stop at the cap — nothing runs until you queue it."
      >
        <Row label="Daily cap" hint="How many brief runs may start per day in this workspace. The tail of a batch fails with a clear reason rather than running past it.">
          <input
            className="setNum"
            type="number"
            min={1}
            max={500}
            value={cap}
            disabled={!settings}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const n = Number(cap)
              if (settings && Number.isInteger(n) && n >= 1 && n <= 500 && n !== settings.briefsDailyCap) void save({ briefsDailyCap: n })
              else if (settings) setCap(String(settings.briefsDailyCap))
            }}
          />
        </Row>
        <Row label="Default model" hint="What a brief runs on when the Create-brief dialog doesn’t pick one. Cheaper models are usually enough for reading.">
          <Select
            className="setSelect"
            aria-label="Default model"
            value={settings?.briefsDefaultModel ?? ''}
            disabled={!settings}
            onValueChange={(v) => void save({ briefsDefaultModel: v || null })}
          >
            <SelectItem value="">Claude Code default</SelectItem>
            {pickable.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </Select>
        </Row>
        {settings?.briefsDefaultModel && !findModel(models, settings.briefsDefaultModel) && (
          <p className="hint">Default model “{settings.briefsDefaultModel}” is not in the probed list; it is passed through as-is.</p>
        )}
        {error && <div className="msg error">{error}</div>}
      </Section>
      <ProseFileSection
        title="Playbooks"
        hint="One markdown file per kind of work item — what to read, what to look for, the headings the brief should have. Edited here or in the file; a brief run pastes it into its first message."
        listUrl="/api/playbooks"
        fileUrl={(kind) => `/api/playbooks?kind=${encodeURIComponent(kind)}`}
      />
      <ProseFileSection
        title="Dispatch templates"
        hint="How a dispatched session opens, per kind. A tiny template: {{title}}, {{url}}, {{description}}, {{reason}}, {{note}}, and {{#brief}}…{{/brief}} when a brief exists."
        listUrl="/api/playbooks"
        fileUrl={(kind) => `/api/dispatch/template?kind=${encodeURIComponent(kind)}`}
      />
    </>
  )
}

/** A per-kind markdown file with a kind picker, a textarea and Save — playbooks and dispatch templates share it. */
function ProseFileSection({
  title,
  hint,
  listUrl,
  fileUrl,
}: {
  title: string
  hint: string
  listUrl: string
  fileUrl: (kind: string) => string
}) {
  const [kinds, setKinds] = useState<{ kind: string; custom: boolean }[]>([])
  const [kind, setKind] = useState('manual')
  const [body, setBody] = useState('')
  const [loaded, setLoaded] = useState('')
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch(listUrl)
      .then((r) => r.json() as Promise<PlaybooksResponse>)
      .then((b) => {
        if (b.ok) setKinds(b.playbooks.map((p) => ({ kind: p.kind, custom: p.custom })))
      })
      .catch(() => {})
  }, [listUrl])

  useEffect(() => {
    setError(null)
    void fetch(fileUrl(kind))
      .then((r) => r.json() as Promise<PlaybookResponse>)
      .then((b) => {
        if (b.ok) {
          setBody(b.body)
          setLoaded(b.body)
          setPath(b.path ?? '')
        } else setError(b.error)
      })
      .catch((e) => setError(String(e)))
  }, [kind, fileUrl])

  async function saveFile() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(fileUrl(kind), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const b = (await res.json()) as PlaybookResponse
      if (b.ok) {
        setLoaded(b.body)
        setKinds((prev) => prev.map((k) => (k.kind === kind ? { ...k, custom: b.custom ?? k.custom } : k)))
      } else setError(b.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const dirty = body !== loaded
  return (
    <Section title={title} hint={hint}>
      <div className="setPlaybook">
        <div className="head">
          <Select className="setSelect" value={kind} onValueChange={setKind} aria-label="Kind">
            {(kinds.length ? kinds : [{ kind: 'manual', custom: false }]).map((k) => (
              <SelectItem key={k.kind} value={k.kind}>
                {KIND_LABEL[k.kind as keyof typeof KIND_LABEL] ?? k.kind}
                {k.custom ? ' · edited' : ''}
              </SelectItem>
            ))}
          </Select>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={!dirty || saving} onClick={() => void saveFile()}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} aria-label={`${title} for ${kind}`} />
        {path && <div className="path" title={path}>{path}</div>}
        {error && <div className="msg error">{error}</div>}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Appearance — theme and text size (per browser).
// ---------------------------------------------------------------------------

/** A pill of mutually-exclusive options — the same idiom as the inbox filter. */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const THEME_OPTS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function AppearanceTab() {
  const a = useAppearance()
  return (
    <>
      <Section title="Theme">
        <Row label="Colour theme" hint={`${resolveTheme(a).name}${a.mode === 'system' ? ' — following your operating system' : ''}.`}>
          <button type="button" className="btn" onClick={() => setSettingsTab('themes')}>
            Browse themes
          </button>
        </Row>
      </Section>
      <Section
        title="Scale"
        hint="Text size nudges just the reading text. To scale the whole interface, use your browser's zoom (⌘+ / ⌘−)."
      >
        <Row label="Text size" hint={`Body text is ${a.fontSize}px${a.fontSize === FONT_DEFAULT ? ' (default)' : ''}.`}>
          <div className="fontSlider">
            <span className="a sm" aria-hidden="true">A</span>
            <Slider.Root
              className="uiSlider"
              min={FONT_MIN}
              max={FONT_MAX}
              step={1}
              value={[a.fontSize]}
              onValueChange={([fontSize]) => writeAppearance({ fontSize })}
            >
              <Slider.Track className="uiSliderTrack">
                <Slider.Range className="uiSliderRange" />
              </Slider.Track>
              <Slider.Thumb className="uiSliderThumb" aria-label="Text size" />
            </Slider.Root>
            <span className="a lg" aria-hidden="true">A</span>
            <span className="val">{a.fontSize}px</span>
          </div>
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Back to defaults" hint="Triage Dark, default text size.">
          <button type="button" className="btn" onClick={() => writeAppearance(APPEARANCE_DEFAULTS)}>
            Reset
          </button>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Themes — a gallery per scheme. The mode decides which pick is on screen.
// ---------------------------------------------------------------------------

function ThemesTab() {
  const a = useAppearance()
  const showing = resolveTheme(a)
  return (
    <>
      <Section title="Mode" hint="System follows your operating system’s light or dark setting and switches with it.">
        <Row label="Colour mode">
          <Segmented ariaLabel="Colour mode" value={a.mode} options={THEME_OPTS} onChange={(mode) => writeAppearance({ mode })} />
        </Row>
      </Section>
      <ThemeGallery scheme="dark" value={a.darkTheme} showing={showing} system={a.mode === 'system'} />
      <ThemeGallery scheme="light" value={a.lightTheme} showing={showing} system={a.mode === 'system'} />
    </>
  )
}

function ThemeGallery({
  scheme,
  value,
  showing,
  system,
}: {
  scheme: ThemeScheme
  value: string
  showing: Theme
  system: boolean
}) {
  const title = scheme === 'dark' ? 'Dark themes' : 'Light themes'
  const hint = system
    ? `Your ${scheme} pick shows whenever your operating system is in ${scheme} mode.`
    : showing.scheme === scheme
      ? 'Showing now. Pick one to switch.'
      : `Picking one switches to ${scheme} mode.`
  return (
    <Section title={title} hint={hint}>
      <RadioGroup.Root
        className="themeGrid"
        aria-label={title}
        value={value}
        onValueChange={(id) => {
          const theme = findTheme(id)
          if (theme) chooseTheme(theme)
        }}
      >
        {THEMES.filter((t) => t.scheme === scheme).map((t) => (
          <RadioGroup.Item key={t.id} value={t.id} className="themeCard" data-showing={t.id === showing.id || undefined}>
            <ThemePreview theme={t} />
            <span className="themeName">
              {t.name}
              {t.id === value && <Check size={13} aria-hidden="true" />}
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </Section>
  )
}

/**
 * A thumbnail of the workbench in a theme's own colours — painted from its
 * palette, not the live tokens, so every card shows itself whatever is active.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const p = theme.palette
  const line = (w: string, color: string) => <i style={{ width: w, background: color }} />
  return (
    <span className="themePreview" style={{ background: p.canvas }} aria-hidden="true">
      <span className="rail" style={{ background: p.card, borderColor: `${p.ink}14` }}>
        {line('70%', p.ink)}
        {line('50%', p.ash)}
        {line('60%', p.ash)}
      </span>
      <span className="main">
        {line('56%', p.ink)}
        {line('84%', p.mute)}
        {line('68%', p.mute)}
        <span className="code" style={{ background: p.deep }}>
          {line('40%', p.purple)}
          {line('62%', p.green)}
        </span>
        <span className="foot">
          <span className="dots">
            {[p.red, p.yellow, p.green, p.blue].map((c, i) => (
              <b key={i} style={{ background: c }} />
            ))}
          </span>
          <span className="btnPill" style={{ background: p.ink }} />
        </span>
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Sessions — defaults for new sessions (per browser).
// ---------------------------------------------------------------------------

function SessionsTab() {
  const [d, setD] = useState<SessionDefaults>(() => readSessionDefaults())
  const models = useModels()
  const fastOk = modelSupportsFastMode(models, d.model)

  const update = (patch: Partial<SessionDefaults>) => {
    writeSessionDefaults(patch)
    setD((prev) => ({ ...prev, ...patch }))
  }

  return (
    <>
      <Section
        title="New session defaults"
        hint="What a fresh draft starts with. A session’s own prompt box can still change any of these for that session, and the last pick there becomes the new default."
      >
        <Row label="Model and effort" hint="Leave unset to follow Claude Code’s own default.">
          <ModelPopover model={d.model} effort={d.effort} onModelChange={(model, effort) => update({ model, effort })} />
        </Row>
        <Row
          label="Fast mode"
          hint={fastOk ? FAST_MODE_BLURB : 'The chosen model does not support fast mode.'}
        >
          <Switch.Root
            className="uiSwitch"
            checked={d.fastMode && fastOk}
            disabled={!fastOk}
            onCheckedChange={(on) => update({ fastMode: on })}
            aria-label="Fast mode for new sessions"
          >
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </Row>
        <Row label="Permissions" hint="How much a new session asks before acting. Shift+Tab cycles it in the prompt box.">
          <PermissionModePicker mode={d.permissionMode} onChange={(permissionMode) => update({ permissionMode })} />
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Forget these defaults" hint="New sessions go back to Claude Code’s defaults and ask every time.">
          <button
            type="button"
            className="btn"
            onClick={() => update({ model: undefined, effort: undefined, fastMode: false, permissionMode: undefined })}
          >
            Reset
          </button>
        </Row>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Shortcuts — read-only for now.
// ---------------------------------------------------------------------------

function ShortcutsTab() {
  return (
    <Section title="Keys" hint="Single keys work outside text fields and while no dialog is open. ⌘K works everywhere.">
      <table className="setKeys">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// About — the daemon.
// ---------------------------------------------------------------------------

function AboutTab({ onOpenSystem }: { onOpenSystem: (t: SystemTab) => void }) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch('/api/system')
      .then((r) => r.json() as Promise<SystemResponse>)
      .then((b) => (b.ok ? setStatus(b.status) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])

  return (
    <>
      <Section title="triage" hint="A local web UI over the Claude Agent SDK. Everything runs on this machine; the daemon answers only this Mac (and phones you pair under Phone) and holds no Slack or GitHub credentials.">
        {error && <div className="msg error">{error}</div>}
        {status && (
          <>
            <div className="setKv">
              <span className="k">version</span>
              <span className="v">{status.version}</span>
            </div>
            <div className="setKv">
              <span className="k">port</span>
              <span className="v">{status.port}</span>
            </div>
            <div className="setKv">
              <span className="k">workspace</span>
              <span className="v">{status.workspace}</span>
            </div>
            <div className="setKv">
              <span className="k">database</span>
              <span className="v" title={status.db}>{status.db}</span>
            </div>
            <div className="setKv">
              <span className="k">logs</span>
              <span className="v" title={status.logDir ?? undefined}>{status.logDir ?? 'in-memory only'}</span>
            </div>
            <div className="setKv">
              <span className="k">live sessions</span>
              <span className="v">{status.liveSessions}</span>
            </div>
          </>
        )}
        {!status && !error && <Loading />}
      </Section>
      <Section title="Under the hood" hint="The daemon’s status sheet, and the diagnostics tabs here.">
        <div className="setActions">
          <button type="button" className="btn" onClick={() => onOpenSystem('status')}>
            <Gauge size={13} aria-hidden="true" /> Status
          </button>
          <button type="button" className="btn" onClick={() => setSettingsTab('activity')}>
            <Activity size={13} aria-hidden="true" /> Activity
          </button>
          <button type="button" className="btn" onClick={() => setSettingsTab('logs')}>
            <ScrollText size={13} aria-hidden="true" /> Logs
          </button>
          <button type="button" className="btn ghost" onClick={() => setSettingsTab('connectors')}>
            <Plug size={13} aria-hidden="true" /> Connectors
          </button>
        </div>
      </Section>
    </>
  )
}
