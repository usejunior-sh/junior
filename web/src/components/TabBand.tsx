import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarClock,
  ChevronRight,
  CircleDot,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Home,
  MessageSquare,
  PanelLeftOpen,
  PenLine,
  Pin,
  Plus,
  Terminal,
  X,
  XCircle,
  type LucideProps,
  ListChecks,
} from 'lucide-react'
import { JuniorFace } from './JuniorFace.js'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import type { Project, ProjectsResponse } from '../../../shared/protocol.js'
import {
  CtxMenu,
  CtxMenuContent,
  CtxMenuItem,
  CtxMenuSeparator,
  CtxMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '../ui/Menu.js'
import { MOD_LABEL } from '../keys.js'
import { defaultProjectOf } from './ProjectPicker.js'

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * What a tab holds. Every kind but `place` is a *thing*, with a tab of its
 * own; a place (Tasks, PRs, Artifacts, Jobs, Settings) shares the preview tab.
 */
export type TabKind = 'session' | 'terminal' | 'draft' | 'item' | 'artifact' | 'job' | 'job-form' | 'change' | 'run' | 'place' | 'dm'

const ICON: Record<TabKind, ComponentType<LucideProps>> = {
  session: MessageSquare,
  terminal: Terminal,
  draft: PenLine,
  item: CircleDot,
  artifact: FileText,
  job: CalendarClock,
  'job-form': CalendarClock,
  change: FileDiff,
  run: FolderOpen,
  place: ListChecks,
  dm: Bot,
}

export type OpenTab = {
  /** the tab-band key: a session id, or `<kind>:<id>` for everything else */
  key: string
  kind: TabKind
  title: string
  color: string
  /** live: a working session, or a running shell */
  running: boolean
  /** a chat waiting on you, and for what: "Question", "Permission: Bash" */
  waiting?: string
  /** the worktree it runs in, as a short branch slug; absent in a project's main folder */
  branch?: string
  /** that worktree has since been removed */
  branchGone?: boolean
  /** the preview tab: styled as provisional, and replaced by the next place */
  preview?: boolean
  /** an agent's DM: its face's colour, in place of the icon (undefined = the persona's) */
  face?: string
  /** a place's own mark, in place of the kind's */
  icon?: ComponentType<LucideProps>
}

type Props = {
  /** the tab in front's key */
  activeKey: string
  /** Junior's DM: always first, icon-only, never closed */
  junior: OpenTab
  tabs: readonly OpenTab[]
  /** The one place in the preview tab, if any: it outlives navigating away. */
  preview?: OpenTab | null
  /** Set while the panel is hidden: its show button leads the band. */
  onShowPanel?: () => void
  onSelect: (key: string) => void
  onClose: (key: string) => void
  /** Close every open tab at once, preview included (Junior's stays). */
  onCloseAll: () => void
  /** Keep the place in the preview tab: the next place opens beside it. */
  onPin: (key: string) => void
  /** Drag a pinned tab: move it to sit before `before`'s key, or to the end when `before` is null. */
  onReorder: (key: string, before: string | null) => void
  onNew: () => void
  /** Open a shell, in `cwd`, or the daemon's default (home) when undefined. */
  onNewTerminal: (cwd?: string) => void
  /** The folder a new terminal opens in by default: the active tab's. */
  terminalCwd?: string
}

/**
 * Which edges still have tabs past them, as a `data-fade` value. The band
 * scrolls once the tabs stop fitting, and a scrolling strip with no edge
 * treatment reads as a clipped one. The fade is the only thing saying
 * "there is more this way".
 */
function useEdgeFade(ref: RefObject<HTMLDivElement | null>, count: number) {
  const [fade, setFade] = useState<'left' | 'right' | 'both' | 'none'>('none')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const left = el.scrollLeft > 1
      // Sub-pixel layout means scrollWidth can sit a hair above clientWidth
      // with nothing actually hidden; a 1px deadband keeps the fade off.
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none')
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    // Resizing the window changes what fits; opening or closing a tab changes
    // what there is to fit, and re-runs this effect through `count`.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [ref, count])
  return fade
}

type DragBag = {
  dragging: boolean
  dropEdge: 'before' | 'after' | null
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void
  onDragOver: (e: DragEvent<HTMLButtonElement>) => void
  onDrop: (e: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
}

/** The context-menu path to the same reorder. The keyboard route, since drag is pointer-only. */
type ReorderBag = { canLeft: boolean; canRight: boolean; onLeft: () => void; onRight: () => void }

/**
 * A private MIME type for the drag payload, not `text/plain`. The prompt box
 * and the inbox title field are drop targets everywhere in this app, and a
 * plain-text tab key would land in them as typed text on an overshot drop.
 * Nothing outside the band ever reads this payload (the dragged key lives in
 * state, see below), so an unrecognised type costs nothing; it still has to
 * be *something*, since Firefox won't start a drag with an empty `dataTransfer`.
 */
const TAB_DRAG_TYPE = 'application/x-junior-tab'

/**
 * Native HTML5 drag and drop for the strip. One horizontal list doesn't need
 * a library. `dropBefore` names the key the dragged tab would land in front
 * of (or `null` for the end); it drives both the reorder call and the
 * indicator, so the two can never show a different answer than they act on.
 * Safari won't hand back `dataTransfer` payload during `dragover`, so the
 * dragged key lives in state instead of being read off the event.
 */
function useTabDrag(tabs: readonly OpenTab[], onReorder: (key: string, before: string | null) => void) {
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  // Separate from dragKey: dropBefore's own `null` already means "end of
  // list", so it can't also mean "pointer isn't over a tab right now", the
  // gap past the last tab, the +. Without this the last real target
  // stays painted under the cursor once the drag leaves the strip.
  const [overStrip, setOverStrip] = useState(false)

  const onDragEnd = useCallback(() => {
    setDragKey(null)
    setDropBefore(null)
    setOverStrip(false)
  }, [])

  const onStripDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverStrip(false)
  }, [])

  const bag = useCallback(
    (key: string, index: number): DragBag => ({
      dragging: dragKey === key,
      dropEdge:
        !dragKey || !overStrip
          ? null
          : dropBefore === key
            ? 'before'
            : dropBefore === null && index === tabs.length - 1
              ? 'after'
              : null,
      onDragStart: (e) => {
        e.dataTransfer.setData(TAB_DRAG_TYPE, key)
        e.dataTransfer.effectAllowed = 'move'
        setDragKey(key)
        setDropBefore(key)
        setOverStrip(true)
      },
      onDragOver: (e) => {
        if (!dragKey) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOverStrip(true)
        const rect = e.currentTarget.getBoundingClientRect()
        const before = e.clientX < rect.left + rect.width / 2
        const target = before ? tabs[index].key : (tabs[index + 1]?.key ?? null)
        setDropBefore((cur) => (cur === target ? cur : target))
      },
      onDrop: (e) => {
        e.preventDefault()
        if (dragKey) onReorder(dragKey, dropBefore)
      },
      onDragEnd,
    }),
    [dragKey, dropBefore, overStrip, tabs, onReorder, onDragEnd],
  )

  return { bag, onStripDragLeave }
}

