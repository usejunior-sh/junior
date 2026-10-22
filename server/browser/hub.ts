import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  type ColorScheme,
  type DownloadState,
  type HostVerb,
  type PageDialog,
  type ProfileFrame,
  type Viewport,
  BROWSER_WIRE_VERSION,
  parseHostFrame,
} from '../../core/browser/wire.js'
import { DEFAULT_PROFILE, profileOfSigninTab } from '../../core/browser/profiles.js'
import { PageLogBuffer } from '../../core/browser/logs.js'
import type { BrowserTabStore } from '../../core/store/types.js'
import type { BrowserTabInfo, ServerMessage } from '../../shared/protocol.js'
import { log } from '../log.js'
import { browserProfiles } from './profiles.js'

export const NO_HOST =
  'The browser lives in the Junior.app window, and Junior.app is not open (or is too old to host it). Tell the user to open Junior.app, then try again. Until then you cannot see the page.'

/** The presets `browser_viewport` knows; anything else is WxH. */
export const VIEWPORTS: Record<string, Viewport> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
}

/** Longest side of an image the agent gets, in pixels: past ~1568 the API scales it down anyway. */
export const SHOT_LONG = 1280
export const FULL_LONG = 1568
/** Checkpoints and compares are diffed pixel by pixel; smaller is faster and still shows the change. */
export const DIFF_LONG = 1000
export const FULL_PAGE_MAX_CSS = 8000
/**
 * Where Junior.app saves a download a tab made during an agent call: a job's
 * fence lets its run read there. Both sides spell it from the home folder
 * (`~/Downloads/Junior/<tab>`), never Electron's downloads setting, so they
 * can't disagree.
 */
export const downloadDirFor = (tabKey: string) => path.join(os.homedir(), 'Downloads', 'Junior', tabKey)

/** How long a tab's moves wait before they are written down: a redirect chain is one write. */
const PERSIST_MS = 1000

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export type ShotKind = 'screenshot' | 'checkpoint' | 'compare' | 'pick'
export type Shot = {
  n: number
  file: string
  mime: string
  kind: ShotKind
  url: string
  title: string
  /** e.g. "1440×900 desktop" */
  viewport: string
  at: number
  label?: string
  /** the compare's numbers, the element a pick was of */
  note?: string
}

type Checkpoint = { label: string; png: string; snapshot: string; url: string; viewport: Viewport | null; at: number }

export type DownloadNote = { file: string; path: string; bytes: number; state: DownloadState; byAgent: boolean; at: number }

/** What the daemon remembers per session's tab: its logs, whether you touched it, its checkpoints. */
class PageMemory {
  readonly logs = new PageLogBuffer()
  /** you navigated or clicked in the tab since the agent's last call */
  touched = false
  url = ''
  readonly checkpoints = new Map<string, Checkpoint>()
  /** a sign-in window the tab opened, still open */
  popup: { url: string } | null = null
  /** a JavaScript dialog blocking the page */
  dialog: PageDialog | null = null
  /** waiting on the next dialog: input that opens one doesn't return until it is answered */
  readonly dialogWaiters = new Set<(d: PageDialog) => void>()
  /** the user took the tab over: Junior's tools wait until they hand it back */
  heldByUser = false
  /** what Junior is doing with the page right now ("Clicking "Send""), for the pane's driving strip */
  agentStep: string | null = null
  /** downloads the agent hasn't been told about yet */
  downloads: DownloadNote[] = []
  /** sites off this machine the user let this session open (asked once each) */
  readonly sites = new Set<string>()
  /** calls the gate sent to the user's prompt, with why: the session's permission handler must not wave them through */
  readonly asks = new Map<string, string>()

  noteAsk(toolName: string, input: unknown, reason: string) {
    this.asks.set(askKey(toolName, input), reason)
  }

  /** Was this call one the gate asked about? Answers once. */
  takeAsk(toolName: string, input: unknown): string | null {
    const k = askKey(toolName, input)
    const r = this.asks.get(k) ?? null
    this.asks.delete(k)
    return r
  }
}

