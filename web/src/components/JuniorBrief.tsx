/**
 * The morning brief tab (.docs/junior-goals-teams/junior-home-v2.html, J):
 * the one thing to start with, then people waiting on you, what's due today,
 * what's waiting for your review, and what happened while you were away.
 * Every row opens its item. The rules live in core/junior/morning.ts.
 */
import type { ReactNode } from 'react'
import type { JuniorDay, MorningRow } from '../../../shared/protocol.js'
import { waitedWords } from '../../../core/junior/greeting.js'
import { sourceWord } from '../../../core/junior/offers.js'
import { itemHash } from '../hooks.js'
import { JuniorFace } from './JuniorFace.js'

/** Rows shown per section before "N more in your inbox". */
const SHOWN = 5

type Props = { day: JuniorDay; onNavigate: (hash: string) => void }

/** `rest`: under the Suggested tab, only what's due and what happened; the people waiting and reviews are suggestions there. */
type BriefProps = Props & { only?: 'rest' }

function age(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function JuniorBrief({ day, onNavigate, only }: BriefProps) {
  const b = day.morning
  const now = Date.now()
  const open = (r: MorningRow) => onNavigate(itemHash(r.itemId))
  const rest = only === 'rest'
  const empty = !rest && !b.people.length && !b.due.length && !b.review.length
  return (
    <div className="jrBriefTab">
      {!rest && b.start && (
        <button type="button" className="jrStart" onClick={() => onNavigate(itemHash(b.start!.itemId))}>
          <span>
            Start with <b>{b.start.title}</b>: {b.start.why}.
          </span>
          <span className="go">Open</span>
        </button>
      )}

      {empty && (
        <p className="jrQuiet">
          <JuniorFace mood="done" size={18} motion="still" decorative />
          Nobody is waiting on you, nothing is due today, and there's nothing to review.
        </p>
      )}

      <Section title="People waiting on you" hot rows={rest ? [] : b.people} aside="longest wait first" onNavigate={onNavigate}>
        {(r) => (
          <button key={r.itemId} type="button" className="jrBr" onClick={() => open(r)}>
            <span className={`w${now - r.since > 86_400_000 ? ' late' : ''}`}>{age(r.since, now)}</span>
            <span className="tx">
              <span className="t">{r.who ?? 'Someone'}</span>
              <span className="m">
                {sourceWord(r.source)} · {r.ref}
              </span>
              <span className="d">{r.title}</span>
            </span>
            <span className="st">{r.ask === 'decide' ? 'decide' : 'reply'}</span>
          </button>
        )}
      </Section>

      <Section title="Due today" rows={b.due} aside={overdueAside(b.due)} onNavigate={onNavigate}>
        {(r) => (
          <button key={r.itemId} type="button" className="jrBr" onClick={() => open(r)}>
            <span className="src">{r.ref}</span>
            <span className="tx">
              <span className="t">{r.title}</span>
            </span>
            <span className={`st${r.late ? ' late' : ''}`}>{r.late ? (r.late === 1 ? 'due yesterday' : `${r.late} days late`) : 'today'}</span>
          </button>
        )}
      </Section>

      <Section title="To review" rows={rest ? [] : b.review} onNavigate={onNavigate}>
        {(r) => (
          <button key={r.itemId} type="button" className="jrBr" onClick={() => open(r)}>
            <span className="src">{r.ref}</span>
            <span className="tx">
              <span className="t">{r.title}</span>
              <span className="d">{r.mine ? 'My work, ready for your review' : `${r.who ?? 'Someone'} asked ${waitedWords(r.since, now)} ago`}</span>
            </span>
            <span className={`st${r.mine ? ' mine' : ''}`}>{r.mine ? 'mine' : 'review'}</span>
          </button>
        )}
      </Section>

      <Away day={day} onNavigate={onNavigate} />
    </div>
  )
}

function overdueAside(due: MorningRow[]): string | undefined {
  const late = due.filter((d) => (d.late ?? 0) > 0).length
  return late ? `${late} overdue` : undefined
}

function Section({
  title,
  rows,
  aside,
  hot,
  onNavigate,
  children,
}: {
  title: string
  rows: MorningRow[]
  aside?: string
  hot?: boolean
  onNavigate: (hash: string) => void
  children: (r: MorningRow) => ReactNode
}) {
  if (!rows.length) return null
  const more = rows.length - SHOWN
  return (
    <section aria-label={title} className="jrBs">
      <h2 className={`jrLh${hot ? ' hot' : ''}`}>
        {title} <span className="n">{rows.length}</span>
        {aside && <span className="aside">{aside}</span>}
      </h2>
      <div className="jrRows">
        {rows.slice(0, SHOWN).map((r) => children(r))}
        {more > 0 && (
          <button type="button" className="jrMore" onClick={() => onNavigate('/inbox')}>
            {more} more in your inbox
          </button>
        )}
      </div>
    </section>
  )
}

/** While you were away: what came in by source, what ran, what went out. Asks nothing of you. */
function Away({ day, onNavigate }: Props) {
  const a = day.morning.away
  const came = a.arrived.reduce((n, x) => n + x.count, 0)
  const title = a.away ? 'While you were away' : 'So far today'
  return (
    <section aria-label={title} className="jrBs">
      <h2 className="jrLh">
        {title} <span className="n">since {clock(a.since)}</span>
      </h2>
      {came === 0 && !a.jobs.length && !a.sent ? (
        <p className="jrQuiet">Quiet: nothing came in.</p>
      ) : (
        <div className="jrAway">
          {came > 0 && (
            <div className="chips" aria-label="What came in">
              {a.arrived.map((x) => (
                <span key={x.label} className="chip">
                  {x.label} <b>{x.count}</b>
                </span>
              ))}
              {a.skipped > 0 && (
                <span className="chip skip" title="FYI: nothing is asked of you">
                  FYI <b>{a.skipped}</b>
                </span>
              )}
            </div>
          )}
          {a.jobs.length > 0 && (
            <p className="ln">
              <b>Jobs ran:</b>{' '}
              {a.jobs.map((j, i) => (
                <span key={j.jobId}>
                  {i > 0 && ' · '}
                  <button type="button" className="jrRef" onClick={() => onNavigate(`/jobs/${encodeURIComponent(j.jobId)}`)}>
                    {j.title}
                  </button>
                  {j.runs > 1 ? ` ×${j.runs}` : ''}
                  {j.filed > 0 ? `, ${j.filed} filed` : ''}
                </span>
              ))}
            </p>
          )}
          {a.sent > 0 && (
            <p className="ln">
              <b>Sent with your OK:</b> {a.sent} {a.sent === 1 ? 'action' : 'actions'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
