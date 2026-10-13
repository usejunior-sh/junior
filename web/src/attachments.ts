import { useCallback, useRef, useSyncExternalStore } from 'react'
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  isImageMediaType,
  type ImageAttachment,
} from '../../shared/protocol.js'
import { uuid } from './uuid.js'

/** An attachment plus the bits only the composer needs — a key and a preview URL. */
export type PendingImage = ImageAttachment & { id: string; url: string }

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    // `data:<type>;base64,<payload>` — the wire format wants the payload alone.
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })

type Tray = { images: PendingImage[]; error: string | null }
const EMPTY: Tray = { images: [], error: null }

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
  if (next.images.length === 0 && next.error === null) trays.delete(key)
  else trays.set(key, next)
  for (const fn of listeners) fn()
}

/**
 * The image tray behind a composer: paste, drop, or pick files and hold them
 * until the message is sent. Oversized files and non-images are refused with a
 * message rather than silently dropped — a screenshot that vanishes is worse
 * than one that explains itself.
 */
export function useAttachments(key?: string) {
  const fallback = useRef(uuid())
  const k = key ?? fallback.current
  const { images, error } = useSyncExternalStore(subscribe, () => trays.get(k) ?? EMPTY)
  const update = useCallback(
    (fn: (t: Tray) => Tray) => setTray(k, fn(trays.get(k) ?? EMPTY)),
    [k],
  )
  const setError = useCallback((error: string | null) => update((t) => ({ ...t, error })), [update])

  const add = useCallback(async (files: Iterable<File>) => {
    const picked = [...files].filter((f) => f.type.startsWith('image/'))
    if (picked.length === 0) return
    const accepted: PendingImage[] = []
    let rejected: string | null = null
    for (const file of picked) {
      if (!isImageMediaType(file.type)) {
        rejected = `${file.type.replace('image/', '').toUpperCase()} images aren't supported`
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejected = `${file.name || 'That image'} is over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`
        continue
      }
      accepted.push({
        id: uuid(),
        name: file.name || undefined,
        mediaType: file.type,
        data: await readAsBase64(file),
        url: URL.createObjectURL(file),
      })
    }
    update((t) => {
      const room = MAX_IMAGES_PER_MESSAGE - t.images.length
      if (accepted.length > room) rejected = `Up to ${MAX_IMAGES_PER_MESSAGE} images per message`
      return { images: [...t.images, ...accepted.slice(0, Math.max(room, 0))], error: rejected }
    })
  }, [update])

  const remove = useCallback(
    (id: string) =>
      update((t) => {
        const gone = t.images.find((i) => i.id === id)
        if (gone) URL.revokeObjectURL(gone.url)
        return { ...t, images: t.images.filter((i) => i.id !== id) }
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

  /** Wire onto a textarea: pasted screenshots become attachments. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.items]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f && f.type.startsWith('image/'))
      if (files.length === 0) return
      e.preventDefault()
      void add(files)
    },
    [add],
  )

  return { images, error, add, remove, clear, payload, onPaste, dismissError: () => setError(null) }
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
  setTray(key, { images: [...t.images, { ...img, id: uuid(), url }], error: null })
}
