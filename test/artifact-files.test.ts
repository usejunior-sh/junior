/**
 * Artifacts as files (server/artifacts.ts): a non-markdown file and its sidecar,
 * an id that survives re-indexing and moves, versions out of the artifacts git
 * repo, the 10 MB and 25 MB rules, and the containment checks. A temp folder
 * and a real git repo, no server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { ArtifactIndex } from '../server/artifacts.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

async function fixture(fn: (f: { dir: string; root: string; idx: ArtifactIndex; store: ReturnType<typeof openSqliteStore>; changes: () => number }) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-files-'))
  const store = openSqliteStore(':memory:')
  let n = 0
  const root = path.join(dir, 'artifacts')
  const idx = new ArtifactIndex(root, store, () => n++)
  try {
    await fn({ dir, root, idx, store, changes: () => n })
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const commits = (root: string) => Number(git(root, 'rev-list', '--count', 'HEAD').trim())
const html = (s: string) => `<html><body>${s}</body></html>`

test('create html: the file and its sidecar, an indexed row at v1', () =>
  fixture(async ({ root, idx }) => {
    const a = await idx.create({ title: 'Q3 report', body: html('one'), author: 'model', format: 'html', refs: ['github:acme/api#4'] })
    assert.equal(a.format, 'html')
    assert.equal(a.version, 1)
    assert.equal(a.history, true)
    assert.match(a.path, /^files\/q3-report-[0-9a-f]{8}\.html$/)
    assert.equal(readFileSync(path.join(root, a.path), 'utf8'), html('one'))
    const side = JSON.parse(readFileSync(path.join(root, a.path + '.artifact.json'), 'utf8'))
    assert.equal(side.id, a.id)
    assert.equal(side.title, 'Q3 report')
    assert.equal(side.author, 'model')
    assert.equal(side.format, 'html')
    assert.deepEqual(side.refs, ['github:acme/api#4'])
    assert.equal(a.size, Buffer.byteLength(html('one')))
    // one commit holds both files
    assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), [a.path, a.path + '.artifact.json'].sort())
  }))

test('the id survives losing the DB row: it is rebuilt from the sidecar', () =>
  fixture(async ({ idx, store }) => {
    const a = await idx.create({ title: 'Table', body: 'a,b\n1,2\n', author: 'model', format: 'csv' })
    await store.artifacts.remove(a.id)
    assert.equal(await store.artifacts.get(a.id), null)
    await idx.refresh(true)
    const back = await store.artifacts.get(a.id)
    assert.ok(back)
    assert.equal(back.title, 'Table')
    assert.equal(back.format, 'csv')
    assert.equal(back.author, 'model')
    assert.equal(back.version, 1)
  }))

test('a non-markdown file without a sidecar is ignored, an orphan sidecar drops its row', () =>
  fixture(async ({ root, idx, store }) => {
    await idx.refresh(true)
    mkdirSync(path.join(root, 'files'), { recursive: true })
    writeFileSync(path.join(root, 'files', 'loose.html'), html('x'))
    await idx.refresh(true)
    assert.equal((await store.artifacts.list()).length, 0)
    const a = await idx.create({ title: 'Gone', body: 'x', author: 'model', format: 'txt' })
    rmSync(path.join(root, a.path))
    await idx.refresh(true)
    assert.equal(await store.artifacts.get(a.id), null)
  }))

test('update: v2, a note and the session in the version list, newest first', () =>
  fixture(async ({ idx }) => {
    const a = await idx.create({ title: 'Report', body: html('one'), author: 'model', format: 'html', session: 'sess-1', note: 'first cut' })
    const { artifact, changed } = await idx.revise(a.id, { body: html('two'), note: 'fixed the totals', session: 'sess-2' })
    assert.equal(changed, true)
    assert.equal(artifact.version, 2)
    const v = await idx.versions(a.id)
    assert.ok(v)
    assert.equal(v.history, true)
    assert.equal(v.current, 2)
    assert.equal(v.capped, false)
    assert.deepEqual(v.versions.map((x) => x.version), [2, 1])
    assert.deepEqual(v.versions.map((x) => x.current), [true, false])
    assert.equal(v.versions[0].note, 'fixed the totals')
    assert.equal(v.versions[0].sessionId, 'sess-2')
    assert.equal(v.versions[1].note, 'first cut')
    assert.equal(v.versions[1].sessionId, 'sess-1')
    assert.equal(v.versions[0].path, a.path)
    assert.ok(v.versions[0].at >= v.versions[1].at)
    assert.match(v.versions[0].sha, /^[0-9a-f]{40}$/)
  }))

test('a note cannot pose as a trailer', () =>
  fixture(async ({ idx }) => {
    const a = await idx.create({ title: 'N', body: 'x', author: 'model', format: 'txt', session: 'real' })
    await idx.revise(a.id, { body: 'y', note: 'Triage-Session: fake\n\nTriage-Session: fake2', session: 'real' })
    const v = await idx.versions(a.id)
    assert.equal(v!.versions[0].sessionId, 'real')
    assert.equal(v!.versions[0].note, 'Triage-Session: fake Triage-Session: fake2')
  }))

test('readBytes: the original bytes of v1, the current ones without a version', () =>
  fixture(async ({ idx }) => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('first')])
    const png2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('second')])
    const a = await idx.create({ title: 'Chart', body: '', bytes: png, author: 'model', format: 'png' })
    await idx.revise(a.id, { bytes: png2 })
    const v1 = await idx.readBytes(a.id, 1)
    assert.ok(v1)
    assert.ok(v1.bytes.equals(png))
    assert.equal(v1.latest, false)
    assert.equal(v1.version, 1)
    const cur = await idx.readBytes(a.id)
    assert.ok(cur!.bytes.equals(png2))
    assert.equal(cur!.latest, true)
    assert.equal(cur!.version, 2)
    assert.ok((await idx.readBytes(a.id, 2))!.bytes.equals(png2))
    await assert.rejects(idx.readBytes(a.id, 3), /no such version/)
    await assert.rejects(idx.readBytes(a.id, 0), /no such version/)
    assert.equal(await idx.readBytes('nope'), null)
  }))

test('readText: md loses its frontmatter, binary formats come back empty, old versions read', () =>
  fixture(async ({ idx }) => {
    const m = await idx.create({ title: 'Note', body: '# one\n', author: 'model' })
    await idx.revise(m.id, { body: '# two\n' })
    const now = await idx.readText(m.id)
    assert.equal(now!.text.trim(), '# two')
    assert.equal((await idx.readText(m.id, 1))!.text.trim(), '# one')
    assert.equal((await idx.readText(m.id, 1))!.latest, false)
    const pdf = await idx.create({ title: 'Doc', body: '', bytes: Buffer.from('%PDF-1.4\n...'), author: 'model', format: 'pdf' })
    const t = await idx.readText(pdf.id)
    assert.equal(t!.binary, true)
    assert.equal(t!.text, '')
  }))

test('identical bytes on a non-markdown update: changed false, no file written, no commit', () =>
  fixture(async ({ root, idx }) => {
    const a = await idx.create({ title: 'Same', body: html('x'), author: 'model', format: 'html' })
    const before = commits(root)
    const mtime = readFileSync(path.join(root, a.path + '.artifact.json'), 'utf8')
    const r = await idx.revise(a.id, { body: html('x'), title: 'Same' })
    assert.equal(r.changed, false)
    assert.equal(r.artifact.version, 1)
    assert.equal(commits(root), before)
    assert.equal(readFileSync(path.join(root, a.path + '.artifact.json'), 'utf8'), mtime)
  }))

test('a title-only update on a non-markdown file makes no new version', () =>
  fixture(async ({ root, idx }) => {
    const a = await idx.create({ title: 'Old title', body: html('x'), author: 'model', format: 'html' })
    const before = commits(root)
    const r = await idx.revise(a.id, { title: 'New title' })
    assert.equal(r.changed, true)
    assert.equal(r.artifact.title, 'New title')
    assert.equal(r.artifact.version, 1)
    assert.equal(commits(root), before + 1) // the sidecar is committed
    assert.equal((await idx.versions(a.id))!.versions.length, 1)
    // a content change after it is v2
    assert.equal((await idx.revise(a.id, { body: html('y') })).artifact.version, 2)
  }))

test('a markdown title change is a version, since the frontmatter is the file', () =>
  fixture(async ({ idx }) => {
    const a = await idx.create({ title: 'One', body: 'text', author: 'model' })
    assert.equal((await idx.revise(a.id, { title: 'Two' })).artifact.version, 2)
  }))

test('the format cannot change, and bytes of another format are refused', () =>
  fixture(async ({ idx }) => {
    const a = await idx.create({ title: 'T', body: 'a,b', author: 'model', format: 'csv' })
    await assert.rejects(idx.revise(a.id, { format: 'html', body: html('x') }), /format cannot change/)
    const png = await idx.create({ title: 'P', body: '', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), author: 'model', format: 'png' })
    await assert.rejects(idx.revise(png.id, { bytes: Buffer.from('%PDF-1.4') }), /not a PNG/)
    await assert.rejects(idx.create({ title: 'J', body: '{nope', author: 'model', format: 'json' }), /not valid JSON/)
    await assert.rejects(idx.create({ title: 'S', body: 'hi', author: 'model', format: 'svg' }), /no <svg>/)
  }))

test('over 10 MB: stored without history and kept out of git; over 25 MB: refused', { timeout: 120_000 }, () =>
  fixture(async ({ root, idx }) => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 'a')
    const a = await idx.create({ title: 'Big log', body: '', bytes: big, author: 'model', format: 'txt' })
    assert.equal(a.history, false)
    assert.equal(a.version, 1)
    assert.equal(git(root, 'ls-files').split('\n').includes(a.path), false)
    assert.ok(git(root, 'ls-files').includes(a.path + '.artifact.json'))
    assert.ok(readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes(`/${a.path}`))
    // a new version of it is counted here, not in git
    const b = Buffer.alloc(10 * 1024 * 1024 + 2, 'b')
    const r = await idx.revise(a.id, { bytes: b })
    assert.equal(r.artifact.history, false)
    assert.equal(r.artifact.version, 2)
    const v = await idx.versions(a.id)
    assert.equal(v!.history, false)
    assert.equal(v!.current, 2)
    assert.equal(v!.versions.length, 1)
    assert.equal(v!.versions[0].current, true)
    await assert.rejects(idx.readBytes(a.id, 1), /no history kept for this file/)
    assert.equal((await idx.readBytes(a.id))!.bytes.length, b.length)
    // shrinking it under the limit puts it back in history
    const s = await idx.revise(a.id, { bytes: Buffer.from('small') })
    assert.equal(s.artifact.history, true)
    assert.equal(git(root, 'ls-files').split('\n').includes(a.path), true)
    assert.equal(readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').includes(`/${a.path}`), false)

    const huge = Buffer.alloc(25 * 1024 * 1024 + 1, 'a')
    await assert.rejects(idx.create({ title: 'Huge', body: '', bytes: huge, author: 'model', format: 'txt' }), /25\.1 MB is over the 25 MB limit for an artifact/)
    await assert.rejects(idx.revise(a.id, { bytes: huge }), /over the 25 MB limit/)
    assert.equal((await idx.versions(a.id))!.versions[0].version, 3)
  }))

test('git mv of the file and its sidecar: the id and the links stay, versions follow the rename', () =>
  fixture(async ({ root, idx, store }) => {
    const a = await idx.create({ title: 'Moves', body: html('x'), author: 'model', format: 'html' })
    await idx.revise(a.id, { body: html('y') })
    await store.links.add({ fromKind: 'artifact', fromId: a.id, toKind: 'session', toId: 's1', role: 'output' })
    mkdirSync(path.join(root, 'files', 'archive'), { recursive: true })
    const to = a.path.replace('files/', 'files/archive/')
    git(root, 'mv', a.path, to)
    git(root, 'mv', a.path + '.artifact.json', to + '.artifact.json')
    git(root, 'commit', '-q', '-m', 'move it')
    await idx.refresh(true)
    const moved = await store.artifacts.get(a.id)
    assert.ok(moved, 'the row survives the move')
    assert.equal(moved.path, to)
    assert.equal(moved.title, 'Moves')
    assert.equal((await store.links.forSource('artifact', a.id)).length, 1, 'the link survives the move')
    assert.equal((await store.artifacts.list()).length, 1)
    const v = await idx.versions(a.id)
    assert.deepEqual(v!.versions.map((x) => x.version), [3, 2, 1])
    assert.equal(v!.versions[0].path, to)
    assert.equal(v!.versions[2].path, a.path)
    // the original bytes come out of git by their old path
    assert.equal((await idx.readBytes(a.id, 1))!.bytes.toString('utf8'), html('x'))
  }))

test('a new artifact with the same bytes as another does not inherit its history', () =>
  fixture(async ({ idx }) => {
    const csv = 'a,b\n1,2\n3,4\n'
    const first = await idx.create({ title: 'One', body: csv, author: 'model', format: 'csv', session: 's1' })
    await idx.revise(first.id, { body: csv + '5,6\n' })
    const json = '{"a":1,"b":[1,2,3,4,5,6,7,8]}'
    const j1 = await idx.create({ title: 'J1', body: json, author: 'model', format: 'json' })
    const j2 = await idx.create({ title: 'J2', body: json, author: 'model', format: 'json', session: 's2' })
    assert.equal(j2.version, 1)
    const v = await idx.versions(j2.id)
    assert.deepEqual(v!.versions.map((x) => x.version), [1])
    assert.equal(v!.versions[0].path, j2.path)
    assert.equal((await idx.versions(j1.id))!.versions.length, 1)
    // the same text as another csv, and a note sharing a long body
    const c2 = await idx.create({ title: 'Two', body: csv + '5,6\n', author: 'model', format: 'csv' })
    assert.equal(c2.version, 1)
    assert.equal((await idx.versions(c2.id))!.versions.length, 1)
    await assert.rejects(idx.readBytes(c2.id, 2), /no such version/)
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    await idx.create({ title: 'M1', body, author: 'model' })
    const m2 = await idx.create({ title: 'M2', body, author: 'model' })
    assert.equal(m2.version, 1)
    assert.equal((await idx.versions(m2.id))!.versions.length, 1)
  }))

test('a hand-deleted file and a new one with the same bytes are not one history', () =>
  fixture(async ({ root, idx }) => {
    const a = await idx.create({ title: 'Old', body: html('same'), author: 'model', format: 'html' })
    rmSync(path.join(root, a.path))
    rmSync(path.join(root, a.path + '.artifact.json'))
    const b = await idx.create({ title: 'New', body: html('same'), author: 'model', format: 'html' })
    assert.equal(b.version, 1)
    assert.equal((await idx.versions(b.id))!.versions.length, 1)
  }))

test('a file moved by hand and rewritten at once keeps every version', () =>
  fixture(async ({ root, idx, store }) => {
    const a = await idx.create({ title: 'Moved', body: '# one\n\nfirst text\n', author: 'model' })
    await idx.revise(a.id, { body: '# two\n\nsecond text\n' })
    const f = await idx.create({ title: 'File', body: html('alpha alpha alpha'), author: 'model', format: 'html' })
    mkdirSync(path.join(root, 'notes', 'old'), { recursive: true })
    mkdirSync(path.join(root, 'files', 'old'), { recursive: true })
    const to = a.path.replace('notes/', 'notes/old/')
    const fto = f.path.replace('files/', 'files/old/')
    // a plain mv: nothing is committed
    renameSync(path.join(root, a.path), path.join(root, to))
    renameSync(path.join(root, f.path), path.join(root, fto))
    renameSync(path.join(root, f.path + '.artifact.json'), path.join(root, fto + '.artifact.json'))
    await idx.refresh(true)
    assert.equal((await store.artifacts.get(a.id))!.path, to)
    // and the next write changes everything about the files
    const r = await idx.revise(a.id, { body: 'nothing in common with the old text, not a single line\nzzz\nyyy\n' })
    // the move is committed alone first (v3, as a move committed by hand is), then the rewrite
    assert.equal(r.artifact.version, 4)
    const v = await idx.versions(a.id)
    assert.deepEqual(v!.versions.map((x) => x.version), [4, 3, 2, 1])
    assert.match((await idx.readBytes(a.id, 1))!.bytes.toString('utf8'), /first text/)
    assert.match((await idx.readBytes(a.id, 2))!.bytes.toString('utf8'), /second text/)
    const rf = await idx.revise(f.id, { body: html('x'.repeat(200)) })
    assert.equal(rf.artifact.version, 3)
    assert.equal((await idx.readBytes(f.id, 1))!.bytes.toString('utf8'), html('alpha alpha alpha'))
    assert.equal(git(root, 'status', '--porcelain').trim(), '')
  }))

test('a human edit made outside triage is its own version, not folded into the next one', () =>
  fixture(async ({ root, idx }) => {
    const a = await idx.create({ title: 'Hand', body: 'one', author: 'model' })
    writeFileSync(path.join(root, a.path), readFileSync(path.join(root, a.path), 'utf8').replace('one', 'edited by hand'))
    const r = await idx.revise(a.id, { body: 'three' })
    assert.equal(r.artifact.version, 3)
    const v = await idx.versions(a.id)
    assert.deepEqual(v!.versions.map((x) => x.version), [3, 2, 1])
    assert.match((await idx.readBytes(a.id, 2))!.bytes.toString('utf8'), /edited by hand/)
    assert.match((await idx.readBytes(a.id, 1))!.bytes.toString('utf8'), /one/)
  }))

test('version numbers stay with their commits after a spell over 10 MB', { timeout: 120_000 }, () =>
  fixture(async ({ idx }) => {
    const a = await idx.create({ title: 'Log', body: 'one', author: 'model', format: 'txt' })
    await idx.revise(a.id, { body: 'two' })
    const big = await idx.revise(a.id, { bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 'z') })
    assert.equal(big.artifact.version, 3)
    const four = await idx.revise(a.id, { body: 'four' })
    assert.equal(four.artifact.version, 4)
    assert.equal(four.artifact.history, true)
    const v = await idx.versions(a.id)
    assert.deepEqual(v!.versions.map((x) => x.version), [4, 2, 1])
    assert.equal((await idx.readBytes(a.id, 1))!.bytes.toString('utf8'), 'one')
    assert.equal((await idx.readBytes(a.id, 2))!.bytes.toString('utf8'), 'two')
    assert.equal((await idx.readBytes(a.id, 4))!.bytes.toString('utf8'), 'four')
    await assert.rejects(idx.readBytes(a.id, 3), /no such version/)
  }))

test('moving a markdown note keeps its row and links too', () =>
  fixture(async ({ root, idx, store }) => {
    const a = await idx.create({ title: 'Note', body: 'text', author: 'human' })
    await store.links.add({ fromKind: 'artifact', fromId: a.id, toKind: 'item', toId: 'manual:1', role: 'context' })
    mkdirSync(path.join(root, 'notes', 'old'), { recursive: true })
    const to = a.path.replace('notes/', 'notes/old/')
    git(root, 'mv', a.path, to)
    git(root, 'commit', '-q', '-m', 'move')
    await idx.refresh(true)
    assert.equal((await store.artifacts.get(a.id))!.path, to)
    assert.equal((await store.links.forSource('artifact', a.id)).length, 1)
  }))

test('a copied file and sidecar get a fresh id, the original keeps its own', () =>
  fixture(async ({ root, idx, store }) => {
    const a = await idx.create({ title: 'Orig', body: html('x'), author: 'model', format: 'html' })
    const copy = a.path.replace('.html', '-copy.html')
    writeFileSync(path.join(root, copy), html('x'))
    writeFileSync(path.join(root, copy + '.artifact.json'), readFileSync(path.join(root, a.path + '.artifact.json')))
    await idx.refresh(true)
    const rows = await store.artifacts.list()
    assert.equal(rows.length, 2)
    assert.equal((await store.artifacts.get(a.id))!.path, a.path)
    const other = rows.find((r) => r.id !== a.id)!
    assert.equal(other.path, copy)
    assert.equal(JSON.parse(readFileSync(path.join(root, copy + '.artifact.json'), 'utf8')).id, other.id)
  }))

test('a sidecar that does not parse gives a row with a warning, never a crash', () =>
  fixture(async ({ root, idx, store }) => {
    mkdirSync(path.join(root, 'files'), { recursive: true })
    writeFileSync(path.join(root, 'files', 'x.csv'), 'a,b')
    writeFileSync(path.join(root, 'files', 'x.csv.artifact.json'), '{nope')
    await idx.refresh(true)
    const [row] = await store.artifacts.list()
    assert.equal(row.title, 'x')
    assert.equal(row.author, 'human')
    assert.match(row.warning ?? '', /did not parse/)
  }))

test('existing markdown rows get a real version from git on the first refresh', () =>
  fixture(async ({ root, idx, store }) => {
    const a = await idx.create({ title: 'Old', body: 'one', author: 'model' })
    await idx.revise(a.id, { body: 'two' })
    await idx.revise(a.id, { body: 'three' })
    // as a row from before versions existed: v1
    await store.artifacts.upsert({ ...(await store.artifacts.get(a.id))!, version: 1 })
    const fresh = new ArtifactIndex(root, store, () => {})
    await fresh.refresh(true)
    assert.equal((await store.artifacts.get(a.id))!.version, 3)
  }))

test('rel and abs refuse .., .git, hidden segments, odd types and a symlink escape', () =>
  fixture(async ({ dir, root, idx }) => {
    await idx.ensure()
    const p = idx as unknown as { rel(p: string): string; abs(p: string): Promise<string> }
    assert.equal(p.rel('files/a.html'), 'files/a.html')
    assert.equal(p.rel('files/a.html.artifact.json'), 'files/a.html.artifact.json')
    assert.equal(p.rel('notes/a.md'), 'notes/a.md')
    for (const bad of ['../a.md', 'notes/../../a.md', 'notes//a.md', '.git/config', '.git/a.md', 'notes/.hidden/a.md', 'notes/.a.md', 'files/a.exe', 'files/a', 'files/.artifact.json', 'a\0.md', '']) {
      assert.throws(() => p.rel(bad), /invalid artifact path|not an artifact file type/, `rel(${JSON.stringify(bad)})`)
    }
    const outside = path.join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.html'), 'secret')
    symlinkSync(outside, path.join(root, 'files'))
    await assert.rejects(p.abs('files/new.html'), /outside the artifacts folder/)
    await assert.rejects(p.abs('files/secret.html'), /outside the artifacts folder/)
    mkdirSync(path.join(root, 'notes'), { recursive: true })
    symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'notes', 'link.html'))
    await assert.rejects(p.abs('notes/link.html'), /outside the artifacts folder/)
    assert.equal(await p.abs('notes/ok.md'), path.join(root, 'notes', 'ok.md'))
  }))

test('a symlink inside the folder is neither listed nor followed', () =>
  fixture(async ({ dir, root, idx, store }) => {
    await idx.ensure()
    const outside = path.join(dir, 'outside.md')
    writeFileSync(outside, '# secret')
    mkdirSync(path.join(root, 'notes'), { recursive: true })
    symlinkSync(outside, path.join(root, 'notes', 'leak.md'))
    await idx.refresh(true)
    assert.equal((await store.artifacts.list()).length, 0)
  }))

test('two commits issued at once both land', () =>
  fixture(async ({ root, idx }) => {
    await idx.ensure()
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, i) => idx.create({ title: `Doc ${i}`, body: html(String(i)), author: 'model', format: 'html', session: `s${i}` })),
    )
    assert.deepEqual(made.map((m) => m.version), [1, 1, 1, 1, 1, 1])
    assert.equal(commits(root), 6)
    assert.equal(git(root, 'status', '--porcelain').trim(), '')
    // and concurrent updates of one artifact each make their own version
    const a = made[0]
    const rs = await Promise.all([1, 2, 3].map((i) => idx.revise(a.id, { body: html(`v${i}`), note: `edit ${i}` })))
    assert.deepEqual(rs.map((r) => r.artifact.version).sort(), [2, 3, 4])
    assert.equal((await idx.versions(a.id))!.versions.length, 4)
    assert.equal(commits(root), 9)
    // an unrelated artifact's history is not inflated by the commits around it
    assert.equal((await idx.versions(made[1].id))!.versions.length, 1)
  }))

test('remove deletes the file, its sidecar, the row and the links', () =>
  fixture(async ({ root, idx, store }) => {
    const a = await idx.create({ title: 'Bye', body: html('x'), author: 'model', format: 'html' })
    await store.links.add({ fromKind: 'artifact', fromId: a.id, toKind: 'session', toId: 's1', role: 'output' })
    await idx.remove(a.id)
    assert.equal(existsSync(path.join(root, a.path)), false)
    assert.equal(existsSync(path.join(root, a.path + '.artifact.json')), false)
    assert.equal(await store.artifacts.get(a.id), null)
    assert.equal((await store.links.forSource('artifact', a.id)).length, 0)
    assert.equal(git(root, 'status', '--porcelain').trim(), '')
  }))

test('touch() tells the clients; a write announces itself too', () =>
  fixture(async ({ idx, changes }) => {
    const before = changes()
    idx.touch()
    assert.equal(changes(), before + 1)
    await idx.create({ title: 'x', body: 'y', author: 'model' })
    assert.ok(changes() > before + 1)
  }))

test('a DB from before formats gains the columns, and its rows read back as md v1', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-schema-'))
  const file = path.join(dir, 'triage.db')
  try {
    await openSqliteStore(file).close()
    const db = new DatabaseSync(file)
    db.exec('DROP INDEX idx_artifacts_format; ALTER TABLE artifacts DROP COLUMN format; ALTER TABLE artifacts DROP COLUMN version; ALTER TABLE artifacts DROP COLUMN history')
    db.prepare(`INSERT INTO artifacts (id, path, title, author, refs, created, updated, mtime, size, indexed_at) VALUES ('old', 'notes/old.md', 'Old', 'human', '[]', 1, 1, 1, 1, 1)`).run()
    db.close()
    const store = openSqliteStore(file)
    const row = await store.artifacts.get('old')
    assert.equal(row?.format, 'md')
    assert.equal(row?.version, 1)
    assert.equal(row?.history, true)
    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
