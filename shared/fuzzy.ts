/**
 * A small fzy-style fuzzy matcher, shared by the server (file search) and the
 * client (work items and sessions in the `@` picker), so both sides rank the
 * same way. The needle must appear in the haystack as a subsequence; the score
 * rewards matches that start a word (after `/`, `.`, `-`, `_`, a space, or a
 * camelCase bump), runs of adjacent matches, and short haystacks.
 */

const WORD_BREAKS = new Set(['/', '.', '-', '_', ' ', ':', '#'])

function isBoundary(hay: string, i: number): boolean {
  if (i === 0) return true
  const prev = hay[i - 1]
  if (WORD_BREAKS.has(prev)) return true
  // camelCase bump: lower → upper
  const cur = hay[i]
  return prev.toLowerCase() === prev && cur.toUpperCase() === cur && cur.toLowerCase() !== cur
}

/**
 * Score `needle` against `hay`; `null` when it is not a subsequence. Higher is
 * better. Greedy left-to-right with a boundary preference, not the full
 * dynamic-programming optimum, but stable and fast enough for 50k paths a
 * keystroke.
 */
export function fuzzyScore(needle: string, hay: string): number | null {
  const n = needle.toLowerCase()
  const h = hay.toLowerCase()
  if (n.length === 0) return 0
  if (n.length > h.length) return null
  // Boundary-seeking can overshoot (the `t` of "prompt" jumping to ".tsx" and
  // stranding the "box"), so a failed walk falls back to plain first-occurrence
  // matching, which succeeds whenever the needle is a subsequence at all.
  return walk(n, h, hay, true) ?? walk(n, h, hay, false)
}

function walk(n: string, h: string, hay: string, preferBoundary: boolean): number | null {
  let score = 0
  let hi = 0
  let prevMatch = -2
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni]
    let at = -1
    for (let j = hi; j < h.length; j++) {
      if (h[j] !== ch) continue
      if (at === -1) {
        at = j
        // Plain mode, or continuing a run of adjacent matches: take it.
        if (!preferBoundary || j === prevMatch + 1) break
      }
      if (isBoundary(hay, j)) {
        at = j
        break
      }
      // Don't scan the whole string looking for a boundary on every char.
      if (j - hi > 24) break
    }
    if (at === -1) return null
    score += 1
    if (isBoundary(hay, at)) score += 8
    if (at === prevMatch + 1) score += 4
    // gap penalty: long jumps read as coincidence
    score -= Math.min(at - hi, 10) * 0.5
    prevMatch = at
    hi = at + 1
  }
  // Basename matches matter more than directory matches for files (a path
  // with no directory is all basename).
  if (prevMatch > h.lastIndexOf('/')) score += 6
  // shorter is better, gently
  score -= Math.min(h.length, 120) * 0.05
  return score
}

/**
 * Rank `items` by `fuzzyScore(needle, key(item))`, dropping non-matches, best
 * first. `minPerChar` drops weak matches: a six-letter needle scattered across
 * a long sentence is a subsequence of almost anything, so prose keys (titles)
 * want a floor around 2.5 while paths can stay lenient at 0.
 */
export function fuzzyRank<T>(
  needle: string,
  items: readonly T[],
  key: (t: T) => string,
  limit = 50,
  minPerChar = 0,
): T[] {
  const q = needle.trim()
  if (!q) return items.slice(0, limit)
  const floor = q.length * minPerChar
  const scored: { t: T; s: number }[] = []
  for (const t of items) {
    const s = fuzzyScore(q, key(t))
    if (s !== null && s >= floor) scored.push({ t, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.t)
}
