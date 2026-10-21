// The renderer's door to the main process. CommonJS because sandboxed
// preloads can't be ES modules. The splash (file:) gets retry/log/status; the
// quick-capture window (file:) gets submit/close; the web UI gets only what its
// desktop chrome needs: ← → and their state, and the browser pane's controls.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:' && location.pathname.endsWith('/capture.html')) {
  contextBridge.exposeInMainWorld('triageCapture', {
    // resolves { ok: true } | { ok: false, error }
    submit: (title) => ipcRenderer.invoke('capture:submit', title),
    close: () => ipcRenderer.send('capture:close'),
    onOpen: (cb) => ipcRenderer.on('capture:open', () => cb()),
  })
}

else if (location.protocol === 'file:') {
  const arg = process.argv.find((a) => a.startsWith('--triage-version='))
  contextBridge.exposeInMainWorld('triageDesktop', {
    platform: 'darwin',
    version: arg ? arg.slice('--triage-version='.length) : '',
    retry: () => ipcRenderer.send('splash:retry'),
    openLog: () => ipcRenderer.send('splash:open-log'),
    // { state: 'starting' | 'error', text, detail? }, the latest is replayed on load
    onStatus: (cb) => ipcRenderer.on('splash:status', (_e, s) => cb(s)),
  })
}

else {
  const on = (channel, cb) => {
    const fn = (_e, s) => cb(s)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.removeListener(channel, fn)
  }
  contextBridge.exposeInMainWorld('triageDesktop', {
    platform: 'darwin',
    chrome: 'mac',
    back: () => ipcRenderer.send('nav:back'),
    forward: () => ipcRenderer.send('nav:forward'),
    navState: () => ipcRenderer.invoke('nav:state'),
    // { canGoBack, canGoForward, fullscreen } after every navigation; returns an unsubscribe
    onNav: (cb) => {
      const fn = (_e, s) => cb(s)
      ipcRenderer.on('nav:state', fn)
      return () => ipcRenderer.removeListener('nav:state', fn)
    },
    // The browser pane (.docs/browser.md): the page itself is a native view
    // laid over the pane's rect; this is only its remote control.
    // A tab is made only by the daemon (POST /api/browser/tabs/:id/open), which
    // names its profile; these act on a tab that exists. `tabKey` is a session
    // id, or `profile-<id>` for a profile's sign-in tab in Settings.
    browser: {
      setPane: (tabKey, rect) => ipcRenderer.send('browser:pane', { sessionId: tabKey, rect }),
      nav: (tabKey, action) => ipcRenderer.send('browser:nav', { sessionId: tabKey, action }),
      setViewport: (tabKey, preset, colorScheme) => ipcRenderer.invoke('browser:viewport', { sessionId: tabKey, preset, colorScheme }),
      state: (tabKey) => ipcRenderer.invoke('browser:state', { sessionId: tabKey }),
      pick: (tabKey) => ipcRenderer.invoke('browser:pick', { sessionId: tabKey }),
      cancelPick: (tabKey) => ipcRenderer.send('browser:pick-cancel', { sessionId: tabKey }),
      devtools: (tabKey) => ipcRenderer.send('browser:devtools', { sessionId: tabKey }),
      // opts: { forward? }. The same text again goes to the next match, new text
      // starts over, empty text clears; matches arrive through onFound.
      find: (tabKey, text, opts) => ipcRenderer.send('browser:find', { sessionId: tabKey, text, forward: opts?.forward }),
      stopFind: (tabKey) => ipcRenderer.send('browser:find-stop', { sessionId: tabKey }),
      // a still of the page as a PNG data URL (null without a tab), for the pane's frozen frame under a menu
      capture: (tabKey) => ipcRenderer.invoke('browser:capture', { sessionId: tabKey }),
      // bring the tab's sign-in window to the front
      focusPopup: (tabKey) => ipcRenderer.send('browser:focus-popup', { sessionId: tabKey }),
      // Show in Finder, for a download: anything outside ~/Downloads is ignored
      reveal: (path) => ipcRenderer.send('browser:reveal', { path }),
      // each returns an unsubscribe
      onState: (cb) => on('browser:state', cb),
      onActivity: (cb) => on('browser:activity', cb),
      // { tabKey, matches, active }
      onFound: (cb) => on('browser:found', cb),
      // { tabKey, key: 'focus-url' | 'find' | 'reload' | 'back' | 'forward' }, pressed in the page.
      // reload, back and forward already happened; focus-url and find are the pane's to do.
      onKey: (cb) => on('browser:key', cb),
    },
  })
}
