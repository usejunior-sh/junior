import { X, Plus, Zap } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import type { TeamRunView } from '../../../../shared/protocol.js'
import { type TeamPermissions, TEAM_PERMISSIONS } from '../../../../core/teams/recipe.js'
import { FAST_MODE_BLURB } from '../../fastMode.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { teamsCall, PERMISSION_META } from '../../teams.js'
import { errText, wireCard } from './shared.js'

// ---------------------------------------------------------------------------
// The side drawer: everything, editable in place while the card is proposed
// ---------------------------------------------------------------------------

/** Reads as text; a click makes it a field; Enter or leaving it saves, Escape drops the change. */
export function Editable({
  value,
  onCommit,
  placeholder,
  disabled,
  mono,
  multiline,
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  const cancelled = useRef(false)
  useEffect(() => {
    if (!editing) setV(value)
  }, [value, editing])
  const cls = `edText${mono ? ' mono' : ''}`
  if (disabled) return <div className={cls}>{value || <span className="muted">{placeholder}</span>}</div>
  if (!editing)
    return (
      <button type="button" className={`${cls} on`} onClick={() => ((cancelled.current = false), setEditing(true))} title="Click to edit">
        {value || <span className="muted">{placeholder}</span>}
      </button>
    )
  return (
    <textarea
      autoFocus
      className={`edInput${mono ? ' mono' : ''}`}
      rows={multiline ? Math.min(6, Math.max(2, Math.ceil(v.length / 38))) : 1}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        setEditing(false)
        if (!cancelled.current && v.trim() !== value) onCommit(v.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** A list of one-liners, each editable, with add and remove. */
export function EditList({ items, onChange, disabled, add }: { items: string[]; onChange: (xs: string[]) => void; disabled: boolean; add: string }) {
  const [adding, setAdding] = useState(false)
  return (
    <ul className="edList">
      {items.map((x, i) => (
        <li key={`${i}:${x}`}>
          <Editable value={x} disabled={disabled} multiline onCommit={(v) => onChange(v ? items.map((y, n) => (n === i ? v : y)) : items.filter((_, n) => n !== i))} />
          {!disabled && (
            <button type="button" className="iconBtn edDel" aria-label="Remove" onClick={() => onChange(items.filter((_, n) => n !== i))}>
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
      {!disabled &&
        (adding ? (
          <li>
            <Editable value="" placeholder={add} multiline onCommit={(v) => (setAdding(false), v && onChange([...items, v]))} />
          </li>
        ) : (
          <li>
            <button type="button" className="edAdd" onClick={() => setAdding(true)}>
              <Plus size={11} aria-hidden="true" /> {add}
            </button>
          </li>
        ))}
    </ul>
  )
}

/**
 * Fast mode for every agent on the team — premium speed, premium price. Before approval it's
 * on the card; while the run goes, it switches every worker session at once.
 */
export function TeamFastToggle({ run, onError }: { run: TeamRunView; onError?: (e: string | null) => void }) {
  const [want, setWant] = useState<boolean | null>(null)
  useEffect(() => setWant(null), [run.rev])
  const on = want ?? run.card.fast
  const ended = run.state === 'done' || run.state === 'stopped'
  return (
    <button
      type="button"
      className={`chip fast${on ? ' on' : ''}`}
      aria-pressed={on}
      disabled={ended}
      title={on ? 'Fast mode is on for every agent on the team — premium price. Click to turn it off.' : `Fast mode for every agent on the team — ${FAST_MODE_BLURB}`}
      onClick={() => {
        setWant(!on)
        onError?.(null)
        teamsCall('PUT', 'fast', { runId: run.id, fast: !on }).catch((err) => {
          setWant(null)
          onError?.(errText(err))
        })
      }}
    >
      <Zap size={12} aria-hidden="true" />
      <span className="name">Fast</span>
    </button>
  )
}

/** The dock's pick: what the workers may do without asking. Saved on the card as you choose. */
export function PermissionSelect({ run, disabled, onError }: { run: TeamRunView; disabled: boolean; onError: (e: string | null) => void }) {
  const [picked, setPicked] = useState<TeamPermissions | null>(null)
  useEffect(() => setPicked(null), [run.rev])
  const value = picked ?? run.card.permissions
  return (
    <Select
      className="teamSel tdPerms"
      aria-label="What the team may do without asking"
      placeholder="Permissions…"
      value={value ?? undefined}
      disabled={disabled}
      onValueChange={(v) => {
        const p = v as TeamPermissions
        setPicked(p)
        onError(null)
        teamsCall('PUT', 'card', { runId: run.id, card: wireCard({ ...run.card, permissions: p }) }).catch((err) => {
          setPicked(null)
          onError(errText(err))
        })
      }}
    >
      {TEAM_PERMISSIONS.map((p) => (
        <SelectItem key={p} value={p} description={PERMISSION_META[p].hint}>
          {PERMISSION_META[p].label}
        </SelectItem>
      ))}
    </Select>
  )
}
