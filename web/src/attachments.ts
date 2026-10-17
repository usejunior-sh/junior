import { useCallback, useRef, useSyncExternalStore } from 'react'
import {
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  isImageMediaType,
  type ImageAttachment,
  type UploadResponse,
} from '../../shared/protocol.js'
import { uuid } from './uuid.js'

/** An attachment plus the bits only the composer needs — a key and a preview URL. */
export type PendingImage = ImageAttachment & { id: string; url: string }

/**
 * Any other file, uploaded the moment it is picked (the bytes never ride the
 * socket). `uploadId` is the server's id for it and only exists once the upload
 * landed; until then the chip spins and send waits.
 */
export type PendingFile = { id: string; name: string; bytes: number; uploadId?: string }

/** 1.2 MB, 340 KB — what a file chip says beside the name. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

async function upload(file: File): Promise<UploadResponse> {
  try {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name || 'file')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
    return (await res.json()) as UploadResponse
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    // `data:<type>;base64,<payload>` — the wire format wants the payload alone.
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })

type Tray = { images: PendingImage[]; files: PendingFile[]; error: string | null }
const EMPTY: Tray = { images: [], files: [], error: null }

/**
 * Trays live here, not in component state: the composer unmounts when you
 * switch tabs, and a screenshot you pasted must still be there when you come
 * back. In memory only (base64 is too big for localStorage), so a reload
 * drops them; keyed by session id or draft id.
 */
const trays = new Map<string, Tray>()
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
function setTray(key: string, next: Tray) {
  if (next.images.length === 0 && next.files.length === 0 && next.error === null) trays.delete(key)
  else trays.set(key, next)
  for (const fn of listeners) fn()
}

/**
 * The tray behind a composer: paste, drop, or pick files and hold them until
 * the message is sent. A PNG/JPEG/GIF/WebP under the image cap stays an inline
 * image (the model sees it); anything else — a pdf, a csv, a big or odd image —
 * is uploaded at once and travels as an id, which Junior reads from disk.
 * Refusals come with a message rather than a silent drop: a file that vanishes
 * is worse than one that explains itself.
 */
