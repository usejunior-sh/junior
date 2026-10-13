/**
 * The browser, daemon side (.docs/browser.md). Triage.app hosts the tabs — one
 * per session — and runs CDP commands on them; this module is everything
 * above that: the host connection, the `browser` MCP server each chat gets,
 * page logs per session, and the evidence (screenshots, checkpoints, diffs)
 * kept on disk under the workspace.
 *
 * Scope is enforced here, not asked for: a session's tools only ever name
 * that session's tab, and the app only attaches a debugger to tabs.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { BROWSER_WIRE_VERSION, parseHostFrame, type HostVerb, type TabState, type Viewport } from '../core/browser/wire.js'
import { formatSnapshot, type AXNode } from '../core/browser/snapshot.js'
import { formatLogs, PageLogBuffer } from '../core/browser/logs.js'
import { BROWSER_SERVER, resolveUrl } from '../core/browser/policy.js'
import { decodePng, diffImages, encodePng } from '../core/browser/image.js'
import { log } from './log.js'

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
const SHOT_LONG = 1280
const FULL_LONG = 1568
/** Checkpoints and compares are diffed pixel by pixel; smaller is faster and still shows the change. */
const DIFF_LONG = 1000
const FULL_PAGE_MAX_CSS = 8000

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

// ---------------------------------------------------------------------------
// One session's page, driven: the CDP sequences every tool is built from.
// ---------------------------------------------------------------------------

type Quad = number[]
type LayoutMetrics = {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
  cssContentSize: { width: number; height: number }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class PageDriver {
  constructor(
    readonly hub: BrowserHub,
    readonly sessionId: string,
  ) {}

  get memory() {
    return this.hub.page(this.sessionId)
  }

  cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.hub.call<T>(this.sessionId, { verb: 'cdp', method, ...(params ? { params } : {}) }, timeoutMs)
  }

  state(): Promise<TabState> {
    return this.hub.call<TabState>(this.sessionId, { verb: 'state' })
  }

  /** The tab, or a plain error telling the agent to open a page first. */
  async requirePage(): Promise<TabState> {
    const s = await this.state()
    if (!s.exists) throw new Error('No page is open in this session yet — call browser_open with a URL first.')
    return s
  }

  async evalValue<T = unknown>(expression: string): Promise<T> {
    const r = await this.cdp<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script threw')
    return r.result.value as T
  }

  /** Run a function with the element as `this`. */
  async onElement<T = unknown>(uid: number, fn: string, args: unknown[] = []): Promise<T> {
    const { object } = await this.resolve(uid)
    const r = await this.cdp<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.callFunctionOn',
      { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script threw')
    return r.result.value as T
  }

  async resolve(uid: number): Promise<{ object: { objectId: string } }> {
    try {
      return await this.cdp('DOM.resolveNode', { backendNodeId: uid })
    } catch {
      throw new Error(`uid=${uid} is no longer on the page (it re-rendered or navigated) — take a fresh browser_snapshot.`)
    }
  }

  /** Scroll the element into view and return its centre in viewport CSS pixels. */
  async centerOf(uid: number): Promise<{ x: number; y: number }> {
    await this.resolve(uid)
    await this.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: uid }).catch(() => {})
    const { quads } = await this.cdp<{ quads: Quad[] }>('DOM.getContentQuads', { backendNodeId: uid }).catch(() => ({ quads: [] as Quad[] }))
    const q = quads.find((q) => area(q) > 1)
    if (!q) throw new Error(`uid=${uid} has no visible box (hidden, collapsed or zero-size) — it can't be clicked.`)
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
  }

  /** The element's box in page CSS pixels (for an element screenshot). */
  async boxOf(uid: number, pad = 0): Promise<{ x: number; y: number; width: number; height: number }> {
    await this.resolve(uid)
    await this.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: uid }).catch(() => {})
    const { quads } = await this.cdp<{ quads: Quad[] }>('DOM.getContentQuads', { backendNodeId: uid }).catch(() => ({ quads: [] as Quad[] }))
    const { model } = await this.cdp<{ model: { border: Quad } }>('DOM.getBoxModel', { backendNodeId: uid }).catch(() => ({ model: { border: quads[0] } }))
    const q = model?.border ?? quads[0]
    if (!q) throw new Error(`uid=${uid} has no visible box.`)
    const m = await this.cdp<LayoutMetrics>('Page.getLayoutMetrics')
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    const x = Math.max(0, Math.min(...xs) + m.cssVisualViewport.pageX - pad)
    const y = Math.max(0, Math.min(...ys) + m.cssVisualViewport.pageY - pad)
    return { x, y, width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 }
  }

  flash(uid: number) {
    void this.hub.call(this.sessionId, { verb: 'flash', backendNodeId: uid }).catch(() => {})
  }

  async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel', x: number, y: number, extra: Record<string, unknown> = {}) {
    await this.cdp('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' || type === 'mouseWheel' ? {} : { button: 'left', clickCount: 1 }), ...extra })
  }

  async snapshot(rootUid?: number): Promise<string> {
    const { nodes } = await this.cdp<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', {}, 20_000)
    return formatSnapshot(nodes, { ...(rootUid != null ? { rootUid } : {}) }).text
  }

  /**
   * A screenshot, sized for the agent: the viewport, the whole page, or one
   * element. `long` caps the longest side in output pixels.
   */
  async capture(opts: { target: 'viewport' | 'full' | { uid: number; pad?: number }; format: 'webp' | 'png'; long: number }): Promise<{ data: string; width: number; height: number }> {
    const m = await this.cdp<LayoutMetrics>('Page.getLayoutMetrics')
    const dpr = (await this.evalValue<number>('window.devicePixelRatio').catch(() => 1)) || 1
    let clip: { x: number; y: number; width: number; height: number }
    let beyond = false
    if (opts.target === 'viewport') {
      clip = { x: m.cssVisualViewport.pageX, y: m.cssVisualViewport.pageY, width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight }
    } else if (opts.target === 'full') {
      clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, FULL_PAGE_MAX_CSS) }
      beyond = true
    } else {
      clip = await this.boxOf(opts.target.uid, opts.target.pad ?? 0)
      beyond = true
    }
    if (clip.width < 1 || clip.height < 1) throw new Error('nothing to capture: the area is empty')
    const scale = Math.min(1, opts.long / (Math.max(clip.width, clip.height) * dpr))
    const r = await this.cdp<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: opts.format,
        ...(opts.format === 'webp' ? { quality: 82 } : {}),
        clip: { ...clip, scale },
        captureBeyondViewport: beyond,
        fromSurface: true,
      },
      30_000,
    )
    return { data: r.data, width: Math.round(clip.width * scale * dpr), height: Math.round(clip.height * scale * dpr) }
  }
}

