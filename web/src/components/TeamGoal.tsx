import * as Collapsible from '@radix-ui/react-collapsible'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GoalHorizonKind, GoalQuestion, RunGoal, TeamRunView, WorkerRun } from '../../../shared/protocol.js'
import { horizonText } from '../../../core/teams/engine.js'
import { teamsCall, usd } from '../teams.js'

/**
 * A team run that is a goal (.docs/junior-goals-teams/modes-autonomy-goals.md):
 * the done-when Junior judges, the horizon, and what only you do, answer
 * Junior's questions, raise the budget, accept the result or say what's missing.
 *
 *   GoalAsks       above the composer, on the lead: Junior's open questions, each with its recommended answer
 *   RaiseBudget    in the dock at a budget pause: how much more, then resume
 *   ResultActions  in the dock when Junior says it's done: accept, or "not yet" with what's missing
 *   GoalSide       the drawer's goal section: the done-when (editable before approval), the horizon, the history
 */

/** "Resumed by Junior" / "Resumed by you": who got the team moving into this run. */
export function ResumedTag({ by, long }: { by: WorkerRun['resumedBy']; long?: boolean }) {
  if (!by) return null
  const who = by === 'junior' ? 'Junior' : 'you'
  return (
    <span className={`resumedTag ${by}`} title={`Resumed by ${who} — the ledger says why`}>
      ↻ {long ? `Resumed by ${who}` : who}
    </span>
  )
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const goalCall = (verb: 'answer' | 'accept' | 'reopen' | 'wake', body: unknown) => teamsCall<{ ok: true }>('POST', `goal/${verb}`, body)
const clock = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** "looks again at Fri 14:20", or "in 12 min" when it's soon. */
export function wakeText(until: number, now = Date.now()): string {
  const min = Math.round((until - now) / 60_000)
  if (min <= 0) return 'looking again now'
  if (min < 60) return `looks again in ${min} min`
  return `looks again ${clock(until)}`
}

function Ask({ run, q }: { run: TeamRunView; q: GoalQuestion }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = (answer: string) => {
    if (!answer.trim()) return
    setBusy(true)
    setError(null)
    goalCall('answer', { runId: run.id, questionId: q.id, answer })
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="goalAsk">
      <div className="gaQ">
        <span className="dot yellow" aria-hidden="true" />
        <span className="gaText">{q.text}</span>
      </div>
      <div className="gaRec">
        <span className="k">Recommended</span> {q.recommended}
      </div>
      <form
        className="gaForm"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <input className="teamInp wide" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} placeholder="Your answer…" aria-label={`Answer: ${q.text}`} />
        <button type="submit" className="btn sm" disabled={busy || !text.trim()}>
          Answer
        </button>
        <button type="button" className="btn sm primary" disabled={busy} onClick={() => send(q.recommended)} title="Answer with what Junior recommends">
          Use recommended
        </button>
      </form>
      {error && <div className="tdErr" role="alert">{error}</div>}
    </div>
  )
}

/** Junior's open questions on the goal: every one waits for you, the run carries on meanwhile. */
export function GoalAsks({ run }: { run: TeamRunView }) {
  const open = run.goal?.questions.filter((q) => q.answer === null) ?? []
  if (!open.length) return null
  return (
    <div className="goalAsks" role="group" aria-label="Junior asks">
      {open.map((q) => (
        <Ask key={q.id} run={run} q={q} />
      ))}
    </div>
  )
}

// The budget: only you raise it

