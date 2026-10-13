import { Activity, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleHelp, Gauge, PanelLeft, Plus, Settings, Settings2, SquareArrowOutUpRight } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { goBack, goForward, isDesktop, useDesktopNav } from '../desktop.js'
import { MOD_LABEL } from '../keys.js'

// Triage.app turns a same-origin window.open into its own window, not a tab.
const NEW_TAB = isDesktop ? 'a new window' : 'a new tab'
import type { Build, Workspace } from '../../../shared/protocol.js'
import type { ConnState } from '../store.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { basePath } from '../workspaceUrl.js'
import { TriageLogo } from './Logo.js'
import { ProvidersButton } from './ProvidersButton.js'

type Props = {
  /** Phone layout: a back button and the page title take the logo's place. */
  mobile?: boolean
  title?: string | null
  /** Where back goes from this page; absent on a section's own page. */
  onBack?: () => void
  workspaces: readonly Workspace[]
  workspaceId: string
  conn: ConnState
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onWorkspaceSettings: () => void
  onOpenSystem: (tab: 'status' | 'activity') => void
  onOpenSettings: () => void
  /** The settings page is in front — the gear shows it, and closes it. */
  settingsOpen?: boolean
  onHelp: () => void
  /** Which copy of triage is answering; null until `hello` lands. */
  build: Build | null
  /** Inside Triage.app: the bar is the window's title bar (see desktop.ts). */
  desktop?: { panelCollapsed: boolean; onTogglePanel: () => void }
}

/**
 * Which build am I looking at — the badge that ends the "wait, which triage is
 * this?" question. Three copies can run on one machine, so a released build
 * says nothing (that is the normal case, and noise there would be ignored) and
 * anything *ahead* of a release is called out. Clicking opens System status,
 * where the package root on disk settles any remaining doubt.
 */
function BuildBadge({ build, onOpenSystem }: { build: Build | null; onOpenSystem: (tab: 'status') => void }) {
  if (!build || build.channel === 'release') return null
  const dev = build.channel === 'dev'
  const title = dev
    ? `Development build — the working tree as it is now, on ${build.home}`
    : `Unreleased build${build.commit ? ` from ${build.commit}` : ''}${build.dirty ? ' (uncommitted changes)' : ''} — v${build.version}`
  return (
    <button type="button" className={`buildBadge ${build.channel}`} title={`${title}\nClick for system status`} onClick={() => onOpenSystem('status')}>
      {dev ? 'Dev' : 'Preview'}
      {build.dirty && <span className="buildDirty" aria-hidden="true" />}
    </button>
  )
}

const CONN_TITLE: Record<ConnState, string> = {
  connecting: 'Connecting to the daemon…',
  connected: 'Daemon connected — system status',
  disconnected: 'Daemon disconnected — retrying',
}

