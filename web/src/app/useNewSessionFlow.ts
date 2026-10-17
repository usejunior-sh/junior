import { useRef, useState, useEffect } from 'react'
import type { CreateStep } from '../../../shared/protocol.js'
import { draftStore } from '../drafts.js'
import { store } from '../store.js'
import { draftKey, termKey } from './tabs.js'
import type { Navigate, TabsApi } from './types.js'

export function useNewSessionFlow({ navigate, replaceTab, openTab, currentTerminalId, currentDraftId }: {
  navigate: Navigate
  replaceTab: TabsApi['replace']
  openTab: TabsApi['open']
  currentTerminalId: string | null
  currentDraftId: string | null
}) {
  // A session created from this tab becomes the selected one, and when it
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

  return { pendingDraft, createError, setCreateError, createStep }
}
