import { useState, useMemo, useEffect, useRef, useCallback, type CSSProperties } from 'react'
import { useLogUnread } from './juniorLog.js'
import type { TerminalSummary, WorkflowAgent, WorkflowRun } from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { focusedItemId } from './selection.js'
import { useSessionChanges } from './useSessionChanges.js'
import { ChangePage } from './components/ChangePage.js'
import { useChanges, changesStore } from './changesStore.js'
import { checkoutOf, branchSlug } from './checkouts.js'
import { GoneCheckoutBar } from './components/GoneCheckoutBar.js'
import { Composer } from './components/Composer.js'
import { BrowserPane } from './components/BrowserPane.js'
import { useBrowserOpen, useWindowNarrower } from './browser.js'
import { PanelCollapseContext, NewTerminalMenu } from './components/ContextPanel.js'
import { needsYouText, useInboxTabs, useInboxViews, resolveView } from './inboxTabs.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { FrictionCapture } from './components/FrictionCapture.js'
import { InboxPage } from './components/InboxPage.js'
import { JuniorPage } from './components/JuniorPage.js'
import { usePersona, useRailMood } from './junior.js'
import { ItemPage } from './components/ItemPage.js'
import { NewSessionComposer } from './components/NewSessionComposer.js'
import { type RailSection, Rail } from './components/Rail.js'
import { SettingsPage } from './components/SettingsPage.js'
import { type SystemTab, SystemModal } from './components/SystemModal.js'
import { type OpenTab, TabBand } from './components/TabBand.js'
import { useDrafts, draftStore, draftTitle } from './drafts.js'
import { TerminalPage } from './components/TerminalPage.js'
import { TopBar } from './components/TopBar.js'
import { UpdateBar } from './components/UpdateBar.js'
import { isDesktop } from './desktop.js'
import { Transcript } from './components/Transcript.js'
import { AgentHeader, AgentBrief, AgentOutcome, AgentDock, AgentComposer } from './components/Agents.js'
import { spawnerOf } from './agents.js'
import { ShellDock } from './components/Shells.js'
import { WorkflowDock } from './components/ultracode/WorkflowDock.js'
import { WorkflowSide } from './components/ultracode/WorkflowSide.js'
import { WorkflowAgentView } from './components/ultracode/WorkflowAgentView.js'
import { TeamStrip, TeamDock, TeamSide } from './components/TeamRun.js'
import { RunHeader, RunsViewToggle, TeamRuns, TeamFiles } from './components/TeamRail.js'
import { RunFolderPage } from './components/RunFolderPage.js'
import { JobsPage } from './components/JobsPage.js'
import { JobFormPage } from './components/JobFormPage.js'
import { JobPage } from './components/JobPage.js'
import { ArtifactsPage } from './components/ArtifactsPage.js'
import { usePendingActions } from './actions.js'
import { ArtifactPage } from './components/ArtifactPage.js'
import { DefaultProjectGate } from './components/DefaultProjectGate.js'
import { useOnboardingSkipped } from './onboarding.js'
import { type WorkspaceModalMode, WorkspaceModal } from './components/WorkspaceModal.js'
import { useConn, useSessions, useTerminals, useCheckouts, useHashRoute, useEvents, usePaging, useWorkspaces, useBuild, useUpdatePending, useWorkspaceId, useOnboarded } from './hooks.js'
import { useInbox, inboxStore } from './inboxStore.js'
import { useArtifacts, artifactStore } from './artifactStore.js'
import { useModels, findModel } from './models.js'
import { noteSettingsTab, noteReturnHash, closeSettings, openSettings } from './settings.js'
import { store } from './store.js'
import { usePanelWidth } from './panelWidth.js'
import { useIsMobile } from './useMobile.js'
import { useOpenTabs, useLastRoutes, projectColor } from './tabs.js'
import { AppPanel } from './app/AppPanel.js'
import { ChatHeader, useNarrowFolder } from './app/ChatHeader.js'
import { MOBILE_SHEETS, PAGE_TABS, SHEET_LABEL, isDocKey, routeOfKey, sectionOf, tabKeyOf } from './app/tabs.js'
import { useDispatchers } from './app/useDispatchers.js'
import { useDocumentTabs } from './app/useDocumentTabs.js'
import { useGlobalHotkeys } from './app/useGlobalHotkeys.js'
import { useNewSessionFlow } from './app/useNewSessionFlow.js'
import { useSessionActions } from './app/useSessionActions.js'
import { useSessionAgents } from './app/useSessionAgents.js'
import { useTeamRail } from './app/useTeamRail.js'
import { useWorkflowRail } from './app/useWorkflows.js'
import { isWorking } from './sessionModes.js'
import { useTerminalActions } from './app/useTerminalActions.js'

