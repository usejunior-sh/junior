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
    browser: {
      setPane: (sessionId, rect) => ipcRenderer.send('browser:pane', { sessionId, rect }),
      navigate: (sessionId, url) => ipcRenderer.invoke('browser:navigate', { sessionId, url }),
      nav: (sessionId, action) => ipcRenderer.send('browser:nav', { sessionId, action }),
      setViewport: (sessionId, preset, colorScheme) => ipcRenderer.invoke('browser:viewport', { sessionId, preset, colorScheme }),
      state: (sessionId) => ipcRenderer.invoke('browser:state', { sessionId }),
      pick: (sessionId) => ipcRenderer.invoke('browser:pick', { sessionId }),
      cancelPick: (sessionId) => ipcRenderer.send('browser:pick-cancel', { sessionId }),
      devtools: (sessionId) => ipcRenderer.send('browser:devtools', { sessionId }),
      // returns an unsubscribe
      onState: (cb) => {
        const fn = (_e, s) => cb(s)
        ipcRenderer.on('browser:state', fn)
        return () => ipcRenderer.removeListener('browser:state', fn)
      },
      onActivity: (cb) => {
        const fn = (_e, s) => cb(s)
        ipcRenderer.on('browser:activity', fn)
        return () => ipcRenderer.removeListener('browser:activity', fn)
      },
    },
  })
}
