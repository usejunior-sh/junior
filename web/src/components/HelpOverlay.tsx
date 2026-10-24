import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { SHORTCUTS } from '../keys.js'

/**
 * The `?` sheet: every global shortcut. A Radix Dialog, so Esc, a scrim click
 * and the X close it and focus goes back to whatever opened it. ⌘K, ⌘, and
 * ⌘⇧. still close it from useGlobalHotkeys and open their own thing; when one
 * of those is already up, focus stays there instead of jumping back.
 */
export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content
          id="helpOverlay"
          className="uiDialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (otherLayerOpen()) e.preventDefault()
          }}
        >
          <div className="helpHead">
            <Dialog.Title asChild>
              <h3>Keyboard shortcuts</h3>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="iconBtn" title="Close (Esc)" aria-label="Close">
                <X size={14} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <table>
            <tbody>
              {SHORTCUTS.map(([keys, what]) => (
                <tr key={keys}>
                  <td>
                    <kbd>{keys}</kbd>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The palette, the friction note or another dialog took over as help closed. */
function otherLayerOpen(): boolean {
  return (
    document.querySelector(
      'dialog[open], [role="dialog"][data-state="open"]:not(#helpOverlay), [data-radix-popper-content-wrapper]',
    ) !== null
  )
}
