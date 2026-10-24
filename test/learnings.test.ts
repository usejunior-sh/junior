/**
 * Learnings with receipts (core/junior/learnings.ts + server/learnings-ops.ts):
 * the strict file, sightings (candidate → proposed on a second day, never
 * kept), expiry and budget on a fake clock, the loss guard, and the folder
 * on disk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  budget,
  dropsTooMuch,
  edit,
  EXPIRE_MS,
  isDay,
  keep,
  KEPT_PER_SCOPE,
  learningId,
  markUsed,
  normaliseText,
  parseLearning,
  scopeFrom,
  serializeLearning,
  sight,
  sweep,
  withinBudget,
  type Learning,
} from '../core/junior/learnings.js'

// The folder pulls in the workspace registry; keep it off the real ~/.junior.
const home = mkdtempSync(path.join(tmpdir(), 'junior-learnings-home-'))
process.env.JUNIOR_HOME = home
const { LearningsFolder } = await import('../server/learnings-ops.js')
test.after(() => rmSync(home, { recursive: true, force: true }))

const DAY = 86_400_000
/** Local time, so day keys don't depend on the machine's zone. */
const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()

const learning = (over: Partial<Learning> = {}): Learning => ({
  id: 'use-pnpm',
  text: 'Run pnpm test:unit, not pnpm test, in acme/web.',
  scope: 'repo:acme/web',
  status: 'proposed',
  sources: [
    { ref: 'pr:acme/web#3235', day: '2026-10-20' },
    { ref: 'pr:acme/web#3240', day: '2026-10-21' },
  ],
  createdAt: at(20),
  ...over,
})

const FILE = `---
scope: repo:acme/web
status: kept
createdAt: 2026-10-20T09:12:00.000Z
keptAt: 2026-10-21T16:40:00.000Z
sources:
  - { ref: "pr:acme/web#3235", day: 2026-10-20 }
  - { ref: "slack:C123/1729.55", day: 2026-10-21 }
---
Run pnpm test:unit, not pnpm test, in acme/web.
`

// ---------------------------------------------------------------------------
// The file

test('a good file parses', () => {
  const { learning: l, errors } = parseLearning('use-pnpm', FILE)
  assert.deepEqual(errors, [])
  assert.ok(l)
  assert.equal(l.scope, 'repo:acme/web')
  assert.equal(l.status, 'kept')
  assert.equal(l.text, 'Run pnpm test:unit, not pnpm test, in acme/web.')
  assert.equal(l.createdAt, Date.parse('2026-10-20T09:12:00.000Z'))
  assert.equal(l.keptAt, Date.parse('2026-10-21T16:40:00.000Z'))
  assert.equal(l.lastUsedAt, undefined)
  assert.deepEqual(l.sources, [
    { ref: 'pr:acme/web#3235', day: '2026-10-20' },
    { ref: 'slack:C123/1729.55', day: '2026-10-21' },
  ])
})

test('strict parse: an unknown key is an error and there is no learning', () => {
  const r = parseLearning('use-pnpm', FILE.replace('status: kept', 'status: kept\nconfidence: high'))
  assert.equal(r.learning, null)
  assert.ok(r.errors.some((e) => e.includes('unknown key "confidence"')), r.errors.join('; '))
})

test('strict parse: an unknown key inside a source is an error', () => {
  const r = parseLearning('use-pnpm', FILE.replace('day: 2026-10-20 }', 'day: 2026-10-20, by: junior }'))
  assert.equal(r.learning, null)
  assert.ok(r.errors.some((e) => e.includes('unknown key "by"')))
})