/** 44px top bar: the logo lockup, the workspace pill, then system / activity / settings / help. */
export function TopBar({
  mobile,
  title,
  onBack,
  workspaces,
  workspaceId,
  conn,
  onSwitchWorkspace,
  onNewWorkspace,
  onWorkspaceSettings,
  onOpenSystem,
  onOpenSettings,
  settingsOpen,
  onHelp,
  build,
  desktop,
}: Props) {
  const current = workspaces.find((w) => w.id === workspaceId)
  if (desktop && !mobile) {
    return (
      <DesktopBar
        {...desktop}
        switcher={
          <WorkspaceSwitcher
            labelled
            workspaces={workspaces}
            workspaceId={workspaceId}
            onSwitch={onSwitchWorkspace}
            onNew={onNewWorkspace}
            onSettings={onWorkspaceSettings}
          />
        }
        badge={<BuildBadge build={build} onOpenSystem={onOpenSystem} />}
        system={<SystemIcons workspace={current} conn={conn} onOpenSystem={onOpenSystem} onOpenSettings={onOpenSettings} settingsOpen={settingsOpen} onHelp={onHelp} />}
      />
    )
  }
  if (mobile) {
    return (
      <header className="topbar mobile">
        {onBack ? (
          <button type="button" className="topIcon back" aria-label="Back" onClick={onBack}>
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        ) : (
          <TriageLogo />
        )}
        {onBack && title && <span className="topTitle">{title}</span>}
        <span className="spacer" />
        <WorkspaceSwitcher
          workspaces={workspaces}
          workspaceId={workspaceId}
          onSwitch={onSwitchWorkspace}
          onNew={onNewWorkspace}
          onSettings={onWorkspaceSettings}
        />
        <BuildBadge build={build} onOpenSystem={onOpenSystem} />
        <button type="button" className="topIcon" aria-label={CONN_TITLE[conn]} onClick={() => onOpenSystem('status')}>
          <Gauge size={17} aria-hidden="true" />
          <span className={`connDot ${conn === 'connected' ? '' : conn === 'connecting' ? 'connecting' : 'down'}`} aria-hidden="true" />
        </button>
        <button type="button" className={`topIcon${settingsOpen ? ' on' : ''}`} aria-label="Settings" aria-pressed={!!settingsOpen} onClick={onOpenSettings}>
          <Settings size={17} aria-hidden="true" />
        </button>
      </header>
    )
  }
  return (
    <header className="topbar">
      <TriageLogo />
      <WorkspaceSwitcher
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSwitch={onSwitchWorkspace}
        onNew={onNewWorkspace}
        onSettings={onWorkspaceSettings}
      />
      <BuildBadge build={build} onOpenSystem={onOpenSystem} />
      <span className="spacer" />
      <SystemIcons workspace={current} conn={conn} onOpenSystem={onOpenSystem} onOpenSettings={onOpenSettings} settingsOpen={settingsOpen} onHelp={onHelp} />
    </header>
  )
}

/** Providers, system status, activity, settings, help — the right end of the bar. */
function SystemIcons({
  workspace,
  conn,
  onOpenSystem,
  onOpenSettings,
  settingsOpen,
  onHelp,
}: Pick<Props, 'conn' | 'onOpenSystem' | 'onOpenSettings' | 'settingsOpen' | 'onHelp'> & { workspace: Workspace | undefined }) {
  return (
    <>
      {/* a daemon from before providers sends none — it shows once that daemon restarts */}
      {workspace?.providers && <ProvidersButton workspace={workspace} />}
      <button type="button" className="topIcon" title={CONN_TITLE[conn]} onClick={() => onOpenSystem('status')}>
        <Gauge size={15} aria-hidden="true" />
        <span className={`connDot ${conn === 'connected' ? '' : conn === 'connecting' ? 'connecting' : 'down'}`} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title="Watch runs and activity" onClick={() => onOpenSystem('activity')}>
        <Activity size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`topIcon${settingsOpen ? ' on' : ''}`}
        title={settingsOpen ? 'Close settings (Esc)' : `Settings (${MOD_LABEL},)`}
        aria-pressed={!!settingsOpen}
        onClick={onOpenSettings}
      >
        <Settings size={15} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title="Keyboard shortcuts (?)" onClick={onHelp}>
        <CircleHelp size={15} aria-hidden="true" />
      </button>
    </>
  )
}

/**
 * Triage.app's title bar (.docs/titlebar-variations.html, E). Two zones that
 * line up with the columns below: over the rail + panel, the traffic lights,
 * the lockup, the panel toggle and ← →; over the content, the workspace and
 * the system icons. With the panel hidden the zones run together as one row.
 * Empty space drags the window; double-clicking it zooms (both native).
 */
