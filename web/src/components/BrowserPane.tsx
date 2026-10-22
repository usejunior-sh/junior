/**
 * The browser pane (.docs/browser.md): beside a chat, or alone in Settings →
 * Browser as a profile's sign-in tab. The toolbar is ours; the page under it
 * is a native view Junior.app lays over `.bpStage`, so the stage reports
 * where it is, and hides the view whenever one of our own popovers, our error
 * page or a drag of the split would otherwise sit underneath it.
 *
 * A tab is opened over HTTP (the daemon names its profile, then tells the
 * app); everything that acts on a tab that exists (back, reload, viewport,
 * pick, find) goes straight to the app.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardCopy,
  Crosshair,
  Eraser,
  ExternalLink,
  Laptop,
  Monitor,
  Moon,
  MoreHorizontal,
  RotateCw,
  Search,
  Scan,
  Smartphone,
  SquareTerminal,
  Sun,
  SunMoon,
  Tablet,
  X,
  ArrowUp,
  type LucideIcon,
} from 'lucide-react'
import { siteOf, profileOfSigninTab } from '../../../core/browser/profiles.js'
import type { BrowserPickResponse } from '../../../shared/protocol.js'
import { attachImage } from '../attachments.js'
import {
  browserBridge,
  browserPane,
  clearProfile,
  openTab,
  presetOf,
  profileById,
  profileSites,
  setTabProfile,
  setTakeover,
  useBrowserDownload,
  useBrowserProfiles,
  useBrowserState,
  useBrowserTab,
  type BrowserPreset,
  type ColorScheme,
} from '../browser.js'
import { composerDrafts } from '../composerDrafts.js'
import { useEvents } from '../hooks.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { AddressField, type AddressFieldHandle } from './browser/AddressField.js'
import { ConfirmDialog } from './browser/ConfirmDialog.js'
import { useDriving, useFrozenFrame, useSplit, useStageRect } from './browser/paneHooks.js'
import { lastBrowserStep } from './browser/steps.js'
import { EmptyState, ErrorState, RevivingState } from './browser/PaneStates.js'
import { ProfileChipStatic, ProfileMenu } from './browser/ProfileMenu.js'

const PRESETS: { value: BrowserPreset; label: string; hint: string; Icon: LucideIcon }[] = [
  { value: 'desktop', label: 'Desktop', hint: '1440×900', Icon: Monitor },
  { value: 'laptop', label: 'Laptop', hint: '1280×800', Icon: Laptop },
  { value: 'tablet', label: 'Tablet', hint: '820×1180', Icon: Tablet },
  { value: 'mobile', label: 'Mobile', hint: '390×844', Icon: Smartphone },
  { value: 'fit', label: 'Fit pane', hint: 'pane size', Icon: Scan },
]

const SCHEMES: { value: string; label: string; Icon: LucideIcon }[] = [
  { value: 'system', label: 'System', Icon: SunMoon },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'light', label: 'Light', Icon: Sun },
]

/** How long "Saved report.csv" stays when nothing else moves it on. */
const DOWNLOAD_SHOW_MS = 10_000
/** Room under an emulated page for its size caption. */
const CAPTION_H = 22

const isBlank = (url: string | undefined) => !url || url === 'about:blank'

type Props = {
  /** a session id, or `profile-<id>` for a profile's sign-in tab */
  tabKey: string
  /** a sign-in tab's own Close (a chat's pane closes itself) */
  onClose?: () => void
  /**
   * Watching a job run beside its transcript: no split, no pick (there is no
   * composer), no revive (the run owns its tab), and the profile is the job's.
   */
  embedded?: boolean
  /** a chat's pane: open a terminal in its project (the error page's "Open a terminal") */
  onTerminal?: () => void
}

/** A line under the toolbar: an error (red), or a plain confirmation. */
type Note = { text: string; ok?: boolean }