const area = (q: Quad) => Math.abs((q[0] * q[3] - q[2] * q[1] + (q[2] * q[5] - q[4] * q[3]) + (q[4] * q[7] - q[6] * q[5]) + (q[6] * q[1] - q[0] * q[7])) / 2)

export const viewportLabel = (v: Viewport | null): string => {
  if (!v) return 'fit to pane'
  const name = Object.entries(VIEWPORTS).find(([, p]) => p.width === v.width && p.height === v.height)?.[0]
  return `${v.width}×${v.height}${name ? ` ${name}` : v.mobile ? ' mobile' : ''}`
}

// ---------------------------------------------------------------------------
// Evidence: what the agent saw, kept per session on disk.
// ---------------------------------------------------------------------------

export class ShotStore {
  constructor(readonly root: string) {}

  dir(sessionId: string) {
    if (!/^[\w-]+$/.test(sessionId)) throw new Error('bad session id')
    return path.join(this.root, sessionId)
  }

  list(sessionId: string): Shot[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(sessionId), 'shots.json'), 'utf8')) as Shot[]
    } catch {
      return []
    }
  }

  async add(sessionId: string, data: Buffer, mime: string, meta: Omit<Shot, 'n' | 'file' | 'mime' | 'at'>): Promise<Shot> {
    const dir = this.dir(sessionId)
    await fsp.mkdir(dir, { recursive: true })
    const shots = this.list(sessionId)
    const n = (shots.at(-1)?.n ?? 0) + 1
    const file = `${n}.${mime === 'image/png' ? 'png' : 'webp'}`
    await fsp.writeFile(path.join(dir, file), data)
    const shot: Shot = { n, file, mime, at: Date.now(), ...meta }
    shots.push(shot)
    await fsp.writeFile(path.join(dir, 'shots.json'), JSON.stringify(shots, null, 1))
    return shot
  }

  file(sessionId: string, n: number): { path: string; mime: string } | null {
    const s = this.list(sessionId).find((x) => x.n === n)
    return s ? { path: path.join(this.dir(sessionId), s.file), mime: s.mime } : null
  }

  async remove(sessionId: string) {
    await fsp.rm(this.dir(sessionId), { recursive: true, force: true }).catch(() => {})
  }

  turns(sessionId: string): VerifiedTurn[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(sessionId), 'turns.json'), 'utf8')) as VerifiedTurn[]
    } catch {
      return []
    }
  }

  /** A turn that used the browser ended: remember which shots it took and what the agent said. */
  async addTurn(sessionId: string, turn: VerifiedTurn): Promise<VerifiedTurn[]> {
    const turns = [...this.turns(sessionId), turn]
    await fsp.mkdir(this.dir(sessionId), { recursive: true })
    await fsp.writeFile(path.join(this.dir(sessionId), 'turns.json'), JSON.stringify(turns, null, 1))
    return turns
  }
}

