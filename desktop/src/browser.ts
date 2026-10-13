/**
 * The browser pane's host (.docs/browser.md). Each triage session gets its own
 * tab — a WebContentsView in its own partition, no preload, sandboxed — shown
 * in whichever window's pane is on that session, else parked in a hidden
 * window where it keeps rendering, so the agent can screenshot it while you
 * look at something else.
 *
 * The agent never talks to this file directly: the daemon dials in nothing,
 * we dial it (`/browser-host`) and run the verbs it sends, each scoped to one
 * session's tab. The debugger is only ever attached to tabs, never to a
 * triage window.
 */
import { BrowserWindow, ipcMain, session as electronSession, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { PORT } from './daemon.js'

// ── the wire (a copy of core/browser/wire.ts — desktop can't import outside src/) ──

const WIRE_VERSION = 1
type Viewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
type ColorScheme = 'dark' | 'light' | null
type HostVerb =
  | { verb: 'open'; url: string; wait: 'load' | 'idle' }
  | { verb: 'cdp'; method: string; params?: Record<string, unknown> }
  | { verb: 'viewport'; viewport: Viewport | null; colorScheme?: ColorScheme }
  | { verb: 'flash'; backendNodeId: number }
  | { verb: 'state' }
  | { verb: 'close' }
type CallFrame = { type: 'call'; id: number; sessionId: string } & HostVerb
type PageLog = { level: 'error' | 'warning' | 'info'; source: 'console' | 'exception' | 'network'; text: string; url?: string; at: number }

const PARTITION = 'persist:triage-browser'
const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
const PRESETS: Record<string, Viewport | null> = {
  fit: null,
  desktop: DEFAULT_VIEWPORT,
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
}
const MAX_TABS = 8
const IDLE_CLOSE_MS = 15 * 60_000
/** Input within this long of an agent call is the agent's, not yours. */
const AGENT_QUIET_MS = 1500
const FLASH_MS = 700

/** What the web UI's pane shows for one session's tab. */
export type PaneState = {
  sessionId: string
  exists: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: Viewport | null
  colorScheme: ColorScheme
  /** an agent call is running on this tab right now */
  agentBusy: boolean
  picking: boolean
}

type Pane = { win: BrowserWindow; sessionId: string | null; rect: Rectangle | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Tab {
  readonly view: WebContentsView
  viewport: Viewport | null = DEFAULT_VIEWPORT
  colorScheme: ColorScheme = null
  /** the pane's zoom: agent coordinates (CSS px) × scale = view px */
  scale = 1
  inflight = 0
  lastAgentAt = 0
  lastUsed = Date.now()
  picking = false
  private requests = new Map<string, { method: string; url: string }>()
  private lastTouchSent = 0

  constructor(
    readonly sessionId: string,
    private readonly host: BrowserHost,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // no preload: a page can never reach window.triageDesktop
      },
    })
    this.view.setBackgroundColor('#ffffff')
    const wc = this.view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      // target=_blank stays in this tab: one session, one page
      if (/^https?:|^file:/.test(url)) void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    const navigated = (url: string) => {
      // the blank page every tab starts on is ours, not a navigation anyone made
      if (url === 'about:blank') return
      this.host.send({ type: 'navigated', sessionId, url, byUser: !this.agentRecently() })
      this.host.pushState(this)
    }
    wc.on('did-navigate', (_e, url) => navigated(url))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) navigated(url)
    })
    wc.on('page-title-updated', () => this.host.pushState(this))
    wc.on('did-start-loading', () => this.host.pushState(this))
    wc.on('did-stop-loading', () => this.host.pushState(this))
    wc.on('before-input-event', () => {
      if (this.agentRecently() || Date.now() - this.lastTouchSent < 2000) return
      this.lastTouchSent = Date.now()
      this.host.send({ type: 'touched', sessionId })
    })
    wc.on('render-process-gone', (_e, d) => this.log({ level: 'error', source: 'exception', text: `the page crashed (${d.reason})` }))
  }

  /**
   * Attach the debugger. Only after a first load: a view that has never
   * navigated has no target, the domains fail to enable, and Electron then
   * crashes on the next command.
   */
  async init() {
    const wc = this.wc
    await wc.loadURL('about:blank').catch(() => {})
    const dbg = wc.debugger
    dbg.attach('1.3')
    dbg.on('message', (_e, method, params) => this.onCdp(method, params as Record<string, unknown>))
    for (const domain of ['Runtime', 'Log', 'Network', 'Page', 'DOM', 'Overlay']) await dbg.sendCommand(`${domain}.enable`).catch(() => {})
    await this.applyColorScheme()
  }

  get wc() {
    return this.view.webContents
  }

  agentRecently() {
    return this.inflight > 0 || Date.now() - this.lastAgentAt < AGENT_QUIET_MS
  }

  cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.wc.debugger.sendCommand(method, params) as Promise<T>
  }

  private log(l: Omit<PageLog, 'at'>) {
    this.host.send({ type: 'log', sessionId: this.sessionId, log: { ...l, at: Date.now() } })
  }

  private onCdp(method: string, p: Record<string, unknown>) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const type = String(p.type)
        const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type === 'log' || type === 'info' ? 'info' : null
        if (!level) return
        const args = (p.args as { value?: unknown; description?: string; type?: string }[]) ?? []
        const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(' ')
        // Electron's own dev-build nag about the page's CSP — not the page's problem
        if (text.startsWith('%cElectron Security Warning')) return
        const frame = (p.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined)?.callFrames?.[0]
        this.log({ level, source: 'console', text, ...(frame?.url ? { url: `${frame.url}:${(frame.lineNumber ?? 0) + 1}` } : {}) })
        return
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } }
        this.log({ level: 'error', source: 'exception', text: d.exception?.description ?? d.text ?? 'uncaught exception', ...(d.url ? { url: `${d.url}:${(d.lineNumber ?? 0) + 1}` } : {}) })
        return
      }
      case 'Log.entryAdded': {
        const e = p.entry as { level: string; source: string; text: string; url?: string }
        // network failures arrive from the Network domain with their status
        if (e.source === 'network' || (e.level !== 'error' && e.level !== 'warning')) return
        this.log({ level: e.level as 'error' | 'warning', source: 'console', text: e.text, ...(e.url ? { url: e.url } : {}) })
        return
      }
      case 'Network.requestWillBeSent': {
        const r = p.request as { method: string; url: string }
        this.requests.set(String(p.requestId), { method: r.method, url: r.url })
        return
      }
      case 'Network.responseReceived': {
        const r = p.response as { status: number; url: string; statusText?: string }
        if (r.status >= 400) {
          const req = this.requests.get(String(p.requestId))
          this.log({ level: 'error', source: 'network', text: `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''} — ${req?.method ?? 'GET'}`, url: r.url })
        }
        return
      }
      case 'Network.loadingFinished':
        this.requests.delete(String(p.requestId))
        return
      case 'Network.loadingFailed': {
        const req = this.requests.get(String(p.requestId))
        this.requests.delete(String(p.requestId))
        const err = String(p.errorText ?? '')
        if (p.canceled || err === 'net::ERR_ABORTED') return
        this.log({ level: 'error', source: 'network', text: `${err} — ${req?.method ?? 'GET'}`, ...(req ? { url: req.url } : {}) })
        return
      }
      case 'Overlay.inspectNodeRequested':
        this.host.picked(this, Number(p.backendNodeId))
        return
    }
  }

  /** Resolve once no request has been in flight for `quietMs`, or after `maxMs`. */
  async networkIdle(quietMs = 500, maxMs = 6000) {
    const until = Date.now() + maxMs
    let quietSince = this.requests.size === 0 ? Date.now() : 0
    while (Date.now() < until) {
      await sleep(100)
      if (this.requests.size > 0) quietSince = 0
      else if (!quietSince) quietSince = Date.now()
      else if (Date.now() - quietSince >= quietMs) return
    }
  }

  async applyColorScheme() {
    await this.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: this.colorScheme ?? '' }] }).catch(() => {})
  }

  /** Lay the tab out in `rect` (a pane) or at its own size (parked). */
  async layout(rect: Rectangle | null) {
    const vp = this.viewport
    if (!vp) {
      const r = rect ?? { x: 0, y: 0, width: 1280, height: 800 }
      this.view.setBounds(r)
      this.scale = 1
      await this.cdp('Emulation.clearDeviceMetricsOverride').catch(() => {})
      await this.cdp('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
      return
    }
    let bounds: Rectangle
    if (rect) {
      const s = Math.min(1, rect.width / vp.width, rect.height / vp.height)
      const w = Math.max(1, Math.floor(vp.width * s))
      const h = Math.max(1, Math.floor(vp.height * s))
      bounds = { x: Math.round(rect.x + (rect.width - w) / 2), y: rect.y, width: w, height: h }
      this.scale = s
    } else {
      bounds = { x: 0, y: 0, width: vp.width, height: vp.height }
      this.scale = 1
    }
    this.view.setBounds(bounds)
    await this.cdp('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.mobile,
      scale: this.scale,
      screenWidth: vp.width,
      screenHeight: vp.height,
    }).catch(() => {})
    await this.cdp('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, ...(vp.mobile ? { maxTouchPoints: 5 } : {}) }).catch(() => {})
  }

  state(): PaneState {
    const wc = this.wc
    return {
      sessionId: this.sessionId,
      exists: true,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      viewport: this.viewport,
      colorScheme: this.colorScheme,
      agentBusy: this.inflight > 0,
      picking: this.picking,
    }
  }

  destroy() {
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      // already gone
    }
    this.wc.close()
  }
}

