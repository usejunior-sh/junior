import fsp from 'node:fs/promises'
import path from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabState, Viewport } from '../../core/browser/wire.js'
import { formatLogs } from '../../core/browser/logs.js'
import { BROWSER_SERVER, resolveUrl } from '../../core/browser/policy.js'
import { decodePng, diffImages, encodePng } from '../../core/browser/image.js'
import { shotMarker, viewportLabel } from './evidence.js'
import { DIFF_LONG, FULL_LONG, SHOT_LONG, VIEWPORTS } from './hub.js'
import { PageDriver, sleep } from './page-driver.js'
import { type BrowserToolContext, VERIFY_LOOP, fail, formatInspected, guarded, inspectElement, lineDiff, pressKey, settle, text } from './tool-kit.js'

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
