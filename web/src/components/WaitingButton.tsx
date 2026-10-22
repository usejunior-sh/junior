/**
 * The top bar's Waiting button: every chat that is waiting on you (a
 * permission, a question, a plan, a team card or gate), and the sends held
 * for your OK. Orange dot when anything waits; click a row to open it.
 */
import * as Popover from '@radix-ui/react-popover'
import { Bell } from 'lucide-react'
import { useState } from 'react'
import { usePendingActions } from '../actions.js'
import { useSessions } from '../hooks.js'
import { needsYouText } from '../inboxTabs.js'

export function WaitingButton() {
  const [open, setOpen] = useState(false)
  const sessions = useSessions()
  const sends = usePendingActions()
  const waiting = sessions.flatMap((s) => {
    const why = needsYouText(s)
    return why ? [{ s, why }] : []
  })
  const count = waiting.length + (sends > 0 ? 1 : 0)
  const label = count === 0 ? 'Nothing is waiting on you' : `${waiting.length + sends} waiting on you`
  const go = (hash: string) => {
    setOpen(false)
    location.hash = hash
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={`topIcon${open ? ' on' : ''}`} title={label} aria-label={label}>
          <Bell size={15} aria-hidden="true" />
          {count > 0 && <span className="connDot needs" aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="provPop waitPop" side="bottom" align="end" sideOffset={8} collisionPadding={12}>
          <div className="head">
            <span className="lab">Waiting on you</span>
          </div>
          {count === 0 && <div className="waitNone">Nothing is waiting on you.</div>}
          {waiting.map(({ s, why }) => (
            <button key={s.id} type="button" className="waitRow" onClick={() => go(s.id)}>
              <span className="dot sm orange" aria-hidden="true" />
              <span className="t">{s.title}</span>
              <span className="why">{why}</span>
            </button>
          ))}
          {sends > 0 && (
            <button type="button" className="waitRow" onClick={() => go('/junior/log')}>
              <span className="dot sm orange" aria-hidden="true" />
              <span className="t">{sends === 1 ? '1 send waits for your OK' : `${sends} sends wait for your OK`}</span>
              <span className="why">Log</span>
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
