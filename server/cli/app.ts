import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pkgVersion, DEFAULT_PORT } from '../state.js'
import { explicitPort } from './args.js'
import { bold, box, cyan, die, dim, execFileP, green, row, tilde } from './ui.js'

// macOS desktop app
// A dependency-free way to run junior in its own window, Dock icon and Cmd-Tab
// entry with no browser chrome: a tiny .app bundle whose launcher opens the UI
// in a dedicated, chromeless Chrome profile (Chrome's --app mode). macOS only;
// the eventual native app replaces this. Nothing here touches the server.

const APP_NAME = 'Junior.app'
const CHROME_APPS = [
  '/Applications/Google Chrome.app',
  path.join(os.homedir(), 'Applications/Google Chrome.app'),
]

/** The 1024px master icon shipped in the package (dist/web) or the dev tree. */
function iconMasterPath(): string | null {
  const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const candidates = [
    path.join(here, '..', 'web', 'icon-1024.png'), // published: dist/server → dist/web
    path.join(here, '..', '..', 'web', 'public', 'icon-1024.png'), // dev: server → web/public
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Rasterize a multi-resolution .icns from a PNG master via sips + iconutil. */
async function buildIcns(masterPng: string, outIcns: string) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'junior-icon-'))
  const iconset = path.join(tmp, 'icon.iconset')
  mkdirSync(iconset)
  const sizes: [number, string][] = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ]
  for (const [px, name] of sizes) {
    await execFileP('sips', ['-s', 'format', 'png', '-z', String(px), String(px), masterPng, '--out', path.join(iconset, name)])
  }
  await execFileP('iconutil', ['-c', 'icns', iconset, '-o', outIcns])
  rmSync(tmp, { recursive: true, force: true })
}

const infoPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Junior</string>
  <key>CFBundleDisplayName</key><string>Junior</string>
  <key>CFBundleIdentifier</key><string>sh.usejunior.app</string>
  <key>CFBundleVersion</key><string>${pkgVersion()}</string>
  <key>CFBundleShortVersionString</key><string>${pkgVersion()}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>junior-launcher</string>
  <key>CFBundleIconFile</key><string>junior</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`

const launcherScript = (port: number) => `#!/bin/bash
# Junior — opens the local UI in a chromeless Chrome app window. Reuses the
# already-running Chrome (default profile) so the window pops instantly; a
# dedicated --user-data-dir would cold-start a second Chrome and feel slow.
URL="http://junior.localhost:${port}/"
# Best-effort, non-blocking: nudge the daemon up without delaying the window.
( command -v junior >/dev/null 2>&1 && junior start ) >/dev/null 2>&1 &
CHROME=""
for C in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  [ -x "$C" ] && CHROME="$C" && break
done
# No Chrome? Fall back to the default browser so the app still works.
[ -n "$CHROME" ] || { open "$URL"; exit 0; }
exec "$CHROME" --app="$URL"
`

/** Prefer /Applications; fall back to ~/Applications when it isn't writable. */
function chooseAppDir(): string {
  const system = '/Applications'
  const probe = path.join(system, '.junior-write-probe')
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return path.join(system, APP_NAME)
  } catch {
    const user = path.join(os.homedir(), 'Applications')
    mkdirSync(user, { recursive: true })
    return path.join(user, APP_NAME)
  }
}

async function appInstall(port: number) {
  if (process.platform !== 'darwin') die(`${cyan('junior app install')} is macOS only`)
  if (!CHROME_APPS.some((p) => existsSync(p))) {
    die(`Google Chrome not found — install it, then re-run ${cyan('junior app install')}`)
  }

  const appDir = chooseAppDir()
  rmSync(appDir, { recursive: true, force: true })
  const macos = path.join(appDir, 'Contents', 'MacOS')
  const resources = path.join(appDir, 'Contents', 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })

  writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), infoPlist())
  const launcher = path.join(macos, 'junior-launcher')
  writeFileSync(launcher, launcherScript(port))
  chmodSync(launcher, 0o755)

  const master = iconMasterPath()
  if (master) {
    try {
      await buildIcns(master, path.join(resources, 'junior.icns'))
    } catch {
      // The icon is cosmetic: a bad sips/iconutil shouldn't fail the install.
    }
  }
  // Reclaim the dedicated Chrome profile older versions created, the launcher
  // now reuses the default profile, so this directory is dead weight.
  rmSync(path.join(os.homedir(), '.junior', 'app-chrome'), { recursive: true, force: true })
  // Nudge LaunchServices to register the new bundle so the icon appears.
  await execFileP('touch', [appDir]).catch(() => {})

  box([
    `${green('●')} ${bold('Junior.app installed')}`,
    '',
    row('where', tilde(appDir)),
    row('opens', cyan(`http://junior.localhost:${port}`)),
    '',
    `${dim('Open it from Spotlight or Launchpad, then')} ${bold('right-click its Dock icon → Options → Keep in Dock')}`,
    `${dim('Remove it with')} ${cyan('junior app uninstall')}`,
  ])
}

function appUninstall() {
  if (process.platform !== 'darwin') die(`${cyan('junior app')} is macOS only`)
  const targets = [path.join('/Applications', APP_NAME), path.join(os.homedir(), 'Applications', APP_NAME)]
  let removed = false
  for (const t of targets) {
    if (existsSync(t)) {
      rmSync(t, { recursive: true, force: true })
      console.log(`${green('✓')} removed ${tilde(t)}`)
      removed = true
    }
  }
  if (!removed) console.log(`${dim('○')} no ${APP_NAME} is installed`)
}

export async function appCmd(sub: string | undefined) {
  const port = explicitPort ?? DEFAULT_PORT
  if (sub === 'install' || sub === undefined) return appInstall(port)
  if (sub === 'uninstall' || sub === 'remove') return appUninstall()
  die(`unknown app command "${sub}" — try ${cyan('junior app install')}`)
}
