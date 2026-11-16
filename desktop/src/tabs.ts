/**
 * Workspace tabs in Junior.app (.docs/workspace-tabs/topbar-variations.html, B).
 *
 * Each open workspace is a `WebContentsView` at `/w/<id>/` with the usual
 * preload, laid over its window; the window's own page only ever shows the
 * splash, under the views. Switching tabs shows another view: nothing
 * reloads, and each view keeps its own socket. Every view draws the whole bar,
 * tabs included, from the list this pushes (`tabs:state`); clicks come back as
 * IPC. The rules (one tab per workspace, last tab closes the window, sleeping)
 * are tabs-model.ts; this owns the views.
 *
 * Tabs never read or write the `junior_ws` cookie: a view is bound by its URL.
 */
import { BrowserWindow, ipcMain, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { TabsModel, type SavedWindow, type TabsState } from './tabs-model.js'

/** A background tab gives up its view after this long out of sight. */
const SLEEP_AFTER_MS = 30 * 60_000
/** How often every workspace's needs-you count is read. */
const COUNTS_EVERY_MS = 15_000
/** A view still loading shows anyway after this long, rather than hide behind the loader for good. */
const LOAD_SHOW_AFTER_MS = 8_000

export type TabsDeps = {
  preload: string
  version: string
  /** the daemon's origin, trailing slash */
  daemonUrl: () => string
  isDaemonUrl: (url: string) => boolean
  openExternal: (url: string) => void
  /** a new Junior window cascaded off `from` (or at its saved place), splash loaded */
  newWindow: (from: BrowserWindow | null) => BrowserWindow
  /** a view's page failed or its renderer died: back to the splash and reconnect */
  reconnect: () => void
  /** a view finished a load: the old-daemon bar fix */
  loaded: (wc: WebContents) => void
  /** where browser panes follow their page (browser.ts) */
  uiChanged: (wc: WebContents) => void
  watchUi: (wc: WebContents) => void
  /** ← → and fullscreen, to one page */
  sendNav: (wc: WebContents, win: BrowserWindow) => void
  /** the window list changed (save it) */
  changed: () => void
  /** the daemon's Hide Workspace Names, read with the counts: the View menu's tick follows it */
  hideNames: (on: boolean) => void
}

/** `/w/<id>/` of a daemon URL, or '' for a bare one. */
export function workspaceOf(raw: string): string {
  try {
    const id = /^\/w\/([^/]+)\/?/.exec(new URL(raw).pathname)?.[1] ?? ''
    return id ? decodeURIComponent(id) : ''
  } catch {
    return ''
  }
}

export class WorkspaceTabsHost {
  readonly model = new TabsModel()
  /** Junior windows by `win.id`, in the order they opened */
  private readonly wins = new Map<number, BrowserWindow>()
  /** the awake views, by workspace id */
  private readonly views = new Map<string, WebContentsView>()
  /** where each workspace's view was last, so a reload or a wake lands back there */
  private readonly urls = new Map<string, string>()
  /** a view's page → its workspace */
  private readonly wsOf = new Map<number, string>()
  private counts: Record<string, number> = {}
  /**
   * Views (by page id) mid-load. They stay hidden until their page has drawn,
   * so a fresh tab shows the window's own loader (blank.html), not a black view.
   */
  private readonly loading = new Set<number>()
  /** the daemon answers: views load. False while the splash is up. */
  private ready = false
  private countsSoon: NodeJS.Timeout | undefined

  constructor(private readonly deps: TabsDeps) {}

  start() {
    const winOf = (e: IpcMainEvent | IpcMainInvokeEvent) => this.windowOfPage(e.sender)
    ipcMain.handle('tabs:state', (e) => {
      const w = winOf(e)
      return w ? this.stateOf(w) : null
    })
    ipcMain.on('tabs:open', (e, msg: { id: string; newWindow?: boolean }) => {
      const w = winOf(e)
      if (w && typeof msg?.id === 'string') this.open(w, msg.id, !!msg.newWindow)
    })
    ipcMain.on('tabs:activate', (e, msg: { id: string }) => {
      const w = winOf(e)
      if (w && typeof msg?.id === 'string') this.activate(w, msg.id)
    })
    ipcMain.on('tabs:switch', (e, msg: { id: string }) => {
      const w = winOf(e)
      if (w && typeof msg?.id === 'string') this.switchTo(w, msg.id)
    })
    ipcMain.on('tabs:close', (e, msg: { id: string }) => {
      const w = winOf(e)
      if (w && typeof msg?.id === 'string') this.close(w, msg.id)
    })
    ipcMain.on('tabs:move', (e, msg: { id: string; to: 'new' | 'here'; at?: { x: number; y: number } }) => {
      const w = winOf(e)
      if (!w || typeof msg?.id !== 'string') return
      const at = msg.at && Number.isFinite(msg.at.x) && Number.isFinite(msg.at.y) ? msg.at : undefined
      if (msg.to === 'here') this.moveTo(msg.id, w)
      else if (msg.to === 'new') this.moveToNewWindow(msg.id, at)
    })
    ipcMain.on('tabs:count', () => {
      clearTimeout(this.countsSoon)
      this.countsSoon = setTimeout(() => void this.readCounts(), 400)
    })
    setInterval(() => void this.readCounts(), COUNTS_EVERY_MS)
    setInterval(() => this.sleep(), 60_000)
  }

  // windows

  /** A new Junior window joins, with these tabs (none: it gets the default workspace once the daemon answers). */
  attach(win: BrowserWindow, ids: string[] = [], active = '') {
    this.wins.set(win.id, win)
    this.model.addWindow(win.id, ids, active, Date.now())
    const relayout = () => this.layout(win)
    win.on('resize', relayout)
    win.on('enter-full-screen', () => this.eachView(win, (v) => this.deps.sendNav(v.webContents, win)))
    win.on('leave-full-screen', () => this.eachView(win, (v) => this.deps.sendNav(v.webContents, win)))
    win.on('focus', () => this.frontView(win)?.webContents.focus())
    win.on('closed', () => {
      const rec = this.model.windows.get(win.id)
      for (const t of rec?.tabs ?? []) this.drop(t.id)
      this.model.removeWindow(win.id)
      this.wins.delete(win.id)
      this.pushAll()
      this.deps.changed()
    })
    if (this.ready) void this.wake(win)
    this.pushAll()
    this.deps.changed()
  }

  windows(): BrowserWindow[] {
    return [...this.wins.values()].filter((w) => !w.isDestroyed())
  }

  /** The window a Junior page is in: a tab's view, or the window's own page. */
  windowOfPage(wc: WebContents): BrowserWindow | null {
    const ws = this.wsOf.get(wc.id)
    if (ws) {
      const at = this.model.find(ws)
      const w = at ? this.wins.get(at.winId) : undefined
      return w && !w.isDestroyed() ? w : null
    }
    const own = BrowserWindow.fromWebContents(wc)
    return own && this.wins.has(own.id) ? own : null
  }

  /** The page is the tab in front of its window. */
  isFront(wc: WebContents): boolean {
    const ws = this.wsOf.get(wc.id)
    if (!ws) return true
    const at = this.model.find(ws)
    return !!at && this.model.windows.get(at.winId)?.active === ws
  }

  pages(): WebContents[] {
    return [...this.views.values()].map((v) => v.webContents).filter((wc) => !wc.isDestroyed())
  }

  /** The front tab's page in a window, if it is awake. */
  frontView(win: BrowserWindow): WebContentsView | null {
    const active = this.model.windows.get(win.id)?.active
    return (active && this.views.get(active)) || null
  }

  /** The workspace in front of a window ('' = none yet). */
  frontWorkspace(win: BrowserWindow): string {
    return this.model.windows.get(win.id)?.active ?? ''
  }

  // the daemon coming and going

  /** The splash goes up: every view hides so the window's own page shows it. */
  hideAll() {
    this.ready = false
    for (const v of this.views.values()) v.setVisible(false)
  }

  /**
   * The daemon answers: windows without a tab get the default workspace, every
   * awake view loads where it was, and each window shows its front tab.
   */
  async connected() {
    const empty = this.windows().filter((w) => !this.model.windows.get(w.id)?.tabs.length)
    if (empty.length) {
      // One workspace, one tab: only the first empty window can take the default; the rest close.
      const fallback = (await this.defaultWorkspace()) || ''
      const [first, ...rest] = empty
      if (fallback && !this.model.find(fallback)) this.model.open(first.id, fallback, Date.now())
      else rest.unshift(first)
      for (const w of rest) if (this.windows().length > 1) w.close()
    }
    this.ready = true
    await Promise.all(this.windows().map((w) => this.wake(w)))
    void this.readCounts()
    this.deps.changed()
  }

  private async defaultWorkspace(): Promise<string> {
    try {
      const r = (await (await fetch(new URL('api/workspaces', this.deps.daemonUrl()))).json()) as { ok: boolean; defaultId?: string }
      return r.ok && r.defaultId ? r.defaultId : ''
    } catch {
      return ''
    }
  }

  /** Every tab in a window that should hold a view gets one, loaded; then the front one shows. */
  private async wake(win: BrowserWindow) {
    const rec = this.model.windows.get(win.id)
    if (!rec) return
    const loads: Promise<void>[] = []
    for (const t of rec.tabs) {
      if (t.asleep && t.id !== rec.active) continue
      loads.push(this.ensureView(win, t.id, true))
    }
    this.show(win)
    await Promise.all(loads)
  }

  // tabs

  open(from: BrowserWindow, id: string, newWindow = false) {
    if (newWindow && !this.model.find(id)) {
      const w = this.deps.newWindow(from)
      this.attach(w, [id], id)
      return
    }
    const { winId, added } = this.model.open(from.id, id, Date.now())
    const win = this.wins.get(winId)
    if (!win) return
    if (added && this.ready) void this.ensureView(win, id)
    this.show(win)
    if (winId !== from.id) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    this.pushAll()
    this.deps.changed()
  }

  activate(win: BrowserWindow, id: string) {
    if (!this.model.activate(win.id, id, Date.now())) return
    if (this.ready && !this.views.has(id)) void this.ensureView(win, id)
    this.show(win)
    this.pushAll()
    this.deps.changed()
  }

  /**
   * The front tab's "Switch to": this tab shows another workspace in its
   * place, and the one it showed closes (its jobs keep running). One open
   * already, here or in another window, is gone to instead.
   */
  switchTo(win: BrowserWindow, id: string) {
    const from = this.frontWorkspace(win)
    if (!from || from === id) return
    if (!this.model.swap(win.id, from, id, Date.now())) {
      this.open(win, id)
      return
    }
    this.drop(from)
    if (this.ready) void this.ensureView(win, id)
    this.show(win)
    this.pushAll()
    this.deps.changed()
  }

  /** ⌘⇧W: close the front workspace tab, or this one. The last tab closes the window. */
  close(win: BrowserWindow, id = this.frontWorkspace(win)) {
    if (!id) return
    const { closeWindow } = this.model.close(win.id, id, Date.now())
    if (closeWindow) {
      win.close()
      return
    }
    this.drop(id)
    this.show(win)
    this.pushAll()
    this.deps.changed()
  }

  /** ⌘⇧N, or a tab dragged off the bar (`point`: where it was let go): a tab out into a window of its own. */
  moveToNewWindow(id: string, point?: { x: number; y: number }) {
    const at = this.model.find(id)
    const from = at ? this.wins.get(at.winId) : undefined
    if (!at || !from) return
    if (this.model.windows.get(at.winId)!.tabs.length === 1) return // already on its own
    const w = this.deps.newWindow(from)
    // the new window's bar under the pointer, about where the tab was held
    if (point) w.setPosition(Math.round(point.x - 380), Math.round(point.y - 22))
    this.attach(w)
    this.moveTo(id, w)
  }

  /** "Bring here", a drop, or Merge all windows: a tab into this window, its view and all (no reload). */
  moveTo(id: string, to: BrowserWindow) {
    const res = this.model.move(id, to.id, Date.now())
    if (!res) return
    const from = this.wins.get(res.from)
    const view = this.views.get(id)
    if (view) {
      from?.contentView.removeChildView(view)
      to.contentView.addChildView(view)
    } else if (this.ready) void this.ensureView(to, id)
    this.layout(to)
    this.show(to)
    to.show()
    to.focus()
    if (from && !from.isDestroyed()) {
      if (res.emptied) from.close()
      else this.show(from)
    }
    this.pushAll()
    this.deps.changed()
  }

  /** Window ▸ Merge all windows: every tab into this one. */
  mergeInto(win: BrowserWindow) {
    for (const [winId, rec] of [...this.model.windows]) {
      if (winId === win.id) continue
      for (const t of [...rec.tabs]) this.moveTo(t.id, win)
    }
  }

  step(win: BrowserWindow, by: 1 | -1) {
    const id = this.model.step(win.id, by)
    if (id) this.activate(win, id)
  }

  nth(win: BrowserWindow, n: number) {
    const id = this.model.nth(win.id, n)
    if (id) this.activate(win, id)
  }

  /** ⌘T: the front tab opens its + menu. */
  openMenu(win: BrowserWindow) {
    this.command(win, 'open-menu')
  }

  /** A shortcut the page in front acts on: ⌘T's menu, ⌘W closing a page tab, ⌘1–9 picking one. */
  command(win: BrowserWindow, c: string) {
    this.frontView(win)?.webContents.send('tabs:command', c)
  }

  save(): SavedWindow[] {
    return this.model.save(this.windows().map((w) => w.id))
  }

  // views

  private async ensureView(win: BrowserWindow, id: string, reload = false) {
    let view = this.views.get(id)
    if (view && !reload) return
    if (!view) {
      view = this.makeView(id)
      win.contentView.addChildView(view)
      this.layout(win)
      view.setVisible(false)
    }
    const url = this.urls.get(id) ?? new URL(`w/${encodeURIComponent(id)}/`, this.deps.daemonUrl()).href
    const wc = view.webContents
    this.loading.add(wc.id)
    this.show(win)
    setTimeout(() => this.loaded(wc), LOAD_SHOW_AFTER_MS)
    try {
      await view.webContents.loadURL(url)
      view.webContents.navigationHistory.clear()
    } catch {
      // did-fail-load sends everything back to the splash
    }
  }

  private makeView(id: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        additionalArguments: [`--junior-version=${this.deps.version}`],
      },
    })
    view.setBackgroundColor('#0c0b0a')
    const wc = view.webContents
    this.views.set(id, view)
    this.wsOf.set(wc.id, id)
    this.deps.watchUi(wc)
    const wsNow = () => this.wsOf.get(wc.id) ?? id
    const winNow = () => this.windowOfPage(wc)
    wc.on('did-stop-loading', () => this.loaded(wc))
    wc.on('did-finish-load', () => {
      const w = winNow()
      if (w) this.deps.sendNav(wc, w)
      this.deps.loaded(wc)
    })
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame && this.deps.isDaemonUrl(navUrl)) this.track(wc, navUrl)
      const w = winNow()
      if (w) this.deps.sendNav(wc, w)
    })
    wc.on('did-navigate', (_e, navUrl) => {
      if (this.deps.isDaemonUrl(navUrl)) this.track(wc, navUrl)
    })
    // The old switcher's full navigation to another workspace (an older UI,
    // or a link) opens that workspace as a tab instead; this one stays put.
    wc.on('will-navigate', (e, navUrl) => {
      if (!this.deps.isDaemonUrl(navUrl)) {
        e.preventDefault()
        this.deps.openExternal(navUrl)
        return
      }
      const to = workspaceOf(navUrl)
      if (to && to !== wsNow()) {
        e.preventDefault()
        const w = winNow()
        if (w) this.open(w, to)
      }
    })
    wc.setWindowOpenHandler(({ url }) => {
      const w = winNow()
      const to = this.deps.isDaemonUrl(url) ? workspaceOf(url) : ''
      if (to && w) this.open(w, to, true)
      else if (!this.deps.isDaemonUrl(url)) this.deps.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('did-fail-load', (_e, code, _desc, failUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded */ || !this.deps.isDaemonUrl(failUrl)) return
      this.deps.reconnect()
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') this.deps.reconnect()
    })
    return view
  }

  /**
   * Where a view is now. The page pins itself to the workspace the daemon
   * resolved, so a workspace that went away shows up here as another id: the
   * tab takes that name, or closes if that workspace has a tab already.
   */
  private track(wc: WebContents, url: string) {
    const was = this.wsOf.get(wc.id)
    if (!was) return
    const now = workspaceOf(url)
    if (now && now !== was) {
      const at = this.model.find(was)
      if (!at) return
      const res = this.model.rename(at.winId, was, now)
      const win = this.wins.get(at.winId)
      if (res === 'duplicate' && win) {
        this.close(win, was)
        return
      }
      if (res === 'renamed') {
        const view = this.views.get(was)!
        this.views.delete(was)
        this.views.set(now, view)
        this.wsOf.set(wc.id, now)
        this.urls.delete(was)
        this.pushAll()
      }
    }
    this.urls.set(now || was, url)
  }

  /** A view's page has loaded (or given up): it can show. */
  private loaded(wc: WebContents) {
    if (!this.loading.delete(wc.id)) return
    const w = this.windowOfPage(wc)
    if (w) this.show(w)
  }

  /** A tab's view goes (closed, asleep, or its window closed). */
  private drop(id: string) {
    const view = this.views.get(id)
    this.views.delete(id)
    if (!view) return
    this.wsOf.delete(view.webContents.id)
    this.loading.delete(view.webContents.id)
    for (const w of this.windows()) if (w.contentView.children.includes(view)) w.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private layout(win: BrowserWindow) {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    this.eachView(win, (v) => v.setBounds({ x: 0, y: 0, width, height }))
  }

  private eachView(win: BrowserWindow, fn: (v: WebContentsView) => void) {
    for (const t of this.model.windows.get(win.id)?.tabs ?? []) {
      const v = this.views.get(t.id)
      if (v) fn(v)
    }
  }

  /** Only the front tab's view shows, once the daemon answers and its page has loaded. Browser panes follow. */
  private show(win: BrowserWindow) {
    const rec = this.model.windows.get(win.id)
    if (!rec || win.isDestroyed()) return
    for (const t of rec.tabs) {
      const v = this.views.get(t.id)
      if (!v) continue
      v.setVisible(this.ready && t.id === rec.active && !this.loading.has(v.webContents.id))
      this.deps.uiChanged(v.webContents)
    }
    const front = this.views.get(rec.active)
    if (front && win.isFocused()) front.webContents.focus()
  }

  /** Background tabs out of sight long enough give up their view; their count stays. */
  private sleep() {
    const due = this.model.sleepers(Date.now(), SLEEP_AFTER_MS)
    for (const { winId, id } of due) {
      const tab = this.model.windows.get(winId)?.tabs.find((t) => t.id === id)
      if (!tab) continue
      tab.asleep = true
      this.drop(id)
    }
    if (due.length) this.pushAll()
  }

  // counts

  /** Every workspace's needs-you count. A workspace that is gone closes its tab. */
  private async readCounts() {
    if (!this.ready) return
    try {
      const r = (await (await fetch(new URL('api/workspaces/needs-you', this.deps.daemonUrl()))).json()) as {
        ok: boolean
        counts?: Record<string, number>
        hideNames?: boolean
      }
      if (!r.ok || !r.counts) return
      if (typeof r.hideNames === 'boolean') this.deps.hideNames(r.hideNames)
      const known = r.counts
      const same = JSON.stringify(known) === JSON.stringify(this.counts)
      this.counts = known
      if (Object.keys(known).length) {
        for (const [winId, rec] of [...this.model.windows]) {
          const win = this.wins.get(winId)
          if (!win) continue
          for (const t of [...rec.tabs]) if (!(t.id in known)) this.close(win, t.id)
        }
      }
      if (!same) this.pushAll()
    } catch {
      // an older daemon has no counts: tabs simply show none
    }
  }

  private stateOf(win: BrowserWindow): TabsState {
    return this.model.stateFor(win.id, this.counts)
  }

  /** Every view in every window redraws its strip. */
  pushAll() {
    for (const w of this.windows()) {
      const s = this.stateOf(w)
      this.eachView(w, (v) => !v.webContents.isDestroyed() && v.webContents.send('tabs:state', s))
    }
  }
}
