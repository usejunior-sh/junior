import { useState, type ReactNode } from 'react'
import type { ActionView, ItemEvent } from '../../../../shared/protocol.js'
import type { ItemTask } from '../../../../core/work/tasks.js'
import { isOwnHandIn } from '../../../../core/actions/own.js'
import { relTime } from '../../itemUi.js'
import { eventText } from './ItemTimeline.js'

type Row = { at: number; key: string; glyph: string; tone?: 'sent' | 'ask' | 'dim'; text: string; who: string; link?: string | null }

const SENT_GLYPH: Partial<Record<ActionView['kind'], string>> = { push: '↑', comment: '↩', message: '↩', email: '↩', pr: '⎇', merge: '⎇' }

/** Who let a send go: "you · approved", "free · your PR's branch", "rule · …". */
function allowed(a: ActionView): string {
  if (a.allowedBy === 'prompt') return 'you · approved'
  if (a.allowedBy === 'policy') return a.allowedDetail?.replace(/^free: /, 'free · ') ?? 'free'
  if (a.allowedBy) return `${a.allowedBy}${a.allowedDetail ? ` · ${a.allowedDetail}` : ''}`
  return a.status.replace('_', ' ')
}

/**
 * The sends on this item: what left the machine for it, and who allowed each
 * one. Hand-ins never count; a held call to a user's server named `browser`
 * or `task` does (core/actions/own.ts isOwnHandIn).
 */
export const sendsOf = (actions: readonly ActionView[]) => actions.filter((a) => !a.hidden && !isOwnHandIn(a))

/**
 * What happened on this item, newest first. Sent (the default) is what went
 * out; All adds the item's own history and Junior's tasks starting and ending.
 */
export function ItemActivity({ actions, events, tasks, footer }: {
  actions: readonly ActionView[]
  events: ItemEvent[] | null
  tasks: ItemTask[]
  footer?: ReactNode
}) {
  const [filter, setFilter] = useState<'sent' | 'all'>('sent')
  const sends = sendsOf(actions)
  const sent = sends.filter((a) => a.status === 'succeeded')

  const rows: Row[] = []
  for (const a of filter === 'sent' ? sent : sends)
    rows.push({
      at: a.settledAt ?? a.attemptedAt,
      key: `a:${a.id}`,
      glyph: a.status === 'succeeded' ? (SENT_GLYPH[a.kind] ?? '●') : a.status === 'needs_you' ? '?' : '×',
      tone: a.status === 'succeeded' ? 'sent' : a.status === 'needs_you' ? 'ask' : 'dim',
      text: a.status === 'succeeded' ? a.title : `${a.title} (${a.status.replace('_', ' ')})`,
      who: allowed(a),
      link: a.link,
    })
  if (filter === 'all') {
    for (const t of tasks) {
      if (t.owner !== 'junior') continue
      if (t.startedAt) rows.push({ at: t.startedAt, key: `ts:${t.id}`, glyph: '▸', text: `Started: ${t.title}`, who: 'Junior' })
      if (t.endedAt && t.state !== 'waiting')
        rows.push({
          at: t.endedAt,
          key: `te:${t.id}`,
          glyph: t.state === 'done' ? '✓' : '×',
          text: `${t.state === 'done' ? 'Done' : t.state === 'failed' ? 'Didn’t finish' : t.state === 'stopped' ? 'Stopped' : 'Skipped'}: ${t.title}${t.output?.summary ? ` — ${t.output.summary}` : ''}`,
          who: 'Junior',
        })
      if (t.state === 'waiting' && t.error) rows.push({ at: t.endedAt ?? t.createdAt, key: `tq:${t.id}`, glyph: '?', tone: 'ask', text: `Asked you: ${t.error}`, who: 'Junior' })
    }
    for (const ev of events ?? []) {
      const e = eventText(ev)
      rows.push({ at: ev.at, key: `e:${ev.seq}`, glyph: '●', tone: 'dim', text: `${e.label[0]!.toUpperCase()}${e.label.slice(1)}${e.why ? `: ${e.why}` : ''}`, who: e.who })
    }
  }
  rows.sort((a, b) => b.at - a.at)

  return (
    <div className="actTab">
      <div className="actFilter" role="radiogroup" aria-label="Show">
        <button type="button" role="radio" aria-checked={filter === 'sent'} className={filter === 'sent' ? 'on' : ''} onClick={() => setFilter('sent')}>
          Sent <span className="n">{sent.length}</span>
        </button>
        <button type="button" role="radio" aria-checked={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
          All
        </button>
        <span className="right">{filter === 'sent' ? 'What went out for this item, and who allowed it.' : 'Yours and Junior’s, newest first.'}</span>
      </div>
      {rows.length === 0 ? (
        <div className="emptyLine">{filter === 'sent' ? 'Nothing has gone out for this item.' : 'Nothing has happened here yet.'}</div>
      ) : (
        <div className="arows">
          {rows.map((r) => (
            <div key={r.key} className={`arow${r.tone ? ` ${r.tone}` : ''}`} title={new Date(r.at).toLocaleString()}>
              <span className="when mono">{relTime(r.at)}</span>
              <span className="glyph" aria-hidden="true">{r.glyph}</span>
              <span className="text">
                {r.link ? (
                  <a href={r.link} target="_blank" rel="noreferrer">{r.text}</a>
                ) : (
                  r.text
                )}
              </span>
              <span className="who">{r.who}</span>
            </div>
          ))}
        </div>
      )}
      {footer}
    </div>
  )
}
