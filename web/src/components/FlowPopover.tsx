/**
 * The item page's stage + turn chip (core/work/flow.ts). Stage and turn are
 * derived: this is the override for what the rules can't see ("waiting on
 * Niraj"). It holds until something newer happens to the item, and every
 * change lands in the item's timeline.
 */
import * as Popover from '@radix-ui/react-popover'
import { Undo2 } from 'lucide-react'
import { useState } from 'react'
import { STAGES, STAGE_LABEL, TURNS, TURN_LABEL, type ItemFlow, type Stage, type Turn } from '../../../core/work/flow.js'
import { usePortalContainer } from '../ui/portalContainer.js'

export function FlowPopover({ itemId, flow, onSaved }: { itemId: string; flow: ItemFlow; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const { anchorRef, container, resolve } = usePortalContainer(open)
  const [stage, setStage] = useState<Stage>(flow.stage)
  const [turn, setTurn] = useState<Turn>(flow.turn)
  const [note, setNote] = useState(flow.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const post = async (body: Record<string, unknown>) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/items/flow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: itemId, ...body }),
      })
      const b = (await res.json()) as { ok: boolean; error?: string }
      if (!b.ok) throw new Error(b.error ?? 'could not save')
      setOpen(false)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) {
          resolve()
          setStage(flow.stage)
          setTurn(flow.turn)
          setNote(flow.note ?? '')
          setError(null)
        }
        setOpen(o)
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={anchorRef}
          type="button"
          className={`pill flowPill turn-${flow.turn}${flow.overridden ? ' set' : ''}`}
          title={flow.overridden ? 'Set by you — click to change or go back to automatic' : 'Where it is and whose move it is — click to correct it'}
        >
          <span className="dot" aria-hidden="true" />
          {STAGE_LABEL[flow.stage]} · {TURN_LABEL[flow.turn]}
          {flow.next && flow.turn === 'me' && <span className="ask">· {flow.next}</span>}
          {flow.note && <span className="ask">· {flow.note}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content className="uiMenu flowPop" align="start" sideOffset={6} collisionPadding={12}>
          <div className="uiMenuCap">Stage</div>
          <div className="seg wrap" role="radiogroup" aria-label="Stage">
            {STAGES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={stage === s}
                className={`segBtn${stage === s ? ' active' : ''}`}
                onClick={() => setStage(s)}
              >
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
          <div className="uiMenuCap">Whose turn</div>
          <div className="seg wrap" role="radiogroup" aria-label="Whose turn">
            {TURNS.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={turn === t}
                className={`segBtn${turn === t ? ' active' : ''}`}
                onClick={() => setTurn(t)}
              >
                {TURN_LABEL[t]}
              </button>
            ))}
          </div>
          <input
            className="flowNote"
            value={note}
            maxLength={200}
            placeholder={turn === 'others' ? 'Waiting on whom, for what' : 'A note (optional)'}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void post({ stage, turn, note })
            }}
          />
          {error && <div className="msg error">{error}</div>}
          <div className="flowPopActs">
            {flow.overridden && (
              <button type="button" className="btn sm ghost" disabled={saving} onClick={() => void post({ clear: true })}>
                <Undo2 size={13} aria-hidden="true" /> Back to automatic
              </button>
            )}
            <button type="button" className="btn sm primary" disabled={saving} onClick={() => void post({ stage, turn, note })}>
              Set
            </button>
          </div>
          <div className="flowPopHint">Holds until something newer happens — a brief starts, a session ends.</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
