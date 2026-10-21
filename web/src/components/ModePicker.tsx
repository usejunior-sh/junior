import { Check, ChevronDown, ListChecks, Signpost, Target, User, Workflow } from 'lucide-react'
import type { SessionMode } from '../../../shared/protocol.js'
import { findSessionMode, SESSION_MODE_INFO } from '../sessionModes.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'

const ICON: Record<SessionMode, typeof Signpost> = { normal: User, plan: ListChecks, goal: Target, ultracode: Workflow }

/**
 * How a new chat works: Solo or Ultracode, picked once before the first
 * message. New sessions only: a running session shows Planning / Ultracode as
 * status chips instead.
 */
export function ModePicker({ mode, onChange, disabled }: { mode?: SessionMode; onChange: (mode: SessionMode) => void; disabled?: boolean }) {
  const selected = findSessionMode(mode)
  const Icon = ICON[selected.id]
  return (
    <div className="modePicker">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={`chip sessionMode ${selected.id}`}
            disabled={disabled}
            title={`${selected.name} — ${selected.description}`}
            aria-label={`Way of working: ${selected.name}`}
          >
            <Icon size={13} aria-hidden="true" />
            <span className="name">{selected.name}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent className="perm" side="top" align="start">
          {SESSION_MODE_INFO.map((m) => {
            const I = ICON[m.id]
            return (
              <MenuItem key={m.id} className={`wrap mode-${m.id}${m.id === selected.id ? ' on' : ''}`} onSelect={() => onChange(m.id)}>
                <I className="modeIcon" size={14} aria-hidden="true" />
                <span className="text">
                  <span className="name">{m.name}</span>
                  <span className="desc">{m.description}</span>
                </span>
                {m.id === selected.id && <Check className="check" size={14} aria-hidden="true" />}
              </MenuItem>
            )
          })}
        </MenuContent>
      </Menu>
    </div>
  )
}
