/**
 * Screenshots attached to a work item, on disk.
 *
 * Chat attachments ride inline as base64 (they land in the event log and the
 * model wants the bytes anyway), but an item's payload is rebroadcast to every
 * WebSocket client on every inbox sync, megabytes of base64 in it would be
 * re-sent on every refresh. So the bytes live here, one folder per item under
 * the workspace's `attachments/`, and the item payload carries only `ItemImage`
 * refs. The web UI fetches them by URL; a brief or dispatched session gets them
 * read back into real image blocks.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ImageAttachment, ImageMediaType, ItemImage, ItemImageEdit } from '../shared/protocol.js'

const EXT: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * One folder per item, named by the same slug briefs use, item ids carry `:`,
 * `/` and `#`, none of which may reach the filesystem. Two different ids can in
 * principle slug the same; the files inside are uuid-named, so they coexist.
 */
export const itemImageDir = (root: string, itemId: string): string =>
  path.join(root, itemId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item')

const fileFor = (root: string, itemId: string, image: ItemImage): string =>
  path.join(itemImageDir(root, itemId), `${image.id}.${EXT[image.mediaType]}`)

/**
 * Reconcile an item's images against what the client just sent: `{ id }`
 * entries keep a stored image (in the order given), anything else is a new
 * upload written to disk, and every stored image the list omits has its file
 * removed. Returns the refs to persist on the item.
 */
export async function applyImageEdits(
  root: string,
  itemId: string,
  current: readonly ItemImage[],
  edits: readonly ItemImageEdit[],
): Promise<ItemImage[]> {
  const byId = new Map(current.map((i) => [i.id, i]))
  const next: ItemImage[] = []
  const fresh: { image: ItemImage; bytes: Buffer }[] = []
  for (const edit of edits) {
    if ('id' in edit) {
      const kept = byId.get(edit.id)
      if (kept) next.push(kept)
      continue
    }
    const bytes = Buffer.from(edit.data, 'base64')
    const image: ItemImage = {
      id: randomUUID(),
      mediaType: edit.mediaType,
      bytes: bytes.length,
      ...(edit.name ? { name: edit.name } : {}),
    }
    next.push(image)
    fresh.push({ image, bytes })
  }
  if (fresh.length > 0) {
    await mkdir(itemImageDir(root, itemId), { recursive: true })
    for (const { image, bytes } of fresh) {
      await writeFile(fileFor(root, itemId, image), bytes)
    }
  }
  // Whatever the new list does not name is gone; the file goes with it.
  const keeping = new Set(next.map((i) => i.id))
  for (const old of current) {
    if (keeping.has(old.id)) continue
    await rm(fileFor(root, itemId, old), { force: true }).catch(() => {})
  }
  return next
}

/** Raw bytes for one image, for serving it back to the browser. */
export const readItemImage = (root: string, itemId: string, image: ItemImage): Promise<Buffer> =>
  readFile(fileFor(root, itemId, image))

/**
 * An item's images as message attachments: what a brief run or a dispatched
 * session is handed. A file that has gone missing is skipped rather than
 * failing the run: the prompt is worth more than the screenshot.
 */
export async function itemImageAttachments(
  root: string,
  itemId: string,
  images: readonly ItemImage[] | undefined,
): Promise<ImageAttachment[] | undefined> {
  if (!images?.length) return undefined
  const out: ImageAttachment[] = []
  for (const image of images) {
    try {
      const buf = await readItemImage(root, itemId, image)
      out.push({ mediaType: image.mediaType, data: buf.toString('base64'), ...(image.name ? { name: image.name } : {}) })
    } catch {
      // the file is gone: the ref outlived it
    }
  }
  return out.length > 0 ? out : undefined
}
