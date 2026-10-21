/**
 * Ask before something that signs you out or deletes: one title, one line,
 * Cancel and the action. Shared by the pane (Clear this site's data) and
 * Settings → Browser (Sign out, Delete). A destructive confirm doesn't close
 * on a click outside it, as an alert dialog shouldn't.
 */
import * as Dialog from '@radix-ui/react-dialog'
import { useState, type ReactNode } from 'react'

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
  title: string
  body: ReactNode
  /** the action's label, e.g. "Delete profile" */
  confirm: string
  /** red outline: it can't be undone */
  danger?: boolean
  /** resolves when done; the dialog stays up (busy) until then */
  onConfirm: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
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
        <Dialog.Content asChild role="alertdialog" onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
          <dialog open className="projModal projAddDialog bpConfirm">
            <Dialog.Title asChild>
              <h3>{title}</h3>
            </Dialog.Title>
            <Dialog.Description asChild>
              <div className="wsIntro">{body}</div>
            </Dialog.Description>
            <div className="bpConfirmBtns">
              <Dialog.Close asChild>
                <button type="button" className="btn sm" disabled={busy}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="button" className={`btn sm ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void go()}>
                {confirm}
              </button>
            </div>
          </dialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
