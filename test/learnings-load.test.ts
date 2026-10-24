/**
 * learnings-load: kept learnings go into chats and runs, their receipts
 * re-checked first. Only kept learnings for the session's scope load; one
 * whose receipts are all gone is skipped and marked stale; the ones loaded
 * get lastUsedAt; nothing touches the network. Fake clock, fixture folders.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  citationOf,
  citeOf,
  forScope,
  keep,
  loadVerdict,
  parseLearning,
  serializeLearning,
  vouched,
  type Learning,
} from '../core/junior/learnings.js'
import { composeLearnings, withLearnings, LEARNINGS_CAP } from '../shared/juniorContext.js'

// The ops pull in the workspace registry; keep it off the real ~/.junior.
const home = mkdtempSync(path.join(tmpdir(), 'junior-learnings-load-'))
process.env.JUNIOR_HOME = home
const { LearningsFolder, loadLearnings, checkCitations } = await import('../server/learnings-ops.js')
test.after(() => rmSync(home, { recursive: true, force: true }))

const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()

let n = 0
const kept = (text: string, scope: Learning['scope'], refs: string[], extra: Partial<Learning> = {}): Learning => ({
  id: `l-${++n}`,
  text,
  scope,
  status: 'kept',
  sources: refs.map((ref, i) => ({ ref, day: `2026-10-${String(10 + i).padStart(2, '0')}` })),
  createdAt: at(10),
  proposedAt: at(11),
  keptAt: at(11, 16),
  ...extra,
})

/** A project folder with one file, and an empty learnings folder next to it. */
function fixture() {
  const root = mkdtempSync(path.join(home, 'fx-'))
  const project = path.join(root, 'web')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  writeFileSync(path.join(project, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(project, 'package.json'), '{}\n')
  const folder = new LearningsFolder(path.join(root, 'learnings'))
  const env = {
    projectPath: project,
    itemExists: async (id: string) => id === 'manual:live',
    sessionExists: async (id: string) => id === 's-live',
  }
  return { root, project, folder, env }
}

const onDisk = (folder: InstanceType<typeof LearningsFolder>, id: string) => parseLearning(id, readFileSync(folder.pathOf(id), 'utf8')).learning

test('citationOf sorts receipts into what can be checked here', () => {
  assert.deepEqual(citationOf('src/a.ts:42'), { kind: 'file', path: 'src/a.ts', line: 42 })
  assert.deepEqual(citationOf('src/a.ts:42-50'), { kind: 'file', path: 'src/a.ts', line: 42 })
  assert.deepEqual(citationOf('/abs/path/x.md:3'), { kind: 'file', path: '/abs/path/x.md', line: 3 })
  assert.deepEqual(citationOf('package.json'), { kind: 'file', path: 'package.json' })
  assert.deepEqual(citationOf('file:docs/x.md'), { kind: 'file', path: 'docs/x.md' })
  assert.deepEqual(citationOf('session:abc-123'), { kind: 'session', id: 'abc-123' })
  assert.deepEqual(citationOf('item:github:a/b#1'), { kind: 'item', id: 'github:a/b#1' })
  assert.deepEqual(citationOf('manual:1f2e'), { kind: 'item', id: 'manual:1f2e' })
  for (const ref of ['pr:acme/web#3235', 'github:acme/web#12', 'slack:C1/1712.3', 'linear:KEY-1', 'https://x.dev/a', 'thread:abc']) {
    assert.deepEqual(citationOf(ref), { kind: 'remote' }, ref)
  }
  assert.deepEqual(citationOf('review'), { kind: 'unknown' })
  assert.deepEqual(citationOf('jira:ABC-1'), { kind: 'unknown' })
})

test('loadVerdict: stale only when every receipt is gone', () => {
  assert.equal(loadVerdict(['gone', 'gone']), 'stale')
  assert.equal(loadVerdict(['gone', 'ok']), 'load')
  assert.equal(loadVerdict(['gone', 'unchecked']), 'load')
  assert.equal(loadVerdict([]), 'load')
})

test('only kept learnings for the matching scope are included', () => {
  const list: Learning[] = [
    kept('Squash merge everywhere', 'global', ['pr:a/b#1']),
    kept('Run pnpm test:unit in acme/web', 'repo:acme/web', ['pr:acme/web#1']),
    kept('Use yarn in acme/api', 'repo:acme/api', ['pr:acme/api#1']),
    { ...kept('A proposal', 'global', ['pr:a/b#2']), status: 'proposed', keptAt: undefined },
    { ...kept('A candidate', 'global', ['pr:a/b#3']), status: 'candidate', keptAt: undefined, proposedAt: undefined },
    { ...kept('A stale one', 'global', ['pr:a/b#4']), status: 'stale', staleAt: at(12) },
  ]
  const web = forScope(list, 'Acme/Web').map((l) => l.text)
  assert.deepEqual(web, ['Run pnpm test:unit in acme/web', 'Squash merge everywhere'])
  assert.deepEqual(forScope(list, null).map((l) => l.text), ['Squash merge everywhere'])
  assert.deepEqual(forScope(list, 'other/repo').map((l) => l.text), ['Squash merge everywhere'])
})

test('a learning whose cited file is gone is skipped and marked stale on disk', async () => {
  const { folder, env } = fixture()
  const gone = kept('Keep helpers in src/old.ts', 'repo:acme/web', ['src/old.ts:4'])
  const here = kept('Keep helpers in src/a.ts', 'repo:acme/web', ['src/a.ts:2'])
  await folder.write(gone)
  await folder.write(here)
  const r = await loadLearnings(folder, 'acme/web', env, at(20))
  assert.deepEqual(r.ids, [here.id])
  assert.deepEqual(r.stale.map((l) => l.id), [gone.id])
  assert.match(r.append, /Keep helpers in src\/a\.ts \(acme\/web; learned from src\/a\.ts:2, 2026-10-10\)/)
  assert.doesNotMatch(r.append, /old\.ts/)
  const marked = onDisk(folder, gone.id)!
  assert.equal(marked.status, 'stale')
  assert.equal(marked.staleAt, at(20))
  assert.equal(marked.lastUsedAt, undefined)
  // Stale is never loaded again until you keep it.
  const again = await loadLearnings(folder, 'acme/web', env, at(21))
  assert.deepEqual(again.ids, [here.id])
  assert.deepEqual(again.stale, [])
})

test('a cited line past the end of the file counts as gone', async () => {
  const { env } = fixture()
  assert.deepEqual(await checkCitations(kept('x', 'repo:acme/web', ['src/a.ts:3', 'src/a.ts:4', 'src/']), env), ['ok', 'gone', 'gone'])
})

test('lastUsedAt is updated on load, and not rewritten minutes later', async () => {
  const { folder, env } = fixture()
  const l = kept('Squash merge everywhere', 'global', ['pr:acme/web#9'])
  await folder.write(l)
  const r = await loadLearnings(folder, 'acme/web', env, at(20))
  assert.equal(r.wrote, 1)
  assert.equal(onDisk(folder, l.id)!.lastUsedAt, at(20))
  const soon = await loadLearnings(folder, 'acme/web', env, at(20) + 60_000)
  assert.deepEqual(soon.ids, [l.id])
  assert.equal(soon.wrote, 0)
  assert.equal(onDisk(folder, l.id)!.lastUsedAt, at(20))
  await loadLearnings(folder, 'acme/web', env, at(21))
  assert.equal(onDisk(folder, l.id)!.lastUsedAt, at(21))
})

test('PR and thread refs pass without a network call', async () => {
  const { folder, env } = fixture()
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error('no network at load')
  }) as typeof fetch
  try {
    await folder.write(kept('Ask Priya before merging infra', 'repo:acme/web', ['pr:acme/web#3235', 'slack:C1/1712.3']))
    const r = await loadLearnings(folder, 'acme/web', env, at(20))
    assert.equal(r.ids.length, 1)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = real
  }
})

