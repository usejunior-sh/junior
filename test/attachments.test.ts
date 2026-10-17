/**
 * Attached files (server/attachments.ts): name sanitizing, the upload store and
 * its caps, path traversal, and the validators for a message's `files` and an
 * item save's `files`. Files live in a temp dir — never ~/.triage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { openSqliteStore } from '../core/store/sqlite.js'
import {
  applyItemFileEdits,
  attachedFilesNote,
  claimSessionFiles,
  copyItemFilesToSession,
  missingFilesNote,
  fileIdList,
  handleUpload,
  itemFileEdits,
  itemFilePath,
  itemFilesDir,
  pruneUploads,
  readItemFile,
  readRawBody,
  readUpload,
  removeSessionFiles,
  resolveUploads,
  sanitizeFileName,
  saveUpload,
  sessionFilePath,
  sessionFilesDir,
  uploadsDir,
} from '../server/attachments.js'
import { MAX_FILE_BYTES, MAX_FILES_PER_ITEM, MAX_FILES_PER_MESSAGE } from '../shared/protocol.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'triage-attach-'))
const reqOf = (body: Buffer, headers: Record<string, string> = {}) =>
  Object.assign(Readable.from([body]), { headers }) as unknown as http.IncomingMessage
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

test('sanitizeFileName drops directories, control characters and leading dots', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('C:\\Users\\me\\report.pdf'), 'report.pdf')
  assert.equal(sanitizeFileName('/abs/path/data.csv'), 'data.csv')
  assert.equal(sanitizeFileName('.bashrc'), 'bashrc')
  assert.equal(sanitizeFileName('a\u0000b\nc.txt'), 'abc.txt')
  assert.equal(sanitizeFileName('we?ird*"na<me>|.pdf'), 'weirdname.pdf')
  assert.equal(sanitizeFileName('  spaced   out.md  '), 'spaced out.md')
})

test('sanitizeFileName never returns an empty name or a dot name', () => {
  for (const bad of ['', '   ', '..', '.', '/', '\\', '...', undefined, null, 42]) {
    assert.equal(sanitizeFileName(bad), 'file')
  }
})

test('sanitizeFileName caps the length and keeps the extension', () => {
  const out = sanitizeFileName(`${'a'.repeat(300)}.pdf`)
  assert.equal(out.length, 120)
  assert.ok(out.endsWith('.pdf'))
})

test('an upload lands at uploads/<uuid>/<sanitized name> and reads back', async () => {
  const root = tmp()
  try {
    const ref = await saveUpload(root, '../../evil/Q3 report.pdf', Buffer.from('%PDF-1.4'))
    assert.equal(ref.name, 'Q3 report.pdf')
    assert.equal(ref.bytes, 8)
    assert.ok(existsSync(path.join(uploadsDir(root), ref.id, 'Q3 report.pdf')))
    assert.deepEqual(await readUpload(root, ref.id), ref)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('size cap: a body over 20 MB is refused, exactly 20 MB is kept, empty is refused', async () => {
  const root = tmp()
  try {
    await assert.rejects(saveUpload(root, 'big.bin', Buffer.alloc(MAX_FILE_BYTES + 1)), /under 20MB/)
    const ok = await saveUpload(root, 'edge.bin', Buffer.alloc(MAX_FILE_BYTES))
    assert.equal(ok.bytes, MAX_FILE_BYTES)
    await assert.rejects(saveUpload(root, 'none.txt', Buffer.alloc(0)), /empty/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('size cap: the request is refused by its declared length, and by the running total', async () => {
  await assert.rejects(readRawBody(reqOf(Buffer.from('x'), { 'content-length': String(MAX_FILE_BYTES + 1) })), /under 20MB/)
  await assert.rejects(readRawBody(reqOf(Buffer.alloc(11)), 10), /under \d+MB/)
  assert.equal((await readRawBody(reqOf(Buffer.alloc(10)), 10)).length, 10)
})

test('handleUpload stores the request body under ?name=', async () => {
  const root = tmp()
  try {
    const ref = await handleUpload(root, reqOf(Buffer.from('a,b\n1,2\n')), 'data.csv')
    assert.equal(ref.name, 'data.csv')
    assert.equal(ref.bytes, 8)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uploads older than 24 h are pruned, newer ones stay', async () => {
  const root = tmp()
  try {
    const oldRef = await saveUpload(root, 'old.txt', Buffer.from('o'))
    const newRef = await saveUpload(root, 'new.txt', Buffer.from('n'))
    const dayAndHour = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(path.join(uploadsDir(root), oldRef.id), dayAndHour, dayAndHour)
    assert.equal(await pruneUploads(root), 1)
    assert.equal(await readUpload(root, oldRef.id), null)
    assert.deepEqual(await readUpload(root, newRef.id), newRef)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruning with no uploads folder is a no-op', async () => {
  const root = tmp()
  try {
    assert.equal(await pruneUploads(root), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('path traversal: ids that are not uuids never reach the filesystem', async () => {
  const root = tmp()
  try {
    for (const evil of ['..', '../x', '../../etc', '/etc/passwd', 'a/b', '.', '']) {
      assert.equal(await readUpload(root, evil), null)
      assert.throws(() => fileIdList([evil], 5), /upload id/)
    }
    await assert.rejects(resolveUploads(root, ['../..'], 5), /upload id/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('count cap: more than 5 files per message or per item is refused', async () => {
  const root = tmp()
  try {
    const refs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => saveUpload(root, `f${i}.txt`, Buffer.from('x'))))
    const ids = refs.map((r) => r.id)
    assert.equal((await resolveUploads(root, ids.slice(0, MAX_FILES_PER_MESSAGE), MAX_FILES_PER_MESSAGE)).length, 5)
    await assert.rejects(resolveUploads(root, ids, MAX_FILES_PER_MESSAGE), /up to 5 files/)
    await assert.rejects(itemFileEdits(root, { files: ids }, [], MAX_FILES_PER_ITEM), /up to 5 files/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unknown and duplicate ids are refused, not dropped', async () => {
  const root = tmp()
  try {
    const a = await saveUpload(root, 'a.txt', Buffer.from('a'))
    await assert.rejects(resolveUploads(root, [UNKNOWN], 5), /no longer available/)
    await assert.rejects(resolveUploads(root, [a.id, UNKNOWN], 5), /no longer available/)
    await assert.rejects(resolveUploads(root, [a.id, a.id], 5), /listed twice/)
    assert.throws(() => fileIdList('nope', 5), /must be a list/)
    assert.throws(() => fileIdList([{ id: a.id }], 5), /upload id/)
    assert.deepEqual(await resolveUploads(root, undefined, 5), [])
    assert.deepEqual(await resolveUploads(root, [a.id], 5), [a])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('item file edits: absent = untouched, held ids are kept, upload ids are claimed', async () => {
  const root = tmp()
  try {
    const held = { id: '11111111-1111-4111-8111-111111111111', name: 'kept.pdf', bytes: 3 }
    const up = await saveUpload(root, 'new.csv', Buffer.from('1,2'))
    assert.equal(await itemFileEdits(root, {}, [held], 5), undefined)
    assert.equal(await itemFileEdits(root, { files: null }, [held], 5), undefined)
    assert.deepEqual(await itemFileEdits(root, { files: [] }, [held], 5), { kept: [], fresh: [], order: [] })
    const edit = await itemFileEdits(root, { files: [up.id, held.id] }, [held], 5)
    assert.deepEqual(edit, { kept: [held], fresh: [up], order: [up.id, held.id] })
    await assert.rejects(itemFileEdits(root, { files: [UNKNOWN] }, [held], 5), /no longer available/)
    await assert.rejects(itemFileEdits(root, { files: [held.id, held.id] }, [held], 5), /listed twice/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('claiming moves uploads into the session folder and the note names the real path', async () => {
  const root = tmp()
  try {
    const up = await saveUpload(root, 'sales.csv', Buffer.from('a,b\n1,2\n'))
    const [ref] = await claimSessionFiles(root, 'sess-1', [up.id], 5)
    assert.deepEqual(ref, up)
    assert.ok(!existsSync(path.join(uploadsDir(root), up.id)), 'no longer pending')
    const file = sessionFilePath(root, 'sess-1', ref)
    assert.equal(file, path.join(root, 'sessions', 'sess-1', up.id, 'sales.csv'))
    assert.equal(readFileSync(file, 'utf8'), 'a,b\n1,2\n')
    const note = attachedFilesNote(root, 'sess-1', [ref])
    assert.ok(note?.includes(file), 'the model is given an absolute path')
    assert.equal(attachedFilesNote(root, 'sess-1', []), null)
    // the event log's shape: id, name, bytes — nothing else
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(ref))).sort(), ['bytes', 'id', 'name'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('claiming checks every id first: one unknown upload leaves the others pending', async () => {
  const root = tmp()
  try {
    const up = await saveUpload(root, 'a.txt', Buffer.from('x'))
    await assert.rejects(claimSessionFiles(root, 's', [up.id, UNKNOWN], 5), /no longer available/)
    assert.ok(existsSync(path.join(uploadsDir(root), up.id)))
    assert.ok(!existsSync(sessionFilesDir(root, 's')))
    assert.deepEqual(await claimSessionFiles(root, 's', [], 5), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removing a session deletes its files folder and nothing else', async () => {
  const root = tmp()
  try {
    const a = await saveUpload(root, 'a.pdf', Buffer.from('x'))
    const b = await saveUpload(root, 'b.pdf', Buffer.from('y'))
    await claimSessionFiles(root, 's1', [a.id], 5)
    await claimSessionFiles(root, 's2', [b.id], 5)
    await removeSessionFiles(root, 's1')
    assert.ok(!existsSync(sessionFilesDir(root, 's1')))
    assert.ok(existsSync(sessionFilesDir(root, 's2')))
    await removeSessionFiles(root, 'never-had-files') // a no-op, not an error
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a session id cannot climb out of the sessions folder', () => {
  const dir = sessionFilesDir('/ws/attachments', '../../etc')
  assert.ok(dir.startsWith(path.join('/ws/attachments', 'sessions') + path.sep))
})

test('an item save keeps, adds and removes files, in the order given', async () => {
  const root = tmp()
  const item = 'manual:abc-123'
  try {
    // add two
    const a = await saveUpload(root, 'a.csv', Buffer.from('a'))
    const b = await saveUpload(root, 'b.pdf', Buffer.from('bb'))
    let edits = (await itemFileEdits(root, { files: [a.id, b.id] }, [], 5))!
    let held = await applyItemFileEdits(root, item, [], edits)
    assert.deepEqual(held, [a, b])
    assert.equal(readFileSync(itemFilePath(root, item, a), 'utf8'), 'a')
    assert.ok(!existsSync(path.join(uploadsDir(root), a.id)), 'claimed, no longer pending')
    assert.equal((await readItemFile(root, item, b)).toString(), 'bb')

    // keep b, drop a, add c — and reorder
    const c = await saveUpload(root, 'c.txt', Buffer.from('ccc'))
    edits = (await itemFileEdits(root, { files: [c.id, b.id] }, held, 5))!
    held = await applyItemFileEdits(root, item, held, edits)
    assert.deepEqual(held, [c, b])
    assert.ok(!existsSync(path.join(itemFilesDir(root, item), a.id)), 'the dropped file is deleted with its folder')
    assert.ok(existsSync(itemFilePath(root, item, b)))

    // absent key = untouched; [] clears
    assert.equal(await itemFileEdits(root, {}, held, 5), undefined)
    edits = (await itemFileEdits(root, { files: [] }, held, 5))!
    assert.deepEqual(await applyItemFileEdits(root, item, held, edits), [])
    assert.ok(!existsSync(itemFilePath(root, item, c)) && !existsSync(itemFilePath(root, item, b)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('copying an item\'s files gives the session its own copy under fresh ids', async () => {
  const root = tmp()
  const item = 'github:acme/api#7'
  try {
    const up = await saveUpload(root, 'spec.pdf', Buffer.from('pdf-bytes'))
    const held = await applyItemFileEdits(root, item, [], (await itemFileEdits(root, { files: [up.id] }, [], 5))!)
    const { files: copies, missing: none } = await copyItemFilesToSession(root, 'sess-9', item, held)
    assert.deepEqual(none, [])
    assert.equal(copies.length, 1)
    assert.notEqual(copies[0].id, up.id)
    assert.equal(copies[0].name, 'spec.pdf')
    assert.equal(readFileSync(sessionFilePath(root, 'sess-9', copies[0]), 'utf8'), 'pdf-bytes')
    // deleting the session leaves the item's file alone
    await removeSessionFiles(root, 'sess-9')
    assert.ok(existsSync(itemFilePath(root, item, held[0])))
    // a file that went missing is skipped, not fatal; no item files = nothing
    const gone = { id: UNKNOWN, name: 'gone.txt', bytes: 1 }
    assert.deepEqual(await copyItemFilesToSession(root, 'sess-9', item, [gone]), { files: [], missing: [gone] })
    assert.match(missingFilesNote([gone]) ?? '', /could not be attached.*gone\.txt/)
    assert.equal(missingFilesNote([]), null)
    assert.ok(!existsSync(sessionFilesDir(root, 'sess-9')) || !existsSync(path.join(sessionFilesDir(root, 'sess-9'), UNKNOWN)))
    assert.deepEqual(await copyItemFilesToSession(root, 'sess-9', item, undefined), { files: [], missing: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('create_session checks its uploads before it makes a worktree or a session', async () => {
  const root = tmp()
  try {
    // The check itself: a stale id refuses, and nothing is moved or made.
    await assert.rejects(resolveUploads(root, [UNKNOWN], MAX_FILES_PER_MESSAGE), /no longer available/)
    assert.ok(!existsSync(path.join(root, 'sessions')))
    // The order: index.ts is not importable (it boots the daemon), so pin where the check sits in the case.
    const src = readFileSync(path.join(import.meta.dirname, '..', 'server', 'index.ts'), 'utf8')
    const body = src.slice(src.indexOf("case 'create_session': {\n          if (msg.provider"))
    const check = body.indexOf('resolveUploads(rt.attachmentsDir, msg.files')
    assert.ok(check > 0)
    for (const makes of ['makeWorktree(rt,', 'await createSession(']) assert.ok(check < body.indexOf(makes), `resolveUploads must come before ${makes}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the store records an item\'s file refs and clears them', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-attach-store-'))
  const store = openSqliteStore(path.join(dir, 'triage.db'))
  try {
    const id = 'manual:11111111-1111-4111-8111-111111111111'
    await store.items.createManual({ id, title: 'with a file' })
    const refs = [{ id: UNKNOWN, name: 'a.csv', bytes: 3 }]
    await store.items.setFiles(id, refs)
    assert.deepEqual((await store.items.get(id))?.files, refs)
    await store.items.setFiles(id, [])
    assert.equal((await store.items.get(id))?.files, undefined)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
