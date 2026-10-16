/**
 * Files attached to a chat message or a work item — any type, not only images.
 *
 * Bytes never ride the WebSocket or an item save. The client first uploads each
 * file (`POST /api/uploads?name=`, raw body) into a pending folder,
 * `<workspace>/attachments/uploads/<uuid>/<name>`, and then names the upload by its uuid
 * in `files`. The real filename is kept on disk: Claude Code's Read chooses
 * pdf / notebook / image handling from the extension. Pending uploads are
 * pruned after a day, each time a new one arrives, so no timer is needed.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type http from 'node:http'
import path from 'node:path'

import { MAX_FILE_BYTES, type FileRef } from '../shared/protocol.js'

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_NAME_CHARS = 120
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000

export const isUploadId = (v: unknown): v is string => typeof v === 'string' && UPLOAD_ID.test(v)

/** `root` is the workspace's `attachments` folder. */
export const uploadsDir = (root: string): string => path.join(root, 'uploads')

/**
 * A filename that is safe to put on disk and to show: no directories, no
 * control characters, no leading dots, no reserved characters, bounded length
 * (the extension survives the trim). Never empty.
 */
export function sanitizeFileName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : ''
  // Whatever follows the last / or \ — a client may send a full path.
  name = name.split(/[\\/]/).pop() ?? ''
  name = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (name.length > MAX_NAME_CHARS) {
    const ext = path.extname(name)
    const keep = ext.length > 0 && ext.length <= 16 ? ext : ''
    name = name.slice(0, MAX_NAME_CHARS - keep.length) + keep
  }
  return name || 'file'
}

/** The stored upload's folder, or null when the id isn't a uuid (nothing from the request reaches a path otherwise). */
const uploadFolder = (root: string, id: string): string | null => (isUploadId(id) ? path.join(uploadsDir(root), id) : null)

/** Write one upload: `<uploads>/<uuid>/<name>`. Throws past the cap or on an empty body. */
export async function saveUpload(root: string, name: unknown, body: Buffer): Promise<FileRef> {
  if (body.length === 0) throw new Error('the file is empty')
  if (body.length > MAX_FILE_BYTES) throw new Error(`each file must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`)
  const id = randomUUID()
  const file = sanitizeFileName(name)
  await mkdir(path.join(uploadsDir(root), id), { recursive: true })
  await writeFile(path.join(uploadsDir(root), id, file), body)
  return { id, name: file, bytes: body.length }
}

/** The one file inside an upload's folder, or null. The name comes from the listing, never from a request. */
export async function readUpload(root: string, id: string): Promise<FileRef | null> {
  const dir = uploadFolder(root, id)
  if (!dir) return null
  try {
    const names = await readdir(dir)
    if (names.length !== 1) return null
    const s = await stat(path.join(dir, names[0]))
    return s.isFile() ? { id, name: names[0], bytes: s.size } : null
  } catch {
    return null
  }
}

/** Delete pending uploads older than `maxAgeMs`. Best-effort; returns how many went. */
export async function pruneUploads(root: string, now = Date.now(), maxAgeMs = UPLOAD_MAX_AGE_MS): Promise<number> {
  let names: string[]
  try {
    names = await readdir(uploadsDir(root))
  } catch {
    return 0
  }
  let removed = 0
  for (const n of names) {
    if (!isUploadId(n)) continue
    const dir = path.join(uploadsDir(root), n)
    try {
      if (now - (await stat(dir)).mtimeMs <= maxAgeMs) continue
      await rm(dir, { recursive: true, force: true })
      removed++
    } catch {
      /* gone already, or unreadable: leave it */
    }
  }
  return removed
}

/**
 * The raw request body, refused as soon as it passes `limit` — by the declared
 * length before a byte is read, then by the running total.
 */
export function readRawBody(req: http.IncomingMessage, limit = MAX_FILE_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooBig = () => new Error(`each file must be under ${Math.round(limit / 1024 / 1024)}MB`)
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooBig())
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > limit) {
        done = true
        reject(tooBig())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (!done) reject(err)
    })
  })
}

/** POST /api/uploads: prune stale uploads, then store this request's body under `?name=`. */
export async function handleUpload(root: string, req: http.IncomingMessage, name: string | null): Promise<FileRef> {
  const body = await readRawBody(req)
  await pruneUploads(root)
  return saveUpload(root, name, body)
}

/**
 * The shape of a `files` list: an array of upload ids, at most `max`, no
 * repeats. Throws on anything else — a file that silently vanishes on send is
 * worse than an error.
 */
export function fileIdList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) throw new Error('files must be a list')
  if (v.length > max) throw new Error(`up to ${max} files at a time`)
  const seen = new Set<string>()
  for (const id of v) {
    if (!isUploadId(id)) throw new Error('each file must be an upload id')
    if (seen.has(id)) throw new Error('a file is listed twice')
    seen.add(id)
  }
  return v as string[]
}

/** The upload refs behind a message's `files`, in order; `undefined`/null = none. Unknown ids throw. */
export async function resolveUploads(root: string, v: unknown, max: number): Promise<FileRef[]> {
  if (v === undefined || v === null) return []
  const out: FileRef[] = []
  for (const id of fileIdList(v, max)) {
    const ref = await readUpload(root, id)
    if (!ref) throw new Error('an attached file is no longer available — attach it again')
    out.push(ref)
  }
  return out
}

/**
 * An item save's `files`: the complete desired set, as ids. Each is either a
 * file the item already holds (`kept`) or a pending upload to claim (`fresh`).
 * Absent = untouched (`undefined`). Order is the order given.
 */
export async function itemFileEdits(
  root: string,
  raw: Record<string, unknown>,
  held: readonly FileRef[],
  max: number,
): Promise<{ kept: FileRef[]; fresh: FileRef[]; order: string[] } | undefined> {
  const v = raw.files
  if (v === undefined || v === null) return undefined
  const ids = fileIdList(v, max)
  const heldById = new Map(held.map((f) => [f.id, f]))
  const kept: FileRef[] = []
  const fresh: FileRef[] = []
  for (const id of ids) {
    const have = heldById.get(id)
    if (have) {
      kept.push(have)
      continue
    }
    const ref = await readUpload(root, id)
    if (!ref) throw new Error('an attached file is no longer available — attach it again')
    fresh.push(ref)
  }
  return { kept, fresh, order: ids }
}
