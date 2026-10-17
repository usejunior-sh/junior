/**
 * Our one calendar idiom. Radix ships no calendar primitive, so the month grid
 * is react-day-picker (headless-ish, keyboard- and screen-reader-complete) and
 * the pixels are ours (`.calendar` in styles/*.css, design tokens only).
 * `DatePopover` is the Radix Popover around it. The due pill in the composer.
 */
import * as Popover from '@radix-ui/react-popover'
import { CalendarDays, X } from 'lucide-react'
import { useState } from 'react'
import { DayPicker } from 'react-day-picker'
import 'react-day-picker/style.css'
import { fromDayInput, toDayInput } from '../dueDay.js'
import { usePortalContainer } from '../ui/portalContainer.js'

/** `value` and `onChange` are YYYY-MM-DD strings; '' is no day. */
export function Calendar({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const selected = fromDayInput(value)
  return (
    <DayPicker
      className="calendar"
      mode="single"
      selected={selected}
      defaultMonth={selected}
      onSelect={(d) => d && onChange(toDayInput(d.getTime()))}
      showOutsideDays
      autoFocus
    />
  )
}

const shortDay = (day: string): string =>
  fromDayInput(day)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) ?? day

export function DatePopover({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (day: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, container, resolve } = usePortalContainer(open)
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) resolve()
        setOpen(o)
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={anchorRef}
          type="button"
          className={`${className ?? 'pill'}${value ? ' set' : ''}`}
          title="Due date"
          aria-label="Due date"
        >
          <CalendarDays size={12} aria-hidden="true" />
          {value ? shortDay(value) : 'Due date'}
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content className="uiMenu calendarPop" align="start" sideOffset={6} collisionPadding={12}>
          <Calendar
            value={value}
            onChange={(day) => {
              onChange(day)
              setOpen(false)
            }}
          />
          {value && (
            <button
              type="button"
              className="calendarClear"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
            >
              <X size={12} aria-hidden="true" /> Clear date
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