export class BrowserHost {
  private readonly tabs = new Map<string, Tab>()
  /** the last URL of tabs closed for being idle, so the next call reopens them where they were */
  private readonly revive = new Map<string, string>()
  private readonly panes = new Map<number, Pane>()
  private park: BrowserWindow | null = null
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private readonly pickWaiters = new Map<string, (uid: number | null) => void>()
  /** tabs being made: two calls for a new session must not make two */
  private readonly creating = new Map<string, Promise<Tab>>()
  private sessionConfigured = false

  constructor(private readonly version: string) {}

  start() {
    this.connect()
    this.registerIpc()
    setInterval(() => this.closeIdle(), 60_000)
  }

  // ── the daemon link ──────────────────────────────────────────────────────

  private connect() {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/browser-host`)
    } catch {
      this.retry = setTimeout(() => this.connect(), 3000)
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: WIRE_VERSION, app: `Triage.app ${this.version}` }))
    })
    ws.addEventListener('message', (ev) => {
      let f: CallFrame
      try {
        f = JSON.parse(String(ev.data)) as CallFrame
      } catch {
        return
      }
      if (f?.type === 'call' && typeof f.id === 'number' && typeof f.sessionId === 'string') void this.handle(f)
    })
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      // the daemon restarts, or isn't up yet: keep trying, quietly
      if (!this.retry) this.retry = setTimeout(() => this.connect(), 2000)
    })
    ws.addEventListener('error', () => {
      // close follows
    })
  }

  send(frame: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  private async handle(f: CallFrame) {
    const reply = (ok: boolean, payload: unknown) =>
      this.send(ok ? { type: 'result', id: f.id, ok: true, result: payload ?? null } : { type: 'result', id: f.id, ok: false, error: String(payload) })
    const existing = this.tabs.get(f.sessionId)
    // Reading the state of a tab that isn't there shouldn't make one.
    if (f.verb === 'state' && !existing && !this.revive.has(f.sessionId)) {
      reply(true, { exists: false, url: '', title: '', loading: false, viewport: null, colorScheme: null })
      return
    }
    if (f.verb === 'close') {
      this.closeTab(f.sessionId)
      reply(true, null)
      return
    }
    let tab: Tab
    try {
      tab = await this.tabFor(f.sessionId)
    } catch (err) {
      reply(false, err instanceof Error ? err.message : String(err))
      return
    }
    tab.inflight += 1
    tab.lastUsed = Date.now()
    this.pushState(tab)
    try {
      reply(true, await this.run(tab, f))
    } catch (err) {
      reply(false, err instanceof Error ? err.message : String(err))
    } finally {
      tab.inflight -= 1
      tab.lastAgentAt = Date.now()
      this.pushState(tab)
    }
  }

  private async run(tab: Tab, f: CallFrame): Promise<unknown> {
    switch (f.verb) {
      case 'open': {
        this.activity(tab.sessionId)
        let status: number | null = null
        const onNav = (_e: unknown, _url: string, code: number) => (status = code)
        tab.wc.on('did-navigate', onNav)
        try {
          await tab.wc.loadURL(f.url)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // ERR_ABORTED: superseded by a redirect or an in-page move — the page did load
          if (!/ERR_ABORTED/.test(msg)) return { url: f.url, title: '', status, error: msg.match(/ERR_[A-Z_]+/)?.[0] ?? msg }
        } finally {
          tab.wc.off('did-navigate', onNav)
        }
        if (f.wait === 'idle') await tab.networkIdle()
        return { url: tab.wc.getURL(), title: tab.wc.getTitle(), status }
      }
      case 'cdp': {
        let params = f.params
        // The agent speaks CSS pixels; the pane may show the page zoomed out.
        if (f.method === 'Input.dispatchMouseEvent' && params && tab.scale !== 1) {
          params = { ...params, x: Number(params.x) * tab.scale, y: Number(params.y) * tab.scale }
        }
        if (f.method === 'Page.captureScreenshot') return this.capture(tab, params)
        return tab.cdp(f.method, params)
      }
      case 'viewport': {
        tab.viewport = f.viewport
        if (f.colorScheme !== undefined) {
          tab.colorScheme = f.colorScheme
          await tab.applyColorScheme()
        }
        await tab.layout(this.paneOf(tab)?.rect ?? null)
        return null
      }
      case 'flash': {
        const color = { r: 255, g: 196, b: 0 }
        await tab
          .cdp('Overlay.highlightNode', {
            backendNodeId: f.backendNodeId,
            highlightConfig: { borderColor: { ...color, a: 1 }, contentColor: { ...color, a: 0.18 }, showInfo: false },
          })
          .catch(() => {})
        setTimeout(() => void tab.cdp('Overlay.hideHighlight').catch(() => {}), FLASH_MS)
        return null
      }
      case 'state': {
        const s = tab.state()
        return { exists: true, url: s.url, title: s.title, loading: s.loading, viewport: s.viewport, colorScheme: s.colorScheme }
      }
    }
    return null
  }

  /**
   * A screenshot that can't hang: a view in a minimized or hidden window stops
   * producing frames, so on a timeout the tab moves to the parking window
   * (which always paints) and tries once more.
   */
  private async capture(tab: Tab, params?: Record<string, unknown>) {
    const attempt = () =>
      Promise.race([tab.cdp('Page.captureScreenshot', params), sleep(4000).then(() => null)]) as Promise<Record<string, unknown> | null>
    const first = await attempt()
    if (first) return first
    const pane = this.paneOf(tab)
    await this.parkTab(tab)
    await sleep(150)
    const second = await attempt()
    if (pane && !pane.win.isMinimized() && pane.win.isVisible()) await this.show(pane, tab)
    if (!second) throw new Error('the page did not produce a screenshot (is it still loading?)')
    return second
  }

  // ── tabs ────────────────────────────────────────────────────────────────

  private configureSession() {
    if (this.sessionConfigured) return
    this.sessionConfigured = true
    const ses = electronSession.fromPartition(PARTITION)
    // no camera, mic, notifications, geolocation… a page under test asks, it hears no
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (e) => e.preventDefault())
  }

  private tabFor(sessionId: string): Promise<Tab> {
    const have = this.tabs.get(sessionId)
    if (have) return Promise.resolve(have)
    let p = this.creating.get(sessionId)
    if (!p) {
      p = this.createTab(sessionId).finally(() => this.creating.delete(sessionId))
      this.creating.set(sessionId, p)
    }
    return p
  }

  private async createTab(sessionId: string): Promise<Tab> {
    if (!/^[\w-]{1,80}$/.test(sessionId)) throw new Error('bad session id')
    this.configureSession()
    if (this.tabs.size >= MAX_TABS) {
      const shown = new Set([...this.panes.values()].map((p) => p.sessionId))
      const lru = [...this.tabs.values()].filter((t) => !shown.has(t.sessionId)).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (lru) this.closeTab(lru.sessionId, true)
    }
    const tab = new Tab(sessionId, this)
    await tab.init()
    this.tabs.set(sessionId, tab)
    const pane = [...this.panes.values()].find((p) => p.sessionId === sessionId)
    if (pane?.rect) await this.show(pane, tab)
    else await this.parkTab(tab)
    const back = this.revive.get(sessionId)
    if (back) {
      this.revive.delete(sessionId)
      await tab.wc.loadURL(back).catch(() => {})
    }
    return tab
  }

  private closeTab(sessionId: string, remember = false) {
    const tab = this.tabs.get(sessionId)
    if (!tab) return
    if (remember) {
      const url = tab.wc.getURL()
      if (url) this.revive.set(sessionId, url)
    } else this.revive.delete(sessionId)
    this.tabs.delete(sessionId)
    this.detach(tab)
    tab.destroy()
    this.send({ type: 'closed', sessionId })
    this.broadcast({ sessionId, exists: false } as PaneState)
  }

  private closeIdle() {
    const shown = new Set([...this.panes.values()].map((p) => p.sessionId))
    for (const t of [...this.tabs.values()]) {
      if (!shown.has(t.sessionId) && t.inflight === 0 && Date.now() - t.lastUsed > IDLE_CLOSE_MS) this.closeTab(t.sessionId, true)
    }
  }

  private parkWindow(): BrowserWindow {
    if (this.park && !this.park.isDestroyed()) return this.park
    this.park = new BrowserWindow({
      width: 1600,
      height: 1400,
      show: false,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      webPreferences: { backgroundThrottling: false },
    })
    return this.park
  }

  private detach(tab: Tab) {
    for (const w of [...BrowserWindow.getAllWindows()]) {
      if (w.isDestroyed()) continue
      if (w.contentView.children.includes(tab.view)) w.contentView.removeChildView(tab.view)
    }
  }

  private async parkTab(tab: Tab) {
    const park = this.parkWindow()
    if (!park.contentView.children.includes(tab.view)) {
      this.detach(tab)
      park.contentView.addChildView(tab.view)
    }
    await tab.layout(null)
  }

  private async show(pane: Pane, tab: Tab) {
    if (!pane.rect || pane.win.isDestroyed()) return
    if (!pane.win.contentView.children.includes(tab.view)) {
      this.detach(tab)
      pane.win.contentView.addChildView(tab.view)
    }
    await tab.layout(pane.rect)
  }

  private paneOf(tab: Tab): Pane | undefined {
    return [...this.panes.values()].find((p) => p.sessionId === tab.sessionId && p.rect && !p.win.isDestroyed())
  }

  // ── the pane (web UI ⇄ main) ──────────────────────────────────────────────

  /** Push one tab's state to every window; each pane filters by its session. */
  pushState(tab: Tab) {
    if (!this.tabs.has(tab.sessionId)) return
    this.broadcast(tab.state())
  }

  private broadcast(s: PaneState) {
    for (const p of this.panes.values()) if (!p.win.isDestroyed()) p.win.webContents.send('browser:state', s)
  }

  /** The agent opened a page: a pane on that session opens itself. */
  private activity(sessionId: string) {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w !== this.park) w.webContents.send('browser:activity', { sessionId })
  }

  picked(tab: Tab, backendNodeId: number) {
    const done = this.pickWaiters.get(tab.sessionId)
    if (!done) return
    this.pickWaiters.delete(tab.sessionId)
    tab.picking = false
    void tab.cdp('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {})
    this.pushState(tab)
    done(backendNodeId)
  }

  private cancelPick(sessionId: string) {
    const tab = this.tabs.get(sessionId)
    const done = this.pickWaiters.get(sessionId)
    this.pickWaiters.delete(sessionId)
    if (tab) {
      tab.picking = false
      void tab.cdp('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {})
      this.pushState(tab)
    }
    done?.(null)
  }

  /** A window closed or hid: its pane's tab goes back to the parking window. */
  watchWindow(win: BrowserWindow) {
    const parkShown = () => {
      const p = this.panes.get(win.webContents.id)
      const tab = p?.sessionId ? this.tabs.get(p.sessionId) : undefined
      if (tab) void this.parkTab(tab)
    }
    const reshow = () => {
      const p = this.panes.get(win.webContents.id)
      const tab = p?.sessionId ? this.tabs.get(p.sessionId) : undefined
      if (p && tab && p.rect) void this.show(p, tab)
    }
    win.on('minimize', parkShown)
    win.on('hide', parkShown)
    win.on('restore', reshow)
    win.on('show', reshow)
    const id = win.webContents.id
    win.on('closed', () => {
      const p = this.panes.get(id)
      this.panes.delete(id)
      const tab = p?.sessionId ? this.tabs.get(p.sessionId) : undefined
      if (tab) void this.parkTab(tab)
    })
    // a reload of the triage UI drops its pane until it reports again
    win.webContents.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return
      parkShown()
      const p = this.panes.get(id)
      if (p) p.rect = null
    })
  }

  private windowOf(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w && w !== this.park ? w : null
  }

  private registerIpc() {
    // The pane says where it is (CSS px in the window) and which session it shows; null rect = hidden.
    ipcMain.on('browser:pane', (e, msg: { sessionId: string | null; rect: Rectangle | null }) => {
      const win = this.windowOf(e)
      if (!win) return
      const zoom = win.webContents.getZoomFactor() || 1
      const rect = msg.rect
        ? { x: Math.round(msg.rect.x * zoom), y: Math.round(msg.rect.y * zoom), width: Math.max(1, Math.round(msg.rect.width * zoom)), height: Math.max(1, Math.round(msg.rect.height * zoom)) }
        : null
      const id = win.webContents.id
      const prev = this.panes.get(id)
      const pane: Pane = { win, sessionId: msg.sessionId, rect }
      this.panes.set(id, pane)
      if (prev?.sessionId && prev.sessionId !== msg.sessionId) {
        const old = this.tabs.get(prev.sessionId)
        if (old && !this.paneOf(old)) void this.parkTab(old)
      }
      const tab = msg.sessionId ? this.tabs.get(msg.sessionId) : undefined
      if (!tab) {
        if (msg.sessionId) win.webContents.send('browser:state', { sessionId: msg.sessionId, exists: false } as PaneState)
        return
      }
      // the same session shown in another window: this one takes it
      for (const [otherId, p] of this.panes) if (otherId !== id && p.sessionId === tab.sessionId) p.rect = null
      if (rect && !win.isMinimized() && win.isVisible()) void this.show(pane, tab)
      else void this.parkTab(tab)
      win.webContents.send('browser:state', tab.state())
    })
    ipcMain.handle('browser:navigate', async (_e, msg: { sessionId: string; url: string }) => {
      const tab = await this.tabFor(msg.sessionId)
      tab.lastUsed = Date.now()
      await tab.wc.loadURL(msg.url).catch(() => {})
      return tab.state()
    })
    ipcMain.on('browser:nav', (_e, msg: { sessionId: string; action: 'back' | 'forward' | 'reload' | 'stop' }) => {
      const tab = this.tabs.get(msg.sessionId)
      if (!tab) return
      const h = tab.wc.navigationHistory
      if (msg.action === 'back' && h.canGoBack()) h.goBack()
      else if (msg.action === 'forward' && h.canGoForward()) h.goForward()
      else if (msg.action === 'reload') tab.wc.reload()
      else if (msg.action === 'stop') tab.wc.stop()
    })
    ipcMain.handle('browser:viewport', async (_e, msg: { sessionId: string; preset: string; colorScheme?: ColorScheme }) => {
      const tab = this.tabs.get(msg.sessionId)
      if (!tab) return null
      if (msg.preset in PRESETS) tab.viewport = PRESETS[msg.preset]
      if (msg.colorScheme !== undefined) {
        tab.colorScheme = msg.colorScheme
        await tab.applyColorScheme()
      }
      await tab.layout(this.paneOf(tab)?.rect ?? null)
      this.pushState(tab)
      return tab.state()
    })
    ipcMain.handle('browser:state', (_e, msg: { sessionId: string }) => this.tabs.get(msg.sessionId)?.state() ?? { sessionId: msg.sessionId, exists: false })
    ipcMain.handle('browser:pick', async (_e, msg: { sessionId: string }) => {
      const tab = this.tabs.get(msg.sessionId)
      if (!tab) return null
      this.cancelPick(msg.sessionId)
      tab.picking = true
      this.pushState(tab)
      tab.wc.focus()
      await tab.cdp('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 111, g: 168, b: 220, a: 0.35 },
          paddingColor: { r: 147, g: 196, b: 125, a: 0.35 },
          borderColor: { r: 255, g: 196, b: 0, a: 1 },
        },
      })
      return new Promise<number | null>((resolve) => {
        this.pickWaiters.set(msg.sessionId, resolve)
        setTimeout(() => {
          if (this.pickWaiters.get(msg.sessionId) === resolve) this.cancelPick(msg.sessionId)
        }, 120_000)
      })
    })
    ipcMain.on('browser:pick-cancel', (_e, msg: { sessionId: string }) => this.cancelPick(msg.sessionId))
    ipcMain.on('browser:devtools', (_e, msg: { sessionId: string }) => {
      this.tabs.get(msg.sessionId)?.wc.openDevTools({ mode: 'detach' })
    })
  }
}
