import { Activity, ChevronRight, Folder, Globe } from 'lucide-react'
import { useScopedAgent } from '../chatAgents.js'
import { JuniorFace } from '../components/JuniorFace.js'
import type { RefObject } from 'react'
import type { SessionStatus, SessionSummary } from '../../../shared/protocol.js'
import { checkoutOf } from '../checkouts.js'
import { CheckoutMenu } from '../components/CheckoutMenu.js'
import { hasBrowser, browserPane, profileById, useBrowserProfiles, useBrowserTab } from '../browser.js'
import { ProfileDot } from '../components/browser/ProfileMenu.js'
import { SessionCost } from '../components/SessionCost.js'
import { AgentsMenu } from '../components/Agents.js'
import { ArtifactsMenu } from '../components/SessionArtifacts.js'
import { usePersona } from '../junior.js'
import { chatSide, useChatSide } from '../chatSide.js'
import type { AgentRun } from '../agents.js'
import { shownStatus } from '../sessionModes.js'
import { needsYouText } from '../inboxTabs.js'

/** `/Users/you/Code/x` → `~/Code/x`: display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

/**
 * The top of a chat (variant I, artifact 9d492a83). On a desktop: a DM gets a
 * floating pill with the agent's face, name and status dot; any other chat a
 * slim row with the face, title and dot. Its tools live in the right rail
 * (ToolRail.tsx). A phone has no rail, so there the row also carries the tools,
 * as menus.
 */
export function ChatHeader({
  current,
  chatHeaderRef,
  currentCheckout,
  newTerminalIn,
  agents,
  openAgent,
  showAgent,
  mobile,
  onNavigate,
}: {
  current: SessionSummary
  chatHeaderRef: RefObject<HTMLDivElement | null>
  currentCheckout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  agents: AgentRun[]
  openAgent: AgentRun | null
  showAgent: (toolUseId: string | null) => void
  mobile: boolean
  onNavigate: (hash: string) => void
}) {
  const shown = shownStatus(current)
  const { agent, colour, name } = useScopedAgent()
  const persona = usePersona()
  const dot = <StatusDot status={shown.status} title={shown.title} />
  if (current.kind === 'dm' && !mobile)
    return <DmPill current={current} label={agent?.label ?? persona.name} colour={colour} headerRef={chatHeaderRef} />
  return (
    <div id="chatHeader" ref={chatHeaderRef}>
      <span className="chFace" title={name}>
        <JuniorFace size={18} motion="still" colour={colour} decorative />
      </span>
      <span id="chatTitle" title={current.title}>
        {current.title}
      </span>
      {dot}
      {mobile && (
        <span className="chIcons">
          <ArtifactsMenu sessionId={current.id} onNavigate={onNavigate} compact />
          {agents.length > 0 && (
            <AgentsMenu agents={agents} current={openAgent?.toolUseId} onOpen={showAgent}>
              <button type="button" className="ib" title={agentsTitle(agents)} aria-label={`Background agents, ${agents.length}`}>
                <AgentsIcon agents={agents} />
              </button>
            </AgentsMenu>
          )}
          <OpenIn current={current} checkout={currentCheckout} newTerminalIn={newTerminalIn} align="end" />
          <SessionCost sessionId={current.id} status={current.status} workflows={current.workflows} compact />
        </span>
      )}
    </div>
  )
}

/**
 * A DM's pill (P5, artifact 9d492a83): "Junior · Writer". While the agent works,
 * a sky light sweeps round the pill's edge, and that alone says so; when it
 * needs you, the edge turns orange and a second line says what for. Hovering
 * grows it and shows a chevron: click it for the agent's card in the sidebar,
 * again to close it.
 */
