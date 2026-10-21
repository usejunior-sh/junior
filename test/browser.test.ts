/**
 * The browser pane (.docs/browser.md): the page as text, what runs without
 * asking, page logs, the before/after image diff, the Verification note, and
 * the host link the daemon drives Triage.app through.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import { formatSnapshot, uidsIn, type AXNode } from '../core/browser/snapshot.js'
import { browserCallAllowed, isLocalUrl, resolveUrl } from '../core/browser/policy.js'
import { dedupe, formatLogs, PageLogBuffer } from '../core/browser/logs.js'
import { decodePng, diffImages, encodePng, type Rgba } from '../core/browser/image.js'
import { BROWSER_WIRE_VERSION, parseHostFrame } from '../core/browser/wire.js'
import { BrowserHub, NO_HOST, renderVerification, ShotStore, viewportLabel, VIEWPORTS } from '../server/browser.js'

const v = (value: unknown) => ({ type: 'string', value })

const TREE: AXNode[] = [
  { nodeId: '1', role: v('RootWebArea'), name: v('Settings'), childIds: ['2', '6'], backendDOMNodeId: 1 },
  { nodeId: '2', parentId: '1', role: v('generic'), childIds: ['3', '4', '5'], backendDOMNodeId: 2 },
  { nodeId: '3', parentId: '2', role: v('heading'), name: v('Profile'), properties: [{ name: 'level', value: { type: 'integer', value: 1 } }], childIds: ['31'], backendDOMNodeId: 3 },
  { nodeId: '31', parentId: '3', role: v('StaticText'), name: v('Profile'), backendDOMNodeId: 31 },
  { nodeId: '4', parentId: '2', role: v('textbox'), name: v('Name'), value: v('Samar'), properties: [{ name: 'focused', value: { type: 'boolean', value: true } }], backendDOMNodeId: 4 },
  { nodeId: '5', parentId: '2', role: v('button'), name: v('Save'), properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }], backendDOMNodeId: 5 },
  { nodeId: '6', parentId: '1', ignored: true, childIds: ['7'], backendDOMNodeId: 6 },
  { nodeId: '7', parentId: '6', role: v('link'), name: v('Help'), properties: [{ name: 'url', value: { type: 'string', value: 'http://localhost:5173/help' } }], backendDOMNodeId: 7 },
]

test('snapshot: elements get their backend id as uid, structure is lifted, repeated text dropped', () => {
  const s = formatSnapshot(TREE)
  assert.equal(
    s.text,
    [
      'uid=1 page "Settings"',
      '  uid=3 heading "Profile" [h1]',
      '  uid=4 textbox "Name" value="Samar" [focused]',
      '  uid=5 button "Save" [disabled]',
      '  uid=7 link "Help" [→ http://localhost:5173/help]',
    ].join('\n'),
  )
  assert.deepEqual(uidsIn(s.text), [1, 3, 4, 5, 7])
})

test('snapshot: scoped to a uid, capped with a note, and a gone uid says so', () => {
  assert.equal(formatSnapshot(TREE, { rootUid: 5 }).text, 'uid=5 button "Save" [disabled]')
  const capped = formatSnapshot(TREE, { maxNodes: 2 })
  assert.equal(capped.truncated, 3)
  assert.match(capped.text, /… 3 more nodes/)
  assert.match(formatSnapshot(TREE, { rootUid: 999 }).text, /not on the page/)
})

test('policy: local means this machine, and a file inside the project', () => {
  for (const u of ['http://localhost:5173/', 'http://127.0.0.1:3000/x', 'http://app.localhost/', 'http://[::1]:8080/', 'about:blank']) assert.ok(isLocalUrl(u), u)
  for (const u of ['https://example.com/', 'http://192.168.1.4/', 'http://localhost.evil.com/', 'javascript:alert(1)']) assert.ok(!isLocalUrl(u), u)
  assert.ok(isLocalUrl('file:///repo/app/index.html', '/repo/app'))
  assert.ok(!isLocalUrl('file:///etc/passwd', '/repo/app'))
  assert.ok(!isLocalUrl('file:///repo/app/index.html'))
})

test('policy: urls are completed, script urls refused', () => {
  assert.equal(resolveUrl('localhost:5173/settings'), 'http://localhost:5173/settings')
  assert.equal(resolveUrl('/settings', 'http://localhost:5173/home'), 'http://localhost:5173/settings')
  assert.equal(resolveUrl('example.com'), 'https://example.com')
  assert.equal(resolveUrl('javascript:alert(1)'), null)
  assert.equal(resolveUrl('data:text/html,hi'), null)
})

test('policy: reading and using the page never asks; leaving the machine and eval do', () => {
  assert.ok(browserCallAllowed('mcp__browser__browser_snapshot', {}))
  assert.ok(browserCallAllowed('mcp__browser__browser_act', { action: 'click', uid: 3 }))
  assert.ok(browserCallAllowed('mcp__browser__browser_open', { url: 'localhost:5173' }))
  assert.ok(!browserCallAllowed('mcp__browser__browser_open', { url: 'https://example.com' }))
  assert.ok(!browserCallAllowed('mcp__browser__browser_eval', { expression: '1' }))
  assert.ok(!browserCallAllowed('mcp__triage__list_work_items', {}))
})

test('logs: read since the last action, deduped, levels filtered', () => {
  const b = new PageLogBuffer()
  b.markLoad()
  b.push({ level: 'error', source: 'console', text: 'boom', at: 1 })
  b.push({ level: 'info', source: 'console', text: 'hello', at: 2 })
  b.markAction()
  b.push({ level: 'warning', source: 'console', text: 'careful', at: 3 })
  b.push({ level: 'warning', source: 'console', text: 'careful', at: 4 })
  assert.deepEqual(b.since('action').map((l) => [l.text, l.count]), [['careful', 2]])
  assert.deepEqual(b.since('load', 'error').map((l) => l.text), ['boom'])
  assert.equal(b.since('all', 'all').length, 3)
  assert.equal(b.errorsSinceLoad(), 1)
  assert.match(formatLogs(dedupe([{ level: 'error', source: 'network', text: 'HTTP 404 — GET', url: '/api/x', at: 0 }])), /\[error\] network: HTTP 404 — GET — \/api\/x/)
  assert.match(formatLogs([]), /No console errors/)
})

const solid = (w: number, h: number, rgb: [number, number, number]): Rgba => {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4)
  return { width: w, height: h, data }
}

test('png: what we encode we decode', () => {
  const img = solid(37, 21, [10, 200, 30])
  img.data.set([255, 0, 0, 255], (5 * 37 + 7) * 4)
  const back = decodePng(encodePng(img))
  assert.equal(back.width, 37)
  assert.equal(back.height, 21)
  assert.deepEqual([...back.data], [...img.data])
})

test('diff: no change is zero; a changed block is found and boxed', () => {
  const a = solid(100, 80, [255, 255, 255])
  assert.equal(diffImages(a, a).changedPct, 0)
  const b = solid(100, 80, [255, 255, 255])
  for (let y = 20; y < 40; y++) for (let x = 50; x < 70; x++) b.data.set([200, 0, 0, 255], (y * 100 + x) * 4)
  const d = diffImages(a, b)
  assert.equal(d.changedPct, 5)
  assert.equal(d.boxes.length, 1)
  const box = d.boxes[0]!
  assert.ok(box.x <= 50 && box.y <= 20 && box.x + box.width >= 70 && box.y + box.height >= 40, JSON.stringify(box))
  assert.equal(d.sizeChanged, false)
  assert.equal(diffImages(a, solid(100, 90, [255, 255, 255])).sizeChanged, true)
})

test('shots and the Verification note', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-shots-'))
  const shots = new ShotStore(root)
  const s1 = await shots.add('sess-1', Buffer.from('a'), 'image/webp', { kind: 'screenshot', url: 'http://localhost:5173/', title: 'Home', viewport: '1440×900 desktop' })
  const s2 = await shots.add('sess-1', Buffer.from('b'), 'image/png', { kind: 'compare', label: 'before', url: 'http://localhost:5173/', title: 'Home', viewport: '1440×900 desktop', note: '3% of pixels changed' })
  assert.deepEqual([s1.n, s2.n], [1, 2])
  assert.equal(shots.file('sess-1', 2)?.mime, 'image/png')
  assert.equal(shots.file('sess-1', 3), null)
  assert.throws(() => shots.dir('../x'))
  const turns = await shots.addTurn('sess-1', { startedAt: 0, endedAt: Date.UTC(2026, 9, 13, 12, 0), summary: 'Made the header sticky.', shots: [1, 2] })
  const md = renderVerification({ title: 'Verification', workspaceId: 'ws', sessionId: 'sess-1', turns, shots: shots.list('sess-1') })
  assert.match(md, /## 2026-10-13 12:00 UTC/)
  assert.match(md, /Made the header sticky\./)
  assert.match(md, /!\[Screenshot 1\]\(\/api\/browser\/shots\/sess-1\/1\?workspace=ws\)/)
  assert.match(md, /Compare · “before” · 1440×900 desktop · 3% of pixels changed/)
  await fs.rm(root, { recursive: true, force: true })
})

test('viewport labels', () => {
  assert.equal(viewportLabel(VIEWPORTS.mobile!), '390×844 mobile')
  assert.equal(viewportLabel(null), 'fits the pane')
  assert.equal(viewportLabel(null, { width: 812, height: 640 }), 'fits the pane, 812×640')
  assert.equal(viewportLabel({ width: 1000, height: 700, deviceScaleFactor: 1, mobile: false }), '1000×700')
})

test('wire: host frames are validated, not cast', () => {
  assert.deepEqual(parseHostFrame('{"type":"hello","version":1,"app":"x"}'), { type: 'hello', version: 1, app: 'x' })
  assert.equal(parseHostFrame('{"type":"result","id":"1","ok":true}'), null)
  assert.equal(parseHostFrame('{"type":"call"}'), null)
  assert.equal(parseHostFrame('nope'), null)
})

/** A stand-in for Triage.app: answers the daemon's verbs over a real socket. */
async function withHost(version: number, answer: (f: Record<string, unknown>) => unknown, run: (hub: BrowserHub, host: WebSocket) => Promise<void>) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.once('listening', r))
  const hub = new BrowserHub()
  wss.on('connection', (ws) => hub.attach(ws))
  const host = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`)
  await new Promise((r) => host.once('open', r))
  host.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as Record<string, unknown>
    try {
      host.send(JSON.stringify({ type: 'result', id: f.id, ok: true, result: answer(f) }))
    } catch (err) {
      host.send(JSON.stringify({ type: 'result', id: f.id, ok: false, error: (err as Error).message }))
    }
  })
  host.send(JSON.stringify({ type: 'hello', version, app: 'test host' }))
  for (let i = 0; i < 50 && !hub.status.connected; i++) await new Promise((r) => setTimeout(r, 10))
  try {
    await run(hub, host)
  } finally {
    host.close()
    wss.close()
  }
}

test('hub: no host → the agent is told to open Triage.app', async () => {
  const hub = new BrowserHub()
  await assert.rejects(hub.call('s1', { verb: 'state' }), (e: Error) => e.message === NO_HOST)
})

test('hub: calls reach the host scoped to their session, results and errors come back', async () => {
  const seen: Record<string, unknown>[] = []
  await withHost(
    BROWSER_WIRE_VERSION,
    (f) => {
      seen.push(f)
      if (f.verb === 'cdp' && f.method === 'Boom.fail') throw new Error('no such method')
      return { echo: f.verb }
    },
    async (hub, host) => {
      assert.deepEqual(await hub.call('sess-a', { verb: 'state' }), { echo: 'state' })
      await assert.rejects(hub.call('sess-a', { verb: 'cdp', method: 'Boom.fail' }), /no such method/)
      assert.equal(seen[0]!.sessionId, 'sess-a')
      // the host reports page logs and your navigation; the daemon keeps them per session
      host.send(JSON.stringify({ type: 'log', sessionId: 'sess-a', log: { level: 'error', source: 'console', text: 'x', at: 1 } }))
      host.send(JSON.stringify({ type: 'navigated', sessionId: 'sess-a', url: 'http://localhost/b', byUser: true }))
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(hub.page('sess-a').logs.since('all').length, 1)
      assert.equal(hub.page('sess-a').touched, true)
      assert.equal(hub.page('sess-b').touched, false)
    },
  )
})

test('hub: a host on another wire version is refused with what to update', async () => {
  await withHost(
    BROWSER_WIRE_VERSION + 1,
    () => null,
    async (hub) => {
      assert.equal(hub.status.compatible, false)
      await assert.rejects(hub.call('s', { verb: 'state' }), /update Triage\.app/)
    },
  )
})