test('item and session receipts must still be in the store', async () => {
  const { folder, env } = fixture()
  const live = kept('From a live session', 'global', ['session:s-live'])
  const deadSession = kept('From a deleted session', 'global', ['session:s-gone'])
  const deadItem = kept('From a deleted item', 'global', ['manual:gone'])
  const liveItem = kept('From a live item', 'global', ['manual:live'])
  for (const l of [live, deadSession, deadItem, liveItem]) await folder.write(l)
  const r = await loadLearnings(folder, null, env, at(20))
  assert.deepEqual(new Set(r.ids), new Set([live.id, liveItem.id]))
  assert.deepEqual(new Set(r.stale.map((l) => l.id)), new Set([deadSession.id, deadItem.id]))
})

test('a global learning citing a relative file is not checked against another repo', async () => {
  const { folder, env } = fixture()
  const l = kept('Name tests after the behaviour', 'global', ['src/elsewhere.ts:10'])
  await folder.write(l)
  const r = await loadLearnings(folder, 'acme/web', env, at(20))
  assert.deepEqual(r.ids, [l.id])
  assert.equal(onDisk(folder, l.id)!.status, 'kept')
})

test('a dry load (trial run) changes nothing on disk', async () => {
  const { folder, env } = fixture()
  const gone = kept('Gone', 'repo:acme/web', ['src/nope.ts:1'])
  const here = kept('Here', 'repo:acme/web', ['src/a.ts:1'])
  await folder.write(gone)
  await folder.write(here)
  const r = await loadLearnings(folder, 'acme/web', env, at(20), { dry: true })
  assert.deepEqual(r.ids, [here.id])
  assert.equal(r.stale.length, 1)
  assert.equal(r.wrote, 0)
  assert.equal(onDisk(folder, gone.id)!.status, 'kept')
  assert.equal(onDisk(folder, here.id)!.lastUsedAt, undefined)
})

