import { ArrowLeftRight, ChevronDown, ChevronRight, EyeOff, Eye, Plus, Settings2, SquareArrowOutUpRight, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import type { Workspace } from '../../../shared/protocol.js'
import { desktopTabs, type DesktopTabsCommand, type DesktopTabsState } from '../desktop.js'
import { isHideNamesKey } from '../shortcuts.js'
import { store } from '../store.js'
import { basePath } from '../workspaceUrl.js'
import { MOD_LABEL } from '../keys.js'
import { fitTabs, monograms } from '../tabStrip.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../ui/Menu.js'
import { Tooltip } from '../ui/Tooltip.js'

/** What a dragged workspace tab carries: its workspace id. */
const TAB_MIME = 'application/x-junior-workspace-tab'
/** The bar's height (--bar-h): let go below it and the tab leaves the window. */
const BAR_H = 44

/**
 * Workspace tabs in Junior.app's bar (.docs/workspace-tabs/topbar-variations.html, B).
 * The app hosts one view per tab; this view draws the strip from the window's
 * tab list. A click shows another view, nothing reloads. The tab in front
 * keeps today's chevron menu; another tab shows its orange count, never more.
 * Hide Workspace Names (⌘⇧H) draws every tab as a monogram tile, its name a
 * hover away (.docs/workspace-tabs/private-tabs.html).
 *
 * The browser draws the same strip (useBrowserTabs): every workspace is a tab,
 * a click switches this page to it (a reload), ⌘-click opens a browser tab.
 */
export function WorkspaceTabs({
  state,
  host,
  workspaces,
  onNew,
  onSettings,
  trailing,
}: {
  state: DesktopTabsState
  /** Junior.app's tabs (desktopTabs), or the browser's stand-in */
  host: TabsHost
  workspaces: readonly Workspace[]
  onNew: () => void
  onSettings: () => void
  /** after the + button: the build badge */
  trailing?: ReactNode
}) {
  const t = host
  const inApp = host.kind === 'app'
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  const tabs = state.tabs.filter((tab) => byId.has(tab.id))
  const count = (id: string) => state.counts[id] ?? 0
  const hide = useSyncExternalStore(store.subscribeStructural, store.getHideNames)
  const mono = monograms(workspaces)
  const elsewhereWord = inApp ? 'its own window' : 'a new browser tab'

  // ⌘⇧H: Junior.app's View menu catches it first; the browser has no menu, so the page listens.
  useEffect(() => {
    if (inApp) return
    const onKey = (e: KeyboardEvent) => {
      if (!isHideNamesKey(e)) return
      e.preventDefault()
      store.setHideNames(!store.getHideNames())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inApp])

  // How much room the strip has: the whole zone up to the system icons, less the + and the badge.
  const wrap = useRef<HTMLDivElement>(null)
  const fixed = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(10_000)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth - (fixed.current?.offsetWidth ?? 0) - 8)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [plusOpen, setPlusOpen] = useState(false)
  const [frontOpen, setFrontOpen] = useState(false)
  // Another window's tab dragged over this strip: it would land here.
  const [dropping, setDropping] = useState(false)
  useEffect(() => t.onCommand?.((c) => c === 'open-menu' && setPlusOpen(true)), [t])

  const fit = fitTabs(
    tabs.map((tab) => ({
      id: tab.id,
      lastActive: tab.lastActive,
      count: tab.id === state.active ? 0 : count(tab.id),
    })),
    state.active,
    width,
    hide,
  )
  const open = new Set([...state.tabs.map((tab) => tab.id), ...state.elsewhere.map((e) => e.id)])
  const closed = workspaces.filter((w) => !open.has(w.id))
  const elsewhere = state.elsewhere.map((e) => byId.get(e.id)).filter((w): w is Workspace => !!w)
  // "Switch to": every other workspace. A closed one takes this tab's place; an open one is gone to.
  const switchTo = t.switch
  const others = workspaces.filter((w) => w.id !== state.active)
  const foldedNeeds = fit.folded.some((id) => count(id) > 0)
  // ⌘-click or a middle click: the workspace in its own window, the switcher's rule.
  const wantsWindow = (e: { metaKey: boolean; ctrlKey: boolean; button: number }) => e.metaKey || e.ctrlKey || e.button === 1

  // Drag a tab off the bar: it becomes a window where it was let go. Drop it on
  // another window's strip: it moves there. The view moves with it; nothing reloads.
  const dragProps = (id: string) => ({
    draggable: inApp,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(TAB_MIME, id)
      e.dataTransfer.effectAllowed = 'move'
      setFrontOpen(false)
    },
    onDragEnd: (e: DragEvent<HTMLElement>) => {
      if (e.dataTransfer.dropEffect !== 'none') return // landed on a strip
      const offBar = e.clientY > BAR_H || e.clientY < 0 || e.clientX < 0 || e.clientX > window.innerWidth
      if (offBar) t.move?.(id, 'new', { x: e.screenX, y: e.screenY })
    },
  })
  const ours = (id: string) => state.tabs.some((tab) => tab.id === id)
  // ⌃1–8 go to that tab, ⌃9 to the last (the Window menu's Go to Workspace). The browser has no such keys.
  const keyOf = (id: string) => {
    if (!inApp) return 0
    const i = tabs.findIndex((tab) => tab.id === id)
    return i === tabs.length - 1 && i >= 8 ? 9 : i < 8 ? i + 1 : 0
  }
  // Names hidden: the name lives in the tooltip, never on the bar.
  const named = (w: Workspace, n: number, tab: ReactNode) =>
    hide ? (
      <Tooltip
        side="bottom"
        delay={400}
        className="wsTip"
        content={
          <>
            <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
            <span>{w.name}</span>
            {n > 0 && <span className="wsTipMeta">· {n} need{n === 1 ? 's' : ''} you</span>}
            {keyOf(w.id) > 0 && <kbd className="wsKbd">⌃{keyOf(w.id)}</kbd>}
          </>
        }
      >
        {tab}
      </Tooltip>
    ) : (
      tab
    )
  // Names hidden: a tile in the workspace's colour, its monogram in place of dot and name.
  const face = (w: Workspace) =>
    hide ? (
      <span className="wsMono" aria-hidden="true">
        {mono[w.id]}
      </span>
    ) : (
      <>
        <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
        <span className="wsTabName">{w.name}</span>
      </>
    )

  return (
    <div
      className={`wsTabs${dropping ? ' dropping' : ''}`}
      ref={wrap}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        const id = e.dataTransfer.getData(TAB_MIME)
        if (!id) return
        e.preventDefault()
        if (!ours(id)) t.move?.(id, 'here')
      }}
    >
      <div className={`wsTabRow${fit.short ? ' short' : ''}${hide ? ' mono' : ''}`} role="tablist" aria-label="Workspaces">
        {fit.shown.map((id) => {
          const w = byId.get(id)!
          const n = count(id)
          if (id === state.active)
            return (
              <Menu key={id} open={frontOpen} onOpenChange={setFrontOpen}>
                {/* The tab drags, so it can't be Radix's trigger (that opens on
                    pointer-down, before a drag starts). A click opens the menu;
                    the trigger is an anchor laid over the tab, for placement only. */}
                {named(
                  w,
                  0,
                  <button
                    type="button"
                    role="tab"
                    aria-selected="true"
                    aria-haspopup="menu"
                    aria-expanded={frontOpen}
                    aria-label={hide ? w.name : undefined}
                    className="wsTab on"
                    style={hide ? { ['--ws' as string]: w.color } : undefined}
                    data-state={frontOpen ? 'open' : 'closed'}
                    title={hide ? undefined : `Workspace: ${w.name}`}
                    onClick={() => setFrontOpen(true)}
                    {...dragProps(id)}
                  >
                    <MenuTrigger asChild>
                      <span className="wsTabAnchor" aria-hidden="true" tabIndex={-1} />
                    </MenuTrigger>
                    {face(w)}
                    <ChevronDown size={12} className="wsTabChev" aria-hidden="true" />
                  </button>,
                )}
                <MenuContent align="start" className="wsMenu">
                  <MenuItem onSelect={onSettings}>
                    <Settings2 size={14} aria-hidden="true" />
                    Workspace settings…
                  </MenuItem>
                  {switchTo && others.length > 0 && (
                    <MenuSub>
                      <MenuSubTrigger className="nav">
                        <ArrowLeftRight size={14} aria-hidden="true" />
                        <span className="name">Switch to</span>
                        <ChevronRight size={14} aria-hidden="true" />
                      </MenuSubTrigger>
                      <MenuSubContent className="wsMenu">
                        {others.map((o) => (
                          <WorkspaceRow key={o.id} w={o} n={count(o.id)} onSelect={() => switchTo(o.id)} />
                        ))}
                      </MenuSubContent>
                    </MenuSub>
                  )}
                  <MenuItem onSelect={() => store.setHideNames(!hide)}>
                    {hide ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                    <span className="wsMenuName">{hide ? 'Show workspace names' : 'Hide workspace names'}</span>
                    <kbd className="wsKbd">{MOD_LABEL}⇧H</kbd>
                  </MenuItem>
                  {inApp && tabs.length > 1 && (
                    <MenuItem onSelect={() => t.move?.(id, 'new')}>
                      <SquareArrowOutUpRight size={14} aria-hidden="true" />
                      <span className="wsMenuName">Open in new window</span>
                      <kbd className="wsKbd">{MOD_LABEL}⇧N</kbd>
                    </MenuItem>
                  )}
                  {t.close && (
                    <MenuItem onSelect={() => t.close?.(id)}>
                      <X size={14} aria-hidden="true" />
                      <span className="wsMenuName">{tabs.length > 1 ? 'Close tab' : 'Close window'}</span>
                      <kbd className="wsKbd">{MOD_LABEL}W</kbd>
                    </MenuItem>
                  )}
                  {t.close && <p className="wsMenuNote">Closing hides {w.name}. Its jobs keep running.</p>}
                </MenuContent>
              </Menu>
            )
          return (
            <Fragment key={id}>
              {named(
                w,
                n,
                <button
                  type="button"
                  role="tab"
                  aria-selected="false"
                  aria-label={hide ? w.name : undefined}
                  className="wsTab"
                  style={hide ? { ['--ws' as string]: w.color } : undefined}
                  title={hide ? undefined : `${w.name}${n ? ` — ${n} need${n === 1 ? 's' : ''} you` : ''}\n${MOD_LABEL}-click: ${elsewhereWord}`}
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  onClick={(e) => (wantsWindow(e) && t.move ? t.move(id, 'new') : t.activate(id))}
                  onAuxClick={(e) => e.button === 1 && t.move?.(id, 'new')}
                  {...dragProps(id)}
                >
                  {face(w)}
                  {n > 0 && <span className="wsCount">{n}</span>}
                </button>,
              )}
            </Fragment>
          )
        })}
      </div>
      <div className="wsTabsFixed" ref={fixed}>
        {fit.folded.length > 0 && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="wsMore" title={`${fit.folded.length} more workspaces`}>
                +{fit.folded.length}
                {foldedNeeds && <span className="wsMoreDot" aria-label="needs you" />}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="start" className="wsMenu">
              {fit.folded.map((id) => (
                <WorkspaceRow key={id} w={byId.get(id)!} n={count(id)} onSelect={() => t.activate(id)} />
              ))}
            </MenuContent>
          </Menu>
        )}
        <Menu open={plusOpen} onOpenChange={setPlusOpen}>
          <MenuTrigger asChild>
            <button type="button" className="topIcon" title={`Open a workspace (${MOD_LABEL}T)`} aria-label="Open a workspace">
              <Plus size={15} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="wsMenu wsPlusMenu">
            {closed.length > 0 && <p className="wsMenuHead">Open a workspace</p>}
            {closed.map((w) => (
              <WorkspaceRow
                key={w.id}
                w={w}
                n={count(w.id)}
                onSelect={(inWindow) => {
                  t.open(w.id, { newWindow: inWindow })
                  setPlusOpen(false)
                }}
                newWindow
              />
            ))}
            {elsewhere.length > 0 && <p className="wsMenuHead">In another window</p>}
            {elsewhere.map((w) => (
              <WorkspaceRow key={w.id} w={w} n={count(w.id)} onSelect={() => t.open(w.id)}>
                <span
                  className="wsBring"
                  role="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    t.move?.(w.id, 'here')
                    setPlusOpen(false)
                  }}
                >
                  Bring here
                </span>
              </WorkspaceRow>
            ))}
            {(closed.length > 0 || elsewhere.length > 0) && <MenuSeparator />}
            <MenuItem onSelect={onNew}>
              <Plus size={14} aria-hidden="true" />
              New workspace…
            </MenuItem>
          </MenuContent>
        </Menu>
        {trailing}
      </div>
    </div>
  )
}

