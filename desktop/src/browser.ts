/**
 * The browser pane's host (.docs/browser.md). Each junior session gets its own
 * tab, a WebContentsView in its profile's partition, no preload, sandboxed,
 * shown in whichever window's pane is on that session, else parked in a hidden
 * window where it keeps rendering, so the agent can screenshot it while you
 * look at something else.
 *
 * The agent never talks to this file directly: the daemon dials in nothing,
 * we dial it (`/browser-host`) and run the verbs it sends, each scoped to one
 * session's tab, in the profile the frame names. The daemon decides profiles
 * and remembers tabs; the app never does. The debugger is only ever attached
 * to tabs, never to a junior window or a sign-in window.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  shell,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type ContextMenuParams,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from 'electron'
import path from 'node:path'
import { downloadsDir, Jars, sweepDroppedJars, type JarTab } from './browser-jar.js'
import { openSignInWindow } from './browser-popup.js'
import {
  partitionOf,
  PROFILE_ID_RE,
  TAB_KEY_RE,
  WIRE_VERSION,
  type CallFrame,
  type ColorScheme,
  type HostFrame,
  type PageDialog,
  type PageLog,
  type ProfileFrame,
  type ProfileId,
  type TabState,
  type Viewport,
} from './browser-wire.js'
import { PORT } from './daemon.js'

const DESKTOP: Viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
const PRESETS: Record<string, Viewport | null> = {
  fit: null,
  desktop: DESKTOP,
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
}
const MAX_TABS = 8
const IDLE_CLOSE_MS = 15 * 60_000
/** Input within this long of an agent call is the agent's, not yours. */
const AGENT_QUIET_MS = 1500
/** A click this recent is what lets a page hand a mailto: or zoommtg: link to another app. */
const USER_GESTURE_MS = 10_000
const FLASH_MS = 700
/** The daemon remembers a tab's URL, title, viewport and scheme; this often at most. */
const REMEMBER_MS = 500
const POPUP_SIZE = { width: 520, height: 680 }
const POPUP_MAX_MS = 10 * 60_000

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
  /** the profile (cookie jar) the tab is in */
  profile: ProfileId | null
  /** a sign-in window the tab opened, still open */
  popup: { url: string } | null
  /** a JavaScript dialog blocking the page */
  dialog: PageDialog | null
  /** the last main-frame load failed (`code` is Chromium's, e.g. ERR_CONNECTION_REFUSED), or the page crashed (`crashed`) */
  error: { code: string; url: string } | null
}

/** The keys a tab hands to its pane instead of the page (or the app menu, where ⌘R would reload Junior). */
type PaneKey = 'focus-url' | 'find' | 'reload' | 'back' | 'forward'

