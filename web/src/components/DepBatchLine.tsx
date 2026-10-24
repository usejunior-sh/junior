/**
 * "6 dependency updates are green · merge?": the dependency batch as one
 * suggested row, last on Needs you (design: .docs/overnight-2026-10-24/designs/
 * dependency-batch-ui.md; rules: core/babysit/dep-batch.ts). A Radix
 * Collapsible over the ledger's own row: opening it queues nothing. Each PR
 * is a sub-row with a Radix Checkbox, all ticked; the Merge button's count
 * follows the ticks. Pressing Merge (or ⏎ on the open row) is the approval:
 * the server reads each PR again, drops one that turned red with a note, and
 * merges the rest one by one, each its own Log record allowed by you. The
 * page polls the run so every sub-row shows its own state.
 *
 * Sky for "Suggested", never orange: nobody is waiting on you.
 */
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Collapsible from '@radix-ui/react-collapsible'
import { Check, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { DepBatchRow, DepBatchView, DepMergeResponse, DepMergeRow, DepMergeRun, DepNotNowResponse } from '../../../shared/protocol.js'
import { shortAge } from '../itemUi.js'
import { JuniorFace } from './JuniorFace.js'

const POLL_MS = 700

/** "acme/web" or "acme/web +1" */
function whereOf(prs: readonly DepBatchRow[]): string {
  const repos = [...new Set(prs.map((p) => p.repo))]
  return repos.length > 1 ? `${repos[0]} +${repos.length - 1}` : (repos[0] ?? '')
}

/** A sub-row's state, as it shows while the batch merges. */
const STATE_TEXT: Record<DepMergeRow['state'], (note: string | null) => string> = {
  waiting: () => 'Waiting',
  checking: () => 'Checking…',
  merging: () => 'Merging…',
  merged: () => 'Merged',
  dropped: (note) => `Dropped · ${note ?? 'left out'}`,
  failed: (note) => `Didn’t merge · ${note ?? 'error'}`,
}

async function postJson<T>(url: string, body: unknown): Promise<T | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as T
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function DepBatchLine({
  className,
  dataKey,
  batch,
  open,
  onToggle,
  onHide,
  enterRef,
}: {
  /** the ledger's `.jhItem` classes: the Collapsible root is the row's item */
  className: string
  dataKey: string
  batch: DepBatchView
  open: boolean
  onToggle: () => void
  /** "Not now" went through: the ledger drops the row */
  onHide: () => void
  /** what ⏎ does on the open row: Merge */
  enterRef: MutableRefObject<(() => void) | null>
}) {
  const n = batch.prs.length
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(batch.prs.map((p) => p.ref)))
  const [run, setRun] = useState<DepMergeRun | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hiding, setHiding] = useState(false)
  const busy = starting || (!!run && !run.done)
  const locked = busy || !!run?.done

  // ticks are local, and reset each time the row opens (not mid-run, not after it)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current && !run) setPicked(new Set(batch.prs.map((p) => p.ref)))
    wasOpen.current = open
  }, [open, run, batch])

  // poll the run until it's done
  useEffect(() => {
    if (!run || run.done) return
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/deps/merge/${encodeURIComponent(run.id)}`)
        const b = (await r.json()) as DepMergeResponse
        if (b.ok) setRun(b.run)
        else setRun({ ...run, done: true, summary: b.error })
      } catch {
        setRun({ ...run }) // try again next tick
      }
    }, POLL_MS)
    return () => clearTimeout(t)
  }, [run])

  const refs = batch.prs.map((p) => p.ref).filter((r) => picked.has(r))
  const merge = () => {
    if (locked || refs.length === 0) return
    setStarting(true)
    setError(null)
    void postJson<DepMergeResponse>('/api/deps/merge', { refs }).then((b) => {
      setStarting(false)
      if (b.ok) setRun(b.run)
      else setError(`Couldn’t start the merges: ${b.error}. Nothing was merged.`)
    })
  }
  const notNow = () => {
    setHiding(true)
    setError(null)
    void postJson<DepNotNowResponse>('/api/deps/not-now', { refs: batch.prs.map((p) => p.ref) }).then((b) => {
      setHiding(false)
      if (b.ok) onHide()
      else setError(`Couldn’t hide it: ${b.error}`)
    })
  }
  enterRef.current = merge

  const rowOf = new Map((run?.rows ?? []).map((r) => [r.ref, r]))
  const youngest = Math.max(...batch.prs.map((p) => p.openedAt))
  const label = `${n} dependency updates are green. Suggested. Merge?`

  return (
    <Collapsible.Root className={className} data-key={dataKey} open={open} onOpenChange={onToggle}>
      <Collapsible.Trigger asChild>
        <button type="button" className="jhRow" aria-label={label}>
          <span className="wc">
            <JuniorFace mood="hello" size={20} motion="still" decorative />
            <span className="nm">Junior</span>
          </span>
          <span className="tt">{n} dependency updates are green · merge?</span>
          <span className="jrc">Suggested</span>
          <span className="wh" title={[...new Set(batch.prs.map((p) => p.repo))].join(', ')}>
            <span>{whereOf(batch.prs)}</span>
          </span>
          <span className="ag" title={`The newest was opened ${shortAge(youngest)} ago`}>
            {shortAge(youngest)}
          </span>
          <ChevronRight className="chev" size={14} aria-hidden="true" />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="jdbList" role="list" aria-label="Dependency updates in the batch">
          {batch.prs.map((p) => {
            const st = rowOf.get(p.ref)
            const pkg = p.more > 0 ? `${p.package} +${p.more}` : p.package
            return (
              <label key={p.ref} className={`jdb${picked.has(p.ref) ? '' : ' off'}`} role="listitem">
                <Checkbox.Root
                  className="cbox"
                  checked={picked.has(p.ref)}
                  disabled={locked}
                  aria-label={`Include ${p.package} ${p.ref}`}
                  onCheckedChange={(v) =>
                    setPicked((s) => {
                      const next = new Set(s)
                      if (v === true) next.add(p.ref)
                      else next.delete(p.ref)
                      return next
                    })
                  }
                >
                  <Checkbox.Indicator>
                    <Check size={11} aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span className="pk" title={pkg}>
                  {pkg}
                </span>
                <span className="vv">
                  {p.from && (
                    <>
                      {p.from} <i aria-hidden="true">→</i>{' '}
                    </>
                  )}
                  {p.to ?? ''}
                </span>
                <span className="bp">{p.bump}</span>
                {st ? (
                  <span className={`ck st-${st.state}`} title={STATE_TEXT[st.state](st.note)}>
                    {STATE_TEXT[st.state](st.note)}
                  </span>
                ) : (
                  <span className="ck">
                    <i className="dot" aria-hidden="true" /> {p.green} green
                  </span>
                )}
                <a className="rf" href={p.url} target="_blank" rel="noreferrer" aria-label={`Open ${p.ref} on GitHub`} onClick={(e) => e.stopPropagation()}>
                  {p.ref}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
                <span className="ag">{shortAge(p.openedAt)}</span>
              </label>
            )
          })}
          {batch.held.length > 0 && (
            <p className="cap jdbHeld">
              Not in the batch: {batch.held.length}
              {batch.held.map((h) => (
                <span key={h.ref} title={h.ref}>
                  {' · '}
                  {h.package} ({h.why})
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="jhXp">
          <span className="lbl jr">Junior</span>
          <span className="said" role="status">
            {run?.done ? run.summary : `These are green, minor or patch, and ${batch.minAgeDays} days old. I merge each one only when you say.`}
          </span>
          {!run?.done && (
            <div className="acts">
              <button
                type="button"
                className="btn sm primary jdbGo"
                disabled={busy || refs.length === 0}
                aria-busy={busy || undefined}
                title="One merge per PR. Each is logged as approved by you."
                onClick={merge}
              >
                {busy ? 'Merging…' : `Merge ${refs.length}`} <kbd className="jhKbd">⏎</kbd>
              </button>
              <button type="button" className="btn sm ghost" disabled={busy || hiding} title="Hide this for a day, or until a new update joins." onClick={notNow}>
                Not now
              </button>
              <span className="cap jdbFine">one merge per PR, each in your Log</span>
            </div>
          )}
          {error && (
            <p className="jrErr jdbErr" role="alert">
              {error}
            </p>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