test('strict parse: every bad field is named', () => {
  const cases: Array<[string, string]> = [
    [FILE.replace('scope: repo:acme/web', 'scope: team'), 'scope'],
    [FILE.replace('status: kept', 'status: maybe'), 'status'],
    [FILE.replace('createdAt: 2026-10-20T09:12:00.000Z', 'createdAt: yesterday'), 'createdAt'],
    [FILE.replace('createdAt: 2026-10-20T09:12:00.000Z\n', ''), 'createdAt'],
    [FILE.replace('day: 2026-10-20', 'day: 2026-02-30'), 'day'],
    [FILE.replace(/sources:[\s\S]*?---/, 'sources: []\n---'), 'sources'],
    [FILE.replace(/sources:[\s\S]*?---/, '---'), 'sources'],
    [FILE.replace('Run pnpm test:unit, not pnpm test, in acme/web.\n', ''), 'body'],
    [FILE.replace('keptAt: 2026-10-21T16:40:00.000Z\n', ''), 'keptAt'],
    ['no frontmatter here', 'frontmatter'],
  ]
  for (const [text, field] of cases) {
    const r = parseLearning('use-pnpm', text)
    assert.equal(r.learning, null, field)
    assert.ok(r.errors.some((e) => e.includes(field)), `${field}: ${r.errors.join('; ')}`)
  }
  assert.equal(parseLearning('Bad Id', FILE).learning, null)
})

test('serialize round-trips, quotes and all', () => {
  const l = learning({ status: 'kept', keptAt: at(21), lastUsedAt: at(23), sources: [{ ref: 'file:src/a "b".ts:12', day: '2026-10-20' }] })
  const back = parseLearning(l.id, serializeLearning(l))
  assert.deepEqual(back.errors, [])
  assert.deepEqual(back.learning, l)
  const g = learning({ scope: 'global', status: 'candidate' })
  assert.deepEqual(parseLearning(g.id, serializeLearning(g)).learning, g)
})

test('scopes: global or one repo, lowercased', () => {
  assert.equal(scopeFrom('global'), 'global')
  assert.equal(scopeFrom('repo:Acme/Web'), 'repo:acme/web')
  assert.equal(scopeFrom('acme/web'), 'repo:acme/web')
  assert.equal(scopeFrom('repo:acme'), null)
  assert.equal(scopeFrom('team'), null)
  assert.equal(scopeFrom(3), null)
  assert.ok(isDay('2026-10-24'))
  assert.ok(!isDay('2026-13-01'))
})

test('ids come from the words and never collide', () => {
  assert.equal(learningId('Run pnpm test:unit in acme/web!', new Set()), 'run-pnpm-test-unit-in-acme-web')
  assert.equal(learningId('Run pnpm', new Set(['run-pnpm', 'run-pnpm-2'])), 'run-pnpm-3')
  assert.equal(learningId('!!!', new Set()), 'learning')
  assert.ok(learningId('x'.repeat(200), new Set()).length <= 48)
})

// ---------------------------------------------------------------------------
// Sightings

test('one sighting is a quiet candidate', () => {
  const s = sight([], { text: 'Squash merge in acme/web', scope: 'repo:acme/web', ref: 'pr:acme/web#1' }, at(20), () => 'squash')
  assert.equal(s.kind, 'candidate')
  assert.equal(s.learning.status, 'candidate')
  assert.deepEqual(s.learning.sources, [{ ref: 'pr:acme/web#1', day: '2026-10-20' }])
})

test('a second sighting on the same day stays a candidate', () => {
  const first = sight([], { text: 'Squash merge in acme/web', scope: 'repo:acme/web', ref: 'pr:acme/web#1' }, at(20, 9), () => 'squash').learning
  const s = sight([first], { text: 'squash merge in  acme/web.', scope: 'repo:acme/web', ref: 'pr:acme/web#2' }, at(20, 17), () => 'x')
  assert.equal(s.kind, 'candidate')
  assert.equal(s.learning.status, 'candidate')
  assert.equal(s.learning.sources.length, 2)
})

