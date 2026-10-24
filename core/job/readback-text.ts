/**
 * A drafted job's read-back as text: the block `draft_job` appends to its
 * result, and the parser the chat's draft strip reads it back with. Kept apart
 * from the builder (readback.ts) so the web bundle carries only this: the
 * strip renders what the server built from the file, never model prose.
 *
 * Pure and browser-safe.
 */

export const READBACK_LABELS = ['Reads', 'Writes', 'Sends', 'Browser', 'Files', 'Runs'] as const
export type ReadbackLabel = (typeof READBACK_LABELS)[number]

export type ReadbackRow = { label: ReadbackLabel; value: string; quiet?: boolean }

export type Readback = {
  /** the job file, workspace-relative: "jobs/sentry-errors.md" */
  file: string
  rows: ReadbackRow[]
}

/** The tail every Sends row with a send carries: the run's hold stops each one. */
export const HELD_FOR_YOU = 'Held for you.'

/** "nothing" and "none" read quiet: present, never hidden, but not loud. */
const QUIET = new Set(['nothing', 'none'])
export const isQuiet = (value: string): boolean => QUIET.has(value)

const HEAD = (file: string) => `Read-back from ${file} (the user sees these lines under this call; don't restate them):`
const HEAD_RE = /^Read-back from (\S.*?) \(the user sees these lines under this call; don't restate them\):$/

export function readbackText(r: Readback): string {
  return [HEAD(r.file), ...r.rows.map((row) => `${row.label}: ${row.value}`)].join('\n')
}

/**
 * The read-back block out of a tool result, or null when there is none or it
 * is not whole (an older server, a parse miss). The strip then shows its
 * one-row form: never a half ledger.
 */
export function parseReadback(text: string): Readback | null {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => HEAD_RE.test(l.trim()))
  if (at < 0) return null
  const file = HEAD_RE.exec(lines[at]!.trim())![1]!
  const rows: ReadbackRow[] = []
  for (const line of lines.slice(at + 1)) {
    const m = /^(\w+): (.+)$/.exec(line.trim())
    if (!m || !(READBACK_LABELS as readonly string[]).includes(m[1]!)) break
    const value = m[2]!.trim()
    rows.push({ label: m[1] as ReadbackLabel, value, ...(isQuiet(value) ? { quiet: true } : {}) })
  }
  // every read-back names these; missing one means the block was cut
  for (const need of ['Reads', 'Writes', 'Sends', 'Files', 'Runs'] as const) {
    if (!rows.some((r) => r.label === need)) return null
  }
  return { file, rows }
}