export type VerifiedTurn = { startedAt: number; endedAt: number; summary: string; shots: number[] }

export const shotUrl = (workspaceId: string, sessionId: string, n: number) =>
  `/api/browser/shots/${sessionId}/${n}?workspace=${encodeURIComponent(workspaceId)}`

const KIND_LABEL: Record<ShotKind, string> = { screenshot: 'Screenshot', checkpoint: 'Checkpoint', compare: 'Compare', pick: 'Picked' }

/**
 * The Verification note (.docs/browser.md, Proof): every turn that used the
 * browser, newest first — what the agent said it did, and the screenshots,
 * checkpoints and diffs it took to see it. Rewritten after each such turn.
 */
export function renderVerification(o: { title: string; workspaceId: string; sessionId: string; turns: VerifiedTurn[]; shots: Shot[] }): string {
  const byN = new Map(o.shots.map((s) => [s.n, s]))
  const when = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 16)
  const parts: string[] = [
    `What the agent looked at in the browser while it worked, turn by turn. Screenshots are what the agent itself saw; compares show red where pixels changed since the checkpoint.`,
  ]
  for (const t of [...o.turns].reverse()) {
    const shots = t.shots.map((n) => byN.get(n)).filter((s): s is Shot => !!s)
    if (!shots.length) continue
    parts.push(`## ${when(t.endedAt)} UTC`)
    const summary = t.summary.trim()
    if (summary) parts.push(summary.length > 1500 ? `${summary.slice(0, 1500)}…` : summary)
    const urls = [...new Set(shots.map((s) => s.url))]
    parts.push(`Pages: ${urls.map((u) => `\`${u}\``).join(', ')}`)
    for (const s of shots) {
      const label = [KIND_LABEL[s.kind], s.label ? `“${s.label}”` : '', s.viewport, s.note ?? ''].filter(Boolean).join(' · ')
      parts.push(`**#${s.n}** ${label}\n\n![${KIND_LABEL[s.kind]} ${s.n}](${shotUrl(o.workspaceId, o.sessionId, s.n)})`)
    }
  }
  return parts.join('\n\n') + '\n'
}

/** The marker a tool result carries so the transcript can show the saved shot. */
export const shotMarker = (n: number) => `[shot #${n}]`
export const SHOT_MARKER_RE = /\[shot #(\d+)\]/g

// ---------------------------------------------------------------------------
// The `browser` MCP server: one per session, bound to that session's tab.
// ---------------------------------------------------------------------------

export type BrowserToolContext = {
  hub: BrowserHub
  shots: ShotStore
  sessionId: string
  /** the session's folder: file: URLs inside it count as local */
  projectRoot: string
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true })

/** Wrap a tool body: errors become a plain sentence the agent can act on, and a page you moved is announced. */
function guarded(ctx: BrowserToolContext, body: (d: PageDriver) => Promise<ToolResult>): () => Promise<ToolResult> {
  return async () => {
    const d = new PageDriver(ctx.hub, ctx.sessionId)
    try {
      const touched = d.memory.touched
      d.memory.touched = false
      const r = await body(d)
      if (touched) r.content.unshift({ type: 'text', text: 'Note: the user used this tab since your last call — the page may not be where you left it.' })
      return r
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string; key?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }

async function pressKey(d: PageDriver, combo: string) {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  const keyName = parts.pop() ?? ''
  let modifiers = 0
  for (const p of parts) {
    const bit = MODIFIERS[p]
    if (bit == null) throw new Error(`unknown modifier "${p}" — use Alt, Control, Meta or Shift`)
    modifiers |= bit
  }
  let k = KEYS[keyName]
  if (!k) {
    if (keyName.length !== 1) throw new Error(`unknown key "${keyName}" — use a single character or one of ${Object.keys(KEYS).join(', ')}`)
    const up = keyName.toUpperCase()
    k = { code: /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(up) ? `Digit${up}` : '', keyCode: up.charCodeAt(0), text: keyName, key: keyName }
  }
  const key = k.key ?? keyName
  // A shortcut types nothing: Meta+a selects, it doesn't insert an "a".
  const textOut = modifiers & (2 | 4) ? undefined : k.text
  await d.cdp('Input.dispatchKeyEvent', {
    type: textOut ? 'keyDown' : 'rawKeyDown',
    key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    modifiers,
    ...(textOut ? { text: textOut, unmodifiedText: textOut } : {}),
  })
  await d.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers })
}

