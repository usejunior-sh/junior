import { useState, type KeyboardEvent } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { ChevronRight, ExternalLink } from 'lucide-react'
import type { ItemTask } from '../../../../core/work/tasks.js'
import { VERDICTS, type VerdictKind } from '../../../../core/babysit/bot-triage.js'
import { claimOf, edited, emptyRows, fileLine, fileOf, firstLine, retryLine, rowsLeft, sendBody, sendLabel, startPicks, tally, VERDICT_LABEL, type BotReply, type RowPick } from '../../../../core/babysit/bot-card.js'
import { isMac } from '../../keys.js'
import { taskVerb } from './useItemTasks.js'

/**
 * Every bot reply on a PR, approved on one card (plan item `bot-triage-card`).
 * One dense row per thread, pre-selected to Junior's verdict; the reply opens
 * to edit. One button sends what's left; ⌘↩ anywhere in the card does too,
 * plain ↩ never. A row flipped to Fix becomes a fix task for Junior.
 * Edited text is what goes out, recorded in Junior's log like any send.
 */
export function BotTriageCard({ t, replies, fixing, onChanged }: {
  t: ItemTask
  replies: BotReply[]
  /** thread ids that already have a fix task on this item */
  fixing: ReadonlySet<string>
  onChanged: () => void
}) {
  const [picks, setPicks] = useState<Record<string, RowPick>>(() => startPicks(replies))
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handled = t.output?.handled ?? []
  const left = rowsLeft(replies, handled)
  const empty = emptyRows(left, picks)
  const counts = tally(left, picks)
  const canSend = !sending && left.length > 0 && empty.length === 0

  const pick = (id: string, p: Partial<RowPick>) => {
    setPicks((was) => ({ ...was, [id]: { ...was[id]!, ...p } }))
    // Typing keeps the reply open, even after an empty reply opened it on its own.
    if (p.reply !== undefined) setOpen((was) => ({ ...was, [id]: true }))
  }

  const send = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    const err = await taskVerb('send-bot-replies', sendBody(t.id, left, picks))
    setSending(false)
    if (err) setError(err)
    onChanged()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(isMac ? e.metaKey : e.ctrlKey)) return
    e.preventDefault()
    void send()
  }

  return (
    <div className="needCard btCard" onKeyDown={onKeyDown}>
      <div className="nTop">
        <span className="jrMark" aria-hidden="true">J</span>
        <span className="nTitle">{t.title}</span>
        {t.whyDetail && <span className="nMeta">{t.whyDetail}</span>}
      </div>
      <div className="btRows">
        {replies.map((r) => {
          const done = handled.includes(r.threadId)
          const p = picks[r.threadId] ?? { verdict: r.verdict, reply: r.reply }
          const isEmpty = empty.includes(r.threadId)
          return (
            <BotRow
              key={r.threadId}
              r={r}
              p={p}
              done={done ? (fixing.has(r.threadId) ? 'fix' : 'sent') : null}
              open={!done && p.verdict !== 'fix' && (isEmpty || !!open[r.threadId])}
              empty={isEmpty}
              disabled={sending}
              onOpen={(o) => setOpen((was) => ({ ...was, [r.threadId]: o }))}
              onPick={(next) => pick(r.threadId, next)}
            />
          )
        })}
      </div>
      <div className="nActs btActs">
        <button type="button" className="btn xs primary" disabled={!canSend} aria-busy={sending || undefined} onClick={() => void send()}>
          {sending ? 'Sending…' : sendLabel(counts)}
        </button>
        <span className="nFine btHint">each reply goes as shown · {isMac ? '⌘↩' : 'Ctrl↩'}</span>
      </div>
      {error ? (
        <div className="notice btNotice" role="alert">{error}</div>
      ) : t.error && handled.length > 0 && left.length > 0 ? (
        <div className="notice btNotice" role="status">{retryLine(left.length, t.error)}</div>
      ) : null}
    </div>
  )
}

function BotRow({ r, p, done, open, empty, disabled, onOpen, onPick }: {
  r: BotReply
  p: RowPick
  /** sent on an earlier press, or turned into a fix */
  done: 'sent' | 'fix' | null
  open: boolean
  empty: boolean
  disabled: boolean
  onOpen: (open: boolean) => void
  onPick: (p: Partial<RowPick>) => void
}) {
  const claim = claimOf(r)
  const file = fileOf(r)
  const fix = p.verdict === 'fix'
  const locked = disabled || done !== null
  const canOpen = !done && !fix
  const thread = r.url && (
    <a className="btThread" href={r.url} target="_blank" rel="noreferrer">
      thread <ExternalLink size={11} aria-hidden="true" />
    </a>
  )

  return (
    <Collapsible.Root open={open} onOpenChange={(o) => canOpen && onOpen(o)} disabled={!canOpen} className={`btRow${done ? ' done' : ''}${fix ? ' fix' : ''}`}>
      <span className="btFile" title={r.path ?? undefined}>{fileLine(r)}</span>
      <span className="btClaim" title={claim}>{claim}</span>
      {done ? (
        <span className={`btDone ${done}`}>{done === 'sent' ? 'Sent' : 'To fix'}</span>
      ) : (
        <RadioGroup.Root
          className="btVerdict"
          aria-label={`Verdict on ${file}`}
          value={p.verdict}
          onValueChange={(v) => onPick({ verdict: v as VerdictKind })}
          orientation="horizontal"
          disabled={locked}
        >
          {VERDICTS.map((v) => (
            <RadioGroup.Item key={v} value={v} className={`btOpt${v === r.verdict ? ' jrPick' : ''}`} title={v === r.verdict ? 'Junior’s pick' : undefined}>
              {VERDICT_LABEL[v]}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      )}
      <Collapsible.Trigger className="btChev" aria-label={`Edit the reply on ${file}`} disabled={!canOpen}>
        <ChevronRight size={14} aria-hidden="true" />
      </Collapsible.Trigger>
      <div className="btBelow">
        {done ? (
          <>
            <span className="btPreview">{done === 'sent' ? firstLine(p.reply) : 'A fix task for Junior.'}</span>
            {thread}
          </>
        ) : fix ? (
          <>
            <span className="btPreview">Becomes a fix task for Junior.</span>
            {thread}
          </>
        ) : !open ? (
          <>
            <Collapsible.Trigger className="btPreview btPeek" disabled={disabled}>{firstLine(p.reply)}</Collapsible.Trigger>
            {thread}
          </>
        ) : null}
        <Collapsible.Content className="btReply">
          <div className="nRec">
            <div className="nRecHead">
              Reply{edited(r, p) ? ' · edited' : ''}
              {thread}
            </div>
            <textarea
              value={p.reply}
              disabled={locked}
              aria-label={`Reply on ${file}`}
              autoFocus={open && !empty}
              rows={Math.min(8, Math.max(2, p.reply.split('\n').length + 1))}
              onChange={(e) => onPick({ reply: e.target.value })}
            />
          </div>
          {empty && <div className="btEmpty">Write a reply, or pick Fix.</div>}
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  )
}
