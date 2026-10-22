// Renders the README banner (docs/banner.png) from the website's dev-only
// /og/readme stage: the share card's look on a 1280x460 stage, at 2x.
// Needs the site's `next dev` running (usejunior.sh repo, :3000).
// Run: node marketing/readme-banner/render.mjs [url]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const url = process.argv[2] ?? 'http://localhost:3000/og/readme'

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
try {
  // reduced motion holds Junior still, eyes open, looking straight out
  const tab = await browser.newPage({ viewport: { width: 1280, height: 460 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await tab.goto(url, { waitUntil: 'networkidle' })
  await tab.evaluate(() => document.fonts.ready)
  await tab.waitForTimeout(1500)
  const out = path.join(root, 'docs', 'banner.png')
  await tab.locator('#banner').screenshot({ path: out })
  console.log(path.relative(root, out))
} finally {
  await browser.close()
}
