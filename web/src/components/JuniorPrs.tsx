/**
 * The Junior tab's PR view (M1, rough): what needs you, what Junior is on,
 * the PRs that ask for your review with Junior's first pass (M3), and every
 * PR you have open. Read straight off the inbox snapshot: each item carries
 * its task summary (core/work/tasks.ts taskSummary). Empty sections hide.
 */
import { useEffect, useState } from 'react'
import type { ScoredItem } from '../../../shared/protocol.js'
import { itemHash } from '../hooks.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { openSettings } from '../settings.js'
import { JuniorFace } from './JuniorFace.js'
import type { Verdict } from '../../../core/review/brief.js'
import type { ReviewState } from '../../../core/work/tasks.js'

/** The verdict chip: short enough for the row's right column. */
const CHIP: Record<Verdict, string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Changes' }

const prName = (i: ScoredItem) => {
  const m = /#(\d+)$/.exec(i.id)
  return m ? `${i.repo}#${m[1]}` : i.repo
}

function Row({ item, meta, right, rightClass, hot, onNavigate }: { item: ScoredItem; meta: string; right?: string; rightClass?: string; hot?: boolean; onNavigate: (hash: string) => void }) {
  return (
    <button type="button" className={`jrRow${hot ? ' need' : ''}`} onClick={() => onNavigate(itemHash(item.id))}>
      <span className="t">{item.title}</span>
      <span className="m">
        {prName(item)} · {meta}
      </span>
      {right && <span className={`r${rightClass ? ` ${rightClass}` : ''}`}>{right}</span>}
      <span className="go">Open</span>
    </button>
  )
}

/** A review row's line: where the pass is, then who else asked (a Slack ask folded into the row). */
function reviewMeta(item: ScoredItem): string {
  const r = item.tasks?.review
  const where: Record<ReviewState['state'], string> = {
    queued: 'first pass queued',
    reviewing: 'reviewing…',
    // the chip says the verdict; the line says the rest
    ready: r?.line?.split(' · ').slice(1).join(' · ') || 'review ready',
    posted: r?.line ?? 'posted',
    skipped: r?.line ?? 'set aside',
    failed: 'first pass stuck: open it',
  }
  const asked = (item.linked ?? []).filter((l) => l.source === 'slack').map((l) => l.author)
  return [`by ${item.author}`, r ? where[r.state] : 'no first pass yet', ...(asked.length ? [`${asked.join(', ')} asked in Slack`] : [])].join(' · ')
}

export function JuniorPrs({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const snap = useInbox()
  const [on, setOn] = useState<boolean | null>(null)
  const [reviewsOn, setReviewsOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!snap.loaded && !snap.loading) void inboxStore.refresh()
  }, [snap.loaded, snap.loading])
  useEffect(() => {
    void fetch('/api/babysit/settings')
      .then((r) => r.json() as Promise<{ ok: boolean; settings?: { enabled: boolean; reviews: boolean } }>)
      .then((b) => {
        setOn(b.ok ? !!b.settings?.enabled : null)
        setReviewsOn(b.ok ? !!b.settings?.reviews : null)
      })
      .catch(() => setOn(null))
  }, [])

  const mine = snap.items.filter((i) => i.reason === 'your-pr')
  const needs = snap.items.filter((i) => (i.tasks?.needsYou ?? 0) > 0)
  const toReview = snap.items.filter((i) => i.reason === 'review-requested' && !needs.includes(i))
  // A review in progress shows on its own row below, not twice.
  const working = snap.items.filter((i) => !needs.includes(i) && !toReview.includes(i) && (i.tasks?.running || (i.tasks?.queued ?? 0) > 0))

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
            <span className="aside">a review to post, a reviewer to request, or where I got stuck</span>
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
      {(toReview.length > 0 || (reviewsOn === false && snap.items.some((i) => i.reason === 'review-requested'))) && (
        <section aria-label="PRs to review">
          <h2 className="jrLh">
            PRs to review <span className="n">{toReview.length}</span>
            <span className="aside">people waiting on your review</span>
          </h2>
          {reviewsOn === false && (
            <p className="jrQuiet">
              <JuniorFace mood="hello" size={18} motion="still" decorative />
              I can read these before you do.{' '}
              <button type="button" className="jrRef" onClick={() => openSettings('babysit')}>
                Turn on first-pass reviews
              </button>
            </p>
          )}
          {toReview.length > 0 && (
            <div className="jrRows">
              {toReview.map((i) => {
                const v = i.tasks?.review?.verdict
                return <Row key={i.id} item={i} meta={reviewMeta(i)} right={v ? CHIP[v] : undefined} rightClass={v ? `verdict v-${v}` : undefined} onNavigate={onNavigate} />
              })}
            </div>
          )}
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
