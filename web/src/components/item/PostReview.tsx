import { useEffect, useState } from 'react'
import * as RadioGroup from '@radix-ui/react-radio-group'
import type { ItemTask } from '../../../../core/work/tasks.js'
import { VERDICT_LABEL, VERDICTS, type FirstPass, type ReviewComment, type Verdict } from '../../../../core/review/brief.js'

/**
 * The review playbook's one send, as a card on the item's "Post review" task:
 * Junior's first pass, editable (verdict, body, each comment), posted only
 * when you press Post. Comments the diff doesn't show go into the body, so
 * the card says so rather than letting GitHub refuse the review.
 */
export function PostReview({ task, itemId, busy, onAct, onNavigate }: {
  task: ItemTask
  itemId: string
  busy: boolean
  onAct: (verb: 'post-review' | 'review-again' | 'skip', extra?: Record<string, unknown>) => void
  onNavigate: (hash: string) => void
}) {
  const pass = task.input?.pass as FirstPass | undefined
  const artifactId = typeof task.input?.artifactId === 'string' ? task.input.artifactId : null
  const [verdict, setVerdict] = useState<Verdict>(pass?.verdict ?? 'comment')
  const [body, setBody] = useState(pass?.summary ?? '')
  const [comments, setComments] = useState<ReviewComment[]>(pass?.comments ?? [])
  const [head, setHead] = useState<string | null>(null)

  useEffect(() => {
    void fetch(`/api/review/head?item=${encodeURIComponent(itemId)}`)
      .then((r) => r.json() as Promise<{ ok: boolean; sha?: string | null }>)
      .then((b) => setHead(b.ok ? (b.sha ?? null) : null))
      .catch(() => setHead(null))
  }, [itemId, task.id])

  if (!pass) return null
  const moved = head && head !== pass.sha
  const setComment = (i: number, text: string) => setComments((cs) => cs.map((c, j) => (j === i ? { ...c, body: text } : c)))
  const drop = (i: number) => setComments((cs) => cs.filter((_, j) => j !== i))
  const kept = comments.filter((c) => c.body.trim())

  return (
    <div className="postReview">
      <div className="prHead">
        <RadioGroup.Root className="seg" aria-label="Verdict" value={verdict} onValueChange={(v) => setVerdict(v as Verdict)} orientation="horizontal">
          {VERDICTS.map((v) => (
            <RadioGroup.Item key={v} value={v} className={`segBtn v-${v}${verdict === v ? ' active' : ''}`}>
              {VERDICT_LABEL[v]}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        <span className="prAt">
          read at {pass.sha.slice(0, 7)}
          {moved && <span className="moved"> · new commits since ({head.slice(0, 7)})</span>}
        </span>
      </div>
      <textarea className="prBody" aria-label="Review body" rows={Math.min(8, Math.max(3, body.split('\n').length + 1))} value={body} onChange={(e) => setBody(e.target.value)} />
      {comments.length > 0 && (
        <ol className="prComments" aria-label="Comments">
          {comments.map((c, i) => (
            <li key={`${c.path}:${c.line}:${i}`}>
              <div className="where">
                <code>
                  {c.path}:{c.line}
                  {c.side === 'LEFT' ? ' (old)' : ''}
                </code>
                <button type="button" className="btn xs ghost" aria-label={`Remove the comment on ${c.path}:${c.line}`} onClick={() => drop(i)}>
                  Remove
                </button>
              </div>
              <textarea aria-label={`Comment on ${c.path}:${c.line}`} rows={Math.min(6, Math.max(2, c.body.split('\n').length))} value={c.body} onChange={(e) => setComment(i, e.target.value)} />
            </li>
          ))}
        </ol>
      )}
      <div className="ask">
        <button type="button" className="btn xs primary" disabled={busy} onClick={() => onAct('post-review', { verdict, body, comments: kept })}>
          Post review
        </button>
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => onAct('review-again')}>
          Review again
        </button>
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => onAct('skip')}>
          Not now
        </button>
        {artifactId && (
          <a
            href={`#/artifact/${artifactId}`}
            onClick={(e) => {
              e.preventDefault()
              onNavigate(`/artifact/${artifactId}`)
            }}
          >
            Junior’s notes
          </a>
        )}
        <span className="cmds">
          One GitHub review as {VERDICT_LABEL[verdict]}
          {kept.length ? ` with ${kept.length} inline comment${kept.length === 1 ? '' : 's'}` : ''}. Comments on lines the diff doesn’t show go into the body.
        </span>
      </div>
    </div>
  )
}
