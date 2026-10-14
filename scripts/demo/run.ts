// Marketing screenshots from a seeded demo world (scripts/demo).
//
//   npm run demo:shots                     seed → demo server → capture every scene → frame → stop
//   npm run demo:shots -- --only inbox,jobs
//   npm run demo:shots -- --theme light    (default dark)
//   npm run demo:serve                     seed → demo server, left running to click around / capture by hand
//
// Flags: --port (5199), --home (~/.triage-demo), --out (marketing/shots), --no-build, --no-seed.
//
// The demo server is its own daemon: its own TRIAGE_HOME and port, a `gh`
// stand-in first on its PATH, the built UI from dist/web. Prod (:5178) and
// dev (:5188) are never touched. Desktop scenes get a stand-in for Triage.app's
// bridge, so the UI draws the app's own title bar, plus painted traffic lights.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright-core'
import { seed, DEFAULT_HOME } from './seed.js'
import { OPEN_TABS, SCENES, TAB_TITLES, type Scene } from './scenes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const mode = argv[0] === 'serve' ? 'serve' : 'shots'
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1].replace(/^~(?=$|\/)/, os.homedir()) : fallback
}
const PORT = Number(opt('port', '5199'))
const HOME = path.resolve(opt('home', DEFAULT_HOME))
const OUT = path.resolve(opt('out', path.join(REPO, 'marketing', 'shots')))
const THEME = opt('theme', 'dark') as 'dark' | 'light'
const ONLY = opt('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const BASE = `http://localhost:${PORT}`

// ---------------------------------------------------------------------------
// Framed outputs: platform sizes in CSS px, rendered at 2x
// ---------------------------------------------------------------------------

type Format = { name: string; width: number; height: number; headline: boolean }
const FORMATS: Format[] = [
  { name: 'x', width: 1600, height: 900, headline: true }, // X / Twitter 16:9
  { name: 'linkedin', width: 1200, height: 1200, headline: true }, // LinkedIn square feed
  { name: 'og', width: 1200, height: 630, headline: false }, // link previews: HN, Reddit, Slack, the site
]

// ---------------------------------------------------------------------------

async function main() {
  if (await healthy()) throw new Error(`something already answers on :${PORT}; pass --port`)
  if (!flag('no-build')) buildWeb()
  if (!flag('no-seed')) {
    const r = await seed(HOME)
    console.log(`seeded ${r.home}`)
  }
  const server = startServer()
  try {
    await waitHealthy(server)
    console.log(`demo server: ${BASE}  (data: ${HOME})`)
    if (mode === 'serve') {
      console.log('Ctrl-C to stop. Tip: Cmd-Shift-4 then Space captures one window.')
      await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve)
        process.on('SIGTERM', resolve)
        server.on('exit', resolve)
      })
      return
    }
    await capture()
  } finally {
    server.kill('SIGTERM')
  }
}

/** Rebuild dist/web when any web source is newer than it. */
function buildWeb() {
  const index = path.join(REPO, 'dist', 'web', 'index.html')
  const built = existsSync(index) ? statSync(index).mtimeMs : 0
  const newest = Math.max(newestIn(path.join(REPO, 'web')), newestIn(path.join(REPO, 'shared')), newestIn(path.join(REPO, 'assets')))
  if (built > newest) return
  console.log('building the web UI (dist/web)…')
  execFileSync(path.join(REPO, 'node_modules', '.bin', 'vite'), ['build'], { cwd: REPO, stdio: 'inherit' })
}

function newestIn(dir: string): number {
  if (!existsSync(dir)) return 0
  let max = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    max = Math.max(max, e.isDirectory() ? newestIn(p) : statSync(p).mtimeMs)
  }
  return max
}

function startServer(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, TRIAGE_HOME: HOME, PORT: String(PORT), PATH: `${path.join(HERE, 'bin')}:${process.env.PATH}` }
  delete env.TRIAGE_DB // would point the demo's workspace at another database
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log: string[] = []
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (b: Buffer) => log.push(b.toString()))
  child.on('exit', (code) => {
    if (code && code !== 143) console.error(`demo server exited (${code}):\n${log.join('').slice(-2000)}`)
  })
  return child
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

