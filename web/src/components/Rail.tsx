import { CalendarClock, FileDiff, FileText, Inbox, MessagesSquare, Send, Terminal, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'

export type RailSection = 'inbox' | 'sessions' | 'artifacts' | 'changes' | 'terminals' | 'jobs' | 'actions'

type Props = {
  active: RailSection | null
  /** Set only where the active icon toggles the panel (the phone sheet). */
  collapsed?: boolean
  inboxCount: number
  runningCount: number
  terminalCount: number
  changedCount: number
  /** queued actions waiting on your approval */
  actionsCount: number
  onGo: (section: RailSection) => void
}

const ITEMS: Array<{ id: RailSection; label: string; icon: ComponentType<LucideProps> }> = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sessions', label: 'Sessions', icon: MessagesSquare },
  { id: 'artifacts', label: 'Artifacts', icon: FileText },
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'jobs', label: 'Jobs', icon: CalendarClock },
  { id: 'actions', label: 'Actions', icon: Send },
]

/** The labelled 64px rail — one button per destination, counts as small badges. */
export function Rail({ active, collapsed, inboxCount, runningCount, terminalCount, changedCount, actionsCount, onGo }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
      {ITEMS.map(({ id, label, icon: Icon }) => {
        const badge =
          id === 'inbox'
            ? inboxCount
            : id === 'sessions'
              ? runningCount
              : id === 'terminals'
                ? terminalCount
                : id === 'changes'
                  ? changedCount
                  : id === 'actions'
                    ? actionsCount
                    : 0
        // On a phone the active tab toggles its sheet, so its own tooltip and
        // aria-expanded speak to that instead of just naming itself.
        const isToggle = collapsed !== undefined && active === id
        return (
          <button
            key={id}
            type="button"
            className={`railBtn${active === id ? ' active' : ''}`}
            title={isToggle ? (collapsed ? 'Show panel' : 'Hide panel') : label}
            aria-current={active === id ? 'page' : undefined}
            aria-expanded={isToggle ? !collapsed : undefined}
            onClick={() => onGo(id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="label">{label}</span>
            {badge > 0 && (
              <span className={`railBadge${id === 'actions' ? ' need' : ''}`} title={id === 'actions' ? `${badge} waiting on your approval` : undefined}>
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
