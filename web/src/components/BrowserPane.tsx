/**
 * The browser pane beside a session (.docs/browser.md). The toolbar is ours;
 * the page under it is a native view Triage.app lays over `.bpStage`, so the
 * stage reports where it is, and hides the view whenever one of our own
 * popovers or dialogs would otherwise sit underneath it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, Crosshair, Laptop, Maximize2, Monitor, Moon, RotateCw, Smartphone, SquareTerminal, Sun, SunMoon, Tablet, X, type LucideIcon } from 'lucide-react'
import type { BrowserPickResponse } from '../../../shared/protocol.js'
import { attachImage } from '../attachments.js'
import { browserBridge, browserPane, presetOf, useBrowserState, type BrowserPreset, type ColorScheme, type PaneRect } from '../browser.js'
import { composerDrafts } from '../composerDrafts.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'

const PRESETS: { value: BrowserPreset; label: string; hint: string; Icon: LucideIcon }[] = [
  { value: 'desktop', label: 'Desktop', hint: '1440×900', Icon: Monitor },
  { value: 'laptop', label: 'Laptop', hint: '1280×800', Icon: Laptop },
  { value: 'tablet', label: 'Tablet', hint: '820×1180', Icon: Tablet },
  { value: 'mobile', label: 'Mobile', hint: '390×844', Icon: Smartphone },
  { value: 'fit', label: 'Fit pane', hint: 'pane size', Icon: Maximize2 },
]

/** Things of ours that float, and so would end up hidden under the native view. */
const FLOATING = '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Where the stage is, or null while it is hidden, collapsed, or covered by one of our popovers. */
function useStageRect(sessionId: string) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !browserBridge) return
    let last = ''
    const report = () => {
      const r = el.getBoundingClientRect()
      const covered = [...document.querySelectorAll(FLOATING)].some((f) => !el.contains(f) && overlaps(f.getBoundingClientRect(), r))
      const rect: PaneRect | null =
        covered || r.width < 40 || r.height < 40 || document.visibilityState !== 'visible'
          ? null
          : { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      browserBridge!.setPane(sessionId, rect)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    const mo = new MutationObserver(report)
    mo.observe(document.body, { childList: true, subtree: false })
    window.addEventListener('resize', report)
    document.addEventListener('visibilitychange', report)
    // Panels next to us can move the stage without resizing it.
    const tick = setInterval(report, 400)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', report)
      document.removeEventListener('visibilitychange', report)
      clearInterval(tick)
      browserBridge!.setPane(null, null)
    }
  }, [sessionId])
  return ref
}

