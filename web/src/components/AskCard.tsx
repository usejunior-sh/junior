import { memo, useState } from 'react'
import type { PermissionBehavior, QuestionAnswers } from '../../../shared/protocol.js'
import { OTHER, type AskQuestion } from '../askQuestions.js'
import type { TranscriptItem } from '../transcript.js'
import { JuniorLabel } from './JuniorLabel.js'

type Permission = Extract<TranscriptItem, { kind: 'permission' }>

type Props = {
  item: Permission
  questions: AskQuestion[]
  onRespond: (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => void
  /** Junior is the one asking (false: a subagent, named by the wrapper around the card) */
  junior?: boolean
}

/**
 * An `AskUserQuestion` prompt, rendered as the choices it is: one block per
 * question, options as clickable rows, and a single submit that hands the
 * picked labels back as the tool's answer.
 */
export const AskCard = memo(function AskCard({ item, questions, onRespond, junior = true }: Props) {
  // Keyed by question index: the tool allows two questions with the same text.
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const answerFor = (qi: number): string => {
    const labels = (picked[qi] ?? []).map((l) => (l === OTHER ? other[qi]?.trim() || '' : l))
    return labels.filter(Boolean).join(', ')
  }
  const complete = questions.every((_, qi) => answerFor(qi) !== '')

  const toggle = (q: AskQuestion, qi: number, label: string) => {
    setPicked((prev) => {
      const cur = prev[qi] ?? []
      if (!q.multiSelect) return { ...prev, [qi]: cur[0] === label ? [] : [label] }
      return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }

  const submit = () => {
    const answers: QuestionAnswers = {}
    questions.forEach((q, qi) => {
      answers[q.question] = answerFor(qi)
    })
    onRespond(item.id, 'allow', answers)
  }

  if (item.resolved) return <ResolvedAsk item={item} questions={questions} junior={junior} />

  return (
    <div className="perm ask" data-reload-guard="card">
      <div className="q">{junior ? <JuniorLabel mood="needs" say="I’ll wait for your answer"> has a question</JuniorLabel> : 'Asking'}</div>
      {questions.map((q, qi) => {
        const sel = picked[qi] ?? []
        return (
          <div className="askQ" key={qi}>
            {q.header && <span className="askHeader">{q.header}</span>}
            <div className="askText">{q.question}</div>
            {q.multiSelect && <div className="askNote">Pick any that apply</div>}
            <div className="askOptions">
              {[...q.options, { label: OTHER, description: 'Something else — type it below.' }].map(
                (o) => (
                  <button
                    key={o.label}
                    className={`askOption${sel.includes(o.label) ? ' on' : ''}`}
                    aria-pressed={sel.includes(o.label)}
                    onClick={() => toggle(q, qi, o.label)}
                  >
                    <span className="askLabel">{o.label}</span>
                    {o.description && <span className="askDesc">{o.description}</span>}
                  </button>
                ),
              )}
            </div>
            {sel.includes(OTHER) && (
              <input
                className="askOther"
                autoFocus
                placeholder="Your answer…"
                value={other[qi] ?? ''}
                onChange={(e) => setOther((p) => ({ ...p, [qi]: e.target.value }))}
              />
            )}
          </div>
        )
      })}
      <button className="btn primary" disabled={!complete} onClick={submit}>
        Send answer{questions.length > 1 ? 's' : ''}
      </button>
      {/* Denying is still on the table: the reader may want none of the above. */}
      <button className="btn" onClick={() => onRespond(item.id, 'deny')}>
        Don't answer
      </button>
    </div>
  )
})

function ResolvedAsk({ item, questions, junior }: { item: Permission; questions: AskQuestion[]; junior: boolean }) {
  return (
    <div className="perm ask">
      <div className="q">{junior ? <JuniorLabel mood="done" say={item.resolved === 'deny' ? 'You left this unanswered' : item.resolved === 'expired' ? 'This expired before you answered' : 'You answered this'}> asked</JuniorLabel> : 'Asked'}</div>
      {questions.map((q, qi) => (
        <div className="askQ" key={qi}>
          <div className="askText">{q.question}</div>
          {item.answers?.[q.question] ? (
            <div className="askAnswer">↳ {item.answers[q.question]}</div>
          ) : null}
        </div>
      ))}
      <span className={`verdict ${item.resolved}`}>
        {item.resolved === 'deny'
          ? '✕ left unanswered'
          : item.resolved === 'expired'
            ? '— expired (session ended before it was answered)'
            : item.answers
              ? '✓ answered'
              : '✓ allowed'}
      </span>
    </div>
  )
}