const askKey = (toolName: string, input: unknown) => `${toolName}\u0000${JSON.stringify(input ?? null)}`

/**
 * Who a tab belongs to: its workspace's store and default, and its session's
 * place on a team run. Found by the resolver `runtime.ts` installs; a
 * profile's sign-in tab has none.
 */
export type TabOwner = {
  store: BrowserTabStore
  /** the workspace's default profile */
  defaultProfile(): Promise<string>
  /** a team worker acts in its lead's profile */
  leadSessionId: string | null
  /** tell the session's workspace (its pane, its chip) */
  broadcast(msg: ServerMessage): void
}

/** The tab as remembered: in memory, written through to the workspace's `browser_tabs`. */
type TabRecord = {
  /** picked for this session; null = follow the default */
  profile: string | null
  url: string
  title: string
  viewport: Viewport | null
  colorScheme: ColorScheme
  updatedAt: number | null
}

const emptyRecord = (): TabRecord => ({ profile: null, url: '', title: '', viewport: null, colorScheme: null, updatedAt: null })

/** The profile a tab ends up in, and whether it fell back from one that was deleted. */
export type ResolvedProfile = { profile: string; explicit: boolean; missing: string | null }

export class BrowserHub {
  private host: WebSocket | null = null
  private hostInfo: { version: number; app: string } | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly pages = new Map<string, PageMemory>()
  /** a job run's profile: used when the session picked none */
  private readonly fallbacks = new Map<string, string>()
  private readonly records = new Map<string, TabRecord>()
  private readonly loading = new Map<string, Promise<TabRecord>>()
  /** tabs open in the app right now */
  private readonly live = new Set<string>()
  private readonly persistTimers = new Map<string, NodeJS.Timeout>()
  private resolver: (sessionId: string) => TabOwner | null = () => null

  constructor(private readonly onStatus: () => void = () => {}) {}

  get status(): { connected: boolean; compatible: boolean; version: number | null } {
    const connected = !!this.host && !!this.hostInfo
    return { connected, compatible: connected && this.hostInfo!.version === BROWSER_WIRE_VERSION, version: this.hostInfo?.version ?? null }
  }

  /** How a tab key finds its owner (installed once, at boot). */
  setResolver(fn: (sessionId: string) => TabOwner | null) {
    this.resolver = fn
  }

  /** A host (Junior.app's main process) connected. The newest wins: a restarted app beats its old socket. */
  attach(ws: WebSocket) {
    if (this.host && this.host !== ws) this.host.close(4000, 'replaced by a newer host')
    this.host = ws
    this.hostInfo = null
    ws.on('message', (data) => this.onFrame(ws, String(data)))
    ws.on('close', () => {
      if (this.host !== ws) return
      this.host = null
      this.hostInfo = null
      this.failAll(NO_HOST)
      for (const id of [...this.live]) this.markClosed(id)
      log('info', 'browser', 'host disconnected')
      this.onStatus()
    })
  }

  private onFrame(ws: WebSocket, raw: string) {
    if (this.host !== ws) return
    const f = parseHostFrame(raw)
    if (!f) return
    switch (f.type) {
      case 'hello':
        this.hostInfo = { version: f.version, app: f.app }
        log('info', 'browser', `host connected (${f.app}, wire v${f.version})`)
        this.onStatus()
        if (this.status.compatible) void this.sendDrops()
        return
      case 'result': {
        const p = this.pending.get(f.id)
        if (!p) return
        this.pending.delete(f.id)
        clearTimeout(p.timer)
        if (f.ok) p.resolve(f.result)
        else p.reject(new Error(f.error))
        return
      }
      case 'log':
        this.page(f.sessionId).logs.push(f.log)
        return
      case 'navigated': {
        const m = this.page(f.sessionId)
        m.url = f.url
        if (f.byUser) m.touched = true
        this.live.add(f.sessionId)
        return
      }
      case 'touched':
        this.page(f.sessionId).touched = true
        return
      case 'closed':
        this.markClosed(f.sessionId)
        return
      case 'tab':
        this.live.add(f.sessionId)
        this.page(f.sessionId).url = f.url
        void this.remember(f.sessionId, { url: f.url, title: f.title, viewport: f.viewport, colorScheme: f.colorScheme })
        return
      case 'popup':
        this.page(f.sessionId).popup = f.state === 'opened' ? { url: f.url } : null
        return
      case 'dialog': {
        const m = this.page(f.sessionId)
        m.dialog = f.dialog
        if (f.dialog) for (const fn of [...m.dialogWaiters]) fn(f.dialog)
        return
      }
      case 'download': {
        const note: DownloadNote = { file: f.file, path: f.path, bytes: f.bytes, state: f.state, byAgent: f.byAgent, at: Date.now() }
        if (f.byAgent) this.page(f.sessionId).downloads.push(note)
        this.resolver(f.sessionId)?.broadcast({ type: 'browser_download', download: { sessionId: f.sessionId, ...note } })
        return
      }
    }
  }