/** The page tabs: Junior's DM first, a closable tab per thing, the preview tab for a place, + for a new chat. */
export function TabBand({
  activeKey,
  junior,
  tabs,
  preview,
  onShowPanel,
  onSelect,
  onClose,
  onCloseAll,
  onPin,
  onReorder,
  onNew,
  onNewTerminal,
  terminalCwd,
}: Props) {
  const strip = useRef<HTMLDivElement>(null)
  const count = tabs.length + (preview ? 1 : 0)
  const fade = useEdgeFade(strip, count)
  useKeepActiveInView(strip, activeKey, count)
  const { bag: dragBag, onStripDragLeave } = useTabDrag(tabs, onReorder)

  return (
    <div className="tabband" role="tablist">
      {/* The + sits outside the scroller: the way out of a crowded band
          must never be the thing that scrolled off it. */}
      {onShowPanel && (
        <button type="button" className="add showPanel" onClick={onShowPanel} title={`Show panel (${MOD_LABEL}B)`} aria-label="Show panel">
          <PanelLeftOpen size={15} aria-hidden="true" />
        </button>
      )}

      <JuniorTab tab={junior} active={activeKey === junior.key} onSelect={onSelect} />

      <div className="strip" ref={strip} data-fade={fade} role="presentation" onDragLeave={onStripDragLeave}>
        {tabs.map((t, i) => (
          <Tab
            key={t.key}
            tab={t}
            active={activeKey === t.key}
            onSelect={onSelect}
            onClose={onClose}
            onCloseAll={onCloseAll}
            onPin={onPin}
            drag={dragBag(t.key, i)}
            reorder={{
              canLeft: i > 0,
              canRight: i < tabs.length - 1,
              onLeft: () => onReorder(t.key, tabs[i - 1]?.key ?? null),
              onRight: () => onReorder(t.key, tabs[i + 2]?.key ?? null),
            }}
          />
        ))}

        {preview && (
          <Tab
            tab={preview}
            active={activeKey === preview.key}
            onSelect={onSelect}
            onClose={onClose}
            onCloseAll={onCloseAll}
            onPin={onPin}
          />
        )}
      </div>

      <NewTabMenu onNew={onNew} onNewTerminal={onNewTerminal} terminalCwd={terminalCwd} />
    </div>
  )
}

