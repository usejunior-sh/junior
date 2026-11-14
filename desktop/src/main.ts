/**
 * Junior.app's main process (ARCHITECTURE.md): windows over the local daemon,
 * a menu, a menu-bar icon. The app attaches, it does not own, quitting it
 * never stops the daemon, so live sessions and jobs carry on.
 *
 * Each window holds workspace tabs (tabs.ts): one view per open workspace at
 * its `/w/<id>/`, the window's own page showing only the splash beneath. The
 * last window only hides on close, so the app lives on in the Dock with its
 * tabs; any other closes for real. Jobs and sessions run on the daemon either way.
 * ⌘⇧T from any app opens quick capture (capture.ts).
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserHost } from './browser.js'
import { CAPTURE_HOTKEY, startCapture, stopCapture, toggleCapture } from './capture.js'
import { PORT, UI_PORT, daemonUrl, ensureDaemon, logFile, probe, restartDaemon, type DaemonHealth } from './daemon.js'
import { WorkspaceTabsHost } from './tabs.js'
import type { SavedWindow } from './tabs-model.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SPLASH = path.join(here, 'splash.html')
const SPLASH_URL = pathToFileURL(SPLASH).href
const DEFAULT_SIZE = { width: 1360, height: 880 }
const MIN_SIZE = { width: 900, height: 600 }

type SplashStatus = { state: 'starting' | 'error'; text: string; detail?: string }

// The workspace tabs, and through them every Junior window.
let tabs: WorkspaceTabsHost | null = null
let tray: Tray | null = null
let quitting = false
// One connect at a time: did-fail-load, the watchdog and Retry all funnel here.
let connecting = false
let lastAutoConnect = 0
let splash: SplashStatus = { state: 'starting', text: 'Looking for Junior…' }
// The browser pane's tabs, and the link the daemon drives them through (.docs/browser.md).
let browser: BrowserHost | null = null

// An unpackaged app (`npm start` in desktop/) is the dev app: its own data
// folder, so it never shares the installed app's single-instance lock, which
// would quit it on launch and bring the installed window forward instead, nor its window state or the browser pane's cookies.
// JUNIOR_APP_USER_DATA gives either app a folder of its own (QA runs), so it
// never touches a real login, lock or window state.
if (!app.isPackaged) app.setName('Junior Dev')
const userData = process.env.JUNIOR_APP_USER_DATA?.trim()
if (userData) app.setPath('userData', path.resolve(userData))
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Junior Dev'))
// The Triage → Junior rename: the old data folder (window state, the browser
// pane's profiles and their logins) moves over once.
if (!userData) {
  const now = app.getPath('userData')
  const before = path.join(path.dirname(now), path.basename(now).replace('Junior', 'Triage'))
  if (before !== now && fs.existsSync(before) && !fs.existsSync(now)) fs.renameSync(before, now)
  // The browser's cookie jars were named persist:triage-*; they are persist:junior-* now
  // (partitionOf). Without this the profiles' saved logins stay behind in the old jars.
  const parts = path.join(now, 'Partitions')
  if (fs.existsSync(parts)) {
    for (const name of fs.readdirSync(parts)) {
      if (!name.startsWith('triage-')) continue
      const to = path.join(parts, 'junior-' + name.slice('triage-'.length))
      if (!fs.existsSync(to)) fs.renameSync(path.join(parts, name), to)
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(start)
}

function start() {
  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(buildMenu())
  createTray()
  ipcMain.on('splash:retry', () => void connect())
  ipcMain.on('splash:open-log', () => void openLog())
  // The web UI's ← → buttons. Hash routes are history entries, so the
  // window's own navigation history is the app's history.
  // Each tab is its own page with its own history.
  ipcMain.on('nav:back', (e) => goBack(e.sender))
  ipcMain.on('nav:forward', (e) => goForward(e.sender))
  ipcMain.handle('nav:state', (e) => navState(e.sender))
  browser = new BrowserHost(app.getVersion())
  browser.start()
  tabs = new WorkspaceTabsHost({
    preload: path.join(here, 'preload.cjs'),
    version: app.getVersion(),
    daemonUrl,
    isDaemonUrl,
    openExternal,
    newWindow: (from) => {
      const b = from?.getNormalBounds()
      return createWindow(b ? { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height } : undefined)
    },
    reconnect,
    loaded: (wc) => void fitLegacyBar(wc),
    uiChanged: (wc) => browser?.uiChanged(wc),
    watchUi: (wc) => browser?.watchUi(wc),
    sendNav,
    changed: saveSoon,
  })
  tabs.start()
  const host = tabs
  browser.setUiHost({ windowOf: (wc) => host.windowOfPage(wc), isFront: (wc) => host.isFront(wc), pages: () => host.pages() })
  // Captured items land in the workspace in front.
  startCapture(() => {
    const w = frontWindow()
    return w ? host.frontWorkspace(w) : ''
  })
  restoreWindows()
  void connect()
  setInterval(watchdog, 5000)
}

/** Last launch's windows and their tabs, or one window whose tab is the default workspace. */
function restoreWindows() {
  const saved = loadWindowState()
  const list = saved.windows.length ? saved.windows : [{ bounds: saved.bounds, maximized: saved.maximized, tabs: [], active: '' }]
  for (const s of list) {
    const w = createWindow(s.bounds)
    if (s.maximized) w.maximize()
    tabs!.attach(w, s.tabs, s.active)
  }
}