  private markClosed(sessionId: string) {
    const was = this.live.delete(sessionId)
    const m = this.pages.get(sessionId)
    if (m) {
      m.popup = null
      m.dialog = null
    }
    if (was) void this.announce(sessionId)
  }

  private failAll(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  page(sessionId: string): PageMemory {
    let m = this.pages.get(sessionId)
    if (!m) {
      m = new PageMemory()
      this.pages.set(sessionId, m)
    }
    return m
  }

  /** Whether the app has this tab open right now (as far as its frames have said). */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId)
  }

  /** The profile a session's tab uses when nothing else picked one: a job run's own. */
  fallbackProfile(sessionId: string, profile: string) {
    this.fallbacks.set(sessionId, profile)
  }

  /** The session is gone: close its tab and drop what was remembered about it (its row is the session store's to delete). */
  forget(sessionId: string) {
    this.pages.delete(sessionId)
    this.fallbacks.delete(sessionId)
    this.records.delete(sessionId)
    this.live.delete(sessionId)
    const t = this.persistTimers.get(sessionId)
    if (t) clearTimeout(t)
    this.persistTimers.delete(sessionId)
    if (this.status.compatible) void this.call(sessionId, { verb: 'close' }).catch(() => {})
  }

  // ── the tab's record: profile + where it was ─────────────────────────────

  private record(sessionId: string): Promise<TabRecord> {
    const have = this.records.get(sessionId)
    if (have) return Promise.resolve(have)
    let p = this.loading.get(sessionId)
    if (!p) {
      p = (async () => {
        const owner = this.resolver(sessionId)
        const row = owner ? await owner.store.get(sessionId).catch(() => null) : null
        const rec: TabRecord = row ? { profile: row.profile, url: row.url, title: row.title, viewport: row.viewport, colorScheme: row.colorScheme, updatedAt: row.updatedAt } : emptyRecord()
        // a frame may have filled it while the row loaded: the frame is newer
        const raced = this.records.get(sessionId)
        if (raced) return raced
        this.records.set(sessionId, rec)
        return rec
      })().finally(() => this.loading.delete(sessionId))
      this.loading.set(sessionId, p)
    }
    return p
  }

  /** Where the tab is now: remembered in memory at once, written down a moment later, told to its pane. */
  private async remember(sessionId: string, patch: Partial<Omit<TabRecord, 'profile' | 'updatedAt'>>) {
    const rec = await this.record(sessionId)
    Object.assign(rec, patch, { updatedAt: Date.now() })
    const owner = this.resolver(sessionId)
    if (!owner) return
    const t = this.persistTimers.get(sessionId)
    if (t) clearTimeout(t)
    this.persistTimers.set(
      sessionId,
      setTimeout(() => {
        this.persistTimers.delete(sessionId)
        const r = this.records.get(sessionId)
        if (!r) return
        void owner.store
          .put(sessionId, { url: r.url, title: r.title, viewport: r.viewport, colorScheme: r.colorScheme }, r.updatedAt ?? Date.now())
          .catch((err) => log('warn', 'browser', `could not remember a tab: ${err instanceof Error ? err.message : String(err)}`, { session: sessionId }))
      }, PERSIST_MS),
    )
    void this.announce(sessionId)
  }

  private async announce(sessionId: string) {
    const owner = this.resolver(sessionId)
    if (!owner) return
    owner.broadcast({ type: 'browser_tab', tab: await this.tabInfo(sessionId) })
  }

  /**
   * The profile a tab is in: a sign-in tab's own; else the one picked for the
   * session; a team worker's lead's; a job run's; the workspace default;
   * Default. A pick that names a deleted profile falls back, and says so.
   */
  async resolve(sessionId: string, depth = 0): Promise<ResolvedProfile> {
    const profiles = browserProfiles()
    const signin = profileOfSigninTab(sessionId)
    if (signin) return profiles.get(signin) ? { profile: signin, explicit: true, missing: null } : { profile: DEFAULT_PROFILE, explicit: false, missing: signin }
    const owner = this.resolver(sessionId)
    const rec = await this.record(sessionId)
    let missing: string | null = null
    const ok = (id: string | null | undefined): id is string => {
      if (!id) return false
      if (profiles.get(id)) return true
      missing ??= id
      return false
    }
    if (ok(rec.profile)) return { profile: rec.profile, explicit: true, missing: null }
    if (owner?.leadSessionId && depth < 2) {
      const lead = await this.resolve(owner.leadSessionId, depth + 1)
      return { ...lead, explicit: false, missing: missing ?? lead.missing }
    }
    const job = this.fallbacks.get(sessionId)
    if (ok(job)) return { profile: job, explicit: false, missing }
    const def = owner ? await owner.defaultProfile().catch(() => DEFAULT_PROFILE) : DEFAULT_PROFILE
    return { profile: ok(def) ? def : DEFAULT_PROFILE, explicit: false, missing }
  }

  /** A browser call started (its step) or ended (null). Told to the pane, so a job run's strip reads too. */
  setStep(sessionId: string, step: string | null) {
    const m = this.page(sessionId)
    if (m.agentStep === step) return
    m.agentStep = step
    void this.announce(sessionId)
  }

  /** Take over (the user drives, Junior's tools wait) or hand back. Told to the pane. */
  async setHeld(sessionId: string, on: boolean): Promise<BrowserTabInfo> {
    this.page(sessionId).heldByUser = on
    void this.announce(sessionId)
    return this.tabInfo(sessionId)
  }

  /** A profile was deleted: tabs put in it follow their default again (the app closes the ones open in it). */
  unbindProfile(id: string) {
    for (const rec of this.records.values()) if (rec.profile === id) rec.profile = null
  }

  /** What the pane shows about a session's tab. */
  async tabInfo(sessionId: string): Promise<BrowserTabInfo> {
    const rec = await this.record(sessionId)
    const r = await this.resolve(sessionId)
    return {
      sessionId,
      profile: rec.profile,
      effectiveProfile: r.profile,
      url: rec.url,
      title: rec.title,
      viewport: rec.viewport,
      colorScheme: rec.colorScheme,
      live: this.live.has(sessionId),
      heldByUser: this.pages.get(sessionId)?.heldByUser ?? false,
      agentStep: this.pages.get(sessionId)?.agentStep ?? null,
      updatedAt: rec.updatedAt,
    }
  }

  /**
   * Put a session's tab in a profile (null = back to the default). Saved for
   * the session; a tab open in another jar reloads its page in the new one.
   */
  async setProfile(sessionId: string, profile: string | null, opts: { byUser?: boolean } = {}): Promise<BrowserTabInfo> {
    if (profile !== null && !browserProfiles().get(profile)) throw new Error(`No profile "${profile}".`)
    const rec = await this.record(sessionId)
    const before = (await this.resolve(sessionId)).profile
    rec.profile = profile
    rec.updatedAt = Date.now()
    await this.resolver(sessionId)?.store.put(sessionId, { profile }, rec.updatedAt)
    const after = (await this.resolve(sessionId)).profile
    if (after !== before && this.live.has(sessionId) && this.status.compatible && rec.url) {
      // a different identity: history and the page's state don't carry over
      this.page(sessionId).checkpoints.clear()
      if (opts.byUser) this.page(sessionId).touched = true
      await this.call(sessionId, { verb: 'open', url: rec.url, wait: 'load', ...(opts.byUser ? { byUser: true } : {}) }, 45_000).catch(() => {})
    }
    void this.announce(sessionId)
    return this.tabInfo(sessionId)
  }

  /**
   * Open a URL in a session's tab (or, with none, the page it was on when it
   * closed), restoring its viewport and scheme when the tab has to be made.
   */
  async open<T = { url: string; title: string; status: number | null; error?: string }>(
    sessionId: string,
    url: string | null,
    wait: 'load' | 'idle' = 'idle',
    opts: { byUser?: boolean } = {},
  ): Promise<T & { revived: boolean }> {
    const rec = await this.record(sessionId)
    const target = url ?? rec.url
    if (!target) throw new Error('No page to reopen: this tab has never been anywhere.')
    // The app applies it only to a tab this open makes: a live tab keeps the viewport the agent set.
    const restore = rec.updatedAt ? { restore: { viewport: rec.viewport, colorScheme: rec.colorScheme } } : {}
    // You moved the page from the pane: Junior's next call hears about it.
    if (opts.byUser && url !== null) this.page(sessionId).touched = true
    const r = await this.call<T>(sessionId, { verb: 'open', url: target, wait, ...restore, ...(opts.byUser ? { byUser: true } : {}) }, 45_000)
    // used = a page was opened in it (a new profile reads "never" until then)
    browserProfiles().touch((await this.resolve(sessionId)).profile)
    this.live.add(sessionId)
    return { ...r, revived: url === null }
  }

  /** The URL a closed tab would come back to, if it was anywhere. */
  async remembered(sessionId: string): Promise<string> {
    return (await this.record(sessionId)).url
  }

  call<T = unknown>(sessionId: string, verb: HostVerb, timeoutMs = 15_000): Promise<T> {
    const refused = this.refusal()
    if (refused) return Promise.reject(refused)
    return this.resolve(sessionId).then(({ profile }) => this.send<T>({ type: 'call', sessionId, profile, ...verb }, timeoutMs))
  }

  /** Work on a whole profile's jar: its sites, a clear, the wipe of a deleted one. */
  profileCall<T = unknown>(profile: string, op: { op: 'sites' } | { op: 'clear'; site?: string } | { op: 'drop' }, timeoutMs = 20_000): Promise<T> {
    const refused = this.refusal()
    if (refused) return Promise.reject(refused)
    return this.send<T>({ type: 'profile', profile, ...op } as Omit<ProfileFrame, 'id'>, timeoutMs)
  }

  /** Deleted profiles whose jars the app hasn't wiped yet: on every hello. */
  async sendDrops() {
    const profiles = browserProfiles()
    for (const id of profiles.drops()) {
      try {
        await this.profileCall(id, { op: 'drop' })
        await profiles.dropped(id)
        log('info', 'browser', `wiped the cookie jar of deleted profile ${id}`)
      } catch (err) {
        log('warn', 'browser', `could not wipe deleted profile ${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private refusal(): Error | null {
    const ws = this.host
    const st = this.status
    if (!ws || !st.connected || ws.readyState !== WebSocket.OPEN) return new Error(NO_HOST)
    if (!st.compatible) {
      return new Error(`Junior.app speaks browser protocol v${st.version}, this Junior expects v${BROWSER_WIRE_VERSION}. Tell the user to update Junior.app (or the daemon) so they match.`)
    }
    return null
  }

  private send<T>(frame: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const ws = this.host
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(NO_HOST))
    const id = this.nextId++
    const what = String(frame.verb ?? frame.op ?? frame.type)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the browser did not answer within ${Math.round(timeoutMs / 1000)}s (${what})`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ ...frame, id }))
    })
  }
}
