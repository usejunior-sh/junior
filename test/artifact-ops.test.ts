/**
 * The artifact write ops every door goes through (server/artifacts-ops.ts):
 * the session auto-link, who may rewrite what, what `from:` may read, and the
 * tool result a chat card is made from. A fake runtime over a real store, a
 * real git folder and temp project folders.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { parseArtifactResult } from '../shared/protocol.js'
import { ArtifactIndex } from '../server/artifacts.js'
import { createArtifactOp, toolResult, updateArtifactOp } from '../server/artifacts-ops.js'
import { sourceRoots, tempRoots } from '../server/artifact-source.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
const PDF = Buffer.from('%PDF-1.4\n%fake')

async function fixture(fn: (f: { rt: WorkspaceRuntime; dir: string; project: string; snapshots: Promise<unknown[]>[] }) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artifact-ops-'))
  const project = path.join(dir, 'project')
  mkdirSync(project)
  const store = openSqliteStore(':memory:')
  const snapshots: Promise<unknown[]>[] = []
  const artifacts = new ArtifactIndex(path.join(dir, 'artifacts'), store, () => snapshots.push(store.links.list()))
  const rows = new Map<string, { id: string; cwd: string; projectId: null; checkoutId: null }>([
    ['sess-1', { id: 'sess-1', cwd: project, projectId: null, checkoutId: null }],
    ['sess-2', { id: 'sess-2', cwd: project, projectId: null, checkoutId: null }],
  ])
  const rt = { store, artifacts, rows, meta: { id: 'ws-test' }, attachmentsDir: path.join(dir, 'attachments') } as unknown as WorkspaceRuntime
  try {
    await fn({ rt, dir, project, snapshots })
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a call from a session links the artifact to it as output', () =>
  fixture(async ({ rt }) => {
    const r = await createArtifactOp(rt, { title: 'Report', body: '<h1>hi</h1>', format: 'html' }, 'model', { sessionId: 'sess-1' })
    assert.equal(r.action, 'created')
    assert.equal(r.version, 1)
    assert.equal(r.artifact.format, 'html')
    const links = await rt.store.links.forSource('artifact', r.artifact.id)
    assert.equal(links.length, 1)
    assert.deepEqual({ kind: links[0].toKind, id: links[0].toId, role: links[0].role }, { kind: 'session', id: 'sess-1', role: 'output' })
    // not passing a session (an external client) links nothing
    const bare = await createArtifactOp(rt, { title: 'Bare', body: 'x', format: 'txt' }, 'model')
    assert.equal((await rt.store.links.forSource('artifact', bare.artifact.id)).length, 0)
  }))

test('an unknown session is refused, and nothing is written', () =>
  fixture(async ({ rt }) => {
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y' }, 'model', { sessionId: 'nope' }), /no session nope/)
    assert.equal((await rt.store.artifacts.list()).length, 0)
  }))

test('explicit links still work, including a session as output', () =>
  fixture(async ({ rt }) => {
    const r = await createArtifactOp(rt, { title: 'x', body: 'y', links: [{ kind: 'session', id: 'sess-2', role: 'output' }] }, 'model')
    const [l] = await rt.store.links.forSource('artifact', r.artifact.id)
    assert.equal(l.role, 'output')
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', links: [{ kind: 'session', id: 'sess-9', role: 'output' }] }, 'model'), /no session sess-9/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', links: [{ kind: 'session', id: 'sess-1', role: 'owner' }] }, 'model'), /role must be/)
  }))

test('touch() fires after the links are added', () =>
  fixture(async ({ rt, snapshots }) => {
    await createArtifactOp(rt, { title: 'x', body: 'y' }, 'model', { sessionId: 'sess-1' })
    const seen = await Promise.all(snapshots)
    assert.ok(seen.length >= 2, 'the index announces the file, then the op announces the links')
    assert.equal(seen[0].length, 0, 'the first announcement predates the link')
    assert.equal(seen[seen.length - 1].length, 1, 'the last one is after it')
  }))

test('update: the model may not rewrite a human artifact, a human may rewrite anything', () =>
  fixture(async ({ rt }) => {
    const note = await createArtifactOp(rt, { title: 'Mine', body: 'my words' }, 'human')
    assert.equal(note.artifact.author, 'human')
    await assert.rejects(updateArtifactOp(rt, note.artifact.id, { body: 'overwritten' }, 'model', { sessionId: 'sess-1' }), /human-authored/)
    const text = await rt.artifacts.readText(note.artifact.id)
    assert.equal(text!.text.trim(), 'my words')
    const edited = await updateArtifactOp(rt, note.artifact.id, { body: 'my new words' }, 'human')
    assert.equal(edited.version, 2)
    const mine = await createArtifactOp(rt, { title: 'Hers', body: 'a', format: 'txt' }, 'model', { sessionId: 'sess-1' })
    assert.equal((await updateArtifactOp(rt, mine.artifact.id, { body: 'b' }, 'model', { sessionId: 'sess-1' })).version, 2)
    await assert.rejects(updateArtifactOp(rt, 'nope', { body: 'b' }, 'model'), /no such artifact/)
    await assert.rejects(updateArtifactOp(rt, mine.artifact.id, {}, 'model'), /nothing to change/)
  }))

test('update: same content is unchanged, a title alone is no new version, another session gets the link', () =>
  fixture(async ({ rt }) => {
    const a = await createArtifactOp(rt, { title: 'Doc', body: '<p>x</p>', format: 'html' }, 'model', { sessionId: 'sess-1' })
    const same = await updateArtifactOp(rt, a.artifact.id, { body: '<p>x</p>', note: 'no real change' }, 'model', { sessionId: 'sess-1' })
    assert.equal(same.action, 'unchanged')
    assert.equal(same.version, 1)
    assert.match(toolResult(same).hint ?? '', /identical content/)
    const title = await updateArtifactOp(rt, a.artifact.id, { title: 'Renamed' }, 'model', { sessionId: 'sess-1' })
    assert.equal(title.action, 'updated')
    assert.equal(title.version, 1)
    assert.match(title.hint ?? '', /no new version/)
    const bumped = await updateArtifactOp(rt, a.artifact.id, { body: '<p>y</p>', note: 'new totals' }, 'model', { sessionId: 'sess-2' })
    assert.equal(bumped.version, 2)
    assert.equal(bumped.hint, undefined)
    const roles = (await rt.store.links.forSource('artifact', a.artifact.id)).map((l) => `${l.toId}:${l.role}`).sort()
    assert.deepEqual(roles, ['sess-1:output', 'sess-2:output'])
    const v = await rt.artifacts.versions(a.artifact.id)
    assert.equal(v!.versions[0].note, 'new totals')
    assert.equal(v!.versions[0].sessionId, 'sess-2')
    await assert.rejects(updateArtifactOp(rt, a.artifact.id, { body: '<p>z</p>' }, 'model', { sessionId: 'ghost' }), /no session ghost/)
  }))

test('create refuses body and from together, a binary format with a body, and from for a human', () =>
  fixture(async ({ rt, project }) => {
    const pdf = path.join(project, 'r.pdf')
    writeFileSync(pdf, PDF)
    const ctx = { sessionId: 'sess-1' }
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', from: pdf }, 'model', ctx), /body or from, not both/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', format: 'pdf' }, 'model', ctx), /pdf files need from: <absolute path>/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', format: 'png' }, 'model', ctx), /png files need from/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', from: pdf }, 'human', ctx), /from: is for files a session made/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: '<p>', format: 'html' }, 'human'), /notes you write are markdown/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', format: 'html' }, 'model'), /pass body/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', format: 'exe' }, 'model'), /format must be/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y', note: 'n'.repeat(501) }, 'model'), /note is too long/)
    await assert.rejects(createArtifactOp(rt, { title: 'x', body: 'y'.repeat(2_000_001) }, 'model'), /2 MB max\) — put the file on disk and pass from:/)
    // a human's blank markdown note is still fine
    const blank = await createArtifactOp(rt, { title: 'Blank' }, 'human')
    assert.equal(blank.artifact.format, 'md')
    assert.equal((await rt.store.artifacts.list()).length, 1)
  }))

test('from: a file in the session folder is copied as a snapshot, format from its extension', () =>
  fixture(async ({ rt, project }) => {
    const pdf = path.join(project, 'out', 'report.pdf')
    mkdirSync(path.dirname(pdf))
    writeFileSync(pdf, PDF)
    const r = await createArtifactOp(rt, { title: 'Report', from: pdf }, 'model', { sessionId: 'sess-1' })
    assert.equal(r.artifact.format, 'pdf')
    assert.equal(r.artifact.size, PDF.length)
    // later edits to the original do not change the artifact
    writeFileSync(pdf, Buffer.concat([PDF, Buffer.from(' edited')]))
    assert.ok((await rt.artifacts.readBytes(r.artifact.id))!.bytes.equals(PDF))
    // an update from a new file is a new version
    const png = path.join(project, 'chart.png')
    writeFileSync(png, PNG)
    const c = await createArtifactOp(rt, { title: 'Chart', from: png, format: 'png' }, 'model', { sessionId: 'sess-1' })
    writeFileSync(png, Buffer.concat([PNG, Buffer.from('2')]))
    const u = await updateArtifactOp(rt, c.artifact.id, { from: png, note: 'redrawn' }, 'model', { sessionId: 'sess-1' })
    assert.equal(u.version, 2)
    assert.equal((await rt.artifacts.readBytes(c.artifact.id, 1))!.bytes.length, PNG.length)
    // the format is the artifact's for life
    await assert.rejects(updateArtifactOp(rt, c.artifact.id, { from: pdf }, 'model', { sessionId: 'sess-1' }), /the file is \.pdf but the format is png/)
  }))

test('from: outside the allowed roots, through a symlink, wrong extension, wrong bytes, a folder: all refused', () =>
  fixture(async ({ rt, dir, project }) => {
    const ctx = { sessionId: 'sess-1' }
    const create = (from: string, format?: string) => createArtifactOp(rt, { title: 'x', from, ...(format ? { format } : {}) }, 'model', ctx)
    // a real file the session has no business reading
    const outside = path.join(process.cwd(), 'package.json')
    await assert.rejects(create(outside), /must be a file in this session's project folder or the temp folder/)
    await assert.rejects(create('/etc/hosts'), /must be a file in this session's project folder or the temp folder/)
    // relative paths and traversal
    await assert.rejects(create('report.pdf'), /absolute path/)
    await assert.rejects(create(path.join(project, '..', '..', '..', '..', 'etc', 'passwd')), /./)
    // a symlink in the project that points out
    const link = path.join(project, 'looks-fine.json')
    symlinkSync(outside, link)
    await assert.rejects(create(link), /must be a file in this session's project folder or the temp folder/)
    // extension vs format vs bytes
    const txt = path.join(project, 'notes.txt')
    writeFileSync(txt, 'plain')
    await assert.rejects(create(txt, 'html'), /the file is \.txt but the format is html/)
    const fake = path.join(project, 'fake.png')
    writeFileSync(fake, 'this is text, not a png')
    await assert.rejects(create(fake), /not a PNG/)
    const bin = path.join(project, 'data.bin')
    writeFileSync(bin, PDF)
    await assert.rejects(create(bin), /not a file type junior publishes/)
    await assert.rejects(create(path.join(project, 'missing.pdf')), /is gone/)
    mkdirSync(path.join(project, 'dir.pdf'))
    await assert.rejects(create(path.join(project, 'dir.pdf')), /a folder, not a file/)
    // the artifacts folder itself is not a source
    const made = await createArtifactOp(rt, { title: 'In store', body: 'x', format: 'txt' }, 'model')
    await assert.rejects(create(path.join(rt.artifacts.root, made.artifact.path)), /inside the artifacts folder/)
    // too big, before it is read
    const big = path.join(project, 'big.txt')
    writeFileSync(big, Buffer.alloc(25 * 1024 * 1024 + 1, 'a'))
    await assert.rejects(create(big), /over the 25 MB limit/)
    // nothing was published by any of them
    assert.equal((await rt.store.artifacts.list()).length, 1)
    void dir
  }))

test('from: without a session only the temp folders are roots (/tmp counts, as models write there)', () =>
  fixture(async ({ rt, project }) => {
    assert.deepEqual(sourceRoots(rt, undefined), tempRoots())
    assert.deepEqual(sourceRoots(rt, 'sess-unknown'), tempRoots())
    const roots = sourceRoots(rt, 'sess-1')
    assert.ok(roots.includes(os.tmpdir()) && roots.includes(project) && roots.includes(rt.attachmentsDir))
    assert.ok(roots.some((r) => r.endsWith(path.join('ws-test', 'browser'))))
    const pdf = path.join(os.tmpdir(), `artifact-ops-${process.pid}.pdf`)
    writeFileSync(pdf, PDF)
    try {
      const r = await createArtifactOp(rt, { title: 'From tmp', from: pdf }, 'model')
      assert.equal(r.artifact.format, 'pdf')
    } finally {
      rmSync(pdf, { force: true })
    }
    // a Mac's os.tmpdir() is /var/folders/…; the plain /tmp scripts and Junior write to must work too
    const viaTmp = path.join('/tmp', `artifact-ops-${process.pid}.pdf`)
    writeFileSync(viaTmp, PDF)
    try {
      assert.equal((await createArtifactOp(rt, { title: 'From /tmp', from: viaTmp }, 'model')).artifact.format, 'pdf')
    } finally {
      rmSync(viaTmp, { force: true })
    }
    await assert.rejects(createArtifactOp(rt, { title: 'x', from: path.join(process.cwd(), 'package.json') }, 'model'), /temp folder/)
  }))

test('the tool result is one line of JSON that parseArtifactResult reads back', () =>
  fixture(async ({ rt }) => {
    const r = await createArtifactOp(rt, { title: 'Table', body: 'a,b\n1,2\n', format: 'csv' }, 'model', { sessionId: 'sess-1' })
    const text = JSON.stringify(toolResult(r))
    assert.equal(text.includes('\n'), false)
    const back = parseArtifactResult(text)
    assert.ok(back)
    assert.equal(back.action, 'created')
    assert.equal(back.id, r.artifact.id)
    assert.equal(back.title, 'Table')
    assert.equal(back.format, 'csv')
    assert.equal(back.version, 1)
    assert.equal(back.size, 8)
    assert.equal(back.history, true)
    assert.equal(back.path, r.artifact.path)
    assert.equal(back.abs, path.join(rt.artifacts.root, ...r.artifact.path.split('/')))
    assert.equal(toolResult(r, 'be careful').hint, 'be careful')
  }))