test('a sighting on another day makes a proposal, never a kept learning', () => {
  const first = sight([], { text: 'Squash merge in acme/web', scope: 'repo:acme/web', ref: 'pr:acme/web#1' }, at(20, 23), () => 'squash').learning
  const s = sight([first], { text: 'Squash merge in acme/web', scope: 'repo:acme/web', ref: 'pr:acme/web#2' }, at(21, 1), () => 'x')
  assert.equal(s.kind, 'proposed')
  assert.equal(s.learning.status, 'proposed')
  assert.equal(s.learning.id, 'squash')
  // A third, a fourth: still only proposed. Only keep keeps.
  let list = [s.learning]
  for (let d = 22; d < 26; d++) {
    const n = sight(list, { text: 'Squash merge in acme/web', scope: 'repo:acme/web', ref: `pr:acme/web#${d}` }, at(d), () => 'x')
    assert.equal(n.kind, 'known')
    assert.notEqual(n.learning.status, 'kept')
    list = [n.learning]
  }
})

test('the same words in another scope are a different learning', () => {
  const first = sight([], { text: 'Squash merge', scope: 'repo:acme/web', ref: 'pr:acme/web#1' }, at(20), () => 'a').learning
  const s = sight([first], { text: 'Squash merge', scope: 'global', ref: 'pr:acme/api#1' }, at(21), () => 'b')
  assert.equal(s.kind, 'candidate')
  assert.equal(s.learning.id, 'b')
  assert.equal(normaliseText('  Squash   *merge*. '), 'squash merge')
})

// ---------------------------------------------------------------------------
// Keep, edit

test('nothing becomes kept without the keep move', () => {
  const p = learning()
  const e = edit([p], p.id, { text: 'Run pnpm test:unit (not pnpm test) in acme/web.' })
  assert.ok(e.ok)
  assert.equal(e.learning.status, 'proposed')
  const k = keep([p], p.id, at(22))
  assert.ok(k.ok)
  assert.equal(k.learning.status, 'kept')
  assert.equal(k.learning.keptAt, at(22))
  assert.equal(keep([p], 'nope', at(22)).ok, false)
})

test('budget: a full scope refuses another keep and names the least used', () => {
  const kept = Array.from({ length: KEPT_PER_SCOPE }, (_, i) =>
    learning({ id: `k${i}`, text: `rule ${i}`, status: 'kept', keptAt: at(1) + i * DAY / 24, createdAt: at(1) }),
  )
  const p = learning({ id: 'new' })
  const b = budget([...kept, p], 'repo:acme/web')
  assert.equal(b.count, KEPT_PER_SCOPE)
  assert.ok(b.full)
  assert.equal(b.leastUsed?.id, 'k0')
  const k = keep([...kept, p], 'new', at(22))
  assert.equal(k.ok, false)
  assert.match((k as { error: string }).error, /at most 20 learnings for acme\/web/)
  // Another scope has room.
  assert.ok(keep([...kept, { ...p, scope: 'global' }], 'new', at(22)).ok)
  // Moving a kept one into the full scope is refused too.
  const g = learning({ id: 'g', scope: 'global', status: 'kept', keptAt: at(20) })
  assert.equal(edit([...kept, g], 'g', { scope: 'repo:acme/web' }).ok, false)
  // A smaller budget, on demand.
  assert.equal(keep([kept[0], p], 'new', at(22), 1).ok, false)
})

test('withinBudget caps each scope, most recently active first', () => {
  const list = [
    learning({ id: 'old', status: 'kept', keptAt: at(1), createdAt: at(1), sources: [{ ref: 'r', day: '2026-10-01' }] }),
    learning({ id: 'new', status: 'kept', keptAt: at(10), createdAt: at(1), sources: [{ ref: 'r', day: '2026-10-01' }] }),
    learning({ id: 'glob', scope: 'global', status: 'kept', keptAt: at(1), createdAt: at(1), sources: [{ ref: 'r', day: '2026-10-01' }] }),
    learning({ id: 'prop', status: 'proposed' }),
  ]
  assert.deepEqual(
    withinBudget(list, 1).map((l) => l.id),
    ['new', 'glob'],
  )
})

