/**
 * A PR handed off while its watch is off (design note:
 * .docs/overnight-2026-10-24/designs/handoff-readiness-ui.md): the Turn on
 * button with its spend limit, and the note Suggested shows right after such
 * a hand-off. Neutral throughout: a switched-off watch isn't Junior waiting on
 * you, so nothing here is orange. Turning on is the Settings → Automations
 * switch (PUT /api/settings), a local setting, never a send.
 */
import { X } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type ReactNode, type Ref } from 'react'
import type { ScoredItem, WatchId } from '../../../shared/protocol.js'
import { capsFrom, capText, turnOnTitle, WATCH_OFF_SAYS, WATCH_ON_SAYS, WATCH_STILL_OFF, type WatchCaps } from '../../../core/junior/watch-off.js'
import { turnOnWatch } from '../handoff.js'

// The spend limits, fetched once and only when a watch-off row first renders.
// undefined = not asked yet; null = unknown (the fetch failed): the title then
// points at Settings instead of naming a number.
let caps: WatchCaps | null | undefined
let asking = false
const capsSubs = new Set<() => void>()

export function useWatchCaps(): WatchCaps | null {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    capsSubs.add(rerender)
    if (caps === undefined && !asking) {
      asking = true
      void fetch('/api/babysit/settings')
        .then((r) => r.json())
        .then((b: unknown) => (caps = capsFrom(b)))
        .catch(() => (caps = null))
        .finally(() => {
          asking = false
          for (const f of capsSubs) f()
        })
    }
    return () => void capsSubs.delete(rerender)
  }, [])
  return caps ?? null
}

/** "Up to $20 a day" next to the button, in mono (it's data); nothing while unknown. */
export function WatchCap({ watch, id }: { watch: WatchId; id: string }) {
  const text = capText(watch, useWatchCaps())
  return text ? (
    <span className="cap" id={id}>
      {text}
    </span>
  ) : null
}

/** The Turn on button: the switch's limits in its title, the cap (by id) read to screen readers. */
export function TurnOnButton({
  watch,
  busy,
  onClick,
  className,
  capId,
  children,
  buttonRef,
}: {
  watch: WatchId
  busy: boolean
  onClick: () => void
  className: string
  capId: string
  children: ReactNode
  buttonRef?: Ref<HTMLButtonElement>
}) {
  const known = useWatchCaps()
  return (
    <button
      ref={buttonRef}
      type="button"
      className={className}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-describedby={capText(watch, known) ? capId : undefined}
      title={turnOnTitle(watch, known)}
      onClick={onClick}
    >
      {busy ? 'Turning on…' : children}
    </button>
  )
}

/** The latest hand-off whose watch was off. */
export type WatchOffNoteState = { itemId: string; title: string; watch: WatchId }

/**
 * The inline note under Suggested's heading, right after a hand-off with the
 * watch off: Turn on or Not now. One at a time, for the latest hand-off. It
 * switches to its "on" line once the watch is on, from here or elsewhere.
 * Always mounted: its status line must exist before it speaks, and it speaks
 * the sentence only, not the buttons.
 */
export function WatchOffNote({ note, ...rest }: { note: WatchOffNoteState | null; items: readonly ScoredItem[]; onDismiss: () => void; onError: (error: string | null) => void }) {
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (!note) setSaid('')
  }, [note])
  return (
    <>
      <span className="sr-only" role="status">
        {said}
      </span>
      {note && <Note key={note.itemId} note={note} onSay={setSaid} {...rest} />}
    </>
  )
}

function Note({
  note,
  items,
  onDismiss,
  onError,
  onSay,
}: {
  note: WatchOffNoteState
  items: readonly ScoredItem[]
  onDismiss: () => void
  onError: (error: string | null) => void
  onSay: (text: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [turned, setTurned] = useState(false)
  const turnRef = useRef<HTMLButtonElement>(null)
  const dismissRef = useRef<HTMLButtonElement>(null)
  const item = items.find((i) => i.id === note.itemId)
  const on = turned || item?.junior?.readiness?.state === 'ready'
  const capId = `watchCap-${note.itemId}`
  const lost = () => !document.activeElement || document.activeElement === document.body

  // a new note (keyed by item): its hand-off button left with the row, so focus would be lost; catch it here
  useEffect(() => {
    requestAnimationFrame(() => lost() && turnRef.current?.focus())
  }, [])
  // on: the Turn on button is gone, so the dismiss takes its focus
  useEffect(() => {
    onSay(on ? WATCH_ON_SAYS[note.watch] : `Handed off “${note.title}”. ${WATCH_OFF_SAYS[note.watch]}`)
    if (on) requestAnimationFrame(() => lost() && dismissRef.current?.focus())
  }, [on, note.title, note.watch])

  const turnOn = () => {
    setBusy(true)
    onError(null)
    void turnOnWatch(note.watch).then((err) => {
      setBusy(false)
      if (err) onError(`${WATCH_STILL_OFF[note.watch]} ${err}`)
      else setTurned(true)
    })
  }

  return (
    <div className="jrNote">
      <span className="k" aria-hidden="true">
        <span className="jrDot" />
      </span>
      <p className="tx">
        {on ? (
          WATCH_ON_SAYS[note.watch]
        ) : (
          <>
            Handed off “<span className="ti">{note.title}</span>”. {WATCH_OFF_SAYS[note.watch]}
            <WatchCap watch={note.watch} id={capId} />
          </>
        )}
      </p>
      <div className="acts">
        {on ? (
          <button ref={dismissRef} type="button" className="iconBtn sm" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : (
          <>
            <TurnOnButton watch={note.watch} busy={busy} onClick={turnOn} className="btn xs" capId={capId} buttonRef={turnRef}>
              Turn on
            </TurnOnButton>
            <button type="button" className="btn xs ghost" onClick={onDismiss}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  )
}
