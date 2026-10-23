/**
 * Reload on build change (web/src/reloadOnBuild.ts): when the daemon behind an
 * open page changes build, does the page reload by itself, show the update
 * bar, or do nothing? The table is the design note's (§3,
 * .docs/overnight-2026-10-24/designs/reload-on-build-change.md), plus the
 * loop guard's cooldown and the server's read of the bundle's entry file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { classifyBuild, uiEntryOf } from '../server/state.js'
import {
  RELOAD_COOLDOWN_MS,
  buildChanged,
  buildKey,
  parseReloadMark,
  shouldAutoReload,
  type ReloadMark,
} from '../web/src/reloadOnBuild.js'
import type { Build } from '../shared/protocol.js'

const APP = '/Applications/Junior.app/Contents/Resources/junior'
const MOVED = '/Users/x/Applications/Junior.app/Contents/Resources/junior'
const CHECKOUT = '/Users/x/Code/novus-triage/triage-dev'
const HOME = path.join(os.homedir(), '.junior')
const NOW = 1_800_000_000_000

const b = (version: string, ui: string | null = 'index-a.js', dir = APP): Build => classifyBuild(dir, version, HOME, ui)

const v1 = b('1.0.4')
const v2 = b('1.0.5')
const dirtyA = b('1.0.4-dev.g23d0004.dirty', 'index-a.js')
const dirtyB = b('1.0.4-dev.g23d0004.dirty', 'index-b.js')
const noUi = b('1.0.4', null)
const movedV1 = b('1.0.4', 'index-a.js', MOVED)
const dev1 = b('1.0.4', 'index-a.js', CHECKOUT)
const dev2 = b('1.0.5', 'index-b.js', CHECKOUT)

const cases: {
  name: string
  loaded: Build | null
  next: Build
  busy: boolean
  last?: ReloadMark | null
  changed: boolean
  auto: boolean
}[] = [
  { name: 'the first hello of a page load: nothing to compare', loaded: null, next: v1, busy: false, changed: false, auto: false },
  { name: 'a plain restart on the same build', loaded: v1, next: v1, busy: false, changed: false, auto: false },
  { name: 'a new version, nothing in flight: reload', loaded: v1, next: v2, busy: false, changed: true, auto: true },
  { name: 'a new version with a draft or a card: the bar', loaded: v1, next: v2, busy: true, changed: true, auto: false },
  {
    name: 'already reloaded for this build: the bar, not a loop',
    loaded: v1,
    next: v2,
    busy: false,
    last: { key: buildKey(v2), at: NOW - 10 * RELOAD_COOLDOWN_MS },
    changed: true,
    auto: false,
  },
  {
    name: 'reloaded for another build moments ago: the bar (two daemons flapping)',
    loaded: v1,
    next: v2,
    busy: false,
    last: { key: buildKey(v1), at: NOW - 5_000 },
    changed: true,
    auto: false,
  },
  {
    name: 'reloaded for another build long ago: reload',
    loaded: v1,
    next: v2,
    busy: false,
    last: { key: buildKey(v1), at: NOW - RELOAD_COOLDOWN_MS },
    changed: true,
    auto: true,
  },
  { name: 'two dirty snapshots of one commit: the bundle tells them apart', loaded: dirtyA, next: dirtyB, busy: false, changed: true, auto: true },
  { name: 'no web build on either side', loaded: noUi, next: noUi, busy: false, changed: false, auto: false },
  { name: 'the app moved (another root, same version)', loaded: v1, next: movedV1, busy: false, changed: true, auto: true },
  { name: 'dev: Vite and HMR keep the UI current', loaded: dev1, next: dev2, busy: false, changed: false, auto: false },
  { name: 'a checkout took the port from prod: still dev, still nothing', loaded: v1, next: dev2, busy: false, changed: false, auto: false },
  { name: 'rolled back to the build this page runs', loaded: v2, next: v2, busy: true, changed: false, auto: false },
]

for (const c of cases) {
  test(`reload on build: ${c.name}`, () => {
    assert.equal(buildChanged(c.loaded, c.next), c.changed, 'changed')
    assert.equal(shouldAutoReload(c.loaded, c.next, c.busy, c.last, NOW), c.auto, 'auto')
  })
}

test('reload on build: three arguments are enough (no mark, real clock)', () => {
  assert.equal(shouldAutoReload(v1, v2, false), true)
  assert.equal(shouldAutoReload(v1, v2, true), false)
  assert.equal(shouldAutoReload(v1, v1, false), false)
})

test('reload on build: an older daemon without `ui` still compares on version and root', () => {
  const old: Build = { ...v1 }
  delete old.ui
  assert.equal(buildChanged(old, { ...v2, ui: undefined }), true)
  assert.equal(buildChanged(old, { ...v1, ui: undefined }), false)
})

test('reload on build: a malformed mark is no mark', () => {
  assert.deepEqual(parseReloadMark(JSON.stringify({ key: 'k', at: 5 })), { key: 'k', at: 5 })
  for (const raw of [null, '', 'nope', '42', 'null', JSON.stringify({ key: 1, at: 5 }), JSON.stringify({ key: 'k' })]) {
    assert.equal(parseReloadMark(raw), null, String(raw))
  }
})

test('reload on build: the server reads the bundle off index.html', () => {
  const html = `<head>\n<script type="module" crossorigin src="/assets/index-Bdx3dsyT.js"></script>\n<link rel="stylesheet" href="/assets/index-C1.css"></head>`
  assert.equal(uiEntryOf(html), 'index-Bdx3dsyT.js')
  assert.equal(uiEntryOf('<p>no build</p>'), null)
  assert.equal(classifyBuild(APP, '1.0.4', HOME).ui, null)
  assert.equal(classifyBuild(APP, '1.0.4', HOME, 'index-x.js').ui, 'index-x.js')
})
