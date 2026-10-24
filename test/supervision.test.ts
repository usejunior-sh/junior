/**
 * The supervision line (core/work/supervision.ts): the counts and words for
 * zero, files only, sends only and both; dedupe and the seen cutoff; reading
 * file touches out of a session's events; and the op that opens the item's
 * file list and resets the count (server/supervision-ops.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { SessionEvent } from '../shared/protocol.js'
import type { ScoredItem } from '../core/work/types.js'
import { type FileTouch, relativeTo, splitPath, SUPERVISION_LIST_MAX, supervisionLine, supervisionOf, touchesOf, unseenFiles } from '../core/work/supervision.js'
import { createManualOp } from '../server/items-ops.js'
import { changesSeenOp, withSupervision } from '../server/supervision-ops.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

const words = (s: string) => s.split(/\s+/).filter((w) => w !== '·').length
const t = (p: string, at: number, sessionId = 's1'): FileTouch => ({ path: p, sessionId, at })

// ---------------------------------------------------------------------------
// The pure line
// ---------------------------------------------------------------------------

test('zero: no line at all', () => {
  const s = supervisionOf({ touches: [], seenAt: null, heldSends: 0 })
  assert.deepEqual(s, { unreviewedFiles: 0, heldSends: 0, line: null, short: null })
})

test('files only', () => {
  const s = supervisionOf({ touches: [t('/r/a.ts', 1), t('/r/b.ts', 2), t('/r/c.ts', 3), t('/r/d.ts', 4)], seenAt: null, heldSends: 0 })
  assert.equal(s.unreviewedFiles, 4)
  assert.equal(s.line, '4 files changed, not reviewed by you')
  assert.equal(s.short, '4 files not reviewed')
})

test('sends only', () => {
  const s = supervisionOf({ touches: [], seenAt: null, heldSends: 2 })
  assert.equal(s.line, '2 sends wait for your OK')
  assert.equal(s.short, '2 sends wait')
})

test('both, joined with a middle dot, within 15 words', () => {
  const s = supervisionOf({ touches: [t('/r/a.ts', 1), t('/r/b.ts', 2), t('/r/c.ts', 3), t('/r/d.ts', 4)], seenAt: null, heldSends: 2 })
  assert.equal(s.line, '4 files changed, not reviewed by you · 2 sends wait for your OK')
  assert.equal(s.short, '4 files not reviewed · 2 sends wait')
  assert.ok(words(s.line!) <= 15)
  assert.ok(words(supervisionLine(128, 1000).line!) <= 15)
})

test('singular forms', () => {
  const s = supervisionLine(1, 1)
  assert.equal(s.line, '1 file changed, not reviewed by you · 1 send waits for your OK')
  assert.equal(s.short, '1 file not reviewed · 1 send waits')
})

test('one file edited five times is one file; only touches after seenAt count', () => {
  const touches = [t('/r/a.ts', 1), t('/r/a.ts', 5), t('/r/a.ts', 9), t('/r/b.ts', 4), t('/r/a.ts', 12, 's2'), t('/r/a.ts', 13)]
  assert.equal(supervisionOf({ touches, seenAt: null, heldSends: 0 }).unreviewedFiles, 2)
  assert.equal(supervisionOf({ touches, seenAt: 4, heldSends: 0 }).unreviewedFiles, 1)
  assert.equal(supervisionOf({ touches, seenAt: 13, heldSends: 0 }).line, null)
  // newest first, and the newest touch of a path wins
  assert.deepEqual(unseenFiles(touches, null), [t('/r/a.ts', 13), t('/r/b.ts', 4)])
})

test('negative or fractional counts never show', () => {
  assert.equal(supervisionLine(-1, 0).line, null)
  assert.equal(supervisionLine(0.5, 0).line, null)
})

test('the list cap is 12', () => assert.equal(SUPERVISION_LIST_MAX, 12))

test('paths: relative inside the folder, as written outside it; folder and name split', () => {
  assert.equal(relativeTo('/r/api', '/r/api/server/retry.ts'), 'server/retry.ts')
  assert.equal(relativeTo('/r/api/', '/r/api/server/retry.ts'), 'server/retry.ts')
  assert.equal(relativeTo('/r/api', '/r/apix/retry.ts'), '/r/apix/retry.ts')
  assert.equal(relativeTo(null, '/r/a.ts'), '/r/a.ts')
  assert.deepEqual(splitPath('server/webhooks/retry.ts'), { dir: 'server/webhooks/', name: 'retry.ts' })
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' })
})

// ---------------------------------------------------------------------------
// Touches out of a session's events
// ---------------------------------------------------------------------------

const toolUse = (name: string, input: Record<string, unknown>, id = `tu-${Math.random()}`): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
})

test('only Write, Edit, MultiEdit and NotebookEdit count; Bash and Read do not', () => {
  const events = [
    toolUse('Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }),
    toolUse('Write', { file_path: '/r/b.ts', content: '' }),
    toolUse('MultiEdit', { file_path: '/r/c.ts', edits: [] }),
    toolUse('NotebookEdit', { notebook_path: '/r/d.ipynb', new_source: '' }),
    toolUse('Read', { file_path: '/r/e.ts' }),
    toolUse('Bash', { command: "sed -i '' s/a/b/ /r/f.ts" }),
    { kind: 'sdk', message: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '"file_path"' }] } } },
    { kind: 'notice', text: 'a team paused' },
  ] satisfies SessionEvent[]
  const touches = touchesOf('s1', events.map((event, n) => ({ event, createdAt: 100 + n })))
  assert.deepEqual(
    touches.map((x) => x.path),
    ['/r/a.ts', '/r/b.ts', '/r/c.ts', '/r/d.ipynb'],
  )
  assert.equal(touches[0].sessionId, 's1')
  assert.equal(touches[0].at, 100)
})

// ---------------------------------------------------------------------------
// The op: opening the list resets the count
// ---------------------------------------------------------------------------

async function withRt(fn: (rt: WorkspaceRuntime) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-supervision-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = {
    store,
    meta: { id: 'test' },
    clients: new Set(),
    inboxCache: null,
    rows: new Map(),
    sessionItem: new Map(),
    attachmentsDir: path.join(dir, 'attachments'),
  } as unknown as WorkspaceRuntime
  try {
    await fn(rt)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

async function counted(rt: WorkspaceRuntime, id: string): Promise<ScoredItem['supervision']> {
  const item = (await rt.store.items.get(id))!
  const scored = { ...item, junior: { state: 'working' } } as unknown as ScoredItem
  await withSupervision(rt, [scored], new Map())
  return scored.supervision
}

test('opening the list returns the files, records the time, and resets the count', () =>
  withRt(async (rt) => {
    const id = await createManualOp(rt, { title: 'Retry the webhook on 502' })
    await rt.store.sessions.create({ id: 'fix', title: 'Fix the 502 retry', cwd: '/r/api', projectId: null })
    await rt.store.links.add({ fromKind: 'session', fromId: 'fix', toKind: 'item', toId: id, role: 'dispatch' })
    let seq = 0
    await rt.store.events.append('fix', ++seq, toolUse('Edit', { file_path: '/r/api/server/retry.ts' }))
    await rt.store.events.append('fix', ++seq, toolUse('Edit', { file_path: '/r/api/server/retry.ts' }))
    await rt.store.events.append('fix', ++seq, toolUse('Write', { file_path: '/r/api/core/backoff.ts' }))
    await rt.store.events.append('fix', ++seq, toolUse('Read', { file_path: '/r/api/README.md' }))
    // a brief run only reads the item: its edits don't count
    await rt.store.sessions.create({ id: 'brief', title: 'Brief', cwd: '/r/api', projectId: null })
    await rt.store.links.add({ fromKind: 'session', fromId: 'brief', toKind: 'item', toId: id, role: 'brief' })
    await rt.store.events.append('brief', 1, toolUse('Write', { file_path: '/r/api/brief.md' }))

    assert.deepEqual(await counted(rt, id), { files: 2, sends: 0 })

    await tick()
    const seen = await changesSeenOp(rt, { id })
    assert.equal(seen.total, 2)
    assert.equal(seen.since, null)
    assert.deepEqual(
      seen.files.map((f) => [f.path, f.sessionTitle]),
      [
        ['core/backoff.ts', 'Fix the 502 retry'],
        ['server/retry.ts', 'Fix the 502 retry'],
      ],
    )
    assert.equal((await rt.store.items.get(id))?.changesSeenAt, seen.seenAt)
    const log = await rt.store.items.events(id)
    assert.equal(log.at(-1)?.event, 'changes-seen')
    assert.equal(log.at(-1)?.actor, 'user')

    // reset: nothing left to show
    assert.equal(await counted(rt, id), undefined)

    // a new edit brings the line back
    await tick()
    await rt.store.events.append('fix', ++seq, toolUse('Edit', { file_path: '/r/api/server/retry.ts' }))
    assert.deepEqual(await counted(rt, id), { files: 1, sends: 0 })
    const again = await changesSeenOp(rt, { id })
    assert.equal(again.since, seen.seenAt)
    assert.deepEqual(again.files.map((f) => f.path), ['server/retry.ts'])
  }))

test('a task session counts, through the task, with no link', () =>
  withRt(async (rt) => {
    const id = await createManualOp(rt, { title: 'x' })
    await rt.store.sessions.create({ id: 'task1', title: 'Fix CI', cwd: '/r', projectId: null })
    await rt.store.events.append('task1', 1, toolUse('Edit', { file_path: '/r/a.ts' }))
    const scored = { ...(await rt.store.items.get(id))!, junior: { state: 'working' } } as unknown as ScoredItem
    await withSupervision(rt, [scored], new Map([[id, [{ sessionId: 'task1' } as never]]]))
    assert.deepEqual(scored.supervision, { files: 1, sends: 0 })
    // an item Junior isn't on gets no line
    const idle = { ...(await rt.store.items.get(id))! } as unknown as ScoredItem
    await withSupervision(rt, [idle], new Map([[id, [{ sessionId: 'task1' } as never]]]))
    assert.equal(idle.supervision, undefined)
  }))

test('the op refuses a bad or unknown id', () =>
  withRt(async (rt) => {
    await assert.rejects(changesSeenOp(rt, {}), /need an item id/)
    await assert.rejects(changesSeenOp(rt, { id: 'manual:nope' }), /no such item/)
  }))
