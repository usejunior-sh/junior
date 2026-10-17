/**
 * Renders one parsed patch, split or unified.
 *
 * Selecting lines is the point of the thing: a drag over the gutter picks a
 * range, and `onComment` hands `path:lines` plus the quoted text to whoever
 * owns the composer. That is the "comment on a hunk → steer the agent" step,
 * so this component stays dumb about sessions and only reports the selection.
 */
import { MessageSquare, X } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { toSplit, type DiffRow, type ParsedDiff } from '../diff.js'

type Props = {
  diff: ParsedDiff
  /** unified is the default: it survives a narrow drawer, split needs width */
  mode: 'split' | 'unified'
  /** omitted in tool cards, where there is nothing to comment on */
  onComment?: (sel: { from: number; to: number; text: string }) => void
  /** cap before "show the rest": tool cards render short, the drawer long */
  maxRows?: number
}

const sign = (k: DiffRow['kind']) => (k === 'add' ? '+' : k === 'del' ? '−' : ' ')

/** The line number a comment should quote: the new file's, falling back to old. */
const lineNo = (r: DiffRow) => r.newNo ?? r.oldNo ?? 0

export const DiffView = memo(function DiffView({ diff, mode, onComment, maxRows = 2000 }: Props) {
  const [sel, setSel] = useState<{ anchor: number; head: number } | null>(null)
  const [showAll, setShowAll] = useState(false)

  const rows = useMemo(
    () => (showAll || diff.rows.length <= maxRows ? diff.rows : diff.rows.slice(0, maxRows)),
    [diff.rows, maxRows, showAll],
  )
  const split = useMemo(() => (mode === 'split' ? toSplit(rows) : null), [rows, mode])
  const hidden = diff.rows.length - rows.length

  const range = sel ? { lo: Math.min(sel.anchor, sel.head), hi: Math.max(sel.anchor, sel.head) } : null
  const selected = (i: number) => !!range && i >= range.lo && i <= range.hi

  function comment() {
    if (!range || !onComment) return
    const picked = rows.slice(range.lo, range.hi + 1).filter((r) => r.kind !== 'hunk')
    if (!picked.length) return
    const nums = picked.map(lineNo).filter((n) => n > 0)
    onComment({
      from: Math.min(...nums),
      to: Math.max(...nums),
      text: picked.map((r) => `${sign(r.kind)}${r.text}`).join('\n'),
    })
    setSel(null)
  }

  // Clicking a row starts a selection; shift-clicking extends it. Deliberately
  // not a native text selection: copying code out of a diff should still work.
  const pick = (i: number, shift: boolean) =>
    setSel((prev) => (shift && prev ? { ...prev, head: i } : { anchor: i, head: i }))

  const gutter = (r: DiffRow, side: 'old' | 'new') => (
    <span className="ln">{(side === 'old' ? r.oldNo : r.newNo) ?? ''}</span>
  )

  return (
    <div className="diffView">
      <div className={`diffBody ${mode}`} role="table">
        {split
          ? split.map((p, i) => (
              <div
                key={i}
                className={`dpair${selected(i) ? ' sel' : ''}`}
                onMouseDown={(e) => onComment && pick(i, e.shiftKey)}
              >
                <div className={`dcell ${p.left ? p.left.kind : 'empty'}`}>
                  {p.left ? (
                    <>
                      {gutter(p.left, 'old')}
                      <span className="sg">{p.left.kind === 'hunk' ? '' : sign(p.left.kind)}</span>
                      <span className="tx">{p.left.kind === 'hunk' ? p.left.text || '⋯' : p.left.text || ' '}</span>
                    </>
                  ) : (
                    <span className="ln" />
                  )}
                </div>
                <div className={`dcell ${p.right ? p.right.kind : 'empty'}`}>
                  {p.right ? (
                    <>
                      {gutter(p.right, 'new')}
                      <span className="sg">{p.right.kind === 'hunk' ? '' : sign(p.right.kind)}</span>
                      <span className="tx">{p.right.kind === 'hunk' ? p.right.text || '⋯' : p.right.text || ' '}</span>
                    </>
                  ) : (
                    <span className="ln" />
                  )}
                </div>
              </div>
            ))
          : rows.map((r, i) => (
              <div
                key={i}
                className={`dline ${r.kind}${selected(i) ? ' sel' : ''}`}
                onMouseDown={(e) => onComment && pick(i, e.shiftKey)}
              >
                <span className="ln">{r.oldNo ?? ''}</span>
                <span className="ln">{r.newNo ?? ''}</span>
                <span className="sg">{r.kind === 'hunk' ? '' : sign(r.kind)}</span>
                <span className="tx">{r.kind === 'hunk' ? r.text || '⋯' : r.text || ' '}</span>
              </div>
            ))}
      </div>

      {hidden > 0 && (
        <button type="button" className="diffMore" onClick={() => setShowAll(true)}>
          Show {hidden.toLocaleString()} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}

      {range && onComment && (
        <div className="diffSel">
          <MessageSquare size={12} aria-hidden="true" />
          <span>
            {range.lo === range.hi ? '1 line' : `${range.hi - range.lo + 1} lines`} selected
          </span>
          <button type="button" className="btn xs primary" onClick={comment}>
            Comment
          </button>
          <button type="button" className="iconBtn sm" aria-label="Clear selection" onClick={() => setSel(null)}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
})
