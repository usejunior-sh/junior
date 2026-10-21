/**
 * The settings page (`#/settings/<tab>`): it takes the place of the panel and
 * the tabbed main area: a tab list down the left, one pane on the right. Every
 * tab is a destination in its own right: `openSettings('providers')` (or the
 * hash) lands on it with nothing to click through, which is what a "Fix" link
 * needs. Close and Esc go back to the page settings was opened from.
 *
 * Workspace-scoped tabs (Workspace · Claude auth · Sources · Projects) write to the
 * server; browser-scoped ones (Sessions · Shortcuts) write to localStorage.
 */
import * as Tabs from '@radix-ui/react-tabs'
import { type LucideProps, GitPullRequest, ShieldCheck, Settings2, Bot, Plug, Folder, Gauge, Sparkles, WandSparkles, BotMessageSquare, Users, Cable, Activity, Wallet, ScrollText, Palette, SwatchBook, MessagesSquare, Keyboard, Smartphone, Info, RefreshCw, X, Globe } from 'lucide-react'
import { type ComponentType, useState, useEffect, useCallback } from 'react'
import type { Workspace } from '../../../shared/protocol.js'
import { isTypingTarget, anyDialogOpen } from '../keys.js'
import { type SettingsTab, SETTINGS_TABS, closeSettings, setSettingsTab } from '../settings.js'
import { ConnectorsPanel } from './Connectors.js'
import { McpTab } from './McpTab.js'
import { PhoneTab } from './PhoneTab.js'
import { ProjectsTab } from './ProjectsTab.js'
import { LibraryTab } from './LibraryTab.js'
import { UsageTab } from './UsageTab.js'
import { type SystemTab, ActivityTab, LogsTab } from './SystemModal.js'
import { AppearanceTab, ThemesTab } from './settings/AppearanceTab.js'
import { BriefsTab } from './settings/BriefsTab.js'
import { BabysitTab } from './settings/BabysitTab.js'
import { ApprovalsTab } from './settings/ApprovalsTab.js'
import { BrowserTab } from './settings/BrowserTab.js'
import { ModelsTab } from './settings/ModelsTab.js'
import { ProvidersTab } from './settings/ProvidersTab.js'
import { AboutTab, SessionsTab, ShortcutsTab } from './settings/SessionsTab.js'
import { Loading } from './settings/shared.js'
import { SourcesTab } from './settings/SourcesTab.js'
import { WorkspaceTab } from './settings/WorkspaceTab.js'

const ICONS: Record<SettingsTab, ComponentType<LucideProps>> = {
  workspace: Settings2,
  providers: Bot,
  sources: Plug,
  projects: Folder,
  models: Gauge,
  briefs: Sparkles,
  babysit: GitPullRequest,
  approvals: ShieldCheck,
  browser: Globe,
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
  /** The tab in front: the route's. */
  tab: SettingsTab
  /** Open the system sheet (status · activity · logs), leaves settings first. */
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
  // Esc leaves settings, but not from a field (it would throw away an edit)
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
                  <Tabs.Content value="approvals">
                    <ApprovalsTab />
                  </Tabs.Content>
                  <Tabs.Content value="browser">
                    <BrowserTab />
                  </Tabs.Content>
                  <Tabs.Content value="babysit">
                    <BabysitTab />
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
