/**
 * The snooze menu (hand-offs, Phase 1): 1 hour, 4 hours, 1, 2 or 3 days,
 * each with the time it comes back. A snooze ends early when the item
 * changes. The times are core/work/snooze.ts; this is the Radix menu.
 * `SnoozeMenu` is a button of its own; `SnoozeSub` sits inside another menu.
 */
import { AlarmClock } from 'lucide-react'
import type { ReactNode } from 'react'
import { SNOOZE_CHOICES, snoozeClock, snoozeUntil } from '../../../core/work/snooze.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../ui/Menu.js'

function Choices({ onSnooze }: { onSnooze: (until: number) => void }) {
  const now = Date.now()
  return (
    <>
      <div className="uiMenuCap">Snooze until</div>
      {SNOOZE_CHOICES.map((c) => {
        const until = snoozeUntil(c.id, now)
        return (
          <MenuItem key={c.id} onSelect={() => onSnooze(snoozeUntil(c.id, Date.now()))}>
            {c.label}
            <span className="k">{snoozeClock(until, now)}</span>
          </MenuItem>
        )
      })}
      <MenuSeparator />
      <div className="snzFoot">Comes back early if something changes.</div>
    </>
  )
}

/** A trigger of its own: `children` is the button. */
export function SnoozeMenu({
  onSnooze,
  children,
  align = 'end',
  open,
  onOpenChange,
}: {
  onSnooze: (until: number) => void
  children: ReactNode
  align?: 'start' | 'end'
  /** controlled, for a key that opens it (S on the Junior page) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Menu {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align={align} className="snzMenu">
        <Choices onSnooze={onSnooze} />
      </MenuContent>
    </Menu>
  )
}

/** Inside another menu: "Snooze ›". */
export function SnoozeSub({ onSnooze }: { onSnooze: (until: number) => void }) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <AlarmClock size={13} aria-hidden="true" /> Snooze
      </MenuSubTrigger>
      <MenuSubContent className="snzMenu">
        <Choices onSnooze={onSnooze} />
      </MenuSubContent>
    </MenuSub>
  )
}
