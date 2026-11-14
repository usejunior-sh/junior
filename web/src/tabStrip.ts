/**
 * Which workspace tabs fit on the bar and which fold into "+N"
 * (.docs/workspace-tabs/topbar-variations.html, B, overflow). Pure.
 *
 * Tabs shrink to their short width first. When even that doesn't fit, the
 * least recently shown fold into "+N". Never folded: the tab in front, and
 * any tab with a needs-you count — a workspace that needs you stays in sight.
 */
export type StripTab = { id: string; lastActive: number; count: number }

export type StripFit = {
  /** shown on the bar, in strip order */
  shown: string[]
  /** in the "+N" menu, in strip order */
  folded: string[]
  /** tabs drawn at their short width */
  short: boolean
}

/** Widths the strip is laid out with, px (the mock's 180 / 92 + gap). */
export const TAB_FULL = 150
export const TAB_SHORT = 96
export const MORE_W = 64

export function fitTabs(tabs: readonly StripTab[], active: string, width: number): StripFit {
  const ids = tabs.map((t) => t.id)
  if (tabs.length * TAB_FULL <= width) return { shown: ids, folded: [], short: false }
  if (tabs.length * TAB_SHORT <= width) return { shown: ids, folded: [], short: true }
  const slots = Math.max(1, Math.floor((width - MORE_W) / TAB_SHORT))
  const keep = new Set(tabs.filter((t) => t.id === active || t.count > 0).map((t) => t.id))
  const rest = tabs.filter((t) => !keep.has(t.id)).sort((a, b) => b.lastActive - a.lastActive)
  for (const t of rest) {
    if (keep.size >= slots) break
    keep.add(t.id)
  }
  return { shown: ids.filter((id) => keep.has(id)), folded: ids.filter((id) => !keep.has(id)), short: true }
}

/** Step to the next or previous tab, wrapping (⌃Tab / ⌃⇧Tab). */
export function stepTab(ids: readonly string[], active: string, by: 1 | -1): string {
  if (!ids.length) return active
  const i = ids.indexOf(active)
  return ids[(i + by + ids.length) % ids.length]
}
