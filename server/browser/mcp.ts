import fsp from 'node:fs/promises'
import path from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SiteCookies, TabState, Viewport } from '../../core/browser/wire.js'
import { formatLogs } from '../../core/browser/logs.js'
import { BROWSER_SERVER, type ElementFacts, isLocalUrl, resolveUrl } from '../../core/browser/policy.js'
import { hostAllowed, profileOfSigninTab, siteOf } from '../../core/browser/profiles.js'
import { stepText, stepUid } from '../../core/browser/steps.js'
import { browserProfiles } from './profiles.js'
import { decodePng, diffImages, encodePng } from '../../core/browser/image.js'
import { shotMarker, viewportLabel } from './evidence.js'
import { DIFF_LONG, FULL_LONG, SHOT_LONG, VIEWPORTS } from './hub.js'
import { PageDriver, sleep } from './page-driver.js'
import { type BrowserToolContext, VERIFY_LOOP, dialogNote, fail, formatInspected, guarded, inspectElement, lineDiff, pressKey, settle, text, unlessDialog } from './tool-kit.js'

export function makeBrowserMcp(ctx: BrowserToolContext) {
  const uid = z.number().int().describe('an element uid from browser_snapshot')
  const meta = async (d: PageDriver, s: TabState) => ({ url: s.url, title: s.title, viewport: await d.viewportText(s) })

  const job = ctx.mode === 'job'
  const profileName = (id: string) => browserProfiles().get(id)?.name ?? id

  const tools = [
      tool(
        'browser_open',
        job
          ? `Open a URL in this run's browser tab, in the profile the job names (its logins). ${ctx.sites?.length ? `Only these sites open: ${ctx.sites.join(', ')}.` : ''} Then read the page with browser_snapshot (find: to search it) and browser_wait. You can't press Send, Post, Save or the like: record what you found with your write tool.`
          : `Open a URL in this session's browser tab (Junior.app's browser pane — the user watches the same page). Local URLs (localhost, 127.0.0.1, *.localhost, file: in the project) open without asking; another site asks the user once per session. A bare path like "/settings" is resolved against the current page. Each profile has its own logins: if the user names one ("use my Pendo profile"), pass profile (browser_profiles lists them). Never sign in for the user: if a page asks for a login, stop and ask them to sign in in the pane. ${VERIFY_LOOP}`,
        {
          url: z.string().describe('http(s)://localhost:5173/settings, localhost:3000, /settings, or a file: URL'),
          wait: z.enum(['load', 'idle']).optional().describe('idle (default) also waits for the network to go quiet — for apps that fetch after load'),
          ...(job ? {} : { profile: z.string().optional().describe('a profile name or id: this session\'s tab moves to it and stays there') }),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const cur = (await d.state().catch(() => null))?.url
            const url = resolveUrl(args.url, cur)
            if (!url) return fail(`"${args.url}" is not a URL this browser can open.`)
            if (job && !isLocalUrl(url, ctx.projectRoot) && !hostAllowed(ctx.sites, url)) return fail(`This job may only open ${ctx.sites!.join(', ')}.`)
            const notes: string[] = []
            const asked = (args as { profile?: string }).profile
            const want = typeof asked === 'string' && asked.trim() ? asked : null
            if (want) {
              const p = browserProfiles().find(want)
              if (!p) return fail(`No profile "${want}". There are: ${browserProfiles().list().map((x) => x.name).join(', ')}.`)
              const before = (await ctx.hub.resolve(ctx.sessionId)).profile
              await ctx.hub.setProfile(ctx.sessionId, p.id)
              if (before !== p.id) notes.push(`Switched this session's browser to the "${p.name}" profile.`)
            }
            const resolved = await ctx.hub.resolve(ctx.sessionId)
            if (resolved.missing) notes.push(`The profile "${resolved.missing}" was deleted; using "${profileName(resolved.profile)}".`)
            d.memory.logs.markLoad()
            const r = await ctx.hub.open(ctx.sessionId, url, args.wait ?? 'idle')
            d.memory.url = r.url
            // The user let this session open the site (the gate asked): the same site doesn't ask again.
            if (!job && !isLocalUrl(url, ctx.projectRoot)) {
              for (const u of [url, r.url]) {
                try {
                  d.memory.sites.add(siteOf(new URL(u).hostname))
                } catch {}
              }
            }
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
                ...notes,
                `Loaded ${r.url} — "${r.title}"${r.status ? ` (HTTP ${r.status})` : ''} in the "${profileName(resolved.profile)}" profile.`,
                `Viewport: ${await d.viewportText(s)}.`,
                errs ? `${errs} console error${errs === 1 ? '' : 's'} since load — read them with browser_logs.` : 'No console errors since load.',
              ].join('\n'),
            )
          })(),
      ),

      tool(
        'browser_snapshot',
        'The page as an accessibility tree: one line per element, with a uid for anything you can act on. Cheaper and more exact than a screenshot for finding things; use a screenshot to judge how it looks. On a big page (a mail inbox, a dashboard) pass find to keep only what mentions some text.',
        {
          uid: uid.optional().describe('snapshot only this element and what is inside it'),
          find: z.string().optional().describe('keep only elements whose name or value contains this text (any case), with what is inside them'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const s = await d.requirePage()
            const snap = await d.snapshot(args.uid, args.find)
            return text(`${s.url} — "${s.title}" · ${await d.viewportText(s)}\n${snap}`)
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
        `Do one thing on the page, like a user: click, type (replaces the field's text), press a key (Enter, Tab, Escape, Meta+a…), hover, scroll, select an <option>, go back / forward / reload, or answer a JavaScript dialog. Target elements by uid from browser_snapshot. Returns what changed (navigation, new console errors) — take a snapshot or screenshot to see the result.${job ? '' : ' On a site off this machine, a click that may send or change something (Send, Post, Delete…) asks the user first.'}`,
        {
          action: z.enum(['click', 'type', 'press', 'hover', 'scroll', 'select', 'back', 'forward', 'reload', 'dialog']),
          uid: uid.optional().describe('the element; required for click, type, hover, select'),
          text: z.string().optional().describe('type: the text; press: the key; select: the option label or value; dialog: "accept" or "dismiss" (or the text to answer a prompt with)'),
          submit: z.boolean().optional().describe('type: press Enter afterwards'),
          dy: z.number().optional().describe('scroll: pixels down (negative = up); default one screen'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const before = await d.requirePage()
            if (args.action === 'dialog') {
              const open = d.memory.dialog
              if (!open) return fail('No dialog is open on the page.')
              const accept = args.text !== 'dismiss'
              const promptText = accept && args.text && args.text !== 'accept' ? args.text : undefined
              await d.cdp('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) })
              d.memory.dialog = null
              return text(`${accept ? 'Accepted' : 'Dismissed'} the ${open.type} "${open.message}".\n${await settle(d, before)}`)
            }
            const need = (what: string) => {
              if (args.uid == null) throw new Error(`${args.action} needs a uid — find it with browser_snapshot.`)
              if (what && args.text == null) throw new Error(`${args.action} needs text (${what}).`)
              return args.uid
            }
            d.memory.logs.markAction()
            if (d.memory.dialog) return text(dialogNote(d.memory.dialog))
            // A click or an Enter that opens a dialog doesn't return until it is answered: don't wait on it.
            const outcome = await unlessDialog(d, async (): Promise<ReturnType<typeof fail> | null> => {
              switch (args.action) {
                case 'back':
                case 'forward': {
                  const h = await d.cdp<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory')
                  const to = h.entries[h.currentIndex + (args.action === 'back' ? -1 : 1)]
                  if (!to) return fail(`There is no page to go ${args.action} to.`)
                  await d.cdp('Page.navigateToHistoryEntry', { entryId: to.id })
                  break
                }
                case 'reload':
                  d.memory.logs.markLoad()
                  await d.cdp('Page.reload', {})
                  break
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
              return null
            })
            if ('dialog' in outcome) return text('That opened a dialog.')
            if (outcome.value) return outcome.value
            return text(await settle(d, before))
          }, { duringDialog: true })(),
      ),

      tool(
        'browser_logs',
        'Console errors and warnings, uncaught exceptions and failed requests (HTTP ≥ 400, network errors) — since your last action by default.',
        {
          since: z.enum(['action', 'load', 'all']).optional(),
          level: z.enum(['error', 'warning', 'all']).optional().describe('default: warnings and errors'),
        },
        async (args) =>
          guarded(
            ctx,
            async (d) => {
              await d.requirePage()
              return text(formatLogs(d.memory.logs.since(args.since ?? 'action', args.level ?? 'warning')))
            },
            { duringDialog: true },
          )(),
      ),

      tool(
        'browser_viewport',
        'Lay the page out at another size: desktop (1440×900), laptop (1280×800), tablet (820×1180), mobile (390×844, touch), "WxH", or fit (follow the pane, where new tabs start). Optionally force dark or light. Check every UI change at desktop and mobile: a tab that fits the pane is whatever size the user made it.',
        {
          size: z.string().describe('desktop | laptop | tablet | mobile | fit | e.g. 1024x768'),
          colorScheme: z.enum(['dark', 'light', 'default']).optional(),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            await d.requirePage()
            const key = args.size.trim().toLowerCase()
            let vp: Viewport | null | undefined = key === 'fit' ? null : VIEWPORTS[key]
            if (vp === undefined) {
              const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(key)
              if (!m) return fail(`"${args.size}" is not a size — use desktop, laptop, tablet, mobile, fit or WxH.`)
              const width = Number(m[1])
              const height = Number(m[2])
              vp = { width, height, deviceScaleFactor: width < 768 ? 2 : 1, mobile: width < 768 }
            }
            const scheme = args.colorScheme === 'default' ? null : args.colorScheme
            await ctx.hub.call(ctx.sessionId, { verb: 'viewport', viewport: vp, ...(scheme !== undefined ? { colorScheme: scheme } : {}) })
            await sleep(200)
            const s = await d.state()
            return text(`Viewport: ${await d.viewportText(s)}${s.colorScheme ? `, ${s.colorScheme} scheme` : ''}.`)
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
            let s = await d.requirePage()
            const label = (args.label ?? 'before').trim() || 'before'
            // A tab that fits the pane changes size with the pane: pin it, so the compare lays out the same.
            let pinned = ''
            if (!s.viewport) {
              const fit = await d.evalValue<{ width: number; height: number; dpr: number }>('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 })')
              const vp: Viewport = { width: fit.width, height: fit.height, deviceScaleFactor: fit.dpr, mobile: false }
              await ctx.hub.call(ctx.sessionId, { verb: 'viewport', viewport: vp })
              await sleep(200)
              s = await d.state()
              pinned = ` Pinned the viewport at ${vp.width}×${vp.height} (it fitted the pane) so the compare lays out the same; browser_viewport "fit" lets it follow the pane again.`
            }
            const [cap, snap] = await Promise.all([d.capture({ target: 'viewport', format: 'png', long: DIFF_LONG }), d.snapshot()])
            const m = await meta(d, s)
            const shot = await ctx.shots.add(ctx.sessionId, Buffer.from(cap.data, 'base64'), 'image/png', { kind: 'checkpoint', label, ...m })
            d.memory.checkpoints.set(label, { label, png: path.join(ctx.shots.dir(ctx.sessionId), shot.file), snapshot: snap, url: s.url, viewport: s.viewport, at: Date.now() })
            return text(`Checkpoint "${label}" saved: ${m.url} at ${m.viewport} ${shotMarker(shot.n)}. After your change, call browser_compare("${label}").${pinned}`)
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

      tool(
        'browser_profiles',
        "The browser profiles: separate logins, like Chrome profiles. Says which one this session's tab uses, the default, and (with Junior.app open) which sites each is signed in to. Pass a name to browser_open's profile to switch.",
        {},
        async () => {
          try {
            const list = browserProfiles().list()
            const mine = await ctx.hub.resolve(ctx.sessionId)
            const sites = new Map<string, string[]>()
            if (ctx.hub.status.compatible) {
              await Promise.all(
                list.map(async (p) => {
                  const r = await ctx.hub.profileCall<{ sites: SiteCookies[] }>(p.id, { op: 'sites' }, 8000).catch(() => null)
                  if (r) await browserProfiles().setSites(p.id, r.sites).catch(() => {})
                  const top = [...(r?.sites ?? [])].filter((x) => x.persistent > 0).sort((a, b) => b.persistent - a.persistent).slice(0, 8).map((x) => x.site)
                  sites.set(p.id, top)
                }),
              )
            }
            const lines = list.map((p) => {
              const tags = [p.id === mine.profile ? 'this session' : '', p.id === 'default' ? 'Default' : ''].filter(Boolean)
              const s = sites.get(p.id) ?? p.sites?.slice(0, 8)
              return `- ${p.name} (id ${p.id})${tags.length ? ` [${tags.join(', ')}]` : ''}${s ? (s.length ? ` — signed in to: ${s.join(', ')}` : ' — no saved logins') : ''}`
            })
            if (!ctx.hub.status.compatible) lines.push('(Junior.app is closed: the sites are as of the last time it was open.)')
            return text(lines.join('\n'))
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err))
          }
        },
      ),

      tool(
        'browser_wait',
        'Wait until the page shows (or stops showing) some text, the URL matches, or an element appears or goes. Use it after an action that loads something, instead of taking screenshots until it is there.',
        {
          text: z.string().optional().describe('text that should be on the page'),
          url: z.string().optional().describe('a piece of the URL, or /regex/'),
          uid: uid.optional().describe('an element that should be on the page'),
          gone: z.boolean().optional().describe('wait for the text or element to go instead'),
          timeoutMs: z.number().int().min(250).max(30_000).optional().describe('default 10000'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            await d.requirePage()
            if (args.text == null && args.url == null && args.uid == null) return fail('Wait for what? Give text, url or uid.')
            const r = await waitFor(d, { ...args, timeoutMs: args.timeoutMs ?? 10_000 })
            return r.ok ? text(`${r.what} after ${(r.ms / 1000).toFixed(1)}s. Now at ${r.url}.`) : fail(`Still waiting after ${(r.ms / 1000).toFixed(1)}s: ${r.what}. The page is ${r.url} — "${r.title}".`)
          })(),
      ),

      tool(
        'browser_fill',
        `Fill several fields at once, like browser_act type on each: text fields by text, a <select> by option label or value, a checkbox or radio by "true" or "false". Optionally click a submit button at the end.${job ? '' : ' Never fill a password: ask the user to sign in.'}`,
        {
          fields: z.array(z.object({ uid, value: z.string() })).min(1).max(20),
          submit: uid.optional().describe('a button to click once every field is filled'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const before = await d.requirePage()
            d.memory.logs.markAction()
            const done: string[] = []
            for (const f of args.fields) {
              d.flash(f.uid)
              const kind = await d.onElement<string>(f.uid, FIELD_KIND_FN).catch(() => {
                throw new Error(`uid=${f.uid} is no longer on the page — take a fresh browser_snapshot.`)
              })
              if (kind === 'select' || kind === 'check') {
                const r = await d.onElement<string>(f.uid, FILL_FN, [f.value])
                if (r.startsWith('!')) throw new Error(`uid=${f.uid}: ${r.slice(1)}`)
                done.push(`uid=${f.uid} → ${r}`)
                continue
              }
              await d.centerOf(f.uid)
              await d.cdp('DOM.focus', { backendNodeId: f.uid }).catch(() => {
                throw new Error(`uid=${f.uid} can't take focus — is it a field?`)
              })
              await d.onElement(
                f.uid,
                `function(){ if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r) } }`,
              )
              if (f.value) await d.cdp('Input.insertText', { text: f.value })
              else await pressKey(d, 'Backspace')
              done.push(`uid=${f.uid} ✓`)
            }
            if (args.submit != null) {
              const submit = args.submit
              const p = await d.centerOf(submit)
              d.flash(submit)
              const clicked = await unlessDialog(d, async () => {
                await d.mouse('mouseMoved', p.x, p.y)
                await d.mouse('mousePressed', p.x, p.y)
                await d.mouse('mouseReleased', p.x, p.y)
              })
              done.push(`clicked uid=${submit}`)
              if ('dialog' in clicked) return text(`Filled ${args.fields.length} field${args.fields.length === 1 ? '' : 's'}: ${done.join(', ')}. That opened a dialog.`)
            }
            return text(`Filled ${args.fields.length} field${args.fields.length === 1 ? '' : 's'}: ${done.join(', ')}.\n${await settle(d, before)}`)
          })(),
      ),

      tool(
        'browser_extract',
        'Read part of the page as data: its text, a table (or ARIA grid) as CSV, or its links. Scope it with a uid from browser_snapshot; without one it reads the whole page (the first table, for a table). For pulling numbers or rows out of a dashboard or a list.',
        {
          as: z.enum(['text', 'table', 'links']),
          uid: uid.optional().describe('read only this element (a table, a list, a panel)'),
        },
        async (args) =>
          guarded(ctx, async (d) => {
            const s = await d.requirePage()
            const out =
              args.uid != null
                ? await d.onElement<string>(args.uid, EXTRACT_FN, [args.as])
                : await d.evalValue<string>(`(${EXTRACT_FN}).call(document.body, ${JSON.stringify(args.as)})`)
            if (!out) return fail(args.as === 'table' ? 'No table or grid there.' : 'Nothing to read there.')
            const max = 12_000
            return text(`${s.url} — ${args.as}${args.uid != null ? ` of uid=${args.uid}` : ''}:\n${out.length > max ? `${out.slice(0, max)}\n… (${out.length} chars; scope it with a uid)` : out}`)
          })(),
      ),
  ]

  // Each call puts its step on the tab while it runs ("Clicking "Send""), for the pane's driving strip.
  for (const t of tools) {
    if (t.name === 'browser_profiles') continue
    type Handler = (args: unknown, extra: unknown) => Promise<unknown>
    const tt = t as unknown as { handler: Handler }
    const run = tt.handler
    tt.handler = async (args, extra) => {
      const m = ctx.hub.page(ctx.sessionId)
      if (profileOfSigninTab(ctx.sessionId) || m.heldByUser || (m.dialog && t.name !== 'browser_act')) return run(args, extra)
      ctx.hub.setStep(ctx.sessionId, await stepFor(t.name, args as Record<string, unknown>))
      try {
        return await run(args, extra)
      } finally {
        ctx.hub.setStep(ctx.sessionId, null)
      }
    }
  }

  /** The call's step, naming its element when it has one and the tab is open to ask (never longer than a moment). */
  async function stepFor(leaf: string, args: Record<string, unknown>): Promise<string> {
    const uid = stepUid(leaf, args)
    let el: ElementFacts | null = null
    if (uid != null && ctx.hub.isLive(ctx.sessionId) && ctx.hub.status.compatible) {
      const d = new PageDriver(ctx.hub, ctx.sessionId)
      el = await Promise.race([d.describe(uid).catch(() => null), sleep(1500).then(() => null)])
    }
    const url = leaf === 'browser_open' && typeof args.url === 'string' ? resolveUrl(args.url, ctx.hub.page(ctx.sessionId).url) : null
    return stepText(leaf, args, el, url)
  }

  // An unattended run reads and moves around; arbitrary script and the before/after proof are a chat's.
  const JOB_LEFT_OUT = new Set(['browser_eval', 'browser_checkpoint', 'browser_compare'])
  return createSdkMcpServer({
    name: BROWSER_SERVER,
    version: '1',
    ...(job ? { alwaysLoad: true } : {}),
    tools: job ? tools.filter((t) => !JOB_LEFT_OUT.has(t.name)) : tools,
  })
}

/** browser_extract, run with the element (or the body) as `this`. */
const EXTRACT_FN = `function(as){
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim()
  if (as === 'text') return (this.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim()
  if (as === 'links') {
    return [...this.querySelectorAll('a[href]')].slice(0, 300).map((a) => '- ' + (clean(a.innerText) || clean(a.getAttribute('aria-label')) || '(no text)') + ' → ' + a.href).join('\\n')
  }
  const t = this.matches && this.matches('table, [role=grid], [role=table], [role=treegrid]') ? this : this.querySelector('table, [role=grid], [role=table], [role=treegrid]')
  if (!t) return ''
  const rows = t.tagName === 'TABLE' ? [...t.rows] : [...t.querySelectorAll('[role=row]')]
  const cell = (c) => { const v = clean(c.innerText); return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
  return rows.slice(0, 500).map((r) => [...(t.tagName === 'TABLE' ? r.cells : r.querySelectorAll('[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]'))].map(cell).join(',')).join('\\n')
}`

/** What kind of field an element is, for browser_fill. */
const FIELD_KIND_FN = `function(){
  const t = (this.tagName || '').toLowerCase(), type = (this.type || '').toLowerCase()
  if (t === 'select') return 'select'
  if (t === 'input' && (type === 'checkbox' || type === 'radio')) return 'check'
  return 'text'
}`

/** Set a <select> or a checkbox/radio the way a user would, so the page's listeners hear it. Returns what it became, or "!why". */
const FILL_FN = `function(want){
  const fire = () => { this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })) }
  if (this.tagName === 'SELECT') {
    const o = [...this.options].find((o) => o.value === want || o.label.trim() === want || o.text.trim() === want)
    if (!o) return '!no option "' + want + '"'
    this.value = o.value; fire(); return o.label || o.value
  }
  const on = /^(true|yes|on|1|checked)$/i.test(want.trim())
  if (this.checked !== on) this.click()
  return on ? 'checked' : 'unchecked'
}`

type WaitArgs = { text?: string; url?: string; uid?: number; gone?: boolean; timeoutMs: number }

/** Poll every 250ms until the condition holds or the time runs out. */
async function waitFor(d: PageDriver, a: WaitArgs): Promise<{ ok: boolean; what: string; ms: number; url: string; title: string }> {
  const started = Date.now()
  const re = a.url && /^\/.+\/[a-z]*$/.test(a.url) ? new RegExp(a.url.slice(1, a.url.lastIndexOf('/')), a.url.slice(a.url.lastIndexOf('/') + 1)) : null
  const parts: string[] = []
  if (a.text != null) parts.push(`"${a.text}" ${a.gone ? 'gone from' : 'on'} the page`)
  if (a.url != null) parts.push(`URL matching ${a.url}`)
  if (a.uid != null) parts.push(`uid=${a.uid} ${a.gone ? 'gone' : 'present'}`)
  const what = parts.join(' and ')
  for (;;) {
    const s = await d.state()
    let ok = true
    if (a.url != null) ok &&= re ? re.test(s.url) : s.url.includes(a.url)
    if (ok && a.text != null) {
      const has = await d.evalValue<boolean>(`(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(a.text.toLowerCase())})`).catch(() => false)
      ok = a.gone ? !has : has
    }
    if (ok && a.uid != null) {
      const has = await d.cdp('DOM.describeNode', { backendNodeId: a.uid }).then(() => true, () => false)
      ok = a.gone ? !has : has
    }
    const ms = Date.now() - started
    if (ok) return { ok: true, what: `${what[0].toUpperCase()}${what.slice(1)}`, ms, url: s.url, title: s.title }
    if (ms >= a.timeoutMs) return { ok: false, what, ms, url: s.url, title: s.title }
    await sleep(250)
  }
}