/**
 * Junior's DM: the J face alone, outside the scroller so it never scrolls
 * away, no close. Its dot says Junior is working; orange says it waits on you.
 */
function JuniorTab({ tab, active, onSelect }: { tab: OpenTab; active: boolean; onSelect: (key: string) => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={tab.waiting ? `${tab.title}, waiting on you: ${tab.waiting}` : tab.title}
      className={`tab juniorTab${active ? ' active' : ''}`}
      title={tab.waiting ? `${tab.title} — waiting on you: ${tab.waiting}` : tab.title}
      onClick={() => onSelect(tab.key)}
    >
      <JuniorFace size={16} motion="still" decorative />
      {tab.waiting ? (
        <span className="pdot needs" aria-hidden="true" />
      ) : (
        tab.running && <span className="pdot live" style={{ background: tab.color }} aria-hidden="true" />
      )}
    </button>
  )
}

/**
 * Hold the selected tab on screen. Selecting happens from the inbox, the
 * command palette and the rail as well as from the band itself, so a tab can
 * become active while sitting well outside the scrolled strip. Keyed on the
 * active *key*, not a tab's active flag: the preview slot is one element that
 * stays active while its document changes. Only the strip scrolls, never the
 * page around it, which scrollIntoView would also move.
 */
function useKeepActiveInView(strip: RefObject<HTMLDivElement | null>, activeKey: string, count: number) {
  useLayoutEffect(() => {
    const el = strip.current
    const tab = el?.querySelector<HTMLElement>('.tab.active')
    if (!el || !tab) return
    // Clear of the 28px edge fade, so the tab reads as fully there.
    const FADE = 28
    const reveal = () => {
      const box = el.getBoundingClientRect()
      const t = tab.getBoundingClientRect()
      const left = t.left - box.left + el.scrollLeft
      const right = left + t.width
      if (left - FADE < el.scrollLeft) el.scrollTo({ left: left - FADE, behavior: 'instant' })
      else if (right + FADE > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right + FADE - el.clientWidth, behavior: 'instant' })
    }
    reveal()
    // A document tab learns its title after it opens, which widens it.
    const ro = new ResizeObserver(reveal)
    ro.observe(tab)
    return () => ro.disconnect()
  }, [strip, activeKey, count])
}

/**
 * One tab. A session or shell carries its project dot; a document does not.
 * The preview tab is provisional: double-click keeps it, the way a preview
 * editor works everywhere else.
 */
