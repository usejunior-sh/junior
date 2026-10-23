/**
 * One work item, in full: what it is (title + your description), the brief
 * about it (a markdown document a playbook run wrote, .docs/next-version.md),
 * why it ranked, what has happened to it, and the sessions working on it.
 * The actions live in the right column so the left reads as a page, not a form.
 */
import { Paperclip, Hash } from 'lucide-react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { type ScoredItem, type ItemStatus, type ItemEvent, type Project, type Link, type BriefView, type ItemImage, type FileRef, type SessionsUsage, type ItemListResponse, type ItemEventsResponse, type JobsResponse, type ProjectsResponse, type BriefResponse, type LinksResponse, type SessionsUsageResponse, type ItemImageEdit, type ItemImagesResponse, type ItemFilesResponse, type BriefJobsResponse, itemImageUrl, itemFileUrl } from '../../../shared/protocol.js'
import { withWorkspace } from '../workspaceUrl.js'
import { MAX_SERIES, SERIES, OTHER_KEY, OTHER } from '../usageFormat.js'
import { useAttachments } from '../attachments.js'
import { AttachmentStrip, FileChip } from './AttachmentStrip.js'
import { useSessions, useCheckouts } from '../hooks.js'
import { useInbox, inboxStore } from '../inboxStore.js'
import { useBriefs, briefStore, briefPill } from '../briefStore.js'
import { store } from '../store.js'
import { useActions } from '../actions.js'
import { ItemActions } from './ActionCard.js'
import { kindIcon, KIND_LABEL, ago, PRIORITY_LABEL } from '../itemUi.js'
import { BriefComposerDialog } from './BriefComposer.js'
import { DueDialog } from './DueDialog.js'
import { type Section, SECTION_ORDER, dueFor, parseDue, dueOf, dueChip, sectionTitle } from '../../../core/work/due.js'
import { ItemLinks } from './ItemLinks.js'
import { FlowPopover } from './FlowPopover.js'
import { AsideActions } from './item/AsideActions.js'
import { CostBlock } from './item/CostBlock.js'
import { BriefCard, ItemDetails, ReportCard } from './item/ItemCards.js'
import { ItemPlans } from './item/ItemPlans.js'
import { ItemTimeline } from './item/ItemTimeline.js'
import * as Tabs from '@radix-ui/react-tabs'
import { verdictOf, type ItemTab } from '../../../core/work/verdict.js'
import { isOwnHandIn } from '../../../core/actions/own.js'
import { useItemTasks } from './item/useItemTasks.js'
import { ItemVerdict } from './item/ItemVerdict.js'
import { NeedsYou } from './item/NeedsYou.js'
import { ItemSessionsTab } from './item/ItemSessionsTab.js'
import { ItemActivity, sendsOf } from './item/ItemActivity.js'

type Props = {
  id: string
  onDispatch: (item: ScoredItem) => void
  onNavigate: (hash: string) => void
  /** Editing here means the tab must survive: promote it out of the peek slot. */
  onDirty: () => void
}

const OTHER_STATUSES: ItemStatus[] = ['snoozed', 'done', 'archived']

/** The tab you last picked on each item, for this window: coming back finds it where you left it. */
const pickedTab = new Map<string, ItemTab>()
/** Items whose brief or links you opened under the description, the same way. */
const openedBrief = new Set<string>()
const openedLinks = new Set<string>()

