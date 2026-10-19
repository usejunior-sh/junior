/**
 * The transcript's side of session artifacts (web/src/transcript.ts): a
 * successful write_artifact / update_artifact is one card, not a tool pill;
 * a failed call stays a tool card; calls on one id in one turn collapse into
 * one card showing the latest; and an old log's plain `ok: …` text still
 * makes a card. Pure fold, no components.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, type ArtifactItem, type TranscriptItem } from '../web/src/transcript.js'
import type { ArtifactToolResult, SdkMessage, SessionEvent } from '../shared/protocol.js'

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
const you = (text: string): SessionEvent => ({ kind: 'local_user', text })
const say = (text: string, parent: string | null = null) =>
  sdk({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const turnEnd = () => sdk({ type: 'result', subtype: 'success', total_cost_usd: 0.1, duration_ms: 1000, num_turns: 1 })

const WRITE = 'mcp__triage__write_artifact'
const UPDATE = 'mcp__triage__update_artifact'

const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
  sdk({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const answer = (id: string, content: string, isError = false, parent: string | null = null) =>
  sdk({
    type: 'user',
    parent_tool_use_id: parent,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  })

const pub = (over: Partial<ArtifactToolResult> = {}): ArtifactToolResult => ({
  triage: 'artifact',
  action: 'created',
  id: 'art-1',
  title: 'Q3 report',
  format: 'html',
  version: 1,
  size: 2048,
  history: true,
  path: 'files/q3-report-art1.html',
  abs: '/tmp/ws/artifacts/files/q3-report-art1.html',
  ...over,
})
const result = (id: string, p: ArtifactToolResult) => answer(id, JSON.stringify(p))

const cards = (items: TranscriptItem[]) => items.filter((i): i is ArtifactItem => i.kind === 'artifact')

test('a successful write_artifact is one artifact card with its result', () => {
  const items = buildTranscript([you('report'), call('w1', WRITE, { title: 'Q3 report', format: 'html', body: '<h1>hi</h1>' }), result('w1', pub()), turnEnd()])
  const [card] = cards(items)
  assert.equal(cards(items).length, 1)
  assert.equal(card.key, 'c1.0')
  assert.equal(card.created, true)
  assert.equal(card.calls, 1)
  assert.equal(card.pub?.id, 'art-1')
  assert.equal(card.pub?.version, 1)
  assert.equal(card.body, '<h1>hi</h1>')
  assert.equal(items.some((i) => i.kind === 'tool' || i.kind === 'toolGroup'), false)
})

test('an update is not "created"', () => {
  const items = buildTranscript([you('go'), call('u1', UPDATE, { id: 'art-1', body: 'x' }), result('u1', pub({ action: 'updated', version: 2 }))])
  const [card] = cards(items)
  assert.equal(card.created, false)
  assert.equal(card.pub?.version, 2)
})

test('a call still out is a card with no result yet', () => {
  const items = buildTranscript([you('go'), call('w1', WRITE, { title: 'Q3 report', body: 'x' })])
  const [card] = cards(items)
  assert.equal(card.pub, undefined)
  assert.equal(card.created, true)
  assert.equal(card.call.result, undefined)
})

test('a failed call keeps the plain tool card, inside a group', () => {
  const items = buildTranscript([you('go'), call('w1', WRITE, { title: 'x', format: 'pdf', body: 'x' }), answer('w1', 'pdf files need from: <absolute path>', true)])
  assert.equal(cards(items).length, 0)
  const group = items.find((i) => i.kind === 'toolGroup')
  assert.ok(group && group.kind === 'toolGroup')
  assert.equal(group.members.some((m) => m.kind === 'tool' && m.name === WRITE && m.result?.isError), true)
})

test('a result nothing can read stays a tool card', () => {
  const items = buildTranscript([you('go'), call('w1', WRITE, { title: 'x', body: 'x' }), answer('w1', 'something else entirely')])
  assert.equal(cards(items).length, 0)
  assert.equal(items.some((i) => i.kind === 'toolGroup'), true)
})

test('two calls on one id in one turn collapse into one card showing the latest', () => {
  const items = buildTranscript([
    you('go'),
    call('w1', WRITE, { title: 'Q3 report', format: 'html', body: 'first' }),
    result('w1', pub()),
    call('u1', UPDATE, { id: 'art-1', body: 'second', note: 'fixed totals' }),
    result('u1', pub({ action: 'updated', version: 2 })),
    turnEnd(),
  ])
  const found = cards(items)
  assert.equal(found.length, 1)
  assert.equal(found[0].key, 'c1.0')
  assert.equal(found[0].calls, 2)
  assert.equal(found[0].created, true)
  assert.equal(found[0].pub?.version, 2)
  assert.equal(found[0].call.name, UPDATE)
  assert.equal(found[0].body, 'second')
})

test('a later call that sent a file clears the stale body', () => {
  const items = buildTranscript([
    you('go'),
    call('w1', WRITE, { title: 'T', body: 'first' }),
    result('w1', pub({ format: 'md' })),
    call('u1', UPDATE, { id: 'art-1', from: '/tmp/x.md' }),
    result('u1', pub({ format: 'md', action: 'updated', version: 2 })),
  ])
  assert.equal(cards(items)[0].body, undefined)
})

test('prose between two calls on one id keeps two cards', () => {
  const items = buildTranscript([
    you('go'),
    call('w1', WRITE, { title: 'Q3 report', body: 'first' }),
    result('w1', pub()),
    say('Let me fix the totals.'),
    call('u1', UPDATE, { id: 'art-1', body: 'second' }),
    result('u1', pub({ action: 'updated', version: 2 })),
  ])
  const found = cards(items)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((c) => c.pub?.version), [1, 2])
  assert.deepEqual(found.map((c) => c.created), [true, false])
})

test('a turn ending between two calls keeps two cards', () => {
  const items = buildTranscript([
    you('go'),
    call('w1', WRITE, { title: 'T', body: 'a' }),
    result('w1', pub()),
    turnEnd(),
    you('again'),
    call('u1', UPDATE, { id: 'art-1', body: 'b' }),
    result('u1', pub({ action: 'updated', version: 2 })),
  ])
  assert.equal(cards(items).length, 2)
})

test('different ids stay separate cards', () => {
  const items = buildTranscript([
    you('go'),
    call('w1', WRITE, { title: 'A', body: 'a' }),
    result('w1', pub({ id: 'art-1' })),
    call('w2', WRITE, { title: 'B', body: 'b' }),
    result('w2', pub({ id: 'art-2', title: 'B' })),
  ])
  assert.deepEqual(cards(items).map((c) => c.pub?.id), ['art-1', 'art-2'])
})

test('an old log\'s "ok: created" text still makes a card, with no version', () => {
  const items = buildTranscript([
    you('go'),
    call('w1', WRITE, { title: 'Old note', body: '# hi' }),
    answer('w1', 'ok: created 6c1e-aaaa at notes/old-note-6c1e.md'),
    call('u1', UPDATE, { id: '6c1e-aaaa', body: '# hello' }),
    answer('u1', 'ok: updated notes/old-note-6c1e.md'),
  ])
  const [card] = cards(items)
  assert.equal(cards(items).length, 1)
  assert.equal(card.pub?.version, 0)
  assert.equal(card.pub?.format, 'md')
  assert.equal(card.pub?.id, '6c1e-aaaa')
  assert.equal(card.pub?.title, 'Old note')
  assert.equal(card.pub?.path, 'notes/old-note-6c1e.md')
  assert.equal(card.calls, 2)
})

test('an old update with no title reads its title off the path', () => {
  const items = buildTranscript([you('go'), call('u1', UPDATE, { id: 'x1', body: 'b' }), answer('u1', 'ok: updated notes/plain-6c1e.md')])
  assert.equal(cards(items)[0].pub?.title, 'plain-6c1e.md')
  assert.equal(cards(items)[0].created, false)
})

test('the body preview is cut at 4000 characters', () => {
  const items = buildTranscript([you('go'), call('w1', WRITE, { title: 'Big', body: 'x'.repeat(9000) }), result('w1', pub())])
  assert.equal(cards(items)[0].body?.length, 4000)
})

test('a call with a file and no body has no body to preview', () => {
  const items = buildTranscript([you('go'), call('w1', WRITE, { title: 'Chart', format: 'png', from: '/tmp/c.png' }), result('w1', pub({ format: 'png' }))])
  assert.equal(cards(items)[0].body, undefined)
})

test('a subagent\'s calls fold the same way in its own view, and stay out of main', () => {
  const events = [
    you('go'),
    call('a1', 'Agent', { description: 'make it', prompt: 'p', subagent_type: 'general-purpose' }),
    call('w1', WRITE, { title: 'Q3', body: 'a' }, 'a1'),
    result('w1', pub()),
    call('u1', UPDATE, { id: 'art-1', body: 'b' }, 'a1'),
    result('u1', pub({ action: 'updated', version: 2 })),
  ].map((e) => {
    // the result messages belong to the same subagent
    if (e.kind === 'sdk' && e.message.type === 'user') return sdk({ ...e.message, parent_tool_use_id: 'a1' } as SdkMessage)
    return e
  })
  assert.equal(cards(buildTranscript(events)).length, 0)
  const own = cards(buildTranscript(events, undefined, { scope: 'a1' }))
  assert.equal(own.length, 1)
  assert.equal(own[0].calls, 2)
  assert.equal(own[0].pub?.version, 2)
})

test('a tool run around a card is split into a group before and one after', () => {
  const tool = (id: string, name: string) => [call(id, name, { file_path: '/x' }), answer(id, 'ok')]
  const items = buildTranscript([
    you('go'),
    ...tool('r1', 'Read'),
    ...tool('r2', 'Grep'),
    call('w1', WRITE, { title: 'T', body: 'a' }),
    result('w1', pub()),
    ...tool('r3', 'Read'),
    ...tool('r4', 'Grep'),
  ])
  assert.deepEqual(
    items.filter((i) => i.kind !== 'user').map((i) => i.kind),
    ['toolGroup', 'artifact', 'toolGroup'],
  )
})
