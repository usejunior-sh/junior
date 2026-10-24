/**
 * The Junior page's hand-off tabs (Phase 1, artifact f335b876): Junior works
 * only what you hand it.
 *
 *   Suggested    what Junior could take, with why: hand off, snooze, or not this one;
 *                then FYI (you were mentioned), what's due and what happened
 *   My PRs       every PR you have open, and whether Junior babysits it
 *   Reviews      every PR asking for your review (a Slack ask folded in), and Junior's first pass
 *   People       people waiting on you: a question, changes requested
 *   My work      assigned to you, or anything you started or handed off
 *   With Junior  everything handed off, by where it stands
 *
 * Which tab an item sits on is core/junior/sections.ts.
 *
 * Read straight off the inbox snapshot: each item carries its hand-off, its
 * suggestion and where it stands with Junior (server/inbox/junior.ts).
 */
import { X, ChevronDown } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HandoffReadiness, JuniorDay, ScoredItem } from '../../../shared/protocol.js'
import type { Verdict } from '../../../core/review/brief.js'
import { bySuggestion, STARTS, SUGGEST_SHOWN, type Suggestion } from '../../../core/junior/suggest.js'
import { sectionOf } from '../../../core/junior/sections.js'
import { watchOffOf } from '../../../core/junior/ledger.js'
import { handBackLine } from '../../../core/babysit/ready.js'
import { clockTime, fixFraction, graceShown } from '../../../core/babysit/grace.js'
import { PIPELINE_STEPS, type Pipeline } from '../../../core/work/handoff.js'
import { itemHash } from '../hooks.js'
import { sendHandoff, snoozeItem, VERB, type HandoffVerb } from '../handoff.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { kindIcon, shortAge } from '../itemUi.js'
import { playbookOf, refOf } from '../refs.js'
import { JuniorBrief } from './JuniorBrief.js'
import { NotThisOneWhy } from './NotThisOneWhy.js'
import { openNotebook } from '../settings.js'
import { useSuppressions } from '../suppressions.js'
import { JuniorFace } from './JuniorFace.js'
import { NeedsLine } from './JuniorToday.js'
import { ReadyChips } from './ReadyChips.js'
import { SnoozeMenu } from './SnoozeMenu.js'
import { WatchOffNote, type WatchOffNoteState } from './WatchOff.js'

type Nav = { onNavigate: (hash: string) => void }

/** The inbox snapshot, loaded once the page opens. */
function useItems(): ScoredItem[] {
  const snap = useInbox()
  useEffect(() => {
    if (!snap.loaded && !snap.loading) void inboxStore.refresh()
  }, [snap.loaded, snap.loading])
  return snap.items as ScoredItem[]
}

/** One verb at a time, its error in a line under the list; `onStarted` hears a hand-off's readiness. */
function useAct(onStarted?: (id: string, readiness: HandoffReadiness) => void): { busy: string | null; error: string | null; act: (verb: HandoffVerb, id: string, playbook?: string) => void } {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = (verb: HandoffVerb, id: string, playbook?: string) => {
    setBusy(id)
    setError(null)
    void sendHandoff(verb, id, playbook).then(({ error, readiness }) => {
      setBusy(null)
      setError(error)
      if (verb === 'start' && readiness) onStarted?.(id, readiness)
    })
  }
  return { busy, error, act }
}

/** A row: what it is, where it stands (or what Junior would do), and the verbs. */
function Row({ item, lead, meta, mid, children, onNavigate }: { item: ScoredItem; lead?: ReactNode; meta: ReactNode; mid: ReactNode; children?: ReactNode } & Nav) {
  const Icon = kindIcon(item)
  return (
    <div className="hoRow">
      <span className="k" aria-hidden="true">
        {lead ?? <Icon size={14} />}
      </span>
      <button type="button" className="tx" onClick={() => onNavigate(itemHash(item.id))}>
        <span className="t">{item.title}</span>
        <span className="m">{meta}</span>
      </button>
      <div className="mid">{mid}</div>
      <div className="acts">{children}</div>
    </div>
  )
}

const Dot = ({ tone }: { tone?: 'live' | 'need' | 'paused' | 'ok' }) => <span className={`jrDot${tone ? ` ${tone}` : ''}`} />

