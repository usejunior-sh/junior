/**
 * ⌘K: the command palette. Radix Dialog around cmdk (combobox, listbox and
 * options a screen reader can reach). Search today's commands, chats, items,
 * projects, jobs; when an item is in focus, its verbs come first under "This
 * item" (itemVerbs.ts, the Junior page's rules). ⌘⏎ hands the highlighted
 * work item to Junior; with Keep open on, the palette stays for the next one.
 * Nothing here sends: a hand-off is local work, and Approve send… opens the
 * chat where the held card is, so the words are approved on the card.
 * Design note: .docs/overnight-2026-10-24/designs/palette-cmdk.md.
 */
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { Command as K } from 'cmdk'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  ActionsResponse,
  InboxResponse,
  Project,
  ProjectsResponse,
  ScoredItem,
  SessionSummary,
  TerminalSummary,
  Job,
  JobsResponse,
} from '../../../shared/protocol.js'
import { SNOOZE_CHOICES, snoozeClock, snoozeUntil } from '../../../core/work/snooze.js'
import { MOD_LABEL } from '../keys.js'
import { frictionKeyLabel } from '../shortcuts.js'
import { SETTINGS_TABS, type SettingsTab } from '../settings.js'
import { grantLabel } from '../../../core/job/tools.js'
import { doneItem, sendHandoff, snoozeItem, type HandoffVerb } from '../handoff.js'
import { filterCommands, handedOffLine, handOffOf, heldSends, moreLine, sectionsOf, verbErrorLine, verbsOf, type ItemVerb } from '../itemVerbs.js'
import { refOf } from '../itemRef.js'
import { useIsMobile } from '../useMobile.js'

export type Command = {
  id: string
  section: 'This item' | 'Actions' | 'Pages' | 'Settings' | 'Projects' | 'Chats' | 'Terminals' | 'Jobs' | 'Work items'
  label: string
  hint?: string
  run: () => void
  /** the Junior page key that does the same (This item verbs, shown on the Junior page only) */
  key?: string
  /** a work item row: ⌘⏎ (or the phone's Hand off button) hands it to Junior */
  item?: ScoredItem
  /** a This item verb, run in place: its answer shows in the footer */
  verb?: ItemVerb
}

type Props = {
  open: boolean
  sessions: readonly SessionSummary[]
  terminals: readonly TerminalSummary[]
  /** the item in focus when ⌘K was pressed (selection.ts focusedItemId), for This item */
  focusedItemId: string | null
  /** keys show on verb rows only there: the Inbox uses some of the same letters */
  onJuniorPage: boolean
  onClose: () => void
  onNavigate: (hash: string) => void
  onNewSession: () => void
  onNewTerminal: () => void
  onOpenItem: (item: ScoredItem) => void
  onNewSessionIn: (project: Project) => void
  onSyncInbox: () => void
  onAddJob: () => void
  onOpenSettings: (tab?: SettingsTab) => void
  onHelp: () => void
  onNoteFriction: () => void
}

const SECTION_ORDER: Command['section'][] = ['This item', 'Actions', 'Pages', 'Settings', 'Projects', 'Chats', 'Terminals', 'Jobs', 'Work items']

const KEEP_OPEN_KEY = 'junior.palette.keepOpen'

type Load = 'loading' | 'ok' | 'failed'
type Status = { text: string; error?: boolean } | null

const LOAD_ERROR = { items: 'Couldn’t load work items.', projects: 'Couldn’t load projects.', jobs: 'Couldn’t load jobs.' } as const

