// Puts the current checkout into Junior.app on this Mac, without releasing it.
//
//   node scripts/app-snapshot.mjs [--arch arm64|x64] [--build-only]
//
// The app bundle *is* the install (desktop/ARCHITECTURE.md), so "get my change
// into prod" means: build the app, then run the real installer over it, the
// same path a `curl | sh` user takes, shims and LaunchAgent included, so the
// thing you try is the thing they get.
//
// The build is labelled with a prerelease version, 1.0.4-dev.gabc1234, plus
// `.dirty` if the tree has uncommitted changes, so the UI badges it Preview
// and never shows unreleased code under a release number. package.json is
// restored byte for byte afterwards, even if the build fails. Nothing is
// committed, tagged or published.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}
const arch = option('--arch') ?? process.arch
if (arch !== 'arm64' && arch !== 'x64') die(`--arch must be arm64 or x64, got ${arch}`)
if (process.platform !== 'darwin') die('Junior.app builds on macOS only')

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' })

function die(msg) {
  console.error(`\napp-snapshot failed: ${msg}`)
  process.exit(1)
}

const original = readFileSync('package.json', 'utf8')
const pkg = JSON.parse(original)
const [, major, minor, patch] = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/)
const sha = git('rev-parse', '--short', 'HEAD')
const dirty = git('status', '--porcelain') !== ''
const version = `${major}.${minor}.${Number(patch) + 1}-dev.g${sha}${dirty ? '.dirty' : ''}`

console.log(`\nJunior.app ${version} · mac-${arch}${dirty ? ' · uncommitted changes included' : ''}\n`)

const zip = path.join('desktop', 'release', `Junior-${version}-mac-${arch}.zip`)
try {
  // desktop/scripts/build.mjs reads this version for both the bundle and the
  // staged package, which is what server/state.ts later reports as the build.
  writeFileSync('package.json', JSON.stringify({ ...pkg, version }, null, 2) + '\n')
  run('npm', '--prefix', 'desktop', 'run', 'build', '--', '--arch', arch)
} finally {
  writeFileSync('package.json', original)
}
if (!existsSync(zip)) die(`the build did not produce ${zip}`)

if (argv.includes('--build-only')) {
  console.log(`\nbuilt ${zip}`)
  console.log(`install it with:  JUNIOR_APP_ZIP=${zip} sh install.sh`)
  process.exit(0)
}

// The installer quits the running app, replaces it, relinks the CLI and, when
// no session is mid-turn: restarts the daemon onto this build. Going through
// install.sh rather than copying the bundle is the point: it is the only path
// that is exercised on every machine, so it is the one worth testing.
execFileSync('sh', ['install.sh'], {
  stdio: 'inherit',
  env: { ...process.env, JUNIOR_APP_ZIP: path.resolve(zip) },
})
