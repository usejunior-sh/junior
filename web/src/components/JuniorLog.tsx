/**
 * The Junior tab's Log (core/junior/log.ts): everything Junior did, newest
 * first. All, or Sent: only what left your Mac, each with who allowed it
 * (you, a rule, or the policy) and where it landed. Opening it clears the
 * rail's dot.
 */
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LogFilter, LogLine } from '../../../core/junior/log.js'
import { itemHash } from '../hooks.js'
import { markLogSeen, useJuniorLog } from '../juniorLog.js'
import { KIND_ICON, overrideAction, shortLink, spanText } from '../actions.js'
import { openSettings } from '../settings.js'

export function JuniorLog({ active, onNavigate }: { active: boolean; onNavigate: (hash: string) => void }) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const { lines, more, older, latestAt } = useJuniorLog(filter)
  // Read while it's on screen: a line that arrives while you look is read too.
  useEffect(() => {
    if (active && latestAt) void markLogSeen(latestAt)
  }, [active, latestAt])
  const now = Date.now()
  return (
    <>
      <div className="jlFilters" role="radiogroup" aria-label="Show">
        {(['all', 'sent'] as const).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={filter === f} className={`jlFilter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : 'Sent'}
          </button>
        ))}
        <span className="jlAside">{filter === 'sent' ? 'only what left your Mac, and who allowed it' : 'everything Junior did, newest first'}</span>
      </div>
      {!lines ? (
        <p className="jrEmpty">Loading…</p>
      ) : !lines.length ? (
        <p className="jrEmpty">{filter === 'sent' ? 'Nothing has left your Mac yet.' : 'Nothing yet.'}</p>
      ) : (
        <ol className="jlList">
          {lines.map((l) => (
            <Line key={l.id} l={l} now={now} onNavigate={onNavigate} />
          ))}
        </ol>
      )}
      {more && (
        <button type="button" className="btn sm jlMore" onClick={() => void older()}>
          Older
        </button>
      )}
    </>
  )
}

function Line({ l, now, onNavigate }: { l: LogLine; now: number; onNavigate: (hash: string) => void }) {
  const Icon = l.kind ? KIND_ICON[l.kind] : null
  const open = l.itemId ? () => onNavigate(itemHash(l.itemId!)) : l.sessionId ? () => onNavigate(l.sessionId!) : null
  return (
    <li className={`jlLine src-${l.source}`}>
      <span className="jlWhen mono" title={new Date(l.at).toLocaleString()}>
        {spanText(now - l.at)}
      </span>
      <span className="jlIc" aria-hidden="true">
        {Icon ? <Icon size={13} /> : <span className="jlDot" />}
      </span>
      <span className="jlMain">
        {open ? (
          <button type="button" className="jlTitle" onClick={open}>
            {l.title}
          </button>
        ) : (
          <span className="jlTitle">{l.title}</span>
        )}
        {l.impact && (
          <span className="jlImpact" title={l.impact}>
            {l.impact}
          </span>
        )}
        <span className="jlMeta">
          {l.allowed && (
            <span className={`jlBy by-${l.allowed.by}`}>
              allowed by:{' '}
              {l.allowed.by === 'rule' ? (
                <button type="button" className="jrRef" onClick={() => openSettings('approvals')}>
                  {l.allowed.text}
                </button>
              ) : (
                l.allowed.text
              )}
            </span>
          )}
          {l.origin && <span>{l.origin}</span>}
          {l.error && <span className="jlErr">{l.error}</span>}
          {l.source === 'send' && (
            <button
              type="button"
              className="jlNot"
              title="This call doesn’t reach anyone: stop counting it as a send (Settings → Approvals undoes it)"
              onClick={() => void overrideAction(l.id.slice('send:'.length), 'not_action')}
            >
              Not a send
            </button>
          )}
        </span>
      </span>
      {l.link && (
        <a className="jlLink" href={l.link} target="_blank" rel="noreferrer" title={l.link}>
          {shortLink(l.link)} <ExternalLink size={11} aria-hidden="true" />
        </a>
      )}
      <span className={`pill ${l.tone}`}>{l.state}</span>
    </li>
  )
}