test('loss guard: an edit that cuts more than half needs confirm', () => {
  const p = learning({ text: 'Run pnpm test:unit, not pnpm test, in acme/web. The full suite needs Docker.' })
  const short = edit([p], p.id, { text: 'Use pnpm.' })
  assert.equal(short.ok, false)
  assert.match((short as { error: string }).error, /more than half/)
  assert.ok(edit([p], p.id, { text: 'Use pnpm.', confirm: true }).ok)
  // A small cut is fine without confirm.
  assert.ok(edit([p], p.id, { text: 'Run pnpm test:unit, not pnpm test, in acme/web.' }).ok)
  assert.equal(edit([p], p.id, { text: '   ' }).ok, false)
  assert.ok(!dropsTooMuch(2, 0, 3))
  assert.ok(dropsTooMuch(6, 2, 3))
  assert.ok(!dropsTooMuch(6, 3, 3))
})

// ---------------------------------------------------------------------------
// Expiry, on a fake clock

test('expiry: 28 days with nothing happening, and not a minute before', () => {
  const c = learning({ id: 'c', status: 'candidate', createdAt: at(1), sources: [{ ref: 'r', day: '2026-10-01' }] })
  const edge = at(1) + EXPIRE_MS
  assert.deepEqual(sweep([c], edge).expired, [])
  assert.deepEqual(
    sweep([c], edge + 60_000).expired.map((l) => l.id),
    ['c'],
  )
})

test('expiry: being used, kept or seen again keeps it fresh', () => {
  const base = { createdAt: at(1), sources: [{ ref: 'r', day: '2026-10-01' }] }
  const now = at(1) + 40 * DAY
  const used = learning({ ...base, id: 'used', status: 'kept', keptAt: at(1), lastUsedAt: now - 10 * DAY })
  const kept = learning({ ...base, id: 'kept', status: 'kept', keptAt: now - 3 * DAY })
  const seen = learning({ ...base, id: 'seen', status: 'proposed', sources: [...base.sources, { ref: 'r2', day: '2026-11-05' }] })
  const stale = learning({ ...base, id: 'stale', status: 'proposed' })
  const s = sweep([used, kept, seen, stale], now)
  assert.deepEqual(
    s.live.map((l) => l.id),
    ['used', 'kept', 'seen'],
  )
  assert.deepEqual(
    s.expired.map((l) => l.id),
    ['stale'],
  )
  assert.deepEqual(s.held, [])
})

