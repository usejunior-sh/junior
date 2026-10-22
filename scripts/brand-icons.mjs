// Renders every raster icon from the brand SVGs in assets/brand (brand v2,
// .docs/junior-goals-teams/junior-brand-v2.html) through your installed Chrome:
//   web/public/icon-{192,512,1024}.png   the app icon tile (1024 also feeds desktop/build/icon.icns)
//   web/public/apple-touch-icon.png      the square tile; iOS rounds it
//   desktop/src/trayTemplate{,@2x}.png   the menu-bar template: black key, eyes and smile cut out
// Run: node scripts/brand-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brand = (f) => readFileSync(path.join(root, 'assets/brand', f), 'utf8')

const jobs = [
  ['junior-app-icon.svg', 1024, 'web/public/icon-1024.png'],
  ['junior-app-icon.svg', 512, 'web/public/icon-512.png'],
  ['junior-app-icon.svg', 192, 'web/public/icon-192.png'],
  ['junior-app-icon-square.svg', 180, 'web/public/apple-touch-icon.png'],
  ['junior-tray-template.svg', 18, 'desktop/src/trayTemplate.png'],
  ['junior-tray-template.svg', 36, 'desktop/src/trayTemplate@2x.png'],
]

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const [file, px, out] of jobs) {
    const svg = brand(file).replace(/<svg([^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, '<svg$1').replace('<svg', `<svg width="${px}" height="${px}"`)
    await page.setViewportSize({ width: px, height: px })
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
    const png = await page.locator('svg').first().screenshot({ omitBackground: true })
    writeFileSync(path.join(root, out), png)
    console.log(`${out} · ${px}px`)
  }
} finally {
  await browser.close()
}
