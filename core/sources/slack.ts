/**
 * Slack scanning: built-in rules + user-defined jobs (.docs/jobs.md),
 * re-based onto the Agent SDK. Fetched *through* the installed Claude Code's
 * claude.ai Slack connector, headless and read-only by construction (tool
 * allowlist). This repo never holds Slack credentials.
 *
 * Design rules: the LLM reads and extracts (URLs, refs, timestamps) and
 * answers exactly one judgment per candidate, "does this match, yes/no
 * (+ a one-line why)". It never scores, never merges, never decides done.
 * Malformed output rows are discarded, never repaired.
 *
 * One composed scan per due batch, not one session per job: the fixed
 * built-in sections plus one section per due job, in a single subprocess.
 */
import { canonicalizeRefs } from '../work/link.js'
import type { WorkItem } from '../work/types.js'
import type { JobDraft } from '../job/types.js'

/** the legacy Slack-only preview row (the live preview lives in server/index.ts now) */
interface JobPreviewRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  why: string
}

export const READ_ONLY_SLACK_TOOLS = [
  'ToolSearch',
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__claude_ai_Slack__slack_read_thread',
  'mcp__claude_ai_Slack__slack_read_channel',
  'mcp__claude_ai_Slack__slack_read_user_profile',
]

/** rows a single job may emit per scan (cost control; also enforced here) */
export const MAX_ROWS_PER_JOB = 15

export interface JobScanSpec {
  id: string
  /** '#channel' | '@dm': the boundary the section may not leave */
  scope: string
  instruction: string
  /** ISO watermark: scan messages after this; absent = recent-history window */
  cursor?: string
  createsItems: boolean
}

const SCAN_PREAMBLE = `You are a junior scanner. Your Slack tools are deferred: first use ToolSearch to load mcp__claude_ai_Slack__slack_search_public_and_private, mcp__claude_ai_Slack__slack_read_channel and mcp__claude_ai_Slack__slack_read_thread, then use them (read-only) to perform every scan section below.

Judge each candidate on its title and first ~200 characters; only read a full thread when that snippet is not enough to decide. Stay strictly inside each section's stated scope and time window.`

const BUILTIN_SECTION = `SECTION builtins — across the workspace, from the last 3 days:
1. Messages that mention/tag the user (the authenticated Slack account).
2. Threads the user participated in where the LATEST message is a question or request directed at the user that they have not answered yet (a reply is pending from them).
Rules: deduplicate threads (one row per thread, prefer kind reply-pending); if the user already answered, exclude it. Rows from this section carry "kind": "mention" or "reply-pending" (no jobId), and "refs": an array of any GitHub PR/issue URLs or Linear issue keys visible in the thread (empty array if none).`

function jobSection(w: JobScanSpec): string {
  const window = w.cursor
    ? `messages newer than ${w.cursor}`
    : `messages from the last 7 days`
  return `SECTION job ${w.id} — in ${w.scope} ONLY, scan ${window}. Match threads where: ${w.instruction}
Rules: one row per thread; at most ${MAX_ROWS_PER_JOB} rows; skip anything outside ${w.scope}. Rows from this section carry "jobId": "${w.id}" (no kind), a one-line "why" stating what matched, and "refs": an array of any GitHub PR/issue URLs or Linear issue keys visible in the matched content (empty array if none).`
}

const OUTPUT_CONTRACT = `Output ONLY one JSON array combining all sections' rows — no prose, no code fence. Each row:
{"title": "<one-line summary>", "permalink": "<slack message permalink>", "channel": "#<channel name>", "from": "<display name of the author/asker>", "lastActivity": "<ISO 8601 timestamp of the newest message in the thread>", "kind": "mention" | "reply-pending" (builtins only), "jobId": "<id>" (job sections only), "why": "<one line>" (job sections only), "refs": ["..."]}
If nothing qualifies anywhere, output [].
If you cannot access any Slack tools at all, output exactly: {"error": "no-slack-tools"}`

