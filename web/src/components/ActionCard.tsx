/**
 * An outbound action as a stub card (.docs/action-card-variations.html, C and
 * C2): one closed row, what happened, where it landed, its status, that
 * opens to the details: where, who allowed it, why it counted, the exact
 * command or args, when. The same card under the tool call that made it (the
 * transcript), on the item page, and on the right of the Actions page.
 *
 * A queued action that needs you opens by default with the draft and the
 * verbs: Approve / Edit / Send back / Reject. Closed, its row keeps a quick ✓
 * / ✕. The ✓ only for what is cheap to take back (a ticket, a post draft, an
 * update); a message, an email, a comment or a PR has to be opened and read.
 * Approved, it shrinks to "Sending … in 12s · Undo", then settles.
 *
 * Under the title, a held (or sent) card says what pressing the button does:
 * the impact line (core/cards/impact.ts), "Comment on acme/api#3235 · as you
 * · can edit or delete, not unsend". It sits outside the Collapsible's body,
 * so a closed held card still shows it; a settled stub stays one row.
 *
 * Radix Collapsible owns the open/close; the row's link and buttons sit
 * beside its trigger, never inside it.
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import { Check, ChevronRight, ExternalLink, RotateCcw, X } from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { JuniorLabel } from './JuniorLabel.js'
import type { ActionView } from '../../../shared/protocol.js'
import { countdownText, impactParts, impactShown, payloadOf, quickApprovable } from '../../../core/actions/view.js'
import {
  actOn,
  allowedText,
  KIND_ICON,
  linkText,
  originText,
  shortLink,
  STATUS_TEXT,
  STATUS_TONE,
  toolText,
  useNow,
  whoText,
} from '../actions.js'
import { shortAge } from '../itemUi.js'
import { CardBody, CardEdit } from './CardView.js'
import type { TranscriptItem } from '../transcript.js'

/** A verb the Actions page's keyboard asks the open card to start (E edit, R reject, B send back). */
export type CardCommand = { kind: 'edit' | 'reject' | 'send_back'; n: number }

type Mode = 'view' | 'edit' | 'send_back' | 'reject'

