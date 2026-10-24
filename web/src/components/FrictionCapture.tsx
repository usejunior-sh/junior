/**
 * ⌘⇧. "What annoyed you?": one line, ↵ files it as a manual item labelled
 * `friction`, due Later, with where you were in its description. Esc closes
 * with nothing filed, and focus goes back where it was. The in-app sibling of
 * Junior.app's Quick capture (desktop/src/capture.ts), with context.
 * Design note: .docs/overnight-2026-10-24/designs/friction-capture.md.
 */
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ManualItemResponse, SessionSummary } from '../../../shared/protocol.js'
import { FRICTION_MAX, frictionContext, frictionDescription, frictionError, frictionTitle, shortId, type FrictionWhere } from '../friction.js'
import type { Route } from '../hooks.js'
import { focusedItemId } from '../selection.js'

/** How long "✓ Noted for later" holds before the popover closes (Quick capture's). */
const DONE_HOLD_MS = 500

type Status = { phase: 'idle' } | { phase: 'saving' } | { phase: 'done' } | { phase: 'error'; error: string }

/** Where you are: the page, the raw hash, and the item in focus. */
function whereNow(route: Route, sessions: readonly SessionSummary[]): FrictionWhere {
  return { page: route.page, hash: location.hash, selected: focusedItemId(route, sessions) }
}

export function FrictionCapture({
  open,
  onOpenChange,
  route,
  sessions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  route: Route
  sessions: readonly SessionSummary[]
}) {
  // the draft outlives an accidental Esc (memory only), until it's filed or the page reloads
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<Status>({ phase: 'idle' })
  const [where, setWhere] = useState<FrictionWhere | null>(null)
  const [said, setSaid] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const returnTo = useRef<Element | null>(null)
  const clickedOut = useRef(false)
  const filed = useRef(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const ctxId = useId()

  // Context is taken at open, not at submit: the page you were annoyed on.
  const live = useRef({ route, sessions })
  live.current = { route, sessions }
  useLayoutEffect(() => {
    if (open) {
      setWhere(whereNow(live.current.route, live.current.sessions))
      setStatus({ phase: 'idle' })
      setSaid('')
      clickedOut.current = false
      return
    }
    window.clearTimeout(closeTimer.current)
    if (filed.current) {
      filed.current = false
      setDraft('')
    }
    setStatus({ phase: 'idle' })
  }, [open])
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  async function file() {
    if (status.phase === 'saving' || status.phase === 'done' || !where) return
    const title = frictionTitle(draft)
    if (!title) return
    setStatus({ phase: 'saving' })
    setSaid('')
    let body: ManualItemResponse | null = null
    try {
      const res = await fetch('/api/items/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description: frictionDescription(where), label: 'friction', due: 'later' }),
      })
      body = (await res.json()) as ManualItemResponse
    } catch {
      body = null
    }
    if (body?.ok) {
      filed.current = true
      setStatus({ phase: 'done' })
      setSaid("Noted for later. It's in your inbox.")
      closeTimer.current = window.setTimeout(() => onOpenChange(false), DONE_HOLD_MS)
      return
    }
    const error = frictionError(body && !body.ok ? body.error : null)
    setStatus({ phase: 'error', error })
    setSaid(error)
    input.current?.focus()
  }

  const ctx = where ? frictionContext(where) : null
  const busy = status.phase === 'saving' || status.phase === 'done'

  return (
    <>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Anchor asChild>
          <span className="frictionAnchor" aria-hidden="true" />
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            className="uiMenu frictionPop"
            side="bottom"
            align="center"
            sideOffset={0}
            collisionPadding={12}
            aria-label="Note what annoyed you"
            onOpenAutoFocus={(e) => {
              // Whatever had focus now is where it goes back to (the palette and `?` have closed by here).
              e.preventDefault()
              returnTo.current = document.activeElement
              input.current?.focus()
              input.current?.select() // a kept draft is replaced by typing
            }}
            onInteractOutside={() => {
              clickedOut.current = true
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              // a click or Tab elsewhere put focus where you meant; otherwise back where it was, if that is still there
              const el = returnTo.current
              returnTo.current = null
              if (clickedOut.current) return
              if (el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus({ preventScroll: true })
            }}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void file()
              }}
            >
              <input
                ref={input}
                className="frictionLine"
                type="text"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  if (status.phase === 'error') setStatus({ phase: 'idle' })
                }}
                readOnly={busy}
                maxLength={FRICTION_MAX}
                placeholder="What annoyed you?"
                aria-label="What annoyed you?"
                aria-describedby={ctxId}
                autoComplete="off"
                autoCapitalize="sentences"
                spellCheck
                enterKeyHint="done"
              />
              <div className="frictionFoot">
                <span className={`fpLeft${status.phase === 'error' ? ' err' : ''}`} id={ctxId}>
                  {status.phase === 'done' ? (
                    <>
                      <span className="ok" aria-hidden="true">
                        ✓
                      </span>{' '}
                      Noted for later
                    </>
                  ) : status.phase === 'error' ? (
                    status.error
                  ) : ctx ? (
                    <>
                      {ctx.place}
                      {ctx.selected && (
                        <>
                          <span className="dot"> · </span>selected{' '}
                          <span className="id" title={ctx.selected}>
                            {shortId(ctx.selected)}
                          </span>
                        </>
                      )}
                    </>
                  ) : null}
                </span>
                {status.phase === 'saving' ? (
                  <span className="fpHint">Noting…</span>
                ) : status.phase === 'error' ? (
                  <span className="fpHint fpKeys">
                    <kbd>↵</kbd> try again
                  </span>
                ) : status.phase === 'idle' ? (
                  <span className="fpHint fpKeys">
                    <kbd>↵</kbd> note <span className="dot">·</span> <kbd>esc</kbd> close
                  </span>
                ) : null}
              </div>
            </form>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {/* outside the popover, so "Noted" is still read after it closes */}
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
    </>
  )
}
