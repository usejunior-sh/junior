import { Check, Loader, X } from 'lucide-react'
import { memo, useMemo } from 'react'
import { collapseContext, diffLines, type ParsedDiff } from '../diff.js'
import { toolHint, truncate, type TranscriptItem } from '../transcript.js'
import { DiffView } from './DiffView.js'

type Tool = Extract<TranscriptItem, { kind: 'tool' }>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The diff an edit-shaped tool describes, straight from its own input.
 *
 * This is the exact change the agent asked for, which is a stronger claim than
 * anything the snapshot diff can make. No other session can be mixed into it.
 * `MultiEdit` is folded into one patch by applying its edits in order.
 */
function toolDiff(name: string, input: Record<string, unknown>): ParsedDiff | null {
  if (name === 'Edit') {
    const before = str(input.old_string)
    const after = str(input.new_string)
    if (!before && !after) return null
    return diffLines(before, after)
  }
  if (name === 'Write') {
    const content = str(input.content)
    if (!content) return null
    return diffLines('', content)
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const parts = (input.edits as Record<string, unknown>[])
      .map((e) => diffLines(str(e.old_string), str(e.new_string)))
      .filter((d) => d.rows.length)
    if (!parts.length) return null
    return parts.reduce<ParsedDiff>(
      (acc, d) => ({
        rows: acc.rows.length ? [...acc.rows, { kind: 'hunk', text: '', oldNo: null, newNo: null }, ...d.rows] : d.rows,
        additions: acc.additions + d.additions,
        deletions: acc.deletions + d.deletions,
        isBinary: false,
      }),
      { rows: [], additions: 0, deletions: 0, isBinary: false },
    )
  }
  return null
}

export const ToolCard = memo(function ToolCard({ item }: { item: Tool }) {
  const state = item.result ? (item.result.isError ? 'fail' : 'ok') : 'busy'
  // Long unchanged stretches in a Write are noise; keep the edges of changes.
  const diff = useMemo(() => {
    const d = toolDiff(item.name, item.input)
    return d ? { ...d, rows: collapseContext(d.rows) } : null
  }, [item.name, item.input])

  return (
    <details className="tool" open={!!diff}>
      <summary>
        <span className={`glyph ${state}`} aria-label={state}>
          {state === 'busy' ? (
            <Loader size={13} aria-hidden="true" />
          ) : state === 'ok' ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <X size={13} aria-hidden="true" />
          )}
        </span>
        <span className="toolName">{item.name}</span>
        <span className="toolHint">{toolHint(item.input)}</span>
        {diff && (
          <span className="toolNum mono">
            <span className="pl">+{diff.additions}</span> <span className="mn">−{diff.deletions}</span>
          </span>
        )}
      </summary>
      {diff ? (
        <div className="toolDiff">
          <DiffView diff={diff} mode="unified" maxRows={80} />
        </div>
      ) : (
        <pre className="well">{truncate(JSON.stringify(item.input, null, 2), 2000)}</pre>
      )}
      {item.result && (
        <pre className={`well result${item.result.isError ? ' fail' : ''}`}>
          {truncate(item.result.text || '(no output)', 2000)}
        </pre>
      )}
    </details>
  )
})
