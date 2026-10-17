import { Check, ChevronDown, ListChecks, Signpost, Target } from 'lucide-react'
import { Fragment } from 'react'
import type { SessionMode } from '../../../shared/protocol.js'
import { usePersona } from '../junior.js'
import { findSessionMode, SESSION_MODE_INFO } from '../sessionModes.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'

const ICON: Record<SessionMode, typeof Signpost> = { normal: Signpost, plan: ListChecks, goal: Target }

/**
 * What Junior does before it starts: an override, not a choice: "Junior
 * decides" by default, and a forced Plan first or Goal takes its colour.
 * New sessions only: a running session shows plan mode as a status chip instead.
 */
export function ModePicker({ mode, onChange, disabled }: { mode?: SessionMode; onChange: (mode: SessionMode) => void; disabled?: boolean }) {
  const persona = usePersona()
  const name = (m: SessionMode) => (m === 'normal' ? `${persona.name} decides` : findSessionMode(m).name)
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
            title={`${name(selected.id)} — ${selected.description}`}
            aria-label={`Mode: ${name(selected.id)}`}
          >
            <Icon size={13} aria-hidden="true" />
            <span className="name">{name(selected.id)}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent className="perm" side="top" align="start">
          {SESSION_MODE_INFO.map((m) => {
            const I = ICON[m.id]
            return (
              <Fragment key={m.id}>
                <MenuItem className={`wrap mode-${m.id}${m.id === selected.id ? ' on' : ''}`} onSelect={() => onChange(m.id)}>
                  <I className="modeIcon" size={14} aria-hidden="true" />
                  <span className="text">
                    <span className="name">{name(m.id)}</span>
                    <span className="desc">{m.description}</span>
                  </span>
                  {m.id === selected.id && <Check className="check" size={14} aria-hidden="true" />}
                </MenuItem>
                {m.id === 'normal' && <div className="uiMenuSep" />}
              </Fragment>
            )
          })}
        </MenuContent>
      </Menu>
    </div>
  )
}