function DesktopBar({
  panelCollapsed,
  onTogglePanel,
  switcher,
  badge,
  system,
}: {
  panelCollapsed: boolean
  onTogglePanel: () => void
  switcher: ReactNode
  badge: ReactNode
  system: ReactNode
}) {
  const nav = useDesktopNav()
  return (
    <header className={`topbar desktopBar${panelCollapsed ? ' panelHidden' : ''}${nav.fullscreen ? ' fullscreen' : ''}`}>
      <div className="dbSide">
        <TriageLogo />
        <span className="spacer" />
        <button
          type="button"
          className="topIcon"
          title={`${panelCollapsed ? 'Show' : 'Hide'} panel (${MOD_LABEL}B)`}
          aria-label={panelCollapsed ? 'Show panel' : 'Hide panel'}
          aria-pressed={!panelCollapsed}
          onClick={onTogglePanel}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <button type="button" className="topIcon" title={`Back (${MOD_LABEL}[)`} aria-label="Back" disabled={!nav.canGoBack} onClick={goBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className="topIcon" title={`Forward (${MOD_LABEL}])`} aria-label="Forward" disabled={!nav.canGoForward} onClick={goForward}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="dbMain">
        {switcher}
        {badge}
        <span className="spacer" />
        {system}
      </div>
    </header>
  )
}

/**
 * The workspace switcher (.docs/workspaces.md): which world am I in, and the
 * door to the others. The colour dot is the ambient signal; the menu lists
 * every workspace (active checked), plus New and Settings.
 */
function WorkspaceSwitcher({
  labelled,
  workspaces,
  workspaceId,
  onSwitch,
  onNew,
  onSettings,
}: {
  /** Triage.app's bar: a WORKSPACE eyebrow and the name at full size instead of the pill. */
  labelled?: boolean
  workspaces: readonly Workspace[]
  workspaceId: string
  onSwitch: (id: string) => void
  onNew: () => void
  onSettings: () => void
}) {
  // A tab is bound to its workspace by its URL, so a workspace row is really a
  // link: ⌘/Ctrl-click opens it in a second tab instead of moving this one.
  // Radix drives rows through `onSelect`, which does not carry the modifier —
  // the pointer event that preceded it does, so stash it there.
  const newTab = useRef(false)
  // The glyph swallows its own pointer events (below), so Radix never selects
  // the row for it and never closes the menu either — we hold `open` to do it.
  const [open, setOpen] = useState(false)
  const active = workspaces.find((w) => w.id === workspaceId)
  if (!active) return null // hello not in yet
  const openInNewTab = (id: string) => {
    window.open(basePath(id), '_blank', 'noopener')
    setOpen(false)
  }
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        newTab.current = false
        setOpen(next)
      }}
    >
      <MenuTrigger asChild>
        {labelled ? (
          <button type="button" className="wsLabelled" title={`Workspace: ${active.name}`}>
            <span className="wsLabel">Workspace</span>
            <span className="wsLabelSep" aria-hidden="true" />
            <span className="wsDot" style={{ background: active.color }} aria-hidden="true" />
            <span className="wsName">{active.name}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="wsPill" title={`Workspace: ${active.name}`}>
            <span className="wsDot" style={{ background: active.color }} aria-hidden="true" />
            <span className="wsName">{active.name}</span>
            <ChevronsUpDown size={11} aria-hidden="true" />
          </button>
        )}
      </MenuTrigger>
      <MenuContent align="start" className="wsMenu">
        {workspaces.map((w) => (
          <MenuItem
            key={w.id}
            title={`${w.name} — ${MOD_LABEL}-click to open in ${NEW_TAB}`}
            onPointerDown={(e) => (newTab.current = e.metaKey || e.ctrlKey || e.button === 1)}
            onSelect={() => {
              if (newTab.current) openInNewTab(w.id)
              else if (w.id !== workspaceId) onSwitch(w.id)
              newTab.current = false
            }}
          >
            <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
            <span className="wsMenuName">
              {w.name}
              {w.isDefault && <em className="wsDefaultTag">default</em>}
            </span>
            {/* The modifier, spelled out as a glyph. It keeps every pointer
                event to itself: Radix selects an item on click *and* on a
                pointer-up it did not see the pointer-down for, so letting any
                of the three through would also switch this tab. */}
            <span
              className="wsOpenTab"
              aria-hidden="true"
              title={`Open in ${NEW_TAB} (${MOD_LABEL}-click)`}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                openInNewTab(w.id)
              }}
            >
              <SquareArrowOutUpRight size={12} aria-hidden="true" />
            </span>
            {w.id === workspaceId && <Check size={13} aria-hidden="true" />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={onNew}>
          <Plus size={14} aria-hidden="true" />
          New workspace…
        </MenuItem>
        <MenuItem onSelect={onSettings}>
          <Settings2 size={14} aria-hidden="true" />
          Workspace settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
