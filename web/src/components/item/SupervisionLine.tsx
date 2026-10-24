/**
 * The supervision line on the item page (core/work/supervision.ts): what
 * Junior did here that you haven't looked at, under the chips.
 *
 *   4 files changed, not reviewed by you ⌄  ·  2 sends wait for your OK →
 *
 * The files part opens the list of files Junior changed since you last looked
 * (a Radix Collapsible). Opening it is one POST that returns the files and
 * records that you looked, so they stop counting. The sends part goes to the
 * item's Needs you tab, where the cards are. Nothing renders when both counts
 * are zero. Never orange: this is a quiet tally, not a "needs you".
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import { ArrowRight, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import type { ChangedByJunior, ChangesSeenResponse } from '../../../../shared/protocol.js'
import { filesPart, sendsPart, splitPath } from '../../../../core/work/supervision.js'
import { shortAge } from '../../itemUi.js'

type Seen = { files: ChangedByJunior[]; total: number; since: number | null }

async function openChanges(id: string): Promise<Seen> {
  const r = await fetch('/api/items/changes-seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  const body = (await r.json().catch(() => null)) as ChangesSeenResponse | null
  if (!body) throw new Error(`the server answered ${r.status}`)
  if (!body.ok) throw new Error(body.error)
  return { files: body.files, total: body.total, since: body.since }
}

export function SupervisionLine({
  itemId,
  files,
  sends,
  onSends,
  onNavigate,
}: {
  itemId: string
  /** files Junior changed since you last looked, from the inbox snapshot */
  files: number
  /** sends that wait for your OK: the page's own held list, fresher than the snapshot */
  sends: number
  /** switch to the Needs you tab and land on it */
  onSends: () => void
  /** a session id opens that chat */
  onNavigate: (hash: string) => void
}) {
  const [open, setOpen] = useState(false)
  // the count when you first opened the list: the trigger keeps its words while you stay on the page
  const [frozen, setFrozen] = useState<number | null>(null)
  const [seen, setSeen] = useState<Seen | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState('')

  const fileCount = frozen ?? files
  const filesText = filesPart(fileCount)
  const sendsText = sendsPart(sends)
  if (!filesText && !sendsText) return null

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await openChanges(itemId)
      setSeen(s)
      setSaid(`${s.total} ${s.total === 1 ? 'file' : 'files'}. Marked as seen.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    if (frozen === null) setFrozen(files)
    if (!seen && !loading) void load()
  }

  const more = seen ? seen.total - seen.files.length : 0

  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className="supWrap">
      <div className="supLine">
        {filesText && (
          <Collapsible.Trigger asChild>
            <button type="button" className="supPart" title="Show the files Junior changed since you last looked" aria-busy={loading || undefined}>
              {filesText}
              <ChevronDown size={12} className="supChev" aria-hidden="true" />
            </button>
          </Collapsible.Trigger>
        )}
        {filesText && sendsText && (
          <span className="supSep" aria-hidden="true">
            ·
          </span>
        )}
        {sendsText && (
          <button type="button" className="supPart" title="Go to the sends that wait for you" onClick={onSends}>
            {sendsText}
            <ArrowRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
      {filesText && (
        <Collapsible.Content className="supList">
          {loading && <div className="supNote">Loading the files…</div>}
          {error && (
            <div className="supErr" role="alert">
              <span>Couldn’t load the files. {error}</span>
              <button type="button" className="btn sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          )}
          {seen && (
            <>
              <div className="secLabel mute">{seen.since === null ? 'Changed by Junior' : 'Changed by Junior, since you last looked'}</div>
              {seen.files.map((f) => {
                const { dir, name } = splitPath(f.path)
                return (
                  <div key={`${f.sessionId}:${f.path}`} className="supRow">
                    <span className="supPath" title={f.path}>
                      <span className="dir">{dir}</span>
                      <span className="nm">{name}</span>
                    </span>
                    <span className="supSess">
                      {f.sessionTitle ? (
                        <button type="button" className="linkBtn" title={f.sessionTitle} onClick={() => onNavigate(f.sessionId)}>
                          {f.sessionTitle}
                        </button>
                      ) : (
                        <span className="gone">a deleted chat</span>
                      )}
                    </span>
                    <span className="supAge">{shortAge(f.at)}</span>
                  </div>
                )
              })}
              {more > 0 && <div className="supNote">And {more} more. Open a session to see them all.</div>}
              <div className="supNote">Marked as seen. New changes will show here.</div>
            </>
          )}
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  )
}
