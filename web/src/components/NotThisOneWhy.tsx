/**
 * After "Not this one": a one-line notice in the row's slot asking why, with
 * three reason chips (.docs/overnight-2026-10-24/designs/not-this-one-reasons.md).
 * It fades after 5 s if you skip it (no reason is fine). Pick one and the
 * chips swap for the outcome line, which fades after 3 s. Hover or focus
 * pauses the fade. Two matching reasons for one repo and kind stop Junior
 * suggesting that kind there (core/junior/suggest.ts); the line says so and
 * links to Junior's notebook, where it can be cleared.
 *
 * Plain buttons in a group: no Radix primitive fits a one-shot pick, and the
 * fade is a timer, not a toast. Used on Suggested (`.hoGone`) and on the
 * ledger (`.jhGone`).
 */
import { useEffect, useRef, useState } from 'react'
import { kindWords } from '../../../core/work/corrections.js'
import { NOT_NOW_REASONS, REASON_WORDS, type NotNowReason, type Suppression } from '../../../core/junior/suggest.js'
import { openNotebook } from '../settings.js'
import { sayWhy } from '../suppressions.js'

/** How long the chips wait for a pick, and how long the outcome stays. */
export const WHY_ASK_MS = 5000
export const WHY_SAID_MS = 3000
/** The collapse, matched by `.ntoWhy.out` in junior.css. */
const OUT_MS = 120

const CHIP: Record<NotNowReason, string> = { 'not-mine': 'Not mine', 'too-small': 'Too small', handled: 'Already handled' }

type Phase = { at: 'ask' } | { at: 'saving' } | { at: 'error'; error: string } | { at: 'said'; reason: NotNowReason; suppression: Suppression | null }

export function NotThisOneWhy({
  item,
  how,
  variant,
  onDone,
}: {
  item: { id: string; title: string }
  /** a click moves focus to the first chip; a key press leaves it on the list, so a stray Enter can't pick */
  how: 'click' | 'key'
  variant: 'ho' | 'jh'
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ at: 'ask' })
  const [held, setHeld] = useState({ hover: false, focus: false })
  const [leaving, setLeaving] = useState(false)
  const [said, setSaid] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  /** our own move of focus to a chip doesn't hold the fade; a person's does */
  const autoFocused = useRef(false)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    // the live region exists before its text, so the line is read out
    const t = setTimeout(() => setSaid(`Not this one: ${item.title}. Pick a reason, or skip it.`), 50)
    if (how === 'click')
      requestAnimationFrame(() => {
        const chip = ref.current?.querySelector<HTMLElement>('.ntoChips button')
        if (!chip) return
        autoFocused.current = true
        chip.focus()
      })
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // fades only while asking or showing the outcome, and never while hovered or focused
  useEffect(() => {
    if (leaving || held.hover || held.focus) return
    if (phase.at !== 'ask' && phase.at !== 'said') return
    const t = setTimeout(() => setLeaving(true), phase.at === 'ask' ? WHY_ASK_MS : WHY_SAID_MS)
    return () => clearTimeout(t)
  }, [phase, held, leaving])
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => done.current(), OUT_MS)
    return () => clearTimeout(t)
  }, [leaving])

  const hold = (what: 'hover' | 'focus', on: boolean) => {
    if (what === 'focus' && on && autoFocused.current) {
      autoFocused.current = false
      return
    }
    setHeld((h) => (h[what] === on ? h : { ...h, [what]: on }))
  }

  async function pick(reason: NotNowReason) {
    setPhase({ at: 'saving' })
    const r = await sayWhy(item.id, reason)
    if (!r.ok) {
      setPhase({ at: 'error', error: r.error })
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.ntoChips button')?.focus())
      return
    }
    const line = outcome(reason, r.suppression)
    setPhase({ at: 'said', reason, suppression: r.suppression })
    setSaid(line)
    // the chip that had focus is gone: the link takes it when there is one, else focus is let go
    setHeld((h) => ({ ...h, focus: false }))
    if (r.suppression)
      requestAnimationFrame(() => {
        const a = ref.current?.querySelector<HTMLElement>('.ntoLink')
        if (!a) return
        autoFocused.current = true
        a.focus()
      })
  }

  const asking = phase.at !== 'said'
  return (
    <div
      ref={ref}
      className={`${variant === 'ho' ? 'hoGone' : 'jhGone'} ntoWhy${leaving ? ' out' : ''}`}
      onMouseEnter={() => hold('hover', true)}
      onMouseLeave={() => hold('hover', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold('focus', false)
      }}
    >
      {asking ? (
        <>
          <span className="w">Not this one. Why?</span>
          <div className="ntoChips" role="group" aria-label="Why not this one" aria-busy={phase.at === 'saving' || undefined}>
            {NOT_NOW_REASONS.map((r) => (
              <button key={r} type="button" className="btn xs ntoChip" disabled={phase.at === 'saving'} onClick={() => void pick(r)}>
                {CHIP[r]}
              </button>
            ))}
          </div>
          {phase.at === 'error' && (
            <div className="msg error ntoErr" role="alert">
              Couldn’t save the reason. {phase.error}
            </div>
          )}
        </>
      ) : (
        <span className="ntoSaid">
          {outcome(phase.reason, phase.suppression)}
          {phase.suppression && (
            <>
              {' '}
              <button type="button" className="ntoLink" onClick={() => openNotebook()}>
                See Junior’s notebook
              </button>
            </>
          )}
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  )
}

/** "Got it: too small." or, when it made a suppression, what Junior stops suggesting. */
export function outcome(reason: NotNowReason, s: Suppression | null): string {
  return s ? `Got it. I’ll stop suggesting ${kindWords(s.kind)} items in ${s.repo}.` : `Got it: ${REASON_WORDS[reason]}.`
}
