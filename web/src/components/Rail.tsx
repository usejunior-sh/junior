import { CalendarClock, FileDiff, FileText, Inbox, MessagesSquare, Terminal, type LucideProps } from 'lucide-react'
import { Fragment, type ComponentType } from 'react'
import type { Mood } from '../../../core/junior/mood.js'
import { MOOD_LABEL } from '../../../core/junior/mood.js'
import { JuniorFace } from './JuniorFace.js'

/** Every section a route can sit in. Actions and Goals are routes with no rail entry (Actions folds into Junior in M2; Goals is hidden). */
export type RailSection = 'junior' | 'inbox' | 'sessions' | 'artifacts' | 'changes' | 'terminals' | 'jobs' | 'actions' | 'goals'

type Props = {
  active: RailSection | null
  /** Set only where the active icon toggles the panel (the phone sheet). */
  collapsed?: boolean
  inboxCount: number
  runningCount: number
  terminalCount: number
  changedCount: number
  /** Junior's entry: the persona's name, and its face's mood (the most urgent state) */
  juniorName: string
  juniorMood: Mood
  onGo: (section: RailSection) => void
}

/** Junior · Inbox, a gap, then the places you work. `gap` starts the second group. */
const ITEMS: Array<{ id: RailSection; label: string; icon: ComponentType<LucideProps>; gap?: true }> = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sessions', label: 'Chats', icon: MessagesSquare, gap: true },
  { id: 'artifacts', label: 'Artifacts', icon: FileText },
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'jobs', label: 'Jobs', icon: CalendarClock },
]

/** The labelled 64px rail: Junior first, then one button per destination, counts as small badges. */
export function Rail({ active, collapsed, inboxCount, runningCount, terminalCount, changedCount, juniorName, juniorMood, onGo }: Props) {
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
      {ITEMS.map(({ id, label, icon: Icon, gap }) => {
        const badge =
          id === 'inbox'
            ? inboxCount
            : id === 'sessions'
              ? runningCount
              : id === 'terminals'
                ? terminalCount
                : id === 'changes'
                  ? changedCount
                  : 0
        // On a phone the active tab toggles its sheet, so its own tooltip and
        // aria-expanded speak to that instead of just naming itself.
        const isToggle = collapsed !== undefined && active === id
        return (
          <Fragment key={id}>
          {gap && <div className="railSep" aria-hidden="true" />}
          <button
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
              <span className="railBadge">{badge > 99 ? '99+' : badge}</span>
            )}
          </button>
          </Fragment>
        )
      })}
    </nav>
  )
}
