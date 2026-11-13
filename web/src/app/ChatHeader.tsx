import { Activity, FileDiff, FileText, Folder, Globe, Info, MessagesSquare, PanelRight } from 'lucide-react'
import { useMemo, type ReactNode, type RefObject } from 'react'
import { useScopedAgent } from '../chatAgents.js'
import { JuniorFace } from '../components/JuniorFace.js'
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
import { useEvents } from '../hooks.js'
import { todoProgress } from '../../../core/junior/now.js'
import { threadState } from '../../../core/junior/threads.js'
import { useSessionArtifacts } from '../artifactsClient.js'
import { useChatChanges, useChatThreads } from '../components/ChatSide.js'
import { Tooltip } from '../ui/Tooltip.js'

/** `/Users/you/Code/x` → `~/Code/x`: display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

/** Plain Junior's line under its name: the locked eyebrow (junior/CLAUDE.md). */
const JUNIOR_LINE = 'Your junior engineer. Runs on your Mac.'

type HeaderProps = {
  current: SessionSummary
  chatHeaderRef: RefObject<HTMLDivElement | null>
  currentCheckout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  agents: AgentRun[]
  openAgent: AgentRun | null
  showAgent: (toolUseId: string | null) => void
  mobile: boolean
  browserOpen: boolean
  onNavigate: (hash: string) => void
  /** Team layout: the face opens the agent's page instead of its card in the sidebar. */
  onAbout?: () => void
}

/**
 * The top of a chat. On a desktop, one bar: who you talk to (a DM shows the
 * agent's name and what it is for), what it is doing now, how full its
 * context is, then the chat's tools, each opening its tab in the sidebar.
 * A phone keeps a slim row with the tools as menus.
 */
export function ChatHeader(props: HeaderProps) {
  const { current, chatHeaderRef, currentCheckout, newTerminalIn, agents, openAgent, showAgent, mobile, onNavigate } = props
  const shown = shownStatus(current)
  const { colour, name } = useScopedAgent()
  if (!mobile) return <TopBar {...props} />
  return (
    <div id="chatHeader" ref={chatHeaderRef}>
      <span className="chFace" title={name}>
        <JuniorFace size={18} motion="still" colour={colour} decorative />
      </span>
      <span id="chatTitle" title={current.title}>
        {current.title}
      </span>
      <StatusDot status={shown.status} title={shown.title} />
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
        <SessionCost sessionId={current.id} status={current.status} workflows={current.workflows} kind={current.kind} compact />
      </span>
    </div>
  )
}

type HeadState = 'needs' | 'working' | 'error' | 'idle'

