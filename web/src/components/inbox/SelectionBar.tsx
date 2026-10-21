import { Sparkles, Check, AlarmClock, Archive, X } from 'lucide-react'
import type { ScoredItem, BriefJob } from '../../../../shared/protocol.js'
import type { Section } from '../../../../core/work/due.js'
import type { Turn } from '../../../../core/work/flow.js'
import type { InboxRoute } from '../../../../core/work/inbox-views.js'

/**
 * Floating bulk-action bar. Appears bottom-centre of the pane while rows are
 * checked and offers the same verbs as a row's hover cluster, applied to all
 * of them at once. It sticks to the bottom of the page scroller rather than
 * the viewport so it never sits over the rail or the Queue panel.
 */
export function SelectionBar({
  count,
  onBrief,
  onDone,
  onSnooze,
  onArchive,
  onClear,
}: {
  count: number
  onBrief: () => void
  onDone: () => void
  onSnooze: () => void
  onArchive: () => void
  onClear: () => void
}) {
  return (
    <div className="selDock">
      <div className="selBar" role="toolbar" aria-label={`${count} checked`}>
        <span className="count">
          <span className="n">{count}</span> checked
        </span>
        <span className="sep" aria-hidden="true" />
        <button type="button" className="btn sm primary" title="Queue a brief for each checked item, with its kind's default template (b)" onClick={onBrief}>
          <Sparkles size={13} aria-hidden="true" /> Brief with defaults
        </button>
        <button type="button" className="btn sm ghost" title="Mark the checked items done (e)" onClick={onDone}>
          <Check size={14} aria-hidden="true" /> Done
        </button>
        <button type="button" className="btn sm ghost" title="Snooze the checked items until tomorrow 9am (z)" onClick={onSnooze}>
          <AlarmClock size={13} aria-hidden="true" /> Snooze
        </button>
        <button type="button" className="btn sm ghost" title="Archive the checked items (x)" onClick={onArchive}>
          <Archive size={13} aria-hidden="true" /> Archive
        </button>
        <span className="sep" aria-hidden="true" />
        <button type="button" className="iconBtn sm" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export type RowActions = {
  view: InboxRoute
  /** open, rather than done, snoozed or archived: All mixes both */
  isOpenItem: (item: ScoredItem) => boolean
  projectName: (id?: string) => string | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onPin: (id: string, title: string) => void
  onDispatch: (item: ScoredItem) => void
  onDone: (item: ScoredItem) => void
  /** `until`: when it comes back (epoch ms); absent = tomorrow 9am */
  onSnooze: (item: ScoredItem, until?: number) => void
  onArchive: (item: ScoredItem) => void
  onReopen: (item: ScoredItem) => void
  onRefineJob: (item: ScoredItem) => void
  onSetPriority: (item: ScoredItem, priority: number) => void
  onSetDue: (item: ScoredItem, due: Section) => void
  onPickDue: (item: ScoredItem) => void
  onEdit: (item: ScoredItem) => void
  onDelete: (item: ScoredItem) => void
  checked: Set<string>
  onToggle: (id: string) => void
  onBrief: (item: ScoredItem) => void
  briefOf: (id: string) => BriefJob | undefined
  /** override whose turn it is; null goes back to what the rules say */
  onSetTurn: (item: ScoredItem, turn: Turn | null) => void
}
