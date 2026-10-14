import {
  AlarmClock,
  AlertTriangle,
  Archive,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  ImagePlus,
  Link2,
  MessageCircleQuestion,
  MoreHorizontal,
  Play,
  ShieldQuestion,
  Sparkles,
  Square,
  Flag,
  UserRound,
  Folder,
  Pencil,
  RefreshCw,
  ThumbsDown,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RepoScopeEditor } from './RepoScope.js'
import type {
  BriefJob,
  BriefJobsResponse,
  InboxAlert,
  ItemImage,
  ItemImageEdit,
  ItemListResponse,
  ItemStatus,
  ManualItemResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  ScoredItem,
  SessionSummary,
  JobsResponse,
} from '../../../shared/protocol.js'
import { itemImageUrl } from '../../../shared/protocol.js'
import { withWorkspace } from '../workspaceUrl.js'
import { useAttachments } from '../attachments.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { projectColor, rowOpen } from '../tabs.js'
import { briefPill, briefStore, useBriefs } from '../briefStore.js'
import { BriefComposerDialog } from './BriefComposer.js'
import { DueDialog } from './DueDialog.js'
import { DatePopover } from './Calendar.js'
import { dayInput } from '../dueDay.js'
import {
  LABELS,
  PRIORITY_LABEL,
  PRIORITY_VALUES,
  itemTone,
  kindIcon,
  ago,
  priorityClass,
  shortAge,
} from '../itemUi.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { Select, SelectItem } from '../ui/Select.js'
import { choosesProject, defaultProjectOf, ProjectIdPicker } from './ProjectPicker.js'
import { anyDialogOpen, isGoSequence, isTypingTarget } from '../keys.js'
import {
  SECTION_ORDER,
  dueChip,
  dueFor,
  dueOf,
  parseDue,
  sectionTitle,
  type Section,
} from '../../../core/work/due.js'
import { STAGE_LABEL, TURN_LABEL, type ItemFlow, type Turn } from '../../../core/work/flow.js'
import { TAB_TITLE, isOpenTab, waitedFor, type InboxTab, type TabEntry } from '../../../core/work/inbox-tabs.js'
import { waitingText, type Tabs } from '../inboxTabs.js'

type OtherState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: ScoredItem[] }
  | { phase: 'error'; message: string }

type Props = {
  /** the tab in front — the route's (`#/inbox/<tab>`), resolved by the shell */
  tab: InboxTab
  /** the open tabs, shared with the sidebar so the counts are the rows */
  tabs: Tabs
  onDispatch: (item: ScoredItem) => void
  onRefineJob: (item: ScoredItem) => void
  onOpenItem: (id: string) => void
  /** Keep it in the band without leaving the inbox (⌘-click, middle-click). */
  onPinItem: (id: string, title: string) => void
  /** Bumped by the shell (Queue panel "+") to open the new-item composer. */
  composeSignal?: number
  /** Go to a route — a job or a session an alert points at. */
  onNavigate: (path: string) => void
}