/** "drafting the reply" → "Drafting the reply". */
const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** The desktop bar. */
function TopBar({ current, chatHeaderRef, currentCheckout, newTerminalIn, agents, browserOpen, onAbout }: HeaderProps) {
  const dm = current.kind === 'dm'
  const shown = shownStatus(current)
  const { agent, colour } = useScopedAgent()
  const persona = usePersona()
  const side = useChatSide(current.id)
  const events = useEvents(current.id)
  const todo = useMemo(() => todoProgress(events), [events])
  const needs = needsYouText(current)
  const working = !needs && (shown.status === 'running' || shown.status === 'starting')
  const state: HeadState = needs ? 'needs' : working ? 'working' : shown.status === 'error' ? 'error' : 'idle'
  // What it is doing: its todo list's step, else what kind of work; nothing while idle.
  const line =
    state === 'needs'
      ? needs === 'Waiting on you'
        ? needs
        : `Waiting on you · ${needs}`
      : state === 'working'
        ? todo
          ? upperFirst(todo.activity)
          : (shown.title ?? (dm ? 'Replying to you' : 'Working'))
        : state === 'error'
          ? 'Stopped with an error'
          : null
  const label = agent?.label ?? persona.name
  const sub = dm ? agent?.description || (agent ? null : JUNIOR_LINE) : null
  const about = () => (onAbout ? onAbout() : chatSide.toggle(current.id, 'agent'))
  const mood = state === 'needs' ? 'needs' : state === 'working' ? 'working' : state === 'error' ? 'stuck' : 'hello'
  return (
    <div id="chatHeader" ref={chatHeaderRef} className={`chTop${dm ? ' dm' : ''}`}>
      {dm ? (
        <button type="button" className={`chWho${side === 'agent' ? ' on' : ''}`} title={`About ${label}`} aria-label={`About ${label}`} onClick={about}>
          <JuniorFace size={36} motion="still" mood={mood} colour={colour} decorative />
          <span className="chNames">
            <span className="chName">
              {label !== persona.name && (
                <>
                  <span className="jr">{persona.name}</span>
                  <span className="jrSep"> · </span>
                </>
              )}
              <b>{label}</b>
            </span>
            {sub && <span className="chSub">{sub}</span>}
          </span>
        </button>
      ) : (
        <span className="chWho">
          <JuniorFace size={20} motion="still" mood={mood} colour={colour} decorative />
          <span className="chNames">
            <span className="chName" title={current.title}>
              <b>{current.title}</b>
            </span>
          </span>
        </span>
      )}
      <span className="chRight">
        {line && (
          <span className={`chStatus ${state}`} title={line} aria-live="polite">
            <span className="d" aria-hidden="true" />
            <span className="t">{line}</span>
            {state === 'working' && todo && todo.of > 1 && (
              <span className="n">
                {todo.n}/{todo.of}
              </span>
            )}
          </span>
        )}
        <SessionCost sessionId={current.id} status={current.status} workflows={current.workflows} kind={current.kind} bar />
        <span className="chSep" aria-hidden="true" />
        <ChatTools current={current} checkout={currentCheckout} newTerminalIn={newTerminalIn} agents={agents} browserOpen={browserOpen} onAbout={dm ? undefined : about} />
      </span>
    </div>
  )
}

/**
 * The chat's tools, in the bar: each icon opens its tab in the sidebar, or
 * closes it when it is the one showing. Threads (what this chat handed out),
 * Changes, Artifacts, Background agents, Browser, then where it runs (Open
 * in), About (a chat's agent; a DM's face does this), and the sidebar toggle.
 */
