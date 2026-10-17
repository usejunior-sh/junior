import { useCallback } from 'react'
import type { PermissionBehavior, QuestionAnswers, ImageAttachment, Mention, EffortLevel, PermissionMode, Project } from '../../../shared/protocol.js'
import { composerDrafts } from '../composerDrafts.js'
import { draftStore } from '../drafts.js'
import { type AgentRun, agentLabel } from '../agents.js'
import type { ShellRun } from '../../../core/shells/fold.js'
import { itemHash } from '../hooks.js'
import { inboxStore } from '../inboxStore.js'
import { store } from '../store.js'
import { draftKey, draftRoute } from './tabs.js'
import type { Navigate, TabsApi } from './types.js'

export function useSessionActions({ currentId, currentDraftId, navigate, closeTab }: {
  currentId: string | null
  currentDraftId: string | null
  navigate: Navigate
  closeTab: TabsApi['close']
}) {
  const respond = useCallback(
    (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => {
      if (currentId)
        store.send({ type: 'permission_response', sessionId: currentId, requestId, behavior, answers })
    },
    [currentId],
  )

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[], mentions?: Mention[], mode?: 'goal', files?: string[]) => {
      if (currentId) store.send({ type: 'user_message', sessionId: currentId, text, images, ...(files ? { files } : {}), mentions, ...(mode ? { mode } : {}) })
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

  return { respond, sendMessage, setPlanning, setModel, setFastMode, setPermissionMode, interrupt, stopAgent, stopShell, backgroundAgent, messageAgent, renameSession, setPinned, deleteSession, newSession, newSessionIn, discardDraft, syncInbox, openItem }
}