test('keeping a stale learning vouches for it: it loads without a re-check', async () => {
  const { folder, env } = fixture()
  const stale: Learning = { ...kept('Gone file rule', 'repo:acme/web', ['src/nope.ts:1']), status: 'stale', staleAt: at(15) }
  const m = keep([stale], stale.id, at(16))
  assert.ok(m.ok)
  assert.equal(m.learning.status, 'kept')
  assert.ok(vouched(m.learning))
  await folder.write(m.learning)
  const r = await loadLearnings(folder, 'acme/web', env, at(20))
  assert.deepEqual(r.ids, [stale.id])
})

test('staleAt round-trips through the file', () => {
  const l: Learning = { ...kept('Round trip', 'global', ['pr:a/b#1']), status: 'stale', staleAt: at(14) }
  assert.deepEqual(parseLearning(l.id, serializeLearning(l)).learning, l)
})

test('citeOf shows the newest receipt still there', () => {
  const l = kept('x', 'global', ['pr:a/b#1', 'src/gone.ts:1'])
  assert.equal(citeOf(l).ref, 'src/gone.ts:1')
  assert.equal(citeOf(l, ['ok', 'gone']).ref, 'pr:a/b#1')
})

test('composeLearnings: nothing adds nothing, the cap holds, invisible characters go', () => {
  assert.deepEqual(composeLearnings([]), { append: '', tokens: 0, ids: [] })
  const one = composeLearnings([{ id: 'a', text: 'Squash​ merge', scope: 'global', cite: { ref: 'pr:a/b#1', day: '2026-10-20' } }])
  assert.match(one.append, /## What you learned about how the user works/)
  assert.match(one.append, /- Squash merge \(everywhere; learned from pr:a\/b#1, 2026-10-20\)/)
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, text: 'w'.repeat(500), scope: 'global', cite: { ref: 'pr:a/b#1', day: '2026-10-20' } }))
  const capped = composeLearnings(many)
  assert.ok(capped.ids.length < 40 && capped.ids.length > 0)
  assert.ok(capped.append.length <= LEARNINGS_CAP + 400)
  const files = { append: '\n\n## Context', tokens: 3, files: [] }
  const both = withLearnings(files, one)
  assert.ok(both.append.startsWith(files.append))
  assert.deepEqual(both.learnings, { count: 1, tokens: one.tokens })
  assert.equal(withLearnings(files, composeLearnings([])), files)
})