export function ActionCard({
  a,
  onNavigate,
  pinnedOpen = false,
  command,
  footer,
  onChanged,
}: {
  a: ActionView
  onNavigate: (hash: string) => void
  /** the Actions page's detail: always open, no chevron */
  pinnedOpen?: boolean
  command?: CardCommand
  /** extra rows under the details (the Actions page's session/item links) */
  footer?: ReactNode
  /** after a verb succeeds (the list refetches on the frame anyway) */
  onChanged?: (a: ActionView) => void
}) {
  const needs = a.status === 'needs_you'
  const [open, setOpen] = useState(needs || pinnedOpen)
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const counting = a.status === 'scheduled' || a.status === 'sending'
  const now = useNow(counting || needs, counting ? 500 : 30_000)

  // A card that comes to need you opens; one that leaves it goes back to view mode.
  const wasNeeds = useRef(needs)
  useEffect(() => {
    if (needs && !wasNeeds.current) setOpen(true)
    if (!needs) setMode('view')
    wasNeeds.current = needs
  }, [needs])
  // A keyboard verb from the page, only a new one: a card mounting under an old command ignores it.
  const seenCommand = useRef(command?.n)
  useEffect(() => {
    if (!command || command.n === seenCommand.current) return
    seenCommand.current = command.n
    if (!needs) return
    setOpen(true)
    setMode(command.kind)
  }, [command?.n])

  async function run(verb: Parameters<typeof actOn>[0], body: Parameters<typeof actOn>[2] = {}) {
    setBusy(true)
    setErr(null)
    const r = await actOn(verb, a.id, body)
    setBusy(false)
    if (!r.ok) setErr(r.error)
    else {
      setMode('view')
      onChanged?.(r.action)
    }
  }

  const Icon = KIND_ICON[a.kind]
  const isOpen = pinnedOpen || open
  // The line reads the held draft (queue.args, your edit once approved), not an edit in progress.
  const impactArgs = a.queue?.args ?? a.args
  const impact = useMemo(
    () => impactParts({ tool: a.tool, args: impactArgs, kind: a.kind, link: a.link, groupKey: a.groupKey }, toolText(a.tool)),
    [a.tool, impactArgs, a.kind, a.link, a.groupKey],
  )
  // One action can show twice on a page (the item's Needs you block and its Actions list): ids stay unique.
  const impactId = `imp-${useId()}`

  // Approved: the slim undo row, counting down.
  const left = a.queue?.sendAt != null ? a.queue.sendAt - now : 0
  const undoRow = counting ? (
    <div className="astub go">
      {/* Only the state is announced: the countdown ticking every second is not. */}
      <span className="sr-only" role="status">
        {a.status === 'sending' ? `Sending: ${a.title}` : `Scheduled: ${a.title}. Undo is available for a few seconds.`}
      </span>
      <div className="arow1">
        <span className="dot wait" aria-hidden="true" />
        <span className="t1">
          {a.status === 'sending' ? 'Sending' : 'Scheduling'} · {a.title}
        </span>
        <span className="sp mono" aria-hidden="true">
          {a.status === 'sending' || left <= 0 ? 'going out…' : countdownText(left)}
        </span>
        {a.status === 'scheduled' && left > 0 && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => void run('undo')}>
            Undo
          </button>
        )}
      </div>
      {err && !pinnedOpen && <div className="astubErr">{err}</div>}
    </div>
  ) : null
  if (counting && !pinnedOpen) return undoRow

  const quick = needs && !isOpen
  const tone = STATUS_TONE[a.status]
  // On every held card, open or closed; on a settled one only once opened.
  const showImpact = impactShown(a.status) && (needs || isOpen)
  const describedBy = showImpact ? impactId : undefined
  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={pinnedOpen ? undefined : setOpen}
      className={`astub st-${a.status}${needs ? ' need' : ''}${a.status === 'failed' ? ' fail' : ''}${pinnedOpen ? ' pinned' : ''}`}
      // Waiting on you, or half-way through an edit / note: hold an automatic reload (reloadGuard.ts).
      data-reload-guard={mode !== 'view' ? 'edit' : needs ? 'card' : undefined}
    >
      <div className="arow1">
        <Collapsible.Trigger asChild disabled={pinnedOpen}>
          <button type="button" className="ahead" title={pinnedOpen ? a.title : isOpen ? 'Close' : 'Open'} aria-describedby={describedBy}>
            <Icon size={14} className="ic" aria-hidden="true" />
            <span className="t1">{a.title}</span>
            {a.count > 1 && <span className="pill mono">×{a.count}</span>}
          </button>
        </Collapsible.Trigger>
        {a.link && (
          <a className="lk" href={a.link} target="_blank" rel="noreferrer" title={a.link}>
            <span>{shortLink(a.link)}</span>
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
        {quick ? (
          <span className="quick">
            {quickApprovable(a.kind) && (
              <button type="button" className="btn xs ok" title="Approve as drafted" aria-label={`Approve: ${a.title}`} aria-describedby={describedBy} disabled={busy} onClick={() => void run('approve')}>
                <Check size={12} aria-hidden="true" />
              </button>
            )}
            <button type="button" className="btn xs" title="Reject" aria-label={`Reject: ${a.title}`} aria-describedby={describedBy} disabled={busy} onClick={() => void run('reject', { reason: '' })}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ) : null}
        {a.status === 'failed' && a.queue && !isOpen && (
          <button type="button" className="btn xs" title="Schedule it again" disabled={busy} onClick={() => void run('retry')}>
            <RotateCcw size={11} aria-hidden="true" /> Retry
          </button>
        )}
        <span className={`pill ${tone}`}>
          {needs && <span className="dot need" aria-hidden="true" />}
          {STATUS_TEXT[a.status]}
        </span>
        {!pinnedOpen && (
          <button type="button" className="chev" aria-label={isOpen ? 'Close' : 'Open'} onClick={() => setOpen(!isOpen)}>
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {showImpact && <ImpactLine id={impactId} parts={impact} />}
      <Collapsible.Content className="abody">
        {undoRow}
        {needs ? (
          <NeedsYou a={a} mode={mode} setMode={setMode} busy={busy} now={now} run={run} />
        ) : (
          <Details a={a} busy={busy} run={run} onNavigate={onNavigate} showCounted={!pinnedOpen} />
        )}
        {err && <div className="astubErr">{err}</div>}
        {footer}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

/**
 * What pressing the button does, in one muted mono line under the title. Each
 * part is a unit that wraps as one, so the line breaks at " · " and never
 * inside a claim. Screen readers hear ", " for the dot.
 */
export function ImpactLine({ id, parts }: { id?: string; parts: readonly string[] }) {
  return (
    <div className="aimpact" id={id}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              <span className="asep" aria-hidden="true">
                {' · '}
              </span>
              <span className="sr-only">, </span>
            </>
          )}
          <span className="apart">{p}</span>
        </Fragment>
      ))}
    </div>
  )
}

