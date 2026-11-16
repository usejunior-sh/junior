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
/** A monogram tile's slot (names hidden): the front one's chevron, plus the gap. */
export const TAB_MONO = 46

/** `mono`: names hidden, every tab a tile of one width; no short step. */
export function fitTabs(tabs: readonly StripTab[], active: string, width: number, mono = false): StripFit {
  const ids = tabs.map((t) => t.id)
  if (mono && tabs.length * TAB_MONO <= width) return { shown: ids, folded: [], short: false }
  if (!mono && tabs.length * TAB_FULL <= width) return { shown: ids, folded: [], short: false }
  if (!mono && tabs.length * TAB_SHORT <= width) return { shown: ids, folded: [], short: true }
  const slots = Math.max(1, Math.floor((width - MORE_W) / (mono ? TAB_MONO : TAB_SHORT)))
  const keep = new Set(tabs.filter((t) => t.id === active || t.count > 0).map((t) => t.id))
  const rest = tabs.filter((t) => !keep.has(t.id)).sort((a, b) => b.lastActive - a.lastActive)
  for (const t of rest) {
    if (keep.size >= slots) break
    keep.add(t.id)
  }
  return { shown: ids.filter((id) => keep.has(id)), folded: ids.filter((id) => !keep.has(id)), short: !mono }
}

/**
 * Each workspace's monogram, for its tile when names are hidden
 * (.docs/workspace-tabs/private-tabs.html). Two or more words: their
 * initials ("Triage Dev" → TD). One word: its first letter and the next
 * consonant ("Lab" → LB, "Novus" → NV). A clash takes the next consonant,
 * then the next letter. Nothing to set up. Pure; keyed by workspace id.
 */
export function monograms(list: readonly { id: string; name: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  const taken = new Set<string>()
  for (const { id, name } of list) {
    const words = name.toUpperCase().match(/[\p{L}\p{N}]+/gu) ?? []
    const [head = '', ...rest] = words
    const first = head[0] ?? '?'
    const tail = rest.map((w) => w[0]).join('') + head.slice(1)
    // second-letter candidates, best first: the next words' initials, else consonants, then any letter
    const seconds = rest.length ? [...tail] : [...tail.replace(/[AEIOUY]/g, ''), ...tail]
    let m = first
    for (const c of seconds) {
      if (!taken.has(first + c)) {
        m = first + c
        break
      }
    }
    taken.add(m)
    out[id] = m
  }
  return out
}

/** Step to the next or previous tab, wrapping (⌃Tab / ⌃⇧Tab). */
export function stepTab(ids: readonly string[], active: string, by: 1 | -1): string {
  if (!ids.length) return active
  const i = ids.indexOf(active)
  return ids[(i + by + ids.length) % ids.length]
}
