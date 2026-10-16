/**
 * The Junior page's sidebar (.docs/junior-goals-teams/junior-home-v2.html, J):
 * Junior's card, not a settings form — who it is, what it's doing right now,
 * what it can see on this Mac, and what it can do. Name,
 * colour and voice sit behind "Customize"; every capability opens a Junior
 * chat with the first message written, waiting for you to send it.
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import { ArrowRight, ChevronRight, MessageSquare } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { JuniorDay, JuniorNow, PlanRow } from '../../../shared/protocol.js'
import type { Mood } from '../../../core/junior/mood.js'
import { canDoCards, sentenceOf } from '../../../core/junior/offers.js'
import { addToday, startJuniorChat, usePersona } from '../junior.js'
import { MOD_LABEL } from '../keys.js'
import { JuniorFace } from './JuniorFace.js'

type Props = {
  day: JuniorDay | null
  mood: Mood
  onNavigate: (hash: string) => void
  /** open the full "What I can do" sentences */
  onSeeAll: () => void
  /** open name, colour and voice */
  onCustomize: () => void
  /** hand an item to Junior: the inbox's own dispatch */
  onDispatch: (itemId: string) => void
}

/** Capabilities listed before "See all". */
const CAN_SHOWN = 4

export function JuniorSide({ day, mood, onNavigate, onSeeAll, onCustomize, onDispatch }: Props) {
  const persona = usePersona()
  const cards = useMemo(() => (day ? canDoCards(day.fill) : []), [day])
  return (
    <aside className="jrSide" aria-label={persona.name}>
      <div className="jrId">
        <JuniorFace mood={mood} size={88} motion="follow" />
        <div className="who">
          <div className="nm">
            <span className="g">Hi, I'm</span> {persona.name}
          </div>
          <div className="ro">Your AI junior engineer</div>
          <button type="button" className="jrChat" onClick={() => startJuniorChat()} title={`New chat with ${persona.name} (${MOD_LABEL}J)`}>
            <MessageSquare size={13} aria-hidden="true" />
            Chat with {persona.name}
            <kbd aria-hidden="true">{MOD_LABEL.replace(/\+$/, '')}J</kbd>
          </button>
        </div>
      </div>

      {day && (
        <>
          <div className="jrSec">
            <h3 className="jrSl">Right now</h3>
            <Now day={day} onNavigate={onNavigate} onDispatch={onDispatch} />
          </div>

          <div className="jrSec">
            <h3 className="jrSl">Can see</h3>
            <Seen seen={day.seen} />
          </div>

          <div className="jrSec">
            <h3 className="jrSl">
              What I can do
              <button type="button" className="r jrLink" onClick={onSeeAll}>
                See all
              </button>
            </h3>
            <div className="jrCan">
              {cards.slice(0, CAN_SHOWN).map((c) => {
                const say = sentenceOf(c, [])
                return (
                  <button key={c.id} type="button" title={say} onClick={() => startJuniorChat(say, c.intent ? { intent: c.intent } : {})}>
                    <span>{c.head}</span>
                    {c.id === 'watch' && day.jobsOn > 0 && <span className="on">{day.jobsOn} on</span>}
                    <ArrowRight size={13} className="go" aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}

      <div className="jrSideFoot">
        <span>{day && day.jobsOn > 0 ? `${day.jobsOn} ${day.jobsOn === 1 ? 'job' : 'jobs'} running for you` : 'On this Mac'}</span>
        <button type="button" className="btn xs" onClick={onCustomize}>
          Customize
        </button>
      </div>
    </aside>
  )
}

/**
 * The next row Junior could take off today's plan when it's free: one of its
 * own that hasn't started, else one of yours that is just to do — not done,
 * not running, not waiting on you or anyone else, not finished and waiting
 * for your review.
 */
export function nextForJunior(rows: readonly PlanRow[]): PlanRow | null {
  const takeable = (r: PlanRow) =>
    !r.missing && (r.status.kind === 'carried' || (r.status.kind === 'todo' && (r.status.note === null || r.status.note === 'brief ready')))
  return rows.find((r) => r.owner === 'junior' && r.startable && takeable(r)) ?? rows.find((r) => r.owner === 'you' && takeable(r)) ?? null
}

/** What Junior is doing, with its step as a bar — or, when free, an offer to take the next row. */
function Now({ day, onNavigate, onDispatch }: { day: JuniorDay; onNavigate: (hash: string) => void; onDispatch: (itemId: string) => void }) {
  const now: JuniorNow = day.now
  const [skipped, setSkipped] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  if (now.idle) {
    const next = nextForJunior(day.plan.rows.filter((r) => !skipped.includes(r.itemId)))
    const take = async (row: PlanRow) => {
      setBusy(true)
      // It's Junior's row from here on, then the same dispatch as Start.
      if (row.owner !== 'junior') await addToday({ itemId: row.itemId, owner: 'junior' })
      setBusy(false)
      onDispatch(row.itemId)
    }
    return (
      <div className="jrNow">
        <span className="jrDot" aria-hidden="true" />
        <span>
          <span>Free right now</span>
          {next && (
            <>
              <span className="jrAsk">
                Want me to take <b>{next.title}</b>?
              </span>
              <span className="jrAskActs">
                <button type="button" className="btn xs primary" disabled={busy} onClick={() => void take(next)}>
                  Take it
                </button>
                <button type="button" className="btn xs ghost" onClick={() => setSkipped((xs) => [...xs, next.itemId])}>
                  Not now
                </button>
              </span>
            </>
          )}
        </span>
      </div>
    )
  }
  const hash = now.target.kind === 'session' ? now.target.id : `/jobs/${encodeURIComponent(now.target.id)}`
  return (
    <button type="button" className="jrNow live" onClick={() => onNavigate(hash)}>
      <span className="jrDot live" aria-hidden="true" />
      <span>
        <span className="t">{now.label}</span>
        {(now.step || now.more > 0) && (
          <span className="jrSm">
            {now.step ? `step ${now.step.n} of ${now.step.of}` : ''}
            {now.step && now.more > 0 ? ' · ' : ''}
            {now.more > 0 ? `${now.more} more running` : ''}
          </span>
        )}
        {now.step && (
          <span className="jrProg" role="progressbar" aria-valuemin={0} aria-valuemax={now.step.of} aria-valuenow={now.step.n - 1}>
            <i style={{ width: `${Math.round(((now.step.n - 1) / now.step.of) * 100)}%` }} />
          </span>
        )}
      </span>
    </button>
  )
}

/** One line ("GitHub · 7 sources · 3 projects") that opens to the names. Unconnected sources aren't listed. */
function Seen({ seen }: { seen: JuniorDay['seen'] }) {
  if (!seen) return <div className="jrSm">Checking…</div>
  const on = seen.sources.filter((s) => s.connected)
  const parts = [
    seen.github ? 'GitHub' : null,
    on.length ? `${on.length} ${on.length === 1 ? 'source' : 'sources'}` : null,
    `${seen.projects.length} ${seen.projects.length === 1 ? 'project' : 'projects'}`,
  ].filter(Boolean)
  return (
    <Collapsible.Root className="jrSeenC">
      <Collapsible.Trigger className="jrSeenT">
        <span>{parts.join(' · ')}</span>
        <ChevronRight size={13} className="chev" aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Content className="jrChips">
        <span className={seen.github ? '' : 'off'} title={seen.github ? `gh signed in as ${seen.github}` : 'gh is not signed in'}>
          <i />
          GitHub{seen.github ? ` · ${seen.github}` : ''}
        </span>
        {on.map((s) => (
          <span key={s.name}>
            <i />
            {s.name}
          </span>
        ))}
        {seen.projects.map((p) => (
          <span key={p} className="proj">
            {p}
          </span>
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
