import { useState } from 'react'
import type { SessionSummary, SessionsUsage } from '../../../../shared/protocol.js'
import { money } from '../../usageFormat.js'
import { useCheckouts } from '../../hooks.js'
import { checkoutOf } from '../../checkouts.js'
import { TEAM_STATE } from './ItemPlans.js'
import type { ItemTask } from '../../../../core/work/tasks.js'
import { relTime } from '../../itemUi.js'
import { taskVerb } from './useItemTasks.js'

const MARK: Record<ItemTask['state'], string> = { queued: '○', running: '◐', waiting: '?', done: '✓', failed: '×', skipped: '–', stopped: '■' }

/** What came of a task, in one line: its hand-in, the question it asked, or what stopped it. */
export function outcomeOf(t: ItemTask): string {
  if (t.state === 'running') return 'Working on it now.'
  if (t.state === 'queued') return 'Next up.'
  if (t.output?.summary) return t.output.summary
  if (t.state === 'waiting') return t.error ? `Asked you: ${t.error}` : 'Waiting on you.'
  if (t.state === 'skipped') return t.error ?? 'Skipped.'
  if (t.state === 'stopped') return t.error ?? 'Stopped.'
  return t.error ? `Didn’t finish: ${t.error}` : 'Didn’t finish.'
}

/**
 * Who has worked this item: Junior's tasks, one row each with what came of
 * it, then your own chats about it.
 */
export function ItemSessionsTab({ tasks, chats, handedOff, spend, checkouts, onChanged, onNavigate }: {
  tasks: ItemTask[]
  chats: { s: SessionSummary; role: string }[]
  handedOff: boolean
  /** each session's cost, from the usage ledger */
  spend: SessionsUsage | null
  checkouts: ReturnType<typeof useCheckouts>
  onChanged: () => void
  onNavigate: (hash: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const mine = tasks.filter((t) => t.owner === 'junior' && t.state !== 'skipped').sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))
  const spent = mine.reduce((n, t) => n + (t.costUsd ?? 0), 0)

  async function verb(v: 'stop' | 'retry' | 'skip', t: ItemTask) {
    setBusy(t.id)
    await taskVerb(v, { id: t.id })
    setBusy(null)
    onChanged()
  }

  return (
    <div className="sessTab">
      <div className="subHead">
        <span>Junior’s tasks</span>
        <span className="n">{mine.length}</span>
        {spent > 0 && <span className="right mono">${spent.toFixed(2)}</span>}
      </div>
      {mine.length === 0 ? (
        <div className="emptyLine">
          {handedOff ? 'No tasks of Junior’s own here. Its work on this item is in the chats below.' : 'Not handed off. Junior hasn’t worked on this item.'}
        </div>
      ) : (
        <div className="sxRows">
          {mine.map((t) => (
            <div key={t.id} className={`sxRow st-${t.state}`}>
              <span className="sxMark" aria-label={t.state}>{MARK[t.state]}</span>
              <span className="sxText">
                <b>{t.title}</b>
                <span title={outcomeOf(t)}>{outcomeOf(t)}</span>
              </span>
              <span className="sxModel mono">{t.model ?? ''}</span>
              <span className="sxCost mono">{t.state === 'running' ? 'running' : t.costUsd ? `$${t.costUsd.toFixed(2)}` : t.endedAt ? relTime(t.endedAt) : ''}</span>
              <span className="sxActs">
                {t.state === 'running' && (
                  <button type="button" className="linkBtn" disabled={busy === t.id} onClick={() => void verb('stop', t)}>Stop</button>
                )}
                {t.state === 'failed' && (
                  <button type="button" className="linkBtn" disabled={busy === t.id} onClick={() => void verb('retry', t)}>Retry</button>
                )}
                {t.state === 'queued' && (
                  <button type="button" className="linkBtn" disabled={busy === t.id} onClick={() => void verb('skip', t)}>Skip</button>
                )}
                {t.sessionId && (
                  <button type="button" className="linkBtn" onClick={() => onNavigate(t.sessionId!)}>Session ›</button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="subHead" style={{ marginTop: 18 }}>
        <span>Chats and runs</span>
        <span className="n">{chats.length}</span>
      </div>
      {chats.length === 0 ? (
        <div className="emptyLine">No chats about this item yet. Start one from the side panel.</div>
      ) : (
        <div className="sxRows">
          {chats.map(({ s, role }) => {
            const kind = role === 'brief' || s.kind === 'brief' ? 'brief run' : s.teamRun ? (s.teamRun.role === 'lead' ? 'team lead' : 'team worker') : s.kind === 'job-run' ? 'job run' : 'chat'
            const state = s.teamRun?.role === 'lead' ? TEAM_STATE[s.teamRun.state] : s.status === 'running' ? 'running' : s.status === 'error' ? 'stopped on an error' : null
            const branch = checkoutOf(checkouts, s.checkoutId)?.branch
            const cost = spend?.bySession[s.id]?.cost
            return (
              <div key={s.id} className={`sxRow${s.status === 'running' ? ' st-running' : s.status === 'error' ? ' st-failed' : ''}`}>
                <span className="sxMark">{s.status === 'running' ? '◐' : s.status === 'error' ? '×' : '○'}</span>
                <span className="sxText">
                  <b title={s.title}>{s.title}</b>
                  <span>
                    {kind}
                    {state ? ` · ${state}` : ''}
                    {branch ? ` · ${branch}` : ''} · {relTime(s.updatedAt)}
                  </span>
                </span>
                <span className="sxModel mono">{s.model ?? ''}</span>
                <span className="sxCost mono">{cost ? money(cost) : ''}</span>
                <span className="sxActs">
                  <button type="button" className="linkBtn" onClick={() => onNavigate(s.id)}>
                    {role === 'brief' ? 'Open the run ›' : 'Open ›'}
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