/** After an action: let it land, wait out a navigation it started, and say what changed. */
async function settle(d: PageDriver, before: TabState): Promise<string> {
  await sleep(250)
  let s = await d.state()
  const until = Date.now() + 10_000
  while (s.loading && Date.now() < until) {
    await sleep(150)
    s = await d.state()
  }
  const lines: string[] = []
  if (s.url !== before.url) lines.push(`Navigated to ${s.url} — "${s.title}".`)
  else if (s.title !== before.title) lines.push(`Title is now "${s.title}".`)
  if (s.loading) lines.push('The page is still loading.')
  const fresh = d.memory.logs.since('action', 'warning')
  if (fresh.length) lines.push(`Since this action:\n${formatLogs(fresh)}`)
  else lines.push('No new console errors or failed requests.')
  return lines.join('\n')
}

const STYLE_PROPS = [
  'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius', 'gap',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
  'color', 'background-color', 'background-image', 'opacity', 'box-shadow', 'outline', 'overflow',
  'flex-direction', 'justify-content', 'align-items', 'grid-template-columns', 'z-index', 'transform', 'visibility', 'cursor',
]
const NOISE: Record<string, string[]> = {
  'background-image': ['none'],
  'box-shadow': ['none'],
  transform: ['none'],
  outline: ['none', 'rgb(0, 0, 0) none 0px'],
  'text-transform': ['none'],
  'letter-spacing': ['normal'],
  visibility: ['visible'],
  'z-index': ['auto'],
  cursor: ['auto'],
  opacity: ['1'],
  gap: ['normal'],
  'grid-template-columns': ['none'],
}
const INSPECT_FN = `function(props){
  const s = getComputedStyle(this), r = this.getBoundingClientRect(), out = {}
  for (const p of props) out[p] = s.getPropertyValue(p)
  const cls = typeof this.className === 'string' ? this.className.trim().split(/\\s+/).filter(Boolean).slice(0, 6).join('.') : ''
  return { tag: this.tagName.toLowerCase() + (this.id ? '#' + this.id : '') + (cls ? '.' + cls : ''),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    text: (this.innerText || this.value || '').trim().slice(0, 80), style: out }
}`
const SELECTOR_FN = `function(){
  const seg = (el) => {
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id
    let s = el.tagName.toLowerCase()
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter((c) => c && !/^[0-9]|[:[\\]]/.test(c)).slice(0, 2) : []
    if (cls.length) s += '.' + cls.join('.')
    const p = el.parentElement
    if (p) { const same = [...p.children].filter((c) => c.tagName === el.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')' }
    return s
  }
  const parts = []; let el = this
  for (let i = 0; el && el.nodeType === 1 && i < 5; i++) { const s = seg(el); parts.unshift(s); if (s.startsWith('#')) break; el = el.parentElement }
  return parts.join(' > ')
}`

type Inspected = { tag: string; rect: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> }

export async function inspectElement(d: PageDriver, uid: number): Promise<Inspected> {
  return d.onElement<Inspected>(uid, INSPECT_FN, [STYLE_PROPS])
}

export function formatInspected(uid: number, i: Inspected): string {
  const style = STYLE_PROPS.map((k) => [k, i.style[k] ?? ''] as const)
    .filter(([k, v]) => v !== '' && !(NOISE[k] ?? []).includes(v))
    .map(([k, v]) => `  ${k}: ${v}`)
  return [
    `uid=${uid} <${i.tag}>${i.text ? ` "${i.text}"` : ''}`,
    `box: ${i.rect.width}×${i.rect.height} at (${i.rect.x}, ${i.rect.y}) in the viewport`,
    ...style,
  ].join('\n')
}