/** The Junior window you were last in (focused, else the first one open). */
function frontWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  const all = allWindows()
  return focused && all.includes(focused) ? focused : (all[0] ?? null)
}

/**
 * A Junior window. Its own page shows only the splash; its workspace tabs
 * (tabs.ts) lie over it once the daemon answers. `bounds` places it (a saved
 * window, or cascaded off another); none = the default size.
 */
function createWindow(bounds?: Partial<Rectangle>): BrowserWindow {
  const w = new BrowserWindow({
    ...DEFAULT_SIZE,
    ...clampBounds(bounds),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Junior',
    backgroundColor: '#0c0b0a',
    // No grey title bar: the traffic lights sit inside Junior's own 44px bar
    // (web/src/components/TopBar.tsx, desktop layout), centred vertically.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--junior-version=${app.getVersion()}`],
    },
  })
  browser?.watchWindow(w)
  w.once('ready-to-show', () => w.show())
  // The last window only hides: the app lives on in the Dock and the menu bar,
  // tabs and all, until ⌘Q. Any other closes, its tabs with it.
  w.on('close', (e) => {
    saveWindowState()
    if (!quitting && allWindows().filter((o) => o !== w).length === 0) {
      e.preventDefault()
      w.hide()
    }
  })
  w.on('closed', saveSoon)
  w.on('resize', saveSoon)
  w.on('move', saveSoon)
  w.on('maximize', saveSoon)
  w.on('unmaximize', saveSoon)

  const wc = w.webContents
  wc.on('did-finish-load', () => wc.send('splash:status', splash))
  wc.on('will-navigate', (e, navUrl) => {
    if (navUrl === SPLASH_URL) return
    e.preventDefault()
    openExternal(navUrl)
  })
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    openExternal(openUrl)
    return { action: 'deny' }
  })
  void w.loadFile(SPLASH)
  return w
}

const allWindows = (): BrowserWindow[] => tabs?.windows() ?? []

/**
 * A daemon older than the desktop title bar (web/src/desktop.ts) serves a UI
 * that doesn't draw one, so its top bar would sit under the traffic lights.
 * Give that bar the lights' inset and make it the drag handle instead.
 */
async function fitLegacyBar(wc: Electron.WebContents) {
  const modern = await wc.executeJavaScript(`document.documentElement.classList.contains('desktop-mac')`).catch(() => true)
  if (modern) return
  await wc.insertCSS(
    '.topbar { padding-left: 84px !important; -webkit-app-region: drag; }' +
      '.topbar button, .topbar [role="button"] { -webkit-app-region: no-drag; }',
  )
}