export function RaiseBudget({ run, onError }: { run: TeamRunView; onError: (e: string | null) => void }) {
  const step = Math.max(2, Math.round(run.budgetUsd * 0.5))
  const [add, setAdd] = useState(String(step))
  const [busy, setBusy] = useState(false)
  useEffect(() => setAdd(String(step)), [step])
  const n = Number(add)
  const ok = Number.isFinite(n) && n > 0
  return (
    <form
      className="raiseBudget"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ok) return
        setBusy(true)
        onError(null)
        teamsCall('POST', 'resume', { runId: run.id, addUsd: n })
          .catch((err) => onError(errText(err)))
          .finally(() => setBusy(false))
      }}
    >
      <span className="mono">+$</span>
      <input className="teamInp rbAmt mono" inputMode="decimal" value={add} disabled={busy} onChange={(e) => setAdd(e.target.value)} aria-label="Raise the budget by" />
      <button type="submit" className="btn primary sm" disabled={busy || !ok} title={ok ? `New budget ${usd(Math.max(run.spentUsd, run.budgetUsd) + n)}` : undefined}>
        {busy ? 'Resuming…' : 'Raise & resume'}
      </button>
    </form>
  )
}

// The result: Junior judged it done: you accept it, or say what's missing

export function ResultActions({ run, onError }: { run: TeamRunView; onError: (e: string | null) => void }) {
  const [why, setWhy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const go = (verb: 'accept' | 'reopen', body: unknown) => {
    setBusy(true)
    onError(null)
    goalCall(verb, body)
      .then(() => setWhy(null))
      .catch((err) => onError(errText(err)))
      .finally(() => setBusy(false))
  }
  if (why !== null)
    return (
      <form
        className="gaForm"
        onSubmit={(e) => {
          e.preventDefault()
          if (why.trim()) go('reopen', { runId: run.id, why })
        }}
      >
        <input className="teamInp" autoFocus value={why} disabled={busy} onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setWhy(null)} placeholder="What's still missing?" aria-label="What's still missing" />
        <button type="submit" className="btn sm" disabled={busy || !why.trim()} title="Another round, with what you said">
          Another round
        </button>
      </form>
    )
  return (
    <>
      <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setWhy('')}>
        Not yet…
      </button>
      <button type="button" className="btn primary sm" disabled={busy} onClick={() => go('accept', { runId: run.id })} title="Close the goal and mark its item done">
        Accept result
      </button>
    </>
  )
}

/** A waiting goal: look now instead of at the time it set. */
export function WakeNow({ run, onError }: { run: TeamRunView; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="btn sm"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        onError(null)
        goalCall('wake', { runId: run.id })
          .catch((err) => onError(errText(err)))
          .finally(() => setBusy(false))
      }}
      title="Junior judges the done-when now instead of waiting"
    >
      Look now
    </button>
  )
}

// The drawer's goal section

const HORIZONS: { kind: GoalHorizonKind; label: string }[] = [
  { kind: 'today', label: 'Today' },
  { kind: 'by', label: 'By a date' },
  { kind: 'until_done', label: 'Until done' },
]

