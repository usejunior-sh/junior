import { Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import type { PermissionMode } from '../../../shared/protocol.js'
import { findMode, levelsFor } from '../permissionModes.js'
import { readAllowNever } from '../sessionDefaults.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'

type Props = {
  mode?: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
  /** The provider can hold sends and catch destructive commands (Claude); without it "Asks before sending" isn't offered. */
  hooks?: boolean
}

/** Four bars, one per level, lit up to this one; neutral until "Never asks", which is all red. */
export function Meter({ bars }: { bars: number }) {
  return (
    <span className="meter" data-bars={bars} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

/** Autonomy: when Junior checks in with you. The meter and the level's short name; "Never asks" in red. */
export function AutonomyPicker({ mode, onChange, disabled, hooks = true }: Props) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<PermissionMode | null>(null)

  const selected = findMode(mode)
  // Read on every render: Settings may have turned "Never asks" on since the last one.
  const levels = levelsFor({ hooks, allowNever: readAllowNever(), current: mode })

  function pick(id: PermissionMode, e: Event) {
    // Never asking is the one choice that gets a second question: it is the
    // only level where a mis-click has no later chance to be caught.
    // preventDefault keeps the menu open so the confirm can render in place.
    if (id === 'bypassPermissions' && selected.id !== id) {
      e.preventDefault()
      setConfirming(id)
      return
    }
    onChange(id)
  }

  return (
    <div className="permPicker">
      <Menu
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setConfirming(null)
        }}
      >
        <MenuTrigger asChild>
          <button
            type="button"
            className={`chip perm risk-${selected.risk}`}
            disabled={disabled}
            title={`${selected.name} — ${selected.description}`}
            aria-label={`Autonomy: ${selected.name}`}
          >
            <Meter bars={selected.bars} />
            <span className="name">{selected.short}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </MenuTrigger>

        <MenuContent className="perm" side="top" align="start">
          {levels.map((m) => (
            <MenuItem
              key={m.id}
              className={`wrap risk-${m.risk}${m.id === selected.id ? ' on' : ''}`}
              onSelect={(e) => pick(m.id, e)}
            >
              <Meter bars={m.bars} />
              <span className="text">
                <span className="name">{m.name}</span>
                <span className="desc">{m.description}</span>
              </span>
              {m.id === selected.id && <Check className="check" size={14} aria-hidden="true" />}
            </MenuItem>
          ))}

          {confirming ? (
            <div className="uiMenuConfirm">
              <p>
                Junior will run every command and send every push, comment and message without asking — including
                ones that delete work. Turn it on only where you can afford the worst case.
              </p>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  onChange(confirming)
                  setOpen(false)
                }}
              >
                Never ask
              </button>
              <button type="button" className="cancel" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <p className="uiMenuBlurb">When Junior checks in with you. Applies from the next tool call.</p>
          )}
        </MenuContent>
      </Menu>
    </div>
  )
}