/**
 * What the strip asks of whoever hosts the tabs. Junior.app's bridge
 * (desktopTabs) does all of it; the browser's stand-in switches the page and
 * opens browser tabs, and has nothing to close, move in or command.
 */
export type TabsHost = {
  kind: 'app' | 'browser'
  activate: (id: string) => void
  open: (id: string, opts?: { newWindow?: boolean }) => void
  close?: (id: string) => void
  switch?: (id: string) => void
  /** 'new': its own window (the browser: a new browser tab); 'here': into this window */
  move?: (id: string, to: 'new' | 'here', at?: { x: number; y: number }) => void
  onCommand?: (cb: (c: DesktopTabsCommand) => void) => () => void
}

/** Junior.app's bridge, as a host; null outside the app. */
export const appTabsHost: TabsHost | null = desktopTabs ? { kind: 'app', ...desktopTabs } : null

/** How often the browser's strip rereads every workspace's needs-you count (the app's host: 15 s too). */
const COUNTS_EVERY_MS = 15_000

/**
 * The browser's tabs: every workspace, in the registry's order, the page's own
 * in front. A click switches this page (switching is a navigation, so it
 * reloads); ⌘-click or a middle click opens one in a new browser tab.
 */
export function useBrowserTabs(workspaces: readonly Workspace[], workspaceId: string, onSwitch: (id: string) => void): { state: DesktopTabsState; host: TabsHost } {
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const r = (await (await fetch('/api/workspaces/needs-you')).json()) as { ok: boolean; counts?: Record<string, number> }
        if (live && r.ok && r.counts) setCounts(r.counts)
      } catch {
        // the daemon is away: keep the last counts
      }
    }
    void read()
    const timer = setInterval(() => void read(), COUNTS_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  const away = (id: string) => window.open(basePath(id), '_blank', 'noopener')
  return {
    state: { tabs: workspaces.map((w) => ({ id: w.id, lastActive: 0, asleep: false })), active: workspaceId, elsewhere: [], counts },
    host: {
      kind: 'browser',
      activate: onSwitch,
      open: (id, opts) => (opts?.newWindow ? away(id) : onSwitch(id)),
      move: (id, to) => to === 'new' && away(id),
    },
  }
}

/** One workspace in a menu: dot, name, its orange count. `newWindow` adds the ↗ and ⌘-click. */
function WorkspaceRow({
  w,
  n,
  onSelect,
  newWindow,
  children,
}: {
  w: Workspace
  n: number
  onSelect: (inNewWindow: boolean) => void
  newWindow?: boolean
  children?: ReactNode
}) {
  // Radix's onSelect carries no modifier; the pointer-down before it does.
  const mod = useRef(false)
  return (
    <MenuItem
      onPointerDown={(e) => (mod.current = !!newWindow && (e.metaKey || e.ctrlKey || e.button === 1))}
      onSelect={() => {
        onSelect(mod.current)
        mod.current = false
      }}
      title={newWindow ? `${w.name} — ${MOD_LABEL}-click: its own window` : w.name}
    >
      <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
      <span className="wsMenuName">{w.name}</span>
      {n > 0 && <span className="wsCount">{n}</span>}
      {newWindow && (
        <span
          className="wsOpenTab"
          aria-hidden="true"
          title="Open in its own window"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(true)
          }}
        >
          <SquareArrowOutUpRight size={12} aria-hidden="true" />
        </span>
      )}
      {children}
    </MenuItem>
  )
}
