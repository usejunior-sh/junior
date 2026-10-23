/**
 * The one line under the top bar when the daemon changed build but reloading
 * now would cost you something on screen: a draft, a card waiting on you, an
 * unsaved edit (.docs/overnight-2026-10-24/designs/reload-on-build-change.md).
 * When nothing is in flight the page reloads by itself and this never shows.
 *
 * Neutral ink only: nothing needs you (no orange), Junior isn't acting (no
 * sky), and it isn't a warning (no yellow). An unsaved edit gets one inline
 * confirm, swapped into the same line, never a dialog over your work.
 */
import { RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Build } from '../../../shared/protocol.js'
import { MOD_LABEL, isMac } from '../keys.js'
import { reloadBlockers } from '../reloadGuard.js'
import { buildKey } from '../reloadOnBuild.js'
import { Tooltip } from '../ui/Tooltip.js'

type Props = {
  /** the build waiting for a reload; null renders nothing but the live region */
  pending: Build | null
  mobile: boolean
  onReload: () => void
  onHide: () => void
}

const SENTENCE = 'Junior was updated.'
const SECOND = 'Reload to use the new version.'

export function UpdateBar({ pending, mobile, onReload, onHide }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [reloading, setReloading] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)
  const reloadRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)

  // Confirm takes focus on its safe choice; leaving it hands focus back to Reload.
  useEffect(() => {
    if (confirming) keepRef.current?.focus()
    else if (wasConfirming.current) reloadRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  // A newer build while confirming (or the bar going away) starts over.
  const key = pending ? buildKey(pending) : ''
  useEffect(() => setConfirming(false), [key])

  const reload = () => {
    setReloading(true)
    onReload()
  }
  const tryReload = () => (reloadBlockers().has('edit') ? setConfirming(true) : reload())
  const onKeyDown = (e: KeyboardEvent) => {
    if (confirming && e.key === 'Escape') {
      e.stopPropagation()
      setConfirming(false)
    }
  }

  const version = pending ? `v${pending.version}` : ''
  const versionTitle = pending ? `${pending.version}${pending.dirty ? ' (uncommitted changes)' : ''}` : ''

  return (
    <>
      {/* Announced once, never taking focus: you may be mid-sentence in a composer. */}
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? (mobile ? SENTENCE : `${SENTENCE} ${SECOND}`) : ''}
      </span>
      {pending && (
        <div className="updateBar" onKeyDown={onKeyDown}>
          <RotateCw size={14} className="ubIc" aria-hidden="true" />
          {confirming ? (
            <span className="ubText">{mobile ? 'Drops your unsaved edit.' : 'Reloading drops your unsaved edit.'}</span>
          ) : (
            <>
              <span className="ubText">
                {SENTENCE}
                {!mobile && <span className="ubMore"> {SECOND}</span>}
              </span>
              {!mobile && (
                // The tooltip is for the pointer. A screen reader already reads the
                // whole version (the ellipsis is only CSS) plus the sr-only note.
                <Tooltip content={versionTitle} side="bottom">
                  <span className="ubVer">
                    {version}
                    {pending?.dirty && <span className="sr-only"> (uncommitted changes)</span>}
                  </span>
                </Tooltip>
              )}
            </>
          )}
          <span className="ubActs">
            {confirming ? (
              <>
                <button ref={keepRef} type="button" className="btn xs" onClick={() => setConfirming(false)}>
                  Keep editing
                </button>
                <button type="button" className="btn xs" disabled={reloading} onClick={reload}>
                  {reloading ? 'Reloading…' : mobile ? 'Reload' : 'Reload anyway'}
                </button>
              </>
            ) : (
              <>
                <button
                  ref={reloadRef}
                  type="button"
                  className="btn xs"
                  disabled={reloading}
                  onClick={tryReload}
                  aria-keyshortcuts={isMac ? 'Meta+R' : 'Control+R'}
                >
                  {reloading ? 'Reloading…' : 'Reload'}
                  {!mobile && !reloading && (
                    <kbd className="ubKbd" aria-hidden="true">
                      {MOD_LABEL}R
                    </kbd>
                  )}
                </button>
                <Tooltip content="Hide until the next update" side="bottom" align="end">
                  <button type="button" className="topIcon" aria-label="Hide until the next update" onClick={onHide}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
              </>
            )}
          </span>
        </div>
      )}
    </>
  )
}
