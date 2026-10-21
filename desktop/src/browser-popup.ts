/**
 * The sign-in window a tab opens ("Sign in with Google", Slack or GitHub
 * OAuth, SSO): a small real window, so the page keeps `window.opener`, with a
 * read-only address strip above the page, as Chrome draws one, because a page
 * Junior opens can open a fake sign-in too. The page is the opener's own
 * guest (Electron hands it to `createWindow`), so it shares the tab's cookie
 * jar; it has no preload and no debugger, and Junior never drives it.
 */
import { BrowserWindow, WebContentsView, type BrowserWindowConstructorOptions, type WebContents } from 'electron'

const STRIP_H = 28

/** How an address reads in the strip and the window title. */
export function addressOf(raw: string): { mark: 'lock' | 'local' | 'insecure' | ''; host: string; title: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { mark: '', host: '', title: 'Sign in' }
  }
  const host = u.host
  if (!host) return { mark: '', host: '', title: 'Sign in' }
  if (u.protocol === 'https:') return { mark: 'lock', host, title: `🔒 ${host}` }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost')
  if (local) return { mark: 'local', host, title: `${host} · local` }
  return { mark: 'insecure', host, title: `Not secure · ${host}` }
}

// The pane's address field, read-only: Geist Mono's lane falls back to the system mono here.
const STRIP_HTML = `<!doctype html><meta charset=utf-8><style>
html,body{margin:0;height:${STRIP_H}px;overflow:hidden;background:#000;color:#f4f4f2;font:12px/1 ui-monospace,"SF Mono",Menlo,monospace;user-select:text;-webkit-user-select:text}
body{display:flex;align-items:center;gap:6px;padding:0 10px;box-sizing:border-box;border-bottom:1px solid rgba(255,255,255,.14)}
#m{display:flex;align-items:center;gap:5px;color:#a1a19c;white-space:nowrap}
#m.insecure{color:#f2c94c}
#h{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
svg{width:12px;height:12px;flex:none}
</style><span id=m></span><span id=h></span><script>
const lock='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>'
const warn='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2 1.5 13.5h13z"/><path d="M8 6.5v3.5M8 12v.01"/></svg>'
window.set=(a)=>{const m=document.getElementById('m');m.className=a.mark;m.innerHTML=a.mark==='lock'?lock:a.mark==='insecure'?warn+'Not secure':a.mark==='local'?'local':'';document.getElementById('h').textContent=a.host}
</script>`

/**
 * Build the window around the guest Electron made for `window.open`.
 * `frame` places it; `guest` is what `createWindow` was given.
 */
export function openSignInWindow(frame: BrowserWindowConstructorOptions, guest: BrowserWindowConstructorOptions, firstUrl: string, onUrl: (url: string) => void) {
  const win = new BrowserWindow({ ...frame, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const view = new WebContentsView({ webPreferences: guest.webPreferences, webContents: (guest as { webContents?: WebContents }).webContents })
  view.setBackgroundColor('#ffffff')
  win.contentView.addChildView(view)
  const fit = () => {
    const b = win.getContentBounds()
    view.setBounds({ x: 0, y: STRIP_H, width: b.width, height: Math.max(0, b.height - STRIP_H) })
  }
  fit()
  win.on('resize', fit)
  const page = view.webContents
  let url = firstUrl
  const show = (next: string) => {
    url = next
    const a = addressOf(next)
    if (!win.isDestroyed()) {
      win.setTitle(a.title)
      void win.webContents.executeJavaScript(`window.set && set(${JSON.stringify(a)})`).catch(() => {})
    }
    onUrl(next)
  }
  // the title bar names the site, never what the page calls itself
  win.webContents.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.on('did-finish-load', () => show(url))
  page.on('did-navigate', (_e, next) => show(next))
  page.on('did-navigate-in-page', (_e, next, isMainFrame) => {
    if (isMainFrame) show(next)
  })
  // the page closed itself (window.close()), or you closed the window
  page.on('destroyed', () => !win.isDestroyed() && win.close())
  win.on('closed', () => {
    if (!page.isDestroyed()) page.close()
  })
  win.setTitle(addressOf(firstUrl).title)
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(STRIP_HTML)}`)
  return { win, page }
}