async function waitHealthy(server: ChildProcess) {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    if (server.exitCode != null) throw new Error('the demo server exited during boot')
    if (await healthy()) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`the demo server did not answer on :${PORT} within 60s`)
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function capture() {
  const scenes = ONLY.length ? SCENES.filter((s) => ONLY.includes(s.name)) : SCENES
  if (!scenes.length) throw new Error(`no scene named ${ONLY.join(', ')}; see scripts/demo/scenes.ts`)
  const rawDir = path.join(OUT, THEME, 'raw')
  mkdirSync(rawDir, { recursive: true })

  const browser = await launch()
  try {
    // let the first inbox sync and the connector probe finish before the first shot
    await warmUp(browser)
    for (const scene of scenes) {
      const file = path.join(rawDir, `${scene.name}.png`)
      await shoot(browser, scene, file)
      console.log(`  ${path.relative(REPO, file)}`)
      for (const f of FORMATS) {
        const out = path.join(OUT, THEME, f.name, `${scene.name}.png`)
        mkdirSync(path.dirname(out), { recursive: true })
        await frame(browser, scene, file, f, out)
        console.log(`  ${path.relative(REPO, out)}`)
      }
    }
  } finally {
    await browser.close()
  }
  console.log(`\n${scenes.length} scene(s) → ${path.relative(process.cwd(), path.join(OUT, THEME)) || '.'}`)
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome' })
  } catch {
    // no Google Chrome: a Playwright-managed Chromium, if one is installed
    return chromium.launch()
  }
}

async function warmUp(browser: Browser) {
  const page = await browser.newPage()
  await page.goto(`${BASE}/#/inbox`)
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2500)
  await page.close()
}

/** Seeded before the app's own scripts run: theme, open tabs, the desktop bridge. */
function initScript(scene: Scene) {
  const tabs = { tabs: OPEN_TABS, preview: null, titles: TAB_TITLES }
  return `
    localStorage.setItem('triage.appearance.theme', ${JSON.stringify(THEME)});
    localStorage.setItem('triage.tabs.default', ${JSON.stringify(JSON.stringify(tabs))});
    ${
      scene.mobile
        ? ''
        : `window.triageDesktop = {
      chrome: 'mac',
      back() {}, forward() {},
      navState: () => Promise.resolve({ canGoBack: true, canGoForward: false, fullscreen: false }),
      onNav: () => () => {},
    };`
    }
  `
}

/** Noise a fresh demo daemon shows that a real user wouldn't: build badge, setup notices, toasts. */
const HIDE_CSS = `
  .buildBadge, .notice, .toast, .toasts, [data-sonner-toaster] { display: none !important; }
  * { caret-color: transparent !important; }
  ::-webkit-scrollbar { display: none; }
`

const TRAFFIC_LIGHTS = `
  (() => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;top:16px;display:flex;gap:8px;z-index:2147483647;pointer-events:none';
    for (const [fill, edge] of [['#ff5f57', '#e0443e'], ['#febc2e', '#dea123'], ['#28c840', '#1aab29']]) {
      const dot = document.createElement('span');
      dot.style.cssText = 'width:12px;height:12px;border-radius:50%;box-sizing:border-box;background:' + fill + ';border:0.5px solid ' + edge;
      box.appendChild(dot);
    }
    document.body.appendChild(box);
  })()
`

/**
 * Where the demo really lives (`~/.triage-demo/projects/api`, under your own
 * username) → where a reader expects a repo to live. Applied to every text
 * node just before the shot.
 */
function redactions(): [string, string][] {
  const project = path.join(HOME, 'projects', 'api')
  const tilde = project.startsWith(os.homedir()) ? `~${project.slice(os.homedir().length)}` : project
  return [
    [project, '/Users/alex/code/acme/api'],
    [tilde, '~/code/acme/api'],
    [HOME, '~/.triage'],
  ]
}

function redact(pairs: [string, string][]) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let text = n.nodeValue ?? ''
    for (const [from, to] of pairs) text = text.split(from).join(to)
    if (text !== n.nodeValue) n.nodeValue = text
  }
}

