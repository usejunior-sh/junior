

// System / daemon status + logs (GET /api/system, GET /api/logs), the gateway
// status surface: is the daemon up, is the scheduler ticking, are connectors
// live, and its recent activity log.
/**
 * Which copy of triage answered: computed from where the running code lives
 * and how its version is labelled (server/state.ts `buildInfo`). Several copies
 * coexist on one machine, so this is what lets the UI, the CLI and
 * `curl /api/health` all name the same one.
 *
 * `channel` is the question actually worth asking, how far is this from what
 * other people have?
 *
 *   dev, a source checkout, uncommitted work included (`npm run dev`)
 *   preview, a real install, but built from commits nobody has yet: the
 *             version carries a prerelease label (1.0.4-dev.g23d0004)
 *   release, a clean released version, the same bytes `curl | sh` hands out
 *
 * `surface` is where it is installed, which is a different axis: a preview and
 * a release both normally live in Triage.app.
 */
export type Build = {
  version: string
  channel: 'dev' | 'preview' | 'release'
  surface: 'app' | 'global' | 'checkout'
  /** short commit a preview was built from, parsed off the version label */
  commit: string | null
  /** the preview was built with uncommitted changes in the tree */
  dirty: boolean
  /** the package root on disk: the unambiguous answer to "which copy?" */
  root: string
  /** the state root this daemon reads: ~/.triage, or ~/.triage-dev in dev */
  home: string
  /** `home` is prod's ~/.triage: false means this daemon is on dev's data */
  prodData: boolean
}

export type SystemStatus = {
  version: string
  build: Build
  startedAt: number
  uptimeMs: number
  port: number
  /** the workspace this status describes (statuses are per-workspace) */
  workspace: string
  db: string
  liveSessions: number
  /** true/false, or null when the connector probe hasn't landed yet */
  slackConnected: boolean | null
  connectorsProbedAt: number | null
  connectorCount: number | null
  schedulerLastTickAt: number | null
  runningJobs: number
  inboxSyncedAt: number | null
  githubReconcileAt: number | null
  githubNotice: string | null
  jobs: { total: number; enabled: number; overdue: number; failing: number; configErrors: number }
  /** the macOS LaunchAgent that keeps triage running after reboot/crash: installed? (null off macOS) */
  launchAgent: boolean | null
  /** the workspace's global jobs switch: off = the scheduler never runs a job */
  jobsEnabled: boolean
  /** where JSONL log files are written, or null if file logging is off */
  logDir: string | null
}

export type SystemResponse = { ok: true; status: SystemStatus } | { ok: false; error: string }

export type LogLevel = 'info' | 'warn' | 'error'
export type LogEntry = {
  seq: number
  ts: number
  level: LogLevel
  subsystem: string
  message: string
  /** optional machine-readable context (ids, counts, durations) */
  fields?: Record<string, unknown>
}
export type LogsResponse =
  | { ok: true; entries: LogEntry[]; subsystems: string[] }
  | { ok: false; error: string }

// Usage (GET /api/usage?days=N)
//
// What Claude Code has spent on this machine, read from its own transcripts
// (`~/.claude/projects/**/*.jsonl`) rather than from anything we write, so it
// covers sessions started here, in a terminal, or anywhere else. Cost is
// derived from list prices: on a Pro/Max subscription it is what the same
// tokens would have cost on the API, not a bill.

export type UsageTotals = {
  input: number
  output: number
  /** Both TTLs of cache write, summed. */
  cacheWrite: number
  cacheRead: number
  /** Every token of every kind. */
  tokens: number
  /** Dollars, priced models only. */
  cost: number
  messages: number
  sessions: number
  /** Messages on a model we have no price for, counted, not costed. */
  unpricedMessages: number
}

/** One calendar day, with the per-model split the stacked chart draws. */
export type UsageDay = {
  date: string
  cost: number
  tokens: number
  byModel: Record<string, { cost: number; tokens: number }>
}

export type UsageByModel = {
  model: string
  messages: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  tokens: number
  cost: number
  /** False when the model has no price row. Its cost reads as 0. */
  priced: boolean
}

export type UsageByProject = {
  path: string
  sessions: number
  messages: number
  tokens: number
  cost: number
}

export type UsageSummary = {
  /** `YYYY-MM-DD`, inclusive. */
  from: string
  to: string
  days: number
  totals: UsageTotals
  /** Every day in the window, zeros included. */
  daily: UsageDay[]
  models: UsageByModel[]
  projects: UsageByProject[]
  /** Models seen with no price row: surfaced so the total is honest. */
  unpricedModels: string[]
  scan: { files: number; reread: number; ms: number }
}

/**
 * One login Claude Code ran on, for the Usage tab's filter (`&login=<id>`).
 * `account` is a claude.ai login, one per Claude config dir; `api-key` is one
 * per distinct key, however many workspaces share it. Every login a workspace
 * has set up is listed, spent or not, so the filter holds still across windows.
 */
export type UsageLogin = {
  /** `machine`, `dir:<workspace>`, `key:<fingerprint>` or `key:unknown`. */
  id: string
  kind: 'account' | 'api-key'
  /** "you@example.com", "API key …abcd". */
  label: string
  /** "Max · includes terminal sessions", or the workspaces on a key. */
  detail?: string
  cost: number
  tokens: number
  messages: number
}

export type UsageResponse =
  | {
      ok: true
      usage: UsageSummary
      logins: UsageLogin[]
      /** The login `usage` is for; null = every login. An unknown id asked for reads as null. */
      login: string | null
    }
  | { ok: false; error: string }

// Per-session spend (GET /api/usage/sessions?ids=…&days=…)
//
// What a work item cost: the same ledger the Usage tab reads, folded by
// session instead of by day/model/project. The client asks about the sessions
// it already knows are linked to the item, so the item→session join stays in
// one place (ItemPage's `linkedSessions`) instead of being re-derived here.

export type SessionSpend = {
  cost: number
  tokens: number
  messages: number
  /** `tokens`, split the way the API bills it. Cache writes are both TTLs. */
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** False when some of the spend came from a model with no price row. */
  priced: boolean
  /** The part of it the session's subagents spent (their own transcripts), workflow agents excluded. Absent = none. */
  subagents?: { cost: number; messages: number }
  /** The part of it the agents of the session's Ultracode Workflow runs spent. Absent = none. */
  workflows?: { cost: number; messages: number; tokens: number }
}

/** One model's share of a spend total, for the split meter under it. */
export type UsageModelSlice = {
  model: string
  cost: number
  tokens: number
  priced: boolean
}

export type SessionsUsage = {
  /** The window the ledger was scanned over. */
  days: number
  /** Keyed by *triage* session id: ids with no transcript in the window are absent. */
  bySession: Record<string, SessionSpend>
  /** The same spend split by model, largest first. */
  models: UsageModelSlice[]
  totals: SessionSpend & { sessions: number }
}

export type SessionsUsageResponse =
  | { ok: true; usage: SessionsUsage }
  | { ok: false; error: string }

/** The windows the Usage tab offers. */
export const USAGE_WINDOWS = [7, 30, 90] as const