export function composeScanPrompt(builtins: boolean, jobs: JobScanSpec[]): string {
  return [
    SCAN_PREAMBLE,
    ...(builtins ? [BUILTIN_SECTION] : []),
    ...jobs.map(jobSection),
    OUTPUT_CONTRACT,
  ].join('\n\n')
}

// Per-job run prompt (.docs/jobs-v2.md): one job, one session. The
// output contract is TOOL CALLS, not JSON: for each match the scanner calls
// upsert_work_item, so a work item exists because a tool call created it (no
// parse-failure-reads-as-empty bug), and the run transcript is the receipt.
// The server injects a permalink-shaped upsert tool and stamps identity,
// kind, provenance, and the channel itself. The model only adds candidates.

const SLACK_MCP_TOOLS = READ_ONLY_SLACK_TOOLS.filter((t) => t.startsWith('mcp__'))

export function composeJobRunPrompt(w: { scope: string; instruction: string; cursor?: string }): string {
  const window = w.cursor ? `messages newer than ${w.cursor}` : `messages from the last 7 days`
  return `You are a junior scanner for ONE job. Your Slack tools are deferred: first call ToolSearch to load ${SLACK_MCP_TOOLS.join(', ')}, then use them (read-only) to perform the scan.

Scan ${w.scope} ONLY, ${window}. Judge each candidate on its title and first ~200 characters; read a full thread only when the snippet is not enough to decide. Stay strictly inside ${w.scope} — never scan any other channel or DM.

Match threads where: ${w.instruction}

For EACH matching thread, call the upsert_work_item tool exactly once, with:
- permalink: the Slack message permalink (required)
- title: a one-line summary of the thread
- from: the display name of the author/asker
- lastActivity: ISO 8601 timestamp of the newest message in the thread
- why: one line stating exactly what matched the instruction
- refs: an array of any GitHub PR/issue URLs or Linear issue keys visible in the matched content (omit when there are none)

Call upsert_work_item at most ${MAX_ROWS_PER_JOB} times, once per matching thread. It is the ONLY write tool you may use. If nothing matches, do not call it at all — just finish. If you cannot access any Slack tools at all, reply with exactly no-slack-tools and stop.`
}

// Output parsing: strict, per-row validation; malformed rows are discarded.

export interface RawBuiltinRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  kind: 'mention' | 'reply-pending'
  /** PR/issue URLs or Linear keys in the thread: a review ask folds into its PR's row */
  refs?: string[]
}

export interface RawJobRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  jobId: string
  why: string
  refs?: string[]
}

function validBase(r: Record<string, unknown>): boolean {
  return (
    typeof r.title === 'string' && r.title.length > 0 &&
    typeof r.permalink === 'string' && r.permalink.startsWith('http') &&
    typeof r.channel === 'string' &&
    typeof r.from === 'string'
  )
}

/** Extract and validate the JSON array from agent output. Pure. */
export function parseScanRows(
  raw: string,
  knownJobIds: Set<string>,
): { builtins: RawBuiltinRow[]; jobs: RawJobRow[] } {
  const builtins: RawBuiltinRow[] = []
  const jobs: RawJobRow[] = []
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return { builtins, jobs }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { builtins, jobs }
  }
  if (!Array.isArray(parsed)) return { builtins, jobs }
  const perJob = new Map<string, number>()
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (!validBase(r)) continue
    if (r.kind === 'mention' || r.kind === 'reply-pending') {
      builtins.push(r as unknown as RawBuiltinRow)
    } else if (typeof r.jobId === 'string' && knownJobIds.has(r.jobId) && typeof r.why === 'string' && r.why.length > 0) {
      const n = perJob.get(r.jobId) ?? 0
      if (n >= MAX_ROWS_PER_JOB) continue
      perJob.set(r.jobId, n + 1)
      jobs.push(r as unknown as RawJobRow)
    }
  }
  return { builtins, jobs }
}

