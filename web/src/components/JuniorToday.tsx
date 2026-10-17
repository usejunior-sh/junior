/**
 * The Junior page's two working tabs: Today's goals (one list, every row with
 * an owner, ending in "Also today…") and Blocked on you (what holds Junior
 * until you answer). On a first open, no plan yet, nothing used, Junior
 * says what it can see and offers work instead (JuniorFirstOpen).
 */
import { X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { JuniorDay, NeedsRow, PlanRow } from '../../../shared/protocol.js'
import type { Mood } from '../../../core/junior/mood.js'
import { addToday, draftToday, matchToday, removeToday, startJuniorChat, usePersona } from '../junior.js'
import { itemHash } from '../hooks.js'
import { JuniorFace } from './JuniorFace.js'

type Props = {
  day: JuniorDay
  onNavigate: (hash: string) => void
  onDispatch: (itemId: string) => void
}

/** Today's goals: the shared plan, then "Also today…". */
export function JuniorGoals({ day, onNavigate, onDispatch }: Props) {
  const persona = usePersona()
  const [fresh, setFresh] = useState<string | null>(null)
  return (
    <section aria-label="Today's goals">
      <h2 className="jrLh">
        Today's goals{' '}
        <span className="n">
          {day.plan.done} of {day.plan.total} done
        </span>
        <span className="aside">{day.plan.drafted ? 'I drafted it from your inbox · ' : ''}every session today can see it</span>
      </h2>
      <div className="jrPlan">
        {day.plan.rows.map((r) => (
          <PlanLine key={r.itemId} row={r} you={day.you} name={persona.name} fresh={fresh === r.itemId} onNavigate={onNavigate} onDispatch={onDispatch} />
        ))}
        {day.plan.total === 0 && <p className="jrEmpty">Nothing on it yet. Tell me what's on your plate.</p>}
        <AlsoToday name={persona.name} onAdded={setFresh} />
      </div>
    </section>
  )
}

/** Blocked on you: what holds Junior until you answer. People waiting on you are in the brief. */
export function JuniorBlocked({ day, onNavigate }: Pick<Props, 'day' | 'onNavigate'>) {
  if (day.needs.length === 0)
    return (
      <p className="jrQuiet">
        <JuniorFace mood="hello" size={18} motion="still" decorative />
        Nothing is blocking me. I'll put anything I can't go on without here, with my best guess.
      </p>
    )
  return (
    <section aria-label="Blocked on you">
      <h2 className="jrLh">
        Blocked on you <span className="n">{day.needs.length}</span>
        <span className="aside">only what stops me · people waiting on you are in the brief</span>
      </h2>
      <div className="jrRows">
        {day.needs.map((r) => (
          <NeedsLine key={r.key} row={r} onNavigate={onNavigate} />
        ))}
      </div>
    </section>
  )
}

/** A Needs-you row: a small orange dot, what it is, where from, and the verb. */
function NeedsLine({ row, onNavigate }: { row: NeedsRow; onNavigate: (hash: string) => void }) {
  const go = () => onNavigate(row.target.kind === 'session' ? row.target.id : '/actions')
  return (
    <button type="button" className="jrRow need" onClick={go}>
      <span className="t">{row.title}</span>
      <span className="m">{row.meta}</span>
      <span className="r">{row.right}</span>
      <span className="go">{row.go}</span>
    </button>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
function clock(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : d.toLocaleDateString(undefined, { weekday: 'short' })
}

function age(since: number): string {
  const m = Math.max(0, Math.floor((Date.now() - since) / 60_000))
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** The row's face: what Junior is doing about it. */
function rowMood(r: PlanRow): Mood {
  switch (r.status.kind) {
    case 'done':
      return 'done'
    case 'live':
      return 'working'
    case 'needs':
      return 'needs'
    default:
      return 'hello'
  }
}

function StatusCell({ row, onDispatch }: { row: PlanRow; onDispatch: (itemId: string) => void }) {
  const s = row.status
  if (row.startable && s.kind !== 'done')
    return (
      <span className="st">
        <button
          type="button"
          className="btn xs jrStart"
          onClick={(e) => {
            e.stopPropagation()
            onDispatch(row.itemId)
          }}
        >
          Start
        </button>
      </span>
    )
  switch (s.kind) {
    case 'done':
      return <span className="st good">done{s.at ? ` ${clock(s.at)}` : ''}</span>
    case 'needs':
      return <span className="st warn">needs you</span>
    case 'live':
      return <span className="st live">{s.step ? `step ${s.step.n} of ${s.step.of}` : 'working'}</span>
    case 'waiting':
      return (
        <span className="st warn">
          {s.who ? <span className="who">{s.who} </span> : null}
          {s.who ? 'waited' : 'waiting'} {age(s.since)}
        </span>
      )
    case 'carried':
      return <span className="st carry">carried</span>
    case 'todo':
      return <span className="st">{s.note ?? ''}</span>
  }
}

function PlanLine({
  row,
  you,
  name,
  fresh,
  onNavigate,
  onDispatch,
}: {
  row: PlanRow
  you: JuniorDay['you']
  name: string
  fresh: boolean
  onNavigate: (hash: string) => void
  onDispatch: (itemId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const done = row.status.kind === 'done'
  const open = () => {
    if (row.status.kind === 'live' || row.status.kind === 'needs') onNavigate(row.status.sessionId)
    else if (!row.missing) onNavigate(itemHash(row.itemId))
  }
  return (
    <div className={`jrPlanRow${done ? ' done' : ''}${fresh ? ' fresh' : ''}`} onClick={open}>
      <span className="ck" role="img" aria-label={done ? 'done' : 'not done'} />
      <button type="button" className="t" title={row.title} onClick={(e) => (e.stopPropagation(), open())}>
        {row.title}
      </button>
      <span className="src" title={row.itemId}>
        {row.ref}
      </span>
      <span className="own">
        {row.owner === 'you' ? (
          <>
            <span className="you" aria-hidden="true">
              {you.initial}
            </span>
            You
          </>
        ) : (
          <>
            <span className="mf">
              <JuniorFace mood={rowMood(row)} size={16} motion="still" decorative />
            </span>
            <span className="nm">{name}</span>
          </>
        )}
      </span>
      <StatusCell row={row} onDispatch={onDispatch} />
      <button
        type="button"
        className="rm"
        title="Take it off today (the item stays in your inbox)"
        aria-label={`Take “${row.title}” off today`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          void removeToday(row.itemId).finally(() => setBusy(false))
        }}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

type Reply =
  | { kind: 'found'; id: string; title: string; ref: string; onToday: boolean }
  | { kind: 'none'; text: string }
  | { kind: 'error'; text: string }

/**
 * "Also today…": Junior looks for a work item before adding anything. Found
 * → whose is it today? Not found → create one and put it on today?
 */
function AlsoToday({ name, onAdded, placeholder }: { name: string; onAdded: (itemId: string | null) => void; placeholder?: string }) {
  const [text, setText] = useState('')
  const [reply, setReply] = useState<Reply | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    const m = await matchToday(q)
    setBusy(false)
    if (typeof m === 'string') setReply({ kind: 'error', text: m })
    else if (m) setReply({ kind: 'found', ...m })
    else setReply({ kind: 'none', text: q })
  }

  const add = async (req: { itemId?: string; title?: string; owner: 'you' | 'junior' }) => {
    setBusy(true)
    const err = await addToday(req)
    setBusy(false)
    if (err) {
      setReply({ kind: 'error', text: err })
      return
    }
    setReply(null)
    setText('')
    onAdded(req.itemId ?? null)
    input.current?.focus()
  }

  const close = () => {
    setReply(null)
    input.current?.focus()
  }

  return (
    <>
      <form className="jrAdd" onSubmit={(e) => void submit(e)}>
        <span className="plus" aria-hidden="true">
          +
        </span>
        <input
          ref={input}
          aria-label="Add to today"
          placeholder={placeholder ?? 'Also today… a title, a ref like #455, or a link'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (reply) setReply(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && reply) {
              e.preventDefault()
              close()
            }
          }}
        />
        <kbd aria-hidden="true">↵</kbd>
      </form>
      {reply && (
        <div className="jrReply" role="status">
          <span className="mf">
            <JuniorFace mood={reply.kind === 'error' ? 'stuck' : 'think'} size={20} motion="still" decorative />
          </span>
          <div>
            {reply.kind === 'found' ? (
              reply.onToday ? (
                <>
                  <div className="txt">
                    That's <b>{reply.ref}</b>, already on today: “{reply.title}”.
                  </div>
                  <div className="acts">
                    <button type="button" className="btn sm" onClick={close}>
                      OK
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="txt">
                    That's <b>{reply.ref}</b> in your inbox: “{reply.title}”. Whose is it today?
                  </div>
                  <div className="acts">
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => void add({ itemId: reply.id, owner: 'you' })}>
                      Mine
                    </button>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void add({ itemId: reply.id, owner: 'junior' })}>
                      Give it to {name}
                    </button>
                  </div>
                </>
              )
            ) : reply.kind === 'none' ? (
              <>
                <div className="txt">There's no work item for “{reply.text}”. Create one and put it on today?</div>
                <div className="acts">
                  <button type="button" className="btn sm primary" disabled={busy} onClick={() => void add({ title: reply.text, owner: 'you' })}>
                    Create it, mine
                  </button>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void add({ title: reply.text, owner: 'junior' })}>
                    Create it for {name}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={close}>
                    Not now
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="txt">That didn't work: {reply.text}</div>
                <div className="acts">
                  <button type="button" className="btn sm ghost" onClick={close}>
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** No plan yet, nothing used: what Junior can see, and work it found there. */
export function JuniorFirstOpen({ day }: { day: JuniorDay }) {
  const persona = usePersona()
  const [drafting, setDrafting] = useState(false)
  const seen = day.seen
  const connected = seen?.sources.filter((s) => s.connected) ?? []
  const missing = seen?.sources.find((s) => !s.connected)
  const shown = connected.slice(0, 4)
  useEffect(() => setDrafting(false), [day.plan.total])
  return (
    <>
      {seen && (
        <ul className="jrSeen" aria-label={`What ${persona.name} can see`}>
          <li>
            <i className={seen.github ? '' : 'off'} />
            {seen.github ? (
              <span>
                GitHub as <span className="mono">{seen.github}</span>
              </span>
            ) : (
              'GitHub not signed in (gh)'
            )}
          </li>
          {shown.map((s) => (
            <li key={s.name}>
              <i />
              {s.name}
            </li>
          ))}
          {connected.length > shown.length && (
            <li>
              <i />
              {connected.length - shown.length} more connected
            </li>
          )}
          <li>
            <i className={seen.projects.length ? '' : 'off'} />
            <span>
              {seen.projects.length === 0 ? (
                'No projects yet'
              ) : (
                <>
                  {seen.projects.length} {seen.projects.length === 1 ? 'project' : 'projects'}:{' '}
                  {seen.projects.slice(0, 3).map((p, i) => (
                    <span key={p}>
                      {i > 0 && ', '}
                      <span className="mono">{p}</span>
                    </span>
                  ))}
                  {seen.projects.length > 3 ? '…' : ''}
                </>
              )}
            </span>
          </li>
          {missing && (
            <li>
              <i className="off" />
              {missing.name} not connected
            </li>
          )}
        </ul>
      )}
      <h2 className="jrLh">We don't have a plan for today yet</h2>
      <p className="jrOfferH">
        Tell me what's on your plate and I'll make it our plan, or{' '}
        <button
          type="button"
          className="jrRef"
          disabled={drafting}
          onClick={() => {
            setDrafting(true)
            void draftToday()
          }}
        >
          draft one from your inbox
        </button>
        .
      </p>
      <div className="jrPlan">
        <AlsoToday name={persona.name} onAdded={() => {}} placeholder="What's on your plate today? A title, a ref like #455, or a link" />
      </div>
      {day.offers.length > 0 && <p className="jrOfferH jrOr">Or start with one of these, picked from what I can see:</p>}
      {day.offers.length > 0 && (
        <div className="jrOffers">
          {day.offers.map((o) => (
            <button key={o.title} type="button" className="jrOffer" onClick={() => startJuniorChat(o.say, o.intent ? { intent: o.intent } : {})}>
              <span>
                <span className="t">{o.title}</span>
                <br />
                <span className="d">{o.detail}</span>
              </span>
              <span className="because">{o.because}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
