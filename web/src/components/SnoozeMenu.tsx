/**
 * The snooze menu (hand-offs, Phase 1): say when it comes back in your own
 * words ("till tue 9am", "in 2 working days"), or pick 1 hour, 4 hours, 1, 2
 * or 3 days, each with the time it comes back. A snooze ends early when the
 * item changes. The times are core/work/snooze.ts (the words are read by
 * shared/when.ts); this is the Radix menu.
 *
 * The field is a plain input inside the menu, not a menu item. Its keys stop
 * at the input so Radix typeahead never eats a letter; only Escape and Tab go
 * on to the menu, and ↓ moves to the first quick pick. The Snooze button is a
 * Radix item drawn as a button, so saving closes the menu (submenu included)
 * the way a quick pick does. It saves exactly the time shown under the field.
 *
 * `SnoozeMenu` is a button of its own; `SnoozeSub` sits inside another menu.
 */
import { AlarmClock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { SNOOZE_CHOICES, readSnooze, snoozeClock, snoozeToSave, snoozeUntil } from '../../../core/work/snooze.js'
import type { SnoozeRead } from '../../../core/work/snooze.js'
import {
  Menu,
  MenuBareItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '../ui/Menu.js'

const HINT = 'Not a time I can read. Try "in 2 working days".'

/** The typed time: the field, what it reads as, and the Snooze button. */
function SnoozeField({ onSnooze, focusOnOpen }: { onSnooze: (until: number) => void; focusOnOpen: boolean }) {
  const [text, setText] = useState('')
  const [read, setRead] = useState<SnoozeRead>({ kind: 'empty' })
  const inputRef = useRef<HTMLInputElement>(null)
  const goRef = useRef<HTMLButtonElement>(null)

  // The field first, so S then typing just works. A frame late on purpose:
  // Radix focuses the menu (or its first item, after a key) as it mounts.
  useEffect(() => {
    if (!focusOnOpen) return
    const id = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(id)
  }, [focusOnOpen])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') return
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      // through the item, so the menu closes as it does on a click; a disabled button ignores it
      goRef.current?.click()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.currentTarget
        .closest('[role="menu"]')
        ?.querySelector<HTMLElement>('[role="menuitem"]:not(.snzGo)')
        ?.focus()
    }
  }

  return (
    <div className="snzType">
      <input
        ref={inputRef}
        className="snzIn"
        type="text"
        value={text}
        placeholder='Type a time, like "tue 9am"'
        aria-label="Snooze until, in your words"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setRead(readSnooze(e.target.value, Date.now()))
        }}
        onKeyDown={onKeyDown}
      />
      <div className="snzRow">
        <span className="snzBack" aria-live="polite">
          {read.kind === 'time' && (
            <>
              Back <span className="snzAt">{read.label}</span>
            </>
          )}
          {read.kind === 'unread' && HINT}
        </span>
        <MenuBareItem
          asChild
          disabled={read.kind !== 'time'}
          onSelect={(e) => {
            const at = snoozeToSave(text, read, Date.now())
            if (at === null) {
              // the shown time has passed and the words no longer read as a future time
              e.preventDefault()
              setRead({ kind: 'unread' })
              inputRef.current?.focus()
              return
            }
            onSnooze(at)
          }}
        >
          <button ref={goRef} type="button" className="btn sm primary snzGo" disabled={read.kind !== 'time'}>
            Snooze <kbd className="kbd">↩</kbd>
          </button>
        </MenuBareItem>
      </div>
    </div>
  )
}

function Choices({ onSnooze, focusOnOpen }: { onSnooze: (until: number) => void; focusOnOpen: boolean }) {
  const now = Date.now()
  return (
    <>
      <div className="uiMenuCap">Snooze until</div>
      <SnoozeField onSnooze={onSnooze} focusOnOpen={focusOnOpen} />
      <MenuSeparator />
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
        <Choices onSnooze={onSnooze} focusOnOpen />
      </MenuContent>
    </Menu>
  )
}

/**
 * Inside another menu: "Snooze ›". Radix decides a submenu's focus on open
 * (and hovering in must not steal it), so here the field takes focus on click.
 */
export function SnoozeSub({ onSnooze }: { onSnooze: (until: number) => void }) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <AlarmClock size={13} aria-hidden="true" /> Snooze
      </MenuSubTrigger>
      <MenuSubContent className="snzMenu">
        <Choices onSnooze={onSnooze} focusOnOpen={false} />
      </MenuSubContent>
    </MenuSub>
  )
}