function readKeepOpen(): boolean {
  try {
    return localStorage.getItem(KEEP_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function CommandPalette({
  open,
  sessions,
  terminals,
  focusedItemId,
  onJuniorPage,
  onClose,
  onNavigate,
  onNewSession,
  onNewTerminal,
  onOpenItem,
  onNewSessionIn,
  onSyncInbox,
  onAddJob,
  onOpenSettings,
  onHelp,
  onNoteFriction,
}: Props) {
  const input = useRef<HTMLInputElement>(null)
  const phone = useIsMobile()
  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [page, setPage] = useState<'root' | 'snooze'>('root')
  const [items, setItems] = useState<ScoredItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [load, setLoad] = useState<{ items: Load; projects: Load; jobs: Load }>({ items: 'loading', projects: 'loading', jobs: 'loading' })
  /** the item in focus when it opened: it stays This item until it closes */
  const [focusId, setFocusId] = useState<string | null>(null)
  const [held, setHeld] = useState<{ count: number; sessionId: string | null } | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [keepOpen, setKeepOpen] = useState(readKeepOpen)
  /** handed off with Keep open on: gone from Work items */
  const [handedOff, setHandedOff] = useState<ReadonlySet<string>>(() => new Set())
  const busy = useRef(false)
  /** a command ran: it may move focus itself (a composer), so the close doesn't restore it */
  const ran = useRef(false)
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!open) return
    setQuery('')
    setValue('')
    setPage('root')
    setStatus(null)
    setHandedOff(new Set())
    setHeld(null)
    setFocusId(focusedItemId)
    setLoad({ items: 'loading', projects: 'loading', jobs: 'loading' })
    let live = true
    const failed = (what: keyof typeof LOAD_ERROR) => {
      if (!live) return
      setLoad((l) => ({ ...l, [what]: 'failed' }))
      setStatus({ text: LOAD_ERROR[what] })
    }
    // Work items come from the server's snapshot cache, ~30ms, no sync.
    void fetch('/api/inbox')
      .then((r) => r.json() as Promise<InboxResponse>)
      .then((b) => {
        if (!live) return
        if (!b.ok) return failed('items')
        setItems(b.items)
        setLoad((l) => ({ ...l, items: 'ok' }))
      })
      .catch(() => failed('items'))
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (!live) return
        if (!b.ok) return failed('projects')
        setProjects(b.projects)
        setLoad((l) => ({ ...l, projects: 'ok' }))
      })
      .catch(() => failed('projects'))
    void fetch('/api/jobs')
      .then((r) => r.json() as Promise<JobsResponse>)
      .then((b) => {
        if (!live) return
        if (!b.ok) return failed('jobs')
        setJobs(b.jobs)
        setLoad((l) => ({ ...l, jobs: 'ok' }))
      })
      .catch(() => failed('jobs'))
    // Sends held on the item in focus, for Approve send…; a failure is silent (the verb just doesn't show).
    if (focusedItemId)
      void fetch(`/api/actions?item=${encodeURIComponent(focusedItemId)}&limit=200`)
        .then((r) => r.json() as Promise<ActionsResponse>)
        .then((b) => {
          if (live && b.ok) setHeld(heldSends(b.actions))
        })
        .catch(() => {})
    return () => {
      live = false
    }
    // The item in focus is read once, as the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const focusItem = focusId ? (items.find((i) => i.id === focusId) ?? null) : null

  /** Close, then run: the dialog lets go of focus before the command's target (a composer) takes it. */
  const closeThen = (run: () => void) => {
    ran.current = true
    onClose()
    run()
  }

  const setKeep = (on: boolean) => {
    setKeepOpen(on)
    try {
      localStorage.setItem(KEEP_OPEN_KEY, on ? '1' : '0')
    } catch {
      /* private mode: remembered for this session only */
    }
  }

  async function handOff(item: ScoredItem) {
    const h = handOffOf(item)
    if (!h) return setStatus({ text: 'Already with Junior.' })
    if (busy.current) return
    busy.current = true
    setStatus(null)
    const { error, readiness } = await sendHandoff('start', item.id, h.playbook)
    busy.current = false
    if (!openRef.current) return
    if (error) return setStatus({ text: verbErrorLine(error), error: true })
    if (!keepOpen) return closeThen(() => {})
    setItems((all) => all.map((i) => (i.id === item.id ? { ...i, handoff: 'on', suggestion: undefined } : i)))
    setHandedOff((s) => new Set(s).add(item.id))
    setStatus({ text: handedOffLine(item.title, readiness) })
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
  }

  /** Pause, resume, not this one: the palette waits for the answer, and stays open on a failure. */
  async function sendVerb(verb: HandoffVerb, item: ScoredItem) {
    if (busy.current) return
    busy.current = true
    setStatus(null)
    const { error } = await sendHandoff(verb, item.id)
    busy.current = false
    if (!openRef.current) return
    if (error) return setStatus({ text: verbErrorLine(error), error: true })
    closeThen(() => {})
  }

  function runVerb(v: ItemVerb, item: ScoredItem) {
    if (v.id === 'handoff') return void handOff(item)
    if (v.id === 'snooze') {
      setPage('snooze')
      setQuery('')
      setValue('')
      return
    }
    if (v.id === 'not-now') return void sendVerb('not-now', item)
    if (v.id === 'pause' || v.id === 'resume') return void sendVerb(v.id, item)
    if (v.id === 'approve') {
      const to = held?.sessionId
      return closeThen(() => onNavigate(to ?? '/junior/log'))
    }
    if (v.id === 'open') return closeThen(() => onOpenItem(item))
    if (v.id === 'done') return closeThen(() => void doneItem(item))
  }

  const commands = useMemo<Command[]>(
    () => [
      ...(focusItem
        ? verbsOf(focusItem, held?.count ?? 0).map((v): Command => ({
            id: `v:${v.id}`,
            section: 'This item',
            label: v.label,
            hint: v.hint,
            key: v.key,
            verb: v,
            run: () => {},
          }))
        : []),
      { id: 'new', section: 'Actions', label: 'New chat', hint: 'n', run: onNewSession },
      { id: 'newterm', section: 'Actions', label: 'New terminal', run: onNewTerminal },
      { id: 'sync', section: 'Actions', label: 'Sync inbox now', run: onSyncInbox },
      { id: 'addjob', section: 'Actions', label: 'Add job', run: onAddJob },
      { id: 'help', section: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: onHelp },
      { id: 'friction', section: 'Actions', label: 'Note what annoyed you', hint: frictionKeyLabel(MOD_LABEL), run: onNoteFriction },
      { id: 'settings', section: 'Actions', label: 'Settings', hint: `${MOD_LABEL},`, run: () => onOpenSettings() },
      ...SETTINGS_TABS.map((t): Command => ({
        id: `set:${t.id}`,
        section: 'Settings',
        label: `Settings: ${t.label}`,
        hint: t.id === 'connectors' ? 'g c' : t.id === 'projects' ? 'g p' : t.sub,
        run: () => onOpenSettings(t.id),
      })),
      { id: 'inbox', section: 'Pages', label: 'Inbox', hint: 'g i', run: () => onNavigate('/inbox') },
      { id: 'sessions', section: 'Pages', label: 'Chats', hint: 'g s', run: () => onNavigate('') },
      { id: 'terminals', section: 'Pages', label: 'Terminals', hint: 'g t', run: () => onNavigate('/terminals') },
      { id: 'jobs', section: 'Pages', label: 'Jobs', hint: 'g j', run: () => onNavigate('/jobs') },
      { id: 'actions', section: 'Pages', label: 'Junior’s log', hint: 'g a', run: () => onNavigate('/junior/log') },
      ...jobs.map((w): Command => ({
        id: `wa:${w.id}`,
        section: 'Jobs',
        label: `${w.enabled ? 'Pause' : 'Resume'} job: ${w.title}`,
        hint: w.tools.map(grantLabel).join(', '),
        run: () => {
          void fetch(`/api/jobs?id=${encodeURIComponent(w.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !w.enabled }),
          })
        },
      })),
      ...projects.map((pr): Command => ({
        id: `p:${pr.id}`,
        section: 'Projects',
        label: `New chat in ${pr.name}`,
        hint: pr.repo || pr.path.split('/').pop(),
        run: () => onNewSessionIn(pr),
      })),
      ...sessions.map((s): Command => ({
        id: `s:${s.id}`,
        section: 'Chats',
        label: s.title,
        hint: `${s.status} · ${s.cwd.split('/').pop() ?? ''}`,
        run: () => onNavigate(s.id),
      })),
      ...terminals.map((t): Command => ({
        id: `t:${t.id}`,
        section: 'Terminals',
        label: t.title,
        hint: `${t.status} · ${t.cwd.split('/').pop() ?? ''}`,
        run: () => onNavigate(`/terminal/${t.id}`),
      })),
      ...items
        .filter((i) => !handedOff.has(i.id))
        .map((i): Command => ({
          id: `w:${i.id}`,
          section: 'Work items',
          label: i.title,
          // the label rides in the hint, so typing "friction" lists every note from ⌘⇧.
          hint: `${i.repo} · ${i.rankWhy}${i.label === 'friction' ? ' · friction' : ''}`,
          item: i,
          run: () => onOpenItem(i),
        })),
    ],
    [focusItem, held, sessions, terminals, items, handedOff, projects, jobs, onNavigate, onNewSession, onNewTerminal, onOpenItem, onNewSessionIn, onSyncInbox, onAddJob, onOpenSettings, onHelp, onNoteFriction],
  )

  const shown = useMemo(() => filterCommands(commands, query, SECTION_ORDER), [commands, query])
  const sections = useMemo(() => sectionsOf(shown), [shown])
  const byId = useMemo(() => new Map(shown.map((c) => [c.id, c])), [shown])
  const loading = load.items === 'loading' || load.projects === 'loading' || load.jobs === 'loading'

  function select(cmd: Command) {
    if (cmd.verb) {
      if (focusItem) runVerb(cmd.verb, focusItem)
      return
    }
    closeThen(cmd.run)
  }

  const back = () => {
    setPage('root')
    setQuery('')
    setValue('')
    requestAnimationFrame(() => input.current?.focus())
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // ⌘⏎: hand the highlighted work item to Junior (before cmdk's own Enter)
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      const cmd = byId.get(value)
      if (page === 'root' && cmd?.item) void handOff(cmd.item)
      return
    }
    if (page === 'snooze' && e.key === 'Backspace' && query === '') {
      e.preventDefault()
      back()
    }
  }

  // a focused button answers Enter and Space itself, not cmdk's highlighted row
  const ownEnter = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
  }

  const showKeys = onJuniorPage && !phone
  const now = Date.now()
  const q = query.trim().toLowerCase()
  const snoozeRows = SNOOZE_CHOICES.filter((c) => !q || c.label.toLowerCase().includes(q))

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content
          id="palette"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            input.current?.focus()
          }}
          onCloseAutoFocus={(e) => {
            // a command that moved focus keeps it; else focus goes back where it was
            const a = document.activeElement
            if (ran.current && a && a !== document.body) e.preventDefault()
            ran.current = false
          }}
          onEscapeKeyDown={(e) => {
            if (page !== 'snooze') return
            e.preventDefault()
            back()
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <K label="Command palette" shouldFilter={false} loop={false} value={value} onValueChange={setValue} onKeyDown={onKeyDown}>
            <div className="palHead">
              {page === 'snooze' && (
                <button type="button" className="palBack" aria-label="Back" onClick={back} onKeyDown={ownEnter}>
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
              )}
              <K.Input ref={input} placeholder={page === 'snooze' ? 'Snooze until…' : 'Search chats, items, projects, commands…'} value={query} onValueChange={setQuery} />
              {/* A phone has no Escape, and the palette fills the screen, leaving no backdrop to tap. */}
              <button type="button" className="palCancel" onClick={onClose} onKeyDown={ownEnter}>
                Cancel
              </button>
            </div>
            <K.List className="palList">
              {page === 'snooze' && focusItem ? (
                <>
                  {snoozeRows.map((c) => {
                    const until = snoozeUntil(c.id, now)
                    return (
                      <K.Item key={c.id} value={`z:${c.id}`} className="palRow" onSelect={() => closeThen(() => void snoozeItem(focusItem, until))}>
                        <span className="palLabel">{c.label}</span>
                        <span className="palHint">{snoozeClock(until, now)}</span>
                      </K.Item>
                    )
                  })}
                  <K.Empty className="palEmpty">Nothing matches.</K.Empty>
                  <div className="palNote">Comes back early if something changes.</div>
                </>
              ) : (
                <>
                  {sections.map((g) => (
                    <K.Group
                      key={g.section}
                      value={g.section}
                      heading={
                        g.section === 'This item' && focusItem ? (
                          <>
                            <span>This item</span>
                            <span className="palFocus" title={focusItem.title}>
                              <span className="palRef">{refOf(focusItem)}</span>
                              <span className="palFocusTitle">· {focusItem.title}</span>
                            </span>
                          </>
                        ) : (
                          g.section
                        )
                      }
                    >
                      {g.rows.map((c) => (
                        <K.Item key={c.id} value={c.id} className="palRow" title={c.label} onSelect={() => select(c)} aria-keyshortcuts={showKeys && c.key ? c.key : undefined}>
                          <span className="palLabel">{c.label}</span>
                          {c.hint && <span className="palHint">{c.hint}</span>}
                          {c.item && value === c.id && !phone && handOffOf(c.item) && (
                            <span className="palDo" aria-hidden="true">
                              {MOD_LABEL}⏎ hand off
                            </span>
                          )}
                          {c.item && phone && handOffOf(c.item) && (
                            <button
                              type="button"
                              className="btn sm ghost palHandoff"
                              onKeyDown={ownEnter}
                              onClick={(e) => {
                                e.stopPropagation()
                                void handOff(c.item!)
                              }}
                            >
                              Hand off
                            </button>
                          )}
                          {showKeys && c.key && (
                            <kbd className="kbd" aria-hidden="true">
                              {c.key.toUpperCase()}
                            </kbd>
                          )}
                        </K.Item>
                      ))}
                      {g.more > 0 && <div className="palMore">{moreLine(g.more)}</div>}
                    </K.Group>
                  ))}
                  <K.Empty className="palEmpty">{loading ? 'Looking…' : 'Nothing matches.'}</K.Empty>
                </>
              )}
            </K.List>
          </K>
          <div className="palFoot">
            <span role="status" aria-live="polite" className={`palStatus${status?.error ? ' err' : ''}`}>
              {status?.text ?? ''}
            </span>
            <label className="palKeep" title="Stay open after a hand-off, to hand off several in a row.">
              <span>Keep open</span>
              <Switch.Root className="uiSwitch" checked={keepOpen} onCheckedChange={setKeep}>
                <Switch.Thumb className="uiSwitchThumb" />
              </Switch.Root>
            </label>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
