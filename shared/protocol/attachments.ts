

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * An image pasted, dropped, or picked into a composer, carried inline as
 * base64 — the server holds no upload store, and the model wants the bytes
 * anyway. Kept small on purpose (see `MAX_IMAGE_BYTES`): these ride the
 * WebSocket and land in the event log so a reload still shows them.
 */
export type ImageAttachment = {
  /** The original filename, when there was one — pasted screenshots have none. */
  name?: string
  /** An `image/*` media type the API accepts. */
  mediaType: ImageMediaType
  /** Base64 of the raw bytes — no `data:` prefix. */
  data: string
}

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

export const isImageMediaType = (v: unknown): v is ImageMediaType =>
  typeof v === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v)

/** Per-image ceiling on the decoded bytes, and how many ride one message. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 8

/**
 * An image attached to a *work item* — a screenshot pasted into the composer
 * or into the item's description. Unlike `ImageAttachment`, the bytes are NOT
 * carried inline: an item's payload is rebroadcast to every client on every
 * inbox sync, so the bytes live on disk in the workspace
 * (`attachments/<item>/<id>.png`) and only this ref rides the wire. Fetch the
 * bytes from `itemImageUrl()`.
 */
export type ItemImage = {
  /** uuid; also the on-disk filename stem */
  id: string
  /** the original filename, when there was one */
  name?: string
  mediaType: ImageMediaType
  /** decoded size on disk — what the UI shows and what the cap is measured against */
  bytes: number
}

/**
 * One entry of the `images` list a client sends when it saves an item: either
 * "keep the image you already hold" (`{ id }`) or "here is a new one"
 * (base64, like a chat attachment). The list is the complete desired set —
 * anything the server holds and the list omits is deleted. Absent = untouched.
 */
export type ItemImageEdit = { id: string } | ImageAttachment

export const MAX_IMAGES_PER_ITEM = 8

/**
 * Any file (pdf, csv, …) attached to a chat message or a work item. Bytes never
 * ride the WebSocket or an item save: the client uploads them first
 * (`POST /api/uploads?name=`, raw body) and then names the upload by id. The
 * server keeps the real filename on disk, because Claude Code's Read picks
 * pdf / notebook / image handling from the extension.
 */
export type FileRef = {
  /** uuid of the stored file's folder */
  id: string
  /** sanitized filename, as stored */
  name: string
  /** size on disk */
  bytes: number
}

/** Per-file ceiling (raw upload body) and how many files ride one message or item. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 5
export const MAX_FILES_PER_ITEM = 5

/** POST /api/uploads?name= — the stored upload, ready to be named in `files`. */
export type UploadResponse = { ok: true; file: FileRef } | { ok: false; error: string }

/** Where an item image's raw bytes are served (the `triage_ws` cookie scopes it). */
export const itemImageUrl = (itemId: string, imageId: string): string =>
  `/api/items/image?item=${encodeURIComponent(itemId)}&image=${encodeURIComponent(imageId)}`

/** Where an item file's bytes are served, as a download (the `triage_ws` cookie scopes it). */
export const itemFileUrl = (itemId: string, fileId: string): string =>
  `/api/items/file?item=${encodeURIComponent(itemId)}&file=${encodeURIComponent(fileId)}`

/** POST /api/items/files — replace the file set on any item: ids the item holds are kept, upload ids are claimed, the rest go. */
export type ItemFilesInput = { id: string; files: string[] }
export type ItemFilesResponse = { ok: true; files: FileRef[] } | { ok: false; error: string }

/** POST /api/items/images — replace the image set on any item (manual or scanned). */
export type ItemImagesInput = { id: string; images: ItemImageEdit[] }
export type ItemImagesResponse = { ok: true; images: ItemImage[] } | { ok: false; error: string }
