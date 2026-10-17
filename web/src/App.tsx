import { CalendarClock, FileDiff, FileText, Globe, Send, Target, Terminal as TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { CreateStep,
  DispatchPreviewResponse,
  EffortLevel,
  ItemDetailResponse,
  ImageAttachment,
  Mention,
  PermissionBehavior,
  PermissionMode,
  Project,
  ProjectsResponse,
  QuestionAnswers,
  ScoredItem,
  SessionStatus,
  SessionSummary,
  TerminalSummary,
  JobsResponse,
} from '../../shared/protocol.js'
import { mentionToken } from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { useSessionChanges } from './useSessionChanges.js'
import { ChangePage } from './components/ChangePage.js'
import { ChangesPanel } from './components/ChangesPanel.js'
import { changeId, changesStore, useChanges } from './changesStore.js'
import { branchSlug, checkoutOf } from './checkouts.js'
import { CheckoutChip } from './components/CheckoutChip.js'
import { CheckoutMenu } from './components/CheckoutMenu.js'
import { GoneCheckoutBar } from './components/GoneCheckoutBar.js'
import { Composer } from './components/Composer.js'
import { BrowserPane } from './components/BrowserPane.js'
import { browserPane, hasBrowser, useBrowserOpen } from './browser.js'
import { ArtifactsPanel, InboxTabsPanel, NewTerminalMenu, PanelCollapseContext, SessionsPanel, TerminalsPanel } from './components/ContextPanel.js'
import { resolveTab, tabOfItem, useInboxTabs } from './inboxTabs.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { InboxPage } from './components/InboxPage.js'
import { JuniorPage } from './components/JuniorPage.js'
import { startJuniorChat, usePersona, useRailMood } from './junior.js'
import { ItemPage } from './components/ItemPage.js'
import { NewSessionComposer, type NewSession } from './components/NewSessionComposer.js'
import { Rail, type RailSection } from './components/Rail.js'
import { SettingsPage } from './components/SettingsPage.js'
import { SystemModal, type SystemTab } from './components/SystemModal.js'
import { TabBand, type OpenTab, type PageTab, type TabKind } from './components/TabBand.js'
import { dispatchPrompt, dispatchTitle } from './dispatch.js'
import { composerDrafts } from './composerDrafts.js'
import { draftStore, draftTitle, useDrafts } from './drafts.js'
import { TerminalPage } from './components/TerminalPage.js'
import { TopBar } from './components/TopBar.js'
import { isDesktop } from './desktop.js'
import { SessionCost } from './components/SessionCost.js'
import { Transcript } from './components/Transcript.js'
import { AgentBrief, AgentComposer, AgentDock, AgentHeader, AgentOutcome, AgentsMenu } from './components/Agents.js'
import { agentLabel, buildAgents, spawnerOf, type AgentRun } from './agents.js'
import { buildShells, type ShellRun } from '../../core/shells/fold.js'
import { ShellDock } from './components/Shells.js'
import { TeamDock, TeamSide, TeamStrip, useTeamRun, type TeamSideTab } from './components/TeamRun.js'
import { RunHeader, runMarks, RunsViewToggle, TeamFiles, TeamRuns, useRunScroll, type RunsView } from './components/TeamRail.js'
import { RunFolderPage, runFileHash } from './components/RunFolderPage.js'
import { JobsPage } from './components/JobsPage.js'
import { REFINE_JOB_KEY, JobFormPage } from './components/JobFormPage.js'
import { JobPage } from './components/JobPage.js'
import { ArtifactsPage } from './components/ArtifactsPage.js'
import { ActionsPage } from './components/ActionsPage.js'
import { GoalPage } from './components/GoalPage.js'
import { GoalsPage } from './components/GoalsPage.js'
import { goalHash } from './goals.js'
import { useTeamGoals } from './teams.js'
import { usePendingActions } from './actions.js'
import { ArtifactPage } from './components/ArtifactPage.js'
import { DefaultProjectGate } from './components/DefaultProjectGate.js'
import { WorkspaceModal, type WorkspaceModalMode } from './components/WorkspaceModal.js'
import {
  itemHash,
  useBuild,
  useCheckouts,
  useConn,
  useEvents,
  useHashRoute,
  useOnboarded,
  useSessions,
  useTerminals,
  useWorkspaceId,
  useWorkspaces,
  type Route,
} from './hooks.js'
import { inboxStore, useInbox } from './inboxStore.js'
import { artifactStore, useArtifacts } from './artifactStore.js'
import { anyDialogOpen, isTypingTarget } from './keys.js'
import { EFFORT_LABEL, findModel, useModels } from './models.js'
import { closeSettings, noteReturnHash, noteSettingsTab, openSettings } from './settings.js'
import { store } from './store.js'
import { usePanelWidth } from './panelWidth.js'
import { useIsMobile } from './useMobile.js'
import { projectColor, useLastRoutes, useOpenTabs } from './tabs.js'

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/** `/Users/you/Code/x` → `x` — the header's fallback once the homely path won't fit. */
const folderName = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? p

/**
 * Whether the folder pill has given up the homely path for just the folder name: true once the
 * header can't fit the full path even with the title shrunk to nothing. Measured each resize
 * against the full path (the hidden `.measure` twin of the pill), so switching back doesn't lag
 * behind the header's real slack the way a latched "we're short" flag would.
 */
function useNarrowFolder(
  headerRef: RefObject<HTMLDivElement | null>,
  shownRef: RefObject<HTMLSpanElement | null>,
  fullRef: RefObject<HTMLSpanElement | null>,
  dep: string,
) {
  const [short, setShort] = useState(false)
  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const read = () => {
      const extra = (fullRef.current?.scrollWidth ?? 0) - (shownRef.current?.scrollWidth ?? 0)
      // Sub-pixel layout means scrollWidth can sit a hair above clientWidth with nothing actually hidden.
      setShort(header.scrollWidth + extra > header.clientWidth + 1)
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(header)
    return () => ro.disconnect()
  }, [headerRef, shownRef, fullRef, dep])
  return short
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

const PAGE_TABS: Record<'jobs' | 'terminals' | 'artifacts' | 'changes' | 'actions' | 'goals', PageTab> = {
  terminals: { key: 'page:terminals', label: 'Terminals', icon: TerminalIcon },
  artifacts: { key: 'page:artifacts', label: 'Artifacts', icon: FileText },
  changes: { key: 'page:changes', label: 'Changes', icon: FileDiff },
  jobs: { key: 'page:jobs', label: 'Jobs', icon: CalendarClock },
  actions: { key: 'page:actions', label: 'Actions', icon: Send },
  goals: { key: 'page:goals', label: 'Goals', icon: Target },
}

/** The sections whose list is the panel: on a phone, their bottom-bar tab opens it as a sheet. */
const MOBILE_SHEETS: readonly RailSection[] = ['inbox', 'sessions', 'terminals', 'changes']
const SHEET_LABEL: Record<RailSection, string> = {
  junior: 'Junior',
  inbox: 'Inbox',
  sessions: 'Sessions',
  artifacts: 'Artifacts',
  changes: 'Changes',
  terminals: 'Terminals',
  jobs: 'Jobs',
  actions: 'Actions',
  goals: 'Goals',
}

const termKey = (id: string) => `term:${id}`
const draftKey = (id: string) => `draft:${id}`
const draftRoute = (id: string) => `/new/${id}`

/**
 * The tab-band key for a route, or null when the route is not a tab at all
 * (`home` redirects, `settings` is a page of its own, outside the band). Sessions keep the bare id they
 * have always had; everything else is `<kind>:<id>`.
 */
function tabKeyOf(route: Route): string | null {
  switch (route.page) {
    case 'junior':
      return 'junior'
    case 'inbox':
      return 'inbox'
    case 'session':
      return route.id
    case 'draft':
      return draftKey(route.id)
    case 'terminal':
      return termKey(route.id)
    case 'item':
      return `item:${route.id}`
    case 'artifact':
      return `artifact:${route.id}`
    case 'run':
      return `run:${route.runId}`
    case 'job':
      return `job:${route.id}`
    case 'job-form':
      return `job-form:${route.id ?? 'new'}`
    case 'goal':
      return `goal:${route.id}`
    case 'change':
      return `change:${changeId(route.checkoutId, route.path)}`
    case 'changes':
    case 'artifacts':
    case 'jobs':
    case 'terminals':
    case 'actions':
    case 'goals':
      return PAGE_TABS[route.page].key
    case 'home':
    case 'settings':
      return null
  }
}

/** The route a tab key points back at — the inverse of `tabKeyOf`. */
function routeOfKey(key: string): string {
  const cut = key.indexOf(':')
  const id = cut === -1 ? '' : key.slice(cut + 1)
  switch (cut === -1 ? '' : key.slice(0, cut)) {
    case 'term':
      return `/terminal/${id}`
    case 'draft':
      return draftRoute(id)
    case 'item':
      return itemHash(id)
    case 'artifact':
      return `/artifact/${id}`
    case 'run':
      return runFileHash(id)
    case 'job':
      return `/jobs/${encodeURIComponent(id)}`
    case 'job-form':
      return id === 'new' ? '/jobs/new' : `/jobs/${encodeURIComponent(id)}/edit`
    case 'change':
      return `/change/${id}`
    case 'goal':
      return goalHash(id)
    case 'page':
      return `/${id}`
    default:
      // a bare session id, or the pinned Junior and inbox
      return key === 'inbox' ? '/inbox' : key === 'junior' ? '/junior' : key
  }
}

/** Documents are peeked at; processes are pinned. */
const DOC_KINDS: readonly TabKind[] = ['item', 'artifact', 'job', 'job-form', 'change', 'goal', 'run']

function kindOfKey(key: string): TabKind | null {
  const cut = key.indexOf(':')
  // A session is the one key with no prefix; the pinned Junior and inbox are not kinds.
  if (cut === -1) return key === 'inbox' || key === 'junior' ? null : 'session'
  const p = key.slice(0, cut)
  if (p === 'term') return 'terminal'
  if (p === 'draft') return 'draft'
  return DOC_KINDS.includes(p as TabKind) ? (p as TabKind) : null
}

/** A document is peeked at by default; a process is pinned from the start. */
function isDocKey(key: string): boolean {
  const kind = kindOfKey(key)
  return !!kind && DOC_KINDS.includes(kind)
}

/** What a document tab is called before its store has caught up. */
const GENERIC: Record<TabKind, string> = {
  session: 'Session',
  terminal: 'Terminal',
  draft: 'Draft',
  item: 'Work item',
  artifact: 'Artifact',
  job: 'Job',
  'job-form': 'Job',
  change: 'File',
  goal: 'Goal',
  run: 'Team run',
}

/**
 * Which rail section a route belongs to: the rail's highlight, and the key
 * rail memory is filed under.
 */
function sectionOf(route: Route): RailSection | null {
  switch (route.page) {
    case 'junior':
      return 'junior'
    case 'inbox':
    case 'item':
      return 'inbox'
    case 'home':
    case 'session':
    case 'draft':
    case 'run':
      return 'sessions'
    case 'terminal':
    case 'terminals':
      return 'terminals'
    case 'artifact':
    case 'artifacts':
      return 'artifacts'
    case 'change':
    case 'changes':
      return 'changes'
    case 'job':
    case 'job-form':
    case 'jobs':
      return 'jobs'
    case 'actions':
      return 'actions'
    case 'goal':
    case 'goals':
      return 'goals'
    case 'settings':
      return null
  }
}

export function App() {
  const conn = useConn()
  const sessions = useSessions()
  const terminals = useTerminals()
  const checkouts = useCheckouts()
  const drafts = useDrafts()
  const models = useModels()
  const inbox = useInbox()
  const inboxTabs = useInboxTabs()
  const artifacts = useArtifacts()
  const changes = useChanges()
  const [route, navigate] = useHashRoute()
  const currentId = route.page === 'session' ? route.id : null
  const currentTerminalId = route.page === 'terminal' ? route.id : null
  const currentDraftId = route.page === 'draft' ? route.id : null
  const events = useEvents(currentId)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Fetched once per session for the transcript's turn markers.
  const sessionChanges = useSessionChanges(currentId)
  const [helpOpen, setHelpOpen] = useState(false)
  const [system, setSystem] = useState<{ open: boolean; tab: SystemTab }>({ open: false, tab: 'status' })
  const [composeSignal, setComposeSignal] = useState(0)
  const workspaces = useWorkspaces()
  const build = useBuild()
  const workspaceId = useWorkspaceId()
  const onboarded = useOnboarded()
  const [wsModal, setWsModal] = useState<WorkspaceModalMode | null>(null)
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null
  const {
    tabs,
    preview,
    titles,
    open: openTab,
    close: closeTab,
    closeAll: closeAllTabs,
    replace: replaceTab,
    setPreview,
    remember,
    move: moveTab,
  } = useOpenTabs(workspaceId)

  /** Every document the band is holding — pinned or peeked. */
  const docKeys = useMemo(
    () => [...tabs, ...(preview ? [preview] : [])].filter((k) => isDocKey(k)),
    [tabs, preview],
  )
  const { lastRoutes, record: recordRoute } = useLastRoutes(workspaceId)
  const panelSize = usePanelWidth()
  // On a phone the panel is a sheet over the page, opened from the bottom bar
  // for the sections whose list *is* the panel (see onRailGo); it closes on
  // any navigation, which is how picking a row in it lands you on the row.
  const mobile = useIsMobile()
  // Queued actions waiting on you — the Actions rail badge.
  const pendingActions = usePendingActions()
  const goals = useTeamGoals(sessions)
  // Junior's name and face, everywhere it shows: the rail and the phone's title.
  const persona = usePersona()
  const juniorMood = useRailMood(pendingActions)
  const [sheet, setSheet] = useState<RailSection | null>(null)
  useEffect(() => setSheet(null), [route, mobile])

  // First run: the workspace modal doubles as onboarding — introduce the
  // concept, name the default workspace, pick the Claude auth method.
  useEffect(() => {
    if (!onboarded && activeWorkspace) {
      setWsModal({ kind: 'onboarding', workspace: activeWorkspace })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded, activeWorkspace?.id])
  // pending "g" prefix for two-key sequences (g i, g s, g j, g p, g c)
  const goPrefix = useRef<number | undefined>(undefined)

  const current = sessions.find((s) => s.id === currentId) ?? null
  // The browser pane beside this session (.docs/browser.md) — Triage.app only, never on a phone.
  const browserOpen = useBrowserOpen(currentId) && hasBrowser && !mobile
  const currentCheckout = checkoutOf(checkouts, current?.checkoutId)
  const chatHeaderRef = useRef<HTMLDivElement>(null)
  const folderTextRef = useRef<HTMLSpanElement>(null)
  const folderMeasureRef = useRef<HTMLSpanElement>(null)
  const folderShort = useNarrowFolder(chatHeaderRef, folderTextRef, folderMeasureRef, `${current?.cwd}`)
  // A team run in this session: one fetch shared by the strip, the dock and the details drawer.
  const teamRun = useTeamRun(current?.teamRun)
  const [teamSide, setTeamSide] = useState(false)
  const [teamTab, setTeamTab] = useState<TeamSideTab>('runs')
  const [runsView, setRunsView] = useState<RunsView>('person')
  // The run rail (desktop): the team's runs in the drawer beside the transcript, and a run to scroll to once its session is up.
  const railOn = !!teamRun && !mobile
  const [teamJump, setTeamJump] = useState<{ sessionId: string; runId: string } | null>(null)
  // Arriving at a session of a team under way opens the drawer on its runs, unless it's already open.
  // Once per session, and only once the session has loaded: a drawer you close stays closed.
  const inRun = !!current?.teamRun && current.teamRun.state !== 'proposed'
  const sideOpenedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!inRun || mobile || !currentId || sideOpenedFor.current === currentId) return
    sideOpenedFor.current = currentId
    if (teamSide) return
    setTeamTab('runs')
    setTeamSide(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, inRun])
  const runScroll = useRunScroll(currentId ?? '', railOn, `${events.length}:${teamRun?.rev ?? 0}`)
  useEffect(() => {
    if (!teamJump || teamJump.sessionId !== currentId) return
    // The divider is there once the history has loaded and the transcript has drawn it.
    const t = requestAnimationFrame(() => runScroll.jump(teamJump.runId) && setTeamJump(null))
    return () => cancelAnimationFrame(t)
  }, [teamJump, currentId, events.length, teamRun?.rev]) // eslint-disable-line react-hooks/exhaustive-deps
  const openTeamRun = useCallback(
    (sessionId: string, runId: string | null, newTab?: boolean) => {
      // ⌘-click: its own tab, behind this one; you stay where you are.
      if (newTab) return openTab(sessionId)
      setTeamJump(runId ? { sessionId, runId } : null)
      if (sessionId !== currentId) navigate(sessionId)
    },
    [currentId, openTab], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const teamMarks = useMemo(() => (railOn && teamRun && currentId ? runMarks(teamRun, currentId) : undefined), [railOn, teamRun, currentId])
  const teamCheckoutId = (teamRun && sessions.find((s) => s.id === teamRun.leadSessionId)?.checkoutId) ?? current?.checkoutId ?? null
  // Subagents: folded from the same events as the transcript. Opening one swaps
  // the transcript for its slice — remembered per session, so leaving and coming
  // back finds main again rather than an agent picked long ago.
  // With no subprocess behind the session, nothing it spawned can still be
  // running — a daemon restart ends them without a word in the log.
  const sessionLive = current?.live
  const agents = useMemo(() => {
    const runs = buildAgents(events, store.eventTime)
    if (sessionLive !== false) return runs
    return runs.map((r) => (r.state === 'running' ? { ...r, state: 'interrupted' as const, waiting: false } : r))
  }, [events, sessionLive])
  // Shells too: the transcript's Bash pills and the background dock read these.
  const shells = useMemo(() => {
    const runs = buildShells(events, store.eventTime)
    if (sessionLive !== false) return runs
    return runs.map((r) => (r.state === 'running' ? { ...r, state: 'interrupted' as const } : r))
  }, [events, sessionLive])
  const [agentPick, setAgentPick] = useState<{ sessionId: string; toolUseId: string } | null>(null)
  const openAgent = agentPick && agentPick.sessionId === currentId ? agents.find((a) => a.toolUseId === agentPick.toolUseId) ?? null : null
  const showAgent = useCallback(
    (toolUseId: string | null) => setAgentPick(toolUseId && currentId ? { sessionId: currentId, toolUseId } : null),
    [currentId],
  )
  const currentTerminal = terminals.find((t) => t.id === currentTerminalId) ?? null
  const currentDraft = drafts.find((d) => d.id === currentDraftId) ?? null
  // Drafts are per workspace; bind before anything reads them.
  useEffect(() => draftStore.bind(workspaceId), [workspaceId])
  // Name the workspace in the tab title — with one tab per workspace, the
  // favicon alone cannot tell them apart.
  useEffect(() => {
    document.title = activeWorkspace ? `triage • ${activeWorkspace.name}` : 'triage'
  }, [activeWorkspace?.name])
  // The bare home route: Junior's page is the product's home.
  useEffect(() => {
    if (route.page === 'home') navigate('/junior', { replace: true })
  }, [route.page, navigate])

  // Settings is a page: remember its tab for the gear, and every other page
  // as where Close and Esc go back to (the inbox on a cold load).
  useEffect(() => {
    if (route.page === 'settings') noteSettingsTab(route.tab)
    else if (route.page !== 'home') noteReturnHash(location.hash.slice(1) || '/inbox')
  }, [route])

  // Jobs have no client store; the band needs their titles, so fetch the
  // (small) list once the first job is in play and keep it.
  const [jobTitles, setJobTitles] = useState<Map<string, string>>(new Map())
  const wantJobTitles = sectionOf(route) === 'jobs' || docKeys.some((k) => k.startsWith('job'))
  useEffect(() => {
    if (conn !== 'connected' || !wantJobTitles) return
    void fetch('/api/jobs')
      .then((r) => r.json() as Promise<JobsResponse>)
      .then((b) => {
        if (b.ok) setJobTitles(new Map(b.jobs.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
  }, [conn, wantJobTitles])

  /** The live name for a document tab, or null while its store is still cold. */
  const liveTitle = useCallback(
    (key: string): string | null => {
      const id = key.slice(key.indexOf(':') + 1)
      if (key.startsWith('item:')) return inbox.items.find((i) => i.id === id)?.title ?? null
      if (key.startsWith('artifact:')) return artifacts.artifacts.find((a) => a.id === id)?.title ?? null
      if (key.startsWith('run:')) {
        const lead = sessions.find((s) => s.teamRun?.id === id && s.teamRun.role === 'lead')
        return lead ? `Run · ${lead.title}` : null
      }
      if (key.startsWith('job:')) return jobTitles.get(id) ?? null
      if (key.startsWith('job-form:')) return id === 'new' ? 'New job' : jobTitles.get(id) ?? null
      // Old goals-engine pages keep the title they were opened with.
      if (key.startsWith('goal:')) return null
      if (key.startsWith('change:')) {
        // A file is named by its basename; the path lives in the page header.
        const file = decodeURIComponent(id.slice(id.indexOf('/') + 1))
        return file.slice(file.lastIndexOf('/') + 1)
      }
      return null
    },
    [inbox.items, artifacts.artifacts, jobTitles, sessions],
  )

  /** A document tab: its best known name, no project dot, nothing running. */
  const docTab = useCallback(
    (key: string): OpenTab | null => {
      const kind = kindOfKey(key)
      if (!kind) return null
      return { key, kind, title: (liveTitle(key) ?? titles[key]) || GENERIC[kind], color: 'var(--stone)', running: false }
    },
    [liveTitle, titles],
  )

  /** Commit a peeked document to a real tab — it stops being replaceable. */
  const pin = useCallback(
    (key: string, title?: string) => {
      if (title) remember({ [key]: title })
      openTab(key)
    },
    [openTab, remember],
  )

  /** Editing what you were only peeking at makes it yours: keep the tab. */
  const pinCurrent = useCallback(() => {
    const key = tabKeyOf(route)
    if (key && isDocKey(key)) openTab(key)
  }, [route, openTab])

  // The peek slot: opening a document parks it in the band so it survives you
  // looking at a session.
  useEffect(() => {
    const key = tabKeyOf(route)
    if (key && isDocKey(key)) setPreview(key)
  }, [route, setPreview])

  // Names arrive after the tab does — stores load, things get renamed. Teach
  // the band every name it can currently resolve.
  useEffect(() => {
    const patch: Record<string, string> = {}
    for (const k of docKeys) {
      const t = liveTitle(k)
      if (t) patch[k] = t
    }
    if (Object.keys(patch).length) remember(patch)
  }, [docKeys, liveTitle, remember])

  // Rail memory: remember where you were in each section, so leaving and
  // coming back lands on what you were reading rather than the section root.
  useEffect(() => {
    const section = sectionOf(route)
    // `home` redirects to the inbox above; `settings` sits outside the rail's sections.
    if (!section || route.page === 'home') return
    recordRoute(section, location.hash.slice(1) || '/inbox')
  }, [route, recordRoute])

  // The open inbox feeds the rail badge and the Queue panel from the start.
  useEffect(() => {
    if (conn === 'connected') void inboxStore.refresh()
  }, [conn])
  // …and the Changes badge: one git pass per project, kept current by the store.
  useEffect(() => {
    if (conn === 'connected') void changesStore.refresh()
  }, [conn])
  // The Artifacts panel lists from the index; load it when that world is in front.
  useEffect(() => {
    const wanted = route.page === 'artifacts' || route.page === 'artifact' || docKeys.some((k) => k.startsWith('artifact:'))
    if (conn === 'connected' && wanted) void artifactStore.refresh()
  }, [conn, route.page, docKeys])

  // A session created from this tab becomes the selected one — and when it
  // came from a draft tab, it takes that tab's slot.
  const pendingDraft = useRef<string | null>(null)
  // A send that failed (a worktree git wouldn't make): the draft stays, and says why.
  const [createError, setCreateError] = useState<{ draftId: string; message: string } | null>(null)
  // …and while one is being made in a new worktree, which step it's on.
  const [createStep, setCreateStep] = useState<{ draftId: string; step: CreateStep } | null>(null)
  useEffect(
    () =>
      store.onCreateFailed((message) => {
        const d = pendingDraft.current
        pendingDraft.current = null
        setCreateStep(null)
        if (d) setCreateError({ draftId: d, message })
      }),
    [],
  )
  useEffect(
    () =>
      store.onCreateProgress((step) => {
        const d = pendingDraft.current
        if (d) setCreateStep({ draftId: d, step })
      }),
    [],
  )
  useEffect(
    () =>
      store.onSessionCreated((s) => {
        const d = pendingDraft.current
        pendingDraft.current = null
        setCreateStep(null)
        if (d) {
          replaceTab(draftKey(d), s.id)
          draftStore.remove(d)
        }
        navigate(s.id)
      }),
    [navigate, replaceTab],
  )
  useEffect(() => store.onTerminalCreated((t) => navigate(`/terminal/${t.id}`)), [navigate])

  // A visited terminal or draft gets a tab too.
  useEffect(() => {
    if (currentTerminalId) openTab(termKey(currentTerminalId))
  }, [currentTerminalId, openTab])
  useEffect(() => {
    if (currentDraftId) openTab(draftKey(currentDraftId))
  }, [currentDraftId, openTab])

  // Replay the log whenever the selection changes (and after a reconnect);
  // a visited session gets a tab. A team run is one tab: walking from one of
  // its members to another (the drawer, the breadcrumb, back/forward) swaps
  // the session in the tab you're in, unless the member already has its own.
  const tabsNow = useRef(tabs)
  tabsNow.current = tabs
  const lastSession = useRef<string | null>(null)
  useEffect(() => {
    if (!currentId) return
    store.subscribeSession(currentId)
    const from = lastSession.current
    lastSession.current = currentId
    const runOf = (id: string) => sessions.find((s) => s.id === id)?.teamRun?.id
    const sameTeam = from && from !== currentId && runOf(from) && runOf(from) === runOf(currentId)
    if (sameTeam && tabsNow.current.includes(from) && !tabsNow.current.includes(currentId)) replaceTab(from, currentId)
    else openTab(currentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, conn, openTab])

  const respond = useCallback(
    (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => {
      if (currentId)
        store.send({ type: 'permission_response', sessionId: currentId, requestId, behavior, answers })
    },
    [currentId],
  )

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[], mentions?: Mention[], mode?: 'goal') => {
      if (currentId) store.send({ type: 'user_message', sessionId: currentId, text, images, mentions, ...(mode ? { mode } : {}) })
    },
    [currentId],
  )

  const setPlanning = useCallback(
    (planning: boolean) => {
      if (currentId) store.send({ type: 'set_session_mode', sessionId: currentId, mode: planning ? 'plan' : 'normal' })
    },
    [currentId],
  )

  const setModel = useCallback(
    (model: string | undefined, effort: EffortLevel | undefined) => {
      if (currentId) store.send({ type: 'set_model', sessionId: currentId, model, effort })
    },
    [currentId],
  )

  const setFastMode = useCallback(
    (fastMode: boolean) => {
      if (currentId) store.send({ type: 'set_fast_mode', sessionId: currentId, fastMode })
    },
    [currentId],
  )

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (currentId) store.send({ type: 'set_permission_mode', sessionId: currentId, mode })
    },
    [currentId],
  )

  const interrupt = useCallback(() => {
    if (currentId) store.send({ type: 'interrupt', sessionId: currentId })
  }, [currentId])

  const stopAgent = useCallback(
    (run: AgentRun) => {
      if (currentId && run.agentId) store.send({ type: 'agent_stop', sessionId: currentId, agentId: run.agentId })
    },
    [currentId],
  )

  // stopTask takes any task id, a shell's as well as an agent's.
  const stopShell = useCallback(
    (run: ShellRun) => {
      if (currentId && run.taskId) store.send({ type: 'agent_stop', sessionId: currentId, agentId: run.taskId })
    },
    [currentId],
  )

  const backgroundAgent = useCallback(
    (run: AgentRun) => {
      if (currentId) store.send({ type: 'agent_background', sessionId: currentId, toolUseId: run.toolUseId })
    },
    [currentId],
  )

  const messageAgent = useCallback(
    (run: AgentRun, text: string) => {
      if (!currentId || !run.agentId) return
      store.send({
        type: 'agent_message',
        sessionId: currentId,
        relay: { toolUseId: run.toolUseId, agentId: run.agentId, label: agentLabel(run) },
        text,
      })
    },
    [currentId],
  )

  const renameSession = useCallback((sessionId: string, title: string) => {
    store.send({ type: 'rename_session', sessionId, title })
  }, [])

  const setPinned = useCallback((sessionId: string, pinned: boolean) => {
    store.send({ type: 'set_pinned', sessionId, pinned })
  }, [])

  const deleteSession = useCallback(
    (sessionId: string) => {
      store.send({ type: 'delete_session', sessionId })
      composerDrafts.set(sessionId, '') // no session, no draft to keep
      closeTab(sessionId)
      // Deleting what you are looking at leaves nothing to look at.
      if (sessionId === currentId) navigate('')
    },
    [currentId, navigate, closeTab],
  )

  // New session = a draft tab. An untouched draft is reused rather than
  // stacking blank tabs; a folder-specific one is always fresh.
  const newSession = useCallback(() => {
    const d = draftStore.findEmpty() ?? draftStore.create()
    navigate(draftRoute(d.id))
  }, [navigate])

  const newSessionIn = useCallback(
    (project: Project) => {
      const d = draftStore.create({ cwd: project.path })
      navigate(draftRoute(d.id))
    },
    [navigate],
  )

  const discardDraft = useCallback(
    (id: string) => {
      draftStore.remove(id)
      closeTab(draftKey(id))
      if (id === currentDraftId) navigate('/inbox')
    },
    [closeTab, currentDraftId, navigate],
  )

  const syncInbox = useCallback(() => {
    void inboxStore.refresh(true).finally(() => navigate('/inbox'))
  }, [navigate])

  const openItem = useCallback((id: string) => navigate(itemHash(id)), [navigate])

  // Terminals: open in a folder (the server falls back to home), rename, kill.
  const newTerminal = useCallback((cwd?: string) => {
    store.send({ type: 'terminal_create', cwd })
  }, [])
  const newTerminalIn = useCallback((checkoutId: string) => {
    store.send({ type: 'terminal_create', checkoutId })
  }, [])
  const renameTerminal = useCallback((terminalId: string, title: string) => {
    store.send({ type: 'terminal_rename', terminalId, title })
  }, [])
  const closeTerminal = useCallback(
    (terminalId: string) => {
      store.send({ type: 'terminal_close', terminalId })
      closeTab(termKey(terminalId))
      if (terminalId === currentTerminalId) {
        const rest = terminals.filter((t) => t.id !== terminalId)
        navigate(rest.length ? `/terminal/${rest[rest.length - 1].id}` : '/terminals')
      }
    },
    [closeTab, currentTerminalId, terminals, navigate],
  )
  // Where "+" opens a shell: the folder of whatever tab is in front.
  const terminalCwd = current?.cwd ?? currentTerminal?.cwd ?? currentDraft?.cwd

  // Back to a section lands on what you were last doing there; clicking the
  // section you are already in pops to its root (Inbox, Artifacts, Jobs).
  // Sessions and Terminals have no index page — their list *is* the panel — so
  // they keep their own "take me to the live one" fallback chain instead.
  const goTo = useCallback(
    (section: RailSection) => {
      const back = sectionOf(route) === section ? undefined : lastRoutes[section]
      if (section === 'sessions') {
        // A remembered session that has since been deleted is no memory at all.
        const alive = back?.startsWith('/new/')
          ? drafts.some((d) => d.id === back.slice('/new/'.length))
          : !!back && sessions.some((s) => s.id === back)
        // The remembered one, else the session in front, else the last session
        // tab, else a fresh draft.
        const last = (alive ? back : undefined) ?? currentId ?? [...tabs].reverse().find((k) => sessions.some((s) => s.id === k))
        if (last) navigate(last)
        else newSession()
      } else if (section === 'terminals') {
        const id = back?.startsWith('/terminal/') ? back.slice('/terminal/'.length) : undefined
        if (id && terminals.some((t) => t.id === id)) navigate(`/terminal/${id}`)
        else {
          const last = currentTerminalId ?? terminals[terminals.length - 1]?.id
          navigate(last ? `/terminal/${last}` : '/terminals')
        }
      } else navigate(back ?? (section === 'inbox' ? '/inbox' : `/${section}`))
    },
    [navigate, route, lastRoutes, currentId, currentTerminalId, terminals, tabs, sessions, drafts, newSession],
  )

  // The rail only navigates — hiding the panel is its own button beside the
  // search field (and ⌘B). Clicking any icon while collapsed reopens it,
  // still landing on that section.
  const onRailGo = useCallback(
    (section: RailSection) => {
      if (mobile) {
        // The inbox's tabs, Sessions, Terminals and Changes live in the panel —
        // so on a phone their tab opens it as a sheet; the
        // rest go to their page, and a second tap pops to its root.
        if (MOBILE_SHEETS.includes(section)) setSheet((s) => (s === section ? null : section))
        else {
          setSheet(null)
          goTo(section)
        }
      } else {
        if (panelSize.collapsed) panelSize.setCollapsed(false)
        goTo(section)
      }
    },
    [mobile, panelSize, goTo],
  )

  const collapsePanel = useCallback(() => panelSize.setCollapsed(true), [panelSize])

  // Closing the tab you are on lands you on its neighbour, else the inbox.
  // A terminal tab closing does not kill the shell — that is the panel's menu.
  const activeTabKey = tabKeyOf(route) ?? 'home'
  const closeOpenTab = useCallback(
    (key: string) => {
      if (key === activeTabKey) {
        // A pinned tab hands over to its neighbour; the preview has none.
        const i = tabs.indexOf(key)
        const next = i === -1 ? undefined : tabs[i + 1] ?? tabs[i - 1]
        navigate(next ? routeOfKey(next) : '/inbox')
      }
      // Closing a draft tab discards the draft — there is nowhere else it lives.
      if (key.startsWith('draft:')) draftStore.remove(key.slice(6))
      closeTab(key)
    },
    [tabs, activeTabKey, navigate, closeTab],
  )

  // Empty the band. Drafts go with their tabs — that is the only place they
  // live — and with nothing left open, the inbox is where you land.
  const closeAllOpenTabs = useCallback(() => {
    for (const key of [...tabs, ...(preview ? [preview] : [])]) {
      if (key.startsWith('draft:')) draftStore.remove(key.slice(6))
    }
    closeAllTabs()
    navigate('/inbox')
  }, [tabs, preview, closeAllTabs, navigate])

  // Global hotkeys. ⌘K works everywhere (even in inputs); single keys only
  // outside text fields and while no dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen((v) => !v)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen(false)
        openSettings()
        return
      }
      // ⌘J: a new chat with Junior, from anywhere (no other ⌘J in the app or Triage.app's menus).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        if (anyDialogOpen()) return
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen(false)
        startJuniorChat()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        if (isTypingTarget(e) || anyDialogOpen()) return
        e.preventDefault()
        panelSize.toggleCollapsed()
        return
      }
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return

      if (goPrefix.current !== undefined) {
        clearTimeout(goPrefix.current)
        goPrefix.current = undefined
        if (e.key === 'h') return goTo('junior')
        if (e.key === 'i') return goTo('inbox')
        if (e.key === 's') return goTo('sessions')
        if (e.key === 't') return goTo('terminals')
        if (e.key === 'c') return openSettings('connectors')
        if (e.key === 'p') return openSettings('projects')
        if (e.key === 'j') return goTo('jobs')
        if (e.key === 'a') return goTo('actions')
        return // unknown sequence — swallow
      }
      if (e.key === 'g') {
        goPrefix.current = window.setTimeout(() => (goPrefix.current = undefined), 1000)
        return
      }
      if (e.key === 'n') {
        e.preventDefault()
        // In the inbox, `n` is "new work item"; among terminals, a new shell;
        // everywhere else, a new session.
        if (route.page === 'inbox') setComposeSignal((n) => n + 1)
        else if (route.page === 'terminal' || route.page === 'terminals') newTerminal(terminalCwd)
        else if (route.page === 'artifacts' || route.page === 'artifact') navigate('/artifact/new')
        else newSession()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newSession, newTerminal, terminalCwd, goTo, currentId, route.page, panelSize])

  const create = useCallback((draftId: string, s: NewSession) => {
    pendingDraft.current = draftId
    setCreateError(null)
    store.send({
      type: 'create_session',
      title: s.title,
      cwd: s.cwd,
      firstMessage: s.firstMessage || undefined,
      model: s.model,
      effort: s.effort,
      fastMode: s.fastMode,
      permissionMode: s.permissionMode,
      ...(s.mode && s.mode !== 'normal' ? { mode: s.mode } : {}),
      provider: s.provider,
      images: s.images,
      mentions: s.mentions,
      itemId: s.itemId,
      checkoutId: s.checkoutId,
      worktree: s.worktree,
    })
  }, [])

  // New job = a chat with Junior, not a form (decisions 4 and 5): an untouched one is reused.
  const addJob = useCallback(() => {
    const d = draftStore.findEmptyJob() ?? draftStore.create({ intent: 'job' })
    navigate(draftRoute(d.id))
  }, [navigate])

  // An item becomes a goal the same way: a chat with Junior, linked to the item, opening "New goal:".
  const goalFrom = useCallback(
    (item: ScoredItem) => {
      const d = draftStore.create({ intent: 'goal', itemId: item.id, text: `${item.title} (work item ${item.id})` })
      navigate(draftRoute(d.id))
    },
    [navigate],
  )

  // Thumbs-down on a matched item: the correction lands as appended text on
  // the job's instruction — the rule stays human-readable.
  const refineJob = useCallback(
    (item: ScoredItem) => {
      if (!item.jobId) return
      sessionStorage.setItem(REFINE_JOB_KEY, JSON.stringify({ jobId: item.jobId, note: item.title }))
      navigate(`/jobs/${encodeURIComponent(item.jobId)}/edit`)
    },
    [navigate],
  )

  // Dispatch = a draft tab prefilled by the server (.docs/next-version.md):
  // the kind's template, the item's description, and the brief as an
  // `@artifact:` mention when one exists. The old client-side prompt stays
  // as the fallback when the preview cannot be fetched.
  const dispatch = useCallback(
    (item: ScoredItem) => {
      const openWith = (init: { cwd?: string; text: string; mentions?: Mention[]; branchHint?: string; continueIn?: string }) => {
        const d = draftStore.create({ label: dispatchTitle(item), itemId: item.id, ...init })
        navigate(draftRoute(d.id))
      }
      void fetch(`/api/dispatch/preview?itemId=${encodeURIComponent(item.id)}`)
        .then((r) => r.json() as Promise<DispatchPreviewResponse>)
        .then((b) => {
          if (!b.ok) throw new Error(b.error)
          openWith({
            cwd: b.preview.cwd ?? undefined,
            text: b.preview.text,
            mentions: b.preview.mentions,
            // Where it runs is asked in the draft, never assumed: it starts in the current folder,
            // with a new worktree (named from the item) or the item's own worktree on offer.
            ...(b.preview.branch ? { branchHint: b.preview.branch } : {}),
            ...(b.preview.checkoutId ? { continueIn: b.preview.checkoutId } : {}),
          })
        })
        .catch(() =>
          fetch('/api/projects')
            .then((r) => r.json() as Promise<ProjectsResponse>)
            .then((p) => {
              const match =
                p.ok &&
                ((item.projectId && p.projects.find((x) => x.id === item.projectId)) ||
                  (item.repo && p.projects.find((x) => x.repo && x.repo === item.repo)))
              openWith({ cwd: match ? match.path : undefined, text: dispatchPrompt(item) })
            })
            .catch(() => openWith({ text: dispatchPrompt(item) })),
        )
    },
    [navigate],
  )

  // Start on a Junior-owned plan row: the same dispatch as the inbox's, by id —
  // the row may name an item the open inbox doesn't hold (a to-do made a moment ago).
  const dispatchById = useCallback(
    (id: string) => {
      const ranked = inbox.items.find((i) => i.id === id)
      if (ranked) return dispatch(ranked)
      void fetch(`/api/items/detail?id=${encodeURIComponent(id)}`)
        .then((r) => r.json() as Promise<ItemDetailResponse>)
        .then((b) => {
          if (b.ok) dispatch({ ...b.detail.item, score: 0, group: 'cycle', reason: 'on today\u2019s plan', label: 'do' })
        })
        .catch(() => {})
    },
    [inbox.items, dispatch],
  )

  // A session whose worktree is gone continues as a new session in the project's
  // main folder, with the old one attached as an `@session:` mention for context.
  const continueInMain = useCallback(
    (s: SessionSummary) => {
      const main = checkouts.find((c) => c.projectId === s.projectId && c.kind === 'main')
      const mention: Mention = { kind: 'session', ref: s.id, label: s.title }
      const d = draftStore.create({
        cwd: main?.path,
        text: `Continuing from ${mentionToken(mention)} — its worktree was removed.\n\n`,
        mentions: [mention],
      })
      navigate(draftRoute(d.id))
    },
    [checkouts, navigate],
  )

  // --- derived shell state -------------------------------------------------

  const railActive: RailSection | null = sectionOf(route)
  // Which list the panel shows: the route's section, or on a phone the open sheet (none when shut).
  const panelSection: RailSection | null = mobile ? sheet : railActive

  // Tabs in a worktree carry its branch, so two sessions on different branches never look the same.
  const worktreeTag = useCallback(
    (checkoutId: string | undefined): Pick<OpenTab, 'branch' | 'branchGone'> => {
      const co = checkoutOf(checkouts, checkoutId)
      if (co?.kind !== 'worktree') return {}
      return { branch: co.branch ? branchSlug(co.branch) : 'detached', ...(co.state === 'removed' ? { branchGone: true } : {}) }
    },
    [checkouts],
  )

  const openTabs = useMemo<OpenTab[]>(
    () =>
      tabs.flatMap((key): OpenTab[] => {
        if (key.startsWith('draft:')) {
          const d = drafts.find((x) => x.id === key.slice(6))
          return d ? [{ key, kind: 'draft', title: draftTitle(d), color: 'var(--stone)', running: false }] : []
        }
        if (key.startsWith('term:')) {
          const t: TerminalSummary | undefined = terminals.find((x) => x.id === key.slice(5))
          return t
            ? [{ key, kind: 'terminal', title: t.title, color: projectColor(t.projectId ?? t.cwd), running: t.status === 'running', ...worktreeTag(t.checkoutId) }]
            : []
        }
        if (isDocKey(key)) {
          const t = docTab(key)
          return t ? [t] : []
        }
        const s = sessions.find((x) => x.id === key)
        return s
          ? [
              {
                key,
                kind: 'session',
                title: s.title,
                color: projectColor(s.projectId ?? s.cwd),
                running: s.status === 'running' || s.status === 'starting',
                ...worktreeTag(s.checkoutId),
              },
            ]
          : []
      }),
    [tabs, sessions, terminals, drafts, docTab, worktreeTag],
  )

  // Only the rail *indexes* get a transient page tab now: an artifact, job
  // or item in front is a document, and gets a real tab of its own.
  const pageTab =
    route.page === 'jobs' || route.page === 'terminals' || route.page === 'artifacts' || route.page === 'changes' || route.page === 'actions' || route.page === 'goals'
      ? PAGE_TABS[route.page]
      : null

  const previewTab = useMemo<OpenTab | null>(() => {
    const t = preview ? docTab(preview) : null
    return t ? { ...t, preview: true } : null
  }, [preview, docTab])

  // The phone's top bar: what is in front, and where "back" goes. Back is
  // *up* — to the page's list — rather than browser history, so it means the
  // same thing in a home-screen app, which has no browser back at all.
  const mobileTitle = sheet
    ? SHEET_LABEL[sheet]
    : route.page === 'junior'
      ? persona.name
      : route.page === 'inbox'
      ? 'Inbox'
      : route.page === 'settings'
        ? 'Settings'
      : [...openTabs, ...(previewTab ? [previewTab] : [])].find((t) => t.key === activeTabKey)?.title ?? pageTab?.label ?? null
  const mobileUp = useMemo((): (() => void) | null => {
    // An open sheet sits over the page: back closes it.
    if (sheet) return () => setSheet(null)
    switch (route.page) {
      case 'inbox':
        return () => setSheet('inbox')
      case 'item':
        return () => navigate('/inbox')
      case 'artifact':
        return () => navigate('/artifacts')
      case 'run':
        return () => history.back()
      case 'job':
        return () => navigate('/jobs')
      case 'goal':
        return () => navigate('/goals')
      case 'job-form':
        return () => navigate(route.id ? `/jobs/${encodeURIComponent(route.id)}` : '/jobs')
      case 'session':
      case 'draft':
        return () => setSheet('sessions')
      case 'terminal':
        return () => setSheet('terminals')
      case 'change':
        return () => setSheet('changes')
      case 'settings':
        return closeSettings
      default:
        return null
    }
  }, [sheet, route, navigate])

  // Brief runs and goal leads are sessions too, but they belong to their item
  // or goal: the Sessions panel and the palette list only chats.
  // A team's workers live under their lead (the run rail), not in the list: one row per team, not one per member.
  const chatSessions = useMemo(() => sessions.filter((s) => s.kind !== 'brief' && s.kind !== 'goal' && s.teamRun?.role !== 'worker'), [sessions])
  const runningCount = chatSessions.filter((s) => s.status === 'running' || s.status === 'starting').length
  const modelName = current ? findModel(models, current.model)?.name ?? current.model : undefined

  // The Actions page is a list and a detail side by side: it needs the room, so no panel beside it.
  // Junior's page is one centred column: no panel beside it either.
  const panel = !panelSection || panelSection === 'actions' || panelSection === 'goals' || panelSection === 'junior' ? null : panelSection === 'terminals' ? (
      <TerminalsPanel
        terminals={terminals}
        currentId={currentTerminalId}
        defaultCwd={terminalCwd}
        onSelect={(id) => navigate(`/terminal/${id}`)}
        onNew={newTerminal}
        onRename={renameTerminal}
        onClose={closeTerminal}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : panelSection === 'artifacts' ? (
      <ArtifactsPanel
        artifacts={artifacts.artifacts}
        loaded={artifacts.loaded}
        currentId={route.page === 'artifact' ? route.id : null}
        onOpen={(id) => navigate(`/artifact/${id}`)}
        onPin={(id, title) => pin(`artifact:${id}`, title)}
        onNew={() => navigate('/artifact/new')}
        onRefresh={() => void fetch('/api/artifacts/reindex', { method: 'POST' }).then(() => artifactStore.refresh())}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : panelSection === 'changes' ? (
      <ChangesPanel
        projects={changes.projects}
        loaded={changes.loaded}
        loading={changes.loading}
        current={route.page === 'change' ? { checkoutId: route.checkoutId, path: route.path } : null}
        onOpen={(checkoutId, path) => navigate(`/change/${changeId(checkoutId, path)}`)}
        onPin={(checkoutId, path) => pin(`change:${changeId(checkoutId, path)}`)}
        onNewTerminal={newTerminalIn}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : panelSection === 'inbox' ? (
      <InboxTabsPanel
        tabs={inboxTabs}
        statusCounts={inbox.counts}
        loaded={inbox.loaded}
        current={route.page === 'inbox' ? resolveTab(route.tab, inboxTabs.counts) : route.page === 'item' ? tabOfItem(inboxTabs, route.id) : null}
        onGo={(t) => navigate(`/inbox/${t}`)}
        onAdd={() => {
          setComposeSignal((n) => n + 1)
          if (route.page !== 'inbox') navigate('/inbox')
        }}
        onRefresh={() => void inboxStore.refresh(true)}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : (
      <SessionsPanel
        sessions={chatSessions}
        currentId={current?.teamRun?.role === 'worker' && teamRun ? teamRun.leadSessionId : currentId}
        drafts={drafts}
        currentDraftId={currentDraftId}
        onSelectDraft={(id) => navigate(draftRoute(id))}
        onDiscardDraft={discardDraft}
        onSelect={navigate}
        onNew={newSession}
        onRename={renameSession}
        onSetPinned={setPinned}
        onDelete={deleteSession}
        onSearch={() => setPaletteOpen(true)}
      />
    )

  return (
    // --panel-w lives on .app so the desktop title bar's left zone tracks the panel's width.
    <div className="app" style={{ '--panel-w': `${panelSize.width}px` } as CSSProperties}>
      <TopBar
        mobile={mobile}
        title={mobileTitle}
        onBack={mobileUp ?? undefined}
        workspaces={workspaces}
        workspaceId={workspaceId}
        conn={conn}
        onSwitchWorkspace={(id) => store.switchWorkspace(id)}
        onNewWorkspace={() => setWsModal({ kind: 'create' })}
        onWorkspaceSettings={() => openSettings('workspace')}
        onOpenSystem={(tab) => setSystem({ open: true, tab })}
        onOpenSettings={() => (route.page === 'settings' ? closeSettings() : openSettings())}
        settingsOpen={route.page === 'settings'}
        onHelp={() => setHelpOpen(true)}
        build={build}
        desktop={isDesktop ? { panelCollapsed: panelSize.collapsed, onTogglePanel: panelSize.toggleCollapsed } : undefined}
      />

      <div
        className={`shell${panelSize.dragging ? ' resizing' : ''}${panelSize.collapsed ? ' collapsed' : ''}${mobile ? ' mobile' : ''}${sheet ? ' sheetOpen' : ''}`}
      >
        <Rail
          active={mobile ? sheet ?? railActive : railActive}
          collapsed={mobile ? !sheet : undefined}
          inboxCount={inbox.items.length}
          runningCount={runningCount}
          terminalCount={terminals.filter((t) => t.status === 'running').length}
          changedCount={changes.projects.reduce((n, p) => n + p.checkouts.reduce((m, c) => m + c.files.length, 0), 0)}
          actionsCount={pendingActions}
          goalsCount={goals.waitingOnYou}
          juniorName={persona.name}
          juniorMood={juniorMood}
          onGo={onRailGo}
        />

        {route.page === 'settings' && !sheet ? (
          <SettingsPage workspace={activeWorkspace} tab={route.tab} onOpenSystem={(tab) => setSystem({ open: true, tab })} />
        ) : (
        <>
        {/* Triage.app's title bar carries the panel toggle, so the panel and tab band drop theirs. */}
        <PanelCollapseContext.Provider value={mobile || isDesktop ? null : collapsePanel}>{panel}</PanelCollapseContext.Provider>
        {!panelSize.collapsed && !mobile && panel && (
          <div
            className="panelResize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panel (double-click to reset)"
            title="Drag to resize · double-click to reset"
            {...panelSize.handleProps}
          />
        )}

        <div id="main">
          {!mobile && <TabBand
            activeKey={activeTabKey}
            tabs={openTabs}
            preview={previewTab}
            onPin={pin}
            pageTab={pageTab}
            onInbox={() => navigate('/inbox')}
            onShowPanel={panelSize.collapsed && !isDesktop ? () => panelSize.setCollapsed(false) : undefined}
            onSelect={(key) => navigate(routeOfKey(key))}
            onClose={closeOpenTab}
            onCloseAll={closeAllOpenTabs}
            onReorder={moveTab}
            onNew={newSession}
            onNewTerminal={newTerminal}
            terminalCwd={terminalCwd}
          />}

          <div className="content">
            {route.page === 'junior' ? (
              <JuniorPage onNavigate={navigate} onDispatch={dispatchById} />
            ) : route.page === 'inbox' ? (
              <InboxPage
                tab={resolveTab(route.tab, inboxTabs.counts)}
                tabs={inboxTabs}
                onDispatch={dispatch}
                onGoal={goalFrom}
                onRefineJob={refineJob}
                onOpenItem={openItem}
                onPinItem={(id, title) => pin(`item:${id}`, title)}
                composeSignal={composeSignal}
                onNavigate={navigate}
              />
            ) : route.page === 'item' ? (
              <ItemPage key={route.id} id={route.id} onDispatch={dispatch} onGoal={goalFrom} onNavigate={navigate} onDirty={pinCurrent} />
            ) : route.page === 'terminal' ? (
              currentTerminal ? (
                <TerminalPage
                  key={currentTerminal.id}
                  terminal={currentTerminal}
                  onRename={(title) => renameTerminal(currentTerminal.id, title)}
                  onClose={() => closeTerminal(currentTerminal.id)}
                  onNewHere={() => newTerminal(currentTerminal.cwd)}
                />
              ) : (
                <div id="empty">Terminal not found — it may have been closed.</div>
              )
            ) : route.page === 'terminals' ? (
              <div className="termHome">
                <div className="glow green" aria-hidden="true" />
                <h2 className="display">Terminals.</h2>
                <p>
                  A real shell, run by the daemon in a project folder. It lands as a tab beside your
                  sessions, and anything you start in it keeps running while you look elsewhere.
                </p>
                <div className="choices">
                  <NewTerminalMenu defaultCwd={terminalCwd} onNew={newTerminal} className="btn primary" />
                </div>
              </div>
            ) : route.page === 'artifacts' ? (
              <ArtifactsPage onOpen={(id) => navigate(`/artifact/${id}`)} onPin={(id, title) => pin(`artifact:${id}`, title)} />
            ) : route.page === 'artifact' ? (
              <ArtifactPage key={route.id} id={route.id} onNavigate={navigate} onDirty={pinCurrent} />
            ) : route.page === 'run' ? (
              <RunFolderPage
                key={route.runId}
                runId={route.runId}
                path={route.path}
                rev={sessions.find((s) => s.teamRun?.id === route.runId)?.teamRun?.rev ?? 0}
                onNavigate={navigate}
              />
            ) : route.page === 'changes' ? (
              <div className="termHome">
                <div className="glow green" aria-hidden="true" />
                <h2 className="display">Changes.</h2>
                <p>
                  Every uncommitted file in your projects, against HEAD — whoever changed it. Pick one on the
                  left to read its diff, and switch to Edit to fix it in place.
                </p>
              </div>
            ) : route.page === 'change' ? (
              <ChangePage
                key={`${route.checkoutId}/${route.path}`}
                checkoutId={route.checkoutId}
                path={route.path}
                onDirty={pinCurrent}
              />
            ) : route.page === 'jobs' ? (
              <JobsPage onNavigate={navigate} onAddJob={addJob} onPin={(id, title) => pin(`job:${id}`, title)} />
            ) : route.page === 'actions' ? (
              <ActionsPage onNavigate={navigate} />
            ) : route.page === 'goals' ? (
              <GoalsPage sessions={sessions} onNavigate={navigate} onPin={(key, title) => pin(key, title)} />
            ) : route.page === 'goal' ? (
              <GoalPage key={route.id} id={route.id} onNavigate={navigate} />
            ) : route.page === 'job' ? (
              <JobPage key={route.id} id={route.id} onNavigate={navigate} />
            ) : route.page === 'job-form' ? (
              <JobFormPage key={route.id ?? 'new'} id={route.id} onNavigate={navigate} />
            ) : route.page === 'draft' ? (
              currentDraft ? (
                <NewSessionComposer
                  key={currentDraft.id}
                  draft={currentDraft}
                  onChange={(patch) => draftStore.update(currentDraft.id, patch)}
                  onCreate={(s) => create(currentDraft.id, s)}
                  error={createError?.draftId === currentDraft.id ? createError : null}
                  step={createStep?.draftId === currentDraft.id ? createStep.step : null}
                />
              ) : (
                <div id="empty">This draft was discarded.</div>
              )
            ) : route.page === 'home' || route.page === 'settings' ? null : current ? (
              <div className={`sessRow${teamRun && teamSide ? ' withSide' : ''}${browserOpen ? ' withBrowser' : ''}`}>
              <div className="sessCol">
                <div id="chatHeader" ref={chatHeaderRef}>
                  <span id="chatTitle" title={current.title}>
                    {current.title}
                  </span>
                  <span className="pills">
                    {modelName && (
                      <span className="pill" title="Model · effort">
                        {modelName}
                        {current.effort ? ` · ${EFFORT_LABEL[current.effort].toLowerCase()}` : ''}
                      </span>
                    )}
                    {currentCheckout ? (
                      <CheckoutMenu checkout={currentCheckout} onNewTerminal={() => newTerminalIn(currentCheckout.id)}>
                        <CheckoutChip
                          checkout={currentCheckout}
                          projectName={
                            changes.projects.find((p) => p.project.id === currentCheckout.projectId)?.project.name ??
                            folderName(currentCheckout.path)
                          }
                          color={projectColor(currentCheckout.projectId)}
                          menu
                          size="sm"
                        />
                      </CheckoutMenu>
                    ) : (
                      <span className="pill mono" title={current.cwd}>
                        <span className="t" ref={folderTextRef}>
                          {folderShort ? folderName(current.cwd) : homely(current.cwd)}
                        </span>
                      </span>
                    )}
                    {!currentCheckout && (
                      <span className="pill mono measure" aria-hidden="true">
                        <span className="t" ref={folderMeasureRef}>
                          {homely(current.cwd)}
                        </span>
                      </span>
                    )}
                  </span>
                  {agents.length > 0 && (
                    <AgentsMenu agents={agents} current={openAgent?.toolUseId} onOpen={showAgent}>
                      <button type="button" className="btn sm ghost agentsBtn" title="Every agent this session has spawned">
                        Agents <span className="n">{agents.length}</span>
                        {agents.some((a) => a.state === 'running') && <span className="dot live" aria-hidden="true" />}
                      </button>
                    </AgentsMenu>
                  )}
                  {hasBrowser && !mobile && (
                    <button
                      type="button"
                      className={`btn sm ghost browserBtn${browserOpen ? ' on' : ''}`}
                      title={browserOpen ? 'Hide the browser pane' : 'Show this session’s browser — the page the agent checks its work in'}
                      aria-pressed={browserOpen}
                      onClick={() => browserPane.set(current.id, !browserOpen)}
                    >
                      <Globe size={14} aria-hidden="true" />
                      Browser
                    </button>
                  )}
                  <SessionCost sessionId={current.id} status={current.status} />
                  <span className={`state ${current.status}`}>
                    <span
                      className={`dot ${
                        current.status === 'running' || current.status === 'starting'
                          ? 'live'
                          : current.status === 'error'
                            ? 'red'
                            : 'green'
                      }`}
                    />
                    {STATUS_LABEL[current.status]}
                  </span>
                </div>
                {railOn && teamRun ? (
                  <RunHeader
                    run={teamRun}
                    sessionId={current.id}
                    sessions={sessions}
                    models={models}
                    current={runScroll.current}
                    onJump={runScroll.jump}
                    sideOpen={teamSide}
                    onToggleSide={() => setTeamSide((o) => !o)}
                    onOpenRun={openTeamRun}
                  />
                ) : teamRun && (
                  <TeamStrip
                    run={teamRun}
                    sessionId={current.id}
                    sessions={sessions}
                    models={models}
                    sideOpen={teamSide}
                    onToggleSide={() => setTeamSide((o) => !o)}
                    onNavigate={navigate}
                  />
                )}
                {openAgent && (
                  <AgentHeader run={openAgent} agents={agents} onOpen={showAgent} onStop={stopAgent} onBackground={backgroundAgent} />
                )}
                <Transcript
                  key={openAgent ? `${current.id}:${openAgent.toolUseId}` : current.id}
                  sessionId={current.id}
                  events={events}
                  turns={sessionChanges?.turns}
                  onRespond={respond}
                  onNavigate={navigate}
                  agents={agents}
                  shells={shells}
                  scope={openAgent?.toolUseId ?? null}
                  onOpenAgent={showAgent}
                  lead={openAgent && <AgentBrief run={openAgent} from={spawnerOf(agents, openAgent)} />}
                  tail={openAgent && <AgentOutcome run={openAgent} to={spawnerOf(agents, openAgent)} />}
                  marks={openAgent ? undefined : teamMarks}
                />
                {!openAgent && <AgentDock agents={agents} onOpen={showAgent} onStop={stopAgent} />}
                {!openAgent && <ShellDock sessionId={current.id} shells={shells} onStop={stopShell} />}
                {teamRun && current.teamRun?.role === 'lead' && !openAgent && <TeamDock run={teamRun} onDetails={() => setTeamSide((o) => !o)} onNavigate={navigate} />}
                {openAgent ? (
                  <AgentComposer key={`agent-composer-${openAgent.toolUseId}`} run={openAgent} onSend={(text) => messageAgent(openAgent, text)} />
                ) : currentCheckout?.state === 'removed' ? (
                  <GoneCheckoutBar checkout={currentCheckout} onContinueInMain={() => continueInMain(current)} />
                ) : (
                <Composer
                  key={`composer-${current.id}`}
                  sessionId={current.id}
                  status={current.status}
                  cwd={current.cwd}
                  projectId={current.projectId}
                  branch={currentCheckout?.branch ?? undefined}
                  model={current.model}
                  effort={current.effort}
                  fastMode={current.fastMode}
                  fastModeState={current.fastModeState}
                  fastModeDisabledReason={current.fastModeDisabledReason}
                  permissionMode={current.permissionMode}
                  planning={current.planning}
                  provider={current.provider ?? 'claude'}
                  onSend={sendMessage}
                  onPlanningChange={setPlanning}
                  onInterrupt={interrupt}
                  onModelChange={setModel}
                  onFastModeChange={setFastMode}
                  onPermissionModeChange={setPermissionMode}
                />
                )}
              </div>
              {browserOpen && <BrowserPane key={current.id} sessionId={current.id} />}
              {teamRun && teamSide && (
                <TeamSide
                  run={teamRun}
                  lead={current.teamRun?.role === 'lead'}
                  models={models}
                  onClose={() => setTeamSide(false)}
                  onNavigate={navigate}
                  tab={teamTab}
                  onTab={setTeamTab}
                  runsTools={<RunsViewToggle view={runsView} onView={setRunsView} />}
                  runs={railOn ? <TeamRuns view={runsView} run={teamRun} sessionId={current.id} sessions={sessions} models={models} current={runScroll.current} onOpenRun={openTeamRun} /> : undefined}
                  files={railOn ? <TeamFiles run={teamRun} checkoutId={teamCheckoutId} onNavigate={navigate} onOpenRun={openTeamRun} /> : undefined}
                />
              )}
              </div>
            ) : (
              <div id="empty">Session not found — it may have been deleted.</div>
            )}
          </div>
        </div>
        </>
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        sessions={chatSessions}
        terminals={terminals}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onNewSession={newSession}
        onNewTerminal={() => newTerminal(terminalCwd)}
        onOpenItem={(item) => openItem(item.id)}
        onNewSessionIn={newSessionIn}
        onSyncInbox={syncInbox}
        onAddJob={addJob}
        onOpenSettings={(tab) => openSettings(tab)}
        onHelp={() => setHelpOpen(true)}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SystemModal
        open={system.open}
        initialTab={system.tab}
        conn={conn}
        onClose={() => setSystem((s) => ({ ...s, open: false }))}
      />
      <WorkspaceModal mode={wsModal} onClose={() => setWsModal(null)} />
      <DefaultProjectGate workspaceId={workspaceId} suspended={wsModal !== null || !onboarded} />
    </div>
  )
}
