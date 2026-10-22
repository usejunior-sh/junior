// Renders the README flow picture (docs/flow-light.png) from the live site's
// app window at step 04, through your installed Chrome. The site is light only.
// Run: node marketing/readme-banner/render-flow.mjs [url]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const url = process.argv[2] ?? 'https://usejunior.sh/'

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
try {
  const tab = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await tab.goto(url, { waitUntil: 'networkidle' })
  await tab.evaluate(() => document.fonts.ready)
  const tabs = tab.getByRole('tablist', { name: 'How Junior works' })
  await tabs.getByRole('tab').nth(3).click()
  await tab.mouse.move(0, 0)
  await tab.waitForTimeout(800)
  const flow = tabs.locator('..')
  await flow.scrollIntoViewIfNeeded()
  const out = path.join(root, 'docs', 'flow-light.png')
  await flow.screenshot({ path: out, animations: 'disabled' })
  console.log(path.relative(root, out))
} finally {
  await browser.close()
}