function showWindow() {
  if (!app.isReady() || !tabs) return // a Dock click or second launch racing startup; start() opens the window
  const w = frontWindow()
  if (!w) {
    tabs.attach(createWindow())
    void connect()
    return
  }
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/** The splash is up: the daemon hasn't answered since the last connect. */
let onSplash = true

function setSplash(s: SplashStatus) {
  splash = s
  for (const w of allWindows()) w.webContents.send('splash:status', s)
}

/** Every window back to its splash: the tab views hide over it. */
function toSplash() {
  onSplash = true
  tabs?.hideAll()
}

/**
 * Every window to the splash → find or start the daemon (or restart it) →
 * each window back to its target. Errors stay on the splash.
 */
async function connect(how: 'ensure' | 'restart' = 'ensure') {
  if (connecting || allWindows().length === 0) return
  connecting = true
  try {
    setSplash({ state: 'starting', text: how === 'restart' ? 'Restarting Junior…' : 'Looking for Junior…' })
    toSplash()
    if (how === 'restart') await restartDaemon()
    else await ensureDaemon((text) => setSplash({ state: 'starting', text }))
    onSplash = false
    await tabs?.connected()
  } catch (err) {
    toSplash()
    // daemon.ts errors are "headline\n\ncli output\n\nlog tail".
    const msg = err instanceof Error ? err.message : String(err)
    const cut = msg.indexOf('\n\n')
    const head = cut === -1 ? msg : msg.slice(0, cut)
    setSplash({
      state: 'error',
      text: head.charAt(0).toUpperCase() + head.slice(1),
      detail: cut === -1 ? undefined : msg.slice(cut + 2),
    })
  } finally {
    connecting = false
  }
}

/**
 * An automatic reconnect, at most once per 10s. A daemon that keeps failing
 * to load ends on the splash's error, waiting for Retry, instead of a loop.
 */
function reconnect() {
  if (connecting || allWindows().length === 0) return
  if (Date.now() - lastAutoConnect < 10_000) {
    toSplash()
    setSplash({ state: 'error', text: 'Junior stopped answering', detail: `Nothing at ${daemonUrl()} — Retry to start it again, or check the log.` })
    return
  }
  lastAutoConnect = Date.now()
  void connect()
}

// A loaded SPA doesn't fail a load when the daemon dies, its socket just
// drops. Two misses in a row (not one: `junior restart` is a short gap) sends
// every window back to the splash. And a splash showing an error recovers on
// its own once a daemon appears.
let misses = 0
async function watchdog() {
  const windows = allWindows()
  if (connecting || windows.length === 0) return
  const health = await probe()
  if (onSplash) {
    if (splash.state === 'error' && health && health !== 'other') void connect()
    return
  }
  // 'other' includes a busy daemon that missed the 1.5s probe, not gone.
  misses = health === null ? misses + 1 : 0
  if (misses >= 2) {
    misses = 0
    reconnect()
  }
}

async function confirmRestart(message = 'Restart the Junior server?') {
  if (connecting) return
  const parent = frontWindow() ?? (showWindow(), frontWindow())
  if (!parent) return
  const health = await probe()
  const live = health && health !== 'other' ? health.liveSessions : 0
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message,
    detail:
      (live
        ? `This stops ${live} live session${live === 1 ? '' : 's'} mid-turn. `
        : 'Any live session is stopped. ') +
      'Each one picks up again on its next message. Jobs skip a beat; nothing is lost.',
    buttons: ['Restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response === 0) void connect('restart')
}

type NavState = { canGoBack: boolean; canGoForward: boolean; fullscreen: boolean }

function navState(wc: WebContents | null, win = wc ? tabs?.windowOfPage(wc) : null): NavState {
  const h = wc && !wc.isDestroyed() ? wc.navigationHistory : null
  return { canGoBack: !!h?.canGoBack(), canGoForward: !!h?.canGoForward(), fullscreen: !!win?.isFullScreen() }
}

function goBack(wc: WebContents | null | undefined) {
  if (wc && navState(wc).canGoBack) wc.navigationHistory.goBack()
}

function goForward(wc: WebContents | null | undefined) {
  if (wc && navState(wc).canGoForward) wc.navigationHistory.goForward()
}

/** Push ← → availability (and fullscreen) to a tab's page after every move. */
function sendNav(wc: WebContents, win: BrowserWindow) {
  if (!wc.isDestroyed()) wc.send('nav:state', navState(wc, win))
}

/** The page in front of the window a menu item was picked in. */
function frontPage(w: unknown): WebContents | null {
  const win = w instanceof BrowserWindow ? w : frontWindow()
  return (win && tabs?.frontView(win)?.webContents) || null
}

/** Run a menu item against the window it was picked in. */
const inWindow = (fn: (w: BrowserWindow) => void) => (_i: unknown, w: unknown) => {
  const win = w instanceof BrowserWindow ? w : frontWindow()
  if (win && tabs) fn(win)
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open in Browser', click: () => void shell.openExternal(daemonUrl()) },
        { label: 'Open server log', click: () => void openLog() },
        { label: 'Restart Junior server…', click: () => void confirmRestart() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+T', click: inWindow((w) => tabs!.openMenu(w)) },
        { label: 'Move Tab to New Window', accelerator: 'CmdOrCtrl+Shift+N', click: inWindow((w) => tabs!.moveToNewWindow(tabs!.frontWorkspace(w))) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: inWindow((w) => tabs!.close(w)) },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // The roles would act on the window's own page (the splash); these act on the tab in front.
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_i, w) => frontPage(w)?.reload() },
        { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: (_i, w) => frontPage(w)?.reloadIgnoringCache() },
        { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: (_i, w) => frontPage(w)?.toggleDevTools() },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: (_i, w) => goBack(frontPage(w)) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: (_i, w) => goForward(frontPage(w)) },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: (_i, w) => zoom(frontPage(w), 0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: (_i, w) => zoom(frontPage(w), 1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: (_i, w) => zoom(frontPage(w), -1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: 'Ctrl+Tab', click: inWindow((w) => tabs!.step(w, 1)) },
        { label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: inWindow((w) => tabs!.step(w, -1)) },
        {
          label: 'Go to Tab',
          submenu: Array.from({ length: 9 }, (_, i) => ({
            label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: inWindow((w) => tabs!.nth(w, i + 1)),
          })),
        },
        { label: 'Merge All Windows', click: inWindow((w) => tabs!.mergeInto(w)) },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'usejunior.sh', click: () => void shell.openExternal('https://usejunior.sh') },
        { label: 'Junior on GitHub', click: () => void shell.openExternal('https://github.com/usejunior-sh/junior') },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

function createTray() {
  // The "Template" suffix makes macOS tint it for light and dark menu bars;
  // trayTemplate@2x.png is picked up beside it.
  const icon = nativeImage.createFromPath(path.join(here, 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Junior')
  // Built on each open so the status line is current.
  const open = async () => tray?.popUpContextMenu(await trayMenu())
  tray.on('click', open)
  tray.on('right-click', open)
}

async function trayMenu(): Promise<Menu> {
  // Don't let a hung port hold the menu up.
  const health = await Promise.race([probe(), new Promise<undefined>((r) => setTimeout(r, 600))])
  return Menu.buildFromTemplate([
    { label: 'Open Junior', click: showWindow },
    // Shown, not registered: the global shortcut already answers it.
    { label: 'Quick capture…', accelerator: CAPTURE_HOTKEY, registerAccelerator: false, click: toggleCapture },
    { label: statusLine(health), enabled: false },
    // Never restarted for you: it would stop live sessions.
    ...(isStale(health)
      ? [{ label: 'Restart to update server…', click: () => void confirmRestart(`Restart Junior to update its server to v${app.getVersion()}?`) }]
      : []),
    { type: 'separator' },
    { label: 'Open in Browser', click: () => void shell.openExternal(daemonUrl()) },
    { label: 'Restart server…', click: () => void confirmRestart() },
    { type: 'separator' },
    { label: 'Quit Junior', click: () => app.quit() },
  ])
}

function statusLine(health: DaemonHealth | 'other' | null | undefined): string {
  if (health === undefined) return 'junior · not answering'
  if (health === null) return 'junior · not running'
  if (health === 'other') return `port ${PORT} · not Junior`
  if (isStale(health)) return `junior v${health.version} running · app v${app.getVersion()}`
  const n = health.liveSessions
  return `junior v${health.version} · ${n} live session${n === 1 ? '' : 's'}`
}

/**
 * After an app upgrade the running daemon can still be the old one. It keeps
 * running across app quits. Unpackaged, the app's version says nothing about
 * the server's (dev runs the repo build), so only a packaged app compares.
 */
function isStale(health: DaemonHealth | 'other' | null | undefined): boolean {
  return app.isPackaged && !!health && health !== 'other' && health.version !== app.getVersion()
}

/** The daemon's origin: any loopback name (prod is junior.localhost) at PORT. */
function isDaemonUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const host = u.hostname
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
    const port = Number(u.port || 80)
    return (u.protocol === 'http:' || u.protocol === 'ws:') && loopback && (port === PORT || port === UI_PORT)
  } catch {
    return false
  }
}

/** ⌘0 / ⌘+ / ⌘-, half a step at a time, on the page in front. */
function zoom(wc: WebContents | null, by: -1 | 0 | 1) {
  if (!wc) return
  wc.setZoomLevel(by === 0 ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + by * 0.5)))
}

