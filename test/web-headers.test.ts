/**
 * Who may frame the app, and how big a JSON body may get.
 *
 * The SPA (server/web.ts) may only be framed by its own origin, so another
 * site can't hide the UI in a frame and steer a click onto Approve. The
 * artifact and PDF frames the UI draws itself come from /api/artifacts/raw,
 * which keeps its own headers (server/artifact-serve.ts) and never gets the
 * SPA ones. readJsonBody gives up and destroys the request at its limit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { SPA_FRAME_HEADERS, serveWeb, spaHeaders } from '../server/web.js'
import { rawHeaders } from '../server/artifact-serve.js'
import { artifactFileRoutes } from '../server/routes/artifact-files.js'
import { readJsonBody } from '../server/routes/http-util.js'
import type { ScopedCtx } from '../server/routes/ctx.js'

type Captured = { status?: number; headers: Record<string, string>; body?: unknown }

function fakeRes(): { res: http.ServerResponse; out: Captured } {
  const out: Captured = { headers: {} }
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status
      out.headers = { ...headers }
      return res
    },
    end(body?: unknown) {
      out.body = body
      return res
    },
  }
  return { res: res as unknown as http.ServerResponse, out }
}

test('spaHeaders: same-origin framing only, never DENY, keeps the content type', () => {
  const h = spaHeaders('text/html; charset=utf-8')
  assert.equal(h['content-type'], 'text/html; charset=utf-8')
  assert.equal(h['Content-Security-Policy'], "frame-ancestors 'self'")
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN')
  assert.deepEqual(SPA_FRAME_HEADERS, { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' })
  assert.throws(() => {
    ;(SPA_FRAME_HEADERS as Record<string, string>)['X-Frame-Options'] = 'DENY'
  })
})

test('serveWeb sends the frame headers on the HTML shell and on assets', async () => {
  // with or without a build: the shell, the SPA fallback and the no-build page all go through spaHeaders
  for (const p of ['/', '/inbox/some/route', '/assets/missing.js', '/../../etc/passwd']) {
    const { res, out } = fakeRes()
    await serveWeb(p, res)
    assert.equal(out.status, 200, p)
    assert.equal(out.headers['Content-Security-Policy'], "frame-ancestors 'self'", p)
    assert.equal(out.headers['X-Frame-Options'], 'SAMEORIGIN', p)
    assert.ok(out.headers['content-type'], p)
  }
})

test('nothing in server/ sends X-Frame-Options: DENY', () => {
  const root = path.join(import.meta.dirname, '..', 'server')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  for (const f of walk(root)) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /X-Frame-Options['"]?\s*[:,]\s*['"]?DENY/i, f)
  }
})

/** The raw artifact route with a stub store: what the UI's own frames actually load. */
async function rawRoute(format: 'pdf' | 'html', query = ''): Promise<Captured> {
  const bytes = Buffer.from(format === 'pdf' ? '%PDF-1.4' : '<p>hi</p>')
  const rt = {
    artifacts: {
      readBytes: async () => ({ artifact: { title: 'Report' }, bytes, version: 1, latest: true, abs: '/x', format }),
    },
  }
  const { res, out } = fakeRes()
  const ctx = {
    req: { method: 'GET', headers: {} },
    res,
    url: new URL(`http://localhost/api/artifacts/raw?id=a1${query}`),
    json: (status: number, body: unknown) => {
      out.status = status
      out.body = body
    },
    access: 'local',
    rt,
  } as unknown as ScopedCtx
  assert.equal(await artifactFileRoutes(ctx), true)
  return out
}

test('artifact and PDF frames keep artifact-serve headers and never get the SPA ones', async () => {
  const pdf = await rawRoute('pdf')
  assert.equal(pdf.status, 200)
  assert.deepEqual(pdf.headers, rawHeaders('pdf', { filename: 'report.pdf', scripts: false, download: false, versioned: false, size: 8 }))
  assert.equal(pdf.headers['X-Frame-Options'], undefined)
  assert.equal(pdf.headers['Content-Security-Policy'], undefined)

  for (const q of ['', '&scripts=1']) {
    const html = await rawRoute('html', q)
    assert.equal(html.status, 200)
    assert.deepEqual(html.headers, rawHeaders('html', { filename: 'report.html', scripts: q !== '', download: false, versioned: false, size: 9 }))
    assert.equal(html.headers['X-Frame-Options'], undefined)
    // still frameable by the UI itself, and still sandboxed
    assert.match(html.headers['Content-Security-Policy'], /^sandbox/)
    assert.match(html.headers['Content-Security-Policy'], /frame-ancestors 'self'/)
  }
})

test('readJsonBody parses a body, even with a character split across chunks', async () => {
  const json = Buffer.from(JSON.stringify({ name: 'café ☕' }))
  const cut = json.indexOf(0xe2) + 1 // inside the 3-byte ☕
  const req = Readable.from([json.subarray(0, cut), json.subarray(cut)]) as unknown as http.IncomingMessage
  assert.deepEqual(await readJsonBody(req), { name: 'café ☕' })
  assert.equal(await readJsonBody(Readable.from([]) as unknown as http.IncomingMessage), null)
})

test('readJsonBody counts bytes: exactly the limit is fine', async () => {
  const body = Buffer.from(JSON.stringify('x'.repeat(98))) // 100 bytes
  assert.equal(body.length, 100)
  assert.equal(await readJsonBody(Readable.from([body]) as unknown as http.IncomingMessage, 100), 'x'.repeat(98))
})

test('readJsonBody rejects and destroys the request once past the limit', async () => {
  let pushed = 0
  // a body that never ends: without destroy it would buffer forever
  const req = new Readable({
    read() {
      pushed++
      this.push(Buffer.alloc(64, 0x20))
    },
  })
  await assert.rejects(readJsonBody(req as unknown as http.IncomingMessage, 1_000), /body too large/)
  assert.equal(req.destroyed, true)
  const at = pushed
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(pushed - at <= 1, 'stopped reading after the limit')
  assert.ok(at * 64 < 2_000, `read ${at * 64} bytes for a 1000-byte limit`)
})

test('readJsonBody rejects on a stream error and on bad JSON', async () => {
  const broken = new Readable({
    read() {
      this.destroy(new Error('socket hang up'))
    },
  })
  await assert.rejects(readJsonBody(broken as unknown as http.IncomingMessage), /socket hang up/)
  await assert.rejects(readJsonBody(Readable.from([Buffer.from('{nope')]) as unknown as http.IncomingMessage), SyntaxError)
})