/**
 * What `Pick` in the pane hands the composer: the element described in words
 * an agent can find again, plus a crop of it with a little context.
 */
export async function describePicked(ctx: BrowserToolContext, uid: number): Promise<{ text: string; image: string | null; shot: number | null }> {
  const d = new PageDriver(ctx.hub, ctx.sessionId)
  const s = await d.requirePage()
  const [info, selector, ax, vp] = await Promise.all([
    inspectElement(d, uid),
    d.onElement<string>(uid, SELECTOR_FN).catch(() => ''),
    d.snapshot(uid).catch(() => ''),
    Promise.resolve(viewportLabel(s.viewport)),
  ])
  const st = info.style
  const head = ax.split('\n')[0]?.replace(/^\s*uid=\d+\s*/, '') || `<${info.tag}>`
  const text = [
    `[Picked in the browser] ${head}`,
    `selector: ${selector || info.tag}`,
    `page: ${s.url} · ${vp}`,
    `box: ${info.rect.width}×${info.rect.height} at (${info.rect.x}, ${info.rect.y}) · font ${st['font-size']}/${st['line-height']} ${st['font-weight']} ${st['font-family']?.split(',')[0] ?? ''} · color ${st.color} · background ${st['background-color']} · padding ${st.padding} · radius ${st['border-radius']}`,
    `uid=${uid} (valid while the element is on the page)`,
  ].join('\n')
  let image: string | null = null
  let shot: number | null = null
  try {
    const cap = await d.capture({ target: { uid, pad: 24 }, format: 'png', long: 800 })
    image = cap.data
    shot = (await ctx.shots.add(ctx.sessionId, Buffer.from(cap.data, 'base64'), 'image/png', { kind: 'pick', url: s.url, title: s.title, viewport: vp, note: head })).n
  } catch {
    // a description without the crop still points at the right element
  }
  return { text, image, shot }
}

const lineDiff = (before: string, after: string) => {
  const norm = (t: string) => t.split('\n').map((l) => l.replace(/uid=\d+\s*/, '').trimEnd()).filter(Boolean)
  const a = norm(before)
  const b = norm(after)
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())
  const ca = count(a)
  const cb = count(b)
  const added = b.filter((x) => {
    const n = ca.get(x) ?? 0
    if (n > 0) {
      ca.set(x, n - 1)
      return false
    }
    return true
  })
  const removed = a.filter((x) => {
    const n = cb.get(x) ?? 0
    if (n > 0) {
      cb.set(x, n - 1)
      return false
    }
    return true
  })
  return { added, removed }
}

const VERIFY_LOOP = `Use this to check UI work before you call it done: open the page → browser_snapshot to find elements (uids) → browser_act on uids → browser_screenshot at desktop AND mobile (browser_viewport) → browser_logs for errors. Before your first UI edit, browser_checkpoint; after, browser_compare. Never claim a visual change you did not screenshot.`

