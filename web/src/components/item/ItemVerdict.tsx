import { useState } from 'react'
import type { ScoredItem } from '../../../../shared/protocol.js'
import type { ItemTask } from '../../../../core/work/tasks.js'
import type { Verdict } from '../../../../core/work/verdict.js'
import { relTime } from '../../itemUi.js'
import { taskVerb } from './useItemTasks.js'

/** The playbooks the hand-off bar offers (core/rules/rules.ts STARTABLE); a drafted reply goes to Slack only. */
const HANDOFFS: { playbook: 'answer' | 'investigate' | 'debug-fix'; label: string; fits: (i: ScoredItem) => boolean }[] = [
  { playbook: 'answer', label: 'Draft a reply', fits: (i) => i.source === 'slack' },
  { playbook: 'investigate', label: 'Investigate', fits: () => true },
  { playbook: 'debug-fix', label: 'Plan the fix', fits: () => true },
]

const TONE: Record<Verdict['turn'], string> = { you: 'you', ready: 'ready', junior: 'junior', others: 'calm', idle: 'calm' }
const WHO: Record<Verdict['turn'], string> = { you: 'Your turn', ready: 'Your turn', junior: 'Junior’s turn', others: 'Waiting', idle: '' }

/**
 * Whose turn it is, in one sentence, and right under it either the hand-off
 * (nobody has the item yet) or what Junior is doing with it.
 */
export function ItemVerdict({ item, verdict, tasks, action, onChat, onChanged }: {
  item: ScoredItem
  verdict: Verdict
  tasks: ItemTask[]
  /** the one button the line needs, when the next move is on this page ("Read the brief") */
  action?: { label: string; run: () => void }
  onChat: () => void
  onChanged: () => void
}) {
  const offers = HANDOFFS.filter((h) => h.fits(item))
  const [pick, setPick] = useState(offers[0]?.playbook ?? 'investigate')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = (item.status ?? 'open') === 'open'

  async function handOff(playbook = pick) {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/playbooks/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: item.id, playbook }) })
      const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as { ok: boolean; error?: string }
      if (!b.ok) setError(b.error ?? 'could not hand it off')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const mine = tasks.filter((t) => t.owner === 'junior')
  const running = mine.find((t) => t.state === 'running')
  const queued = mine.find((t) => t.state === 'queued')
  const last = [...mine].filter((t) => t.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]

  return (
    <div className="itemVerdict">
      <div className={`verdictBox ${TONE[verdict.turn]}`}>
        <span className="vdot" aria-hidden="true" />
        <div className="vtext">
          <div className="say">{verdict.say}</div>
          <div className="sub">{verdict.sub}</div>
        </div>
        {WHO[verdict.turn] && (
          <div className="vwho">
            <b>{WHO[verdict.turn]}</b>
            {verdict.needs > 0 && <span>{verdict.needs === 1 ? '1 thing' : `${verdict.needs} things`} in Needs you</span>}
            {action && (
              <button type="button" className="btn xs" onClick={action.run}>
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>

      {!verdict.handedOff && open ? (
        <>
          <div className="handoffBar">
            <span className="jrMark" aria-hidden="true">J</span>
            <span className="hlabel">Hand it to Junior</span>
            <span className="hpicks" role="radiogroup" aria-label="What Junior should do">
              {offers.map((h) => (
                <button key={h.playbook} type="button" role="radio" aria-checked={pick === h.playbook} className={`hpick${pick === h.playbook ? ' on' : ''}`} onClick={() => setPick(h.playbook)}>
                  {h.label}
                </button>
              ))}
            </span>
            <button type="button" className="btn xs primary" disabled={busy} onClick={() => void handOff()}>
              {busy ? 'Handing off…' : 'Hand off'}
            </button>
          </div>
          <div className="vline">
            <span>
              Or do it yourself, or{' '}
              <button type="button" className="linkBtn" onClick={onChat}>
                start a chat
              </button>
              . Junior asks before anything leaves your Mac.
            </span>
          </div>
        </>
      ) : running ? (
        <div className="vline">
          <span className="dot live sm" aria-hidden="true" /> Junior is working on: {running.title}
          {running.startedAt ? ` · started ${relTime(running.startedAt)}` : ''}
          <button type="button" className="linkBtn" disabled={busy} onClick={() => void taskVerb('stop', { id: running.id }).then(onChanged)}>
            Stop
          </button>
        </div>
      ) : queued ? (
        <div className="vline">Junior picks up next: {queued.title}</div>
      ) : last ? (
        <div className="vline">
          {last.state === 'done'
            ? `Junior handed in${last.endedAt ? ` ${relTime(last.endedAt)}` : ''}: ${last.output?.summary ?? last.title}`
            : last.state === 'waiting'
              ? `Junior asked you${last.endedAt ? ` ${relTime(last.endedAt)}` : ''} about: ${last.title}`
              : `Junior’s last task didn’t finish${last.endedAt ? ` (${relTime(last.endedAt)})` : ''}: ${last.title}. Retry it under Sessions.`}
        </div>
      ) : null}
      {error && <div className="notice">{error}</div>}
    </div>
  )
}
