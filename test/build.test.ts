/**
 * Build identity (server/state.ts `classifyBuild`): which copy of junior is
 * answering. Three can be installed at once — a checkout, the one staged inside
 * Junior.app, a global npm install — and the whole point is that a bare version
 * number does not tell them apart. The table below is the contract the top-bar
 * badge, `junior status` and /api/health all read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { classifyBuild } from '../server/state.js'

const APP = '/Applications/Junior.app/Contents/Resources/junior'
const GLOBAL = '/Users/x/.local/lib/node_modules/usejunior'
const CHECKOUT = '/Users/x/Code/novus-triage/triage-dev'
const PROD_HOME = path.join(os.homedir(), '.junior')
const DEV_HOME = path.join(os.homedir(), '.junior-dev')

type Expected = Pick<ReturnType<typeof classifyBuild>, 'channel' | 'surface' | 'commit' | 'dirty'>

const cases: { name: string; dir: string; version: string; want: Expected }[] = [
  {
    name: 'the released app — what `curl | sh` hands out',
    dir: APP,
    version: '1.0.3',
    want: { channel: 'release', surface: 'app', commit: null, dirty: false },
  },
  {
    name: 'an app built from commits nobody has yet',
    dir: APP,
    version: '1.0.4-dev.g23d0004',
    want: { channel: 'preview', surface: 'app', commit: '23d0004', dirty: false },
  },
  {
    name: 'an app built with uncommitted work in the tree',
    dir: APP,
    version: '1.0.4-dev.g23d0004.dirty',
    want: { channel: 'preview', surface: 'app', commit: '23d0004', dirty: true },
  },
  {
    name: 'a global npm install of a release',
    dir: GLOBAL,
    version: '1.0.3',
    want: { channel: 'release', surface: 'global', commit: null, dirty: false },
  },
  {
    name: 'a global npm install of a snapshot',
    dir: GLOBAL,
    version: '1.0.4-dev.g23d0004',
    want: { channel: 'preview', surface: 'global', commit: '23d0004', dirty: false },
  },
  {
    name: 'the working tree — version says nothing, the path does',
    dir: CHECKOUT,
    version: '1.0.3',
    want: { channel: 'dev', surface: 'checkout', commit: null, dirty: false },
  },
]

for (const c of cases) {
  test(`classifyBuild: ${c.name}`, () => {
    const got = classifyBuild(c.dir, c.version, PROD_HOME)
    assert.deepEqual(
      { channel: got.channel, surface: got.surface, commit: got.commit, dirty: got.dirty },
      c.want,
    )
    assert.equal(got.root, c.dir, 'the path on disk is reported verbatim')
    assert.equal(got.version, c.version)
  })
}

test('classifyBuild: a prerelease that is not a snapshot label is still unreleased', () => {
  // `npm version prerelease` or a hand-cut rc — no sha to show, but it is
  // emphatically not what anyone else is running.
  const got = classifyBuild(APP, '1.1.0-rc.1', PROD_HOME)
  assert.equal(got.channel, 'preview')
  assert.equal(got.commit, null)
  assert.equal(got.dirty, false)
})

test('classifyBuild: the data root is what separates a dev daemon from prod', () => {
  assert.equal(classifyBuild(CHECKOUT, '1.0.3', PROD_HOME).prodData, true)
  assert.equal(classifyBuild(CHECKOUT, '1.0.3', DEV_HOME).prodData, false)
  // A checkout pointed at prod's data is the genuinely dangerous combination
  // (JUNIOR_HOME=~/.junior npm run dev) — it must still read as prod data.
  assert.equal(classifyBuild(CHECKOUT, '1.0.3', PROD_HOME).channel, 'dev')
})

test('classifyBuild: an app inside a node_modules-free path is never "global"', () => {
  // The app bundle wins over the node_modules test: its staged package has a
  // node_modules of its own, and `<app>/Contents/Resources/junior/node_modules`
  // must not be mistaken for a global install.
  const nested = path.join(APP, 'node_modules', 'usejunior')
  assert.equal(classifyBuild(nested, '1.0.3', PROD_HOME).surface, 'app')
})