export function BrowserPane({ sessionId }: { sessionId: string }) {
  const state = useBrowserState(sessionId)
  const stage = useStageRect(sessionId)
  const [url, setUrl] = useState('')
  const [editing, setEditing] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!editing) setUrl(state.url ?? '')
  }, [state.url, editing])

  const go = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const raw = url.trim()
      if (!raw || !browserBridge) return
      const full = /^[a-z]+:/i.test(raw) ? raw : /^(localhost|127\.|\[::1\]|[\w-]+\.localhost)/.test(raw) ? `http://${raw}` : raw.startsWith('/') ? `http://localhost${raw}` : `https://${raw}`
      setEditing(false)
      void browserBridge.navigate(sessionId, full)
    },
    [url, sessionId],
  )

  const pick = useCallback(async () => {
    if (!browserBridge) return
    if (picking) {
      browserBridge.cancelPick(sessionId)
      return
    }
    setPickError(null)
    setPicking(true)
    try {
      const uid = await browserBridge.pick(sessionId)
      if (uid == null) return
      const r = await fetch('/api/browser/pick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, uid }),
      })
      const body = (await r.json()) as BrowserPickResponse
      if (!body.ok) throw new Error(body.error)
      const draft = composerDrafts.get(sessionId)
      composerDrafts.set(sessionId, `${draft ? `${draft.trimEnd()}\n\n` : ''}${body.text}\n\n`)
      if (body.image) attachImage(sessionId, { mediaType: 'image/png', data: body.image, name: 'picked element' })
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }, [picking, sessionId])

  // Escape ends a pick from anywhere in the triage window.
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') browserBridge?.cancelPick(sessionId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, sessionId])

  if (!browserBridge) {
    return (
      <aside className="browserPane" aria-label="Browser">
        <div className="bpBar">
          <span className="bpTitle">Browser</span>
          <span className="sp" />
          <button type="button" className="btn sm ghost icon" title="Close the browser" onClick={() => browserPane.set(sessionId, false)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="bpEmpty">
          <p className="bpLead">The browser lives in Triage.app.</p>
          <p>Open this session there to watch the agent check its work — and to let it look at all.</p>
        </div>
      </aside>
    )
  }

  const preset = presetOf(state.viewport)
  const scheme: ColorScheme = state.colorScheme ?? null
  const nextScheme: ColorScheme = scheme === null ? 'dark' : scheme === 'dark' ? 'light' : null
  const SchemeIcon = scheme === 'dark' ? Moon : scheme === 'light' ? Sun : SunMoon
  const current = PRESETS.find((p) => p.value === preset)
  const ViewportIcon = current?.Icon ?? Monitor
  const sizeLabel = state.viewport ? `${state.viewport.width}×${state.viewport.height}` : 'pane size'

  return (
    <aside className="browserPane" aria-label="Browser">
      <div className="bpBar">
        <button type="button" className="btn sm ghost icon" title="Back" disabled={!state.canGoBack} onClick={() => browserBridge!.nav(sessionId, 'back')}>
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button type="button" className="btn sm ghost icon" title="Forward" disabled={!state.canGoForward} onClick={() => browserBridge!.nav(sessionId, 'forward')}>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`btn sm ghost icon${state.loading ? ' spin' : ''}`}
          title={state.loading ? 'Stop' : 'Reload'}
          disabled={!state.exists}
          onClick={() => browserBridge!.nav(sessionId, state.loading ? 'stop' : 'reload')}
        >
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <form className="bpUrl" onSubmit={go}>
          <input
            className="mono"
            value={url}
            placeholder="localhost:5173"
            spellCheck={false}
            aria-label="Address"
            onFocus={(e) => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setUrl(state.url ?? '')
                e.currentTarget.blur()
              }
            }}
          />
        </form>
        <Menu>
          <MenuTrigger asChild disabled={!state.exists}>
            <button type="button" className="btn sm ghost icon" title={`Viewport: ${current ? `${current.label} · ${current.hint}` : sizeLabel}`} aria-label="Viewport">
              <ViewportIcon size={14} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent className="bpVpMenu" align="end">
            {PRESETS.map((p) => (
              <MenuItem key={p.value} onSelect={() => void browserBridge!.setViewport(sessionId, p.value)}>
                <p.Icon size={14} aria-hidden="true" />
                <span className="bpVpLabel">{p.label}</span>
                <span className="bpVpHint mono">{p.hint}</span>
                <span className="bpVpCheck">{preset === p.value && <Check size={13} aria-hidden="true" />}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <button
          type="button"
          className="btn sm ghost icon"
          disabled={!state.exists}
          title={`Colour scheme: ${scheme ?? 'the page’s default'} — click for ${nextScheme ?? 'the default'}`}
          onClick={() => void browserBridge!.setViewport(sessionId, '', nextScheme)}
        >
          <SchemeIcon size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`btn sm ghost icon${picking ? ' on' : ''}`}
          disabled={!state.exists}
          title={picking ? 'Picking — click an element on the page (Esc cancels)' : 'Pick an element and hand it to the composer'}
          aria-pressed={picking}
          onClick={() => void pick()}
        >
          <Crosshair size={14} aria-hidden="true" />
        </button>
        <button type="button" className="btn sm ghost icon" disabled={!state.exists} title="Open DevTools for this page" onClick={() => browserBridge!.devtools(sessionId)}>
          <SquareTerminal size={14} aria-hidden="true" />
        </button>
        <span
          className={`bpAgent${state.agentBusy ? ' on' : ''}`}
          title={state.agentBusy ? 'The agent is using this page' : 'The agent is not using the page right now'}
          aria-label={state.agentBusy ? 'Agent is using the page' : 'Agent idle'}
        >
          <span className={`dot${state.agentBusy ? ' live' : ''}`} aria-hidden="true" />
        </span>
        <button type="button" className="btn sm ghost icon" title="Close the browser pane (the page keeps its place)" onClick={() => browserPane.set(sessionId, false)}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {pickError && (
        <div className="bpNote" role="status">
          {pickError}
        </div>
      )}
      <div className="bpStage" ref={stage}>
        {!state.exists && (
          <div className="bpEmpty">
            <p className="bpLead">No page yet.</p>
            <p>
              The agent opens one with <span className="mono">browser_open</span> when it checks its work — or type a local URL
              above. You and the agent see the same page; click into it any time.
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
