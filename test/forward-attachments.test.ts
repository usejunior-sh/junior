/**
 * Files one chat hands another (start_session / message_session
 * `attachments`, server/attachments.ts readForwarded): images the API takes
 * ride inline, anything else is copied into the thread's own folder, and a bad
 * path sends nothing. Files live in a temp dir, never ~/.junior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachedFilesNote, copyForwardedFiles, MAX_FORWARDED, readForwarded, sessionFilePath, sniffImage } from '../server/attachments.js'
import { messageSessionOp, startSessionsOp } from '../server/session/spawn-ops.js'
import type { StoredSession } from '../core/store/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'
import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_IMAGE_BYTES } from '../shared/protocol.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'junior-forward-'))
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

function put(dir: string, name: string, body: Buffer | string): string {
  const p = path.join(dir, name)
  writeFileSync(p, body)
  return p
}

test('sniffImage reads the bytes, never the name', () => {
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(JPEG), 'image/jpeg')
  assert.equal(sniffImage(GIF), 'image/gif')
  assert.equal(sniffImage(WEBP), 'image/webp')
  assert.equal(sniffImage(Buffer.from('%PDF-1.7')), null)
  assert.equal(sniffImage(Buffer.alloc(0)), null)
})

test('a screenshot rides inline as a real image; other files wait to be copied', async () => {
  const dir = tmp()
  try {
    const shot = put(dir, '3.png', PNG)
    const pdf = put(dir, 'spec.pdf', '%PDF-1.7 hello')
    // a png named .txt is still an image; a .png that isn't one is a file
    const odd = put(dir, 'notes.txt', JPEG)
    const fake = put(dir, 'fake.png', 'not an image')
    const got = await readForwarded([shot, pdf, odd, fake])
    assert.deepEqual(
      got.images.map((i) => [i.name, i.mediaType]),
      [
        ['3.png', 'image/png'],
        ['notes.txt', 'image/jpeg'],
      ],
    )
    assert.equal(Buffer.from(got.images[0].data, 'base64').equals(PNG), true, 'the bytes, base64, no data: prefix')
    assert.deepEqual(
      got.files.map((f) => [f.name, f.bytes]),
      [
        ['spec.pdf', 14],
        ['fake.png', 12],
      ],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no attachments is no attachments', async () => {
  assert.deepEqual(await readForwarded(undefined), { images: [], files: [] })
  assert.deepEqual(await readForwarded([]), { images: [], files: [] })
  assert.deepEqual(await readForwarded(['  ']), { images: [], files: [] })
})

test('an image over the image cap goes as a file instead', async () => {
  const dir = tmp()
  try {
    const big = put(dir, 'big.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
    const got = await readForwarded([big])
    assert.equal(got.images.length, 0)
    assert.deepEqual(got.files.map((f) => f.name), ['big.png'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bad paths are refused with the path named', async () => {
  const dir = tmp()
  try {
    const ok = put(dir, 'a.csv', 'a,b')
    await assert.rejects(readForwarded(['a.csv']), /must be an absolute path: a\.csv/)
    await assert.rejects(readForwarded([path.join(dir, 'gone.png')]), /no file at .*gone\.png/)
    await assert.rejects(readForwarded([dir]), /not a file/)
    await assert.rejects(readForwarded([put(dir, 'empty.txt', '')]), /the file is empty/)
    await assert.rejects(readForwarded([ok, ok]), /listed twice/)
    await assert.rejects(readForwarded([put(dir, 'huge.bin', Buffer.alloc(MAX_FILE_BYTES + 1))]), /under 20MB/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('count caps: too many paths, or too many non-image files', async () => {
  const dir = tmp()
  try {
    const many = Array.from({ length: MAX_FORWARDED + 1 }, (_, i) => put(dir, `f${i}.png`, PNG))
    await assert.rejects(readForwarded(many), /up to 13 attachments/)
    const files = Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, (_, i) => put(dir, `d${i}.csv`, 'x'))
    await assert.rejects(readForwarded(files), /up to 5 files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forwarded files are copied into the thread's folder; the original stays and the copy outlives it", async () => {
  const dir = tmp()
  const root = tmp()
  try {
    const src = put(dir, 'trace.log', 'boom')
    const { files } = await readForwarded([src])
    const [ref] = await copyForwardedFiles(root, 'thread-1', files)
    assert.equal(ref.name, 'trace.log')
    assert.equal(ref.bytes, 4)
    const copy = sessionFilePath(root, 'thread-1', ref)
    assert.ok(copy.startsWith(path.join(root, 'sessions', 'thread-1')))
    rmSync(src)
    assert.equal(readFileSync(copy, 'utf8'), 'boom')
    assert.match(attachedFilesNote(root, 'thread-1', [ref], 'Junior') ?? '', /^Junior attached a file\. Read it from disk:\n- .*trace\.log \(trace\.log, 1 KB\)$/)
    assert.match(attachedFilesNote(root, 'thread-1', [ref]) ?? '', /^The user attached a file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

// The ops check attachments before they touch anything else: a bad path starts no thread and sends no message.
const row = (id: string, name: string): StoredSession => ({ id, name, title: name }) as StoredSession
const fakeRt = (...rows: StoredSession[]) => ({ rows: new Map(rows.map((r) => [r.id, r])) }) as unknown as WorkspaceRuntime

test('start_session: one bad attachment starts none of the threads', async () => {
  const rt = fakeRt(row('dm', 'junior'))
  await assert.rejects(
    startSessionsOp(rt, 'dm', [
      { name: 'one', prompt: 'do one' },
      { name: 'two', prompt: 'do two', attachments: ['/no/such/3.png'] },
    ]),
    /"two": no file at \/no\/such\/3\.png/,
  )
  assert.equal(rt.rows.size, 1, 'no session was made')
})

test('message_session: a bad attachment sends nothing', async () => {
  const rt = fakeRt(row('dm', 'junior'), row('t1', 'auth fix'))
  await assert.rejects(messageSessionOp(rt, 'dm', 'auth fix', 'here is the screenshot', ['relative.png']), /absolute path/)
})