type Run = (verb: Parameters<typeof actOn>[0], body?: Parameters<typeof actOn>[2]) => Promise<void>

/** The draft and the verbs: what goes out, word for word, and what you can do about it. */
function NeedsYou({ a, mode, setMode, busy, now, run }: { a: ActionView; mode: Mode; setMode: (m: Mode) => void; busy: boolean; now: number; run: Run }) {
  const args = a.queue?.args ?? a.args
  const expires = a.queue ? a.queue.expiresAt - now : 0
  const expiry = expires > 0 ? `expires ${countdownText(expires)}` : 'expired'
  const meta = `${toolText(a.tool)} · ${originText(a)}`
  if (mode === 'edit') {
    const onApprove = (next: Record<string, unknown>) => void run('approve', { args: next })
    return a.card ? (
      <CardEdit plan={a.card} args={args} busy={busy} onCancel={() => setMode('view')} onApprove={onApprove} />
    ) : (
      <EditArgs args={args} busy={busy} onCancel={() => setMode('view')} onApprove={onApprove} />
    )
  }
  return (
    <>
      {a.card ? <CardBody plan={a.card} args={args} /> : <Payload args={args} />}
      {mode === 'send_back' || mode === 'reject' ? (
        <NoteForm
          key={mode}
          label={mode === 'send_back' ? 'What should change?' : 'Why not? (optional)'}
          placeholder={mode === 'send_back' ? 'Shorter, and link the PR…' : 'Not now / wrong channel…'}
          go={mode === 'send_back' ? 'Send back' : 'Reject'}
          required={mode === 'send_back'}
          busy={busy}
          onCancel={() => setMode('view')}
          onGo={(text) => void run(mode === 'send_back' ? 'send-back' : 'reject', mode === 'send_back' ? { notes: text } : { reason: text })}
        />
      ) : (
        <div className="averbs">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void run('approve')}>
            <Check size={12} aria-hidden="true" /> {a.card?.verb ?? 'Approve'}
          </button>
          <button type="button" className="btn sm outline" disabled={busy} onClick={() => setMode('edit')}>
            Edit
          </button>
          <button type="button" className="btn sm outline" disabled={busy} onClick={() => setMode('send_back')}>
            Send back
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setMode('reject')}>
            Reject
          </button>
          <span className="ameta mono" title={`${expiry} · ${meta} · #${a.short} · ${a.counted}`}>
            {/* The expiry never clips: it leads, and only the tool and origin give way. */}
            <span className="aexp">{expiry}</span>
            <span className="arest"> · {meta}</span>
          </span>
        </div>
      )}
    </>
  )
}

/** The args readably: where it goes, then its text fields, or the JSON when it has none. */
function Payload({ args }: { args: Record<string, unknown> }) {
  const p = payloadOf(args)
  return (
    <div className="apayload">
      {p.target.length > 0 && (
        <div className="atarget mono">
          {p.target.map((t) => (
            <span key={t.key}>
              {t.key}: {t.text}
            </span>
          ))}
        </div>
      )}
      {p.json !== null ? (
        <pre className="ajson">{p.json}</pre>
      ) : (
        p.fields.map((f, i) => (
          <div key={f.key} className={`afield${i === 0 && p.fields.length > 1 ? ' lead' : ''}`}>
            {f.text}
          </div>
        ))
      )}
    </div>
  )
}