/** What CI and the threads say on your PR, as the babysit watch last read it. */
function prSignals(i: ScoredItem): ReactNode[] {
  const s = i.seen
  const out: ReactNode[] = []
  if (s?.draft ?? i.isDraft) out.push('draft')
  if (s?.red.length) out.push(<span key="red" className="red">CI red: {s.red.slice(0, 3).join(', ')}</span>)
  else if (i.ciFailing) out.push(<span key="red" className="red">CI red</span>)
  if (s?.bots) out.push(`${s.bots} bot comment${s.bots === 1 ? '' : 's'}`)
  if (s?.people) out.push(`${s.people} open thread${s.people === 1 ? '' : 's'}`)
  if (s?.rebase === 'conflict' || i.kind === 'own-pr-conflicting') out.push(<span key="cf" className="red">conflicts</span>)
  // data, not a warning: mono ash, outside the red span
  const g = i.handoff === 'on' ? graceShown(s, Date.now()) : null
  if (g && 'fixes' in g)
    out.push(
      <span key="fx" className="mono">
        {fixFraction(g.fixes)}
      </span>,
    )
  return out
}

/** "acme/web#3312 · draft · CI red: lint" */
const joined = (parts: ReactNode[]) => parts.filter((p) => p !== '' && p != null).flatMap((p, n) => (n ? [' · ', p] : [p]))

/** Who else asked for it in Slack: one row per PR, the ask folded in. */
const slackAsks = (i: ScoredItem) => [...new Set((i.linked ?? []).filter((l) => l.source === 'slack').map((l) => l.author).filter(Boolean))]

function SnoozeButton({ item }: { item: ScoredItem }) {
  return (
    <SnoozeMenu onSnooze={(until) => void snoozeItem(item, until)}>
      <button type="button" className="btn xs">
        Snooze <ChevronDown size={12} aria-hidden="true" />
      </button>
    </SnoozeMenu>
  )
}

function Err({ error }: { error: string | null }) {
  return error ? (
    <p className="jrErr" role="alert">
      {error}
    </p>
  ) : null
}

// ---------- Suggested ----------