function ChatTools({
  current,
  checkout,
  newTerminalIn,
  agents,
  browserOpen,
  onAbout,
}: {
  current: SessionSummary
  checkout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  agents: AgentRun[]
  browserOpen: boolean
  onAbout?: () => void
}) {
  const side = useChatSide(current.id)
  const artifacts = useSessionArtifacts(current.id).length
  const changed = useChatChanges(current.checkoutId)?.files.length ?? 0
  const threads = useChatThreads(current.id)
  const threadsWaiting = threads.filter((t) => threadState(t) === 'you').length
  const threadsBusy = threads.some((t) => threadState(t) === 'working')
  const browserTip = !hasBrowser ? 'Browser · in Junior.app' : browserOpen ? 'Hide the browser' : 'Browser'
  const tab = (name: Parameters<typeof chatSide.toggle>[1]) => ({
    type: 'button' as const,
    className: `ib${side === name ? ' on' : ''}`,
    'aria-pressed': side === name,
    onClick: () => chatSide.toggle(current.id, name),
  })
  return (
    <span className="chIcons" role="toolbar" aria-label="Chat tools">
      {(current.kind === 'dm' || threads.length > 0) && (
        <HeadTip
          label="Threads"
          note={threads.length ? `${threads.length} handed off from this chat${threadsWaiting ? `, ${threadsWaiting} waiting on you` : ''}` : 'none handed off yet'}
        >
          <button {...tab('threads')} aria-label={`Threads from this chat, ${threads.length}`}>
            <MessagesSquare size={15} aria-hidden="true" />
            {threadsWaiting ? (
              <span className="ibNeeds" aria-hidden="true" />
            ) : threadsBusy ? (
              <span className="ibLive" aria-hidden="true" />
            ) : (
              threads.length > 0 && <span className="ibCount">{threads.length}</span>
            )}
          </button>
        </HeadTip>
      )}
      {current.checkoutId && (
        <HeadTip label="Changes" note={changed ? `${changed} ${changed === 1 ? 'file' : 'files'} in this folder` : 'nothing uncommitted'}>
          <button {...tab('changes')} aria-label={`Changes in this folder, ${changed}`}>
            <FileDiff size={15} aria-hidden="true" />
            {changed > 0 && <span className="ibCount">{changed}</span>}
          </button>
        </HeadTip>
      )}
      <HeadTip label="Artifacts" note={artifacts ? `${artifacts} from this chat` : 'none from this chat yet'}>
        <button {...tab('artifacts')} aria-label={`Artifacts from this chat, ${artifacts}`}>
          <FileText size={15} aria-hidden="true" />
          {artifacts > 0 && <span className="ibCount">{artifacts}</span>}
        </button>
      </HeadTip>
      {agents.length > 0 && (
        <HeadTip label="Background agents" note={agentsTitle(agents).replace(/^Background agents · /, '')}>
          <button {...tab('agents')} aria-label={`Background agents, ${agents.length}`}>
            <AgentsIcon agents={agents} />
          </button>
        </HeadTip>
      )}
      <HeadTip label={browserTip}>
        <BrowserButton sessionId={current.id} open={browserOpen} bare />
      </HeadTip>
      <HeadTip label="Open in…" note={checkout ? 'Finder, your editor, a terminal' : 'copy the folder path'}>
        <OpenIn current={current} checkout={checkout} newTerminalIn={newTerminalIn} align="end" bare />
      </HeadTip>
      {onAbout && (
        <HeadTip label="About" note="who this chat talks as">
          <button type="button" className={`ib${side === 'agent' ? ' on' : ''}`} aria-label="About" aria-pressed={side === 'agent'} onClick={onAbout}>
            <Info size={15} aria-hidden="true" />
          </button>
        </HeadTip>
      )}
      <HeadTip label={side ? 'Hide the sidebar' : 'Show the sidebar'} keys="⌘⌥B">
        <button
          type="button"
          className={`ib${side ? ' on' : ''}`}
          aria-label={side ? 'Hide the sidebar' : 'Show the sidebar'}
          aria-pressed={!!side}
          onClick={() => chatSide.toggleOpen(current.id)}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
      </HeadTip>
    </span>
  )
}

/**
 * A tool's tooltip: the name, its key, and a line of what's there, opening
 * below. The span gives Radix a box to anchor on, so a menu trigger inside
 * (Open in) keeps working.
 */
function HeadTip({ label, note, keys, children }: { label: string; note?: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip
      side="bottom"
      align="center"
      delay={250}
      className="railTip"
      content={
        <>
          <span className="rtName">{label}</span>
          {keys && <span className="rtKeys">{keys}</span>}
          {note && <span className="rtNote">{note}</span>}
        </>
      }
    >
      <span className="trTip">{children}</span>
    </Tooltip>
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
  bare = false,
}: {
  current: SessionSummary
  checkout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  align: 'start' | 'end'
  /** a tooltip outside names it: no native title */
  bare?: boolean
}) {
  if (!checkout)
    return (
      <button
        type="button"
        className="ib"
        title={bare ? undefined : `${homely(current.cwd)} · click to copy the path`}
        aria-label="Copy the folder path"
        onClick={() => void navigator.clipboard?.writeText(current.cwd).catch(() => {})}
      >
        <Folder size={15} aria-hidden="true" />
      </button>
    )
  return (
    <CheckoutMenu checkout={checkout} align={align} onNewTerminal={() => newTerminalIn(checkout.id)}>
      <button type="button" className="ib" title={bare ? undefined : `Open in… · ${homely(checkout.path)}`} aria-label="Open in">
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
export function BrowserButton({ sessionId, open, className = '', bare = false }: { sessionId: string; open: boolean; className?: string; /** a tooltip outside names it: no native title */ bare?: boolean }) {
  const tab = useBrowserTab(sessionId)
  const snap = useBrowserProfiles()
  const profile = profileById(snap, tab?.effectiveProfile)
  const other = !!profile && !!snap && profile.id !== snap.workspaceDefault
  return (
    <button
      type="button"
      className={`ib${className ? ` ${className}` : ''}${open ? ' on' : ''}`}
      title={
        bare
          ? undefined
          : !hasBrowser
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
