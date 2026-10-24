/**
 * "Learned: … · Keep · Edit · Undo": one footer line at Junior's
 * propose_learning call, the way the Rule card sits at propose_approval.
 * Nothing is kept until Keep. Its state is read from the notebook's list by
 * id (web/src/learnings.ts), so a keep or forget anywhere shows here too.
 * Also exports the inline editor and the source link the notebook reuses.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { learningProposalOf, type Learning } from '../../../core/junior/learnings.js'
import type { TranscriptItem } from '../transcript.js'
import { editLearning, forgetLearning, keepLearning, useLearnings } from '../learnings.js'
import { editCutsTooMuch, footerState, latestSource, sourceLabel } from '../learnings-view.js'
import { openNotebook } from '../settings.js'

type Proposal = { key: string; learning: Learning }

/** The proposals among a run of tool calls: only answers that made a card (`shown`). */
function proposalsIn(tools: readonly TranscriptItem[]): Proposal[] {
  return tools.flatMap((t) => {
    if (t.kind !== 'tool' || !t.name.endsWith('__propose_learning') || !t.result || t.result.isError) return []
    const learning = learningProposalOf(t.result.text)
    return learning ? [{ key: t.key, learning }] : []
  })
}

export function LearnedLines({ tools }: { tools: readonly TranscriptItem[] }) {
  const list = proposalsIn(tools)
  if (!list.length) return null
  return (
    <>
      {list.map((p) => (
        <LearnedLine key={p.key} proposal={p.learning} />
      ))}
    </>
  )
}

type Busy = 'keep' | 'edit' | 'undo' | null

function LearnedLine({ proposal }: { proposal: Learning }) {
  const { learnings, loadedAt } = useLearnings()
  const [busy, setBusy] = useState<Busy>(null)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  // our own Undo: shown at once, before the list catches up
  const [undone, setUndone] = useState(false)
  const { state, learning } = undone ? { state: 'undone' as const, learning: proposal } : footerState(proposal, learnings, loadedAt)
  const ref = latestSource(learning)

  async function run(which: Exclude<Busy, null | 'edit'>) {
    setBusy(which)
    setErr(null)
    const r = which === 'keep' ? await keepLearning(learning.id) : await forgetLearning(learning.id)
    setBusy(null)
    if (!r.ok) return setErr(r.error)
    if (which === 'undo') setUndone(true)
  }

  if (state === 'undone') {
    return (
      <div className="learnedLine st-undone">
        <span className="llDot" aria-hidden="true" />
        <span className="llText">Undone. Junior won’t use this.</span>
      </div>
    )
  }

  if (editing) {
    return (
      <div className="learnedLine st-editing">
        <span className="llDot" aria-hidden="true" />
        <LearningEditor
          learning={learning}
          onDone={() => setEditing(false)}
          label="Edit what Junior learned"
        />
      </div>
    )
  }

  const notebookLink = (
    <button type="button" className="linkBtn" onClick={openNotebook}>
      Junior’s notebook
    </button>
  )

  return (
    <div className={`learnedLine st-${state}`}>
      <span className="llDot" aria-hidden="true" />
      <span className="llText">
        <span className="llKicker">{state === 'kept' ? 'Kept:' : 'Learned:'}</span> <span className="llWords">{learning.text}</span>
        {state === 'proposed' && ref && (
          <>
            {' · from '}
            <SourceLink sourceRef={ref} />
          </>
        )}
        {state === 'stale' && (
          <>
            {' '}
            <span className="pill yellow">stale</span>
          </>
        )}
        {state !== 'proposed' && <> · {notebookLink}</>}
      </span>
      {state === 'proposed' && (
        <span className="llActions">
          <button
            type="button"
            className="btn sm primary"
            disabled={busy !== null}
            aria-busy={busy === 'keep' || undefined}
            aria-label={`Keep: ${learning.text}`}
            onClick={() => void run('keep')}
          >
            Keep
          </button>
          <button type="button" className="btn sm ghost" disabled={busy !== null} aria-label={`Edit: ${learning.text}`} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy !== null}
            aria-busy={busy === 'undo' || undefined}
            aria-label={`Undo: ${learning.text}`}
            onClick={() => void run('undo')}
          >
            Undo
          </button>
        </span>
      )}
      {err && (
        <div className="msg error" role="alert">
          Couldn’t save. {err}
        </div>
      )}
    </div>
  )
}

/**
 * A learning's words as an input, in place: Enter saves, Esc cancels. An edit
 * that cuts more than half asks once ("Save anyway") and resends with confirm.
 * Editing never keeps a proposal.
 */
export function LearningEditor({ learning, onDone, label }: { learning: Learning; onDone: () => void; label: string }) {
  const [text, setText] = useState(learning.text)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  async function save(confirm: boolean) {
    const next = text.trim()
    if (!next) return setErr('A learning needs words.')
    if (next === learning.text) return onDone()
    if (!confirm && editCutsTooMuch(learning.text, next)) return setConfirming(true)
    setBusy(true)
    setErr(null)
    const r = await editLearning(learning.id, next, confirm)
    setBusy(false)
    if (!r.ok) return setErr(r.error)
    onDone()
  }

  return (
    <span className="llEdit">
      <input
        ref={input}
        className="llInput"
        type="text"
        value={text}
        readOnly={busy}
        aria-label={label}
        aria-describedby={hintId}
        onChange={(e) => {
          setText(e.target.value)
          setConfirming(false)
          setErr(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void save(confirming)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone()
          }
        }}
      />
      <span className="llActions">
        {confirming ? (
          <button type="button" className="btn sm primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void save(true)}>
            Save anyway
          </button>
        ) : (
          <button type="button" className="btn sm primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void save(false)}>
            Save
          </button>
        )}
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </span>
      <small id={hintId} className="llHint">
        {confirming ? 'That drops most of it. Save anyway?' : 'Enter saves. Esc cancels.'}
      </small>
      {err && (
        <div className="msg error" role="alert">
          Couldn’t save. {err}
        </div>
      )}
    </span>
  )
}

/** A receipt: a PR opens GitHub, a chat or an item opens here, a path is just mono text. */
export function SourceLink({ sourceRef }: { sourceRef: string }) {
  const s = sourceLabel(sourceRef)
  const cls = s.mono ? 'llSrc mono' : 'llSrc'
  if (s.href)
    return (
      <a className={cls} href={s.href} target="_blank" rel="noreferrer" title={s.title}>
        {s.label}
      </a>
    )
  if (s.hash)
    return (
      <a className={cls} href={`#${s.hash}`} title={s.title}>
        {s.label}
      </a>
    )
  return (
    <span className={cls} title={s.title}>
      {s.label}
    </span>
  )
}