test('loss guard: a month away does not wipe more than half of what you kept', () => {
  const old = { createdAt: at(1), keptAt: at(1), status: 'kept' as const, sources: [{ ref: 'r', day: '2026-10-01' }] }
  const kept = ['a', 'b', 'c', 'd'].map((id) => learning({ ...old, id }))
  const fresh = learning({ id: 'fresh', status: 'kept', keptAt: at(1) + 39 * DAY, createdAt: at(1) })
  const cand = learning({ id: 'cand', status: 'candidate', createdAt: at(1), sources: [{ ref: 'r', day: '2026-10-01' }] })
  const s = sweep([...kept, fresh, cand], at(1) + 40 * DAY)
  // 4 of 5 kept would go: held. The candidate still goes.
  assert.deepEqual(
    s.held.map((l) => l.id),
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual(
    s.expired.map((l) => l.id),
    ['cand'],
  )
  assert.equal(s.live.length, 5)
  // With enough fresh ones, the stale kept go as usual.
  const many = ['f1', 'f2', 'f3', 'f4'].map((id) => learning({ ...fresh, id }))
  const s2 = sweep([...kept, ...many], at(1) + 40 * DAY)
  assert.equal(s2.expired.length, 4)
  assert.deepEqual(s2.held, [])
})

test('markUsed touches only kept learnings', () => {
  const k = learning({ id: 'k', status: 'kept', keptAt: at(20) })
  const p = learning({ id: 'p' })
  assert.deepEqual(
    markUsed([k, p], ['k', 'p', 'x'], at(23)).map((l) => [l.id, l.lastUsedAt]),
    [['k', at(23)]],
  )
})

// ---------------------------------------------------------------------------
// The folder on disk

test('the folder: propose, keep, edit, forget, sweep', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'junior-learnings-')), 'learnings')
  const f = new LearningsFolder(dir)
  assert.deepEqual(await f.read(), { learnings: [], broken: [] })

  await assert.rejects(f.propose({ text: 'Squash merge', scope: 'global', ref: '' }, at(20)), /ref/)
  await assert.rejects(f.propose({ text: 'Squash merge', scope: 'team', ref: 'pr:a/b#1' }, at(20)), /scope/)

  const one = await f.propose({ text: 'Squash merge in acme/web', scope: 'acme/web', ref: 'pr:acme/web#1' }, at(20))
  assert.equal(one.kind, 'candidate')
  assert.deepEqual(readdirSync(dir), ['squash-merge-in-acme-web.md'])
  const two = await f.propose({ text: 'Squash merge in acme/web', scope: 'repo:acme/web', ref: 'pr:acme/web#2' }, at(21))
  assert.equal(two.kind, 'proposed')
  assert.equal(two.learning.id, one.learning.id)

  // Two at once, through the queue: both land.
  await Promise.all([
    f.propose({ text: 'Rebase, never merge main in', scope: 'global', ref: 'pr:a/b#1' }, at(21)),
    f.propose({ text: 'Rebase, never merge main in', scope: 'global', ref: 'pr:a/b#2' }, at(22)),
  ])
  const rebase = (await f.read()).learnings.find((l) => l.text.startsWith('Rebase'))
  assert.equal(rebase?.status, 'proposed')
  assert.equal(rebase?.sources.length, 2)

  const kept = await f.keep(one.learning.id, at(22))
  assert.equal(kept.status, 'kept')
  const edited = await f.edit(one.learning.id, { text: 'Squash merge PRs in acme/web' })
  assert.equal(edited.status, 'kept')
  assert.match(readFileSync(f.pathOf(one.learning.id), 'utf8'), /Squash merge PRs in acme\/web/)

  // A hand-broken file is listed as broken, never rewritten, never used.
  writeFileSync(path.join(dir, 'broken.md'), '---\nscope: global\nmood: happy\n---\nhi\n')
  const read = await f.read()
  assert.deepEqual(
    read.broken.map((b) => b.id),
    ['broken'],
  )
  await assert.rejects(f.keep('broken', at(22)), /no such learning/)

  const gone = await f.forget(rebase!.id)
  assert.equal(gone.id, rebase!.id)
  await assert.rejects(f.forget(rebase!.id), /no such learning/)

  await f.markUsed([one.learning.id], at(23))
  assert.equal((await f.read()).learnings.find((l) => l.id === one.learning.id)?.lastUsedAt, at(23))

  // A month and a half on, the one kept learning goes (too few for the guard).
  const s = await f.sweep(at(23) + 45 * DAY)
  assert.deepEqual(
    s.expired.map((l) => l.id),
    [one.learning.id],
  )
  assert.deepEqual(readdirSync(dir).sort(), ['broken.md'])
  rmSync(path.dirname(dir), { recursive: true, force: true })
})

test('the folder ignores dotfiles and non-markdown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-learnings-'))
  mkdirSync(path.join(dir, 'sub'))
  writeFileSync(path.join(dir, '.DS_Store'), 'x')
  writeFileSync(path.join(dir, 'notes.txt'), 'x')
  writeFileSync(path.join(dir, 'use-pnpm.md'), FILE)
  const r = await new LearningsFolder(dir).read()
  assert.deepEqual(
    r.learnings.map((l) => l.id),
    ['use-pnpm'],
  )
  assert.deepEqual(r.broken, [])
  rmSync(dir, { recursive: true, force: true })
})
