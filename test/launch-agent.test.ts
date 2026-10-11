/**
 * The LaunchAgent (server/launchd.ts) is what makes watches a promise rather
 * than a hope: without it the daemon dies at the next reboot and nothing brings
 * it back. Triage.app writes it on launch, so two things have to hold — the
 * plist must name the exact node + script we meant, and `load: false` must be
 * able to write one without touching launchctl (the app does that while a
 * daemon is already serving, and bootstrapping then would crash-loop).
 *
 * HOME is redirected per test, so nothing here goes near the real
 * ~/Library/LaunchAgents.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installLaunchAgent, launchAgentInstalled, launchAgentPlist, launchAgentPointsAt, plistFor } from '../server/launchd.js'

const APP = '/Applications/Triage.app/Contents/Resources'
const NODE = `${APP}/node/bin/node`
const CLI = `${APP}/triage/dist/server/cli.js`

const spec = {
  node: NODE,
  script: CLI,
  port: 5178,
  logFile: '/Users/x/.triage/server.log',
  env: { PATH: '/usr/bin:/bin', HOME: '/Users/x' },
}

/**
 * Run `fn` with HOME pointed at a throwaway directory. Awaits `fn` before
 * restoring: `launchAgentPlist()` reads os.homedir() on every call, so handing
 * HOME back early would point the rest of the test at the real one.
 */
async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'triage-agent-'))
  const prev = process.env.HOME
  process.env.HOME = home
  // These tests write a real plist. If the redirect ever stops working, the
  // write lands in the developer's own ~/Library/LaunchAgents — so prove the
  // target moved before anything is written, and fail loudly if it didn't.
  assert.ok(
    launchAgentPlist().startsWith(home + path.sep),
    `HOME redirect failed — refusing to write to ${launchAgentPlist()}`,
  )
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

test('plistFor runs `<node> <cli> serve` and restarts on crash and at login', () => {
  const xml = plistFor(spec)
  assert.match(xml, /<string>\/Applications\/Triage\.app\/Contents\/Resources\/node\/bin\/node<\/string>/)
  assert.match(xml, /<string>serve<\/string>/)
  // Without both of these a reboot or a crash leaves watches dead.
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/)
  // PATH has to ride along or the daemon can't find `claude` under launchd.
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/)
  assert.match(xml, /<key>PORT<\/key>\s*<string>5178<\/string>/)
})

test('plistFor escapes a path that would otherwise break the XML', () => {
  const xml = plistFor({ ...spec, logFile: '/tmp/a&b<c>/server.log' })
  assert.match(xml, /<string>\/tmp\/a&amp;b&lt;c&gt;\/server\.log<\/string>/)
  assert.doesNotMatch(xml, /a&b<c>/)
})

test('installLaunchAgent({ load: false }) writes the plist without launchctl', async () => {
  await withHome(async (home) => {
    assert.equal(launchAgentInstalled(), false, 'a fresh HOME has no agent')
    await installLaunchAgent(spec, { load: false })
    assert.equal(launchAgentInstalled(), true)
    const xml = readFileSync(path.join(home, 'Library/LaunchAgents/sh.usetriage.triage.plist'), 'utf8')
    assert.match(xml, /sh\.usetriage\.triage/)
    assert.equal(xml, plistFor(spec))
  })
})

test('launchAgentPointsAt: the copy that wrote it, and nobody else', async () => {
  await withHome(async () => {
    assert.equal(launchAgentPointsAt(NODE, CLI), false, 'no plist at all')
    await installLaunchAgent(spec, { load: false })
    assert.equal(launchAgentPointsAt(NODE, CLI), true)
    // An app moved to ~/Applications, or the npm install this replaced: the
    // plist still exists, so "installed" is true while it restarts nothing.
    const moved = '/Users/x/Applications/Triage.app/Contents/Resources'
    assert.equal(launchAgentInstalled(), true)
    assert.equal(launchAgentPointsAt(`${moved}/node/bin/node`, `${moved}/triage/dist/server/cli.js`), false)
    assert.equal(launchAgentPointsAt('/usr/local/bin/node', CLI), false, 'node must match too')
  })
})

test('launchAgentPointsAt: a partial path must not count as a match', async () => {
  await withHome(async () => {
    await installLaunchAgent(spec, { load: false })
    // `<string>…node</string>` is matched whole: a prefix of the real path is
    // a different binary, not the same one.
    assert.equal(launchAgentPointsAt(`${APP}/node/bin`, CLI), false)
  })
})

test('the plist is rewritten in place, not appended to', async () => {
  await withHome(async () => {
    await installLaunchAgent(spec, { load: false })
    const moved = { ...spec, node: '/Users/x/Applications/Triage.app/Contents/Resources/node/bin/node' }
    await installLaunchAgent(moved, { load: false })
    const xml = readFileSync(launchAgentPlist(), 'utf8')
    assert.equal(xml, plistFor(moved))
    assert.equal(launchAgentPointsAt(NODE, CLI), false, 'the old path is gone')
  })
})

test('launchAgentInstalled sees a plist written by anything, ours or not', async () => {
  await withHome(async (home) => {
    mkdirSync(path.join(home, 'Library/LaunchAgents'), { recursive: true })
    writeFileSync(launchAgentPlist(), 'not really a plist')
    // Installed is a file test by design — `launchAgentPointsAt` is the one
    // that decides whether it is ours and current.
    assert.equal(launchAgentInstalled(), true)
    assert.equal(launchAgentPointsAt(NODE, CLI), false)
  })
})
