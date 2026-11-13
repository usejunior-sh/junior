/**
 * The team sidebar (.docs/redesign-b2-plan.md, .docs/sidebar-concepts.html 01):
 * everything you talk to is a conversation row. Search and the four places on
 * top, then Junior pinned first, speaking one line (core/junior/say.ts), then
 * the open threads, then the agents with their latest line. Quiet agents fold
 * into one row. Settings at the bottom.
 */
import { CalendarClock, FileText, GitPullRequest, ListChecks, PanelLeft, Plus, Search, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { JUNIOR_DM, dmKey, findDm } from '../../../core/junior/dms.js'
import { juniorSays, type SayNeed } from '../../../core/junior/say.js'
import { agentStatus, openThreads, THREADS_SHOWN, type AgentStatus, type Thread } from '../../../core/junior/threads.js'
import type { SessionSummary } from '../../../shared/protocol.js'
import { useChatAgents } from '../chatAgents.js'
import { useInbox } from '../inboxStore.js'
import { usePersona, useYouName } from '../junior.js'
import { markThreadSeen, useThreadSeen } from '../threadSeen.js'
import { isWorking } from '../sessionModes.js'
import { setSidebarCollapsed } from '../layout.js'
import { JuniorFace } from './JuniorFace.js'
import { relTime } from '../itemUi.js'
import { MOD_LABEL } from '../keys.js'

export type SidebarPlace = 'junior' | 'tasks' | 'prs' | 'artifacts' | 'jobs' | 'settings' | { agent: string } | { thread: string } | null

type Props = {
  sessions: readonly SessionSummary[]
  /** sends drafted and waiting for your OK */
  pendingSends: number
  /** what is in front, to mark it */
  active: SidebarPlace
  taskCount: number
  prCount: number
  onJunior: () => void
  onAgent: (name: string) => void
  onThread: (id: string) => void
  onPlace: (place: 'tasks' | 'prs' | 'artifacts' | 'jobs') => void
  onNewAgent: () => void
  /** the command palette (⌘K) */
  onSearch: () => void
  onSettings: () => void
}

/** How long "Got it. Reviewer has #512 now." stays before the card goes back to the state of things. */
const HANDED_OFF_MS = 4_000

const today = () => new Date().toDateString()
const HELLO_KEY = 'junior.sidebar.hello'

/** The first open of the day says hello once; read when the sidebar mounts. */
function useFirstOpenToday(): boolean {
  const [first] = useState(() => {
    try {
      const was = localStorage.getItem(HELLO_KEY)
      localStorage.setItem(HELLO_KEY, today())
      return was !== today()
    } catch {
      return false
    }
  })
  return first
}

/** A thread Junior just started: shown for a few seconds as "Got it. <Agent> has <title> now." */
function useHandedOff(threads: readonly Thread[], label: (agent?: string) => string): { to: string; title: string } | null {
  const seen = useRef<Set<string> | null>(null)
  const [flash, setFlash] = useState<{ to: string; title: string } | null>(null)
  useEffect(() => {
    const ids = new Set(threads.map((t) => t.id))
    if (seen.current) {
      const fresh = threads.find((t) => t.fromJunior && !seen.current!.has(t.id))
      if (fresh) setFlash({ to: label(fresh.agent), title: fresh.title })
    }
    seen.current = new Set([...(seen.current ?? []), ...ids])
  }, [threads, label])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), HANDED_OFF_MS)
    return () => clearTimeout(t)
  }, [flash])
  return flash
}