export function ItemPage({ id, onDispatch, onNavigate, onDirty }: Props) {
  const snap = useInbox()
  const sessions = useSessions()
  const checkouts = useCheckouts()
  const briefs = useBriefs()
  // What sessions working this item sent out: PRs, comments, pushes (core/actions).
  const itemActions = useActions({ item: id })
  const { tasks: loadedTasks, reload: reloadTasks } = useItemTasks(id)
  const [tab, setTab] = useState<ItemTab | null>(pickedTab.get(id) ?? null)
  const [briefShown, setBriefShown] = useState(openedBrief.has(id))
  const [linksShown, setLinksShown] = useState(openedLinks.has(id))
  const [descMore, setDescMore] = useState(false)
  useEffect(() => {
    setTab(pickedTab.get(id) ?? null)
    setBriefShown(openedBrief.has(id))
    setLinksShown(openedLinks.has(id))
    setDescMore(false)
  }, [id])
  const open = snap.items.find((i) => i.id === id)
  // Not in the open inbox → it may be snoozed, done or archived.
  const [other, setOther] = useState<{ id: string; item: ScoredItem | null } | null>(null)
  const [events, setEvents] = useState<ItemEvent[] | null>(null)
  const [eventsRev, setEventsRev] = useState(0)
  const [jobTitles, setJobTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [pickingDue, setPickingDue] = useState(false)
  const [links, setLinks] = useState<Link[]>([])
  // A digest item's report: the artifact a job run wrote, linked with role `report`.
  const [report, setReport] = useState<{ id: string; title: string; body: string; updated: number } | null>(null)
  const [brief, setBrief] = useState<BriefView | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [descDraft, setDescDraft] = useState<string | null>(null)
  /** the images the editor is holding: parallel to `descDraft`, null when not editing */
  const [imgDraft, setImgDraft] = useState<ItemImage[] | null>(null)
  /** the files the editor is holding, the same way */
  const [fileDraft, setFileDraft] = useState<FileRef[] | null>(null)
  const attach = useAttachments()
  const [descDragging, setDescDragging] = useState(false)
  const filePicker = useRef<HTMLInputElement>(null)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [spend, setSpend] = useState<SessionsUsage | null>(null)
  /** the readout is optional: a ledger that can't be read hides it rather than sitting on a skeleton */
  const [spendFailed, setSpendFailed] = useState(false)

  // Anything unsaved on this page would be lost if the peek slot handed the
  // tab to the next document, so the first keystroke keeps it.
  const dirty = descDraft !== null || imgDraft !== null || fileDraft !== null || feedback.trim() !== ''
  useEffect(() => {
    if (dirty) onDirty()
  }, [dirty, onDirty])

  useEffect(() => {
    if (!snap.loaded && !snap.loading) void inboxStore.refresh()
  }, [snap.loaded, snap.loading])

  useEffect(() => {
    if (open || !snap.loaded) return
    let cancelled = false
    void Promise.all(
      OTHER_STATUSES.map((s) =>
        fetch(`/api/items?status=${s}`)
          .then((r) => r.json() as Promise<ItemListResponse>)
          .then((b) => (b.ok ? b.items : []))
          .catch(() => [] as ScoredItem[]),
      ),
    ).then((lists) => {
      if (cancelled) return
      setOther({ id, item: lists.flat().find((i) => i.id === id) ?? null })
    })
    return () => {
      cancelled = true
    }
  }, [id, open, snap.loaded])

  useEffect(() => {
    setEvents(null)
    void fetch(`/api/items/events?id=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<ItemEventsResponse>)
      .then((b) => setEvents(b.ok ? b.events : []))
      .catch(() => setEvents([]))
  }, [id, eventsRev])

  useEffect(() => {
    void fetch('/api/jobs')
      .then((r) => r.json() as Promise<JobsResponse>)
      .then((b) => {
        if (b.ok) setJobTitles(new Map(b.jobs.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  // The brief and the links follow the item's newest job: every transition
  // (queued → running → ready) arrives as a frame and refetches both.
  // Opened straight from a link, the inbox never loaded the jobs, and the Re-brief
  // composer starts from the newest one.
  useEffect(() => {
    if (!briefs.loaded) void briefStore.refresh()
  }, [briefs.loaded])
  const job = briefs.byItem.get(id)
  const jobKey = job ? `${job.id}:${job.status}` : ''
  const loadBrief = useCallback(() => {
    void fetch(`/api/briefs?itemId=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<BriefResponse>)
      .then((b) => {
        if (b.ok) setBrief(b.brief)
      })
      .catch(() => {})
    void fetch(`/api/links?kind=item&id=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<LinksResponse>)
      .then((b) => {
        if (b.ok) setLinks(b.links)
      })
      .catch(() => {})
  }, [id])
  useEffect(loadBrief, [loadBrief, jobKey, sessions.length])
  // A hand edit of the brief file lands as an index change.
  useEffect(() => store.onArtifactsChanged(loadBrief), [loadBrief])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 2500)
    return () => window.clearTimeout(t)
  }, [notice])

  const item = open ?? (other?.id === id ? other.item : undefined)

  // Sessions from the links table (dispatch / brief); the pre-0.7 title match stays as a fallback.
  const linkedSessions = useMemo(() => {
    if (!item) return []
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const seen = new Set<string>()
    const out: { s: (typeof sessions)[number]; role: string }[] = []
    for (const l of links) {
      if (l.fromKind !== 'session') continue
      const s = byId.get(l.fromId)
      if (!s || seen.has(s.id)) continue
      seen.add(s.id)
      out.push({ s, role: l.role })
    }
    for (const s of sessions) {
      if (!seen.has(s.id) && s.kind !== 'brief' && s.title === item.title.slice(0, 80)) out.push({ s, role: 'dispatch' })
    }
    return out
  }, [sessions, links, item])

  // What the item cost: the ledger, folded by the item's linked sessions. Refetched
  // when the set changes and when a live one settles, a running session's
  // transcript is still growing, so its figure is a floor, not a total.
  const spendKey = linkedSessions.map(({ s }) => `${s.id}:${s.status}`).join(',')
  useEffect(() => {
    const ids = linkedSessions.map(({ s }) => s.id)
    if (ids.length === 0) {
      setSpend(null)
      return
    }
    let live = true
    void fetch(`/api/usage/sessions?ids=${encodeURIComponent(ids.join(','))}`)
      .then((r) => r.json() as Promise<SessionsUsageResponse>)
      .then((b) => {
        if (!live) return
        setSpend(b.ok ? b.usage : null)
        setSpendFailed(!b.ok)
      })
      .catch(() => {
        if (!live) return
        setSpend(null)
        setSpendFailed(true)
      })
    return () => {
      live = false
    }
    // `spendKey` is the real dependency: `linkedSessions` is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spendKey])

  // The split under the total: at most six hues in fixed order, the tail
  // stacked as one "Other" band rather than inventing colours. Slices are
  // already cost-sorted by the server.
  const split = useMemo(() => {
    const rows = spend?.models.filter((m) => m.cost > 0) ?? []
    if (rows.length <= MAX_SERIES) return rows.map((m, i) => ({ ...m, color: SERIES[i] }))
    const tail = rows.slice(MAX_SERIES)
    return [
      ...rows.slice(0, MAX_SERIES).map((m, i) => ({ ...m, color: SERIES[i] })),
      {
        model: OTHER_KEY,
        cost: tail.reduce((n, m) => n + m.cost, 0),
        tokens: tail.reduce((n, m) => n + m.tokens, 0),
        priced: tail.every((m) => m.priced),
        color: OTHER,
      },
    ]
  }, [spend])

  async function setState(status: ItemStatus, snoozeUntil?: number) {
    if (!item) return
    inboxStore.patch((items) => items.filter((i) => i.id !== item.id))
    await fetch('/api/items/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, status, snoozeUntil }),
    }).catch(() => {})
    onNavigate('/inbox')
  }

  function snooze1d() {
    const t = new Date()
    t.setDate(t.getDate() + 1)
    t.setHours(9, 0, 0, 0)
    void setState('snoozed', t.getTime())
  }

  function setPriority(priority: number) {
    if (!item) return
    inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, priority: priority || undefined } : i)))
    void fetch('/api/items/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, priority: priority || null }),
    }).catch(() => {})
  }

  // A due set here is yours and outlives rescans (same route as the inbox keys).
  function setDue(due: Section | string) {
    if (!item) return
    const at = (SECTION_ORDER as string[]).includes(due) ? dueFor(due as Section, Date.now()) : parseDue(due)
    inboxStore.patch((items) =>
      items.map((i) => (i.id === item.id ? { ...i, dueSource: 'you' as const, dueAt: at ?? undefined } : i)),
    )
    void fetch('/api/items/due', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, due }),
    }).catch(() => {})
  }

  function setProject(projectId: string) {
    if (!item) return
    inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, projectId: projectId || undefined } : i)))
    void fetch(`/api/items/manual?id=${encodeURIComponent(item.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }).catch(() => {})
  }

  /** Enter the description editor with the item's current text and images. */
  function editDescription() {
    if (!item) return
    setDescDraft(item.description ?? '')
    setImgDraft(item.images ?? [])
    setFileDraft(item.files ?? [])
    attach.clear()
  }

  function cancelDescription() {
    setDescDraft(null)
    setImgDraft(null)
    setFileDraft(null)
    setDescDragging(false)
    attach.clear()
  }

  async function saveDescription() {
    if (!item || descDraft === null) return
    const description = descDraft.trim()
    const held = imgDraft ?? []
    const heldFiles = fileDraft ?? []
    if (attach.uploading) return
    // Two endpoints, one save: the text, then the images when they moved.
    const imagesChanged = attach.images.length > 0 || held.length !== (item.images ?? []).length
    const filesChanged = !!attach.fileIds() || heldFiles.length !== (item.files ?? []).length
    setBusy('desc')
    try {
      const res = await fetch('/api/items/description', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, description: description || null }),
      })
      const b = (await res.json()) as { ok: boolean; error?: string }
      if (!b.ok) {
        setNotice(`Description not saved: ${b.error ?? 'could not save'}`)
        return
      }
      // The text is in; if a later part fails the editor stays open with the rest.
      const textSaved = (i: ScoredItem) => (i.id === item.id ? { ...i, description: description || undefined } : i)
      const partial = (what: string, why: string) => {
        inboxStore.patch((items) => items.map(textSaved))
        setOther((o) => (o?.item ? { ...o, item: textSaved(o.item) } : o))
        setNotice(`Description saved, but ${what} were not: ${why}`)
      }
      let images = item.images
      if (imagesChanged) {
        const edits: ItemImageEdit[] = [...held.map((i) => ({ id: i.id })), ...(attach.payload() ?? [])]
        const r = await fetch('/api/items/images', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id, images: edits }),
        })
        const ib = (await r.json()) as ItemImagesResponse
        if (!ib.ok) {
          partial('the images', ib.error)
          return
        }
        images = ib.images.length > 0 ? ib.images : undefined
      }
      let files = item.files
      if (filesChanged) {
        const r = await fetch('/api/items/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id, files: [...heldFiles.map((f) => f.id), ...(attach.fileIds() ?? [])] }),
        })
        const fb = (await r.json()) as ItemFilesResponse
        if (!fb.ok) {
          partial('the files', fb.error)
          return
        }
        files = fb.files.length > 0 ? fb.files : undefined
      }
      const patch = (i: ScoredItem) =>
        i.id === item.id ? { ...i, description: description || undefined, images, files } : i
      inboxStore.patch((items) => items.map(patch))
      setOther((o) => (o?.item ? { ...o, item: patch(o.item) } : o))
      cancelDescription()
    } finally {
      setBusy(null)
    }
  }

  async function iterate() {
    if (!item || !feedback.trim()) return
    setBusy('iterate')
    try {
      const res = await fetch('/api/briefs/iterate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, text: feedback.trim() }),
      })
      const b = (await res.json()) as BriefJobsResponse
      if (b.ok) setFeedback('')
      else setNotice(b.error)
    } finally {
      setBusy(null)
    }
  }

  async function cancelBrief() {
    if (!job || job.status !== 'queued') return
    await fetch('/api/briefs/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    }).catch(() => {})
  }

  if (!item) {
    const stillLooking = !snap.loaded || (other?.id !== id && !open)
    return (
      <div className="page">
        <div className="glow orange" aria-hidden="true" />
        <div className="inner">
          <div className="probing">
            {stillLooking ? (
              <>
                <span className="pip" /> Loading item…
              </>
            ) : (
              <>
                This item is not in the inbox any more. <a href="#/inbox">Back to the inbox</a>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const Icon = kindIcon(item)
  const status = item.status ?? 'open'
  const isOpen = status === 'open'
  const pri = item.priority ?? 0
  const due = dueOf(item, Date.now())
  const dueLabel =
    due.source === 'default'
      ? 'None'
      : due.at != null
        ? dueChip(due.at, Date.now())
        : sectionTitle(due.section, Date.now())
  const jobId = item.jobId ?? item.foundBy?.[item.foundBy.length - 1]?.jobId
  const project = item.projectId ? projects.find((p) => p.id === item.projectId) : undefined
  const settled = !job || job.status === 'ready' || job.status === 'failed'
  const pill = briefPill(job, brief?.stale ?? false)
  const tasks = loadedTasks ?? []
  const held = itemActions.actions.filter((a) => !a.hidden && a.status === 'needs_you' && !isOwnHandIn(a))
  const chats = linkedSessions.filter(({ s }) => s.kind !== 'task')
  // Dispatched chats and team runs hand the item off too; a brief run only reads it.
  const dispatched = chats.filter(({ s, role }) => role !== 'brief' && s.kind !== 'brief')
  const verdict = verdictOf(item, tasks, held.length, { total: dispatched.length, running: dispatched.filter(({ s }) => s.status === 'running').length })
  const shownTab = tab ?? verdict.tab
  const juniorTasks = tasks.filter((t) => t.owner === 'junior' && t.state !== 'skipped')
  const juniorLive = juniorTasks.some((t) => t.state === 'running') || chats.some(({ s }) => s.status === 'running')
  const linkCount = item.urls?.length ?? 0
  const longDesc = (item.description?.length ?? 0) > 220 || (item.description?.split('\n').length ?? 0) > 3
  const toggleBrief = () => {
    if (briefShown) openedBrief.delete(item.id)
    else openedBrief.add(item.id)
    setBriefShown(!briefShown)
  }
  const toggleLinks = () => {
    if (linksShown) openedLinks.delete(item.id)
    else openedLinks.add(item.id)
    setLinksShown(!linksShown)
  }

  return (
    <div className="itemPage">
      <div className="glow orange" aria-hidden="true" />

      <div className="itemMain">
        <div className="itemMeta">
          <Icon size={13} aria-hidden="true" />
          {item.repo && <span className="mono">{item.repo}</span>}
          {item.repo && <span className="sep">·</span>}
          <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
          <span className="sep">·</span>
          <span>
            {item.source === 'manual' ? 'added' : 'opened'} {ago(item.createdAt)}
            {item.source !== 'manual' && item.author && ` by ${item.author}`}
          </span>
        </div>

        <h1 className="display md">{item.title}</h1>

        <div className="chipRow">
          {item.flow && <FlowPopover key={`${item.flow.stage}:${item.flow.turn}`} itemId={item.id} flow={item.flow} onSaved={() => setEventsRev((n) => n + 1)} />}
          {item.flow?.broken && <span className="pill red">{item.flow.broken}</span>}
          <span className="pill mono">↑ {Math.round(item.score)}</span>
          {item.ciFailing && <span className="pill red">CI red</span>}
          {item.kind === 'own-pr-conflicting' && <span className="pill red">conflicts</span>}
          {item.peopleWaiting > 0 && <span className="pill">{item.peopleWaiting} waiting</span>}
          {pri > 0 && <span className={`pill ${pri <= 2 ? 'yellow' : ''}`}>{PRIORITY_LABEL[pri]}</span>}
          {item.isDraft && <span className="pill mute">draft</span>}
          {item.returned && <span className="pill green">returned</span>}
          {project && <span className="pill">{project.name}</span>}
          {jobId && jobTitles.has(jobId) && <span className="pill blue">{jobTitles.get(jobId)}</span>}
          {!isOpen && <span className="pill mute">{status}</span>}
          {pill && (
            <span className={`pill ${pill.tone}`}>
              {job?.status === 'running' && <span className="dot live sm" aria-hidden="true" />}
              {pill.label}
            </span>
          )}
        </div>

        {/* Description: the human's intent, in their words (and their
            screenshots). Never written by a run; both go to the brief. */}
        <div
          className={`descBlock${descDragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            if (descDraft === null || !e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDescDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDescDragging(false)
          }}
          onDrop={(e) => {
            if (descDraft === null || !e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDescDragging(false)
            void attach.add(e.dataTransfer.files)
          }}
        >
          <div className="secLabel mute">Description</div>
          {descDraft !== null ? (
            <>
              <textarea
                autoFocus
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Your intent, in your words — paste a screenshot or attach a file and it goes with it. The brief and any dispatched session read all of it."
                onPaste={attach.onPaste}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void saveDescription()
                  if (e.key === 'Escape') cancelDescription()
                }}
              />
              <AttachmentStrip
                images={[
                  ...(imgDraft ?? []).map((i) => ({ id: i.id, url: withWorkspace(itemImageUrl(item.id, i.id)), name: i.name })),
                  ...attach.images,
                ]}
                files={[
                  ...(fileDraft ?? []).map((f) => ({ id: f.id, name: f.name, bytes: f.bytes })),
                  ...attach.files.map((f) => ({ id: f.id, name: f.name, bytes: f.bytes, uploading: !f.uploadId })),
                ]}
                error={attach.error}
                onRemove={(imgId) => {
                  if ((imgDraft ?? []).some((i) => i.id === imgId)) setImgDraft((prev) => (prev ?? []).filter((i) => i.id !== imgId))
                  else if ((fileDraft ?? []).some((f) => f.id === imgId)) setFileDraft((prev) => (prev ?? []).filter((f) => f.id !== imgId))
                  else attach.remove(imgId)
                }}
              />
              <div className="row">
                <input
                  ref={filePicker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void attach.add(e.target.files)
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  className="btn xs ghost"
                  onClick={() => filePicker.current?.click()}
                  title="Attach a file or screenshot — or paste it into the box"
                  aria-label="Attach file"
                >
                  <Paperclip size={12} aria-hidden="true" /> File
                </button>
                <span className="spacer" />
                <button type="button" className="btn xs ghost" onClick={cancelDescription}>
                  Cancel
                </button>
                <button type="button" className="btn xs primary" disabled={busy === 'desc' || attach.uploading} onClick={() => void saveDescription()}>
                  {attach.uploading ? 'Uploading…' : 'Save'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                className={`descText${item.description ? '' : ' empty'}${item.description && longDesc && !descMore ? ' clamp' : ''}`}
                role="button"
                tabIndex={0}
                title="Click to edit"
                onClick={editDescription}
                onKeyDown={(e) => e.key === 'Enter' && editDescription()}
              >
                {item.description ?? 'Add a description: your intent, in your words. Junior reads it before it starts.'}
              </div>
              {longDesc && (
                <button type="button" className="linkBtn descMore" onClick={() => setDescMore(!descMore)}>
                  {descMore ? 'Show less' : 'Show more'}
                </button>
              )}
              {item.images && item.images.length > 0 && (
                <div className="descShots">
                  {item.images.map((img) => (
                    <a
                      key={img.id}
                      className="shot"
                      href={withWorkspace(itemImageUrl(item.id, img.id))}
                      target="_blank"
                      rel="noreferrer"
                      title={img.name ?? 'Open full size'}
                    >
                      <img src={withWorkspace(itemImageUrl(item.id, img.id))} alt={img.name ?? 'Attached screenshot'} />
                    </a>
                  ))}
                </div>
              )}
              {item.files && item.files.length > 0 && (
                <div className="descFiles">
                  {item.files.map((f) => (
                    <FileChip key={f.id} file={f} href={withWorkspace(itemFileUrl(item.id, f.id))} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Brief and links: one quiet row under the description, each opens in place. */}
        <div className="descMeta">
          {item.kind !== 'digest' && (
            <span>
              Brief · {pill ? pill.label : 'none'} ·{' '}
              {brief?.artifact || job ? (
                <button type="button" className="linkBtn" onClick={toggleBrief}>{briefShown ? 'Hide' : 'Show'}</button>
              ) : (
                <button type="button" className="linkBtn" onClick={() => setBriefOpen(true)}>Create</button>
              )}
            </span>
          )}
          <span>
            Links · {linkCount} ·{' '}
            <button type="button" className="linkBtn" onClick={toggleLinks}>{linksShown ? 'Hide' : linkCount ? 'Show' : 'Add'}</button>
          </span>
          <span className="spacer" />
          {descDraft === null && (
            <button type="button" className="linkBtn" onClick={editDescription}>Edit</button>
          )}
        </div>

        {linksShown && (
          <ItemLinks
            item={item}
            onDirty={onDirty}
            onSaved={(urls) => {
              const patch = (i: ScoredItem) => (i.id === item.id ? { ...i, urls: urls.length > 0 ? urls : undefined } : i)
              inboxStore.patch((items) => items.map(patch))
              setOther((o) => (o?.item ? { ...o, item: patch(o.item) } : o))
            }}
          />
        )}

        {briefShown && item.kind !== 'digest' && (
          <BriefCard
            item={item}
            job={job}
            brief={brief}
            pill={pill}
            settled={settled}
            feedback={feedback}
            busy={busy}
            setFeedback={setFeedback}
            setBriefOpen={setBriefOpen}
            iterate={iterate}
            cancelBrief={cancelBrief}
            onNavigate={onNavigate}
          />
        )}

        {report && <ReportCard report={report} onNavigate={onNavigate} />}

        <ItemVerdict
          item={item}
          verdict={verdict}
          tasks={tasks}
          {...(item.flow?.next === 'read brief' && !briefShown && item.kind !== 'digest' ? { action: { label: 'Read the brief', run: toggleBrief } } : {})}
          onChat={() => onDispatch(item)}
          onChanged={() => {
            reloadTasks()
            itemActions.refresh()
          }}
        />

        {notice && <div className="notice">{notice}</div>}

        {/* Needs you · Sessions · Activity: the order never changes; the one that opens follows whose turn it is. */}
        <Tabs.Root
          className="itemTabs"
          value={shownTab}
          onValueChange={(v) => {
            pickedTab.set(item.id, v as ItemTab)
            setTab(v as ItemTab)
          }}
        >
          <Tabs.List className="itemTabList" aria-label="This item">
            <Tabs.Trigger className="itemTab" value="needs">
              Needs you <span className={`n${verdict.needs > 0 ? ' hot' : ''}`}>{verdict.needs}</span>
            </Tabs.Trigger>
            <Tabs.Trigger className="itemTab" value="sessions">
              Sessions <span className="n">{juniorTasks.length + chats.length}</span>
              {juniorLive && <span className="dot live sm" aria-hidden="true" />}
            </Tabs.Trigger>
            <Tabs.Trigger className="itemTab" value="activity">
              Activity
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content className="itemTabPanel" value="needs">
            <NeedsYou
              item={item}
              verdict={verdict}
              tasks={tasks}
              held={held}
              onChanged={() => {
                reloadTasks()
                itemActions.refresh()
              }}
              onNavigate={onNavigate}
              onSnooze={snooze1d}
            />
          </Tabs.Content>
          <Tabs.Content className="itemTabPanel" value="sessions">
            <ItemSessionsTab tasks={tasks} chats={chats} handedOff={verdict.handedOff} spend={spend} checkouts={checkouts} onChanged={reloadTasks} onNavigate={onNavigate} />
          </Tabs.Content>
          <Tabs.Content className="itemTabPanel" value="activity">
            <ItemActivity
              actions={sendsOf(itemActions.actions)}
              events={events}
              tasks={tasks}
              footer={<ItemDetails item={item} jobTitles={jobTitles} />}
            />
          </Tabs.Content>
        </Tabs.Root>
      </div>

      <div className="itemAside">
        <AsideActions
          item={item}
          linkedSessions={linkedSessions}
          projects={projects}
          status={status}
          isOpen={isOpen}
          settled={settled}
          brief={brief}
          pri={pri}
          due={due}
          dueLabel={dueLabel}
          onDispatch={onDispatch}
          setBriefOpen={setBriefOpen}
          setPickingDue={setPickingDue}
          setState={setState}
          snooze1d={snooze1d}
          setPriority={setPriority}
          setDue={setDue}
          setProject={setProject}
        />

        <ItemPlans linkedSessions={linkedSessions} links={links} onNavigate={onNavigate} />

        {/* Outbound actions: what those sessions did that left this machine. */}
        {itemActions.actions.some((a) => !a.hidden) && (
          <>
            <div className="secLabel mute">
              Actions <span className="n">{itemActions.actions.filter((a) => !a.hidden).length}</span>
            </div>
            {/* What waits on you first; then newest first. */}
            <ItemActions
              actions={itemActions.actions.filter((a) => !a.hidden).sort((x, y) => Number(y.status === 'needs_you') - Number(x.status === 'needs_you'))}
              onNavigate={onNavigate}
            />
          </>
        )}

        <CostBlock linkedSessions={linkedSessions} spend={spend} spendFailed={spendFailed} split={split} />

        <div className="secLabel mute">Linked</div>
        {item.linked && item.linked.length > 0 ? (
          item.linked.map((l) => (
            <div key={l.id} className="linkedRow">
              <Hash size={13} aria-hidden="true" />
              <span>
                <span className="src">
                  {l.source} · {l.repo}
                </span>
                <br />
                <a href={l.url} target="_blank" rel="noreferrer">
                  {l.title || l.url.replace(/^https?:\/\//, '')}
                </a>
              </span>
            </div>
          ))
        ) : (
          <div className="asideEmpty">Nothing else refers to this item yet.</div>
        )}

        <ItemTimeline events={events} />
      </div>

      <DueDialog
        item={pickingDue ? item : null}
        onClose={() => setPickingDue(false)}
        onPick={(_, day) => {
          setDue(day ?? 'later')
          setPickingDue(false)
        }}
      />
      <BriefComposerDialog item={briefOpen ? item : null} latest={job ?? null} onClose={() => setBriefOpen(false)} />
    </div>
  )
}
