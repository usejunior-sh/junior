import { RefreshCw, Check } from 'lucide-react'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ScoredItem, Project, ItemStatus, ItemListResponse, BriefJobsResponse, ProjectsResponse, ReposResponse, JobsResponse } from '../../../shared/protocol.js'
import { useInbox, inboxStore } from '../inboxStore.js'
import { useBriefs, briefStore } from '../briefStore.js'
import { BriefComposerDialog } from './BriefComposer.js'
import { DueDialog } from './DueDialog.js'
import { ago } from '../itemUi.js'
import { isTypingTarget, anyDialogOpen, isGoSequence } from '../keys.js'
import { type Section, SECTION_ORDER, dueFor, parseDue } from '../../../core/work/due.js'
import type { Turn } from '../../../core/work/flow.js'
import { OPEN_TABS, type TabEntry } from '../../../core/work/inbox-tabs.js'
import { type InboxRoute, VIEW_TITLE } from '../../../core/work/inbox-views.js'
import type { Tabs, Views } from '../inboxTabs.js'
import { ItemComposer, RepoPicker } from './inbox/ItemComposer.js'
import { DUE_KEYS, signalIds, tomorrow9 } from './inbox/rowHelpers.js'
import { type RowActions, SelectionBar } from './inbox/SelectionBar.js'
import { AlertRow, EMPTY_TEXT, SessionRow, WorkRow, WorkRowWithSessions } from './inbox/WorkRow.js'

type OtherState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: ScoredItem[] }
  | { phase: 'error'; message: string }

type Props = {
  /** the view in front: the route's (`#/inbox/<view>`), resolved by the shell */
  view: InboxRoute
  /** the open tabs (row order, held sessions), shared with the sidebar */
  tabs: Tabs
  /** the open views cut from them, so the sidebar's counts are the rows */
  views: Views
  onDispatch: (item: ScoredItem) => void
  onRefineJob: (item: ScoredItem) => void
  onOpenItem: (id: string) => void
  /** Keep it in the band without leaving the inbox (⌘-click, middle-click). */
  onPinItem: (id: string, title: string) => void
  /** Bumped by the shell (Queue panel "+") to open the new-item composer. */
  composeSignal?: number
  /** Go to a route: a job or a session an alert points at. */
  onNavigate: (path: string) => void
}

