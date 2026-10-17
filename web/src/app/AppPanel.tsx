import type { Dispatch, SetStateAction } from 'react'
import type { SessionSummary } from '../../../shared/protocol.js'
import { ChangesPanel } from '../components/ChangesPanel.js'
import { useChanges, changeId } from '../changesStore.js'
import { TerminalsPanel, ArtifactsPanel, InboxTabsPanel, SessionsPanel } from '../components/ContextPanel.js'
import { useInboxTabs, resolveTab, tabOfItem } from '../inboxTabs.js'
import type { RailSection } from '../components/Rail.js'
import { useDrafts } from '../drafts.js'
import { useTeamRun } from '../components/TeamRun.js'
import { useTerminals, type Route } from '../hooks.js'
import { useInbox, inboxStore } from '../inboxStore.js'
import { useArtifacts, artifactStore } from '../artifactStore.js'
import { draftRoute } from './tabs.js'
import type { Navigate } from './types.js'

export function AppPanel({
  panelSection,
  terminals,
  currentTerminalId,
  terminalCwd,
  navigate,
  newTerminal,
  newTerminalIn,
  renameTerminal,
  closeTerminal,
  setPaletteOpen,
  setComposeSignal,
  artifacts,
  changes,
  inbox,
  inboxTabs,
  route,
  pin,
  chatSessions,
  current,
  currentId,
  teamRun,
  drafts,
  currentDraftId,
  discardDraft,
  newSession,
  renameSession,
  setPinned,
  deleteSession,
}: {
  panelSection: Exclude<RailSection, 'actions' | 'goals' | 'junior'>
  terminals: ReturnType<typeof useTerminals>
  currentTerminalId: string | null
  terminalCwd: string | undefined
  navigate: Navigate
  newTerminal: (cwd?: string) => void
  newTerminalIn: (checkoutId: string) => void
  renameTerminal: (terminalId: string, title: string) => void
  closeTerminal: (terminalId: string) => void
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setComposeSignal: Dispatch<SetStateAction<number>>
  artifacts: ReturnType<typeof useArtifacts>
  changes: ReturnType<typeof useChanges>
  inbox: ReturnType<typeof useInbox>
  inboxTabs: ReturnType<typeof useInboxTabs>
  route: Route
  pin: (key: string, title?: string) => void
  chatSessions: readonly SessionSummary[]
  current: SessionSummary | null
  currentId: string | null
  teamRun: ReturnType<typeof useTeamRun>
  drafts: ReturnType<typeof useDrafts>
  currentDraftId: string | null
  discardDraft: (id: string) => void
  newSession: () => void
  renameSession: (sessionId: string, title: string) => void
  setPinned: (sessionId: string, pinned: boolean) => void
  deleteSession: (sessionId: string) => void
}) {
  return panelSection === 'terminals' ? (
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
}