export function App() {
  const conn = useConn()
  const sessions = useSessions()
  const terminals = useTerminals()
  const checkouts = useCheckouts()
  const drafts = useDrafts()
  const models = useModels()
  const inbox = useInbox()
  const inboxTabs = useInboxTabs()
  const inboxViews = useInboxViews(inboxTabs)
  const artifacts = useArtifacts()
  const changes = useChanges()
  const [route, navigate] = useHashRoute()
  const currentId = route.page === 'session' ? route.id : null
  const currentTerminalId = route.page === 'terminal' ? route.id : null
  const currentDraftId = route.page === 'draft' ? route.id : null
  const events = useEvents(currentId)
  const paging = usePaging(currentId)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Fetched once per session for the transcript's turn markers.
  const sessionChanges = useSessionChanges(currentId)
  const [helpOpen, setHelpOpen] = useState(false)
  const [frictionOpen, setFrictionOpen] = useState(false)
  const [system, setSystem] = useState<{ open: boolean; tab: SystemTab }>({ open: false, tab: 'status' })
  const [composeSignal, setComposeSignal] = useState(0)
  const workspaces = useWorkspaces()
  const build = useBuild()
  const updatePending = useUpdatePending()
  const workspaceId = useWorkspaceId()
  const onboarded = useOnboarded()
  const [wsModal, setWsModal] = useState<WorkspaceModalMode | null>(null)
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null
  // Junior's first message owns a zero-project workspace; the default-project gate waits until it's skipped.
  const [onboardingSkipped] = useOnboardingSkipped(workspaceId)
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

  /** Every document the band is holding: pinned or peeked. */
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
  // Queued actions waiting on you: they set Junior's face on the rail.
  const pendingActions = usePendingActions()
  // Junior's name and face, everywhere it shows: the rail and the phone's title.
  const persona = usePersona()
  const juniorMood = useRailMood(pendingActions)
  const [sheet, setSheet] = useState<RailSection | null>(null)
  useEffect(() => setSheet(null), [route, mobile])

  // First run: the workspace modal asks only for the Claude login and checks
  // it. Name, colour and description keep their defaults (Settings → Workspace);
  // projects come from Junior's first message on the Junior page.
  useEffect(() => {
    if (!onboarded && activeWorkspace) {
      setWsModal({ kind: 'onboarding', workspace: activeWorkspace })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded, activeWorkspace?.id])

  // Junior's log has something new: a dot on the rail until you open the Log tab.
  const logUnread = useLogUnread()
  const current = sessions.find((s) => s.id === currentId) ?? null
  // The browser pane beside this session (.docs/browser.md), never on a phone. Outside
  // Junior.app it opens to say the browser lives there.
  const browserOpen = useBrowserOpen(currentId) && !mobile
  // A narrow window can't hold the chats list, a chat and the browser at once: while
  // the pane shows, the list steps aside for display only (the saved setting stays),
  // and comes back when the pane closes, the window widens, or you ask for it.
  const narrowWindow = useWindowNarrower(1180)
  const paneShown = browserOpen && route.page === 'session' && !!current
  const [keepPanel, setKeepPanel] = useState(false)
  useEffect(() => {
    if (!paneShown || !narrowWindow) setKeepPanel(false)
  }, [paneShown, narrowWindow])
  const panelStepsAside = paneShown && narrowWindow && !keepPanel && !panelSize.collapsed
  const panelCollapsed = panelSize.collapsed || panelStepsAside
  const currentCheckout = checkoutOf(checkouts, current?.checkoutId)
  const chatHeaderRef = useRef<HTMLDivElement>(null)
  const folderTextRef = useRef<HTMLSpanElement>(null)
  const folderMeasureRef = useRef<HTMLSpanElement>(null)
  const folderShort = useNarrowFolder(chatHeaderRef, folderTextRef, folderMeasureRef, `${current?.cwd}`)
  const { teamRun, teamSide, setTeamSide, teamTab, setTeamTab, runsView, setRunsView, railOn, runScroll, openTeamRun, teamMarks, teamCheckoutId } = useTeamRail({ current, currentId, events, mobile, navigate, openTab, sessions })
  const { agents, shells, workflows, openAgent, showAgent } = useSessionAgents({ events, current, currentId })
  // Ultracode runs: the run panel shares the team drawer's slot, so opening one closes the other.
  const wf = useWorkflowRail({ currentId, workflows, mobile, onOpenSide: () => setTeamSide(false) })
  const { closeSide: closeWfSide, closeAgent: closeWfAgent, openAgent: openWfAgentRaw, openRun: openWfRun } = wf
  useEffect(() => {
    if (teamSide) closeWfSide()
  }, [teamSide, closeWfSide])
  // A workflow agent's view and a subagent's take the same place: one at a time.
  useEffect(() => {
    if (openAgent) closeWfAgent()
  }, [openAgent?.toolUseId, closeWfAgent]) // eslint-disable-line react-hooks/exhaustive-deps
  const openWfAgent = useCallback(
    (toolUseId: string, agent: WorkflowAgent) => {
      showAgent(null)
      // On a phone the panel covers the page: get it out of the way of the agent's view.
      if (mobile) closeWfSide()
      openWfAgentRaw(toolUseId, agent)
    },
    [showAgent, mobile, closeWfSide, openWfAgentRaw],
  )
  const onOpenWorkflow = useCallback(
    (toolUseId: string, agent?: WorkflowAgent) => (agent ? openWfAgent(toolUseId, agent) : openWfRun(toolUseId)),
    [openWfAgent, openWfRun],
  )
  // Back from a workflow agent to main, with its run's panel open.
  const backToRun = useCallback(
    (toolUseId: string) => {
      closeWfAgent()
      openWfRun(toolUseId)
    },
    [closeWfAgent, openWfRun],
  )
  const stopWorkflow = useCallback(
    (run: WorkflowRun) => {
      if (currentId && run.taskId) store.send({ type: 'agent_stop', sessionId: currentId, agentId: run.taskId })
    },
    [currentId],
  )
  const currentTerminal = terminals.find((t) => t.id === currentTerminalId) ?? null
  const currentDraft = drafts.find((d) => d.id === currentDraftId) ?? null
  // Drafts are per workspace; bind before anything reads them.
  useEffect(() => draftStore.bind(workspaceId), [workspaceId])
  // Name the workspace in the tab title, with one tab per workspace, the
  // favicon alone cannot tell them apart.
  useEffect(() => {
    document.title = activeWorkspace ? `Junior • ${activeWorkspace.name}` : 'Junior'
  }, [activeWorkspace?.name])
  // The bare home route: Junior's page is the product's home. Goals are hidden,
  // so an old link to them (or to an old goal page) lands there too.
  useEffect(() => {
    if (route.page === 'home' || route.page === 'goals') navigate('/junior', { replace: true })
  }, [route.page, navigate])

  // Settings is a page: remember its tab for the gear, and every other page
  // as where Close and Esc go back to (Junior's page on a cold load).
  useEffect(() => {
    if (route.page === 'settings') noteSettingsTab(route.tab)
    else if (route.page !== 'home') noteReturnHash(location.hash.slice(1) || '/junior')
  }, [route])

  const { docTab, pin, pinCurrent } = useDocumentTabs({ conn, route, docKeys, inbox, artifacts, sessions, titles, openTab, remember, setPreview })

  // Rail memory: remember where you were in each section, so leaving and
  // coming back lands on what you were reading rather than the section root.
  useEffect(() => {
    const section = sectionOf(route)
    // `home` redirects to Junior's page above; `settings` sits outside the rail's sections.
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

  const { pendingDraft, createError, setCreateError, createStep } = useNewSessionFlow({ navigate, replaceTab, openTab, currentTerminalId, currentDraftId })

  // Replay the log whenever the selection changes (and after a reconnect);
  // a visited session gets a tab. A team run is one tab: walking from one of
  // its members to another (the drawer, the breadcrumb, back/forward) swaps
  // the session in the tab you're in, unless the member already has its own.
  const tabsNow = useRef(tabs)
  tabsNow.current = tabs
  const lastSession = useRef<string | null>(null)
  useEffect(() => {
    if (!currentId) return
    // The newest page only: a long session opens at once, older pages load as you scroll up.
    store.subscribeSession(currentId, { paged: true })
    const from = lastSession.current
    lastSession.current = currentId
    const runOf = (id: string) => sessions.find((s) => s.id === id)?.teamRun?.id
    const sameTeam = from && from !== currentId && runOf(from) && runOf(from) === runOf(currentId)
    if (sameTeam && tabsNow.current.includes(from) && !tabsNow.current.includes(currentId)) replaceTab(from, currentId)
    else openTab(currentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, conn, openTab])

  // Inbox is a regular tab: opening it pins it, and it can be closed.
  useEffect(() => {
    if (route.page === 'inbox') openTab('inbox')
  }, [route.page, openTab])

  const { respond, sendMessage, setPlanning, setUltracode, setModel, setFastMode, interrupt, stopAgent, stopShell, backgroundAgent, messageAgent, renameSession, setPinned, deleteSession, newSession, newSessionIn, discardDraft, syncInbox, openItem } = useSessionActions({ currentId, currentDraftId, navigate, closeTab })

  const { newTerminal, newTerminalIn, renameTerminal, closeTerminal, terminalCwd } = useTerminalActions({ closeTab, currentTerminalId, terminals, navigate, current, currentTerminal, currentDraft })

  // Back to a section lands on what you were last doing there; clicking the
  // section you are already in pops to its root (Inbox, Artifacts, Jobs).
  // Sessions and Terminals have no index page, their list *is* the panel, so
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

  // The rail only navigates: hiding the panel is its own button beside the
  // search field (and ⌘B). Clicking any icon while collapsed reopens it,
  // still landing on that section.
  const onRailGo = useCallback(
    (section: RailSection) => {
      if (mobile) {
        // The inbox's tabs, Sessions, Terminals and Changes live in the panel, 
        // so on a phone their tab opens it as a sheet; the
        // rest go to their page, and a second tap pops to its root.
        if (MOBILE_SHEETS.includes(section)) setSheet((s) => (s === section ? null : section))
        else {
          setSheet(null)
          goTo(section)
        }
      } else {
        if (panelStepsAside) setKeepPanel(true)
        if (panelSize.collapsed) panelSize.setCollapsed(false)
        goTo(section)
      }
    },
    [mobile, panelSize, panelStepsAside, goTo],
  )

  const collapsePanel = useCallback(() => panelSize.setCollapsed(true), [panelSize])

  // Closing the tab you are on lands you on its neighbour, else the inbox.
  // A terminal tab closing does not kill the shell. That is the panel's menu.
  const activeTabKey = tabKeyOf(route) ?? 'home'
  const closeOpenTab = useCallback(
    (key: string) => {
      if (key === activeTabKey) {
        // A pinned tab hands over to its neighbour; the preview has none.
        const i = tabs.indexOf(key)
        const next = i === -1 ? undefined : tabs[i + 1] ?? tabs[i - 1]
        navigate(next ? routeOfKey(next) : '/junior')
      }
      // Closing a draft tab discards the draft. There is nowhere else it lives.
      if (key.startsWith('draft:')) draftStore.remove(key.slice(6))
      closeTab(key)
    },
    [tabs, activeTabKey, navigate, closeTab],
  )

  // Empty the band. Drafts go with their tabs: that is the only place they
  // live, and with nothing left open, Junior's page is where you land.
  const closeAllOpenTabs = useCallback(() => {
    for (const key of [...tabs, ...(preview ? [preview] : [])]) {
      if (key.startsWith('draft:')) draftStore.remove(key.slice(6))
    }
    closeAllTabs()
    navigate('/junior')
  }, [tabs, preview, closeAllTabs, navigate])

  useGlobalHotkeys({ route, navigate, newSession, newTerminal, terminalCwd, goTo, currentId, panelSize, setHelpOpen, setPaletteOpen, setFrictionOpen, setComposeSignal })

  const { create, addJob, refineJob, dispatch, dispatchById, continueInMain } = useDispatchers({ navigate, pendingDraft, setCreateError, inbox, checkouts })

  // derived shell state

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
        if (key === 'inbox') return [{ key, kind: 'inbox', title: 'Inbox', color: 'var(--stone)', running: false }]
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
                running: isWorking(s),
                ...(needsYouText(s) ? { waiting: needsYouText(s)! } : {}),
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
    route.page === 'jobs' || route.page === 'terminals' || route.page === 'artifacts' || route.page === 'changes'
      ? PAGE_TABS[route.page]
      : null

  const previewTab = useMemo<OpenTab | null>(() => {
    const t = preview ? docTab(preview) : null
    return t ? { ...t, preview: true } : null
  }, [preview, docTab])

  // The phone's top bar: what is in front, and where "back" goes. Back is
  // *up*, to the page's list, rather than browser history, so it means the
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
  const runningCount = chatSessions.filter(isWorking).length
  const modelName = current ? findModel(models, current.model)?.name ?? current.model : undefined

  // The Actions page is a list and a detail side by side: it needs the room, so no panel beside it.
  // Junior's page is one centred column: no panel beside it either.
  const panel =
    !panelSection || panelSection === 'actions' || panelSection === 'goals' || panelSection === 'junior' ? null : (
      <AppPanel
        panelSection={panelSection}
        terminals={terminals}
        currentTerminalId={currentTerminalId}
        terminalCwd={terminalCwd}
        navigate={navigate}
        newTerminal={newTerminal}
        newTerminalIn={newTerminalIn}
        renameTerminal={renameTerminal}
        closeTerminal={closeTerminal}
        setPaletteOpen={setPaletteOpen}
        setComposeSignal={setComposeSignal}
        artifacts={artifacts}
        changes={changes}
        inbox={inbox}
        inboxTabs={inboxTabs}
        inboxViews={inboxViews}
        route={route}
        pin={pin}
        chatSessions={chatSessions}
        current={current}
        currentId={currentId}
        teamRun={teamRun}
        drafts={drafts}
        currentDraftId={currentDraftId}
        discardDraft={discardDraft}
        newSession={newSession}
        renameSession={renameSession}
        setPinned={setPinned}
        deleteSession={deleteSession}
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
        desktop={isDesktop ? { panelCollapsed, onTogglePanel: panelStepsAside ? () => setKeepPanel(true) : panelSize.toggleCollapsed } : undefined}
      />
      <UpdateBar pending={updatePending} mobile={mobile} onReload={store.reloadForUpdate} onHide={store.hideUpdate} />

      <div
        className={`shell${panelSize.dragging ? ' resizing' : ''}${panelCollapsed ? ' collapsed' : ''}${mobile ? ' mobile' : ''}${sheet ? ' sheetOpen' : ''}`}
      >
        <Rail
          active={mobile ? sheet ?? railActive : railActive}
          collapsed={mobile ? !sheet : undefined}
          inboxCount={inbox.items.length}
          runningCount={runningCount}
          terminalCount={terminals.filter((t) => t.status === 'running').length}
          changedCount={changes.projects.reduce((n, p) => n + p.checkouts.reduce((m, c) => m + c.files.length, 0), 0)}
          juniorName={persona.name}
          juniorMood={juniorMood}
          juniorUnread={logUnread}
          onGo={onRailGo}
        />

        {route.page === 'settings' && !sheet ? (
          <SettingsPage workspace={activeWorkspace} tab={route.tab} onOpenSystem={(tab) => setSystem({ open: true, tab })} />
        ) : (
        <>
        {/* Junior.app's title bar carries the panel toggle, so the panel and tab band drop theirs. */}
        <PanelCollapseContext.Provider value={mobile || isDesktop ? null : collapsePanel}>{panel}</PanelCollapseContext.Provider>
        {!panelCollapsed && !mobile && panel && (
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
            onShowPanel={panelCollapsed && !isDesktop ? () => (panelStepsAside ? setKeepPanel(true) : panelSize.setCollapsed(false)) : undefined}
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
              <JuniorPage key={route.tab ?? 'home'} initialTab={route.tab} onNavigate={navigate} onDispatch={dispatchById} onCreate={create} createError={createError} createStep={createStep} />
            ) : route.page === 'inbox' ? (
              <InboxPage
                view={resolveView(route.view, inboxTabs)}
                tabs={inboxTabs}
                views={inboxViews}
                onDispatch={dispatch}
                onRefineJob={refineJob}
                onOpenItem={openItem}
                onPinItem={(id, title) => pin(`item:${id}`, title)}
                composeSignal={composeSignal}
                onNavigate={navigate}
              />
            ) : route.page === 'item' ? (
              <ItemPage key={route.id} id={route.id} onDispatch={dispatch} onNavigate={navigate} onDirty={pinCurrent} />
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
            ) : route.page === 'home' || route.page === 'settings' || route.page === 'goals' ? null : current ? (
              <div className={`sessRow${(teamRun && teamSide) || wf.sideRun ? ' withSide' : ''}${browserOpen ? ' withBrowser' : ''}`}>
              <div className="sessCol">
                <ChatHeader
                  current={current}
                  chatHeaderRef={chatHeaderRef}
                  folderTextRef={folderTextRef}
                  folderMeasureRef={folderMeasureRef}
                  folderShort={folderShort}
                  modelName={modelName}
                  currentCheckout={currentCheckout}
                  newTerminalIn={newTerminalIn}
                  changes={changes}
                  agents={agents}
                  openAgent={openAgent}
                  showAgent={showAgent}
                  mobile={mobile}
                  browserOpen={browserOpen}
                  onNavigate={navigate}
                />
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
                {wf.agentView ? (
                  <WorkflowAgentView
                    key={`${current.id}:${wf.agentView.run.toolUseId}:${wf.agentView.index}`}
                    sessionId={current.id}
                    run={wf.agentView.run}
                    index={wf.agentView.index}
                    agentId={wf.agentView.agentId}
                    events={events}
                    onRespond={respond}
                    onBack={closeWfAgent}
                    onOpenRun={backToRun}
                    onNavigate={navigate}
                  />
                ) : (
                <>
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
                  speaker={!openAgent && (current.provider ?? 'claude') === 'claude' ? { status: current.status } : undefined}
                  workflows={workflows}
                  onOpenWorkflow={onOpenWorkflow}
                  paging={paging}
                  onLoadEarlier={store.loadEarlier}
                  onRetryEarlier={store.retryEarlier}
                />
                {!openAgent && <AgentDock agents={agents} onOpen={showAgent} onStop={stopAgent} />}
                {!openAgent && <ShellDock sessionId={current.id} shells={shells} onStop={stopShell} />}
                {!openAgent && <WorkflowDock workflows={workflows} onDetails={openWfRun} onStop={stopWorkflow} />}
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
                  planning={current.planning}
                  ultracode={current.ultracode}
                  provider={current.provider ?? 'claude'}
                  onSend={sendMessage}
                  onPlanningChange={setPlanning}
                  onUltracodeChange={setUltracode}
                  ultracodeEver={!!current.ultracode || workflows.length > 0 || events.some((e) => e.kind === 'notice' && e.text.startsWith('Ultracode'))}
                  onInterrupt={interrupt}
                  onModelChange={setModel}
                  onFastModeChange={setFastMode}
                />
                )}
                </>
                )}
              </div>
              {browserOpen && <BrowserPane key={current.id} tabKey={current.id} onTerminal={currentCheckout ? () => newTerminalIn(currentCheckout.id) : undefined} />}
              {wf.sideRun && (
                <WorkflowSide
                  sessionId={current.id}
                  run={wf.sideRun}
                  runs={workflows}
                  tab={wf.tab}
                  onTab={wf.setTab}
                  onPick={openWfRun}
                  onClose={closeWfSide}
                  onOpenAgent={(run, agent) => openWfAgent(run.toolUseId, agent)}
                />
              )}
              {teamRun && teamSide && !wf.sideRun && (
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
        focusedItemId={paletteOpen ? focusedItemId(route, sessions) : null}
        onJuniorPage={route.page === 'junior'}
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
        onNoteFriction={() => setFrictionOpen(true)}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <FrictionCapture open={frictionOpen} onOpenChange={setFrictionOpen} route={route} sessions={sessions} />
      <SystemModal
        open={system.open}
        initialTab={system.tab}
        conn={conn}
        onClose={() => setSystem((s) => ({ ...s, open: false }))}
      />
      <WorkspaceModal mode={wsModal} onClose={() => setWsModal(null)} />
      <DefaultProjectGate workspaceId={workspaceId} suspended={wsModal !== null || !onboarded} onboardingSkipped={onboardingSkipped} />
    </div>
  )
}