export function BrowserPane({ tabKey, onClose, embedded = false, onTerminal }: Props) {
  const signinProfile = profileOfSigninTab(tabKey)
  const signin = signinProfile !== null
  const sessionId = signin ? null : tabKey
  const chat = !signin && !embedded

  const state = useBrowserState(tabKey)
  const tab = useBrowserTab(tabKey)
  const snap = useBrowserProfiles()
  const download = useBrowserDownload(tabKey)
  const events = useEvents(sessionId)

  const paneRef = useRef<HTMLElement>(null)
  const address = useRef<AddressFieldHandle>(null)
  const split = useSplit(paneRef)
  const busy = useDriving(!signin && !!state.agentBusy)
  const driving = busy && !tab?.heldByUser
  // The daemon names the step when it knows the element (`Clicking "Send"`); the log is the fallback.
  const agentStep = tab?.agentStep ?? null
  const step = useMemo(() => (driving ? agentStep ?? lastBrowserStep(events) : null), [driving, agentStep, events])

  const [note, setNoteRaw] = useState<Note | null>(null)
  const setNote = useCallback((text: string | null, ok = false) => setNoteRaw(text ? { text, ok } : null), [])
  // The URL being opened, for the address field while the tab still says about:blank.
  const [pending, setPending] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [reviving, setReviving] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)

  const error = state.exists && state.error ? state.error : null
  // A first load from about:blank paints the Mac's theme, not ours: keep the page away until it commits.
  const opening = state.exists && !!state.loading && isBlank(state.url)
  // An emulated size gets a caption under the page; Fit fills the stage.
  const emulated = state.exists && !error && !!state.viewport
  const capturing = useRef<Promise<unknown> | null>(null)
  const { ref: stage, covered } = useStageRect(tabKey, !!error || split.dragging || opening, driving ? 2 : 0, emulated ? CAPTION_H : 0, capturing)
  const { frame, freeze } = useFrozenFrame(tabKey, covered, capturing)
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight - CAPTION_H }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage])

  const profileId = signinProfile ?? tab?.effectiveProfile ?? state.profile ?? snap?.workspaceDefault ?? 'default'
  const profile = profileById(snap, profileId)

  // The sites this profile is signed in to, for the empty state's one-click rows.
  const [sites, setSites] = useState<string[]>([])
  const connected = !!snap?.app.connected
  useEffect(() => {
    if (!connected || state.exists) return
    let live = true
    void profileSites(profileId).then((b) => {
      if (live) setSites(b.ok ? b.sites.map((s) => s.site) : [])
    })
    return () => {
      live = false
    }
  }, [profileId, connected, state.exists])

  const open = useCallback(
    async (url?: string) => {
      setNote(null)
      setPending(url ?? null)
      const b = await openTab(tabKey, url)
      if (!b.ok) setNote(b.error)
    },
    [tabKey, setNote],
  )
  // The tab got somewhere real: it says where it is from now on.
  useEffect(() => {
    if (!isBlank(state.url)) setPending(null)
  }, [state.url])

  // Revive: a chat whose tab closed (idle, an app or daemon restart) gets its
  // page back in its profile, at its viewport, without anyone asking.
  const revived = useRef(false)
  useEffect(() => {
    if (!chat || revived.current || !browserBridge || !state.known || state.exists || !tab?.url) return
    revived.current = true
    setReviving(tab.url)
    void open().finally(() => setReviving(null))
    setPending(tab.url)
  }, [chat, state.known, state.exists, tab?.url, open])

  // Take over: Junior's browser calls on this tab wait until you hand it back.
  // A job run is unattended: holding its tab would only fail the run, so only a chat offers it.
  const held = chat && !!tab?.heldByUser
  const takeover = useCallback(
    async (on: boolean) => {
      setNote(null)
      const b = await setTakeover(tabKey, on)
      if (!b.ok) setNote(b.error)
    },
    [tabKey],
  )

  const switchProfile = useCallback(
    async (id: string) => {
      setNote(null)
      const b = await setTabProfile(tabKey, id)
      if (!b.ok) setNote(b.error)
    },
    [tabKey],
  )

  const pick = useCallback(async () => {
    if (!browserBridge || !sessionId) return
    if (picking) {
      browserBridge.cancelPick(sessionId)
      return
    }
    setNote(null)
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
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }, [picking, sessionId])

  // Escape ends a pick from anywhere in the junior window.
  useEffect(() => {
    if (!picking || !sessionId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') browserBridge?.cancelPick(sessionId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, sessionId])

  // "Saved report.csv" goes after 10s or the next page, whichever is first; a failed one stays.
  useEffect(() => {
    if (download?.state !== 'completed') return
    const t = setTimeout(() => setDismissed(download.at), DOWNLOAD_SHOW_MS)
    return () => clearTimeout(t)
  }, [download])
  const urlSeen = useRef(state.url)
  useEffect(() => {
    if (state.url === urlSeen.current) return
    urlSeen.current = state.url
    if (download?.state === 'completed') setDismissed(download.at)
  }, [state.url, download])

  const canFind = !!browserBridge?.find
  // ⌘L and ⌘F pressed inside the page come back from the app (it already did
  // ⌘R and ⌘[ ⌘] itself); the same two work on our toolbar.
  const onShortcut = useCallback(
    (key: 'focus-url' | 'find') => {
      if (key === 'focus-url') address.current?.focus()
      else setFindOpen(canFind && state.exists)
    },
    [canFind, state.exists],
  )
  useEffect(
    () =>
      browserBridge?.onKey?.((k) => {
        if (k.tabKey === tabKey && (k.key === 'focus-url' || k.key === 'find')) onShortcut(k.key)
      }),
    [tabKey, onShortcut],
  )

  if (!browserBridge) {
    return (
      <aside className="browserPane" aria-label="Browser">
        <div className="bpBar">
          <span className="bpTitle">Browser</span>
          <span className="sp" />
          <button type="button" className="btn sm ghost icon" title="Close the browser" onClick={() => (onClose ? onClose() : browserPane.set(tabKey, false))}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="bpEmpty">
          <p className="bpLead">The browser lives in Junior.app.</p>
          <p>Open this chat there to watch Junior check its work.</p>
        </div>
      </aside>
    )
  }

  const preset = presetOf(state.viewport)
  const scheme: ColorScheme = state.colorScheme ?? null
  const current = PRESETS.find((p) => p.value === preset)
  const ViewportIcon = current?.Icon ?? Monitor
  const sizeLabel = state.viewport ? `${state.viewport.width}×${state.viewport.height}` : 'pane size'
  const url = state.url ?? ''
  const lastUrl = !state.exists ? tab?.url || null : null
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  const showDownload = download && download.at !== dismissed
  const shownUrl = error?.url ?? (state.loading && isBlank(url) ? pending ?? tab?.url ?? url : url)
  const popupHost = (() => {
    try {
      return state.popup ? new URL(state.popup.url).host : ''
    } catch {
      return ''
    }
  })()
  const vp = state.viewport
  const scale = vp && stageSize ? Math.min(1, stageSize.w / vp.width, stageSize.h / vp.height) : 1

  return (
    <aside
      ref={paneRef}
      className={`browserPane${signin ? ' signin' : ''}${embedded ? ' embedded' : ''}`}
      aria-label="Browser"
      style={chat ? { flexBasis: `${(split.fraction * 100).toFixed(2)}%` } : undefined}
      onKeyDown={(e) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey) return
        if (e.key === 'l') {
          e.preventDefault()
          onShortcut('focus-url')
        } else if (e.key === 'f' && canFind && state.exists) {
          e.preventDefault()
          onShortcut('find')
        }
      }}
    >
      {chat && (
        <div
          className="bpResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the browser (double-click to reset)"
          title="Drag to resize · double-click to reset"
          tabIndex={0}
          {...split.handleProps}
        />
      )}
      <div className="bpBar">
        {!chat ? (
          <ProfileChipStatic profile={profile} />
        ) : (
          <ProfileMenu
            snap={snap}
            current={profileId}
            disabledReason={driving ? 'Take over first to switch profiles.' : null}
            onPick={(id) => void switchProfile(id)}
            onPress={freeze}
          />
        )}
        <button type="button" className="btn sm ghost icon bpNavBtn" title="Back" disabled={!state.canGoBack} onClick={() => browserBridge!.nav(tabKey, 'back')}>
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button type="button" className="btn sm ghost icon bpNavBtn" title="Forward" disabled={!state.canGoForward} onClick={() => browserBridge!.nav(tabKey, 'forward')}>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn sm ghost icon"
          title={state.loading ? 'Stop' : 'Reload'}
          disabled={!state.exists}
          onClick={() => (error ? void open(error.url) : browserBridge!.nav(tabKey, state.loading ? 'stop' : 'reload'))}
        >
          {state.loading ? <X size={14} aria-hidden="true" /> : <RotateCw size={14} aria-hidden="true" />}
        </button>
        {findOpen ? (
          <FindBar tabKey={tabKey} onClose={() => setFindOpen(false)} />
        ) : (
          <AddressField ref={address} url={shownUrl} onGo={(u) => void open(u)} />
        )}
        {chat && (
          <button
            type="button"
            className={`btn sm ghost icon${picking ? ' on' : ''}`}
            disabled={!state.exists}
            title={picking ? 'Picking: click an element on the page (Esc cancels)' : 'Pick an element and hand it to the composer'}
            aria-pressed={picking}
            onClick={() => void pick()}
          >
            <Crosshair size={14} aria-hidden="true" />
          </button>
        )}
        {!signin && (
        <Menu>
          <MenuTrigger asChild disabled={!state.exists}>
            <button type="button" className="btn sm ghost icon" title={`Viewport: ${current ? `${current.label} · ${current.hint}` : sizeLabel}`} aria-label="Viewport" onPointerDown={freeze}>
              <ViewportIcon size={14} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent className="bpVpMenu" align="end">
            {PRESETS.map((p) => (
              <MenuItem key={p.value} onSelect={() => void browserBridge!.setViewport(tabKey, p.value)}>
                <p.Icon size={14} aria-hidden="true" />
                <span className="bpVpLabel">{p.label}</span>
                <span className="bpVpHint mono">{p.hint}</span>
                <span className="bpVpCheck">{preset === p.value && <Check size={13} aria-hidden="true" />}</span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <DropdownMenu.Label className="bpMenuGroup">colour scheme</DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={scheme ?? 'system'}
              onValueChange={(v) => void browserBridge!.setViewport(tabKey, '', v === 'system' ? null : (v as ColorScheme))}
            >
              {SCHEMES.map((s) => (
                <DropdownMenu.RadioItem key={s.value} value={s.value} className="uiMenuItem">
                  <s.Icon size={14} aria-hidden="true" />
                  <span className="bpVpLabel">{s.label}</span>
                  <span className="bpVpCheck">
                    <DropdownMenu.ItemIndicator>
                      <Check size={13} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </MenuContent>
        </Menu>
        )}
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="btn sm ghost icon" title="More" aria-label="More" onPointerDown={freeze}>
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent className="bpMoreMenu" align="end">
            {canFind && (
              <MenuItem disabled={!state.exists} onSelect={() => setFindOpen(true)}>
                <Search size={14} aria-hidden="true" />
                Find in page
                <span className="k">⌘F</span>
              </MenuItem>
            )}
            <MenuItem disabled={!url} onSelect={() => void navigator.clipboard?.writeText(url).catch(() => {})}>
              <ClipboardCopy size={14} aria-hidden="true" />
              Copy address
            </MenuItem>
            <MenuItem disabled={!/^https?:/.test(url)} onSelect={() => window.open(url, '_blank', 'noopener')}>
              <ExternalLink size={14} aria-hidden="true" />
              Open in your browser
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={!host || !connected} onSelect={() => setConfirmClear(siteOf(host))}>
              <Eraser size={14} aria-hidden="true" />
              Clear this site's data
            </MenuItem>
            <MenuItem disabled={!state.exists} onSelect={() => browserBridge!.devtools(tabKey)}>
              <SquareTerminal size={14} aria-hidden="true" />
              Developer tools
            </MenuItem>
          </MenuContent>
        </Menu>
        {/* A sign-in tab already has its way back (← Profiles) above it. */}
        {!signin && (
          <button
            type="button"
            className="btn sm ghost icon"
            title={chat ? 'Close the browser (the page keeps its place)' : 'Close'}
            onClick={() => (onClose ? onClose() : browserPane.set(tabKey, false))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <Progress loading={!!state.loading} />
      </div>
      {held ? (
        <div className="bpStrip wheel" role="status">
          <b>You have the page.</b>
          <span className="step">Junior waits.</span>
          <span className="sp" />
          <button type="button" className="btn sm" onClick={() => void takeover(false)}>
            Hand back
          </button>
        </div>
      ) : (
        driving && (
          <div className="bpStrip drive" role="status">
            <span className="dot live" aria-hidden="true" />
            <b>Junior is driving</b>
            {step && <span className="step">{step}</span>}
            <span className="sp" />
            {chat && (
              <button type="button" className="btn sm" onClick={() => void takeover(true)}>
                Take over
              </button>
            )}
          </div>
        )
      )}
      {state.popup && (
        <div className="bpStrip wait" role="status">
          <span className="step">{popupHost ? `Finish signing in to ${popupHost} in the window that opened.` : 'Finish signing in in the window that opened.'}</span>
          <span className="sp" />
          {browserBridge.focusPopup && (
            <button type="button" className="btn sm" onClick={() => browserBridge!.focusPopup!(tabKey)}>
              Show window
            </button>
          )}
        </div>
      )}
      {state.dialog && (
        <div className="bpStrip wait" role="status">
          <span className="step">{`The page opened a dialog: "${state.dialog.message}"`}</span>
        </div>
      )}
      {showDownload && (
        <div className={`bpStrip ${download.state === 'completed' ? 'done' : 'warn'}`} role="status">
          <span className="step">
            {download.state === 'completed' ? (
              <>
                Saved <span className="mono">{download.file}</span>
              </>
            ) : download.state === 'refused' ? (
              <>
                Junior didn't save <span className="mono">{download.file}</span>.
              </>
            ) : (
              <>
                <span className="mono">{download.file}</span> didn't finish downloading.
              </>
            )}
          </span>
          <span className="sp" />
          {download.state === 'completed' && browserBridge.reveal && (
            <button type="button" className="btn sm ghost" onClick={() => browserBridge!.reveal!(download.path)}>
              Show in Finder
            </button>
          )}
          <button type="button" className="btn sm ghost icon" title="Dismiss" onClick={() => setDismissed(download.at)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {note && (
        <div className={`bpNote${note.ok ? ' ok' : ''}`} role="status">
          <span>{note.text}</span>
          <button type="button" className="btn sm ghost icon" title="Dismiss" onClick={() => setNote(null)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className={`bpStage${driving ? ' driving' : ''}`} ref={stage}>
        {error ? (
          <ErrorState
            code={error.code}
            url={error.url}
            onReload={() => void open(error.url)}
            onEdit={() => address.current?.focus()}
            onTerminal={chat ? onTerminal : undefined}
            onAskJunior={chat && sessionId ? () => composerDrafts.set(sessionId, 'Start the dev server for this project.') : undefined}
          />
        ) : !state.exists ? (
          reviving ? (
            <RevivingState url={reviving} />
          ) : (
            <EmptyState profile={profile} lastUrl={lastUrl} sites={sites.length ? sites : profile?.sites ?? []} signin={signin} onOpen={(u) => void open(u)} />
          )
        ) : opening ? (
          pending || tab?.url ? <RevivingState url={(pending ?? tab?.url)!} verb="Opening" /> : null
        ) : null}
        {frame && !error && <img className="bpFrozen" src={frame} alt="" aria-hidden="true" />}
        {emulated && vp && (
          <span className="bpVpCaption mono">
            {vp.width}×{vp.height}
            {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={confirmClear !== null}
        title={`Sign out of ${confirmClear ?? ''} in ${profile?.name ?? 'this profile'}?`}
        body="This clears its cookies and storage."
        confirm="Clear"
        danger
        onConfirm={async () => {
          if (!confirmClear) return
          const b = await clearProfile(profileId, confirmClear)
          if (b.ok) setNote(`Signed out of ${confirmClear} in ${profile?.name ?? 'this profile'}.`, true)
          else setNote(b.error)
        }}
        onClose={() => setConfirmClear(null)}
      />
    </aside>
  )
}

/** The 2px bar on the toolbar's bottom hairline: quick to 30%, easing toward 85%, full on load, then gone. */
function Progress({ loading }: { loading: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>(loading ? 'loading' : 'idle')
  useEffect(() => {
    if (loading) {
      setPhase('loading')
      return
    }
    setPhase((p) => (p === 'loading' ? 'done' : p))
    const t = setTimeout(() => setPhase('idle'), 500)
    return () => clearTimeout(t)
  }, [loading])
  return <span className={`bpProgress ${phase}`} aria-hidden="true" />
}

/** ⌘F: the address field makes way for a find bar on the page. */
function FindBar({ tabKey, onClose }: { tabKey: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const [found, setFound] = useState<{ matches: number; active: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const off = browserBridge?.onFound?.((f) => f.tabKey === tabKey && setFound({ matches: f.matches, active: f.active }))
    return () => {
      off?.()
      browserBridge?.stopFind?.(tabKey)
    }
  }, [tabKey])

  const find = (next: string, opts?: { forward?: boolean }) => {
    if (!next) {
      browserBridge?.stopFind?.(tabKey)
      setFound(null)
      return
    }
    browserBridge?.find?.(tabKey, next, opts)
  }

  return (
    <div className="bpFind" role="search">
      <Search size={12} className="bpMark" aria-hidden="true" />
      <input
        ref={input}
        value={text}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          find(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            find(text, { forward: !e.shiftKey })
          }
        }}
      />
      {found && text && <span className="bpFindCount mono">{found.matches ? `${found.active} of ${found.matches}` : 'No matches'}</span>}
      <button type="button" className="btn sm ghost icon" title="Previous" disabled={!text} onClick={() => find(text, { forward: false })}>
        <ArrowUp size={13} aria-hidden="true" />
      </button>
      <button type="button" className="btn sm ghost icon" title="Next" disabled={!text} onClick={() => find(text, { forward: true })}>
        <ArrowDown size={13} aria-hidden="true" />
      </button>
      <button type="button" className="btn sm ghost icon" title="Close (Esc)" onClick={onClose}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
