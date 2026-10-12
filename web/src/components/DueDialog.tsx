import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import type { ScoredItem } from '../../../shared/protocol.js'
import { dayInput } from '../dueDay.js'
import { Calendar } from './Calendar.js'

// ---------------------------------------------------------------------------
// Due-date picker: an exact day for one item, from its row menu. The menu's
// Today / Tomorrow / This week / Later cover the quick cases; this is the rest.
// ---------------------------------------------------------------------------

export function DueDialog({
  item,
  onClose,
  onPick,
}: {
  item: ScoredItem | null
  onClose: () => void
  /** a YYYY-MM-DD day, or null for Later (no date) */
  onPick: (item: ScoredItem, day: string | null) => void
}) {
  const [day, setDay] = useState('')
  useEffect(() => {
    if (item) setDay(dayInput(item))
  }, [item])
  return (
    <Dialog.Root open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content asChild>
          <dialog open className="projModal projAddDialog">
            <Dialog.Title asChild>
              <h3>Due date</h3>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p className="wsIntro">{item?.title}</p>
            </Dialog.Description>
            <Calendar value={day} onChange={setDay} />
            <div className="row">
              <Dialog.Close asChild>
                <button type="button" className="cancel">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="button" className="go" disabled={!day} onClick={() => item && onPick(item, day)}>
                Set date
              </button>
            </div>
          </dialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
