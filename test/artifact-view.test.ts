/**
 * The pure side of the Artifacts tab and page (web/src/artifactView.ts):
 * filters and chip counts, the `#/artifacts?session=` link, the version
 * dropdown's line, and the text comparison of two versions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArtifactFormat, ArtifactVersion, ArtifactWithLinks, Link } from '../shared/protocol.js'
import {
  agoLong,
  artifactsRoute,
  chipCounts,
  compareMode,
  filterArtifacts,
  originSession,
  outputSessions,
  prettyJson,
  previousVersion,
  sessionFromHash,
  textChanges,
  versionLine,
  type ArtifactFilter,
} from '../web/src/artifactView.js'

const link = (id: string, session: string, createdAt: number): Link => ({
  id,
  fromKind: 'artifact',
  fromId: 'x',
  toKind: 'session',
  toId: session,
  role: 'output',
  createdAt,
})

const art = (id: string, format: ArtifactFormat, o: Partial<ArtifactWithLinks> = {}): ArtifactWithLinks => ({
  id,
  path: `files/${id}.${format}`,
  title: id,
  author: 'model',
  refs: [],
  created: 1,
  updated: 1,
  mtime: 1,
  size: 1,
  format,
  version: 1,
  history: true,
  links: [],
  hidden: false,
  ...o,
})

const all: ArtifactFilter = { chip: 'all', author: 'all', session: '', showFinished: false }

const rows = [
  art('a', 'md', { author: 'human' }),
  art('b', 'html', { links: [link('l1', 's1', 10)], updated: 50 }),
  art('c', 'png', { links: [link('l2', 's1', 20), link('l3', 's2', 5)], updated: 90 }),
  art('d', 'svg', { links: [link('l4', 's2', 30)], updated: 70 }),
  art('e', 'json'),
  art('f', 'md', { hidden: true }),
]

test('chips filter by format group: svg counts as an image, json as other', () => {
  const ids = (chip: ArtifactFilter['chip']) => filterArtifacts(rows, { ...all, chip }).map((a) => a.id)
  assert.deepEqual(ids('all'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(ids('md'), ['a'])
  assert.deepEqual(ids('images'), ['c', 'd'])
  assert.deepEqual(ids('other'), ['e'])
  assert.deepEqual(ids('pdf'), [])
})

test('finished briefs show only when asked for', () => {
  assert.equal(filterArtifacts(rows, { ...all, showFinished: true }).length, 6)
})

test('the author and session filters narrow together', () => {
  assert.deepEqual(filterArtifacts(rows, { ...all, author: 'human' }).map((a) => a.id), ['a'])
  assert.deepEqual(filterArtifacts(rows, { ...all, session: 's2' }).map((a) => a.id), ['c', 'd'])
  assert.deepEqual(filterArtifacts(rows, { ...all, session: 's2', chip: 'images' }).map((a) => a.id), ['c', 'd'])
  assert.deepEqual(filterArtifacts(rows, { ...all, session: 's2', chip: 'html' }).map((a) => a.id), [])
})

test('chip counts apply every filter but the chip itself', () => {
  assert.deepEqual(chipCounts(rows, all), { all: 5, md: 1, html: 1, csv: 0, pdf: 0, images: 2, other: 1 })
  // picking the images chip does not zero the others: they show what a click would give
  assert.deepEqual(chipCounts(rows, { ...all, chip: 'images', session: 's1' }), { all: 2, md: 0, html: 1, csv: 0, pdf: 0, images: 1, other: 0 })
})

test('the origin of an artifact is its earliest output link', () => {
  assert.equal(originSession(rows[2]), 's2')
  assert.equal(originSession(rows[0]), undefined)
  const ctx = art('g', 'md', { links: [{ ...link('l9', 's9', 1), role: 'context' }] })
  assert.equal(originSession(ctx), undefined)
})

test('output sessions are listed newest activity first, once each', () => {
  assert.deepEqual(outputSessions(rows), ['s1', 's2'])
  assert.deepEqual(outputSessions(rows.filter((a) => a.id === 'd' || a.id === 'b')), ['s2', 's1'])
  assert.deepEqual(outputSessions([]), [])
})

test('the session filter round-trips through the hash', () => {
  assert.equal(artifactsRoute(''), '/artifacts')
  assert.equal(sessionFromHash('/artifacts'), '')
  assert.equal(sessionFromHash('#/artifacts?session=abc-123'), 'abc-123')
  assert.equal(sessionFromHash(artifactsRoute('a b&c')), 'a b&c')
  assert.equal(sessionFromHash('/artifact/xyz?session=nope'), '')
  assert.equal(sessionFromHash('/artifacts?other=1'), '')
})

test('agoLong reads in plain units', () => {
  const now = 10 * 24 * 3600_000
  assert.equal(agoLong(now - 20_000, now), 'just now')
  assert.equal(agoLong(now - 2 * 60_000, now), '2 min ago')
  assert.equal(agoLong(now - 3 * 3600_000, now), '3 h ago')
  assert.equal(agoLong(now - 4 * 24 * 3600_000, now), '4 d ago')
  assert.equal(agoLong(now + 5_000, now), 'just now')
})

const ver = (version: number, o: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  version,
  sha: `sha${version}`,
  at: 0,
  path: 'files/x.html',
  current: false,
  ...o,
})

test('the version line names the session, or says it is gone, or says nothing for a human edit', () => {
  const now = 2 * 60_000
  const title = (id: string) => (id === 's1' ? 'Q3 churn' : null)
  assert.equal(versionLine(ver(3, { sessionId: 's1' }), title, now), 'v3 · 2 min ago · from Q3 churn')
  assert.equal(versionLine(ver(2, { sessionId: 'gone' }), title, now), 'v2 · 2 min ago · from a deleted session')
  assert.equal(versionLine(ver(1), title, now), 'v1 · 2 min ago')
})

test('previousVersion finds the next lower version in a newest-first list', () => {
  const list = [ver(4), ver(3), ver(2), ver(1)]
  assert.equal(previousVersion(list, 4)?.version, 3)
  assert.equal(previousVersion(list, 2)?.version, 1)
  assert.equal(previousVersion(list, 1), undefined)
  assert.equal(previousVersion([ver(5), ver(3)], 5)?.version, 3)
})

test('text formats compare as a diff, the rest as old and new', () => {
  for (const f of ['md', 'csv', 'txt', 'json'] as const) assert.equal(compareMode(f), 'text')
  for (const f of ['html', 'pdf', 'png', 'jpg', 'gif', 'webp', 'svg'] as const) assert.equal(compareMode(f), 'visual')
})

test('textChanges counts the lines that moved and reports no change for equal text', () => {
  const r = textChanges('a,b\n1,2\n3,4', 'a,b\n1,2\n3,5\n6,7')
  assert.equal(r.changed, true)
  assert.equal(r.diff.additions, 2)
  assert.equal(r.diff.deletions, 1)
  const same = textChanges('x\ny', 'x\ny')
  assert.equal(same.changed, false)
  assert.equal(same.diff.additions + same.diff.deletions, 0)
})

test('textChanges folds a long unchanged run', () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const r = textChanges(body.join('\n'), [...body.slice(0, 39), 'edited'].join('\n'))
  assert.equal(r.diff.rows.some((x) => x.kind === 'hunk'), true)
  assert.ok(r.diff.rows.length < 20)
})

test('prettyJson indents valid JSON and leaves anything else alone', () => {
  assert.equal(prettyJson('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}')
  assert.equal(prettyJson('{oops'), '{oops')
})
