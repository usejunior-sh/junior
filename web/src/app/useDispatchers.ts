import { type Dispatch, type SetStateAction, useCallback } from 'react'
import { type ScoredItem, type Mention, type DispatchPreviewResponse, type ProjectsResponse, type ItemDetailResponse, type SessionSummary, mentionToken } from '../../../shared/protocol.js'
import type { NewSession } from '../components/NewSessionComposer.js'
import { dispatchTitle, dispatchPrompt } from '../dispatch.js'
import { draftStore } from '../drafts.js'
import { REFINE_JOB_KEY } from '../components/JobFormPage.js'
import { useCheckouts } from '../hooks.js'
import { useInbox } from '../inboxStore.js'
import { store } from '../store.js'
import { draftRoute } from './tabs.js'
import type { Navigate } from './types.js'

export function useDispatchers({ navigate, pendingDraft, setCreateError, inbox, checkouts }: {
  navigate: Navigate
  pendingDraft: { current: string | null }
  setCreateError: Dispatch<SetStateAction<{ draftId: string; message: string } | null>>
  inbox: ReturnType<typeof useInbox>
  checkouts: ReturnType<typeof useCheckouts>
}) {
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
      ...(s.files ? { files: s.files } : {}),
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

  return { create, addJob, goalFrom, refineJob, dispatch, dispatchById, continueInMain }
}
