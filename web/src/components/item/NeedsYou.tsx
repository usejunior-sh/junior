import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { ActionView, ScoredItem } from '../../../../shared/protocol.js'
import type { ItemTask } from '../../../../core/work/tasks.js'
import type { Verdict } from '../../../../core/work/verdict.js'
import { requestCommands } from '../../../../core/babysit/reviewer.js'
import { ItemActions } from '../ActionCard.js'
import { PostReview } from './PostReview.js'
import { taskVerb, type TaskVerb } from './useItemTasks.js'

const prOf = (itemId: string) => {
  const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(itemId)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** "cursor[bot]" → "Bugbot", "coderabbitai[bot]" → "coderabbitai" (core/babysit/watch.ts botName). */
const botName = (login: string) => {
  const base = login.replace(/\[bot\]$/, '')
  return base === 'cursor' ? 'Bugbot' : base
}

/** A bot's comment as one readable paragraph: no HTML, badges, folded details or links to "fix in". */
export function plainClaim(body: string, max = 360): string {
  const s = body
    .replace(/^#{1,6}\s*(.+?)\s*$/gm, '$1.')
    .replace(/^\*\*(.+?)\*\*\s*$/gm, '$1.')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<details>[\s\S]*?<\/details>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

type Act = (verb: TaskVerb, t: ItemTask, extra?: Record<string, unknown>) => Promise<void>

/**
 * Everything on this item that waits on you, each with the answer Junior
 * recommends where it has one. Nothing on a card goes out until you press it.
 */
export function NeedsYou({ item, verdict, tasks, held, onChanged, onNavigate, onSnooze }: {
  item: ScoredItem
  verdict: Verdict
  tasks: ItemTask[]
  held: ActionView[]
  onChanged: () => void
  onNavigate: (hash: string) => void
  onSnooze: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const waiting = tasks.filter((t) => t.state === 'waiting').sort((a, b) => a.createdAt - b.createdAt)
  const ownAsk = !verdict.handedOff && verdict.turn === 'you' && waiting.length === 0 && held.length === 0

  const act: Act = async (verb, t, extra = {}) => {
    setBusy(t.id)
    setError(null)
    const err = await taskVerb(verb, { id: t.id, ...extra })
    setBusy(null)
    if (err) setError(err)
    onChanged()
  }

  if (!ownAsk && waiting.length === 0 && held.length === 0)
    return (
      <div className="emptyLine">
        {verdict.turn === 'junior'
          ? 'Nothing needs you. Junior will ask here if it needs you.'
          : verdict.turn === 'you'
            ? 'Nothing waits on a card here. The line above says what’s next.'
            : 'Nothing needs you on this item.'}
      </div>
    )

  return (
    <div className="needsYou">
      {ownAsk && <OwnAsk item={item} onSnooze={onSnooze} />}
      {waiting.map((t) => {
        const props = { t, busy: busy === t.id, act }
        switch (t.step) {
          case 'request-review':
            return <RequestCard key={t.id} {...props} itemId={item.id} />
          case 'post-review':
            return (
              <div key={t.id} className="needCard">
                <div className="nTop"><span className="nTitle">{t.title}</span></div>
                <PostReview task={t} itemId={item.id} busy={busy === t.id} onAct={(verb, extra) => void act(verb, t, extra)} onNavigate={onNavigate} />
              </div>
            )
          case 'send-reply':
            return <ReplyCard key={t.id} {...props} slack={item.source === 'slack'} />
          case 'approve-plan':
            return <PlanCard key={t.id} {...props} onNavigate={onNavigate} />
          default:
            return <TaskCard key={t.id} {...props} onNavigate={onNavigate} />
        }
      })}
      {held.length > 0 && <ItemActions actions={held} onNavigate={onNavigate} />}
      {error && <div className="notice">{error}</div>}
    </div>
  )
}

/** Nobody has the item yet: the ask itself is what needs you. */
function OwnAsk({ item, onSnooze }: { item: ScoredItem; onSnooze: () => void }) {
  const from = item.source === 'manual' ? null : item.author
  const why = item.why && item.source !== 'manual' ? item.why : item.rankWhy
  return (
    <div className="needCard">
      <div className="nTop">
        {from && <span className="nWho">{from}</span>}
        <span className="nMeta">{item.source === 'manual' ? 'your to-do' : item.source}</span>
        {item.url && (
          <a className="nLink" href={item.url} target="_blank" rel="noreferrer">
            open <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="nClaim">{item.title}</div>
      {why && (
        <div className="nRead">
          <span>
            <b>Why it’s here:</b> {why}
          </span>
        </div>
      )}
      <div className="nActs">
        {item.url && (
          <a className="btn xs primary" href={item.url} target="_blank" rel="noreferrer">
            Do it yourself <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
        <button type="button" className="btn xs ghost" onClick={onSnooze}>
          Snooze till 9:00 tomorrow
        </button>
        <span className="nFine">or hand it to Junior above</span>
      </div>
    </div>
  )
}

function RequestCard({ t, busy, act, itemId }: { t: ItemTask; busy: boolean; act: Act; itemId: string }) {
  const [who, setWho] = useState(str(t.input?.reviewer))
  const pr = prOf(itemId)
  let cmds: string[] = []
  try {
    cmds = pr && who ? requestCommands(pr, who, t.input?.draft === true).map((c) => `gh ${c.join(' ')}`) : []
  } catch {
    cmds = []
  }
  return (
    <div className="needCard">
      <div className="nTop"><span className="nTitle">{t.title}</span></div>
      <div className="nRead">Checks are green and nothing is open. Pick who reviews it. The request goes out only when you press it.</div>
      <div className="nActs">
        <input className="reviewer" value={who} placeholder="GitHub login" aria-label="Reviewer" onChange={(e) => setWho(e.target.value.trim())} />
        <button type="button" className="btn xs primary" disabled={busy || !who || cmds.length === 0} onClick={() => void act('approve', t, { reviewer: who })}>
          Request review
        </button>
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => void act('skip', t)}>
          Not now
        </button>
      </div>
      {cmds.length > 0 && <code className="cmds">{cmds.join('  &&  ')}</code>}
    </div>
  )
}

function ReplyCard({ t, busy, act, slack }: { t: ItemTask; busy: boolean; act: Act; slack: boolean }) {
  const [reply, setReply] = useState(str(t.input?.reply))
  const unsure = str(t.input?.unsure)
  return (
    <div className="needCard">
      <div className="nTop">
        <span className="jrMark" aria-hidden="true">J</span>
        <span className="nTitle">{t.title}</span>
        <span className="nMeta">sent word for word</span>
      </div>
      {unsure && (
        <div className="nRead">
          <span>
            <b>Junior couldn’t confirm:</b> {unsure}
          </span>
        </div>
      )}
      <div className="nRec">
        <div className="nRecHead"><span className="tag">Junior’s draft</span>Edit it, then send.</div>
        <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={Math.min(10, Math.max(3, reply.split('\n').length + 1))} />
      </div>
      <div className="nActs">
        {slack ? (
          <button type="button" className="btn xs primary" disabled={busy || !reply.trim()} onClick={() => void act('send-reply', t, { reply })}>
            Send
          </button>
        ) : (
          <>
            <button type="button" className="btn xs" onClick={() => void navigator.clipboard?.writeText(reply)}>
              Copy
            </button>
            <button type="button" className="btn xs primary" disabled={busy} onClick={() => void act('send-reply', t, { reply, byHand: true })}>
              I sent it
            </button>
          </>
        )}
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => void act('skip', t)}>
          Not now
        </button>
        <span className="nFine">{slack ? 'one send · as you · Slack' : 'copy it and send it yourself'}</span>
      </div>
    </div>
  )
}

function PlanCard({ t, busy, act, onNavigate }: { t: ItemTask; busy: boolean; act: Act; onNavigate: (hash: string) => void }) {
  const [note, setNote] = useState('')
  const artifactId = str(t.input?.artifactId)
  const confidence = str(t.input?.confidence)
  return (
    <div className="needCard">
      <div className="nTop">
        <span className="jrMark" aria-hidden="true">J</span>
        <span className="nTitle">{t.title}</span>
        {confidence && <span className="nMeta">confidence: {confidence}</span>}
        {artifactId && (
          <button type="button" className="linkBtn" onClick={() => onNavigate(`/artifact/${artifactId}`)}>
            Read the plan
          </button>
        )}
      </div>
      <div className="nRead">Approve it and Junior fixes it on its own branch, then opens a draft PR. Or send it back with what should change.</div>
      <div className="nRec">
        <textarea value={note} placeholder="A note for Junior (optional to approve, needed to send back)" onChange={(e) => setNote(e.target.value)} rows={2} />
      </div>
      <div className="nActs">
        <button type="button" className="btn xs primary" disabled={busy} onClick={() => void act('approve-plan', t, note.trim() ? { note } : {})}>
          Approve the plan
        </button>
        <button type="button" className="btn xs" disabled={busy || !note.trim()} onClick={() => void act('change-plan', t, { note })}>
          Send it back
        </button>
      </div>
    </div>
  )
}

/** A question Junior handed in, or a task that is yours: what it's about, what Junior said, and the way out. */
function TaskCard({ t, busy, act, onNavigate }: { t: ItemTask; busy: boolean; act: Act; onNavigate: (hash: string) => void }) {
  const author = str(t.input?.author)
  const path = str(t.input?.path)
  const body = str(t.input?.body)
  const url = str(t.input?.url)
  return (
    <div className="needCard">
      <div className="nTop">
        {author && <span className="nWho">{botName(author)}</span>}
        {path && <span className="nMeta mono">{path.split('/').pop()}</span>}
        {!author && <span className="nTitle">{t.title}</span>}
        {url && (
          <a className="nLink" href={url} target="_blank" rel="noreferrer">
            thread <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
      </div>
      {body && (
        <div className="nClaim">
          <b>Its claim:</b> {plainClaim(body)}
        </div>
      )}
      {t.error && (
        <div className="nRead">
          {t.owner === 'junior' && <span className="jrMark" aria-hidden="true">J</span>}
          <span>{t.error}</span>
        </div>
      )}
      <div className="nActs">
        {t.sessionId && (
          <button type="button" className="btn xs" onClick={() => onNavigate(t.sessionId!)}>
            Open the session
          </button>
        )}
        {t.owner === 'junior' && (
          <button type="button" className="btn xs" disabled={busy} onClick={() => void act('retry', t)}>
            Have Junior try again
          </button>
        )}
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => void act('skip', t)}>
          Skip
        </button>
        {t.whyDetail && <span className="nFine">{t.whyDetail}</span>}
      </div>
    </div>
  )
}