export function JuniorSuggested({ day, onNavigate }: { day: JuniorDay | null } & Nav) {
  const items = useItems()
  const snap = useInbox()
  // the latest hand-off whose watch is off: one note at a time, inline, never a modal
  const [note, setNote] = useState<WatchOffNoteState | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const { busy, error, act } = useAct((id, r) => {
    if (r.state !== 'watch-off') return
    setNoteError(null)
    setNote({ itemId: id, title: items.find((i) => i.id === id)?.title ?? 'that PR', watch: r.watch })
  })
  const sectionRef = useRef<HTMLElement>(null)
  const dismissNote = () => {
    setNote(null)
    setNoteError(null)
    // the note's buttons are gone: focus the first row, or the heading when the list is empty
    requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('.hoRow .tx, .jrLh')?.focus())
  }
  const [all, setAll] = useState(false)
  const rows = items.filter((i): i is ScoredItem & { suggestion: Suggestion } => !!i.suggestion).sort(bySuggestion)
  const shown = all ? rows : rows.slice(0, SUGGEST_SHOWN)
  const snoozed = snap.counts?.snoozed ?? 0
  // "Not this one": the row leaves, and its slot asks why for a few seconds
  const [why, setWhy] = useState<{ item: ScoredItem; at: number } | null>(null)
  const whyRow = why ? shown.findIndex((i) => i.id === why.item.id) : -1
  // the notice sits in the slot; if a refetch brought the row back, just under it
  const whyAt = !why ? -1 : whyRow >= 0 ? whyRow + 1 : Math.min(why.at, shown.length)
  const whyLine = why && <NotThisOneWhy key={`why:${why.item.id}`} item={why.item} how="click" variant="ho" onDone={() => setWhy(null)} />
  const kinds = useSuppressions().suppressions?.length ?? 0
  return (
    <>
      <section aria-label="Suggested" ref={sectionRef}>
        <h2 className="jrLh" tabIndex={-1}>
          I could take these <span className="n">{rows.length}</span>
          <span className="aside">nothing starts until you hand it off</span>
        </h2>
        <div className="jrNoteWrap">
          <WatchOffNote note={note} items={items} onDismiss={dismissNote} onError={setNoteError} />
        </div>
        {rows.length === 0 && !why ? (
          <p className="jrEmpty">
            <JuniorFace mood="hello" size={18} motion="still" decorative /> Nothing to suggest right now. I’ll add things here as they come in.
          </p>
        ) : (
          <div className="hoRows">
            {shown.map((i, n) => (
              <Fragment key={i.id}>
                {n === whyAt && whyLine}
                <Row
                  item={i}
                  meta={joined([refOf(i), ...(i.reason === 'your-pr' ? prSignals(i) : []), ...(i.reason === 'review-requested' ? [`${i.author} asked ${shortAge(i.createdAt)} ago`] : []), ...(slackAsks(i).length ? [<span key="sl" className="chipSl">asked in Slack too</span>] : [])])}
                  mid={
                    <span className="would">
                      <span className="l">{i.suggestion.head}</span>
                      {i.suggestion.would}
                    </span>
                  }
                  onNavigate={onNavigate}
                >
                  <button type="button" className="btn xs primary" disabled={busy === i.id} onClick={() => act('start', i.id, i.suggestion.playbook === 'babysit' || i.suggestion.playbook === 'review' ? undefined : i.suggestion.playbook)}>
                    {VERB[i.suggestion.playbook]}
                  </button>
                  <SnoozeButton item={i} />
                  <button
                    type="button"
                    className="iconBtn sm"
                    title="Not this one"
                    aria-label="Not this one"
                    disabled={busy === i.id}
                    onClick={() => {
                      act('not-now', i.id)
                      setWhy({ item: i, at: n })
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </Row>
              </Fragment>
            ))}
            {whyAt === shown.length && whyLine}
            {rows.length > SUGGEST_SHOWN && (
              <button type="button" className="jrMore" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show ${rows.length - SUGGEST_SHOWN} more`}
              </button>
            )}
          </div>
        )}
        <Err error={error ?? noteError} />
        {snoozed > 0 && (
          <p className="jrQuiet">
            {snoozed} snoozed. They come back early if something changes.{' '}
            <button type="button" className="jrRef" onClick={() => onNavigate('/inbox/snoozed')}>
              Show them
            </button>
          </p>
        )}
        {kinds > 0 && (
          <p className="jrQuiet">
            {kinds === 1 ? '1 kind not suggested.' : `${kinds} kinds not suggested.`}{' '}
            <button type="button" className="jrRef" onClick={() => openNotebook()}>
              Show them
            </button>
          </p>
        )}
      </section>
      <Fyi items={items} onNavigate={onNavigate} />
      {day && <JuniorBrief day={day} onNavigate={onNavigate} only="rest" />}
    </>
  )
}

// ---------- My PRs ----------

/** Where your PR stands with Junior, in a line and a sub-line. */
function prState(i: ScoredItem): { tone?: 'live' | 'need' | 'paused'; label: ReactNode; sub: ReactNode } {
  if (i.handoff === 'paused') return { tone: 'paused', label: <span className="chip paused">Paused</span>, sub: 'Nothing runs until you resume.' }
  if (i.junior?.stage === 'needs-you') return { tone: 'need', label: <span className="chip need">Needs you</span>, sub: i.tasks?.next?.title ?? 'Open it to see.' }
  if (watchOffOf(i) === 'babysit') return { label: 'Babysitting off', sub: 'Nothing runs until you turn it on.' }
  if (i.handoff === 'on') {
    // you just pushed: the fix waits, and the line says until when (core/babysit/grace.ts)
    const g = graceShown(i.seen, Date.now())
    if (g && 'graceUntil' in g)
      return {
        tone: 'live',
        label: 'Babysitting',
        sub: (
          <>
            You just pushed. I’ll fix it after <time dateTime={new Date(g.graceUntil).toISOString()}>{clockTime(g.graceUntil)}</time> if it’s still red.
          </>
        ),
      }
    return { tone: 'live', label: 'Babysitting', sub: i.junior?.stage === 'working' ? (i.tasks?.line ?? 'Working on it.') : 'Nothing to do right now.' }
  }
  return { label: 'Not handed off', sub: i.suggestion?.would ?? ((i.seen?.draft ?? i.isDraft) ? 'A draft. I won’t suggest it.' : 'Nothing to do yet.') }
}

const PR_ORDER = (i: ScoredItem) => (i.junior?.stage === 'needs-you' ? 0 : i.handoff === 'on' ? 1 : i.suggestion ? 2 : i.handoff === 'paused' ? 3 : 4)

export function JuniorMyPrs({ onNavigate }: Nav) {
  const items = useItems()
  const { busy, error, act } = useAct()
  const rows = items.filter((i) => i.reason === 'your-pr').sort((a, b) => PR_ORDER(a) - PR_ORDER(b) || b.score - a.score)
  return (
    <section aria-label="My PRs">
      <h2 className="jrLh">
        Your open PRs <span className="n">{rows.length}</span>
        <span className="aside">Junior babysits only the ones you hand off</span>
      </h2>
      {rows.length === 0 ? (
        <p className="jrEmpty">No open PRs in this workspace’s repos.</p>
      ) : (
        <div className="hoRows">
          {rows.map((i) => {
            const st = prState(i)
            return (
              <Row
                key={i.id}
                item={i}
                lead={<Dot {...(st.tone ? { tone: st.tone } : {})} />}
                meta={joined([refOf(i), ...prSignals(i)])}
                mid={
                  <span className={`state${i.handoff ? '' : ' off'}`}>
                    {st.label}
                    <span className="sub">{st.sub}</span>
                  </span>
                }
                onNavigate={onNavigate}
              >
                {i.handoff === 'paused' ? (
                  <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('resume', i.id)}>
                    Resume
                  </button>
                ) : i.handoff === 'on' ? (
                  <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('pause', i.id)}>
                    Pause
                  </button>
                ) : (
                  <button type="button" className={`btn xs${i.suggestion ? ' primary' : ''}`} disabled={busy === i.id} onClick={() => act('start', i.id)}>
                    Babysit
                  </button>
                )}
              </Row>
            )
          })}
        </div>
      )}
      <Err error={error} />
    </section>
  )
}

// ---------- Reviews ----------

const CHIP: Record<Verdict, string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Changes' }

function reviewState(i: ScoredItem): { tone?: 'live' | 'need' | 'paused'; label: ReactNode; sub: string; ready: boolean } {
  const r = i.tasks?.review
  if (i.handoff === 'paused') return { tone: 'paused', label: <span className="chip paused">Paused</span>, sub: 'No first pass until you resume.', ready: false }
  if (watchOffOf(i) === 'review') return { label: 'Reviews off', sub: 'Nothing runs until you turn it on.', ready: false }
  if (!i.handoff && !r) {
    const asks = slackAsks(i)
    return { label: 'Not handed off', sub: `Waiting ${shortAge(i.createdAt)}${asks.length ? ` · ${asks.join(', ')} asked in Slack` : ''}.`, ready: false }
  }
  if (!r || r.state === 'queued' || r.state === 'reviewing') return { tone: 'live', label: 'Reading', sub: r?.state === 'reviewing' ? 'Reading the diff now.' : 'Queued.', ready: false }
  if (r.state === 'ready') {
    const v = r.verdict
    return { tone: 'need', label: v ? <span className={`chip v-${v}`}>{CHIP[v]}</span> : 'Ready', sub: 'First pass ready. Nothing posted.', ready: true }
  }
  if (r.state === 'posted') return { label: 'Posted', sub: r.line ?? 'You posted the review.', ready: false }
  if (r.state === 'failed') return { tone: 'need', label: <span className="chip need">Stuck</span>, sub: 'Open it to see why.', ready: true }
  return { label: 'Set aside', sub: r.line ?? 'Skipped.', ready: false }
}

export function JuniorReviews({ onNavigate }: Nav) {
  const items = useItems()
  const { busy, error, act } = useAct()
  const rows = items.filter((i) => i.reason === 'review-requested').sort((a, b) => Number(reviewState(b).ready) - Number(reviewState(a).ready) || b.score - a.score)
  return (
    <section aria-label="Reviews">
      <h2 className="jrLh">
        Waiting on your review <span className="n">{rows.length}</span>
        <span className="aside">GitHub requests and Slack asks, one row per PR</span>
      </h2>
      {rows.length === 0 ? (
        <p className="jrEmpty">No one is waiting on your review.</p>
      ) : (
        <div className="hoRows">
          {rows.map((i) => {
            const st = reviewState(i)
            const asks = slackAsks(i)
            return (
              <Row
                key={i.id}
                item={i}
                lead={<Dot {...(st.tone ? { tone: st.tone } : {})} />}
                meta={joined([refOf(i), i.author, `requested ${shortAge(i.createdAt)} ago`, ...(asks.length ? [<span key="sl" className="chipSl">asked in Slack too</span>] : [])])}
                mid={
                  <span className={`state${i.handoff || i.tasks?.review ? '' : ' off'}`}>
                    {st.label}
                    <span className="sub">{st.sub}</span>
                  </span>
                }
                onNavigate={onNavigate}
              >
                {st.ready ? (
                  <button type="button" className="btn xs primary" onClick={() => onNavigate(itemHash(i.id))}>
                    Read pass
                  </button>
                ) : i.handoff === 'paused' ? (
                  <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('resume', i.id)}>
                    Resume
                  </button>
                ) : i.handoff === 'on' ? (
                  <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('pause', i.id)}>
                    Pause
                  </button>
                ) : (
                  <button type="button" className="btn xs primary" disabled={busy === i.id} onClick={() => act('start', i.id)}>
                    First pass
                  </button>
                )}
              </Row>
            )
          })}
        </div>
      )}
      <Err error={error} />
    </section>
  )
}

// ---------- People · My work · FYI ----------

/** Where an item that isn't a PR stands with Junior, in a line and a sub-line. */
function itemState(i: ScoredItem): { tone?: 'live' | 'need' | 'paused' | 'ok'; label: ReactNode; sub: string } {
  const w = i.junior
  if (i.handoff === 'paused') return { tone: 'paused', label: <span className="chip paused">Paused</span>, sub: 'Nothing runs until you resume.' }
  if (w?.stage === 'needs-you') return { tone: 'need', label: <span className="chip need">Needs you</span>, sub: i.tasks?.next?.title ?? 'Open it to see.' }
  if (w?.stage === 'working') return { tone: 'live', label: 'Junior is on it', sub: i.tasks?.line ?? 'Working on it.' }
  if (w) return { tone: 'ok', label: 'Handed in', sub: i.tasks?.lastDone ?? 'Done for now.' }
  const started = i.flow && (i.flow.stage === 'working' || i.flow.stage === 'review')
  return { label: 'Not handed off', sub: started ? `You’re on it${i.flow!.next ? ` · next: ${i.flow!.next}` : ''}.` : i.peopleWaiting > 0 ? `Waiting ${shortAge(i.createdAt)}.` : 'Yours.' }
}

const ITEM_ORDER = (i: ScoredItem) => (i.junior?.stage === 'needs-you' ? 0 : !i.handoff && !i.junior ? 1 : i.junior?.stage === 'working' ? 2 : i.handoff === 'paused' ? 3 : 4)

/** People and My work: the same rows, hand off · snooze · pause. */
function ItemList({ section, title, aside, empty, onNavigate }: { section: 'people' | 'work'; title: string; aside: string; empty: string } & Nav) {
  const items = useItems()
  const { busy, error, act } = useAct()
  const rows = items.filter((i) => sectionOf(i) === section).sort((a, b) => ITEM_ORDER(a) - ITEM_ORDER(b) || b.score - a.score)
  return (
    <section aria-label={title}>
      <h2 className="jrLh">
        {title} <span className="n">{rows.length}</span>
        <span className="aside">{aside}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="jrEmpty">{empty}</p>
      ) : (
        <div className="hoRows">
          {rows.map((i) => {
            const st = itemState(i)
            const handed = !!i.handoff || !!i.junior
            const pb = playbookOf(i)
            return (
              <Row
                key={i.id}
                item={i}
                lead={<Dot {...(st.tone ? { tone: st.tone } : {})} />}
                meta={joined([refOf(i), ...(i.author ? [i.author] : []), ...(i.label ? [i.label] : []), `${shortAge(i.updatedAt)} ago`])}
                mid={
                  i.suggestion ? (
                    <span className="would">
                      <span className="l">{i.suggestion.head}</span>
                      {i.suggestion.would}
                    </span>
                  ) : (
                    <span className={`state${handed ? '' : ' off'}`}>
                      {st.label}
                      <span className="sub">{st.sub}</span>
                    </span>
                  )
                }
                onNavigate={onNavigate}
              >
                {i.handoff === 'paused' ? (
                  <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('resume', i.id)}>
                    Resume
                  </button>
                ) : i.junior?.stage === 'working' ? (
                  <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('pause', i.id)}>
                    Pause
                  </button>
                ) : handed ? (
                  <button type="button" className={`btn xs${i.junior?.stage === 'needs-you' ? ' primary' : ''}`} onClick={() => onNavigate(itemHash(i.id))}>
                    Open
                  </button>
                ) : (
                  <>
                    <button type="button" className={`btn xs${i.suggestion ? ' primary' : ''}`} title={STARTS[pb as keyof typeof STARTS]?.would} disabled={busy === i.id} onClick={() => act('start', i.id, pb)}>
                      Hand off
                    </button>
                    <SnoozeButton item={i} />
                  </>
                )}
              </Row>
            )
          })}
        </div>
      )}
      <Err error={error} />
    </section>
  )
}

export const JuniorPeople = ({ onNavigate }: Nav) => (
  <ItemList section="people" title="People waiting on you" aside="questions and asks to you" empty="Nobody is waiting on you." onNavigate={onNavigate} />
)

export const JuniorMyWork = ({ onNavigate }: Nav) => (
  <ItemList section="work" title="My work" aside="assigned to you, or started" empty="Nothing assigned to you or started. Your backlog is in the inbox." onNavigate={onNavigate} />
)

/** FYI: you were mentioned, nothing is asked. Read it, or snooze it. */
function Fyi({ items, onNavigate }: { items: ScoredItem[] } & Nav) {
  const rows = items.filter((i) => sectionOf(i) === 'fyi').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  if (rows.length === 0) return null
  return (
    <section aria-label="FYI">
      <h2 className="jrLh">
        FYI <span className="n">{rows.length}</span>
        <span className="aside">you were mentioned · nothing is asked of you</span>
      </h2>
      <div className="hoRows">
        {rows.slice(0, SUGGEST_SHOWN).map((i) => (
          <Row key={i.id} item={i} meta={joined([refOf(i), ...(i.author ? [i.author] : []), `${shortAge(i.updatedAt)} ago`])} mid={i.why ? <span className="state off">{i.why}</span> : null} onNavigate={onNavigate}>
            <SnoozeButton item={i} />
          </Row>
        ))}
        {rows.length > SUGGEST_SHOWN && (
          <button type="button" className="jrMore" onClick={() => onNavigate('/inbox')}>
            {rows.length - SUGGEST_SHOWN} more in your inbox
          </button>
        )}
      </div>
    </section>
  )
}

// ---------- With Junior ----------

/** Plan → approve → work → draft PR → babysit, as five bars and a line. */
function PipelineBars({ p }: { p: Pipeline }) {
  const line =
    p.done >= 5 ? 'Babysitting the PR'
    : p.done === 3 ? 'Draft PR open · not babysat'
    : p.at === 'you' ? `${PIPELINE_STEPS[p.done]} · needs you`
    : p.done === 0 ? 'Planning'
    : 'Working'
  return (
    <span className="pipe">
      <span className="bars" aria-hidden="true">
        {PIPELINE_STEPS.map((s, n) => (
          <i key={s} className={n < p.done ? 'done' : n === p.done && p.at ? (p.at === 'you' ? 'you' : 'now') : ''} />
        ))}
      </span>
      <span className="pl">{line}</span>
    </span>
  )
}

/** A With Junior row's line: never "nothing to do" while its watch is off. */
function watchLine(i: ScoredItem): string {
  const off = watchOffOf(i)
  if (off) return off === 'babysit' ? 'Babysitting is off' : 'Reviews are off'
  const w = i.junior!
  return handBackLine(i) ?? i.tasks?.line ?? (w.stage === 'watching' ? (i.reason === 'your-pr' ? 'Babysitting · nothing to do' : 'Waiting on a request') : '—')
}

const PLAYBOOK_WORD: Record<string, string> = { babysit: 'babysitting', review: 'first pass', answer: 'drafting a reply', 'debug-fix': 'debug and fix', investigate: 'investigating' }

export function JuniorWith({ day, onNavigate }: { day: JuniorDay | null } & Nav) {
  const items = useItems()
  const { busy, error, act } = useAct()
  const mine = items.filter((i) => i.junior)
  const byId = new Map(items.map((i) => [i.id, i]))
  const group = (stage: string) => mine.filter((i) => i.junior!.stage === stage)
  const needs = group('needs-you')
  const blocked = day?.needs ?? []
  const row = (i: ScoredItem) => {
    const w = i.junior!
    const pr = w.pr ? byId.get(w.pr) : undefined
    const prWaits = !!pr && pr.handoff !== 'on'
    return (
      <Row
        key={i.id}
        item={i}
        lead={<Dot tone={w.stage === 'needs-you' ? 'need' : w.stage === 'paused' ? 'paused' : w.stage === 'handed-in' ? 'ok' : 'live'} />}
        meta={joined([refOf(i), ...(i.playbook ? [PLAYBOOK_WORD[i.playbook] ?? i.playbook] : []), ...(i.tasks?.lastDone && w.stage === 'handed-in' ? [i.tasks.lastDone] : [])])}
        mid={w.pipeline ? <PipelineBars p={w.pipeline} /> : handBackLine(i) && !watchOffOf(i) && i.seen?.ready ? <ReadyChips ready={i.seen.ready} evidence={false} /> : <span className="state">{watchLine(i)}</span>}
        onNavigate={onNavigate}
      >
        {prWaits && (
          <button type="button" className="btn xs primary" disabled={busy === pr!.id} onClick={() => act('start', pr!.id)}>
            Babysit it
          </button>
        )}
        {w.stage === 'paused' ? (
          <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('resume', i.id)}>
            Resume
          </button>
        ) : w.stage === 'working' || w.stage === 'watching' ? (
          <button type="button" className="btn xs" disabled={busy === i.id} onClick={() => act('pause', i.id)}>
            Pause
          </button>
        ) : (
          !prWaits && (
            <button type="button" className={`btn xs${w.stage === 'needs-you' ? ' primary' : ''}`} onClick={() => onNavigate(itemHash(i.id))}>
              Open
            </button>
          )
        )}
      </Row>
    )
  }
  const section = (title: string, rows: ScoredItem[], aside?: string, extra?: ReactNode) =>
    rows.length > 0 || extra ? (
      <section aria-label={title}>
        <h2 className="jrLh">
          {title} <span className="n">{rows.length + (title === 'Needs you' ? blocked.length : 0)}</span>
          {aside && <span className="aside">{aside}</span>}
        </h2>
        <div className="hoRows">
          {rows.map(row)}
          {extra}
        </div>
      </section>
    ) : null
  if (mine.length === 0 && blocked.length === 0)
    return (
      <p className="jrQuiet">
        <JuniorFace mood="hello" size={18} motion="still" decorative />
        Nothing is handed to me yet. Pick something from Suggested, or hand it off from its page.
      </p>
    )
  return (
    <>
      {section('Needs you', needs, 'plans to approve, sends to OK, where I got stuck', blocked.length ? <div className="jrRows">{blocked.map((r) => <NeedsLine key={r.key} row={r} onNavigate={onNavigate} />)}</div> : undefined)}
      {section('Working', group('working'), 'plan → approve → work → draft PR → babysit')}
      {section('Watching', group('watching'), 'PRs I babysit, reviews I first-pass')}
      {section('Paused', group('paused'), 'nothing runs until you resume')}
      {section('Handed in', group('handed-in').slice(0, 8), 'done for now')}
      <Err error={error} />
    </>
  )
}

/** The tab counts: [shown, hot]. */
export function useHandoffCounts(day: JuniorDay | null): { suggested: number; prs: [number, number]; reviews: [number, number]; people: [number, number]; work: [number, number]; with: [number, number] } {
  const snap = useInbox()
  const items = snap.items as ScoredItem[]
  const people = items.filter((i) => sectionOf(i) === 'people')
  const work = items.filter((i) => sectionOf(i) === 'work')
  const prs = items.filter((i) => i.reason === 'your-pr')
  const reviews = items.filter((i) => i.reason === 'review-requested')
  const mine = items.filter((i) => i.junior)
  return {
    suggested: items.filter((i) => i.suggestion).length,
    prs: [prs.length, prs.filter((i) => i.junior?.stage === 'needs-you').length],
    reviews: [reviews.length, reviews.filter((i) => !i.handoff && !i.tasks?.review).length],
    // people waiting are hot until someone (you or Junior) is on it
    people: [people.length, people.filter((i) => !i.handoff && !i.junior).length],
    work: [work.length, work.filter((i) => i.junior?.stage === 'needs-you').length],
    with: [mine.length, mine.filter((i) => i.junior!.stage === 'needs-you').length + (day?.needs.length ?? 0)],
  }
}
