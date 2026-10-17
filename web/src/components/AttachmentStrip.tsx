import { FileText, LoaderCircle, X } from 'lucide-react'
import type { Mention } from '../../../shared/protocol.js'
import { fileSize } from '../attachments.js'
import { MentionChip } from './MentionPicker.js'

/**
 * Anything with a preview: a `PendingImage` being uploaded, or an image a work
 * item already holds (`itemImageUrl`). The strip only needs a key and a src.
 */
export type StripImage = { id: string; url: string; name?: string }

/** A non-image file: one still going up (`uploading`), or one the item already holds. */
export type StripFile = { id: string; name: string; bytes: number; uploading?: boolean }

type Props = {
  images: readonly StripImage[]
  files?: readonly StripFile[]
  mentions?: readonly Mention[]
  error: string | null
  onRemove: (id: string) => void
  onRemoveMention?: (m: Mention) => void
}

/** A file's chip: icon, name, size, and an x when it can be taken back out. */
export function FileChip({ file, href, onRemove }: { file: StripFile; href?: string; onRemove?: () => void }) {
  const body = (
    <>
      {file.uploading ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : <FileText size={11} aria-hidden="true" />}
      <span className="n">{file.name}</span>
      <span className="sz">{file.uploading ? 'uploading…' : fileSize(file.bytes)}</span>
    </>
  )
  return (
    <span className={'fchip' + (file.uploading ? ' busy' : '')} title={`${file.name} · ${fileSize(file.bytes)}`}>
      {href ? (
        <a className="body" href={href} download={file.name}>
          {body}
        </a>
      ) : (
        <span className="body">{body}</span>
      )}
      {onRemove && (
        <button type="button" className="x" onClick={onRemove} aria-label={`Remove ${file.name}`} title="Remove">
          ×
        </button>
      )}
    </span>
  )
}

/** What's attached to the message being written, above the box: image thumbnails, file chips and `@` chips. */
export function AttachmentStrip({ images, files = [], mentions = [], error, onRemove, onRemoveMention }: Props) {
  if (images.length === 0 && files.length === 0 && mentions.length === 0 && !error) return null
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((img) => (
            <div className="thumb" key={img.id}>
              <img src={img.url} alt={img.name ?? 'Attached image'} />
              <button
                className="drop"
                onClick={() => onRemove(img.id)}
                title="Remove"
                aria-label={`Remove ${img.name ?? 'image'}`}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="fchips">
          {files.map((f) => (
            <FileChip key={f.id} file={f} onRemove={() => onRemove(f.id)} />
          ))}
        </div>
      )}
      {mentions.length > 0 && (
        <div className="mchips">
          {mentions.map((m) => (
            <MentionChip key={`${m.kind}:${m.ref}`} m={m} onRemove={onRemoveMention ? () => onRemoveMention(m) : undefined} />
          ))}
        </div>
      )}
      {error && <div className="attachError">{error}</div>}
    </div>
  )
}
