// Renders the README banner (marketing/readme-banner/banner.html) to
// docs/banner-dark.png and docs/banner-light.png through your installed Chrome.
// Run: node marketing/readme-banner/render.mjs
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const page = pathToFileURL(path.join(here, 'banner.html')).href

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
try {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 460 }, deviceScaleFactor: 2 })
  for (const theme of ['dark', 'light']) {
    await tab.goto(`${page}#${theme}`)
    await tab.reload()
    await tab.evaluate(() => document.fonts.ready)
    await tab.waitForTimeout(300)
    const out = path.join(root, 'docs', `banner-${theme}.png`)
    await tab.locator('#banner').screenshot({ path: out })
    console.log(path.relative(root, out))
  }
} finally {
  await browser.close()
}
