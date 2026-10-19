/**
 * The external MCP contract for artifacts (core/mcp/tools.ts, used by the stdio
 * shim and POST /mcp): the schemas say what a session can publish, and the
 * text the tools answer with carries the format and the version.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callTool, type McpApi, TOOLS } from '../core/mcp/tools.js'

type Schema = { properties: Record<string, { enum?: string[]; type?: string; items?: { properties?: Record<string, { enum?: string[] }> } }>; required?: string[] }
const tool = (name: string) => TOOLS.find((t) => t.name === name) as unknown as { description: string; inputSchema: Schema }
const conn = { serverUrl: 'http://localhost:1/mcp', requestedWorkspace: null }

test('write_artifact: format, from and note are there, body is no longer required', () => {
  const t = tool('write_artifact')
  assert.deepEqual(t.inputSchema.properties.format.enum, ['md', 'html', 'csv', 'txt', 'json', 'svg', 'pdf', 'png', 'jpg', 'gif', 'webp'])
  assert.equal(t.inputSchema.properties.from.type, 'string')
  assert.equal(t.inputSchema.properties.note.type, 'string')
  assert.equal(t.inputSchema.properties.body.type, 'string')
  assert.deepEqual(t.inputSchema.required, ['title'])
  assert.deepEqual(t.inputSchema.properties.links.items?.properties?.role.enum, ['brief', 'context', 'dispatch', 'output'])
  assert.match(t.description, /update_artifact/)
  assert.match(t.description, /Never write report-v2\.html/)
})

test('update_artifact: from and note, and the by-id rule is said', () => {
  const t = tool('update_artifact')
  assert.equal(t.inputSchema.properties.from.type, 'string')
  assert.equal(t.inputSchema.properties.note.type, 'string')
  assert.deepEqual(t.inputSchema.required, ['id'])
  assert.match(t.description, /report-v2\.html/)
})

test('read_artifact takes a version; link_artifact takes the output role; list_artifacts says files', () => {
  assert.equal(tool('read_artifact').inputSchema.properties.version.type, 'number')
  assert.deepEqual(tool('link_artifact').inputSchema.properties.role.enum, ['brief', 'context', 'dispatch', 'output'])
  assert.doesNotMatch(tool('list_artifacts').description, /markdown notes/)
  assert.match(tool('list_artifacts').description, /format, version/)
})

test('callTool write_artifact: sends the call as the model, answers with the format and version', async () => {
  const calls: { path: string; body: unknown; method?: string }[] = []
  const api: McpApi = async (path, body, method) => {
    calls.push({ path, body, method })
    return { ok: true, artifact: { id: 'abc', path: 'files/q3-abc.html', format: 'html' }, action: 'created', version: 1 }
  }
  const r = await callTool(api, conn, 'write_artifact', { title: 'Q3', body: '<p>x</p>', format: 'html', note: 'first' })
  assert.equal(r.isError, false)
  assert.equal(r.text, 'ok: created abc (html, v1) at files/q3-abc.html')
  assert.equal(calls[0].path, '/api/artifacts')
  assert.deepEqual(calls[0].body, { title: 'Q3', body: '<p>x</p>', format: 'html', note: 'first', author: 'model' })
  const bad = await callTool(async () => ({ ok: false, error: 'pdf files need from: <absolute path>' }), conn, 'write_artifact', { title: 'x' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /pdf files need from/)
})

test('callTool update_artifact: updated with a version, or unchanged', async () => {
  let seen = ''
  const api = (action: string, version: number): McpApi => async (path, body, method) => {
    seen = `${method} ${path} ${JSON.stringify(body)}`
    return { ok: true, artifact: { path: 'files/q3-abc.html' }, action, version }
  }
  const up = await callTool(api('updated', 2), conn, 'update_artifact', { id: 'abc', body: 'new', note: 'fixed' })
  assert.equal(up.text, 'ok: updated abc (v2) files/q3-abc.html')
  assert.equal(seen, 'PUT /api/artifacts?id=abc&by=model {"body":"new","note":"fixed"}')
  const same = await callTool(api('unchanged', 2), conn, 'update_artifact', { id: 'abc', body: 'new' })
  assert.match(same.text, /^ok: unchanged abc \(v2\)/)
  assert.match(same.text, /identical content/)
  assert.equal((await callTool(api('updated', 1), conn, 'update_artifact', {})).isError, true)
})

test('callTool read_artifact: asks for a version, says binary files have no text', async () => {
  let asked = ''
  const api: McpApi = async (path) => {
    asked = path
    return {
      ok: true,
      artifact: { title: 'Doc', id: 'abc', author: 'model', refs: [], format: 'pdf', version: 3 },
      body: '',
      abs: '/tmp/doc.pdf',
      version: 2,
      latest: false,
      binary: true,
      truncated: false,
    }
  }
  const r = await callTool(api, conn, 'read_artifact', { id: 'abc', version: 2 })
  assert.equal(asked, '/api/artifacts/content?id=abc&v=2')
  assert.match(r.text, /format: pdf/)
  assert.match(r.text, /version: 2 \(current is v3\)/)
  assert.match(r.text, /binary file, no text here/)
  await callTool(api, conn, 'read_artifact', { id: 'abc' })
  assert.equal(asked, '/api/artifacts/content?id=abc')
})
