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
  isBuild,
  loadedFrom,
  parseReloadMark,
  shouldAutoReload,
  uiEntryOfSrc,
  type ReloadMark,
} from '../web/src/reloadOnBuild.js'
import { blockersOf, type FieldFacts, type PageFacts } from '../web/src/reloadGuard.js'
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

test('reload on build: the page reads its own bundle the way the server reads index.html', () => {
  const html = `<script type="module" crossorigin src="/assets/index-Bdx3dsyT.js"></script>`
  assert.equal(uiEntryOfSrc('http://junior.localhost:5178/assets/index-Bdx3dsyT.js'), uiEntryOf(html))
  assert.equal(uiEntryOfSrc('/assets/index-Bdx3dsyT.js?v=1'), 'index-Bdx3dsyT.js')
  assert.equal(uiEntryOfSrc('http://localhost:5189/src/main.tsx'), null)
  assert.equal(uiEntryOfSrc('/assets/vendor-x.js'), null)
})

test('reload on build: a page loaded mid update runs the old bundle under the new hello', () => {
  // The old daemon served index.html (index-a.js); the new one answered the socket.
  const loaded = loadedFrom(v2, 'index-old.js')
  assert.equal(loaded.ui, 'index-old.js')
  assert.equal(buildChanged(loaded, v2), true)
  assert.equal(shouldAutoReload(loaded, v2, false), true)
  // The usual case: the page runs what the daemon serves.
  assert.equal(buildChanged(loadedFrom(v1, 'index-a.js'), v1), false)
  // Dev (no hashed script) and an old daemon (no ui) keep the hello as it is.
  assert.deepEqual(loadedFrom(v1, null), v1)
  assert.deepEqual(loadedFrom(noUi, 'index-z.js'), noUi)
  const old: Build = { ...v1 }
  delete old.ui
  assert.equal(buildChanged(loadedFrom(old, 'index-z.js'), old), false)
})

// What on screen holds an automatic reload (reloadGuard.ts)

const page = (p: Partial<PageFacts> = {}): PageFacts => ({ guards: [], focused: null, fields: [], dialogOpen: false, hidden: false, ...p })
const ta = (text: string, more: Partial<FieldFacts> = {}): FieldFacts => ({ kind: 'textarea', text, ...more })
const input = (type: string, text: string, more: Partial<FieldFacts> = {}): FieldFacts => ({ kind: 'input', type, text, ...more })

const typed = { typed: true }

const guardCases: { name: string; page: PageFacts; want: string[] }[] = [
  { name: 'an empty page', page: page(), want: [] },
  { name: 'a marked draft and a waiting card', page: page({ guards: ['draft', 'card', 'nonsense'] }), want: ['draft', 'card'] },
  { name: 'an empty autofocused composer', page: page({ focused: ta('', { exempt: true }), fields: [ta('', { exempt: true })] }), want: [] },
  {
    name: 'an unguarded textarea you typed in (a reply in Needs you), focus elsewhere',
    page: page({ fields: [ta('LGTM, one nit', typed)] }),
    want: ['edit'],
  },
  {
    name: 'the same, window hidden: still held, the text would be lost either way',
    page: page({ fields: [ta('LGTM, one nit', typed)], hidden: true }),
    want: ['edit'],
  },
  {
    name: 'focus in the terminal: xterm’s helper textarea is no text of yours',
    page: page({ focused: ta(' ', { exempt: true, typed: true }), fields: [ta(' ', { exempt: true, typed: true })] }),
    want: [],
  },
  {
    name: 'a persisted composer draft: its own guard covers it, not the safety net',
    page: page({ fields: [ta('half a thought', { exempt: true, typed: true })] }),
    want: [],
  },
  {
    // The subagent composer keeps its text in memory: it marks itself `draft`,
    // and is not exempt, so the typing rule and the safety net both see it.
    name: 'a composer that keeps nothing in storage, typing in it',
    page: page({ guards: ['draft'], focused: ta('ask it to retry', typed), fields: [ta('ask it to retry', typed)] }),
    want: ['draft', 'typing', 'edit'],
  },
  {
    name: 'typing in a single-line field, window visible: typing, not an edit',
    page: page({ focused: input('text', 'acme', typed), fields: [input('text', 'acme', typed)] }),
    want: ['typing'],
  },
  {
    name: 'a filter with text, out of focus (Filter jobs…): no edit',
    page: page({ fields: [input('text', 'flaky', typed)] }),
    want: [],
  },
  {
    name: 'a settings field that saved on blur: no edit',
    page: page({ fields: [input('number', '2.5', typed), input('text', 'Acme', typed)] }),
    want: [],
  },
  {
    name: 'the browser address, prefilled and focused: a URL you didn’t type',
    page: page({ focused: input('', 'https://acme.dev/login'), fields: [input('', 'https://acme.dev/login')] }),
    want: [],
  },
  {
    name: 'a form opened on saved values (a job’s instructions), untouched',
    page: page({ fields: [ta('Every morning, triage the inbox.'), input('text', 'morning-triage')] }),
    want: [],
  },
  {
    name: 'the same form after you changed the instructions',
    page: page({ fields: [ta('Every morning, triage the inbox. Skip Fridays.', typed)] }),
    want: ['edit'],
  },
  { name: 'a search filter, window hidden', page: page({ fields: [input('search', 'flaky', typed)], hidden: true }), want: [] },
  {
    name: 'read-only and disabled fields',
    page: page({ fields: [ta('log', { readOnly: true, typed: true }), ta('x', { disabled: true, typed: true })] }),
    want: [],
  },
  { name: 'a checkbox is not text', page: page({ focused: input('checkbox', 'on', typed), fields: [input('checkbox', 'on', typed)] }), want: [] },
  { name: 'a contenteditable you typed in', page: page({ fields: [{ kind: 'editable', text: 'notes', typed: true }] }), want: ['edit'] },
  { name: 'an open dialog', page: page({ dialogOpen: true }), want: ['dialog'] },
]

for (const c of guardCases) {
  test(`reload guard: ${c.name}`, () => {
    assert.deepEqual([...blockersOf(c.page)].sort(), [...c.want].sort())
  })
}

test('reload on build: a malformed build off the socket is no build', () => {
  assert.equal(isBuild(v1), true)
  assert.equal(isBuild(noUi), true)
  const old: Partial<Build> = { ...v1 }
  delete old.ui
  assert.equal(isBuild(old), true)
  for (const bad of [null, undefined, 'v1', 42, {}, { ...v1, version: 5 }, { ...v1, root: null }, { ...v1, channel: 'beta' }, { ...v1, ui: 3 }]) {
    assert.equal(isBuild(bad), false, JSON.stringify(bad))
  }
})
