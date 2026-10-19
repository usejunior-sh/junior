/**
 * What Claude Code has actually spent, read from its own transcripts.
 *
 * Every Claude Code session, one started from this workbench, one started
 * from a terminal, one started by anything else on this machine, appends
 * JSONL to `~/.claude/projects/<slug>/<session>.jsonl`, and every assistant
 * line carries the API's `usage` block. That log is the ledger; we never
 * write our own, so the numbers can't drift from reality.
 *
 * Three things make this cheap enough to do on demand:
 *
 *  - Only lines that mention `usage` are parsed; the rest are skipped on a
 *    substring test, which is most of a transcript.
 *  - Parsed files are cached by (size, mtime). A rescan re-reads only what
 *    changed, in practice the one session you are talking to right now.
 *  - The same message can appear in several files (a resumed session replays
 *    its parent's transcript) and on several lines of one (Claude Code writes
 *    a line per content block, and the earlier ones can carry an output count
 *    that isn't final yet), so entries are de-duplicated on the API's own
 *    `message.id` + `requestId`, keeping the line that counts the most output.
 *
 * Subagents write their own transcripts, a level down,
 * `<slug>/<session>/subagents/agent-<id>.jsonl`, with the parent's
 * `sessionId` on every line, so they fold into the session that spawned them.
 * Workflow agents (Ultracode) sit two levels further down, at
 * `<session>/subagents/workflows/<runId>/agent-<id>.jsonl`, and fold the same way.
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { costOf, normalizeModel, type TokenCounts } from './pricing.js'

/** One assistant message's usage, flattened. */
export type UsageEntry = TokenCounts & {
  /** Epoch ms of the message. */
  ts: number
  model: string
  /** `message.id:requestId`: the de-duplication key. */
  key: string
  /** The folder the session ran in. */
  cwd: string
  sessionId: string
  fast: boolean
  /** Spent by a subagent of `sessionId`, not by the session's own agent. */
  subagent: boolean
  /** Spent by an agent of one of the session's Workflow runs (also a `subagent`). */
  workflow?: true
  /** The `projects/` root the transcript sits under: which Claude config dir, so which login. */
  root: string
}

type FileCache = { size: number; mtimeMs: number; entries: UsageEntry[] }

/** Parsed transcripts, keyed by path, survives between requests. */
const cache = new Map<string, FileCache>()

/** A runaway corpus shouldn't be able to exhaust memory. */
const MAX_ENTRIES_PER_FILE = 200_000

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Pull the usage out of one transcript line, or `null` if it carries none. */
export function usageEntryFrom(line: string, root: string): UsageEntry | null {
  let row: Record<string, any>
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (row?.type !== 'assistant') return null
  const message = row.message
  const usage = message?.usage
  if (!usage || typeof message?.model !== 'string') return null
  const model = normalizeModel(message.model)
  if (!model || model === '<synthetic>') return null

  // The breakdown is authoritative when present; older lines only have the
  // total, which we bill at the cheaper 5-minute write price.
  const created = num(usage.cache_creation_input_tokens)
  const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens)
  const fiveMin = usage.cache_creation
    ? num(usage.cache_creation.ephemeral_5m_input_tokens)
    : created

  const ts = Date.parse(row.timestamp ?? '')
  return {
    ts: Number.isFinite(ts) ? ts : 0,
    model,
    key: `${message.id ?? ''}:${row.requestId ?? ''}`,
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
    fast: usage.speed === 'fast',
    subagent: row.isSidechain === true,
    root,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheWrite5m: fiveMin,
    cacheWrite1h: oneHour,
    cacheRead: num(usage.cache_read_input_tokens),
  }
}

async function readFileEntries(path: string, root: string, workflow: boolean): Promise<UsageEntry[]> {
  const entries: UsageEntry[] = []
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      // Cheap gate: only assistant lines carry a usage block, and they are a
      // small minority of a transcript.
      if (!line.includes('"usage"')) continue
      const e = usageEntryFrom(line, root)
      if (e) entries.push(workflow ? { ...e, workflow: true } : e)
      if (entries.length >= MAX_ENTRIES_PER_FILE) break
    }
  } finally {
    rl.close()
  }
  return entries
}