// Normalization. Identity is deterministic: one item per thread, keyed by
// the permalink tail. Same scheme for every scanner, external ones included.

export function permalinkId(permalink: string): string {
  const tail = permalink.replace(/^https?:\/\/[^/]+\/archives\//, '').replace(/[?#].*$/, '')
  return `slack:${tail}`
}

export function safeWhen(iso: string, now: number): string {
  return Number.isFinite(Date.parse(iso)) ? iso : new Date(now).toISOString()
}

export function normalizeBuiltinRows(rows: RawBuiltinRow[], now = Date.now()): WorkItem[] {
  return rows.map((row) => {
    const when = safeWhen(row.lastActivity, now)
    const refs = canonicalizeRefs(row.refs)
    return {
      id: permalinkId(row.permalink),
      source: 'slack' as const,
      kind: row.kind === 'reply-pending' ? ('slack-reply-pending' as const) : ('slack-mention' as const),
      ...(refs ? { refs } : {}),
      title: row.title,
      url: row.permalink,
      repo: row.channel,
      author: row.from,
      peopleWaiting: row.kind === 'reply-pending' ? 1 : 0,
      createdAt: when,
      updatedAt: when,
    }
  })
}

export function normalizeJobRows(
  rows: RawJobRow[],
  specs: Map<string, JobScanSpec>,
  now = Date.now(),
): WorkItem[] {
  return rows.flatMap((row) => {
    const spec = specs.get(row.jobId)
    if (!spec) return []
    const when = safeWhen(row.lastActivity, now)
    return [{
      id: permalinkId(row.permalink),
      source: 'slack' as const,
      kind: spec.createsItems ? ('job-hit' as const) : ('fyi' as const),
      title: row.title,
      url: row.permalink,
      repo: row.channel,
      author: row.from,
      peopleWaiting: 0,
      createdAt: when,
      updatedAt: when,
      jobId: row.jobId,
      why: row.why,
      refs: canonicalizeRefs(row.refs),
    }]
  })
}

export interface SlackScanOutcome {
  builtinItems: WorkItem[]
  jobItems: WorkItem[]
  matchesByJob: Map<string, number>
  /** total tokens the scan consumed (0 when the SDK reports none) */
  tokens: number
  /** ISO time the scan started: the next cursor for every job it covered */
  startedAt: string
}

/**
 * The coding agent a scan runs through: the server's provider
 * (server/providers), passed in so core never spawns one itself.
 */
export interface HeadlessAgent {
  run(spec: {
    prompt: string
    /** load the user's own settings (connectors); false = none at all */
    userConfig: boolean
    allowedTools: string[]
    abort: AbortController
    env?: Record<string, string>
  }): AsyncIterable<HeadlessEvent>
}

/** The slice of a provider event a scan reads: a `result` carries the reply and its tokens. */
export type HeadlessEvent = { kind: string; text?: string; tokens?: number }

/** Run one headless prompt to completion; returns the result text + tokens. */
async function runHeadless(
  agent: HeadlessAgent,
  prompt: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<{ text: string; tokens: number }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const q = agent.run({
      prompt,
      userConfig: true,
      allowedTools: READ_ONLY_SLACK_TOOLS,
      abort,
      // Workspace auth: spawn with the caller's env (api key / config dir).
      ...(env ? { env } : {}),
    })
    let text = ''
    let tokens = 0
    for await (const ev of q) {
      if (ev.kind === 'result') {
        text = ev.text ?? ''
        tokens = ev.tokens ?? 0
        break
      }
    }
    if (text.includes('"no-slack-tools"')) {
      throw new Error('no Slack tools — enable Slack for Claude at claude.ai/settings/connectors')
    }
    return { text, tokens }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One composed scan: built-in rules (when due) + every due job, in a single
 * session. Throws on timeout or a missing connector; the caller decides how
 * that degrades (notice + retry on the next tick).
 */
export async function runSlackScan(
  agent: HeadlessAgent,
  opts: { builtins: boolean; jobs: JobScanSpec[]; timeoutMs?: number },
  now = Date.now(),
): Promise<SlackScanOutcome> {
  const startedAt = new Date(now).toISOString()
  const { text, tokens } = await runHeadless(
    agent,
    composeScanPrompt(opts.builtins, opts.jobs),
    opts.timeoutMs ?? 240_000,
  )
  const specs = new Map(opts.jobs.map((w) => [w.id, w]))
  const rows = parseScanRows(text, new Set(specs.keys()))
  const matchesByJob = new Map<string, number>(opts.jobs.map((w) => [w.id, 0]))
  for (const row of rows.jobs) {
    matchesByJob.set(row.jobId, (matchesByJob.get(row.jobId) ?? 0) + 1)
  }
  return {
    builtinItems: normalizeBuiltinRows(rows.builtins, now),
    jobItems: normalizeJobRows(rows.jobs, specs, now),
    matchesByJob,
    tokens,
    startedAt,
  }
}

/** Backwards-compatible built-ins-only scan. */
export async function scanSlack(agent: HeadlessAgent, timeoutMs = 180_000): Promise<WorkItem[]> {
  const outcome = await runSlackScan(agent, { builtins: true, jobs: [], timeoutMs })
  return outcome.builtinItems
}

// Job preview, the trust-maker in the creation flow: run a draft against
// the scope's recent history and show what it *would have* matched. Reads
// only; never touches jobs, cursors, or items.

export async function previewJob(
  agent: HeadlessAgent,
  scope: string,
  instruction: string,
  timeoutMs = 240_000,
  env?: Record<string, string>,
): Promise<{ rows: JobPreviewRow[]; tokens: number }> {
  const spec: JobScanSpec = { id: 'preview', scope, instruction, createsItems: true }
  const { text, tokens } = await runHeadless(agent, composeScanPrompt(false, [spec]), timeoutMs, env)
  const rows = parseScanRows(text, new Set(['preview'])).jobs.map((r) => ({
    title: r.title,
    permalink: r.permalink,
    channel: r.channel,
    from: r.from,
    lastActivity: r.lastActivity,
    why: r.why,
  }))
  return { rows, tokens }
}

// Job drafting: one LLM call parsing a plain-text wish into the structured
// form. Every field stays editable in the UI; this is a convenience, not an
// authority, so a parse failure just returns null and the user fills the form.

const DRAFT_PROMPT = (text: string) => `Parse this job request into JSON. A job scans one Slack scope (a "#channel" or "@dm") on a cadence for threads matching a plain-English instruction.

Request: ${JSON.stringify(text)}

Output ONLY a JSON object, no prose, no code fence:
{"title": "<short name, e.g. 'PX topics in #novus-px'>", "scope": "<#channel or @dm mentioned>", "instruction": "<the matching criteria as one clear sentence, including any exclusions>", "cadence": "hourly" | "daily" | "weekly" (default "daily" unless the request implies otherwise), "createsItems": true unless the request says FYI/digest-only}`

export async function draftJob(
  agent: HeadlessAgent,
  text: string,
  timeoutMs = 60_000,
  env?: Record<string, string>,
): Promise<JobDraft | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const q = agent.run({
      prompt: DRAFT_PROMPT(text),
      userConfig: false,
      allowedTools: [],
      abort,
      ...(env ? { env } : {}),
    })
    let out = ''
    for await (const ev of q) {
      if (ev.kind === 'result') {
        out = ev.text ?? ''
        break
      }
    }
    const start = out.indexOf('{')
    const end = out.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    const parsed = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>
    if (typeof parsed.title !== 'string' || typeof parsed.scope !== 'string' || typeof parsed.instruction !== 'string') return null
    const cadence = parsed.cadence === 'hourly' || parsed.cadence === 'weekly' ? parsed.cadence : 'daily'
    return {
      title: parsed.title,
      scope: parsed.scope,
      instruction: parsed.instruction,
      cadence,
      createsItems: parsed.createsItems !== false,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
