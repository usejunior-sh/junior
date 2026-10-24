/**
 * The drafted nudge, open for edits (plan item `nudge-ui`): the impact line,
 * the text in a box, and the way out. Used on the Junior page's Waiting row
 * (JuniorLedger, in its Nudge row) and on the item page's Needs you card.
 *
 * ⌘↩ (Ctrl↩ off a Mac) in the box sends exactly what the box holds; a plain
 * ↩ is a newline. Esc leaves the box. A source Junior can't reply on gets
 * Copy, then "I sent it", which only records it. Nothing here drafts.
 */
import { forwardRef, useEffect, useId, useState, type ReactNode } from 'react'
import type { ItemTask } from '../../../core/work/tasks.js'
import { isNudgeSendKey, nudgeFine, nudgeImpact, nudgeRows, nudgeSendFailed, type NudgeWay } from '../../../core/work/nudge-view.js'
import { MOD_LABEL } from '../keys.js'
import { sendNudge } from '../nudge.js'
import { ImpactLine } from './ActionCard.js'
import { taskVerb } from './item/useItemTasks.js'

const Kbd = ({ children }: { children: ReactNode }) => <kbd className="jhKbd">{children}</kbd>
const SEND_KEY = `${MOD_LABEL}↩`

type Props = {
  task: ItemTask
  person: string
  way: NudgeWay
  /** the box, held by the caller so closing a row keeps your edits */
  text: string
  onText: (text: string) => void
  /** it went out (or you marked it sent): the task as the server left it */
  onDone: (how: 'sent' | 'by-hand', task: ItemTask) => void
  /** Not now: the draft is skipped */
  onSkipped: () => void
}

export const NudgeEditor = forwardRef<HTMLTextAreaElement, Props>(function NudgeEditor({ task, person, way, text, onText, onDone, onSkipped }, ref) {
  const [busy, setBusy] = useState<'send' | 'skip' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const impactId = useId()
  const empty = !text.trim()

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  const send = async () => {
    if (busy || empty) return
    setBusy('send')
    setError(null)
    const r = await sendNudge(task.id, text, way === 'copy')
    setBusy(null)
    if (r.error !== undefined) return setError(nudgeSendFailed(r.error))
    onDone(way === 'copy' ? 'by-hand' : 'sent', r.task)
  }

  const skip = async () => {
    if (busy) return
    setBusy('skip')
    setError(null)
    const err = await taskVerb('skip', { id: task.id })
    setBusy(null)
    if (err) return setError(err)
    onSkipped()
  }

  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setError('Couldn’t copy. Select the text and copy it yourself.'))
  }

  return (
    <div className="ndg" data-reload-guard="edit">
      <ImpactLine id={impactId} parts={nudgeImpact(way)} />
      <textarea
        ref={ref}
        value={text}
        rows={nudgeRows(text)}
        aria-label={`Nudge to ${person}`}
        aria-describedby={impactId}
        disabled={busy === 'send'}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (isNudgeSendKey(e.nativeEvent)) {
            e.preventDefault()
            e.stopPropagation()
            void send()
            return
          }
          if (e.key === 'Escape') {
            // the first Esc leaves the box; the next one closes rows (JuniorLedger)
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.blur()
          }
        }}
      />
      <div className="ndgActs">
        {way === 'send' ? (
          <button type="button" className="btn sm primary" disabled={!!busy || empty} aria-busy={busy === 'send'} onClick={() => void send()}>
            {busy === 'send' ? 'Sending…' : 'Send'} <Kbd>{SEND_KEY}</Kbd>
          </button>
        ) : (
          <>
            <button type="button" className="btn sm" disabled={empty} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn sm primary" disabled={!!busy || empty} aria-busy={busy === 'send'} onClick={() => void send()}>
              I sent it <Kbd>{SEND_KEY}</Kbd>
            </button>
          </>
        )}
        <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void skip()}>
          Not now
        </button>
        <span className="cap">{nudgeFine(way)}</span>
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
    </div>
  )
})
