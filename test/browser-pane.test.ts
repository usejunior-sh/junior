/**
 * The browser pane's own words (web/src/browserUrl.ts, components/browser/steps.ts):
 * what a typed address means, how the field splits one at rest, what the stage
 * says when a page didn't load, and the driving strip's step.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressParts, completeUrl, pageErrorView, shortUrl, PAGE_CRASHED } from '../web/src/browserUrl.js'
import { lastBrowserStep, stepOf } from '../web/src/components/browser/steps.js'
import type { SdkMessage, SessionEvent } from '../shared/protocol.js'

test('completeUrl: local hosts get http, bare hosts https, schemes stay', () => {
  const table: [string, string][] = [
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost', 'http://localhost'],
    ['127.0.0.1:5173/x', 'http://127.0.0.1:5173/x'],
    ['[::1]:8080', 'http://[::1]:8080'],
    ['app.localhost:5178', 'http://app.localhost:5178'],
    ['/settings', 'http://localhost/settings'],
    ['app.pendo.io', 'https://app.pendo.io'],
    ['app.pendo.io:443/s/1', 'https://app.pendo.io:443/s/1'],
    ['localhostfoo.com', 'https://localhostfoo.com'],
    ['https://mail.google.com', 'https://mail.google.com'],
    ['file:///tmp/a.html', 'file:///tmp/a.html'],
    ['  http://x.dev  ', 'http://x.dev'],
  ]
  for (const [raw, want] of table) assert.equal(completeUrl(raw), want, raw)
})

test('addressParts: host, path, folded query and the mark', () => {
  assert.deepEqual(addressParts('https://app.pendo.io/s/123/dashboard?x=1'), { host: 'app.pendo.io', path: '/s/123/dashboard', query: true, mark: 'secure' })
  assert.deepEqual(addressParts('http://localhost:5173/'), { host: 'localhost:5173', path: '', query: false, mark: 'local' })
  assert.deepEqual(addressParts('http://example.com/a'), { host: 'example.com', path: '/a', query: false, mark: 'insecure' })
  assert.equal(addressParts('')?.host, undefined)
  assert.equal(addressParts('about:blank'), null)
  assert.equal(shortUrl('https://app.pendo.io/s/1?tab=2'), 'app.pendo.io/s/1…')
})

test('pageErrorView: our words for Chromium codes', () => {
  assert.equal(pageErrorView('ERR_CONNECTION_REFUSED', 'http://localhost:5173/').kind, 'refused-local')
  assert.equal(pageErrorView('ERR_CONNECTION_REFUSED', 'http://localhost:5173/').lead, 'Nothing is running on localhost:5173.')
  assert.equal(pageErrorView('ERR_102', 'http://127.0.0.1:3000/').kind, 'refused-local')
  assert.equal(pageErrorView('ERR_CONNECTION_REFUSED', 'https://app.example.com/').lead, "app.example.com didn't answer.")
  assert.equal(pageErrorView('ERR_NAME_NOT_RESOLVED', 'https://app.pendoo.io/').lead, "Can't find app.pendoo.io.")
  assert.equal(pageErrorView('ERR_INTERNET_DISCONNECTED', 'https://x.io/').kind, 'offline')
  assert.equal(pageErrorView('ERR_CERT_AUTHORITY_INVALID', 'https://x.io/').kind, 'cert')
  assert.equal(pageErrorView(PAGE_CRASHED, 'https://x.io/').lead, 'This page crashed.')
  assert.equal(pageErrorView('ERR_SOMETHING_NEW', 'https://x.io/').kind, 'other')
  // Every line the stage shows keeps to 15 words a sentence.
  for (const code of ['ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'ERR_CERT_DATE_INVALID', PAGE_CRASHED, 'ERR_X']) {
    const v = pageErrorView(code, 'https://app.example.com/')
    for (const s of `${v.lead} ${v.line ?? ''}`.split(/(?<=[.!?])\s+/)) assert.ok(s.split(/\s+/).length <= 15, s)
  }
})

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
const call = (name: string, input: Record<string, unknown>) =>
  sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: name, name, input }] } })

test('the driving strip names the last browser call', () => {
  assert.equal(stepOf('browser_open', { url: 'https://app.pendo.io/s/1' }), 'Opening app.pendo.io')
  assert.equal(stepOf('browser_open', { url: 'localhost:5173/x' }), 'Opening localhost:5173')
  assert.equal(stepOf('browser_act', { action: 'press', text: 'Enter' }), 'Pressing Enter')
  assert.equal(stepOf('browser_logs', {}), 'Checking the console')
  assert.equal(lastBrowserStep([]), null)
  const events = [call('mcp__browser__browser_open', { url: 'https://a.io' }), call('Bash', { command: 'ls' }), call('mcp__browser__browser_screenshot', {})]
  assert.equal(lastBrowserStep(events), 'Taking a screenshot')
  assert.equal(lastBrowserStep(events.slice(0, 2)), 'Opening a.io')
})
