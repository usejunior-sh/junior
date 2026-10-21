/**
 * Browser profiles and the gate (.docs/browser.md → Profiles, Logged-in
 * sites): the pure profile helpers, the machine-wide registry, the tab store,
 * how the hub picks a tab's profile and remembers where it was, snapshot
 * search, and what a click on a signed-in site may do without asking.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { findProfile, hostAllowed, partitionOf, profileIdFor, profileNameError, profileOfSigninTab, signinTabKey, siteOf, type BrowserProfile } from '../core/browser/profiles.js'
import { clickVerdict, keyVerdict, typeVerdict, type ElementFacts } from '../core/browser/policy.js'
import { formatSnapshot, type AXNode } from '../core/browser/snapshot.js'
import { BROWSER_WIRE_VERSION, parseHostFrame } from '../core/browser/wire.js'
import type { BrowserTabRow, BrowserTabStore } from '../core/store/types.js'
import type { ServerMessage } from '../shared/protocol.js'

// TRIAGE_DIR is fixed when state.ts loads, so the root is set before the imports that read it.
const home = mkdtempSync(path.join(os.tmpdir(), 'triage-browser-'))
process.env.TRIAGE_HOME = home
const { BrowserProfiles, browserProfiles, readProfilesFile } = await import('../server/browser/profiles.js')
const { BrowserHub } = await import('../server/browser/hub.js')
const { browserGate } = await import('../server/browser/gate.js')
const { makeBrowserMcp } = await import('../server/browser/mcp.js')
const { HELD_BY_USER } = await import('../server/browser/tool-kit.js')
const { ShotStore } = await import('../server/browser/evidence.js')
const { openSqliteStore } = await import('../core/store/sqlite.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const p = (id: string, name: string): BrowserProfile => ({ id, name, color: 'blue', createdAt: 1, lastUsedAt: null })

// ── pure ────────────────────────────────────────────────────────────────────

test('profiles: ids are slugs, unique, never "default"; Default keeps the old jar', () => {
  assert.equal(profileIdFor('Work', new Set()), 'work')
  assert.equal(profileIdFor('Work', new Set(['work'])), 'work-2')
  assert.equal(profileIdFor('Pendo — Test User!', new Set()), 'pendo-test-user')
  assert.equal(profileIdFor('Default', new Set(['default'])), 'default-1')
  assert.equal(profileIdFor('???', new Set()), 'profile')
  assert.equal(partitionOf('default'), 'persist:triage-browser')
  assert.equal(partitionOf('work'), 'persist:triage-profile-work')
  assert.equal(signinTabKey('work'), 'profile-work')
  assert.equal(profileOfSigninTab('profile-work'), 'work')
  assert.equal(profileOfSigninTab('1b2c3d4e-session'), null)
})

test('profiles: names are unique in any case; found by id or name', () => {
  const list = [p('default', 'Default'), p('work', 'Work')]
  assert.match(profileNameError('work', list)!, /already/)
  assert.equal(profileNameError('Work', list, 'work'), null)
  assert.match(profileNameError('  ', list)!, /needs a name/)
  assert.match(profileNameError('x'.repeat(41), list)!, /under/)
  assert.equal(findProfile(list, 'WORK')?.id, 'work')
  assert.equal(findProfile(list, 'default')?.name, 'Default')
  assert.equal(findProfile(list, 'nope'), null)
})

test('profiles: a cookie domain groups under its site; a job site list matches hosts', () => {
  assert.equal(siteOf('.mail.google.com'), 'google.com')
  assert.equal(siteOf('app.pendo.io'), 'pendo.io')
  assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk')
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1')
  assert.equal(siteOf('localhost'), 'localhost')
  assert.equal(hostAllowed(undefined, 'https://x.com'), true)
  assert.equal(hostAllowed(['app.pendo.io'], 'https://app.pendo.io/s/1'), true)
  assert.equal(hostAllowed(['app.pendo.io'], 'https://evil.io/?app.pendo.io'), false)
  assert.equal(hostAllowed(['*.pendo.io'], 'https://eu.pendo.io/'), true)
  assert.equal(hostAllowed(['*.pendo.io'], 'https://pendo.io/'), true)
  assert.equal(hostAllowed(['*.pendo.io'], 'https://notpendo.io/'), false)
})

const el = (o: Partial<ElementFacts>): ElementFacts => ({ role: 'button', name: '', tag: 'button', type: '', inForm: false, editable: false, ...o })

test('gate verdicts: what a click may commit', () => {
  const cases: [Partial<ElementFacts> | null, string][] = [
    [{ name: 'Send' }, 'commit'],
    [{ name: 'Reply all' }, 'commit'],
    [{ name: 'Merge pull request' }, 'commit'],
    [{ name: 'Delete' }, 'commit'],
    [{ name: 'Save changes' }, 'commit'],
    [{ name: 'Close' }, 'free'],
    [{ name: 'Cancel' }, 'free'],
    [{ name: 'Next page' }, 'free'],
    [{ name: '' }, 'unsure'], // an icon button: could be anything
    [{ role: 'link', tag: 'a', name: 'Settings' }, 'free'],
    [{ role: 'link', tag: 'a', name: 'Delete account' }, 'commit'],
    // a mail's subject line is content, not a verb
    [{ role: 'row', tag: 'tr', name: 'Re: please merge my PR when you get a chance — Alex, 3:04 PM' }, 'free'],
    [{ name: 'Continue', inForm: true }, 'unsure'], // a form's submit button
    [{ name: 'Search', inForm: true }, 'free'],
    [{ role: 'switch', tag: 'button', name: 'Dark mode' }, 'commit'],
    [{ role: 'checkbox', tag: 'input', type: 'checkbox', name: 'Select' }, 'free'],
    [null, 'unsure'],
  ]
  for (const [facts, want] of cases) assert.equal(clickVerdict(facts ? el(facts) : null), want, JSON.stringify(facts))
})

test('gate verdicts: Enter in a composer or form commits, ⌘Enter always, search never; passwords are refused', () => {
  const box = el({ role: 'textbox', tag: 'div', name: 'Message body', editable: true })
  assert.equal(keyVerdict('Enter', box), 'commit')
  assert.equal(keyVerdict('Meta+Enter', null), 'commit')
  assert.equal(keyVerdict('Tab', box), 'free')
  assert.equal(keyVerdict('Enter', el({ role: 'searchbox', tag: 'input', type: 'search', editable: true, inForm: true })), 'free')
  assert.equal(keyVerdict('Enter', el({ role: 'textbox', tag: 'textarea', editable: true })), 'unsure')
  assert.equal(keyVerdict('Enter', null), 'unsure')
  assert.equal(typeVerdict(el({ role: 'textbox', tag: 'input', type: 'password', editable: true })), 'password')
  assert.equal(typeVerdict(el({ role: 'textbox', tag: 'input', type: 'email', editable: true, name: 'Email' })), 'free')
})

test('snapshot find: only what mentions the text, with the path to it and what is inside', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Inbox' }, childIds: ['2', '5'], backendDOMNodeId: 1 },
    { nodeId: '2', role: { value: 'list' }, name: { value: 'Mail' }, parentId: '1', childIds: ['3', '4'], backendDOMNodeId: 2 },
    { nodeId: '3', role: { value: 'row' }, name: { value: 'Weekly report from Pendo' }, parentId: '2', childIds: ['6'], backendDOMNodeId: 3 },
    { nodeId: '6', role: { value: 'link' }, name: { value: 'Open' }, parentId: '3', backendDOMNodeId: 6 },
    { nodeId: '4', role: { value: 'row' }, name: { value: 'Lunch?' }, parentId: '2', backendDOMNodeId: 4 },
    { nodeId: '5', role: { value: 'button' }, name: { value: 'Compose' }, parentId: '1', backendDOMNodeId: 5 },
  ]
  const s = formatSnapshot(nodes, { find: 'pendo' }).text
  assert.match(s, /uid=3 row "Weekly report from Pendo"/)
  assert.match(s, /uid=6 link "Open"/) // inside the match
  assert.match(s, /uid=2 list/) // on the way down
  assert.doesNotMatch(s, /Lunch|Compose/)
  assert.match(formatSnapshot(nodes, { find: 'zebra' }).text, /Nothing on the page matches "zebra"/)
  assert.match(formatSnapshot(nodes, { find: 'pendo', rootUid: 5 }).text, /Nothing in uid=5/)
})

test('wire v2: the new host frames are validated', () => {
  assert.equal(BROWSER_WIRE_VERSION, 2)
  assert.ok(parseHostFrame(JSON.stringify({ type: 'tab', sessionId: 's', profile: 'work', url: 'https://x', title: 't', viewport: null, colorScheme: null })))
  assert.equal(parseHostFrame(JSON.stringify({ type: 'tab', sessionId: 's', url: 'https://x', title: 't' })), null)
  assert.ok(parseHostFrame(JSON.stringify({ type: 'popup', sessionId: 's', url: 'https://accounts.google.com', state: 'opened' })))
  assert.equal(parseHostFrame(JSON.stringify({ type: 'popup', sessionId: 's', url: 'x', state: 'maybe' })), null)
  assert.ok(parseHostFrame(JSON.stringify({ type: 'dialog', sessionId: 's', dialog: null })))
  assert.ok(parseHostFrame(JSON.stringify({ type: 'download', sessionId: 's', file: 'a.csv', path: '/d/a.csv', bytes: 3, state: 'completed', byAgent: true })))
})

// ── the registry ────────────────────────────────────────────────────────────

test('registry: Default always first, bad rows dropped', () => {
  const r = readProfilesFile({ profiles: [{ id: 'work', name: 'Work', color: 'pink' }, { id: 'Bad Id', name: 'x' }, { id: 'work', name: 'dup' }], pendingDrops: ['old', 'default', 7] })
  assert.deepEqual(r.profiles.map((x) => x.id), ['default', 'work'])
  assert.equal(r.profiles[1].color, 'gray')
  assert.deepEqual(r.pendingDrops, ['old'])
})

test('registry: create, rename, delete; Default stays; the file is 0600 and reloads', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'triage-prof-')), 'browser-profiles.json')
  const reg = new BrowserProfiles(file)
  let changes = 0
  reg.onChange(() => changes++)
  const work = await reg.create({ name: 'Work', color: 'green' })
  assert.equal(work.id, 'work')
  await assert.rejects(reg.create({ name: 'work' }), /already/)
  const renamed = await reg.update('work', { name: 'Pendo' })
  assert.equal(renamed.id, 'work') // the jar never moves
  assert.equal(reg.find('pendo')?.id, 'work')
  await assert.rejects(reg.remove('default'), /cleared, not deleted/)
  await reg.remove('work')
  assert.deepEqual(reg.drops(), ['work'])
  // a new profile can't take a jar that is still waiting to be wiped
  assert.equal((await reg.create({ name: 'Work' })).id, 'work-2')
  assert.equal(changes, 4)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const again = new BrowserProfiles(file)
  assert.deepEqual(again.list().map((x) => x.name), ['Default', 'Work'])
  assert.deepEqual(again.drops(), ['work'])
  await again.dropped('work')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pendingDrops, undefined)
  // what the app last said each is signed in to reads back with the app closed
  await again.setSites('work-2', [{ site: 'google.com', persistent: 3 }, { site: 'ads.example', persistent: 0 }, { site: 'pendo.io', persistent: 9 }], 42)
  assert.deepEqual(new BrowserProfiles(file).get('work-2'), { ...again.get('work-2'), sites: ['pendo.io', 'google.com'], sitesAt: 42 })
})

// ── the tab store ───────────────────────────────────────────────────────────

test('store: browser_tabs upserts, keeps what a patch leaves out, lists by profile', async () => {
  const store = openSqliteStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'triage-tabs-')), 'triage.db'))
  await store.browserTabs.put('s1', { url: 'https://a', title: 'A', viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } }, 10)
  await store.browserTabs.put('s1', { profile: 'work' }, 20)
  const row = await store.browserTabs.get('s1')
  assert.deepEqual(row, { sessionId: 's1', profile: 'work', url: 'https://a', title: 'A', viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, colorScheme: null, updatedAt: 20 })
  assert.deepEqual(await store.browserTabs.withProfile('work'), ['s1'])
  await store.browserTabs.remove('s1')
  assert.equal(await store.browserTabs.get('s1'), null)
  await store.close()
})

// ── the hub ─────────────────────────────────────────────────────────────────

class MemTabs implements BrowserTabStore {
  rows = new Map<string, BrowserTabRow>()
  async get(id: string) {
    return this.rows.get(id) ?? null
  }
  async put(id: string, patch: Partial<Omit<BrowserTabRow, 'sessionId' | 'updatedAt'>>, at: number) {
    const cur = this.rows.get(id) ?? { sessionId: id, profile: null, url: '', title: '', viewport: null, colorScheme: null, updatedAt: at }
    this.rows.set(id, { ...cur, ...patch, updatedAt: at })
  }
  async remove(id: string) {
    this.rows.delete(id)
  }
  async withProfile(profile: string) {
    return [...this.rows.values()].filter((r) => r.profile === profile).map((r) => r.sessionId)
  }
}

type Frame = Record<string, unknown>
/** The host holds this call, as Chrome holds input that opened a dialog. */
const NO_REPLY = Symbol('no reply')
async function withHost(answer: (f: Frame) => unknown, run: (hub: InstanceType<typeof BrowserHub>, host: WebSocket, seen: Frame[]) => Promise<void>) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.once('listening', r))
  const hub = new BrowserHub()
  wss.on('connection', (ws) => hub.attach(ws))
  const host = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`)
  await new Promise((r) => host.once('open', r))
  const seen: Frame[] = []
  host.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as Frame
    seen.push(f)
    try {
      const result = answer(f)
      if (result === NO_REPLY) return
      host.send(JSON.stringify({ type: 'result', id: f.id, ok: true, result: result ?? null }))
    } catch (err) {
      host.send(JSON.stringify({ type: 'result', id: f.id, ok: false, error: (err as Error).message }))
    }
  })
  host.send(JSON.stringify({ type: 'hello', version: BROWSER_WIRE_VERSION, app: 'test host' }))
  for (let i = 0; i < 50 && !hub.status.connected; i++) await sleep(10)
  try {
    await run(hub, host, seen)
  } finally {
    host.close()
    wss.close()
  }
}

test('hub: a tab is in its own pick, else its lead’s, its job’s, the workspace default, else Default', async () => {
  const reg = browserProfiles()
  await reg.create({ name: 'Work' })
  await reg.create({ name: 'Pendo' })
  await reg.create({ name: 'Gone' })
  const tabs = new MemTabs()
  await tabs.put('picked', { profile: 'pendo' }, 1)
  await tabs.put('stale', { profile: 'gone' }, 1)
  let wsDefault = 'work'
  const hub = new BrowserHub()
  hub.setResolver((id) =>
    id === 'nobody' ? null : { store: tabs, defaultProfile: async () => wsDefault, leadSessionId: id === 'worker' ? 'picked' : null, broadcast: () => {} },
  )
  hub.fallbackProfile('job-run', 'pendo')
  assert.deepEqual(await hub.resolve('picked'), { profile: 'pendo', explicit: true, missing: null })
  assert.equal((await hub.resolve('worker')).profile, 'pendo')
  assert.equal((await hub.resolve('job-run')).profile, 'pendo')
  assert.equal((await hub.resolve('plain')).profile, 'work')
  assert.equal((await hub.resolve('nobody')).profile, 'default')
  assert.deepEqual(await hub.resolve('profile-pendo'), { profile: 'pendo', explicit: true, missing: null })
  await reg.remove('gone')
  assert.deepEqual(await hub.resolve('stale'), { profile: 'work', explicit: false, missing: 'gone' })
  wsDefault = 'gone'
  assert.equal((await hub.resolve('plain')).profile, 'default')
})

test('hub: every call names the profile; the tab is remembered, announced, switched and reopened where it was', async () => {
  const tabs = new MemTabs()
  const told: ServerMessage[] = []
  await withHost(
    (f) => (f.verb === 'open' ? { url: f.url, title: 'T', status: 200 } : f.op === 'sites' ? { sites: [{ site: 'google.com', cookies: 9, persistent: 4, expiresAt: null }] } : null),
    async (hub, host, seen) => {
      hub.setResolver(() => ({ store: tabs, defaultProfile: async () => 'default', leadSessionId: null, broadcast: (m) => told.push(m) }))
      await hub.call('s1', { verb: 'state' })
      assert.equal(seen.at(-1)!.profile, 'default')
      // the app says where the tab is: remembered at once, written a moment later, announced
      host.send(JSON.stringify({ type: 'tab', sessionId: 's1', profile: 'default', url: 'https://mail.google.com/', title: 'Inbox', viewport: null, colorScheme: 'dark' }))
      await sleep(1200)
      assert.equal(tabs.rows.get('s1')?.url, 'https://mail.google.com/')
      assert.equal(tabs.rows.get('s1')?.profile, null) // where it is is not a pick
      const announced = told.find((m) => m.type === 'browser_tab')
      assert.ok(announced && announced.type === 'browser_tab' && announced.tab.live && announced.tab.title === 'Inbox')
      // switching a live tab reloads its page in the new jar
      await hub.setProfile('s1', 'work')
      const reopen = seen.at(-1)!
      assert.deepEqual([reopen.verb, reopen.url, reopen.profile], ['open', 'https://mail.google.com/', 'work'])
      assert.equal(tabs.rows.get('s1')?.profile, 'work')
      await assert.rejects(hub.setProfile('s1', 'nope'), /No profile/)
      // the app closed it: the next open restores its scheme first
      host.send(JSON.stringify({ type: 'closed', sessionId: 's1' }))
      await sleep(30)
      assert.equal(hub.isLive('s1'), false)
      const r = await hub.open('s1', null)
      assert.equal(r.revived, true)
      assert.deepEqual(seen.at(-1)!.restore, { viewport: null, colorScheme: 'dark' })
      await assert.rejects(hub.open('never', null), /never been anywhere/)
      // a whole jar: no tab involved
      const sites = await hub.profileCall<{ sites: unknown[] }>('work', { op: 'sites' })
      assert.equal(sites.sites.length, 1)
      assert.deepEqual([seen.at(-1)!.type, seen.at(-1)!.op, seen.at(-1)!.profile], ['profile', 'sites', 'work'])
      // a download during an agent call is told to the agent once, and to the pane
      host.send(JSON.stringify({ type: 'download', sessionId: 's1', file: 'r.csv', path: '/tmp/r.csv', bytes: 10, state: 'completed', byAgent: true }))
      await sleep(30)
      assert.equal(hub.page('s1').downloads.length, 1)
      assert.ok(told.some((m) => m.type === 'browser_download'))
    },
  )
})

// ── the gate ────────────────────────────────────────────────────────────────

/** A host that answers the gate's questions about one element. */
function describing(facts: Partial<ElementFacts>) {
  const f = el(facts)
  return (frame: Frame) => {
    if (frame.verb !== 'cdp') return null
    if (frame.method === 'Accessibility.getPartialAXTree') return { nodes: [{ nodeId: '1', role: { value: f.role }, name: { value: f.name }, backendDOMNodeId: 7 }] }
    if (frame.method === 'DOM.resolveNode') return { object: { objectId: 'o1' } }
    if (frame.method === 'Runtime.callFunctionOn') return { result: { value: { tag: f.tag, type: f.type, inForm: f.inForm, editable: f.editable } } }
    return null
  }
}

const ACT = 'mcp__browser__browser_act'
const OPEN = 'mcp__browser__browser_open'

test('gate: on a signed-in site a Send click asks in a chat and is refused in a job; local pages are free', async () => {
  await withHost(describing({ name: 'Send' }), async (hub) => {
    const ctx = { hub, sessionId: 'g1', projectRoot: '/tmp/proj', mode: 'chat' as const }
    hub.page('g1').url = 'http://localhost:5173/compose'
    assert.equal(await browserGate(ctx, ACT, { action: 'click', uid: 7 }), null)
    hub.page('g1').url = 'https://mail.google.com/mail/u/0/'
    const d = await browserGate(ctx, ACT, { action: 'click', uid: 7 })
    assert.ok(d && !d.allow && d.ask)
    assert.match(d.reason, /Click "Send" on mail\.google\.com as Default\?/)
    // the session's permission handler hears it was asked, once
    assert.match(hub.page('g1').takeAsk(ACT, { action: 'click', uid: 7 })!, /Send/)
    assert.equal(hub.page('g1').takeAsk(ACT, { action: 'click', uid: 7 }), null)
    const j = await browserGate({ ...ctx, mode: 'job' }, ACT, { action: 'click', uid: 7 })
    assert.ok(j && !j.allow && !j.ask)
    assert.match(j.reason, /A job can't do that on mail\.google\.com/)
    // moving around is free
    assert.equal(await browserGate(ctx, ACT, { action: 'scroll' }), null)
    // not a browser tool: no opinion
    assert.equal(await browserGate(ctx, 'Bash', { command: 'ls' }), null)
  })
})

test('gate: never a password on a site; a chat asks once per site; a job opens only its sites', async () => {
  await withHost(describing({ role: 'textbox', tag: 'input', type: 'password', editable: true, name: 'Password' }), async (hub) => {
    const ctx = { hub, sessionId: 'g2', projectRoot: '/tmp/proj', mode: 'chat' as const }
    hub.page('g2').url = 'https://app.pendo.io/login'
    const pw = await browserGate(ctx, ACT, { action: 'type', uid: 7, text: 'hunter2' })
    assert.ok(pw && !pw.allow && !pw.ask)
    const fill = await browserGate(ctx, 'mcp__browser__browser_fill', { fields: [{ uid: 7, value: 'x' }] })
    assert.ok(fill && !fill.allow && /passwords/.test(fill.reason))

    assert.equal(await browserGate(ctx, OPEN, { url: 'localhost:3000' }), null)
    const first = await browserGate(ctx, OPEN, { url: 'https://app.pendo.io/s/123' })
    assert.ok(first && !first.allow && first.ask && /Open app\.pendo\.io as Default\?/.test(first.reason))
    hub.page('g2').sites.add('pendo.io') // browser_open ran: the user said yes
    assert.equal(await browserGate(ctx, OPEN, { url: 'https://eu.pendo.io/' }), null)

    const job = { ...ctx, mode: 'job' as const, sites: ['app.pendo.io'] }
    assert.equal(await browserGate(job, OPEN, { url: 'https://app.pendo.io/s/1' }), null)
    const off = await browserGate(job, OPEN, { url: 'https://mail.google.com' })
    assert.ok(off && !off.allow && /may only open app\.pendo\.io/.test(off.reason))
  })
})

test('take over: while the user holds the tab every tool but browser_profiles waits; hand back and forget clear it', async () => {
  const told: ServerMessage[] = []
  const tabs = new MemTabs()
  await withHost(
    (f) => (f.verb === 'state' ? { exists: true, url: 'http://localhost:3000/', title: 'App', loading: false, viewport: null, colorScheme: null, profile: 'default', popup: null, dialog: null } : null),
    async (hub) => {
      hub.setResolver(() => ({ store: tabs, defaultProfile: async () => 'default', leadSessionId: null, broadcast: (m) => told.push(m) }))
      const server = makeBrowserMcp({ hub, shots: new ShotStore(mkdtempSync(path.join(os.tmpdir(), 'triage-shots-'))), sessionId: 't1', projectRoot: '/tmp/p', mode: 'chat' })
      const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler?: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }>; callback?: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }> }> })._registeredTools
      const call = (name: string, args: unknown = {}) => {
        const t = tools[name]
        return (t.handler ?? t.callback)!(args, {})
      }
      const info = await hub.setHeld('t1', true)
      assert.equal(info.heldByUser, true)
      await sleep(20)
      assert.ok(told.some((m) => m.type === 'browser_tab' && m.tab.heldByUser))
      for (const name of ['browser_snapshot', 'browser_open', 'browser_act', 'browser_wait', 'browser_extract']) {
        const r = await call(name, name === 'browser_open' ? { url: 'localhost:3000' } : name === 'browser_act' ? { action: 'scroll' } : name === 'browser_wait' ? { text: 'x' } : name === 'browser_extract' ? { as: 'text' } : {})
        assert.equal(r.isError, true, name)
        assert.equal(r.content[0].text, HELD_BY_USER)
      }
      // the gate stays out of the way: the tool says why
      hub.page('t1').url = 'https://mail.google.com/'
      assert.equal(await browserGate({ hub, sessionId: 't1', projectRoot: '/tmp/p', mode: 'chat' }, ACT, { action: 'click', uid: 7 }), null)
      const profiles = await call('browser_profiles')
      assert.notEqual(profiles.isError, true)
      assert.equal((await hub.setHeld('t1', false)).heldByUser, false)
      const snap = await call('browser_snapshot')
      assert.notEqual(snap.content[0].text, HELD_BY_USER)
      await hub.setHeld('t1', true)
      hub.forget('t1')
      assert.equal(hub.page('t1').heldByUser, false)
    },
  )
})

const STATE = { exists: true, url: 'http://localhost:3000/', title: 'App', loading: false, viewport: null, colorScheme: null, profile: 'default', popup: null, dialog: null }
type ToolFn = (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }>
const toolsOf = (server: ReturnType<typeof makeBrowserMcp>) => {
  const reg = (server.instance as unknown as { _registeredTools: Record<string, { handler: ToolFn }> })._registeredTools
  return (name: string, args: unknown = {}) => reg[name].handler(args, {})
}
const textOf = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')

test('dialog: a click that opens confirm() returns at once; other tools say a dialog blocks the page; dismiss answers it', async () => {
  let dialogUp = false
  await withHost(
    (f) => {
      if (f.verb === 'state') return STATE
      if (f.verb !== 'cdp') return null
      if (f.method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
      if (f.method === 'DOM.getContentQuads') return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }
      if (f.method === 'Input.dispatchMouseEvent' && (f.params as Frame).type === 'mousePressed') {
        dialogUp = true
        return NO_REPLY
      }
      if (f.method === 'Page.handleJavaScriptDialog') return {}
      return dialogUp ? NO_REPLY : {}
    },
    async (hub, host, seen) => {
      const call = toolsOf(makeBrowserMcp({ hub, shots: new ShotStore(mkdtempSync(path.join(os.tmpdir(), 'triage-shots-'))), sessionId: 'd1', projectRoot: '/tmp/p', mode: 'chat' }))
      const clicking = call('browser_act', { action: 'click', uid: 4 })
      await sleep(50)
      host.send(JSON.stringify({ type: 'dialog', sessionId: 'd1', dialog: { type: 'confirm', message: 'Delete it?' } }))
      const started = Date.now()
      const r = await clicking
      assert.ok(Date.now() - started < 1000)
      assert.match(textOf(r), /That opened a dialog\.[\s\S]*confirm dialog is open: "Delete it\?"/)
      // a snapshot would hang on the blocked page: it says why instead
      const snap = await call('browser_snapshot')
      assert.match(textOf(snap), /dialog is open/)
      assert.ok(!seen.some((f) => f.method === 'Accessibility.getFullAXTree'))
      // the logs still read (they are the daemon's), with the dialog noted under them
      const logs = await call('browser_logs')
      assert.match(textOf(logs), /^No console errors[\s\S]*dialog is open/)
      const answered = await call('browser_act', { action: 'dialog', text: 'dismiss' })
      assert.match(textOf(answered), /Dismissed the confirm "Delete it\?"/)
      assert.deepEqual(seen.find((f) => f.method === 'Page.handleJavaScriptDialog')?.params, { accept: false })
      assert.equal(hub.page('d1').dialog, null)
    },
  )
})

test('the pane moving the page is the user, not Junior', async () => {
  await withHost(
    (f) => (f.verb === 'open' ? { url: f.url, title: 'T', status: 200 } : null),
    async (hub, _host, seen) => {
      await hub.open('u1', 'https://example.com/', 'load', { byUser: true })
      assert.equal(seen.at(-1)!.byUser, true)
      assert.equal(hub.page('u1').touched, true)
      hub.page('u1').touched = false
      await hub.open('u1', 'https://example.com/b', 'load')
      assert.equal(seen.at(-1)!.byUser, undefined)
      assert.equal(hub.page('u1').touched, false)
    },
  )
})

test('a profile sign-in tab is never driven by a tool', async () => {
  await withHost(
    () => STATE,
    async (hub, _host, seen) => {
      const call = toolsOf(makeBrowserMcp({ hub, shots: new ShotStore(mkdtempSync(path.join(os.tmpdir(), 'triage-shots-'))), sessionId: 'profile-work', projectRoot: '/tmp/p', mode: 'chat' }))
      for (const [name, args] of [['browser_open', { url: 'localhost:3000' }], ['browser_snapshot', {}], ['browser_act', { action: 'scroll' }]] as const) {
        const r = await call(name, args)
        assert.equal(r.isError, true, name)
        assert.match(textOf(r), /sign-in tab/)
      }
      assert.equal(seen.length, 0)
    },
  )
})

test('downloads during an agent call land under the home folder', async () => {
  const { downloadDirFor } = await import('../server/browser/hub.js')
  assert.equal(downloadDirFor('s1'), path.join(os.homedir(), 'Downloads', 'Triage', 's1'))
})

test('steps: what the driving strip says Junior is doing', async () => {
  const { stepText } = await import('../core/browser/steps.js')
  const send = el({ name: 'Send' })
  const email = el({ role: 'textbox', tag: 'input', type: 'email', name: 'Email', editable: true })
  const bare = el({ role: 'textbox', tag: 'input', name: '', editable: true })
  assert.equal(stepText('browser_act', { action: 'click', uid: 1 }, send), 'Clicking "Send"')
  assert.equal(stepText('browser_act', { action: 'type', uid: 1 }, email), 'Typing in "Email"')
  assert.equal(stepText('browser_act', { action: 'type', uid: 1 }, bare), 'Typing in a field')
  assert.equal(stepText('browser_act', { action: 'click', uid: 1 }, null), 'Clicking an element')
  assert.equal(stepText('browser_open', { url: 'app.pendo.io/s/1' }, null, 'https://app.pendo.io/s/1'), 'Opening app.pendo.io')
  assert.equal(stepText('browser_wait', { text: 'Saved' }, null), 'Waiting for "Saved"')
  assert.equal(stepText('browser_screenshot', {}, null), 'Taking a screenshot')
  assert.equal(stepText('browser_snapshot', { find: 'Export CSV' }, null), 'Looking for "Export CSV"')
  assert.equal(stepText('browser_fill', { fields: [{ uid: 1 }, { uid: 2 }] }, null), 'Filling 2 fields')
  assert.equal(stepText('browser_extract', { as: 'table' }, null), 'Reading a table')
})

test('steps: a call puts its step on the tab while it runs, and the pane hears it; a new profile is unused until a page opens in it', async () => {
  const told: ServerMessage[] = []
  const tabs = new MemTabs()
  const facts = describing({ name: 'Send' })
  await withHost(
    (f) => {
      if (f.verb === 'state') return STATE
      if (f.verb === 'open') return { url: f.url, title: 'T', status: 200 }
      if (f.method === 'DOM.getContentQuads') return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }
      return facts(f) ?? {}
    },
    async (hub, host) => {
      hub.setResolver(() => ({ store: tabs, defaultProfile: async () => 'default', leadSessionId: null, broadcast: (m) => told.push(m) }))
      host.send(JSON.stringify({ type: 'tab', sessionId: 'st1', profile: 'default', url: 'http://localhost:3000/', title: 'App', viewport: null, colorScheme: null }))
      await sleep(30)
      const call = toolsOf(makeBrowserMcp({ hub, shots: new ShotStore(mkdtempSync(path.join(os.tmpdir(), 'triage-shots-'))), sessionId: 'st1', projectRoot: '/tmp/p', mode: 'chat' }))
      await call('browser_act', { action: 'click', uid: 7 })
      await sleep(30)
      const steps = told.flatMap((m) => (m.type === 'browser_tab' ? [m.tab.agentStep] : []))
      assert.ok(steps.includes('Clicking "Send"'), JSON.stringify(steps))
      assert.equal(steps.at(-1), null)
      assert.equal(hub.page('st1').agentStep, null)

      const fresh = await browserProfiles().create({ name: 'Staging' })
      assert.equal(browserProfiles().get(fresh.id)?.lastUsedAt, null)
      await hub.setProfile('st2', fresh.id)
      assert.equal(browserProfiles().get(fresh.id)?.lastUsedAt, null) // picked, not used
      await hub.open('st2', 'https://staging.example.com/')
      assert.equal(typeof browserProfiles().get(fresh.id)?.lastUsedAt, 'number')
    },
  )
})
