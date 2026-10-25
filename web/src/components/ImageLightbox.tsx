/**
 * An image full size, over everything. Esc or a click outside closes it
 * (Radix). `ZoomableImage` is the thumbnail that opens it: attached images in
 * the chat and the composer, an item's screenshots.
 */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

export function ImageLightbox({ src, alt, title, onClose }: { src: string | null; alt: string; title: string; onClose: () => void }) {
  return (
    <Dialog.Root open={!!src} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shotOverlay" />
        <Dialog.Content className="shotLightbox" aria-describedby={undefined}>
          <Dialog.Title className="shotLbTitle mono">{title}</Dialog.Title>
          <Dialog.Close className="btn sm ghost icon shotLbClose" aria-label="Close">
            <X size={14} aria-hidden="true" />
          </Dialog.Close>
          {src && <img src={src} alt={alt} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ZoomableImage({ src, alt, title, className }: { src: string; alt: string; title?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={'imgZoom' + (className ? ` ${className}` : '')} title={title ?? 'Open full size'} onClick={() => setOpen(true)}>
        <img src={src} alt={alt} />
      </button>
      <ImageLightbox src={open ? src : null} alt={alt} title={title ?? alt} onClose={() => setOpen(false)} />
    </>
  )
}
