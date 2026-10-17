import { WebSocket } from 'ws'
import { type Viewport, BROWSER_WIRE_VERSION, parseHostFrame, type HostVerb } from '../../core/browser/wire.js'
import { PageLogBuffer } from '../../core/browser/logs.js'
import { log } from '../log.js'

export const NO_HOST =
  'The browser lives in the Triage.app window, and Triage.app is not open (or is too old to host it). Tell the user to open Triage.app, then try again. Until then you cannot see the page.'

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

/** What the daemon remembers per session's tab: its logs, whether you touched it, its checkpoints. */
class PageMemory {
  readonly logs = new PageLogBuffer()
  /** you navigated or clicked in the tab since the agent's last call */
  touched = false
  url = ''
  readonly checkpoints = new Map<string, Checkpoint>()
}

export class BrowserHub {
  private host: WebSocket | null = null
  private hostInfo: { version: number; app: string } | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly pages = new Map<string, PageMemory>()

  constructor(private readonly onStatus: () => void = () => {}) {}

  get status(): { connected: boolean; compatible: boolean; version: number | null } {
    const connected = !!this.host && !!this.hostInfo
    return { connected, compatible: connected && this.hostInfo!.version === BROWSER_WIRE_VERSION, version: this.hostInfo?.version ?? null }
  }

  /** A host (Triage.app's main process) connected. The newest wins: a restarted app beats its old socket. */
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
        return
      }
      case 'touched':
        this.page(f.sessionId).touched = true
        return
      case 'closed':
        return
    }
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

  /** The session is gone: close its tab and drop what was remembered about it. */
  forget(sessionId: string) {
    this.pages.delete(sessionId)
    if (this.status.compatible) void this.call(sessionId, { verb: 'close' }).catch(() => {})
  }

  call<T = unknown>(sessionId: string, verb: HostVerb, timeoutMs = 15_000): Promise<T> {
    const ws = this.host
    const st = this.status
    if (!ws || !st.connected || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(NO_HOST))
    if (!st.compatible) {
      return Promise.reject(
        new Error(`Triage.app speaks browser protocol v${st.version}, this triage expects v${BROWSER_WIRE_VERSION}. Tell the user to update Triage.app (or the daemon) so they match.`),
      )
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the browser did not answer within ${Math.round(timeoutMs / 1000)}s (${verb.verb})`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ type: 'call', id, sessionId, ...verb }))
    })
  }
}