export function useAttachments(key?: string) {
  const fallback = useRef(uuid())
  const k = key ?? fallback.current
  const { images, files, error } = useSyncExternalStore(subscribe, () => trays.get(k) ?? EMPTY)
  const update = useCallback(
    (fn: (t: Tray) => Tray) => setTray(k, fn(trays.get(k) ?? EMPTY)),
    [k],
  )
  const setError = useCallback((error: string | null) => update((t) => ({ ...t, error })), [update])

  const add = useCallback(async (picked: Iterable<File>) => {
    const list = [...picked]
    if (list.length === 0) return
    const inline: PendingImage[] = []
    const uploads: Array<{ file: File; entry: PendingFile }> = []
    let rejected: string | null = null
    // Early filter against the tray as it is now; the real cap is applied at commit below.
    const room = {
      images: MAX_IMAGES_PER_MESSAGE - (trays.get(k) ?? EMPTY).images.length,
      files: MAX_FILES_PER_MESSAGE - (trays.get(k) ?? EMPTY).files.length,
    }
    for (const file of list) {
      if (isImageMediaType(file.type) && file.size <= MAX_IMAGE_BYTES) {
        if (inline.length >= room.images) {
          rejected = `Up to ${MAX_IMAGES_PER_MESSAGE} images per message`
          continue
        }
        inline.push({
          id: uuid(),
          name: file.name || undefined,
          mediaType: file.type,
          data: await readAsBase64(file),
          url: URL.createObjectURL(file),
        })
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected = `${file.name || 'That file'} is over ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`
        continue
      }
      if (file.size === 0) {
        rejected = `${file.name || 'That file'} is empty`
        continue
      }
      if (uploads.length >= room.files) {
        rejected = `Up to ${MAX_FILES_PER_MESSAGE} files per message`
        continue
      }
      uploads.push({ file, entry: { id: uuid(), name: file.name || 'file', bytes: file.size } })
    }
    // Another add may have landed while images were being read: the room is
    // taken from the tray at this instant (no await between read and write), so
    // overlapping adds can never overfill it.
    let accepted: Array<{ file: File; entry: PendingFile }> = uploads
    update((t) => {
      const imageRoom = Math.max(0, MAX_IMAGES_PER_MESSAGE - t.images.length)
      const fileRoom = Math.max(0, MAX_FILES_PER_MESSAGE - t.files.length)
      for (const dropped of inline.slice(imageRoom)) URL.revokeObjectURL(dropped.url)
      if (inline.length > imageRoom) rejected = `Up to ${MAX_IMAGES_PER_MESSAGE} images per message`
      if (uploads.length > fileRoom) rejected = `Up to ${MAX_FILES_PER_MESSAGE} files per message`
      accepted = uploads.slice(0, fileRoom)
      return {
        images: [...t.images, ...inline.slice(0, imageRoom)],
        files: [...t.files, ...accepted.map((u) => u.entry)],
        error: rejected,
      }
    })
    // Each upload settles on its own: the chip gains its id, or goes with the reason.
    await Promise.all(
      accepted.map(async ({ file, entry }) => {
        const res = await upload(file)
        update((t) => {
          // Removed (or the message sent) while it was on its way: nothing to settle.
          if (!t.files.some((f) => f.id === entry.id)) return t
          if (!res.ok) return { ...t, files: t.files.filter((f) => f.id !== entry.id), error: `${entry.name}: ${res.error}` }
          return {
            ...t,
            files: t.files.map((f) => (f.id === entry.id ? { ...f, name: res.file.name, bytes: res.file.bytes, uploadId: res.file.id } : f)),
          }
        })
      }),
    )
  }, [k, update])

  const remove = useCallback(
    (id: string) =>
      update((t) => {
        const gone = t.images.find((i) => i.id === id)
        if (gone) URL.revokeObjectURL(gone.url)
        return { ...t, images: t.images.filter((i) => i.id !== id), files: t.files.filter((f) => f.id !== id) }
      }),
    [update],
  )

  const clear = useCallback(() => {
    for (const i of trays.get(k)?.images ?? []) URL.revokeObjectURL(i.url)
    setTray(k, EMPTY)
  }, [k])

  /** The wire shape: previews and ids stay on the client. */
  const payload = useCallback(
    (): ImageAttachment[] | undefined =>
      images.length > 0
        ? images.map(({ name, mediaType, data }) => ({ name, mediaType, data }))
        : undefined,
    [images],
  )

  /** Upload ids of the files that landed — what `files` on the wire names. */
  const fileIds = useCallback(
    (): string[] | undefined => {
      const ids = files.flatMap((f) => (f.uploadId ? [f.uploadId] : []))
      return ids.length > 0 ? ids : undefined
    },
    [files],
  )

  /** Some file is still on its way up: send waits for it. */
  const uploading = files.some((f) => !f.uploadId)

  /** Wire onto a textarea: pasted screenshots and files become attachments. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = [...e.clipboardData.items]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f)
      if (pasted.length === 0) return
      e.preventDefault()
      void add(pasted)
    },
    [add],
  )

  return { images, files, error, uploading, add, remove, clear, payload, fileIds, onPaste, dismissError: () => setError(null) }
}

/**
 * Put an image in a composer's tray from code — the browser pane's picker
 * hands over a crop of the element you picked. Same caps as a paste.
 */
export function attachImage(key: string, img: ImageAttachment) {
  const t = trays.get(key) ?? EMPTY
  if (t.images.length >= MAX_IMAGES_PER_MESSAGE) {
    setTray(key, { ...t, error: `Up to ${MAX_IMAGES_PER_MESSAGE} images per message` })
    return
  }
  const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: img.mediaType }))
  setTray(key, { ...t, images: [...t.images, { ...img, id: uuid(), url }], error: null })
}