type Pane = { win: BrowserWindow; sessionId: string | null; rect: Rectangle | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const NO_TAB: TabState = { exists: false, url: '', title: '', loading: false, viewport: null, colorScheme: null, profile: null, popup: null, dialog: null }

/**
 * Where a page's window.open goes. A sign-in popup (a features string or a
 * named window, without noopener) needs a real window: "Sign in with Google"
 * talks back through window.opener. Everything else (target=_blank, a plain
 * window.open) stays in the tab: one session, one page.
 */
function isSignInPopup(disposition: string, frameName: string, features: string): boolean {
  return disposition === 'new-window' || (!!frameName && !/(^|,)\s*noopener\b/i.test(features))
}

class Tab implements JarTab {
  readonly view: WebContentsView
  /** null = fit the pane, like a browser; Junior or the viewport menu sets a size */
  viewport: Viewport | null = null
  colorScheme: ColorScheme = null
  /** the pane's zoom: agent coordinates (CSS px) × scale = view px */
  scale = 1
  inflight = 0
  /** opens you sent from the pane (`open.byUser`) running now: their navigations are yours */
  userOpen = 0
  lastAgentAt = 0
  lastUserAt = 0
  lastUsed = Date.now()
  picking = false
  /** the text of the find in progress: the same text again is "next match" */
  findText = ''
  /** the sign-in window and the page in it */
  popup: BrowserWindow | null = null
  popupPage: WebContents | null = null
  popupUrl = ''
  dialog: PageDialog | null = null
  error: { code: string; url: string } | null = null
  private requests = new Map<string, { method: string; url: string }>()
  private lastTouchSent = 0
  private rememberTimer: NodeJS.Timeout | null = null

  constructor(
    readonly key: string,
    readonly profile: ProfileId,
    partition: string,
    private readonly host: BrowserHost,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // no preload: a page can never reach window.juniorDesktop
      },
    })
    this.view.setBackgroundColor('#ffffff')
    const wc = this.view.webContents
    wc.setWindowOpenHandler(({ url, frameName, features, disposition }) => {
      if (isSignInPopup(disposition, frameName, features) && /^(https?:|about:blank)/.test(url)) {
        const open = this.popup
        if (open && !open.isDestroyed() && this.popupPage && !this.popupPage.isDestroyed()) {
          // one sign-in window per tab: a second popup reuses it
          void this.popupPage.loadURL(url).catch(() => {})
          open.focus()
          return { action: 'deny' }
        }
        return { action: 'allow', createWindow: (options) => this.host.openPopup(this, options, url) }
      }
      if (/^https?:|^file:/.test(url)) void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    const navigated = (url: string) => {
      // the blank page every tab starts on is ours, not a navigation anyone made
      if (url === 'about:blank') return
      this.host.send({ type: 'navigated', sessionId: key, url, byUser: this.userOpen > 0 || !this.agentRecently() })
      this.host.pushState(this)
      this.remember()
    }
    wc.on('did-navigate', (_e, url) => navigated(url))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) navigated(url)
    })
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument || !this.error) return
      this.error = null
      this.host.pushState(this)
    })
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 ERR_ABORTED: superseded by another load, not a failure
      if (!isMainFrame || code === -3) return
      this.error = { code: desc || `ERR_${-code}`, url }
      this.host.pushState(this)
    })
    wc.on('page-title-updated', () => {
      this.host.pushState(this)
      this.remember()
    })
    wc.on('did-start-loading', () => this.host.pushState(this))
    wc.on('did-stop-loading', () => this.host.pushState(this))
    wc.on('before-input-event', (e, input) => {
      if (this.inflight > 0) return
      if (input.type === 'keyDown' && input.meta && !input.control && !input.alt) {
        const k = input.key.toLowerCase()
        const key: PaneKey | null =
          k === 'l' && !input.shift ? 'focus-url' : k === 'f' && !input.shift ? 'find' : k === 'r' ? 'reload' : k === '[' ? 'back' : k === ']' ? 'forward' : null
        if (key) {
          e.preventDefault()
          this.host.paneKey(this, key)
          return
        }
        // Not the app menu's zoom: zooming a tab changes the CSS width Junior measures, even under emulation
        if (k === '=' || k === '+' || k === '-' || k === '0') {
          e.preventDefault()
          return
        }
      }
      if (input.type === 'keyDown') this.userInput()
    })
    wc.on('input-event', (_e, input) => {
      if (input.type === 'mouseDown' || input.type === 'gestureTap') this.userInput()
    })
    wc.on('context-menu', (_e, params) => {
      if (!this.agentRecently()) this.host.contextMenu(this, params)
    })
    wc.on('found-in-page', (_e, r) => this.host.toPanes('browser:found', { tabKey: key, matches: r.matches, active: r.activeMatchOrdinal }))
    wc.on('render-process-gone', (_e, d) => {
      this.log({ level: 'error', source: 'exception', text: `the page crashed (${d.reason})` })
      this.error = { code: 'crashed', url: wc.getURL() }
      this.host.pushState(this)
    })
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
    // Without it a view whose window isn't focused (parked, or a pane in a window in the
    // background) drops synthetic clicks and Enter: the page believes it has no focus.
    await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
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

  userRecently() {
    return Date.now() - this.lastUserAt < USER_GESTURE_MS
  }

  /** You typed or clicked in the page: the agent's next call hears about it. */
  private userInput() {
    if (this.agentRecently()) return
    this.lastUserAt = Date.now()
    if (Date.now() - this.lastTouchSent < 2000) return
    this.lastTouchSent = Date.now()
    this.host.send({ type: 'touched', sessionId: this.key })
  }

  cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.wc.debugger.sendCommand(method, params) as Promise<T>
  }

  private log(l: Omit<PageLog, 'at'>) {
    this.host.send({ type: 'log', sessionId: this.key, log: { ...l, at: Date.now() } })
  }

  /** Tell the daemon where this tab is, soon: it brings the tab back there after a restart. */
  remember() {
    if (this.rememberTimer) clearTimeout(this.rememberTimer)
    this.rememberTimer = setTimeout(() => this.flushRemember(), REMEMBER_MS)
  }

  flushRemember() {
    if (!this.rememberTimer) return
    clearTimeout(this.rememberTimer)
    this.rememberTimer = null
    const url = this.wc.getURL()
    if (!url || url === 'about:blank') return
    this.host.send({ type: 'tab', sessionId: this.key, profile: this.profile, url, title: this.wc.getTitle(), viewport: this.viewport, colorScheme: this.colorScheme })
  }

  private onCdp(method: string, p: Record<string, unknown>) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const type = String(p.type)
        const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type === 'log' || type === 'info' ? 'info' : null
        if (!level) return
        const args = (p.args as { value?: unknown; description?: string; type?: string }[]) ?? []
        const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(' ')
        // Electron's own dev-build nag about the page's CSP, not the page's problem
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
      case 'Page.javascriptDialogOpening':
        this.dialog = { type: String(p.type ?? 'alert'), message: String(p.message ?? '') }
        this.host.send({ type: 'dialog', sessionId: this.key, dialog: this.dialog })
        this.host.pushState(this)
        return
      case 'Page.javascriptDialogClosed':
        if (!this.dialog) return
        this.dialog = null
        this.host.send({ type: 'dialog', sessionId: this.key, dialog: null })
        this.host.pushState(this)
        return
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

  tabState(): TabState {
    const wc = this.wc
    return {
      exists: true,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      viewport: this.viewport,
      colorScheme: this.colorScheme,
      profile: this.profile,
      popup: this.popupState(),
      dialog: this.dialog,
    }
  }

  state(): PaneState {
    const wc = this.wc
    return {
      ...this.tabState(),
      sessionId: this.key,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      agentBusy: this.inflight > 0,
      picking: this.picking,
      error: this.error,
    }
  }

  private popupState(): { url: string } | null {
    const p = this.popup
    return p && !p.isDestroyed() ? { url: this.popupUrl } : null
  }

  destroy() {
    this.flushRemember()
    if (this.popup && !this.popup.isDestroyed()) this.popup.close()
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
  private readonly panes = new Map<number, Pane>()
  /** Junior's own windows (never the parking window or a sign-in window) */
  private readonly windows = new Set<BrowserWindow>()
  private park: BrowserWindow | null = null
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private readonly pickWaiters = new Map<string, (uid: number | null) => void>()
  /** tabs being made or remade: two calls for one tab key must not make two */
  private readonly making = new Map<string, Promise<Tab>>()
  private readonly jars: Jars
  /** the app is quitting: nothing gets parked, made or redialled any more */
  private quitting = false

  constructor(private readonly version: string) {
    this.jars = new Jars({
      tabOf: (wc) => this.tabOf(wc),
      download: (key, d) => this.send({ type: 'download', sessionId: key, ...d }),
    })
  }

  start() {
    // before any partition loads: a dropped profile's folder is free to remove only now
    sweepDroppedJars()
    this.connect()
    this.registerIpc()
    // A self-signed dev server opens; nothing else with a bad certificate does.
    app.on('certificate-error', (e, wc, url, _error, _cert, cb) => {
      if (!this.tabOf(wc) || !isLocalUrl(url)) return
      e.preventDefault()
      cb(true)
    })
    setInterval(() => this.closeIdle(), 60_000)
  }

  /** Before quit: what the daemon should remember, and every jar's cookies, on disk. */
  async flush() {
    for (const t of this.tabs.values()) t.flushRemember()
    await this.jars.flush()
  }

  /**
   * Quitting: close every tab and the parking window. Left alone, a closing
   * window parks its tab, the parking window lives on, and ⌘Q never quits.
   */
  shutdown() {
    this.quitting = true
    for (const t of [...this.tabs.values()]) this.closeTab(t.key)
    if (this.park && !this.park.isDestroyed()) this.park.destroy()
    this.park = null
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.ws?.close()
  }

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
      ws.send(JSON.stringify({ type: 'hello', version: WIRE_VERSION, app: `Junior.app ${this.version}` }))
    })
    ws.addEventListener('message', (ev) => {
      let f: CallFrame | ProfileFrame
      try {
        f = JSON.parse(String(ev.data)) as CallFrame | ProfileFrame
      } catch {
        return
      }
      if (f?.type === 'call' && typeof f.id === 'number' && typeof f.sessionId === 'string') void this.handle(f)
      else if (f?.type === 'profile' && typeof f.id === 'number') void this.handleProfile(f)
    })
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      // the daemon restarts, or isn't up yet: keep trying, quietly
      if (!this.retry && !this.quitting) this.retry = setTimeout(() => this.connect(), 2000)
    })
    ws.addEventListener('error', () => {
      // close follows
    })
  }

  send(frame: HostFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  private reply(id: number, ok: boolean, payload: unknown) {
    this.send(ok ? { type: 'result', id, ok: true, result: payload ?? null } : { type: 'result', id, ok: false, error: payload instanceof Error ? payload.message : String(payload) })
  }

  private async handle(f: CallFrame) {
    const reply = (ok: boolean, payload: unknown) => this.reply(f.id, ok, payload)
    if (this.quitting) return reply(false, 'Junior.app is quitting')
    if (!TAB_KEY_RE.test(f.sessionId)) return reply(false, 'bad tab key')
    if (typeof f.profile !== 'string' || !PROFILE_ID_RE.test(f.profile)) return reply(false, `bad profile "${String(f.profile)}"`)
    const existing = this.tabs.get(f.sessionId)
    // Reading a tab's state never makes one, nor moves it to another profile.
    if (f.verb === 'state') return reply(true, existing ? existing.tabState() : NO_TAB)
    if (f.verb === 'close') {
      this.closeTab(f.sessionId)
      return reply(true, null)
    }
    let tab: Tab
    let fresh: boolean
    try {
      ;({ tab, fresh } = await this.tabFor(f.sessionId, f.profile, f.verb !== 'open'))
    } catch (err) {
      return reply(false, err)
    }
    // Your own open (the pane's address bar, a profile switch) isn't Junior driving.
    const mine = f.verb === 'open' && f.byUser === true
    if (mine) tab.userOpen += 1
    else tab.inflight += 1
    tab.lastUsed = Date.now()
    this.pushState(tab)
    try {
      // a revived tab comes back at its remembered size before it loads, so it never flashes
      if (fresh && f.verb === 'open' && f.restore) {
        tab.viewport = f.restore.viewport
        tab.colorScheme = f.restore.colorScheme
        await tab.applyColorScheme()
        await tab.layout(this.paneOf(tab)?.rect ?? null)
      }
      reply(true, await this.run(tab, f))
    } catch (err) {
      reply(false, err)
    } finally {
      if (mine) tab.userOpen -= 1
      else {
        tab.inflight -= 1
        tab.lastAgentAt = Date.now()
      }
      // the tab may have been closed or remade meanwhile: the pane gets whatever is there now
      const live = this.tabs.get(tab.key)
      if (live) this.pushState(live)
      else this.broadcast({ sessionId: tab.key, exists: false } as PaneState)
    }
  }

  private async handleProfile(f: ProfileFrame) {
    const reply = (ok: boolean, payload: unknown) => this.reply(f.id, ok, payload)
    if (typeof f.profile !== 'string' || !PROFILE_ID_RE.test(f.profile)) return reply(false, `bad profile "${String(f.profile)}"`)
    try {
      switch (f.op) {
        case 'sites':
          return reply(true, { sites: await this.jars.sites(f.profile) })
        case 'clear':
          return reply(true, { removed: await this.jars.clear(f.profile, typeof f.site === 'string' && f.site ? f.site : undefined) })
        case 'drop': {
          await Promise.all([...this.making.values()].map((p) => p.catch(() => {})))
          for (const t of [...this.tabs.values()]) if (t.profile === f.profile) this.closeTab(t.key)
          await this.jars.drop(f.profile)
          return reply(true, null)
        }
        default:
          return reply(false, `unknown profile op`)
      }
    } catch (err) {
      reply(false, err)
    }
  }

  private async run(tab: Tab, f: CallFrame): Promise<unknown> {
    switch (f.verb) {
      case 'open': {
        if (!f.byUser) this.activity(tab.key)
        let status: number | null = null
        const onNav = (_e: unknown, _url: string, code: number) => (status = code)
        tab.wc.on('did-navigate', onNav)
        try {
          await tab.wc.loadURL(f.url)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // ERR_ABORTED: superseded by a redirect or an in-page move, the page did load
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
        tab.remember()
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

  /** The tab a page belongs to: its own view, or the sign-in window it opened. */
  private tabOf(wc: WebContents): Tab | null {
    for (const t of this.tabs.values()) if (t.wc === wc || (t.popupPage && !t.popupPage.isDestroyed() && t.popupPage === wc)) return t
    return null
  }

  /**
   * The tab for `key` in `profile`'s jar. A live tab in another jar is made
   * again in this one, at the same viewport and scheme, and (`carry`) back at
   * its URL. Its history stays behind: it is another identity.
   */
  private async tabFor(key: string, profile: ProfileId, carry: boolean): Promise<{ tab: Tab; fresh: boolean }> {
    for (;;) {
      const pending = this.making.get(key)
      if (pending) {
        await pending.catch(() => {})
        continue
      }
      const have = this.tabs.get(key)
      if (have && have.profile === profile) return { tab: have, fresh: false }
      const p = this.makeTab(key, profile, have ?? null, carry).finally(() => this.making.delete(key))
      this.making.set(key, p)
      return { tab: await p, fresh: true }
    }
  }

  private async makeTab(key: string, profile: ProfileId, old: Tab | null, carry: boolean): Promise<Tab> {
    // the jar first: a view keeps the user agent it was created under
    this.jars.session(profile)
    let url = ''
    let viewport: Viewport | null = null
    let colorScheme: ColorScheme = null
    if (old) {
      url = old.wc.getURL()
      viewport = old.viewport
      colorScheme = old.colorScheme
      // the tab lives on in another jar: neither the daemon nor the pane should see it close
      this.closeTab(key, true)
    } else if (this.tabs.size >= MAX_TABS) {
      const shown = new Set([...this.panes.values()].map((p) => p.sessionId))
      const lru = [...this.tabs.values()].filter((t) => !shown.has(t.key)).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (lru) this.closeTab(lru.key)
    }
    const tab = new Tab(key, profile, partitionOf(profile), this)
    tab.viewport = viewport
    tab.colorScheme = colorScheme
    await tab.init()
    this.tabs.set(key, tab)
    const pane = [...this.panes.values()].find((p) => p.sessionId === key)
    if (pane?.rect) await this.show(pane, tab)
    else await this.parkTab(tab)
    if (carry && url && url !== 'about:blank') await tab.wc.loadURL(url).catch(() => {})
    this.pushState(tab)
    return tab
  }

  /** Close a tab. `quiet`: it is being made again in another jar, so nobody hears it close. */
  private closeTab(key: string, quiet = false) {
    const tab = this.tabs.get(key)
    if (!tab) return
    this.tabs.delete(key)
    const waiter = this.pickWaiters.get(key)
    this.pickWaiters.delete(key)
    waiter?.(null)
    this.detach(tab)
    tab.destroy()
    if (quiet) return
    this.send({ type: 'closed', sessionId: key })
    this.broadcast({ sessionId: key, exists: false } as PaneState)
  }

  private closeIdle() {
    const shown = new Set([...this.panes.values()].map((p) => p.sessionId))
    for (const t of [...this.tabs.values()]) {
      if (!shown.has(t.key) && t.inflight === 0 && Date.now() - t.lastUsed > IDLE_CLOSE_MS) this.closeTab(t.key)
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
    if (this.quitting) return
    const park = this.parkWindow()
    if (!park.contentView.children.includes(tab.view)) {
      this.detach(tab)
      park.contentView.addChildView(tab.view)
    }
    await tab.layout(null)
  }

  private async show(pane: Pane, tab: Tab) {
    if (this.quitting || !pane.rect || pane.win.isDestroyed()) return
    if (!pane.win.contentView.children.includes(tab.view)) {
      this.detach(tab)
      pane.win.contentView.addChildView(tab.view)
    }
    await tab.layout(pane.rect)
  }

  private paneOf(tab: Tab): Pane | undefined {
    return [...this.panes.values()].find((p) => p.sessionId === tab.key && p.rect && !p.win.isDestroyed())
  }

  /** Push one tab's state to every window; each pane filters by its session. */
  pushState(tab: Tab) {
    if (this.tabs.get(tab.key) !== tab) return
    this.broadcast(tab.state())
  }

  private broadcast(s: PaneState) {
    this.toPanes('browser:state', s)
  }

  toPanes(channel: string, payload: unknown) {
    for (const p of this.panes.values()) if (!p.win.isDestroyed()) p.win.webContents.send(channel, payload)
  }

  /** The agent opened a page, or a parked tab opened a sign-in window: a pane on that session opens itself. */
  private activity(sessionId: string) {
    for (const w of this.windows) if (!w.isDestroyed()) w.webContents.send('browser:activity', { sessionId })
  }

  /** The window a tab's sign-in window sits over: its pane's, else the first junior window you can see. */
  private anchorWindow(tab: Tab): BrowserWindow | null {
    const pane = this.paneOf(tab)?.win
    if (pane) return pane
    const live = [...this.windows].filter((w) => !w.isDestroyed())
    return live.find((w) => w.isVisible() && !w.isMinimized()) ?? live[0] ?? null
  }

  /** Where a tab's sign-in window goes: 520×680, centred over the pane (or the window you can see). */
  private popupFrame(tab: Tab): BrowserWindowConstructorOptions {
    const pane = this.paneOf(tab)?.win
    const anchor = this.anchorWindow(tab)
    const b = anchor?.getBounds()
    return {
      ...POPUP_SIZE,
      ...(b ? { x: Math.round(b.x + (b.width - POPUP_SIZE.width) / 2), y: Math.round(b.y + Math.max(0, (b.height - POPUP_SIZE.height) / 2)) } : {}),
      ...(pane ? { parent: pane } : {}),
      show: true,
      minimizable: false,
      fullscreenable: false,
      backgroundColor: '#000000',
    }
  }

  /** `createWindow` for a tab's sign-in popup (browser-popup.ts): the window, wired to its tab. */
  openPopup(tab: Tab, options: BrowserWindowConstructorOptions, firstUrl: string): WebContents {
    const { win, page: pwc } = openSignInWindow(this.popupFrame(tab), options, firstUrl, (next) => {
      if (tab.popup !== win) return
      tab.popupUrl = next
      this.pushState(tab)
    })
    tab.popup = win
    tab.popupPage = pwc
    tab.popupUrl = firstUrl
    // inside the sign-in window, another window.open stays in it
    pwc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/.test(next)) void pwc.loadURL(next).catch(() => {})
      return { action: 'deny' }
    })
    const timer = setTimeout(() => !win.isDestroyed() && win.close(), POPUP_MAX_MS)
    win.on('closed', () => {
      clearTimeout(timer)
      const url = tab.popupUrl
      if (tab.popup === win) {
        tab.popup = null
        tab.popupPage = null
        tab.popupUrl = ''
      }
      this.send({ type: 'popup', sessionId: tab.key, url, state: 'closed' })
      this.pushState(tab)
    })
    this.send({ type: 'popup', sessionId: tab.key, url: firstUrl, state: 'opened' })
    if (!this.paneOf(tab)) this.activity(tab.key)
    this.pushState(tab)
    return pwc
  }

  /** A shortcut pressed in the page: back, forward and reload happen here; the pane hears every one. */
  paneKey(tab: Tab, key: PaneKey) {
    const h = tab.wc.navigationHistory
    if (key === 'reload') tab.wc.reload()
    else if (key === 'back' && h.canGoBack()) h.goBack()
    else if (key === 'forward' && h.canGoForward()) h.goForward()
    const win = this.paneOf(tab)?.win
    // the URL field and the find bar are in Junior's page: it needs the keyboard back
    if (win && (key === 'focus-url' || key === 'find')) win.webContents.focus()
    this.toPanes('browser:key', { tabKey: tab.key, key })
  }

  contextMenu(tab: Tab, p: ContextMenuParams) {
    const win = this.paneOf(tab)?.win
    if (!win) return
    const wc = tab.wc
    const h = wc.navigationHistory
    const items: MenuItemConstructorOptions[] = []
    const separate = () => {
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
    }
    const selection = p.selectionText.trim()
    if (p.isEditable) {
      items.push(
        { label: 'Cut', enabled: p.editFlags.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: p.editFlags.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: p.editFlags.canPaste, click: () => wc.paste() },
        { label: 'Select all', enabled: p.editFlags.canSelectAll, click: () => wc.selectAll() },
      )
    } else if (selection) items.push({ label: 'Copy', click: () => wc.copy() })
    if (p.linkURL) {
      separate()
      items.push(
        { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) },
        { label: 'Open link in your browser', enabled: /^(https?|mailto):/i.test(p.linkURL), click: () => void shell.openExternal(p.linkURL) },
      )
    }
    if (p.mediaType === 'image' && p.srcURL) {
      separate()
      items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) })
    }
    if (!items.length) {
      items.push(
        { label: 'Back', enabled: h.canGoBack(), click: () => h.goBack() },
        { label: 'Forward', enabled: h.canGoForward(), click: () => h.goForward() },
        { label: 'Reload', click: () => wc.reload() },
      )
    }
    separate()
    items.push({
      label: 'Inspect element',
      click: () => {
        wc.openDevTools({ mode: 'detach' })
        wc.inspectElement(p.x, p.y)
      },
    })
    Menu.buildFromTemplate(items).popup({ window: win })
  }

  picked(tab: Tab, backendNodeId: number) {
    const done = this.pickWaiters.get(tab.key)
    if (!done) return
    this.pickWaiters.delete(tab.key)
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
    this.windows.add(win)
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
      this.windows.delete(win)
      const p = this.panes.get(id)
      this.panes.delete(id)
      const tab = p?.sessionId ? this.tabs.get(p.sessionId) : undefined
      if (tab) void this.parkTab(tab)
    })
    // a reload of the junior UI drops its pane until it reports again
    win.webContents.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return
      parkShown()
      const p = this.panes.get(id)
      if (p) p.rect = null
    })
  }

  private windowOf(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w && this.windows.has(w) ? w : null
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
      for (const [otherId, p] of this.panes) if (otherId !== id && p.sessionId === tab.key) p.rect = null
      if (rect && !win.isMinimized() && win.isVisible()) void this.show(pane, tab)
      else void this.parkTab(tab)
      win.webContents.send('browser:state', tab.state())
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
      tab.remember()
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
    // Find in page: matches arrive as browser:found. The same text again moves to
    // the next match, new text starts over, empty text clears the highlight.
    // (Electron's own `findNext` means the opposite: true starts a new search.)
    ipcMain.on('browser:find', (_e, msg: { sessionId: string; text: string; forward?: boolean }) => {
      const tab = this.tabs.get(msg.sessionId)
      if (!tab) return
      if (typeof msg.text !== 'string' || !msg.text) {
        tab.findText = ''
        tab.wc.stopFindInPage('clearSelection')
        return
      }
      const again = msg.text === tab.findText
      tab.findText = msg.text
      tab.wc.findInPage(msg.text, { forward: msg.forward !== false, findNext: !again })
    })
    ipcMain.on('browser:find-stop', (_e, msg: { sessionId: string }) => {
      const tab = this.tabs.get(msg.sessionId)
      if (!tab) return
      tab.findText = ''
      tab.wc.stopFindInPage('clearSelection')
    })
    // A still of the page, for the pane to show while one of its menus covers the view → PNG data URL
    ipcMain.handle('browser:capture', async (_e, msg: { sessionId: string }) => {
      const tab = this.tabs.get(msg.sessionId)
      if (!tab) return null
      const img = await tab.wc.capturePage().catch(() => null)
      return img && !img.isEmpty() ? img.toDataURL() : null
    })
    // "Show window" on the pane's sign-in strip: the window may be behind Junior
    ipcMain.on('browser:focus-popup', (_e, msg: { sessionId: string }) => {
      const win = this.tabs.get(msg.sessionId)?.popup
      if (!win || win.isDestroyed()) return
      win.show()
      win.focus()
    })
    // "Show in Finder" for a download, and only for one: nothing outside ~/Downloads
    ipcMain.on('browser:reveal', (e, msg: { path: string }) => {
      if (!this.windowOf(e) || typeof msg?.path !== 'string') return
      const downloads = downloadsDir()
      const p = path.resolve(msg.path)
      if (p.startsWith(downloads + path.sep)) shell.showItemInFolder(p)
    })
  }
}

/** localhost, 127.0.0.1, [::1] and *.localhost: where a self-signed dev server lives. */
function isLocalUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}