const isoDay = (at: number | null) => {
  const d = at ? new Date(at) : new Date(Date.now() + 3 * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The card's goal before approval: set it, change the done-when and horizon, or make it a plain team run. */
function GoalEdit({ run, goal, onError }: { run: TeamRunView; goal: RunGoal | null; onError: (e: string | null) => void }) {
  const [doneWhen, setDoneWhen] = useState(goal?.doneWhen ?? '')
  useEffect(() => setDoneWhen(goal?.doneWhen ?? ''), [goal?.doneWhen])
  const save = (g: { doneWhen: string; horizon: GoalHorizonKind; by?: string } | null) => {
    onError(null)
    teamsCall('PUT', 'card', { runId: run.id, goal: g }).catch((err) => onError(errText(err)))
  }
  const kind = goal?.horizon.kind ?? 'until_done'
  if (!goal)
    return (
      <div className="tsMeta">
        A team run ends when its steps do.{' '}
        <button type="button" className="tfLink" onClick={() => save({ doneWhen: run.card.goal, horizon: 'until_done' })}>
          Make it a goal
        </button>{' '}
        — the team keeps going, round after round, until Junior judges the done-when met.
      </div>
    )
  return (
    <>
      <textarea
        className="teamArea"
        rows={2}
        value={doneWhen}
        onChange={(e) => setDoneWhen(e.target.value)}
        onBlur={() => doneWhen.trim() && doneWhen.trim() !== goal.doneWhen && save({ doneWhen: doneWhen.trim(), horizon: kind })}
        placeholder="The outcome Junior judges, e.g. “the PR is merged with checks green”"
        aria-label="Done when"
      />
      <RadioGroup.Root className="goalHorizon" aria-label="Horizon" value={kind} onValueChange={(v) => save({ doneWhen: goal.doneWhen, horizon: v as GoalHorizonKind, ...(v === 'by' ? { by: isoDay(goal.horizon.at) } : {}) })}>
        {HORIZONS.map((h) => (
          <RadioGroup.Item key={h.kind} value={h.kind} className="goalHz">
            {h.label}
          </RadioGroup.Item>
        ))}
        {kind === 'by' && (
          <input type="date" className="teamInp ghDate" value={isoDay(goal.horizon.at)} onChange={(e) => e.target.value && save({ doneWhen: goal.doneWhen, horizon: 'by', by: e.target.value })} aria-label="Done by" />
        )}
      </RadioGroup.Root>
      <div className="tsMeta">
        {horizonText(goal.horizon) === 'until done' ? 'No deadline' : `Due ${horizonText(goal.horizon)}`} ·{' '}
        <button type="button" className="tfLink" onClick={() => save(null)}>
          Make it a plain team run
        </button>
      </div>
    </>
  )
}

/** The goal in the drawer: what it's for, and, once it runs, every verdict, question and resume. */
export function GoalSide({ run, editable, onError }: { run: TeamRunView; editable: boolean; onError: (e: string | null) => void }) {
  const g = run.goal ?? null
  const [history, setHistory] = useState(false)
  if (editable)
    return (
      <section className="tsSec">
        <div className="tsK">goal · done when</div>
        <GoalEdit run={run} goal={g} onError={onError} />
      </section>
    )
  if (!g) return null
  const answered = g.questions.filter((q) => q.answer !== null)
  const resumes = run.resumes ?? []
  return (
    <section className="tsSec">
      <div className="tsK">
        goal · done when · {horizonText(g.horizon)}
        {g.round ? ` · round ${g.round + 1}` : ''}
      </div>
      <div className="edText">{g.doneWhen}</div>
      {g.wait && <div className="tsMeta">Waiting for {g.wait.for} — {wakeText(g.wait.until)}.</div>}
      {g.round > 0 && g.gap && <div className="tsMeta">Still missing: {g.gap}</div>}
      {g.acceptedAt && <div className="tsMeta">Accepted {clock(g.acceptedAt)}.</div>}
      {(g.verdicts.length > 0 || answered.length > 0 || resumes.length > 0) && (
        <Collapsible.Root open={history} onOpenChange={setHistory}>
          <Collapsible.Trigger className="goalHist">
            <ChevronRight size={12} className={`hoCaret${history ? ' on' : ''}`} aria-hidden="true" />
            {[
              g.verdicts.length && `${g.verdicts.length} verdict${g.verdicts.length === 1 ? '' : 's'}`,
              resumes.length && `${resumes.length} resume${resumes.length === 1 ? '' : 's'}`,
              answered.length && `${answered.length} answered`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Collapsible.Trigger>
          <Collapsible.Content>
            <ul className="tsNotes goalLog">
              {[
                ...g.verdicts.map((v) => ({ at: v.at, node: <><span className={`hoVerdict ${v.met ? 'pass' : 'fail'}`}>{v.met ? 'met' : 'not met'}</span> round {v.round + 1} — {v.evidence}</> })),
                ...resumes.map((r) => ({ at: r.at, node: <><ResumedTag by={r.by} long /> {r.what}{r.why && <span className="muted"> — because {r.why}</span>}</> })),
                ...answered.map((q) => ({ at: q.answeredAt ?? q.at, node: <>{q.id} {q.text} <span className="muted">— you: {q.answer}</span></> })),
              ]
                .sort((a, b) => a.at - b.at)
                .map((x, i) => (
                  <li key={i}>
                    <span className="tsId mono">{clock(x.at)}</span> {x.node}
                  </li>
                ))}
            </ul>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </section>
  )
}