export function InboxPage({ view, tabs, views, onDispatch, onRefineJob, onOpenItem, onPinItem, composeSignal = 0, onNavigate }: Props) {
  // The open views read the shared snapshot (the sidebar counts the same rows);
  // Done, Snoozed and Archived are loaded here on demand, and All adds Done to the open rows.
  const snap = useInbox()
  // Archived holds deleted to-dos too; this picks which of the two it lists.
  const [deletedOnly, setDeletedOnly] = useState(false)
  const [other, setOther] = useState<OtherState>({ phase: 'loading' })
  const [reposOpen, setReposOpen] = useState(false)
  const [repoCount, setRepoCount] = useState<number | null>(null)
  const [jobTitles, setJobTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [composer, setComposer] = useState<{ open: boolean; editing: ScoredItem | null }>({
    open: false,
    editing: null,
  })
  const [pickingDue, setPickingDue] = useState<ScoredItem | null>(null)
  const [scanning, setScanning] = useState(false)
  const [sel, setSel] = useState(0)
  // Multi-select: checked rows brief together.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [briefError, setBriefError] = useState<string | null>(null)
  /** one row's brief, composed in place */
  const [briefing, setBriefing] = useState<ScoredItem | null>(null)
  const briefs = useBriefs()
  useEffect(() => {
    if (!briefs.loaded) void briefStore.refresh()
  }, [briefs.loaded])
  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Open rows come from the snapshot; a view of a status (or All's done rows) from the server.
  const isOpen = view === 'todo' || view === 'doing' || view === 'all'
  const otherStatus: ItemStatus | null = view === 'todo' || view === 'doing' ? null : view === 'all' ? 'done' : view

  const loadOther = useCallback(async (which: ItemStatus) => {
    setOther({ phase: 'loading' })
    try {
      const res = await fetch(`/api/items?status=${which}`)
      const body = (await res.json()) as ItemListResponse
      setOther(body.ok ? { phase: 'ready', items: body.items } : { phase: 'error', message: body.error })
    } catch (err) {
      setOther({ phase: 'error', message: String(err) })
    }
  }, [])

  const reload = useCallback(
    (refresh: boolean) => {
      if (isOpen) void inboxStore.refresh(refresh)
      if (otherStatus) void loadOther(otherStatus)
    },
    [isOpen, otherStatus, loadOther],
  )

  const scanNow = useCallback(async () => {
    setScanning(true)
    try {
      await fetch('/api/scan', { method: 'POST' }).catch(() => {})
      // give the forced GitHub reconcile a moment, then reload
      setTimeout(() => void inboxStore.refresh(true), 1200)
    } finally {
      setTimeout(() => setScanning(false), 1200)
    }
  }, [])

  const projectName = useCallback(
    (id?: string) => (id ? projects.find((p) => p.id === id)?.name : undefined),
    [projects],
  )

  const removeLocally = useCallback((id: string) => {
    inboxStore.patch((items) => items.filter((i) => i.id !== id))
    setOther((prev) => (prev.phase === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : prev))
  }, [])

  // A status change is a recorded transition on a durable item, the row leaves
  // the current tab optimistically; the item is never deleted (.docs/jobs-v2.md).
  // A row is every signal folded into it, so they all move together.
  const setItemState = useCallback(
    async (item: ScoredItem, status: ItemStatus, snoozeUntil?: number) => {
      removeLocally(item.id)
      await Promise.all(
        signalIds(item).map((id) =>
          fetch('/api/items/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, status, snoozeUntil }),
          }).catch(() => {}),
        ),
      )
    },
    [removeLocally],
  )

  // A priority override applies to any item and survives re-sync. Reflect the
  // chip immediately; re-ranking lands on the next refresh.
  const setPriority = useCallback((item: ScoredItem, priority: number) => {
    inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, priority: priority || undefined } : i)))
    void fetch('/api/items/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, priority: priority || null }),
    }).catch(() => {})
  }, [])

  // "Delete" a manual item archives it (never a hard delete); it moves to Archived.
  const deleteManual = useCallback(
    (item: ScoredItem) => {
      removeLocally(item.id)
      void fetch(`/api/items/manual?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {})
    },
    [removeLocally],
  )

  const snooze1d = useCallback((item: ScoredItem, until?: number) => void setItemState(item, 'snoozed', until ?? tomorrow9()), [setItemState])

  // Whose turn, when the rules can't see it. The row moves tab on the refetch
  // the server's inbox_changed brings.
  const setTurn = useCallback((item: ScoredItem, turn: Turn | null) => {
    void fetch('/api/items/flow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(turn ? { id: item.id, turn } : { id: item.id, clear: true }),
    }).catch(() => {})
  }, [])

  // A due set here is yours and outlives rescans. The row moves section now;
  // the server resolves the bucket to the same day.
  const setDue = useCallback((targets: ScoredItem[], due: Section | string) => {
    const at = (SECTION_ORDER as string[]).includes(due) ? dueFor(due as Section, Date.now()) : parseDue(due)
    const ids = new Set(targets.map((t) => t.id))
    inboxStore.patch((items) =>
      items.map((i) => (ids.has(i.id) ? { ...i, dueSource: 'you' as const, dueAt: at ?? undefined } : i)),
    )
    for (const id of targets.flatMap(signalIds)) {
      void fetch('/api/items/due', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, due }),
      }).catch(() => {})
    }
  }, [])

  // The route picks the view; a status view (and All, for its done rows) loads its list when it comes up.
  useEffect(() => {
    setSel(0)
    if (otherStatus) void loadOther(otherStatus)
  }, [otherStatus, loadOther])

  // The open rows, in the tabs' reading order: held on you, due and people waiting first.
  const entries = useMemo<readonly TabEntry<ScoredItem>[]>(
    () => (view === 'todo' ? views.todo : view === 'doing' ? views.doing : view === 'all' ? OPEN_TABS.flatMap((t) => tabs.tabs.get(t) ?? []) : []),
    [view, views, tabs],
  )
  const openIds = useMemo(() => new Set(entries.map((e) => e.item.id)), [entries])
  const isOpenItem = useCallback((i: ScoredItem) => openIds.has(i.id), [openIds])

  // The list a status view shows, or All's done rows under the open ones.
  const others = useMemo<readonly ScoredItem[]>(
    () => (other.phase !== 'ready' || !otherStatus ? [] : view === 'archived' ? other.items.filter((i) => !!i.deleted === deletedOnly) : other.items),
    [other, otherStatus, view, deletedOnly],
  )

  // Items in on-screen order: the open entries, then the status list.
  const ordered = useMemo<readonly ScoredItem[]>(() => [...entries.map((e) => e.item), ...others], [entries, others])

  // The live selection: checked open rows still on screen. Ids of rows that
  // already left the view (done via the keyboard, refreshed away) don't count.
  const checkedItems = useMemo(() => ordered.filter((i) => openIds.has(i.id) && checked.has(i.id)), [ordered, openIds, checked])
  const clearChecked = useCallback(() => setChecked(new Set()), [])

  // Bulk transition: every checked row leaves the tab optimistically, the N
  // single-item POSTs run together, and a failed one resyncs the list so it
  // stays honest (there is no batch form of /api/items/state).
  const bulkState = useCallback(
    async (status: ItemStatus, snoozeUntil?: number) => {
      const targets = checkedItems
      if (!targets.length) return
      clearChecked()
      for (const t of targets) removeLocally(t.id)
      const results = await Promise.allSettled(
        targets.flatMap(signalIds).map((id) =>
          fetch('/api/items/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, status, snoozeUntil }),
          }),
        ),
      )
      if (results.some((r) => r.status === 'rejected' || !r.value.ok)) reload(false)
    },
    [checkedItems, clearChecked, removeLocally, reload],
  )

  // One item: the composer, with its template to edit.
  const briefOne = useCallback((item: ScoredItem) => setBriefing(item), [])

  // Checked items: queued at once, each with its own kind's template, editing is per item.
  const briefChecked = useCallback(async () => {
    const targets = checkedItems
    if (!targets.length) return
    setBriefError(null)
    try {
      const res = await fetch('/api/briefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemIds: targets.map((t) => t.id) }),
      })
      const b = (await res.json()) as BriefJobsResponse
      if (!b.ok) return setBriefError(b.error)
      for (const j of b.jobs) briefStore.apply(j)
      clearChecked()
    } catch (err) {
      setBriefError(String(err))
    }
  }, [checkedItems, clearChecked])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e) || anyDialogOpen() || isGoSequence(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const cur = ordered[sel]
      // All mixes open and done rows: what a key does follows the row under it.
      const curOpen = !!cur && openIds.has(cur.id)
      const due = curOpen || checkedItems.length ? DUE_KEYS[e.key] : undefined
      if (due) {
        const picked = checkedItems.length ? checkedItems : cur ? [cur] : []
        if (picked.length) {
          e.preventDefault()
          setDue(picked, due)
        }
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((v) => Math.min(v + 1, Math.max(0, ordered.length - 1)))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((v) => Math.max(v - 1, 0))
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault()
        onOpenItem(cur.id)
      } else if (e.key === 'o' && cur?.url) {
        e.preventDefault()
        window.open(cur.url, '_blank', 'noopener')
      } else if (e.key === 'd' && cur) {
        e.preventDefault()
        onDispatch(cur)
      } else if (e.key === 'b' && (curOpen || checkedItems.length)) {
        e.preventDefault()
        if (checkedItems.length) void briefChecked()
        else if (cur) briefOne(cur)
      } else if (e.key === ' ' && cur && curOpen) {
        e.preventDefault()
        toggleChecked(cur.id)
      } else if (e.key === 'Escape' && checkedItems.length && !e.defaultPrevented) {
        e.preventDefault()
        clearChecked()
      } else if (e.key === 'e' && checkedItems.length) {
        e.preventDefault()
        void bulkState('done')
      } else if (e.key === 'e' && cur) {
        e.preventDefault()
        void setItemState(cur, curOpen ? 'done' : 'open')
      } else if (e.key === 'x' && checkedItems.length) {
        e.preventDefault()
        void bulkState('archived')
      } else if (e.key === 'x' && cur) {
        e.preventDefault()
        void setItemState(cur, 'archived')
      } else if (e.key === 'z' && checkedItems.length) {
        e.preventDefault()
        void bulkState('snoozed', tomorrow9())
      } else if (e.key === 'z' && cur && curOpen) {
        e.preventDefault()
        snooze1d(cur)
      } else if (e.key === 'r') {
        e.preventDefault()
        reload(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ordered, sel, openIds, onDispatch, onOpenItem, reload, setItemState, snooze1d, setDue, checkedItems, toggleChecked, bulkState, clearChecked, briefChecked, briefOne])

  const loadProjects = useCallback(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!snap.loaded) void inboxStore.refresh(false)
    loadProjects()
    void fetch('/api/repos')
      .then((r) => r.json() as Promise<ReposResponse>)
      .then((b) => {
        if (b.ok) setRepoCount(b.connected.length)
      })
      .catch(() => {})
    void fetch('/api/jobs')
      .then((r) => r.json() as Promise<JobsResponse>)
      .then((b) => {
        if (b.ok) setJobTitles(new Map(b.jobs.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadProjects])

  // The shell's "+" (Queue panel) opens the composer from anywhere in the inbox.
  const lastSignal = useRef(composeSignal)
  useEffect(() => {
    if (composeSignal !== lastSignal.current) {
      lastSignal.current = composeSignal
      setComposer({ open: true, editing: null })
    }
  }, [composeSignal])

  const loading = (isOpen && !snap.loaded && snap.loading) || (!!otherStatus && other.phase === 'loading')
  const error = (isOpen && !snap.loaded ? snap.error : undefined) ?? (otherStatus && other.phase === 'error' ? other.message : undefined)
  const items = ordered
  // In progress (and All) also hold what isn't an item but is held on you: a
  // blocked session with no open item, a failed job, a paused run.
  const held = view === 'doing' || view === 'all'
  const alerts = held ? snap.alerts : []
  const orphans = held ? tabs.orphans : []
  const count = items.length + alerts.length + orphans.length
  const viewLabel = VIEW_TITLE[view]
  const emptyText =
    isOpen && snap.notices.length > 0
      ? 'Nothing here — but a source is degraded, so this may be incomplete.'
      : EMPTY_TEXT[view]

  const rowProps: RowActions = {
    view,
    isOpenItem,
    projectName,
    onSelect: (id) => setSel(ordered.findIndex((i) => i.id === id)),
    onOpen: onOpenItem,
    onPin: onPinItem,
    onDispatch,
    onDone: (i) => void setItemState(i, 'done'),
    onSnooze: snooze1d,
    onArchive: (i) => void setItemState(i, 'archived'),
    onReopen: (i) => void setItemState(i, 'open'),
    onRefineJob,
    onSetPriority: setPriority,
    onSetDue: (i, due) => setDue([i], due),
    onPickDue: setPickingDue,
    onEdit: (i) => setComposer({ open: true, editing: i }),
    onDelete: deleteManual,
    checked,
    onToggle: toggleChecked,
    onBrief: briefOne,
    briefOf: (id) => briefs.byItem.get(id),
    onSetTurn: setTurn,
  }

  return (
    <div className="page full" id="inboxPage">
      <div className="glow blue" aria-hidden="true" />
      <div className="inner">
        <div className="pageHead">
          <h1 className="display">
            {viewLabel}.{' '}
            {loading && count === 0 ? (
              <span className="muted">syncing…</span>
            ) : (
              <span className="muted">{`${count} item${count === 1 ? '' : 's'}.`}</span>
            )}
          </h1>
          <span className="pageMeta" title={snap.syncedAt ? new Date(snap.syncedAt).toLocaleString() : undefined}>
            <RefreshCw size={12} aria-hidden="true" />
            {snap.syncedAt ? `synced ${ago(snap.syncedAt)}` : 'not synced yet'}
            {repoCount != null && ` · ${repoCount === 0 ? 'no repos' : `${repoCount} repo${repoCount === 1 ? '' : 's'}`}`}
            {jobTitles.size > 0 && ` · ${jobTitles.size} job${jobTitles.size === 1 ? '' : 's'}`}
            {snap.loaded && (
              <span className="landed" title="Items marked done since midnight">
                {' · '}
                <Check size={12} aria-hidden="true" /> landed today <span className="n">{snap.landedToday}</span>
              </span>
            )}
          </span>
        </div>

        <div className="toolRow">
          {view === 'archived' ? (
            <div className="seg" role="tablist" aria-label="Archived or deleted">
              {([false, true] as const).map((d) => (
                <button
                  key={String(d)}
                  type="button"
                  role="tab"
                  aria-selected={deletedOnly === d}
                  className={`segBtn${deletedOnly === d ? ' active' : ''}`}
                  onClick={() => {
                    setDeletedOnly(d)
                    setSel(0)
                  }}
                >
                  {d ? 'Deleted' : 'Archived'}
                  {other.phase === 'ready' && <span className="segN">{other.items.filter((i) => !!i.deleted === d).length}</span>}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="right">
            <button type="button" className="btn sm ghost" onClick={() => setComposer({ open: true, editing: null })}>
              + Add item
            </button>
            <button type="button" className="btn sm ghost mono" onClick={() => setReposOpen(true)}>
              {repoCount == null ? 'Repos' : repoCount === 0 ? 'Repos: none' : `Repos: ${repoCount}`}
            </button>
            <button type="button" className="btn sm ghost" disabled={scanning} onClick={() => void scanNow()}>
              {scanning ? 'Scanning…' : 'Scan now'}
            </button>
            <button type="button" className="btn sm ghost" disabled={loading} onClick={() => reload(true)}>
              {loading ? 'Syncing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading && items.length === 0 && (
          <div className="probing">
            <span className="pip" /> {isOpen ? 'Syncing sources…' : 'Loading…'}
          </div>
        )}

        {error && <div className="msg error">Sync failed: {error}</div>}
        {briefError && <div className="msg error">Could not queue the briefs: {briefError}</div>}

        {!loading && !error && (
          <>
            {isOpen &&
              snap.notices.map((n) => (
                <div key={n} className="notice">
                  {n}
                </div>
              ))}
            {count === 0 ? (
              <div className="inboxEmpty">
                {emptyText}
                {isOpen && (
                  <button type="button" className="btn" onClick={() => setComposer({ open: true, editing: null })}>
                    Add a work item
                  </button>
                )}
              </div>
            ) : (
              <div className="homeList">
                {orphans.map((s) => (
                  <SessionRow key={s.id} session={s} project={projectName(s.projectId)} onOpen={() => onNavigate(s.id)} />
                ))}
                {alerts.map((a) => (
                  <AlertRow key={a.id} alert={a} onOpen={() => onNavigate(a.jobId ? `/jobs/${encodeURIComponent(a.jobId)}` : a.sessionId ?? '/inbox')} />
                ))}
                {entries.map((e) => (
                  <WorkRowWithSessions
                    key={e.item.id}
                    entry={e}
                    sessions={tabs.sessionsByRow.get(e.item.id)}
                    selected={e.item.id === (ordered[sel]?.id ?? null)}
                    onOpenSession={(id) => onNavigate(id)}
                    {...rowProps}
                  />
                ))}
                {view === 'all' && others.length > 0 && <div className="secLabel">Done</div>}
                {others.map((item) => (
                  <WorkRow key={item.id} item={item} selected={item.id === (ordered[sel]?.id ?? null)} {...rowProps} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {checkedItems.length > 0 && (
        <SelectionBar
          count={checkedItems.length}
          onBrief={() => void briefChecked()}
          onDone={() => void bulkState('done')}
          onSnooze={() => void bulkState('snoozed', tomorrow9())}
          onArchive={() => void bulkState('archived')}
          onClear={clearChecked}
        />
      )}

      <RepoPicker
        open={reposOpen}
        onClose={() => setReposOpen(false)}
        onSaved={(count) => {
          setRepoCount(count)
          setReposOpen(false)
          void inboxStore.refresh(true) // scope changed: resync now
        }}
      />

      <ItemComposer
        open={composer.open}
        editing={composer.editing}
        projects={projects}
        onClose={() => setComposer({ open: false, editing: null })}
        onSaved={() => {
          setComposer({ open: false, editing: null })
          reload(false) // include the new/edited item
        }}
        onSavedMore={() => reload(false)} // "Add more": refresh, stay open
      />

      <BriefComposerDialog item={briefing} latest={briefing ? briefs.byItem.get(briefing.id) ?? null : null} onClose={() => setBriefing(null)} />

      <DueDialog
        item={pickingDue}
        onClose={() => setPickingDue(null)}
        onPick={(item, day) => {
          setDue([item], day ?? 'later')
          setPickingDue(null)
        }}
      />

    </div>
  )
}