export function makeBrowserMcp(ctx: BrowserToolContext) {
  const uid = z.number().int().describe('an element uid from browser_snapshot')
  const meta = async (d: PageDriver, s: TabState) => ({ url: s.url, title: s.title, viewport: viewportLabel(s.viewport) })

  return createSdkMcpServer({
    name: BROWSER_SERVER,
    version: '1',
    tools: [
      tool(
        'browser_open',
        `Open a URL in this session's browser tab (Triage.app's browser pane — the user watches the same page). Local URLs (localhost, 127.0.0.1, *.localhost, file: in the project) open without asking; a bare path like "/settings" is resolved against the current page. ${VERIFY_LOOP}`,
        {
          url: z.string().describe('http(s)://localhost:5173/settings, localhost:3000, /settings, or a file: URL'),
          wait: z.enum(['load', 'idle']).optional().describe('idle (default) also waits for the network to go quiet — for apps that fetch after load'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const cur = (await d.state().catch(() => null))?.url
            const url = resolveUrl(args.url, cur)
            if (!url) return fail(`"${args.url}" is not a URL this browser can open.`)
            d.memory.logs.markLoad()
            const r = await ctx.hub.call<{ url: string; title: string; status: number | null; error?: string }>(
              ctx.sessionId,
              { verb: 'open', url, wait: args.wait ?? 'idle' },
              45_000,
            )
            d.memory.url = r.url
            if (r.error) {
              const refused = /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(r.error)
              return fail(
                refused
                  ? `Nothing answered at ${url} (${r.error}). Is the dev server running? Start it (e.g. in the background with Bash) and open the URL again.`
                  : `Loading ${url} failed: ${r.error}`,
              )
            }
            const s = await d.state()
            const errs = d.memory.logs.errorsSinceLoad()
            return text(
              [
                `Loaded ${r.url} — "${r.title}"${r.status ? ` (HTTP ${r.status})` : ''}.`,
                `Viewport: ${viewportLabel(s.viewport)}.`,
                errs ? `${errs} console error${errs === 1 ? '' : 's'} since load — read them with browser_logs.` : 'No console errors since load.',
              ].join('\n'),
            )
          })(),
      ),

      tool(
        'browser_snapshot',
        'The page as an accessibility tree: one line per element, with a uid for anything you can act on. Cheaper and more exact than a screenshot for finding things; use a screenshot to judge how it looks.',
        { uid: uid.optional().describe('snapshot only this element and what is inside it') },
        async (args) =>
          guarded(ctx, async (d) => {
            const s = await d.requirePage()
            const snap = await d.snapshot(args.uid)
            return text(`${s.url} — "${s.title}" · ${viewportLabel(s.viewport)}\n${snap}`)
          })(),
      ),

      tool(
        'browser_screenshot',
        'See the page: the viewport (default), the full scrolling page, or one element. The image is saved as evidence the user can see on this session.',
        {
          target: z.enum(['viewport', 'full']).optional(),
          uid: uid.optional().describe('capture just this element'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const s = await d.requirePage()
            const target = args.uid != null ? { uid: args.uid, pad: 8 } : (args.target ?? 'viewport')
            const cap = await d.capture({ target, format: 'webp', long: target === 'full' ? FULL_LONG : SHOT_LONG })
            const m = await meta(d, s)
            const shot = await ctx.shots.add(ctx.sessionId, Buffer.from(cap.data, 'base64'), 'image/webp', {
              kind: 'screenshot',
              ...m,
              ...(args.uid != null ? { note: `uid=${args.uid}` } : target === 'full' ? { note: 'full page' } : {}),
            })
            if (args.uid != null) d.flash(args.uid)
            return {
              content: [
                { type: 'image', data: cap.data, mimeType: 'image/webp' },
                { type: 'text', text: `${m.url} · ${m.viewport} · ${cap.width}×${cap.height}px ${shotMarker(shot.n)}` },
              ],
            }
          })(),
      ),

      tool(
        'browser_act',
        'Do one thing on the page, like a user: click, type (replaces the field\'s text), press a key (Enter, Tab, Escape, Meta+a…), hover, scroll, or select an <option>. Target elements by uid from browser_snapshot. Returns what changed (navigation, new console errors) — take a snapshot or screenshot to see the result.',
        {
          action: z.enum(['click', 'type', 'press', 'hover', 'scroll', 'select']),
          uid: uid.optional().describe('the element; required for click, type, hover, select'),
          text: z.string().optional().describe('type: the text; press: the key; select: the option label or value'),
          submit: z.boolean().optional().describe('type: press Enter afterwards'),
          dy: z.number().optional().describe('scroll: pixels down (negative = up); default one screen'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const before = await d.requirePage()
            const need = (what: string) => {
              if (args.uid == null) throw new Error(`${args.action} needs a uid — find it with browser_snapshot.`)
              if (what && args.text == null) throw new Error(`${args.action} needs text (${what}).`)
              return args.uid
            }
            d.memory.logs.markAction()
            switch (args.action) {
              case 'click': {
                const u = need('')
                const p = await d.centerOf(u)
                d.flash(u)
                await d.mouse('mouseMoved', p.x, p.y)
                await d.mouse('mousePressed', p.x, p.y)
                await d.mouse('mouseReleased', p.x, p.y)
                break
              }
              case 'hover': {
                const u = need('')
                const p = await d.centerOf(u)
                d.flash(u)
                await d.mouse('mouseMoved', p.x, p.y)
                break
              }
              case 'type': {
                const u = need('what to type')
                await d.centerOf(u)
                d.flash(u)
                await d.cdp('DOM.focus', { backendNodeId: u }).catch(() => {
                  throw new Error(`uid=${u} can't take focus — is it a text field?`)
                })
                await d.onElement(
                  u,
                  `function(){ if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r) } }`,
                )
                if (args.text) await d.cdp('Input.insertText', { text: args.text })
                else await pressKey(d, 'Backspace')
                if (args.submit) await pressKey(d, 'Enter')
                break
              }
              case 'press':
                if (!args.text) throw new Error('press needs text: the key, e.g. "Enter" or "Meta+a".')
                if (args.uid != null) await d.cdp('DOM.focus', { backendNodeId: args.uid }).catch(() => {})
                await pressKey(d, args.text)
                break
              case 'scroll': {
                if (args.uid != null && args.dy == null) {
                  await d.centerOf(args.uid)
                  d.flash(args.uid)
                  break
                }
                const vh = await d.evalValue<number>('innerHeight').catch(() => 800)
                const center = await d.evalValue<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })')
                await d.mouse('mouseWheel', center.x, center.y, { deltaX: 0, deltaY: args.dy ?? Math.round(vh * 0.85) })
                break
              }
              case 'select': {
                const u = need('the option label or value')
                d.flash(u)
                const picked = await d.onElement<string | null>(
                  u,
                  `function(want){
                    if (this.tagName !== 'SELECT') return null
                    const o = [...this.options].find((o) => o.value === want || o.label.trim() === want || o.text.trim() === want)
                    if (!o) return ''
                    this.value = o.value
                    this.dispatchEvent(new Event('input', { bubbles: true }))
                    this.dispatchEvent(new Event('change', { bubbles: true }))
                    return o.label || o.value
                  }`,
                  [args.text],
                )
                if (picked === null) throw new Error(`uid=${u} is not a <select>; click it and pick the option instead.`)
                if (picked === '') throw new Error(`uid=${u} has no option "${args.text}".`)
                break
              }
            }
            return text(await settle(d, before))
          })(),
      ),

      tool(
        'browser_logs',
        'Console errors and warnings, uncaught exceptions and failed requests (HTTP ≥ 400, network errors) — since your last action by default.',
        {
          since: z.enum(['action', 'load', 'all']).optional(),
          level: z.enum(['error', 'warning', 'all']).optional().describe('default: warnings and errors'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            await d.requirePage()
            return text(formatLogs(d.memory.logs.since(args.since ?? 'action', args.level ?? 'warning')))
          })(),
      ),

      tool(
        'browser_viewport',
        'Lay the page out at another size: desktop (1440×900), laptop (1280×800), tablet (820×1180), mobile (390×844, touch), or "WxH". Optionally force dark or light. Check every UI change at desktop and mobile.',
        {
          size: z.string().describe('desktop | laptop | tablet | mobile | e.g. 1024x768'),
          colorScheme: z.enum(['dark', 'light', 'default']).optional(),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            await d.requirePage()
            const key = args.size.trim().toLowerCase()
            let vp: Viewport | undefined = VIEWPORTS[key]
            if (!vp) {
              const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(key)
              if (!m) return fail(`"${args.size}" is not a size — use desktop, laptop, tablet, mobile or WxH.`)
              const width = Number(m[1])
              const height = Number(m[2])
              vp = { width, height, deviceScaleFactor: width < 768 ? 2 : 1, mobile: width < 768 }
            }
            const scheme = args.colorScheme === 'default' ? null : args.colorScheme
            await ctx.hub.call(ctx.sessionId, { verb: 'viewport', viewport: vp, ...(scheme !== undefined ? { colorScheme: scheme } : {}) })
            await sleep(200)
            const s = await d.state()
            return text(`Viewport: ${viewportLabel(s.viewport)}${s.colorScheme ? `, ${s.colorScheme} scheme` : ''}.`)
          })(),
      ),

      tool(
        'browser_inspect',
        'The numbers behind how an element looks: its box, font, colours, spacing, radius, layout — computed, after every stylesheet. Use it to check a design value exactly instead of guessing from a screenshot.',
        { uid },
        async (args) =>
          guarded(ctx, async (d) => {
            await d.requirePage()
            d.flash(args.uid)
            return text(formatInspected(args.uid, await inspectElement(d, args.uid)))
          })(),
      ),

      tool(
        'browser_eval',
        'Run a JavaScript expression in the page and get its JSON value back (promises are awaited). For what the other tools can\'t read; asks the user first unless the session runs without prompts.',
        { expression: z.string() },
        async (args) =>
          guarded(ctx, async (d) => {
            await d.requirePage()
            const v = await d.evalValue(args.expression)
            const out = v === undefined ? 'undefined' : JSON.stringify(v, null, 1)
            return text(out.length > 4000 ? `${out.slice(0, 4000)}… (${out.length} chars)` : out)
          })(),
      ),

      tool(
        'browser_checkpoint',
        'Remember how the page looks now (screenshot + snapshot) under a label, to compare against after your change. Take one before your first UI edit; one per viewport if you check several.',
        { label: z.string().optional().describe('default "before"') },
        async (args) =>
          guarded(ctx, async (d) => {
            const s = await d.requirePage()
            const label = (args.label ?? 'before').trim() || 'before'
            const [cap, snap] = await Promise.all([d.capture({ target: 'viewport', format: 'png', long: DIFF_LONG }), d.snapshot()])
            const m = await meta(d, s)
            const shot = await ctx.shots.add(ctx.sessionId, Buffer.from(cap.data, 'base64'), 'image/png', { kind: 'checkpoint', label, ...m })
            d.memory.checkpoints.set(label, { label, png: path.join(ctx.shots.dir(ctx.sessionId), shot.file), snapshot: snap, url: s.url, viewport: s.viewport, at: Date.now() })
            return text(`Checkpoint "${label}" saved: ${m.url} at ${m.viewport} ${shotMarker(shot.n)}. After your change, call browser_compare("${label}").`)
          })(),
      ),

      tool(
        'browser_compare',
        'Compare the page now against a checkpoint: what share of pixels changed and where (highlighted image), and which elements appeared, went or changed. Same viewport as the checkpoint.',
        { label: z.string().optional().describe('default "before"') },
        async (args) =>
          guarded(ctx, async (d) => {
            const s = await d.requirePage()
            const label = (args.label ?? 'before').trim() || 'before'
            const cp = d.memory.checkpoints.get(label)
            if (!cp) {
              const have = [...d.memory.checkpoints.keys()]
              return fail(`No checkpoint "${label}"${have.length ? ` — this session has: ${have.join(', ')}` : ' — take one with browser_checkpoint first'}.`)
            }
            const notes: string[] = []
            if (JSON.stringify(cp.viewport) !== JSON.stringify(s.viewport)) {
              await ctx.hub.call(ctx.sessionId, { verb: 'viewport', viewport: cp.viewport })
              await sleep(250)
              notes.push(`Switched back to the checkpoint's viewport (${viewportLabel(cp.viewport)}).`)
            }
            if (cp.url !== s.url) notes.push(`Careful: the checkpoint was of ${cp.url}; the page is now ${s.url}.`)
            const [cap, snap] = await Promise.all([d.capture({ target: 'viewport', format: 'png', long: DIFF_LONG }), d.snapshot()])
            const before = decodePng(await fsp.readFile(cp.png))
            const after = decodePng(Buffer.from(cap.data, 'base64'))
            const diff = diffImages(before, after)
            const png = encodePng(diff.image)
            const dpr = after.width / Math.max(1, (cp.viewport ?? s.viewport)?.width ?? after.width)
            const regions = diff.boxes.map((b) => {
              const k = dpr > 0 ? 1 / dpr : 1
              return `${Math.round(b.width * k)}×${Math.round(b.height * k)} at (${Math.round(b.x * k)}, ${Math.round(b.y * k)})`
            })
            const { added, removed } = lineDiff(cp.snapshot, snap)
            const m = await meta(d, await d.state())
            const summary = diff.changedPct === 0 ? 'no visible change' : `${diff.changedPct}% of pixels changed`
            const shot = await ctx.shots.add(ctx.sessionId, png, 'image/png', { kind: 'compare', label, ...m, note: summary })
            const lines = [
              ...notes,
              `Compared with "${label}": ${summary}${diff.sizeChanged ? ' (the page size changed)' : ''}. ${shotMarker(shot.n)}`,
              regions.length ? `Changed regions (CSS px, largest first): ${regions.join('; ')}` : '',
              added.length ? `Appeared or changed (${added.length}):\n${added.slice(0, 25).map((l) => `+ ${l.trim()}`).join('\n')}` : '',
              removed.length ? `Gone or changed (${removed.length}):\n${removed.slice(0, 25).map((l) => `- ${l.trim()}`).join('\n')}` : '',
              !added.length && !removed.length ? 'The accessibility tree is the same.' : '',
              'In the image: red = changed pixels, yellow boxes = changed regions, the rest dimmed.',
            ].filter(Boolean)
            return {
              content: [
                { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
                { type: 'text', text: lines.join('\n') },
              ],
            }
          })(),
      ),
    ],
  })
}
