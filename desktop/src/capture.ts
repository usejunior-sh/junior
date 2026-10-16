/**
 * Quick capture: ⌘⇧T from any app pops one line; Enter files it as a manual
 * item in the inbox, with you — the same route the inbox's own add uses
 * (POST /api/items/manual → createManualOp). Esc, or clicking away, dismisses.
 *
 * The window is a non-activating panel, so it takes the keyboard without
 * bringing Triage forward: the app you were in stays where it was, and gets
 * the focus back when the panel hides.
 */
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT } from './daemon.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CAPTURE_HOTKEY = 'CommandOrControl+Shift+T'
const SIZE = { width: 560, height: 56 }

let panel: BrowserWindow | null = null
// The workspace the item lands in — the main window's, '' for the default.
let workspaceOf: () => string = () => ''

/** Register the hotkey and the panel's IPC. False if another app holds the hotkey. */
export function startCapture(workspace: () => string): boolean {
  workspaceOf = workspace
  ipcMain.handle('capture:submit', (_e, title: unknown) => submit(title))
  ipcMain.on('capture:close', () => panel?.hide())
  const ok = globalShortcut.register(CAPTURE_HOTKEY, toggleCapture)
  if (!ok) console.warn(`quick capture: ${CAPTURE_HOTKEY} is taken by another app`)
  return ok
}

export function stopCapture() {
  globalShortcut.unregister(CAPTURE_HOTKEY)
}

export function toggleCapture() {
  if (panel && !panel.isDestroyed() && panel.isVisible()) {
    panel.hide()
    return
  }
  const p = panel && !panel.isDestroyed() ? panel : (panel = createPanel())
  // On the display the pointer is on, a third of the way down — where Spotlight sits.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  p.setBounds({
    x: Math.round(area.x + (area.width - SIZE.width) / 2),
    y: Math.round(area.y + area.height / 4),
    ...SIZE,
  })
  const open = () => {
    p.show()
    p.focus()
    p.webContents.send('capture:open')
  }
  if (p.webContents.isLoading()) p.webContents.once('did-finish-load', open)
  else open()
}

function createPanel(): BrowserWindow {
  const p = new BrowserWindow({
    ...SIZE,
    type: 'panel',
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // Over full-screen apps too, on whichever Space you're in.
  p.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  p.on('blur', () => p.hide())
  p.webContents.on('will-navigate', (e) => e.preventDefault())
  p.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void p.loadFile(path.join(here, 'capture.html'))
  return p
}

async function submit(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const title = typeof raw === 'string' ? raw.trim() : ''
  if (!title) return { ok: false, error: 'type something first' }
  const ws = workspaceOf()
  const url = `http://localhost:${PORT}/api/items/manual${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(5000),
    })
    const out = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; error?: string }
    return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'couldn’t add it' }
  } catch {
    return { ok: false, error: 'triage isn’t answering' }
  }
}
