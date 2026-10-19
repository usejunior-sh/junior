/**
 * The headers a raw artifact is served with (server/artifact-serve.ts): the
 * boundary that keeps a generated page away from /api. Pure, a table over
 * every format.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARTIFACT_FORMATS, formatMime } from '../shared/protocol.js'
import { ARTIFACT_RAW_PATH, rawCsp, rawHeaders } from '../server/artifact-serve.js'

const opts = { filename: 'report.html', versioned: false, size: 12 }

test('every format: nosniff, its own type, inline, no referrer, same-origin only', () => {
  for (const f of ARTIFACT_FORMATS) {
    const h = rawHeaders(f, opts)
    assert.equal(h['X-Content-Type-Options'], 'nosniff', f)
    assert.equal(h['Content-Type'], formatMime(f), f)
    assert.match(h['Content-Disposition'], /^inline; filename="report\.html"/, f)
    assert.equal(h['Content-Length'], '12', f)
    assert.equal(h['Referrer-Policy'], 'no-referrer', f)
    assert.equal(h['Cross-Origin-Resource-Policy'], 'same-origin', f)
  }
})

test('no format ever gets allow-same-origin, and every CSP but pdf sandboxes the document', () => {
  for (const f of ARTIFACT_FORMATS) {
    for (const scripts of [false, true]) {
      const csp = rawCsp(f, scripts)
      if (f === 'pdf') {
        assert.equal(csp, null)
        continue
      }
      assert.ok(csp, f)
      assert.match(csp, /(^|; )sandbox(;|$| )/, `${f} is sandboxed`)
      assert.doesNotMatch(csp, /allow-same-origin/, f)
    }
  }
})

test('html: scripts are off by default', () => {
  const csp = rawCsp('html')!
  assert.ok(csp.startsWith('sandbox;'))
  assert.doesNotMatch(csp, /allow-scripts/)
  assert.doesNotMatch(csp, /script-src/)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /frame-ancestors 'self'/)
  assert.match(csp, /form-action 'none'/)
})

test('html with scripts on: sandboxed, allow-scripts only, and no network', () => {
  const csp = rawCsp('html', true)!
  assert.ok(csp.startsWith('sandbox allow-scripts;'))
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /default-src 'none'/)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.doesNotMatch(csp, /allow-(forms|popups|top-navigation|modals)/)
  assert.doesNotMatch(csp, /connect-src (?!'none')/)
  assert.equal(rawHeaders('html', { ...opts, scripts: true })['Content-Security-Policy'], csp)
})

test('scripts=1 on a format other than html changes nothing', () => {
  for (const f of ARTIFACT_FORMATS) {
    if (f === 'html') continue
    assert.equal(rawCsp(f, true), rawCsp(f, false), f)
  }
})

test('svg is sandboxed with no scripts, however it is asked for', () => {
  for (const scripts of [false, true]) {
    const csp = rawCsp('svg', scripts)!
    assert.ok(csp.startsWith('sandbox;'))
    assert.doesNotMatch(csp, /allow-scripts/)
    assert.doesNotMatch(csp, /script-src/)
  }
})

test('pdf has no CSP (the PDF viewer will not load in a sandboxed document)', () => {
  assert.equal('Content-Security-Policy' in rawHeaders('pdf', opts), false)
})

test('images are sandboxed with nothing allowed', () => {
  for (const f of ['png', 'jpg', 'gif', 'webp'] as const) assert.equal(rawCsp(f), "default-src 'none'; sandbox")
})

test('download is an attachment; a name cannot break out of the header', () => {
  const h = rawHeaders('html', { ...opts, download: true, filename: 'a"b\\c\r\nX-Evil: 1é.html' })
  assert.match(h['Content-Disposition'], /^attachment; filename="[^"\\\r\n]*"; filename\*=UTF-8''/)
  assert.doesNotMatch(h['Content-Disposition'], /[\r\n]/)
  assert.match(h['Content-Disposition'], /filename\*=UTF-8''a%22b%5Cc%0D%0AX-Evil%3A%201%C3%A9\.html$/)
})

test('an old version is immutable, the current file is revalidated', () => {
  assert.equal(rawHeaders('csv', { ...opts, versioned: true })['Cache-Control'], 'private, max-age=31536000, immutable')
  assert.equal(rawHeaders('csv', opts)['Cache-Control'], 'private, no-cache')
})

test('the raw route sits under /api/, so the paired-device gate covers it', () => {
  assert.equal(ARTIFACT_RAW_PATH, '/api/artifacts/raw')
})