// Only schemes a browser or mail client should handle, never file: or app handlers.
function openExternal(url: string) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
}

async function openLog() {
  const err = await shell.openPath(logFile())
  if (err) dialog.showErrorBox('No server log yet', `${logFile()}\n\n${err}`)
}

type Bounds = Partial<Rectangle> & { width: number; height: number }
type SavedWin = SavedWindow & { bounds: Bounds; maximized: boolean }
/** `bounds`/`maximized` are the first window's, as before tabs; `windows` is every window and its tabs. */
type WindowState = { bounds: Bounds; maximized: boolean; windows: SavedWin[] }

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

/** Clamp to the display it was on, or the nearest, if that one is gone. */
function clampBounds(b: Partial<Rectangle> | undefined): Partial<Rectangle> {
  if (!b || !b.width || !b.height) return b ?? {}
  if (![b.x, b.y].every(Number.isFinite)) return { width: b.width, height: b.height }
  const r = b as Rectangle
  const area = screen.getDisplayMatching(r).workArea
  const width = Math.min(Math.max(r.width, MIN_SIZE.width), area.width)
  const height = Math.min(Math.max(r.height, MIN_SIZE.height), area.height)
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<WindowState>
    const okBounds = (b: unknown): b is Bounds => !!b && [(b as Rectangle).width, (b as Rectangle).height].every(Number.isFinite)
    const windows = (Array.isArray(s.windows) ? s.windows : []).filter(
      (w): w is SavedWin => !!w && okBounds(w.bounds) && Array.isArray(w.tabs) && w.tabs.every((t) => typeof t === 'string'),
    )
    if (okBounds(s.bounds)) return { bounds: s.bounds, maximized: !!s.maximized, windows }
  } catch {
    // first launch, or an unreadable file: defaults
  }
  return { bounds: { ...DEFAULT_SIZE }, maximized: false, windows: [] }
}