type Transcript = { path: string; workflow: boolean }

/** A Workflow run's agent transcripts; its folder also holds journal.jsonl and *.meta.json. */
export const isWorkflowAgentFile = (name: string) => /^agent-[^/]+\.jsonl$/.test(name)

/**
 * Every `*.jsonl` under a `projects/` root: each project slug's sessions, each
 * session's subagents, and each of its Workflow runs' agents.
 */
async function transcripts(root: string): Promise<Transcript[]> {
  let slugs: string[]
  try {
    slugs = await readdir(root)
  } catch {
    return []
  }
  const out: Transcript[] = []
  const subagentDirs: string[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    let names: Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of names) {
      if (d.isFile() && d.name.endsWith('.jsonl')) out.push({ path: join(dir, d.name), workflow: false })
      else if (d.isDirectory()) subagentDirs.push(join(dir, d.name, 'subagents'))
    }
  }
  // Most session folders hold only tool results; a missing subagents/ is the common case.
  const nested = await mapLimit(subagentDirs, 16, async (sub): Promise<Transcript[]> => {
    let names: Dirent[]
    try {
      names = await readdir(sub, { withFileTypes: true })
    } catch {
      return []
    }
    const found: Transcript[] = names.filter((d) => d.name.endsWith('.jsonl')).map((d) => ({ path: join(sub, d.name), workflow: false }))
    if (names.some((d) => d.isDirectory() && d.name === 'workflows')) found.push(...(await workflowAgentFiles(join(sub, 'workflows'))))
    return found
  })
  return out.concat(nested.flat())
}

/** `subagents/workflows/<runId>/agent-*.jsonl`, one folder per run. */
async function workflowAgentFiles(dir: string): Promise<Transcript[]> {
  let runs: Dirent[]
  try {
    runs = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const perRun = await Promise.all(
    runs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        try {
          return (await readdir(join(dir, d.name))).filter(isWorkflowAgentFile).map((n) => ({ path: join(dir, d.name, n), workflow: true }))
        } catch {
          return []
        }
      }),
  )
  return perRun.flat()
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i])
  })
  await Promise.all(workers)
  return out
}

export type ScanResult = {
  entries: UsageEntry[]
  files: number
  /** Files re-read this pass; the rest came from cache. */
  reread: number
}

/**
 * Every usage entry under these roots, de-duplicated. `since` drops whole
 * files by mtime before they are opened. A 30-day window never touches a
 * transcript last written months ago.
 */
export async function scanUsage(roots: string[], since: number): Promise<ScanResult> {
  const paths = (await Promise.all(roots.map(async (root) => (await transcripts(root)).map((t) => ({ ...t, root }))))).flat()
  let reread = 0

  const perFile = await mapLimit(paths, 8, async ({ path, root, workflow }) => {
    let info
    try {
      info = await stat(path)
    } catch {
      return []
    }
    if (info.mtimeMs < since) {
      // Outside the window and unchanged since: nothing in it can matter.
      cache.delete(path)
      return []
    }
    const hit = cache.get(path)
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.entries
    reread++
    const entries = await readFileEntries(path, root, workflow)
    cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, entries })
    return entries
  })

  const seen = new Map<string, number>()
  const entries: UsageEntry[] = []
  for (const list of perFile) {
    for (const e of list) {
      if (e.ts < since) continue
      // An empty key means the line carried neither id, count it rather than
      // collapse every such line into one.
      if (e.key !== ':') {
        const at = seen.get(e.key)
        if (at !== undefined) {
          if (e.output > entries[at].output) entries[at] = e
          continue
        }
        seen.set(e.key, entries.length)
      }
      entries.push(e)
    }
  }
  return { entries, files: paths.length, reread }
}

/** Dollars for one entry, or `undefined` when its model has no price row. */
export const entryCost = (e: UsageEntry): number | undefined => costOf(e.model, e, e.fast)

/** Drop the cache: used by tests and by an explicit "rescan from scratch". */
export function resetUsageCache() {
  cache.clear()
}
