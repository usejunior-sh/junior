import type { PageDialog, TabState } from '../../core/browser/wire.js'
import { profileOfSigninTab } from '../../core/browser/profiles.js'
import { formatLogs } from '../../core/browser/logs.js'
import { ShotStore, viewportLabel } from './evidence.js'
import { BrowserHub, pageNumber } from './hub.js'
import { PageDriver, sleep } from './page-driver.js'

// The `browser` MCP server: one per session, bound to that session's tab.

export type BrowserToolContext = {
  hub: BrowserHub
  shots: ShotStore
  sessionId: string
  /** the session's folder: file: URLs inside it count as local */
  projectRoot: string
  /** a chat asks before risky steps; a job run is unattended and is refused them */
  mode: 'chat' | 'job'
  /** a job's `browser_sites`: browser_open outside them is refused */
  sites?: string[]
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }
export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
export const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true })

export const SIGNIN_TAB_REFUSAL = "That is a profile's sign-in tab: only the user uses it. Use this session's own tab."

export const HELD_BY_USER = 'The user took over the browser. Wait for them to hand it back, or ask what they want.'

/** What the agent hears when a dialog blocks the page. */
export const dialogNote = (x: PageDialog) =>
  `A ${x.type} dialog is open: "${x.message}". The page waits until it is answered: use browser_act with action "dialog" and text "accept" or "dismiss".`

/**
 * Run page work, but stop waiting the moment a JavaScript dialog opens: the
 * input that opened it (a click, an Enter) doesn't return until the dialog is
 * answered, and neither does anything else that touches the page.
 */
export async function unlessDialog<T>(d: PageDriver, work: () => Promise<T>): Promise<{ value: T } | { dialog: PageDialog }> {
  const m = d.memory
  if (m.dialog) return { dialog: m.dialog }
  let off = () => {}
  const opened = new Promise<{ dialog: PageDialog }>((resolve) => {
    const fn = (x: PageDialog) => resolve({ dialog: x })
    m.dialogWaiters.add(fn)
    off = () => m.dialogWaiters.delete(fn)
  })
  const done = work().then((value) => ({ value }))
  // left behind when the dialog wins: it settles once the dialog is answered, or times out
  done.catch(() => {})
  try {
    return await Promise.race([done, opened])
  } finally {
    off()
  }
}

/**
 * Wrap a tool body: errors become a plain sentence the agent can act on, and
 * a page you moved is announced. While you hold the tab, or a dialog blocks
 * the page, the body doesn't run: it would only wait (`duringDialog` for the
 * tools that work anyway: the one that answers it, and the logs).
 */
export function guarded(ctx: BrowserToolContext, body: (d: PageDriver) => Promise<ToolResult>, opts: { duringDialog?: boolean } = {}): () => Promise<ToolResult> {
  return async () => {
    // A profile's sign-in tab is yours alone: no tool ever drives it.
    if (profileOfSigninTab(ctx.sessionId)) return fail(SIGNIN_TAB_REFUSAL)
    // the session's active page: page 1, or the one browser_open newPage / browser_page switched to
    const d = new PageDriver(ctx.hub, ctx.hub.activeKey(ctx.sessionId))
    if (ctx.hub.page(ctx.sessionId).heldByUser) return fail(HELD_BY_USER)
    if (d.memory.dialog && !opts.duringDialog) return text(dialogNote(d.memory.dialog))
    try {
      const touched = d.memory.touched
      d.memory.touched = false
      const r = await body(d)
      if (touched) r.content.unshift({ type: 'text', text: 'Note: the user used this tab since your last call — the page may not be where you left it.' })
      if (d.revived) r.content.unshift({ type: 'text', text: `Reopened ${d.revived}: the tab had closed.` })
      const notes = pageNotes(d)
      if (notes) r.content.push({ type: 'text', text: notes })
      const pages = pagesNote(ctx, d.sessionId)
      if (pages) r.content.push({ type: 'text', text: pages })
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

export async function pressKey(d: PageDriver, combo: string) {
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

/** With more than one page open: which one this was, so the agent never loses track. */
export function pagesNote(ctx: BrowserToolContext, key: string): string {
  const keys = ctx.hub.pageKeys(ctx.sessionId)
  if (keys.length < 2) return ''
  const list = keys.map((k) => {
    const n = pageNumber(k)
    const host = (() => {
      try {
        return new URL(ctx.hub.page(k).url).hostname
      } catch {
        return 'blank'
      }
    })()
    return k === key ? `[${n}: ${host}]` : `${n}: ${host}`
  })
  return `Page ${pageNumber(key)} of ${keys.length} (pages ${list.join(', ')}). browser_page switches or closes them.`
}

/** What else is going on with the tab: a sign-in window, a dialog, downloads (each said once). */
export function pageNotes(d: PageDriver): string {
  const m = d.memory
  const out: string[] = []
  if (m.popup) out.push(`A sign-in window is open (${m.popup.url}). Junior can't use it: ask the user to finish signing in, then carry on.`)
  if (m.dialog) out.push(dialogNote(m.dialog))
  for (const dl of m.downloads.splice(0)) {
    out.push(
      dl.state === 'completed'
        ? `Downloaded ${dl.file} (${Math.max(1, Math.round(dl.bytes / 1024))} KB) to ${dl.path}.`
        : dl.state === 'refused'
          ? `The page tried to download ${dl.file}; that kind of file is refused.`
          : `The download of ${dl.file} ${dl.state === 'cancelled' ? 'was cancelled' : 'failed'}.`,
    )
  }
  return out.join('\n')
}

/** After an action: let it land, wait out a navigation it started, and say what changed. */
export async function settle(d: PageDriver, before: TabState): Promise<string> {
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
  const d = new PageDriver(ctx.hub, ctx.hub.activeKey(ctx.sessionId))
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

export const lineDiff = (before: string, after: string) => {
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

export const VERIFY_LOOP = `Use this to check UI work before you call it done: open the page → browser_snapshot to find elements (uids) → browser_act on uids → browser_screenshot at desktop AND mobile (browser_viewport; a new tab fits the user's pane, which is no particular size) → browser_logs for errors. Before your first UI edit, browser_checkpoint; after, browser_compare. Never claim a visual change you did not screenshot.`