export function InboxPage({ tab, tabs, onDispatch, onRefineJob, onOpenItem, onPinItem, composeSignal = 0, onNavigate }: Props) {
  // The open tabs read the shared snapshot (the sidebar counts the same rows);
  // the status tabs are loaded here on demand.
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
  // Multi-select (.docs/next-version.md, phase 2): checked rows brief together.
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

  const isOpen = isOpenTab(tab)

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
      if (isOpenTab(tab)) void inboxStore.refresh(refresh)
      else void loadOther(tab)
    },
    [tab, loadOther],
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

  const removeLocally = useCallback(
    (id: string) => {
      if (isOpen) inboxStore.patch((items) => items.filter((i) => i.id !== id))
      else setOther((prev) => (prev.phase === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : prev))
    },
    [isOpen],
  )

  // A status change is a recorded transition on a durable item — the row leaves
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

  const snooze1d = useCallback((item: ScoredItem) => void setItemState(item, 'snoozed', tomorrow9()), [setItemState])

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

  // The route picks the tab; a status tab loads its list when it comes up.
  useEffect(() => {
    setSel(0)
    if (!isOpenTab(tab)) void loadOther(tab)
  }, [tab, loadOther])

  const entries = useMemo<readonly TabEntry<ScoredItem>[]>(() => (isOpenTab(tab) ? tabs.tabs.get(tab) ?? [] : []), [tab, tabs])

  // Items in on-screen order: the tab's entries, or the status list.
  const ordered = useMemo<readonly ScoredItem[]>(
    () =>
      isOpen
        ? entries.map((e) => e.item)
        : other.phase === 'ready'
          ? tab === 'archived'
            ? other.items.filter((i) => !!i.deleted === deletedOnly)
            : other.items
          : [],
    [isOpen, entries, other, tab, deletedOnly],
  )

  // The live selection: checked ids that are still on screen. Ids of rows that
  // already left the tab (done via the keyboard, refreshed away) don't count.
  const checkedItems = useMemo(
    () => (isOpen ? ordered.filter((i) => checked.has(i.id)) : []),
    [isOpen, ordered, checked],
  )
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

  // Checked items: queued at once, each with its own kind's template — editing is per item.
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
      const due = isOpen ? DUE_KEYS[e.key] : undefined
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
      } else if (e.key === 'b' && isOpen) {
        e.preventDefault()
        if (checkedItems.length) void briefChecked()
        else if (cur) briefOne(cur)
      } else if (e.key === ' ' && cur && isOpen) {
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
        void setItemState(cur, isOpen ? 'done' : 'open')
      } else if (e.key === 'x' && checkedItems.length) {
        e.preventDefault()
        void bulkState('archived')
      } else if (e.key === 'x' && cur) {
        e.preventDefault()
        void setItemState(cur, 'archived')
      } else if (e.key === 'z' && checkedItems.length) {
        e.preventDefault()
        void bulkState('snoozed', tomorrow9())
      } else if (e.key === 'z' && cur && isOpen) {
        e.preventDefault()
        snooze1d(cur)
      } else if (e.key === 'r') {
        e.preventDefault()
        reload(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ordered, sel, isOpen, onDispatch, onOpenItem, reload, setItemState, snooze1d, setDue, checkedItems, toggleChecked, bulkState, clearChecked, briefChecked, briefOne])

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

  const loading = isOpen ? !snap.loaded && snap.loading : other.phase === 'loading'
  const error = isOpen ? (!snap.loaded ? snap.error : undefined) : other.phase === 'error' ? other.message : undefined
  const items = ordered
  // Needs you now also holds what isn't an item: a blocked session with no
  // open item, a failed job, a paused team run.
  const alerts = tab === 'needs' ? snap.alerts : []
  const orphans = tab === 'needs' ? tabs.orphans : []
  const count = items.length + alerts.length + orphans.length
  const tabLabel = TAB_TITLE[tab]
  const emptyText =
    isOpen && snap.notices.length > 0
      ? 'Nothing here — but a source is degraded, so this may be incomplete.'
      : EMPTY_TEXT[tab] ?? `Nothing in ${tabLabel.toLowerCase()}.`

  const rowProps: RowActions = {
    tab,
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
            {tabLabel}.{' '}
            {loading && count === 0 ? (
              <span className="muted">syncing…</span>
            ) : (
              <span className="muted">
                {tab === 'needs'
                  ? count === 0
                    ? 'Nothing is held on you.'
                    : `${count} held on you.`
                  : `${count} item${count === 1 ? '' : 's'}.`}
              </span>
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
          {tab === 'archived' ? (
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
                {isOpen
                  ? entries.map((e) => (
                      <WorkRowWithSessions
                        key={e.item.id}
                        entry={e}
                        sessions={tabs.sessionsByRow.get(e.item.id)}
                        selected={e.item.id === (ordered[sel]?.id ?? null)}
                        onOpenSession={(id) => onNavigate(id)}
                        {...rowProps}
                      />
                    ))
                  : items.map((item) => (
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
          void inboxStore.refresh(true) // scope changed — resync now
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
        onSavedMore={() => reload(false)} // "Add more" — refresh, stay open
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

/** A row's own id and every signal folded into it (core/work/link.ts). */
function signalIds(item: ScoredItem): string[] {
  return [item.id, ...(item.linked ?? []).map((l) => l.id)]
}

/** "4 signals · Niraj, Drew" — for a row that folds several items about one thing. */
function signalsText(item: ScoredItem): string | null {
  if (!item.linked?.length) return null
  const people = [...new Set([item.author, ...item.linked.map((l) => l.author)].filter(Boolean))]
  const who = people.length > 2 ? `${people.slice(0, 2).join(', ')} +${people.length - 2}` : people.join(', ')
  return [`${item.linked.length + 1} signals`, who].filter(Boolean).join(' · ')
}

/** The due keys: t today, m next workday (Monday on a Friday), w this week, l later. */
const DUE_KEYS: Record<string, Section> = { t: 'today', m: 'next-workday', w: 'this-week', l: 'later' }
const DUE_KEY_OF = Object.fromEntries(Object.entries(DUE_KEYS).map(([k, s]) => [s, k])) as Record<Section, string>

/** Tomorrow 09:00 local — the one snooze duration the inbox knows (`z`). */
function tomorrow9(): number {
  const t = new Date()
  t.setDate(t.getDate() + 1)
  t.setHours(9, 0, 0, 0)
  return t.getTime()
}

/**
 * Floating bulk-action bar. Appears bottom-centre of the pane while rows are
 * checked and offers the same verbs as a row's hover cluster, applied to all
 * of them at once. It sticks to the bottom of the page scroller rather than
 * the viewport so it never sits over the rail or the Queue panel.
 */
function SelectionBar({
  count,
  onBrief,
  onDone,
  onSnooze,
  onArchive,
  onClear,
}: {
  count: number
  onBrief: () => void
  onDone: () => void
  onSnooze: () => void
  onArchive: () => void
  onClear: () => void
}) {
  return (
    <div className="selDock">
      <div className="selBar" role="toolbar" aria-label={`${count} checked`}>
        <span className="count">
          <span className="n">{count}</span> checked
        </span>
        <span className="sep" aria-hidden="true" />
        <button type="button" className="btn sm primary" title="Queue a brief for each checked item, with its kind's default template (b)" onClick={onBrief}>
          <Sparkles size={13} aria-hidden="true" /> Brief with defaults
        </button>
        <button type="button" className="btn sm ghost" title="Mark the checked items done (e)" onClick={onDone}>
          <Check size={14} aria-hidden="true" /> Done
        </button>
        <button type="button" className="btn sm ghost" title="Snooze the checked items until tomorrow 9am (z)" onClick={onSnooze}>
          <AlarmClock size={13} aria-hidden="true" /> Snooze
        </button>
        <button type="button" className="btn sm ghost" title="Archive the checked items (x)" onClick={onArchive}>
          <Archive size={13} aria-hidden="true" /> Archive
        </button>
        <span className="sep" aria-hidden="true" />
        <button type="button" className="iconBtn sm" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

type RowActions = {
  tab: InboxTab
  projectName: (id?: string) => string | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onPin: (id: string, title: string) => void
  onDispatch: (item: ScoredItem) => void
  onDone: (item: ScoredItem) => void
  onSnooze: (item: ScoredItem) => void
  onArchive: (item: ScoredItem) => void
  onReopen: (item: ScoredItem) => void
  onRefineJob: (item: ScoredItem) => void
  onSetPriority: (item: ScoredItem, priority: number) => void
  onSetDue: (item: ScoredItem, due: Section) => void
  onPickDue: (item: ScoredItem) => void
  onEdit: (item: ScoredItem) => void
  onDelete: (item: ScoredItem) => void
  checked: Set<string>
  onToggle: (id: string) => void
  onBrief: (item: ScoredItem) => void
  briefOf: (id: string) => BriefJob | undefined
  /** override whose turn it is; null goes back to what the rules say */
  onSetTurn: (item: ScoredItem, turn: Turn | null) => void
}

const EMPTY_TEXT: Partial<Record<InboxTab, string>> = {
  needs: 'Nothing is held on you — no agent is waiting, nothing broke.',
  due: 'Nothing is due today.',
  people: 'Nobody is waiting on you.',
  new: 'Nothing new in the last day.',
  ready: 'No brief is waiting on you.',
  ai: 'The AI isn’t working on anything.',
  review: 'Nothing to review.',
  others: 'Nobody is holding anything of yours.',
  backlog: 'The backlog is empty.',
}

/**
 * An item row with the sessions dispatched for it that are held on a prompt,
 * one line each beneath it — answering one opens the session.
 */
function WorkRowWithSessions({
  entry,
  sessions,
  selected,
  onOpenSession,
  ...actions
}: {
  entry: TabEntry<ScoredItem>
  sessions?: readonly SessionSummary[]
  selected: boolean
  onOpenSession: (id: string) => void
} & RowActions) {
  return (
    <>
      <WorkRow item={entry.item} entry={entry} selected={selected} {...actions} />
      {sessions?.map((s) => (
        <SessionRow key={s.id} session={s} nested onOpen={() => onOpenSession(s.id)} />
      ))}
    </>
  )
}

/** A session held on a permission prompt or a question. */
function SessionRow({
  session,
  project,
  nested,
  onOpen,
}: {
  session: SessionSummary
  project?: string
  nested?: boolean
  onOpen: () => void
}) {
  const what = waitingText(session)
  return (
    <div className={`wrow sessionRow${nested ? ' nested' : ''}`}>
      <span className="check" aria-hidden="true" />
      <span className="bar" />
      <span className="glyph">
        {session.waitingOn === 'AskUserQuestion' ? <MessageCircleQuestion size={14} aria-hidden="true" /> : <ShieldQuestion size={14} aria-hidden="true" />}
      </span>
      <button type="button" className="t" title={`${session.title} — ${what}`} onClick={onOpen}>
        <span className="name">{nested ? what : session.title}</span>
        {!nested && <span className="why">{what}</span>}
      </button>
      <span className="meta">
        <span className="c state flow-ask">Answer</span>
        <span className="c src">{nested ? session.title : project ?? ''}</span>
        <span className="c when">{shortAge(session.updatedAt)}</span>
      </span>
    </div>
  )
}

/** Something broke that isn't an item — opens where it can be fixed. */
function AlertRow({ alert, onOpen }: { alert: InboxAlert; onOpen: () => void }) {
  return (
    <div className="wrow alert alertRow">
      <span className="check" aria-hidden="true" />
      <span className="bar" />
      <span className="glyph">
        <AlertTriangle size={14} aria-hidden="true" />
      </span>
      <button type="button" className="t" title={alert.detail ?? alert.title} onClick={onOpen}>
        <span className="name">{alert.title}</span>
        {alert.detail && <span className="why">{alert.detail}</span>}
      </button>
      <span className="meta">
        <span className="c state flow-broken">{alert.kind === 'job' ? 'Open job' : 'Open run'}</span>
        <span className="c when">{alert.at ? shortAge(alert.at) : ''}</span>
      </span>
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The state cell: what is asked of you on your turn, else who has it. A
 * broken item says what broke; that outranks everything.
 */
function rowState(item: ScoredItem, brief: { label: string; tone: string } | null): { text: string; tone: string } {
  const f = item.flow
  if (!f) return { text: brief?.label ?? (LABELS[item.label] ?? LABELS.read).name, tone: brief ? brief.tone : `label-${item.label}` }
  if (f.broken) return { text: cap(f.broken), tone: 'flow-broken' }
  if (f.turn === 'me') return f.ask ? { text: cap(f.ask), tone: 'flow-ask' } : { text: (LABELS[item.label] ?? LABELS.read).name, tone: `label-${item.label}` }
  if (f.turn === 'ai') return { text: f.stage === 'briefing' ? (brief?.label === 'brief queued' ? 'Brief queued' : 'Briefing…') : 'AI working', tone: 'flow-ai' }
  if (f.turn === 'others') return { text: f.note ? f.note : 'Waiting', tone: 'flow-others' }
  return { text: STAGE_LABEL[f.stage], tone: 'flow-none' }
}

function flowTitle(f: ItemFlow): string {
  return `${STAGE_LABEL[f.stage]} · ${TURN_LABEL[f.turn]}${f.overridden ? ' — set by you' : ''}${f.note ? ` — ${f.note}` : ''}`
}

/**
 * One work item, one line (.docs/work-item-variations.html — variation A).
 *
 * The row is a ledger entry, not a card: state, source and age sit in
 * fixed-width right-aligned cells so they form columns down the page, and
 * scanning happens by alignment rather than by reading a strip of pills. The
 * right-hand cells are the row's one piece of real estate and three things
 * take turns in it, never two at once — the meta columns at rest, the
 * shortcut legend when the row is keyboard-selected, the action cluster on
 * hover. Because they swap in place, nothing reflows under the cursor.
 */
function WorkRow({
  item,
  selected,
  tab,
  projectName,
  onSelect,
  onOpen,
  onPin,
  onDispatch,
  onDone,
  onSnooze,
  onArchive,
  onReopen,
  onRefineJob,
  onSetPriority,
  onSetDue,
  onPickDue,
  onEdit,
  onDelete,
  checked,
  onToggle,
  onBrief,
  briefOf,
  onSetTurn,
  entry,
}: { item: ScoredItem; selected: boolean; entry?: TabEntry<ScoredItem> } & RowActions) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isManual = item.source === 'manual'
  const isOpen = isOpenTab(tab)
  const isChecked = checked.has(item.id)
  const brief = briefPill(briefOf(item.id))
  const pri = item.priority ?? 0
  // jobId now rides in the provenance list; fall back to the item field.
  const jobId = item.jobId ?? item.foundBy?.[item.foundBy.length - 1]?.jobId
  const Icon = kindIcon(item)
  const alert = itemTone(item) === 'red'

  // The state cell: the ask on your turn, else who has it (rowState).
  const state = rowState(item, brief)
  const flow = item.flow
  const signals = signalsText(item)
  // Tab extras: how long a person has waited, a stuck wait to nudge.
  const now = Date.now()
  const waited = tab === 'people' ? waitedFor(Date.parse(item.createdAt) || now, now) : null
  const stuck = entry?.stuck && flow ? waitedFor(flow.since, now) : null
  // Only a stated deadline gets a date chip; a late one you set says how late.
  const due = isOpen ? dueOf(item, Date.now()) : null
  // A date you picked shows too when its section can't say it (This week, Later).
  const showsDate = due?.source === 'explicit' || (due?.source === 'you' && (due.section === 'later' || due.section === 'this-week'))
  const dueText = !due ? null : due.late > 0 ? `${due.late}d late` : showsDate && due.at != null ? dueChip(due.at, Date.now()) : null
  const source = projectName(item.projectId) ?? item.repo
  // The scored reason ("2 people waiting · opened 3d ago") is the fallback when
  // the item carries no human note.
  const trailing = item.why || item.reason

  return (
    <div
      className={['wrow', priorityClass(item), selected && 'sel', isChecked && 'checked', menuOpen && 'menu', alert && 'alert']
        .filter(Boolean)
        .join(' ')}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseMove={() => !selected && onSelect(item.id)}
    >
      {isOpen ? (
        <button
          type="button"
          className="check"
          title={isChecked ? 'Uncheck (Space)' : 'Check to act on several rows at once (Space)'}
          aria-pressed={isChecked}
          onClick={() => onToggle(item.id)}
        >
          {isChecked ? <CheckSquare size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
        </button>
      ) : (
        <span />
      )}
      <span className="bar" title={pri > 0 ? `Priority: ${PRIORITY_LABEL[pri]}` : undefined} />
      <span className="glyph">
        <Icon size={14} aria-hidden="true" />
      </span>
      <button
        type="button"
        className="t"
        title={item.title}
        {...rowOpen(
          () => onOpen(item.id),
          () => onPin(item.id, item.title),
        )}
      >
        {item.returned && (
          <span className="returned" title="Was done — the source updated since">
            ↩
          </span>
        )}
        <span className="name">{item.title}</span>
        {signals && <span className="signals">{signals}</span>}
        {dueText && (
          <span
            className={`due${due?.late ? ' late' : ''}${due?.source === 'explicit' ? ' explicit' : ''}`}
            title={due?.at != null ? `${due.source === 'explicit' ? 'Deadline' : 'Due'} ${new Date(due.at).toLocaleDateString()}` : undefined}
          >
            {dueText}
          </span>
        )}
        {entry?.badge && <span className={`fresh ${entry.badge}`}>{entry.badge === 'new' ? 'New' : 'Updated'}</span>}
        {waited && <span className="waited">waiting {waited}</span>}
        {stuck && <span className="waited stuck">stuck {stuck}</span>}
        {trailing && <span className="why">{trailing}</span>}
      </button>

      <span className="meta" aria-hidden={selected || undefined}>
        {flow && (
          <span className={`c stage turn-${flow.turn}${flow.overridden ? ' set' : ''}`} title={flowTitle(flow)}>
            <span className="dot" aria-hidden="true" />
            {STAGE_LABEL[flow.stage]}
          </span>
        )}
        <span className={`c state ${state.tone}`}>{state.text}</span>
        <span className="c src">{source}</span>
        <span className="c when" title={item.updatedAt ? new Date(item.updatedAt).toLocaleString() : undefined}>
          {shortAge(item.updatedAt)}
        </span>
      </span>

      {selected && (
        <span className="keys" aria-hidden="true">
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">d</span> dispatch
          </span>
          {isOpen && (
            <>
              <span>
                <span className="kbd">e</span> done
              </span>
              <span>
                <span className="kbd">z</span> snooze
              </span>
            </>
          )}
        </span>
      )}

      <span className="acts">
        {stuck ? (
          <button
            type="button"
            className="btn sm primary"
            title={`Waiting ${stuck} — nudge them${item.url ? ' at the source' : ''}`}
            onClick={() => (item.url ? window.open(item.url, '_blank', 'noopener') : onOpen(item.id))}
          >
            Nudge?
          </button>
        ) : isOpen ? (
          <button type="button" className="btn sm primary" title="Start a Claude Code session on this item (d)" onClick={() => onDispatch(item)}>
            Dispatch
          </button>
        ) : (
          <button type="button" className="btn sm primary" title="Move back to the open inbox (e)" onClick={() => onReopen(item)}>
            Reopen
          </button>
        )}
        {isOpen && (
          <>
            <button type="button" className="iconBtn sm" title={brief ? 'Re-brief (b)' : 'Create a brief (b)'} onClick={() => onBrief(item)}>
              <Sparkles size={13} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm green" title="Mark done (e)" onClick={() => onDone(item)}>
              <Check size={14} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm" title="Snooze until tomorrow 9am (z)" onClick={() => onSnooze(item)}>
              <AlarmClock size={13} aria-hidden="true" />
            </button>
          </>
        )}
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button type="button" className="iconBtn sm more" title="More actions">
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="rowMenu">
            <MenuItem onSelect={() => onOpen(item.id)}>
              <ChevronRight size={13} aria-hidden="true" /> Open item<span className="k">↵</span>
            </MenuItem>
            {item.url && (
              <MenuItem onSelect={() => window.open(item.url, '_blank', 'noopener')}>
                <ExternalLink size={13} aria-hidden="true" /> Open at the source<span className="k">o</span>
              </MenuItem>
            )}
            {item.linked?.map((l) => (
              <MenuItem key={l.id} onSelect={() => window.open(l.url, '_blank', 'noopener')}>
                <ExternalLink size={13} aria-hidden="true" /> Also in {l.source} · {l.repo}
              </MenuItem>
            ))}
            {isOpen ? (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onBrief(item)}>
                  <Sparkles size={13} aria-hidden="true" /> {brief ? 'Re-brief' : 'Create a brief'}
                  <span className="k">b</span>
                </MenuItem>
                <MenuItem onSelect={() => onDispatch(item)}>
                  <Play size={13} aria-hidden="true" /> Dispatch to a session<span className="k">d</span>
                </MenuItem>
                <MenuItem onSelect={() => onDone(item)}>
                  <Check size={13} aria-hidden="true" /> Mark done<span className="k">e</span>
                </MenuItem>
                <MenuItem onSelect={() => onSnooze(item)}>
                  <AlarmClock size={13} aria-hidden="true" /> Snooze to tomorrow<span className="k">z</span>
                </MenuItem>
                <MenuSeparator />
                <div className="uiMenuCap">Due</div>
                {SECTION_ORDER.map((s) => (
                  <MenuItem key={s} onSelect={() => onSetDue(item, s)}>
                    <CalendarDays size={13} aria-hidden="true" /> {sectionTitle(s, Date.now())}
                    {due?.source !== 'default' && due?.section === s && <Check className="check" size={13} aria-hidden="true" />}
                    <span className="k">{DUE_KEY_OF[s]}</span>
                  </MenuItem>
                ))}
                <MenuItem onSelect={() => onPickDue(item)}>
                  <CalendarDays size={13} aria-hidden="true" /> Pick a date…
                  {due?.source === 'you' && due.at != null && <span className="k">{dueChip(due.at, Date.now())}</span>}
                </MenuItem>
                <MenuSeparator />
                <div className="uiMenuCap">Whose turn</div>
                {(['me', 'ai', 'others'] as const).map((t) => (
                  <MenuItem key={t} onSelect={() => onSetTurn(item, t)}>
                    <UserRound size={13} aria-hidden="true" /> {TURN_LABEL[t]}
                    {flow?.turn === t && <Check className="check" size={13} aria-hidden="true" />}
                  </MenuItem>
                ))}
                {flow?.overridden && (
                  <MenuItem onSelect={() => onSetTurn(item, null)}>
                    <Undo2 size={13} aria-hidden="true" /> Back to automatic
                  </MenuItem>
                )}
                <MenuSeparator />
                <div className="uiMenuCap">Priority</div>
                {PRIORITY_VALUES.map((v) => (
                  <MenuItem key={v} onSelect={() => onSetPriority(item, v)}>
                    <span className={`dot sm prio${v}`} aria-hidden="true" />
                    {v === 0 ? 'None' : PRIORITY_LABEL[v]}
                    {v === pri && <Check className="check" size={13} aria-hidden="true" />}
                  </MenuItem>
                ))}
                <MenuSeparator />
                {isManual && (
                  <MenuItem onSelect={() => onEdit(item)}>
                    <Pencil size={13} aria-hidden="true" /> Edit
                  </MenuItem>
                )}
                {jobId && (
                  <MenuItem onSelect={() => onRefineJob(item)}>
                    <ThumbsDown size={13} aria-hidden="true" /> Bad match — refine this job
                  </MenuItem>
                )}
                <MenuItem className="danger" onSelect={() => (isManual ? onDelete(item) : onArchive(item))}>
                  {isManual ? <Trash2 size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
                  {isManual ? 'Delete' : 'Archive'}
                  <span className="k">x</span>
                </MenuItem>
              </>
            ) : (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onReopen(item)}>
                  <Undo2 size={13} aria-hidden="true" /> Move back to open<span className="k">e</span>
                </MenuItem>
                {tab !== 'archived' && (
                  <MenuItem className="danger" onSelect={() => onArchive(item)}>
                    <Archive size={13} aria-hidden="true" /> Archive<span className="k">x</span>
                  </MenuItem>
                )}
              </>
            )}
          </MenuContent>
        </Menu>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item composer: add or edit a manual work item. Title, description, link,
// project, priority — plus screenshots, which are the point: a brief or a
// dispatched session reads the images the same way it reads the description,
// so "here is what's broken" can be a paste rather than a paragraph.
// ---------------------------------------------------------------------------

function ItemComposer({
  open,
  editing,
  projects,
  onClose,
  onSaved,
  onSavedMore,
}: {
  open: boolean
  editing: ScoredItem | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void
  /** Saved with "Add more" on: refresh the inbox, but keep the composer open. */
  onSavedMore: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState(0)
  const [due, setDue] = useState('')
  const [description, setDescription] = useState('')
  const [url, setUrl] = useState('')
  const [linkOpen, setLinkOpen] = useState(false)
  /** images the item already holds (edit only) — dropping one here deletes it on save */
  const [kept, setKept] = useState<ItemImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [addMore, setAddMore] = useState(false)
  const attach = useAttachments()

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setTitle(editing?.title ?? '')
      setProjectId(editing?.projectId ?? '')
      setPriority(editing?.priority ?? 0)
      setDue(dayInput(editing))
      setDescription(editing?.description ?? editing?.note ?? '')
      setUrl(editing?.url ?? '')
      setLinkOpen(!!editing?.url)
      setKept(editing?.images ?? [])
      attach.clear()
      setError(null)
    }
    if (!open && el.open) el.close()
  }, [open, editing])

  // One tray, two origins: what the item already holds and what is being
  // pasted now. The strip does not care which is which; removal does.
  const thumbs = [
    ...kept.map((i) => ({ id: i.id, url: editing ? withWorkspace(itemImageUrl(editing.id, i.id)) : '', name: i.name })),
    ...attach.images,
  ]
  const removeThumb = (id: string) => {
    if (kept.some((i) => i.id === id)) setKept((prev) => prev.filter((i) => i.id !== id))
    else attach.remove(id)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // The complete desired set: refs to keep, then the new pastes.
      const images: ItemImageEdit[] = [
        ...kept.map((i) => ({ id: i.id })),
        ...(attach.payload() ?? []),
      ]
      const payload = {
        title,
        projectId: projectId || undefined,
        priority,
        description: description.trim() || undefined,
        url: url.trim() || undefined,
        // An edit sends the day only when it changed: null clears it.
        ...(editing ? (due !== dayInput(editing) ? { due: due || null } : {}) : due ? { due } : {}),
        images,
      }
      const path = editing ? `/api/items/manual?id=${encodeURIComponent(editing.id)}` : '/api/items/manual'
      const res = await fetch(path, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as ManualItemResponse
      if (!body.ok) {
        setError(body.error)
      } else if (addMore && !editing) {
        // keep the composer open for the next one; clear all but the project
        onSavedMore()
        setTitle('')
        setDescription('')
        setUrl('')
        setLinkOpen(false)
        setPriority(0)
        setDue('')
        attach.clear()
        setError(null)
        titleInput.current?.focus()
      } else {
        onSaved()
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialog} className="itemComposer" onClose={onClose}>
      <form
        className={dragging ? 'dragging' : undefined}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        // ⌘↵ saves from any field — the description is where you live, and
        // reaching for the button to save a two-line to-do is a tax.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && title.trim() && !saving) {
            e.preventDefault()
            void save()
          }
        }}
        onPaste={attach.onPaste}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(false)
          void attach.add(e.dataTransfer.files)
        }}
      >
        <div className="composerHead">
          <div className="crumbs">
            <span className="crumb">Inbox</span>
            <span className="crumbSep">›</span>
            <span className="crumb now">{editing ? 'Edit work item' : 'New work item'}</span>
          </div>
          <button type="button" className="composerClose" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <input
          ref={titleInput}
          className="titleInput"
          autoFocus
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="descInput"
          rows={4}
          placeholder="Context, acceptance criteria, or a pasted screenshot — the brief reads all of it."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {linkOpen && (
          <label className="linkRow">
            <Link2 size={13} aria-hidden="true" />
            <input
              type="url"
              placeholder="https://…"
              value={url}
              autoFocus={!editing?.url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        )}

        <div className="composerAttachments">
          <AttachmentStrip images={thumbs} error={attach.error} onRemove={removeThumb} />
          {thumbs.length === 0 && !attach.error && (
            <button type="button" className="dropHint" onClick={() => filePicker.current?.click()}>
              <ImagePlus size={12} aria-hidden="true" />
              Paste, drop, or click to attach a screenshot
            </button>
          )}
        </div>

        <input
          ref={filePicker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void attach.add(e.target.files)
            // Reset, so picking the same file twice in a row still fires.
            e.target.value = ''
          }}
        />

        <div className="pillRow">
          <Select
            className={`pill prio${priority}`}
            title="Priority"
            aria-label="Priority"
            icon={<Flag size={12} aria-hidden="true" />}
            value={String(priority)}
            onValueChange={(v) => setPriority(Number(v))}
          >
            {PRIORITY_VALUES.map((v) => (
              <SelectItem key={v} value={String(v)}>
                {v === 0 ? 'Priority' : PRIORITY_LABEL[v]}
              </SelectItem>
            ))}
          </Select>
          <DatePopover className="pill" value={due} onChange={setDue} />
          {choosesProject(projects) && (
          <ProjectIdPicker
            projects={projects}
            value={projectId || defaultProjectOf(projects)?.id || ''}
            allowNone={false}
            onChange={(id) => id && setProjectId(id)}
          >
            {(current) => (
              <button type="button" className={`pill${current ? ' set' : ''}`} title="Project" aria-label="Project">
                {current ? (
                  <span className="pdot" style={{ background: projectColor(current.id) }} aria-hidden="true" />
                ) : (
                  <Folder size={12} aria-hidden="true" />
                )}
                {current?.name ?? 'Project'}
              </button>
            )}
          </ProjectIdPicker>
          )}
          <button
            type="button"
            className={`pill add${thumbs.length ? ' set' : ''}`}
            onClick={() => filePicker.current?.click()}
            title="Attach screenshots — or just paste them"
          >
            <ImagePlus size={12} aria-hidden="true" />
            {thumbs.length > 0 ? `${thumbs.length} image${thumbs.length === 1 ? '' : 's'}` : 'Image'}
          </button>
          {!linkOpen && (
            <button type="button" className="pill add" onClick={() => setLinkOpen(true)} title="Add a link">
              <Link2 size={12} aria-hidden="true" />
              Link
            </button>
          )}
        </div>

        {error && <div className="msg error">{error}</div>}

        <div className="composerFoot">
          {!editing && (
            <label className="addMore" title="Keep this open to add another after saving">
              <input type="checkbox" checked={addMore} onChange={(e) => setAddMore(e.target.checked)} />
              <span className="switch" aria-hidden="true" />
              Add more
            </label>
          )}
          <div className="footActions">
            <span className="hint">⌘↵</span>
            <button type="button" className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="go" disabled={saving || !title.trim()}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Repo picker: which repos the GitHub source is scoped to, per workspace.
// Empty = no GitHub items (scope is opt-in per workspace — see workspaces.md).
// ---------------------------------------------------------------------------

function RepoPicker({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (count: number) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog ref={dialog} className="repoDialog" onClose={onClose}>
      <h3>Connected repos</h3>
      <p className="pickerSub">
        The GitHub source only pulls from checked repos, and this scope is per workspace. Nothing
        checked = no GitHub items here.
      </p>
      {open && <RepoScopeEditor onSaved={onSaved} onCancel={onClose} />}
    </dialog>
  )
}
