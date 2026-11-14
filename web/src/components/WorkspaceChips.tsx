import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Workspace, WorkspacesNeedsYouResponse } from '../../../shared/protocol.js'

/** How often the other workspaces' counts are read on the phone. */
const COUNTS_EVERY_MS = 30_000

/** Every workspace's needs-you count, polled (GET /api/workspaces/needs-you). Empty until it answers. */
export function useWorkspaceCounts(on: boolean): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!on) return
    let live = true
    const read = async () => {
      try {
        const r = (await (await fetch('/api/workspaces/needs-you')).json()) as WorkspacesNeedsYouResponse
        if (live && r.ok) setCounts(r.counts)
      } catch {
        // an older daemon has no counts: the chips show none
      }
    }
    void read()
    const timer = window.setInterval(read, COUNTS_EVERY_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [on])
  return counts
}

/**
 * The phone's workspace tabs (.docs/workspace-tabs/topbar-variations.html, B,
 * phone): a row of chips under the bar that swipes sideways. A tap is a page
 * change, not a new window. Another workspace shows its orange count; the one
 * you are in keeps its count on the rail, as in the app.
 */
export function WorkspaceChips({
  workspaces,
  workspaceId,
  onSwitch,
  onNew,
}: {
  workspaces: readonly Workspace[]
  workspaceId: string
  onSwitch: (id: string) => void
  onNew: () => void
}) {
  const counts = useWorkspaceCounts(true)
  return (
    <nav className="wsChipRow" aria-label="Workspaces">
      {workspaces.map((w) => {
        const on = w.id === workspaceId
        const n = on ? 0 : (counts[w.id] ?? 0)
        return (
          <button key={w.id} type="button" className={`wsChip${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => !on && onSwitch(w.id)}>
            <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
            <span className="wsChipName">{w.name}</span>
            {n > 0 && <span className="wsCount">{n}</span>}
          </button>
        )
      })}
      <button type="button" className="wsChip add" aria-label="New workspace" onClick={onNew}>
        <Plus size={14} aria-hidden="true" />
      </button>
    </nav>
  )
}
