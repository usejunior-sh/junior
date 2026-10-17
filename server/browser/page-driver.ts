import type { TabState } from '../../core/browser/wire.js'
import { type AXNode, formatSnapshot } from '../../core/browser/snapshot.js'
import { BrowserHub, FULL_PAGE_MAX_CSS } from './hub.js'

// ---------------------------------------------------------------------------
// One session's page, driven: the CDP sequences every tool is built from.
// ---------------------------------------------------------------------------

type Quad = number[]
type LayoutMetrics = {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
  cssContentSize: { width: number; height: number }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