async function shoot(browser: Browser, scene: Scene, file: string) {
  const viewport = scene.viewport ?? { width: 1440, height: 900 }
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scene.mobile ? 3 : 2,
    colorScheme: THEME,
    isMobile: !!scene.mobile,
    hasTouch: !!scene.mobile,
  })
  try {
    await context.addInitScript(initScript(scene))
    const page = await context.newPage()
    await page.goto(`${BASE}/${scene.hash}`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.evaluate(() => document.fonts.ready)
    if (scene.click) await page.getByText(scene.click, { exact: true }).first().click()
    await page.addStyleTag({ content: HIDE_CSS + (scene.hide?.length ? `${scene.hide.join(', ')} { display: none !important; }` : '') })
    if (!scene.mobile) await page.evaluate(TRAFFIC_LIGHTS)
    // park the pointer off-window so no hover state lands in the shot
    await page.mouse.move(viewport.width - 1, viewport.height - 1)
    await page.waitForTimeout(800 + (scene.settleMs ?? 0))
    await page.evaluate(redact, redactions())
    await page.screenshot({ path: file })
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Frame: the raw shot as a window on a dark stage, sized per platform
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

async function frame(browser: Browser, scene: Scene, rawFile: string, f: Format, out: string) {
  const img = `data:image/png;base64,${readFileSync(rawFile).toString('base64')}`
  const vw = scene.viewport?.width ?? 1440
  const vh = scene.viewport?.height ?? 900
  const showText = f.headline && !!scene.headline
  const pad = Math.round(Math.min(f.width, f.height) * 0.07)
  const textH = showText ? (scene.sub ? 150 : 104) : 0
  // fit the window in what's left, keeping its aspect
  const scale = Math.min((f.width - pad * 2) / vw, (f.height - pad * 2 - textH) / vh)
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  const light = THEME === 'light'
  const radius = scene.mobile ? Math.round(44 * scale * 1.2) : 12

  const html = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Geist:wght@400;500&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; width: ${f.width}px; height: ${f.height}px; overflow: hidden; }
  body {
    background: ${
      light
        ? 'radial-gradient(120% 80% at 50% 0%, #ffffff 0%, #eef2f6 55%, #e3e8ee 100%)'
        : 'radial-gradient(90% 70% at 50% 0%, rgba(59,158,255,0.16) 0%, rgba(59,158,255,0) 60%), radial-gradient(60% 50% at 85% 100%, rgba(17,255,153,0.06) 0%, rgba(17,255,153,0) 70%), #000'
    };
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${showText ? 36 : 0}px;
    font-family: Geist, -apple-system, sans-serif; -webkit-font-smoothing: antialiased;
  }
  .text { text-align: center; max-width: ${f.width - pad * 2}px; }
  h1 { margin: 0; font: 400 ${f.width >= 1500 ? 64 : 56}px/1.05 'Instrument Serif', serif; letter-spacing: -0.01em; color: ${light ? '#0b0c0e' : '#fcfdff'}; }
  p { margin: 14px 0 0; font-size: 22px; line-height: 1.4; color: ${light ? 'rgba(11,12,14,0.62)' : 'rgba(252,253,255,0.62)'}; }
  .win {
    width: ${w}px; height: ${h}px; border-radius: ${radius}px; overflow: hidden; flex: none;
    box-shadow: 0 0 0 1px ${light ? 'rgba(11,12,14,0.12)' : 'rgba(255,255,255,0.14)'}, 0 30px 80px ${light ? 'rgba(15,23,42,0.18)' : 'rgba(0,0,0,0.7)'};
  }
  .win img { display: block; width: 100%; height: 100%; }
</style></head><body>
  ${showText ? `<div class="text"><h1>${esc(scene.headline!)}</h1>${scene.sub ? `<p>${esc(scene.sub)}</p>` : ''}</div>` : ''}
  <div class="win"><img src="${img}"></div>
</body></html>`

  const page = await browser.newPage({ viewport: { width: f.width, height: f.height }, deviceScaleFactor: 2 })
  try {
    await page.setContent(html, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: out })
  } finally {
    await page.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