/**
 * Edit, then approve: one box per readable field, or the whole args as JSON.
 * What you approve here is what goes out. The server checks it is a JSON
 * object, and the dispatch fence holds the run to it.
 */
function EditArgs({
  args,
  busy,
  onCancel,
  onApprove,
}: {
  args: Record<string, unknown>
  busy: boolean
  onCancel: () => void
  onApprove: (args: Record<string, unknown>) => void
}) {
  const p = payloadOf(args)
  const [asJson, setAsJson] = useState(p.json !== null)
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(p.fields.map((f) => [f.key, f.text])))
  const [json, setJson] = useState(() => JSON.stringify(args, null, 2))
  const [bad, setBad] = useState<string | null>(null)
  const first = useRef<HTMLTextAreaElement>(null)
  useEffect(() => first.current?.focus(), [asJson])

  function approve() {
    if (!asJson) return onApprove({ ...args, ...fields })
    try {
      const v = JSON.parse(json) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the args must be a JSON object')
      onApprove(v as Record<string, unknown>)
    } catch (err) {
      setBad(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aedit">
      {asJson ? (
        <textarea
          ref={first}
          className="ajsonEdit mono"
          value={json}
          spellCheck={false}
          rows={Math.min(18, json.split('\n').length + 1)}
          onChange={(e) => {
            setJson(e.target.value)
            setBad(null)
          }}
          aria-label="Arguments as JSON"
        />
      ) : (
        p.fields.map((f, i) => (
          <label key={f.key} className="afieldEdit">
            <span className="mono">{f.key}</span>
            <textarea
              ref={i === 0 ? first : undefined}
              value={fields[f.key] ?? ''}
              rows={Math.min(12, Math.max(2, Math.ceil((fields[f.key] ?? '').length / 70)))}
              onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
            />
          </label>
        ))
      )}
      {bad && <div className="astubErr">{bad}</div>}
      <div className="averbs">
        <button type="button" className="btn sm primary" disabled={busy} onClick={approve}>
          <Check size={12} aria-hidden="true" /> Approve edited
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {p.json === null && (
          <button type="button" className="btn sm ghost amore" onClick={() => setAsJson((v) => !v)}>
            {asJson ? 'Edit fields' : 'Edit as JSON'}
          </button>
        )}
      </div>
    </div>
  )
}

function NoteForm({
  label,
  placeholder,
  go,
  required,
  busy,
  onCancel,
  onGo,
}: {
  label: string
  placeholder: string
  go: string
  required: boolean
  busy: boolean
  onCancel: () => void
  onGo: (text: string) => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="anote">
      <label>
        <span>{label}</span>
        <textarea
          ref={ref}
          value={text}
          rows={3}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (!required || text.trim())) onGo(text)
            if (e.key === 'Escape') onCancel()
          }}
        />
      </label>
      <div className="averbs">
        <button type="button" className={`btn sm ${go === 'Reject' ? 'danger' : 'primary'}`} disabled={busy || (required && !text.trim())} onClick={() => onGo(text)}>
          {go}
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** A settled (or stopped) action's facts. */
function Details({
  a,
  busy,
  run,
  onNavigate,
  showCounted,
}: {
  a: ActionView
  busy: boolean
  run: Run
  onNavigate: (hash: string) => void
  /** off where the page's own footer says it (with its "not an action?") */
  showCounted: boolean
}) {
  const q = a.queue
  const command = a.tool === 'Bash' && typeof a.args.command === 'string' ? a.args.command : null
  const args = q?.args ?? a.args
  return (
    <>
      <dl className="akv">
        {a.link && (
          <>
            <dt>where</dt>
            <dd className="mono">
              <a href={a.link} target="_blank" rel="noreferrer">
                {linkText(a.link)}
              </a>
            </dd>
          </>
        )}
        {a.error && (
          <>
            <dt>{a.status === 'unknown' ? 'unknown' : a.status === 'denied' ? 'denied' : 'error'}</dt>
            <dd className="err">{a.error}</dd>
          </>
        )}
        {q?.note && (
          <>
            <dt>{a.status === 'rejected' ? 'reason' : 'notes'}</dt>
            <dd>{q.note}</dd>
          </>
        )}
        {a.status === 'sent_back' && (
          <>
            <dt>notes</dt>
            <dd>{q?.delivery === 'delivered' ? 'delivered — the session is redrafting' : q?.delivery ? `${q.delivery} — the notes stay here` : 'on their way when its run ends'}</dd>
          </>
        )}
        <dt>allowed by</dt>
        <dd>{allowedText(a)}</dd>
        {showCounted && (
          <>
            <dt>counted</dt>
            <dd>{a.counted}</dd>
          </>
        )}
        <dt>{command ? 'command' : 'tool'}</dt>
        <dd className="mono">{command ?? toolText(a.tool)}</dd>
        {a.card && Object.keys(args).length > 0 && (
          <>
            <dt>{a.status === 'succeeded' || a.status === 'attempted' ? 'sent' : 'draft'}</dt>
            <dd>
              <CardBody plan={a.card} args={args} />
            </dd>
          </>
        )}
        {!command && !a.card && Object.keys(args).length > 0 && (
          <>
            <dt>args</dt>
            <dd className="mono">
              <pre className="ajson">{JSON.stringify(args, null, 2)}</pre>
            </dd>
          </>
        )}
        <dt>when</dt>
        <dd>
          {shortAge(a.attemptedAt)} ago ·{' '}
          <button type="button" className="alink" onClick={() => onNavigate(a.sessionId)}>
            {whoText(a)}
          </button>
          {q?.costUsd != null && <span className="mono"> · sent for ${q.costUsd.toFixed(3)}</span>}
        </dd>
        {a.history && a.history.length > 0 && (
          <>
            <dt>history</dt>
            <dd>
              <ol className="ahist">
                {a.history.map((h, i) => (
                  <li key={i}>
                    <span className="mono">{new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> {h.event}
                    {h.actor === 'you' ? ' by you' : h.actor === 'agent' ? ' by the agent' : ''}
                    {h.note ? ` — ${h.note}` : ''}
                  </li>
                ))}
              </ol>
            </dd>
          </>
        )}
      </dl>
      {q && (a.status === 'failed' || a.status === 'unknown') && (
        <div className="averbs">
          {a.status === 'unknown' && <span className="awarn">It may have gone out. Check {a.link ? 'the link' : 'where it was going'} before retrying.</span>}
          <button type="button" className="btn sm outline" disabled={busy} onClick={() => void run('retry')}>
            <RotateCcw size={12} aria-hidden="true" /> {a.status === 'unknown' ? 'Checked — retry' : 'Retry'}
          </button>
        </div>
      )}
    </>
  )
}

/** The cards for a run of tool calls, once per record, however many of its calls are here. */
export function ActionNotes({
  tools,
  byCall,
  onNavigate,
}: {
  tools: readonly TranscriptItem[]
  byCall: ReadonlyMap<string, ActionView>
  onNavigate: (hash: string) => void
}) {
  if (!byCall.size) return null
  const seen = new Set<string>()
  const list: ActionView[] = []
  for (const t of tools) {
    const a = t.kind === 'tool' && t.id ? byCall.get(t.id) : undefined
    if (a && !a.hidden && !seen.has(a.id)) {
      seen.add(a.id)
      list.push(a)
    }
  }
  if (!list.length) return null
  const waiting = list.filter((a) => a.status === 'needs_you').length
  return (
    <div className="astubs">
      {/* In a chat, a send held for you is Junior asking: say so above the stubs. */}
      {waiting > 0 && (
        <div className="astubsWho">
          <JuniorLabel mood="needs" say="Nothing goes out until you approve it"> needs your OK to send {waiting === 1 ? 'this' : `these ${waiting}`}</JuniorLabel>
        </div>
      )}
      {list.map((a) => (
        <ActionCard key={a.id} a={a} onNavigate={onNavigate} />
      ))}
    </div>
  )
}

/** An item's actions, newest first, as stubs. The ones waiting on you open. */
export function ItemActions({ actions, onNavigate }: { actions: readonly ActionView[]; onNavigate: (hash: string) => void }) {
  return (
    <div className="astubs item">
      {actions.map((a) => (
        <ActionCard key={a.id} a={a} onNavigate={onNavigate} />
      ))}
    </div>
  )
}
