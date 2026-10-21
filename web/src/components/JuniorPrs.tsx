/**
 * The Junior tab's PR view (M1, rough): what needs you, what Junior is on,
 * and every PR you have open. Read straight off the inbox snapshot: each
 * item carries its task summary (core/work/tasks.ts taskSummary). Empty
 * sections hide.
 */
import { useEffect, useState } from 'react'
import type { ScoredItem } from '../../../shared/protocol.js'
import { itemHash } from '../hooks.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { openSettings } from '../settings.js'
import { JuniorFace } from './JuniorFace.js'

const prName = (i: ScoredItem) => {
  const m = /#(\d+)$/.exec(i.id)
  return m ? `${i.repo}#${m[1]}` : i.repo
}

function Row({ item, meta, right, hot, onNavigate }: { item: ScoredItem; meta: string; right?: string; hot?: boolean; onNavigate: (hash: string) => void }) {
  return (
    <button type="button" className={`jrRow${hot ? ' need' : ''}`} onClick={() => onNavigate(itemHash(item.id))}>
      <span className="t">{item.title}</span>
      <span className="m">
        {prName(item)} · {meta}
      </span>
      {right && <span className="r">{right}</span>}
      <span className="go">Open</span>
    </button>
  )
}

export function JuniorPrs({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const snap = useInbox()
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!snap.loaded && !snap.loading) void inboxStore.refresh()
  }, [snap.loaded, snap.loading])
  useEffect(() => {
    void fetch('/api/babysit/settings')
      .then((r) => r.json() as Promise<{ ok: boolean; settings?: { enabled: boolean } }>)
      .then((b) => setOn(b.ok ? !!b.settings?.enabled : null))
      .catch(() => setOn(null))
  }, [])

  const mine = snap.items.filter((i) => i.reason === 'your-pr')
  const needs = snap.items.filter((i) => (i.tasks?.needsYou ?? 0) > 0)
  const working = snap.items.filter((i) => !needs.includes(i) && (i.tasks?.running || (i.tasks?.queued ?? 0) > 0))

  return (
    <>
      {on === false && (
        <p className="jrQuiet">
          <JuniorFace mood="hello" size={18} motion="still" decorative />
          I'm not babysitting your PRs yet.{' '}
          <button type="button" className="jrRef" onClick={() => openSettings('babysit')}>
            Turn it on
          </button>
        </p>
      )}
      {needs.length > 0 && (
        <section aria-label="Needs you">
          <h2 className="jrLh">
            Needs you <span className="n">{needs.length}</span>
            <span className="aside">a reviewer to request, or where I got stuck</span>
          </h2>
          <div className="jrRows">
            {needs.map((i) => (
              <Row key={i.id} item={i} hot meta={i.tasks?.next?.error ? `${i.tasks.next.title}: ${i.tasks.next.error}` : (i.tasks?.next?.title ?? 'needs you')} onNavigate={onNavigate} />
            ))}
          </div>
        </section>
      )}
      {working.length > 0 && (
        <section aria-label="With Junior">
          <h2 className="jrLh">
            With Junior <span className="n">{working.length}</span>
          </h2>
          <div className="jrRows">
            {working.map((i) => (
              <Row key={i.id} item={i} meta={i.tasks?.line ?? 'queued'} onNavigate={onNavigate} />
            ))}
          </div>
        </section>
      )}
      <section aria-label="My PRs">
        <h2 className="jrLh">
          My PRs <span className="n">{mine.length}</span>
          <span className="aside">every PR you have open in this workspace's repos</span>
        </h2>
        {mine.length === 0 ? (
          <p className="jrEmpty">No open PRs in this workspace's repos.</p>
        ) : (
          <div className="jrRows">
            {mine.map((i) => (
              <Row
                key={i.id}
                item={i}
                meta={i.tasks?.lastDone ?? i.tasks?.line ?? (i.ciFailing ? 'CI red' : i.isDraft ? 'draft' : 'nothing to do')}
                right={i.ciFailing ? 'CI red' : undefined}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </section>
    </>
  )
}
