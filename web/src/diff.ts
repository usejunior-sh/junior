/**
 * Unified-diff parsing and a small line differ, both pure, both dependency
 * free on purpose (a diff library is a lot of weight for two screens, and the
 * published package should stay cheap to install).
 *
 * Two inputs feed the same renderer: git's patch text for a file's real diff,
 * and an `Edit` tool's `old_string`/`new_string`, which never went through git
 * at all and is diffed here.
 */

export type DiffRow =
  /** `@@ … @@`: a jump in the file */
  | { kind: 'hunk'; text: string; oldNo: null; newNo: null }
  | { kind: 'context'; text: string; oldNo: number; newNo: number }
  | { kind: 'add'; text: string; oldNo: null; newNo: number }
  | { kind: 'del'; text: string; oldNo: number; newNo: null }

export type ParsedDiff = {
  rows: DiffRow[]
  additions: number
  deletions: number
  isBinary: boolean
}

/** Parse git's unified-diff text for a single file. */
export function parsePatch(patch: string): ParsedDiff {
  const rows: DiffRow[] = []
  let additions = 0
  let deletions = 0
  let isBinary = false
  let oldNo = 0
  let newNo = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      isBinary = true
      continue
    }
    // Headers carry no content: the file name is already known by the caller.
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to')
    ) {
      continue
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
        rows.push({ kind: 'hunk', text: m[3].trim(), oldNo: null, newNo: null })
      }
      continue
    }
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    const body = line.slice(1)
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: body, oldNo: null, newNo: newNo++ })
      additions++
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: body, oldNo: oldNo++, newNo: null })
      deletions++
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', text: body, oldNo: oldNo++, newNo: newNo++ })
    }
    // Anything else is a stray trailing line, drop it rather than render it.
  }

  return { rows, additions, deletions, isBinary }
}

/** One screen row of a side-by-side view; either side can be empty. */
export type SplitRow = { left: DiffRow | null; right: DiffRow | null }

/**
 * Fold unified rows into side-by-side pairs: a run of deletions is zipped
 * against the run of additions that follows it, which is what makes a rewrite
 * read as "this became that" instead of two separate blocks.
 */
export function toSplit(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.kind === 'hunk' || row.kind === 'context') {
      out.push({ left: row, right: row })
      i++
      continue
    }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++])
    while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++])
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      out.push({ left: dels[j] ?? null, right: adds[j] ?? null })
    }
  }
  return out
}

/**
 * A line diff of two strings, for tool inputs that never reached git.
 *
 * Classic LCS over lines: O(n·m) in table size, which is the right trade for
 * an `Edit`'s couple of dozen lines and keeps the whole thing dependency free.
 * Above `MAX_LCS_CELLS` it degrades to "all removed, then all added" rather
 * than locking the tab up.
 */
const MAX_LCS_CELLS = 250_000

export function diffLines(before: string, after: string): ParsedDiff {
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  const rows: DiffRow[] = []

  if (a.length * b.length > MAX_LCS_CELLS) {
    a.forEach((t, i) => rows.push({ kind: 'del', text: t, oldNo: i + 1, newNo: null }))
    b.forEach((t, i) => rows.push({ kind: 'add', text: t, oldNo: null, newNo: i + 1 }))
    return { rows, additions: b.length, deletions: a.length, isBinary: false }
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  let additions = 0
  let deletions = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i], oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i], oldNo: i + 1, newNo: null })
      deletions++
      i++
    } else {
      rows.push({ kind: 'add', text: b[j], oldNo: null, newNo: j + 1 })
      additions++
      j++
    }
  }
  while (i < a.length) {
    rows.push({ kind: 'del', text: a[i], oldNo: i + 1, newNo: null })
    deletions++
    i++
  }
  while (j < b.length) {
    rows.push({ kind: 'add', text: b[j], oldNo: null, newNo: j + 1 })
    additions++
    j++
  }

  return { rows, additions, deletions, isBinary: false }
}

/**
 * Drop long runs of unchanged lines, leaving `pad` lines of context either
 * side of each change. The same job `--unified=N` does for git, but applied
 * to a diff we computed ourselves.
 */
export function collapseContext(rows: readonly DiffRow[], pad = 3): DiffRow[] {
  const keep = new Set<number>()
  rows.forEach((r, i) => {
    if (r.kind === 'add' || r.kind === 'del' || r.kind === 'hunk') {
      for (let j = Math.max(0, i - pad); j <= Math.min(rows.length - 1, i + pad); j++) keep.add(j)
    }
  })
  const out: DiffRow[] = []
  let gap = false
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      out.push(r)
      gap = false
    } else if (!gap) {
      out.push({ kind: 'hunk', text: '⋯', oldNo: null, newNo: null })
      gap = true
    }
  })
  return out
}

/** The `+a −d` pair a file row shows. */
export const countsOf = (d: ParsedDiff) => ({ additions: d.additions, deletions: d.deletions })
