/**
 * A line typed in `n` characters so far, split per segment into what shows and
 * what is still to come: [typed, rest] for each. The rest is still rendered
 * (hidden), so the line has its final size and breaks from the first frame.
 */
export function splitTyped(segments: string[], n: number): [string, string][] {
  let left = Math.max(0, n)
  return segments.map((seg) => {
    const k = Math.min(left, seg.length)
    left -= k
    return [seg.slice(0, k), seg.slice(k)]
  })
}