function Tab({
  tab,
  active,
  onSelect,
  onClose,
  onCloseAll,
  onPin,
  drag,
  reorder,
}: {
  tab: OpenTab
  active: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseAll: () => void
  onPin: (key: string) => void
  /** Present only for pinned tabs: the preview slot and page tab neither drag nor take a drop. */
  drag?: DragBag
  /** Present only for pinned tabs: same reasoning as `drag`, but this is the keyboard/menu route to it. */
  reorder?: ReorderBag
}) {
  const close = (e: MouseEvent) => {
    e.stopPropagation()
    onClose(tab.key)
  }
  const Icon = tab.icon ?? ICON[tab.kind]
  // A DM's face is its mark; its dot shows only while the agent works.
  const dotted = tab.kind === 'session' || tab.kind === 'terminal' || (tab.kind === 'dm' && tab.running)
  return (
    <CtxMenu>
      <CtxMenuTrigger asChild>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          draggable={!!drag}
          className={`tab${active ? ' active' : ''}${tab.preview ? ' preview' : ''}${drag?.dragging ? ' dragging' : ''}`}
          title={tab.preview ? `${tab.title} — double-click to keep it open` : tab.waiting ? `${tab.title} — waiting on you: ${tab.waiting}` : tab.title}
          onClick={() => onSelect(tab.key)}
          onDoubleClick={() => tab.preview && onPin(tab.key)}
          onAuxClick={(e) => e.button === 1 && close(e)}
          onDragStart={drag?.onDragStart}
          onDragOver={drag?.onDragOver}
          onDrop={drag?.onDrop}
          onDragEnd={drag?.onDragEnd}
        >
          {drag?.dropEdge === 'before' && <span className="dropline before" aria-hidden="true" />}
          {tab.kind === 'dm' ? <JuniorFace size={14} motion="still" colour={tab.face} decorative /> : <Icon size={13} aria-hidden="true" />}
          <span className={`t${tab.kind === 'draft' ? ' draft' : ''}`}>
            {tab.waiting ? (
              <span className="pdot needs" aria-label="waiting on you" />
            ) : (
              dotted && <span className={`pdot${tab.running ? ' live' : ''}`} style={{ background: tab.color }} aria-hidden="true" />
            )}
            {tab.title}
          </span>
          {tab.branch && (
            <span className={`br${tab.branchGone ? ' gone' : ''}`} title={tab.branchGone ? 'worktree removed' : 'worktree'}>
              <GitBranch size={9} aria-hidden="true" />
              {tab.branch}
            </span>
          )}
          <span className="cl" role="button" aria-label={`Close ${tab.title}`} tabIndex={-1} onClick={close}>
            <X size={11} aria-hidden="true" />
          </span>
          {drag?.dropEdge === 'after' && <span className="dropline after" aria-hidden="true" />}
        </button>
      </CtxMenuTrigger>
      <CtxMenuContent>
        {tab.preview && (
          <>
            <CtxMenuItem onSelect={() => onPin(tab.key)}>
              <Pin size={14} aria-hidden="true" />
              <span className="text">
                <span className="name">Keep open</span>
                <span className="desc">Stop the next page replacing it</span>
              </span>
            </CtxMenuItem>
            <CtxMenuSeparator />
          </>
        )}
        {reorder && (
          <>
            <CtxMenuItem disabled={!reorder.canLeft} onSelect={reorder.onLeft}>
              <ArrowLeft size={14} aria-hidden="true" />
              <span className="name">Move left</span>
            </CtxMenuItem>
            <CtxMenuItem disabled={!reorder.canRight} onSelect={reorder.onRight}>
              <ArrowRight size={14} aria-hidden="true" />
              <span className="name">Move right</span>
            </CtxMenuItem>
            <CtxMenuSeparator />
          </>
        )}
        <CtxMenuItem onSelect={() => onClose(tab.key)}>
          <X size={14} aria-hidden="true" />
          <span className="name">Close</span>
        </CtxMenuItem>
        <CtxMenuItem onSelect={onCloseAll}>
          <XCircle size={14} aria-hidden="true" />
          <span className="name">Close all</span>
        </CtxMenuItem>
      </CtxMenuContent>
    </CtxMenu>
  )
}

/** The "+": a new session, or a new terminal, here, or in a project folder. */
function NewTabMenu({ onNew, onNewTerminal, terminalCwd }: Pick<Props, 'onNew' | 'onNewTerminal' | 'terminalCwd'>) {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    if (!open) return
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [open])

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button type="button" className="add labelled" title="New tab — chat or terminal">
          <Plus size={14} aria-hidden="true" />
          <span>New</span>
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="wide">
        <MenuItem onSelect={onNew}>
          <MessageSquare size={14} aria-hidden="true" />
          <span className="text">
            <span className="name">New chat</span>
            <span className="desc">Pick the project in the composer</span>
          </span>
          <span className="val">n</span>
        </MenuItem>
        <MenuItem onSelect={() => onNewTerminal(terminalCwd)}>
          <Terminal size={14} aria-hidden="true" />
          <span className="text">
            <span className="name">New terminal</span>
            {/* No folder in view: the server opens it in the default project. */}
            <span className="desc">{homely(terminalCwd ?? defaultProjectOf(projects)?.path ?? '~')}</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger className="nav">
            <Folder size={14} aria-hidden="true" />
            <span className="name">Terminal in…</span>
            <ChevronRight size={14} aria-hidden="true" />
          </MenuSubTrigger>
          <MenuSubContent className="wide">
            {projects.map((p) => (
              <MenuItem key={p.id} onSelect={() => onNewTerminal(p.path)}>
                <Folder size={14} aria-hidden="true" />
                <span className="text">
                  <span className="name">{p.name}</span>
                  <span className="desc">{homely(p.path)}</span>
                </span>
              </MenuItem>
            ))}
            {projects.length > 0 && <MenuSeparator />}
            <MenuItem onSelect={() => onNewTerminal('~')}>
              <Home size={14} aria-hidden="true" />
              Home folder
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
      </MenuContent>
    </Menu>
  )
}