function DmPill({ current, label, colour, headerRef }: { current: SessionSummary; label: string; colour: string | undefined; headerRef: RefObject<HTMLDivElement | null> }) {
  const open = useChatSide(current.id) === 'agent'
  const persona = usePersona()
  const shown = shownStatus(current)
  const needs = needsYouText(current)
  const working = !needs && (shown.status === 'running' || shown.status === 'starting')
  const state = needs ? 'needs' : working ? 'working' : shown.status === 'error' ? 'error' : 'idle'
  const line = needs ? (needs === 'Waiting on you' ? needs : `Waiting on you · ${needs}`) : state === 'error' ? 'Stopped with an error' : null
  const jr = label !== persona.name
  return (
    <div className="dmPillWrap" ref={headerRef}>
      <button
        type="button"
        className={`dmPill ${state}${open ? ' on' : ''}`}
        title={working ? `${label} is working · about ${label}` : open ? `Hide ${label}'s card` : `About ${label}`}
        aria-pressed={open}
        onClick={() => chatSide.toggle(current.id, 'agent')}
      >
        <JuniorFace size={25} motion="still" mood={state === 'needs' ? 'needs' : state === 'working' ? 'working' : 'hello'} colour={colour} decorative />
        <span className="tx">
          <span className="nm">
            {jr && (
              <>
                <span className="jr">{persona.name}</span>
                <span className="jrSep"> · </span>
              </>
            )}
            {label}
          </span>
          {line && (
            <span className="step" aria-live="polite">
              {line}
            </span>
          )}
        </span>
        <ChevronRight className="chev" size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

/** One dot for the chat's state: sky while it works, red on an error, quiet otherwise. Its word is the tooltip. */
function StatusDot({ status, title }: { status: SessionStatus; title?: string }) {
  const live = status === 'running' || status === 'starting'
  return (
    <span
      className={`chDot dot ${live ? 'live' : status === 'error' ? 'red' : 'idle'}`}
      title={title ?? STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
      role="img"
    />
  )
}

export const agentsTitle = (agents: AgentRun[]) => {
  const running = agents.filter((a) => a.state === 'running').length
  return `Background agents · ${agents.length}${running ? `, ${running} running` : ''}`
}

/** The background-agents icon: its count, or a live dot while one runs. */
export function AgentsIcon({ agents }: { agents: AgentRun[] }) {
  const running = agents.some((a) => a.state === 'running')
  return (
    <>
      <Activity size={15} aria-hidden="true" />
      {running ? <span className="ibLive" aria-hidden="true" /> : <span className="ibCount">{agents.length}</span>}
    </>
  )
}

/** Open in: the folder's menu (editors, Finder, a terminal, copy path); without a checkout, a copy-path button. */
export function OpenIn({
  current,
  checkout,
  newTerminalIn,
  align,
}: {
  current: SessionSummary
  checkout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  align: 'start' | 'end'
}) {
  if (!checkout)
    return (
      <button
        type="button"
        className="ib"
        title={`${homely(current.cwd)} · click to copy the path`}
        aria-label="Copy the folder path"
        onClick={() => void navigator.clipboard?.writeText(current.cwd).catch(() => {})}
      >
        <Folder size={15} aria-hidden="true" />
      </button>
    )
  return (
    <CheckoutMenu checkout={checkout} align={align} onNewTerminal={() => newTerminalIn(checkout.id)}>
      <button type="button" className="ib" title={`Open in… · ${homely(checkout.path)}`} aria-label="Open in">
        <Folder size={15} aria-hidden="true" />
      </button>
    </CheckoutMenu>
  )
}

/**
 * The chat's Browser icon (not on a phone; outside Junior.app the pane says
 * where the browser lives). Once the chat uses a profile other than the
 * workspace's default, a small swatch sits on the icon and the tooltip names it.
 */
export function BrowserButton({ sessionId, open }: { sessionId: string; open: boolean }) {
  const tab = useBrowserTab(sessionId)
  const snap = useBrowserProfiles()
  const profile = profileById(snap, tab?.effectiveProfile)
  const other = !!profile && !!snap && profile.id !== snap.workspaceDefault
  return (
    <button
      type="button"
      className={`ib${open ? ' on' : ''}`}
      title={
        !hasBrowser
          ? 'Browser · open Junior.app: the browser lives there.'
          : open
            ? 'Hide the browser'
            : `Browser${profile ? ` · ${profile.name}` : ''}`
      }
      aria-label={open ? 'Hide the browser' : 'Show the browser'}
      aria-pressed={open}
      onClick={() => browserPane.set(sessionId, !open)}
    >
      <Globe size={15} aria-hidden="true" />
      {other && (
        <span className="ibProfile">
          <ProfileDot profile={profile} size={6} />
        </span>
      )}
    </button>
  )
}