export function TeamSidebar(p: Props) {
  const persona = usePersona()
  const you = useYouName()
  const agents = useChatAgents()
  const inbox = useInbox()
  const [now, setNow] = useState(() => Date.now())
  // Ready threads age out of the list and "waited 40 minutes" moves: a slow clock is enough.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const [showAll, setShowAll] = useState(false)
  const [allAgents, setAllAgents] = useState(false)

  const labelOf = useMemo(() => {
    const byName = new Map(agents.map((a) => [a.name, a]))
    return (agent?: string) => (agent ? byName.get(agent)?.label ?? agent : persona.name)
  }, [agents, persona.name])
  const colourOf = useMemo(() => {
    const byName = new Map(agents.map((a) => [a.name, a.colour]))
    return (agent?: string) => (agent ? byName.get(agent) ?? undefined : undefined)
  }, [agents])

  const threads = useMemo(() => openThreads(p.sessions, now), [p.sessions, now])
  const wasSeen = useThreadSeen()
  // The thread in front counts as looked at.
  const activeThread = p.active && typeof p.active === 'object' && 'thread' in p.active ? p.active.thread : null
  useEffect(() => {
    const t = activeThread ? threads.find((x) => x.id === activeThread) : undefined
    if (t) markThreadSeen(t.id, t.updatedAt)
  }, [activeThread, threads])
  const handedOff = useHandedOff(threads, labelOf)
  const firstOpen = useFirstOpenToday()

  // What Junior says: everything waiting on you, what broke, what runs.
  const say = useMemo(() => {
    const needs: SayNeed[] = threads.filter((t) => t.state === 'you').map((t) => ({ title: t.title, question: t.question, ...(t.agent ? { from: labelOf(t.agent) } : {}), since: t.updatedAt }))
    // A DM waiting on you counts too: it is not a thread, but it is your turn.
    for (const s of p.sessions) if (s.kind === 'dm' && s.waiting) needs.push({ title: `your chat with ${labelOf(s.agent)}`, question: s.waitingOn === 'AskUserQuestion', since: s.updatedAt })
    for (let i = 0; i < p.pendingSends; i++) needs.push({ title: p.pendingSends === 1 ? 'A send waits for your OK' : 'a send waits for your OK' })
    const broken = threads.find((t) => t.state === 'stopped')
    const alert = inbox.alerts[0]
    const stuck = broken ? { title: `${labelOf(broken.agent)} stopped on ${broken.title}` } : alert ? { title: alert.title } : null
    const working = p.sessions.filter((s) => (s.kind ?? 'chat') !== 'brief' && isWorking(s)).length
    const ready = threads.filter((t) => t.state === 'ready' && t.fromJunior && !wasSeen(t.id, t.updatedAt)).map((t) => ({ title: t.title }))
    return { ...juniorSays({ you, needs, stuck, working, ready, handedOff, firstOpenToday: firstOpen, now }), needs: needs.length }
  }, [threads, p.sessions, p.pendingSends, inbox.alerts, labelOf, you, handedOff, firstOpen, now, wasSeen])

  // Agents as conversations: busy ones first, then the ones you talked to lately, newest first. The rest fold into one row.
  const agentRows = useMemo(() => {
    const rank = { you: 0, working: 1, idle: 2 } as const
    const rows = agents.map((a, i) => {
      const dm = findDm(p.sessions, dmKey(a.name))
      const st = agentStatus(a.name, p.sessions, a.description)
      const state: AgentState = st.state === 'you' || dm?.waiting ? 'you' : st.state
      return { a, i, st, dm, state, recent: !!dm?.lastLine && now - dm.updatedAt < RECENT_MS }
    })
    rows.sort((x, y) => rank[x.state] - rank[y.state] || (y.dm?.updatedAt ?? 0) - (x.dm?.updatedAt ?? 0) || x.i - y.i)
    return rows
  }, [agents, p.sessions, now])
  const isActive = (place: SidebarPlace) => JSON.stringify(place) === JSON.stringify(p.active)
  // Busy, recent and open agents keep their rows, and never fewer than AGENTS_SHOWN: the list is never just the fold.
  const shownAgents = agentRows.filter((r, i) => allAgents || i < AGENTS_SHOWN || r.state !== 'idle' || r.recent || isActive({ agent: r.a.name }))
  const folded = agentRows.filter((r) => !shownAgents.includes(r))
  // Only the threads where it is your turn; the rest show as a working agent in Team, and in Junior's line.
  const waiting = useMemo(() => threads.filter((t) => t.state === 'you'), [threads])
  const shownThreads = showAll ? waiting : waiting.slice(0, THREADS_SHOWN)
  const juniorDm = findDm(p.sessions, JUNIOR_DM)
  const juniorBusy = !!juniorDm && isWorking(juniorDm)

  return (
    <nav className="teamSide" aria-label="Junior and the team">
      <button type="button" className="tsFind" onClick={p.onSearch}>
        <Search size={14} aria-hidden="true" />
        <span className="tsGrow">Search or jump to</span>
        <kbd>{MOD_LABEL}K</kbd>
      </button>

      <div className="tsPlaces" role="group" aria-label="Places">
        <Place on={isActive('tasks')} icon={<ListChecks size={17} aria-hidden="true" />} label="Tasks" count={p.taskCount} onClick={() => p.onPlace('tasks')} />
        <Place on={isActive('prs')} icon={<GitPullRequest size={17} aria-hidden="true" />} label="PRs" title="Pull requests" count={p.prCount} onClick={() => p.onPlace('prs')} />
        <Place on={isActive('artifacts')} icon={<FileText size={17} aria-hidden="true" />} label="Artifacts" onClick={() => p.onPlace('artifacts')} />
        <Place on={isActive('jobs')} icon={<CalendarClock size={17} aria-hidden="true" />} label="Jobs" onClick={() => p.onPlace('jobs')} />
      </div>

      {/* Junior: a conversation row like the ones below, pinned first and a little bigger, so it opens like they do. */}
      <button
        type="button"
        className={`tsConv tsJunior${isActive('junior') ? ' on' : ''}`}
        aria-current={isActive('junior') ? 'page' : undefined}
        onClick={p.onJunior}
      >
        <span className={`tsRing${say.needs ? ' you' : juniorBusy ? ' work' : ''}`}>
          <JuniorFace mood={say.mood} size={38} motion="follow" decorative />
        </span>
        <span className="tsT">
          <span className="tsL1">
            <b>{persona.name}</b>
            {/* No time here: Junior's line is about now, not about when the chat last moved. */}
            {juniorBusy && <Typing />}
          </span>
          <span className="tsL2" aria-live="polite">
            <span>
              {say.lead && <em>{say.lead}</em>} {say.rest}
            </span>
          </span>
        </span>
        {say.needs > 0 && (
          <span className="tsBadge" aria-label={`${say.needs} need you`}>
            {say.needs}
          </span>
        )}
      </button>

      <div className="tsScroll">
        {/* What waits on you, as one card under Junior. Nothing waiting: no card, Junior's line already says so. */}
        {waiting.length > 0 && (
          <section className="tsWaiting" aria-label="Waiting on you">
            <div className="tsWaitHead">
              <span className="tsGrow">Waiting on you</span>
              <span>{waiting.length}</span>
            </div>
            {shownThreads.map((t) => (
              <ThreadRow key={t.id} t={t} agentLabel={labelOf(t.agent)} colour={colourOf(t.agent)} active={isActive({ thread: t.id })} onOpen={() => p.onThread(t.id)} />
            ))}
            {waiting.length > THREADS_SHOWN && (
              <button type="button" className="tsWaitMore" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${waiting.length}`}
              </button>
            )}
          </section>
        )}

        <div className="tsLabel">
          <span className="tsGrow">
            Team{agentRows.length > 0 && <span className="tsN">{agentRows.length}</span>}
          </span>
          <button type="button" className="tsLabelBtn" title={`Ask ${persona.name} for a new agent`} aria-label={`Ask ${persona.name} for a new agent`} onClick={p.onNewAgent}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {shownAgents.map((r) => (
          <AgentRow
            key={r.a.name}
            label={r.a.label}
            description={r.a.description}
            colour={r.a.colour ?? undefined}
            st={r.st}
            state={r.state}
            dm={r.dm}
            active={isActive({ agent: r.a.name })}
            onOpen={() => p.onAgent(r.a.name)}
          />
        ))}
        {folded.length > 0 && (
          <button type="button" className="tsThread tsAg tsFolded" title={`Show ${folded.map((r) => r.a.label).join(', ')}`} onClick={() => setAllAgents(true)}>
            <JuniorFace size={22} motion="still" mood="hello" colour={folded[0].a.colour ?? undefined} decorative />
            <span className="tsTitle">{foldedNames(folded.map((r) => r.a.label))}</span>
          </button>
        )}
        {allAgents && agentRows.length > AGENTS_SHOWN && agentRows.some((r) => r.state === 'idle' && !r.recent) && (
          <button type="button" className="tsMore" onClick={() => setAllAgents(false)}>
            Show fewer
          </button>
        )}
      </div>

      <div className="tsFoot">
        <button type="button" className={`tsSettings${isActive('settings') ? ' on' : ''}`} aria-current={isActive('settings') ? 'page' : undefined} onClick={p.onSettings}>
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  )
}

type AgentState = 'you' | 'working' | 'idle'

/** Agents always shown before the fold. */
const AGENTS_SHOWN = 3
/** An agent you talked to within this long keeps its own row; older quiet ones fold. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000

const ago = (ms: number) => (Date.now() - ms < 45_000 ? 'now' : relTime(ms))

/** "Brief · Explainer · Elon", or "Brief · Explainer · +3" past three. */
function foldedNames(names: string[]): string {
  return names.length <= 3 ? names.join(' · ') : `${names.slice(0, 2).join(' · ')} · +${names.length - 2}`
}

function Typing() {
  return (
    <span className="tsTyping" aria-label="replying">
      <i />
      <i />
      <i />
    </span>
  )
}

/** One of the four places: an icon, its name, and a count when there is something to look at. */
function Place({ on, icon, label, title, count, onClick }: { on: boolean; icon: ReactNode; label: string; title?: string; count?: number; onClick: () => void }) {
  return (
    <button type="button" className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} title={title ?? label} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {!!count && <small>{count}</small>}
    </button>
  )
}

/**
 * One agent: a small face and its name, one line like a thread. Working shows typing dots; waiting on you,
 * the orange dot. Its latest line rides in the tooltip. Hovering wakes the face.
 */
function AgentRow(r: { label: string; description: string; colour?: string; st: AgentStatus; state: AgentState; dm?: SessionSummary; active: boolean; onOpen: () => void }) {
  const [hover, setHover] = useState(false)
  const said = r.state === 'working' ? r.st.line : (r.dm?.lastLine ?? (r.state === 'you' ? r.st.line : r.description))
  return (
    <button
      type="button"
      className={`tsThread tsAg${r.active ? ' on' : ''}`}
      aria-current={r.active ? 'page' : undefined}
      title={`${r.label}: ${said}`}
      onClick={r.onOpen}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <JuniorFace size={22} motion={hover ? 'follow' : 'still'} mood={hover ? 'done' : r.state === 'you' ? 'needs' : r.state === 'working' ? 'working' : 'hello'} colour={r.colour} decorative />
      <span className="tsTitle">{r.label}</span>
      {r.state === 'working' && <Typing />}
      {r.state === 'you' && <span className="tsYou" aria-label="needs you" />}
    </button>
  )
}

/** A thread waiting on you: the face of whoever has it, the title, how long it has waited, and who asks. */
function ThreadRow({ t, agentLabel, colour, active, onOpen }: { t: Thread; agentLabel: string; colour?: string; active: boolean; onOpen: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      className={`tsWaitRow${active ? ' on' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={`${t.title} · ${agentLabel}${t.question ? ' asks you a question' : ' waits on you'}`}
      onClick={onOpen}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <JuniorFace mood={hover ? 'done' : 'needs'} size={24} motion={hover ? 'follow' : 'still'} colour={colour} decorative />
      <span className="tsT">
        <span className="tsL1">
          <b>{t.title}</b>
          <small>{ago(t.updatedAt)}</small>
        </span>
        <span className="tsL2">
          <span>{t.question ? `${agentLabel} asks` : `${agentLabel} waits for your OK`}</span>
        </span>
      </span>
    </button>
  )
}

/**
 * The collapsed sidebar: a rail. Junior's face with how many things need you, the four places with
 * their counts, Settings at the bottom. ⌘\ or the title bar's toggle brings the sidebar back.
 */
export function TeamRail(p: {
  needs: number
  active: SidebarPlace
  taskCount: number
  prCount: number
  onJunior: () => void
  onPlace: (place: 'tasks' | 'prs' | 'artifacts' | 'jobs') => void
  onSettings: () => void
}) {
  const persona = usePersona()
  const [hover, setHover] = useState(false)
  const on = (place: SidebarPlace) => JSON.stringify(place) === JSON.stringify(p.active)
  const place = (key: 'tasks' | 'prs' | 'artifacts' | 'jobs', icon: ReactNode, label: string, title: string, count?: number) => (
    <button type="button" className={`trItem${on(key) ? ' on' : ''}`} aria-current={on(key) ? 'page' : undefined} title={title} onClick={() => p.onPlace(key)}>
      {icon}
      <span>{label}</span>
      {!!count && <small>{count}</small>}
    </button>
  )
  return (
    <nav className="sideRail" aria-label="Junior and the places">
      <button
        type="button"
        className={`trItem trJunior${on('junior') ? ' on' : ''}`}
        aria-current={on('junior') ? 'page' : undefined}
        title={p.needs ? `${persona.name}: ${p.needs} need you` : `${persona.name}: all clear`}
        onClick={p.onJunior}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
      >
        <JuniorFace mood={hover ? 'done' : p.needs ? 'needs' : 'hello'} size={30} motion={hover ? 'follow' : 'still'} decorative />
        {p.needs > 0 && <small className="you">{p.needs}</small>}
      </button>
      <span className="trSep" aria-hidden="true" />
      {place('tasks', <ListChecks size={18} aria-hidden="true" />, 'Tasks', 'Tasks', p.taskCount)}
      {place('prs', <GitPullRequest size={18} aria-hidden="true" />, 'PRs', 'Pull requests', p.prCount)}
      {place('artifacts', <FileText size={18} aria-hidden="true" />, 'Artifacts', 'Artifacts')}
      {place('jobs', <CalendarClock size={18} aria-hidden="true" />, 'Jobs', 'Jobs')}
      <span className="tsGrow" />
      <button type="button" className="trItem" title={`Show the sidebar (${MOD_LABEL}\\)`} aria-label="Show the sidebar" onClick={() => setSidebarCollapsed(false)}>
        <PanelLeft size={18} aria-hidden="true" />
      </button>
      <button type="button" className="trItem" title="Settings" aria-label="Settings" onClick={p.onSettings}>
        <Settings size={18} aria-hidden="true" />
      </button>
    </nav>
  )
}
