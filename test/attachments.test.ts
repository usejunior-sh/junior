/**
 * Attached files (server/attachments.ts): name sanitizing, the upload store and
 * its caps, path traversal, and the validators for a message's `files` and an
 * item save's `files`. Files live in a temp dir — never ~/.triage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import {
  fileIdList,
  handleUpload,
  itemFileEdits,
  pruneUploads,
  readRawBody,
  readUpload,
  resolveUploads,
  sanitizeFileName,
  saveUpload,
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
