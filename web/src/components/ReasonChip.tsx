/**
 * The reason chip (.docs/overnight-2026-10-24/designs/reason-chip.md): a row's
 * score as a sum you can check, and three corrections when the order is wrong.
 * The chip is a hairline pill with the parts in mono and the total; it opens a
 * Radix Popover with every part (weights you set tagged "you set this", each
 * with Clear) and the corrections from core/work/corrections.ts. A correction
 * writes a weight through /api/score-weights; the server drops its inbox
 * snapshot and sends `inbox_changed`, so the list re-ranks on its own. Nothing
 * here sends anything anywhere.
 *
 * Controlled like SnoozeMenu (`open` / `onOpenChange`), so the ledger's W key
 * can open it. `onSaved` gets the line to announce; without it the chip has
 * its own polite status.
 */
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { ScoredItem } from '../../../shared/protocol.js'
import { correctionsFor, displayParts, pressedLine, type Correction } from '../../../core/work/corrections.js'
import { signed, WEIGHT_TTL_DAYS } from '../../../core/work/weights.js'
import { openNotebook } from '../settings.js'
import { usePortalContainer } from '../ui/portalContainer.js'
import { clearWeight, setWeight, useWeights } from '../weights.js'

export function ReasonChip({
  item,
  me,
  open,
  onOpenChange,
  onSaved,
}: {
  item: ScoredItem
  /** your login: no "This person matters" on your own rows */
  me: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** after a save or clear, with the line to announce ("Saved: +20 you said @priya matters. …") */
  onSaved?: (said: string) => void
}) {
  const [self, setSelf] = useState(false)
  const isOpen = open ?? self
  const setOpen = (o: boolean) => {
    if (open === undefined) setSelf(o)
    onOpenChange?.(o)
  }
  const { anchorRef, container, resolve } = usePortalContainer(isOpen)
  const [said, setSaid] = useState('')
  // an older server sends no parts: the plain line, no chip
  if (!item.rankParts?.length) return <span className="rsnPlain">{item.rankWhy}</span>
  const { parts, total } = displayParts(item.rankParts)
  const done = (line: string) => {
    setOpen(false)
    if (onSaved) onSaved(line)
    else setSaid(line)
  }
  return (
    <>
      <Popover.Root
        open={isOpen}
        onOpenChange={(o) => {
          if (o) resolve()
          setOpen(o)
        }}
      >
        <Popover.Trigger asChild>
          <button ref={anchorRef} type="button" className="rsnChip" aria-label={`Why it ranked here: ${total} points. Open to see the sum and correct it.`}>
            <span className="ps" aria-hidden="true">
              {parts.map((p, n) => (
                <span key={n}>
                  {n > 0 && <i className="sep"> · </i>}
                  {signed(p.shown)} {p.label}
                </span>
              ))}
            </span>
            <span className="tot" aria-hidden="true">
              = {total}
            </span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal container={container}>
          <ReasonPop item={item} me={me} onDone={done} onLeave={() => setOpen(false)} />
        </Popover.Portal>
      </Popover.Root>
      {!onSaved && (
        <span className="sr-only" role="status" aria-live="polite">
          {said}
        </span>
      )}
    </>
  )
}

function ReasonPop({ item, me, onDone, onLeave }: { item: ScoredItem; me: string | null; onDone: (said: string) => void; onLeave: () => void }) {
  const { weights } = useWeights()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const uid = useId()
  const now = Date.now()
  const { parts, total } = displayParts(item.rankParts ?? [])
  const fixes = correctionsFor(item, me, weights ?? [])
  // the signed line the server built for a weight on this row: never rebuilt from the key
  const partLine = (key: string) => {
    const p = item.rankParts?.find((x) => x.weight === key)
    return p ? `${signed(p.points)} ${p.label}` : key
  }

  const clear = async (key: string) => {
    setBusy(true)
    setError(null)
    const r = await clearWeight(key)
    setBusy(false)
    if (!r.ok) return setError(`Couldn't clear. ${r.error}`)
    onDone(`Cleared: ${partLine(key)}.`)
  }
  const press = async (c: Correction) => {
    if (c.pressed) return clear(c.key)
    setBusy(true)
    setError(null)
    const r = await setWeight({ key: c.key, delta: c.delta, ...(c.reason ? { reason: c.reason } : {}) })
    setBusy(false)
    if (!r.ok) return setError(`Couldn't save. ${r.error}`)
    onDone(`Saved: ${r.weight?.label ?? c.label}. The list re-ranks now.`)
  }

  return (
    <Popover.Content
      ref={ref}
      className="uiMenu rsnPop"
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={12}
      tabIndex={-1}
      aria-labelledby={`${uid}-h`}
      // focus the surface, not the first button: a second ⏎ must never set a weight by accident
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        ref.current?.focus()
      }}
    >
      <h4 id={`${uid}-h`}>Why it's here</h4>
      <ul className="rsnParts">
        {parts.map((p, n) => (
          <li key={n} className={p.weight ? 'w' : undefined}>
            <span className="pt">{signed(p.shown)}</span>
            <span className="lb">
              <span>{p.label}</span>
              {p.weight && (
                <>
                  <span className="rsnTag">you set this</span>
                  <button type="button" className="jhKey clr" disabled={busy} aria-label={`Clear: ${partLine(p.weight)}`} onClick={() => void clear(p.weight!)}>
                    Clear
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
        <li className="tot">
          <span className="pt">{total}</span>
          <span className="lb">total</span>
        </li>
      </ul>
      {fixes.length > 0 && (
        <div className="rsnFix" aria-busy={busy || undefined}>
          <div className="cap">Is the order wrong?</div>
          {fixes.map((c) => (
            <div key={c.id} className="row">
              <button type="button" className="btn sm" aria-pressed={c.pressed} aria-describedby={`${uid}-${c.id}`} disabled={busy} onClick={() => void press(c)}>
                {c.pressed && <Check size={12} aria-hidden="true" />}
                {c.label}
              </button>
              <span className="fx" id={`${uid}-${c.id}`}>
                {c.pressed ? pressedLine(c.setAt, now) : c.effect}
              </span>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="msg error" role="alert">
          {error}
        </div>
      )}
      <div className="rsnFoot">
        {busy ? (
          'Saving…'
        ) : (
          <>
            Counts for {WEIGHT_TTL_DAYS} days.{' '}
            <a
              href="#/settings/approvals"
              onClick={(e) => {
                e.preventDefault()
                onLeave()
                openNotebook()
              }}
            >
              See all in Junior's notebook.
            </a>
          </>
        )}
      </div>
    </Popover.Content>
  )
}
