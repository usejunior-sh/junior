import { CalendarClock, FileDiff, FileText, Inbox, MessagesSquare, Send, Target, Terminal, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { Mood } from '../../../core/junior/mood.js'
import { MOOD_LABEL } from '../../../core/junior/mood.js'
import { JuniorFace } from './JuniorFace.js'

export type RailSection = 'junior' | 'inbox' | 'sessions' | 'artifacts' | 'changes' | 'terminals' | 'jobs' | 'actions' | 'goals'

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
  /** goals whose turn is yours */
  goalsCount: number
  /** Junior's entry: the persona's name, and its face's mood (the most urgent state) */
  juniorName: string
  juniorMood: Mood
  onGo: (section: RailSection) => void
}

const ITEMS: Array<{ id: RailSection; label: string; icon: ComponentType<LucideProps> }> = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'actions', label: 'Actions', icon: Send },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'sessions', label: 'Sessions', icon: MessagesSquare },
  { id: 'artifacts', label: 'Artifacts', icon: FileText },
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'jobs', label: 'Jobs', icon: CalendarClock },
]

/** The labelled 64px rail: Junior first, then one button per destination, counts as small badges. */
export function Rail({ active, collapsed, inboxCount, runningCount, terminalCount, changedCount, actionsCount, goalsCount, juniorName, juniorMood, onGo }: Props) {
  const juniorToggle = collapsed !== undefined && active === 'junior'
  return (
    <nav className="rail" aria-label="Sections">
      {/* Junior: its face in place of an icon, still, changing only when its state does. */}
      <button
        type="button"
        className={`railBtn junior${active === 'junior' ? ' active' : ''}`}
        title={`${juniorName} · ${MOOD_LABEL[juniorMood].toLowerCase()}`}
        aria-current={active === 'junior' ? 'page' : undefined}
        aria-expanded={juniorToggle ? !collapsed : undefined}
        onClick={() => onGo('junior')}
      >
        <span className="jrRailFace">
          <JuniorFace mood={juniorMood} size={22} motion="still" decorative />
        </span>
        <span className="label">{juniorName}</span>
      </button>
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
                    : id === 'goals'
                      ? goalsCount
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
              <span
                className={`railBadge${id === 'actions' || id === 'goals' ? ' need' : ''}`}
                title={id === 'actions' ? `${badge} waiting on your approval` : id === 'goals' ? `${badge} waiting on you` : undefined}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