function saveWindowState() {
  if (!tabs) return
  const live = allWindows()
  const saved = tabs.save()
  const windows: SavedWin[] = []
  // tabs.save() keeps window order and drops empty windows; pair them back up.
  let i = 0
  for (const w of live) {
    if (!tabs.model.windows.get(w.id)?.tabs.length) continue
    const t = saved[i++]
    if (!t || w.isFullScreen()) continue
    windows.push({ ...t, bounds: w.getNormalBounds(), maximized: w.isMaximized() })
  }
  if (!windows.length) return
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ bounds: windows[0].bounds, maximized: windows[0].maximized, windows }))
  } catch {
    // losing the window position is not worth an error dialog
  }
}

let saveTimer: NodeJS.Timeout | undefined
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveWindowState, 500)
}

// The browser's cookies hit the disk once, before the first quit goes ahead
// (a login made a few seconds before ⌘Q would otherwise be lost), then its
// tabs and parking window close, so nothing holds the quit up.
let flushed = false
app.on('before-quit', (e) => {
  quitting = true
  if (flushed || !browser) return
  flushed = true
  e.preventDefault()
  void Promise.race([browser.flush(), new Promise((r) => setTimeout(r, 2000))]).finally(() => {
    browser?.shutdown()
    app.quit()
  })
})
app.on('will-quit', stopCapture)
app.on('activate', showWindow)
// Never quit on the last window closing: the window only hides, and the tray stays.
app.on('window-all-closed', () => {})
