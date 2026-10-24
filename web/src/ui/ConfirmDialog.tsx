/**
 * Ask before something you can't take back: a title (the question), one line
 * under it, Cancel and the action. It stands in for the browser's native confirm box,
 * which ignores the theme and freezes the window.
 *
 * Controlled, so the call is no longer synchronous: whatever the action needs
 * (the job to delete, the entry to switch to) waits in the caller's state
 * until `onConfirm` runs. Focus starts on Cancel, the safe answer. Escape and
 * Cancel close with no effect, a click outside does nothing (an alert dialog
 * shouldn't vanish on a stray click), and on close focus goes back to whatever
 * opened it (useReturnFocus). On a phone the shared `.uiDialog` rule makes it
 * a full-width sheet with thumb-sized buttons.
 */
import * as Dialog from '@radix-ui/react-dialog'
import { useRef, useState, type ReactNode } from 'react'
import { useReturnFocus } from './returnFocus.js'

export function ConfirmDialog({
  open,
  title,
  body,
  confirm,
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean
  /** the question, e.g. "Delete job “Nightly CI sweep”?" */
  title: string
  body?: ReactNode
  /** the action's label, e.g. "Delete job" */
  confirm: string
  /** red outline: it can't be undone */
  danger?: boolean
  /** may resolve later; both buttons stay disabled until it does */
  onConfirm: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useReturnFocus(open)
  // Callers clear what they asked about as it closes; keep the words on screen while it goes.
  const shown = useRef({ title, body })
  if (open) shown.current = { title, body }

  const go = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      onClose()
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content
          className="uiDialog confirmDialog"
          role="alertdialog"
          // no body: say so, or Radix warns that the Description is missing
          {...(shown.current.body ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            cancelRef.current?.focus()
          }}
          onCloseAutoFocus={returnFocus}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title asChild>
            <h3>{shown.current.title}</h3>
          </Dialog.Title>
          {shown.current.body && (
            <Dialog.Description asChild>
              <p>{shown.current.body}</p>
            </Dialog.Description>
          )}
          <div className="row">
            <Dialog.Close asChild>
              <button ref={cancelRef} type="button" className="cancel" disabled={busy}>
                Cancel
              </button>
            </Dialog.Close>
            <button type="button" className={danger ? 'danger' : 'go'} disabled={busy} onClick={() => void go()}>
              {confirm}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
