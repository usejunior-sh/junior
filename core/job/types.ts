/**
 * Jobs: user-defined ingestion rules (.docs/jobs.md). A job is plain-English
 * instructions, a schedule, the tools its runs may call, and the project
 * folder its runs work in. Server-managed rows → SQLite.
 */
import type { JobToolGrant } from './tools.js'

export type { JobToolGrant } from './tools.js'

export type JobCadence = 'hourly' | 'daily' | 'weekly'

/** Legacy (pre-grants) connector ids; old rows are migrated to tool grants. */
export type JobConnector = 'slack' | 'linear' | 'github' | 'web'

/**
 * What a run produces. `items`: one work item per match, deduped by the link
 * it passes. `digest`: ONE rolling work item per job with a markdown report
 * attached; each run rewrites the report and the item returns to the inbox.
 */
export type JobOutput = 'items' | 'digest'
export const JOB_OUTPUTS: JobOutput[] = ['items', 'digest']

/** The outcome of one job run. */
export type JobRunStatus = 'ok' | 'failed' | 'timeout' | 'skipped' | 'interrupted' | 'slept'
export const JOB_RUN_STATUSES: JobRunStatus[] = ['ok', 'failed', 'timeout', 'skipped', 'interrupted', 'slept']

/** Why a run happened. */
/** redraft = a finished run's own session continued with your send-back notes (core/actions/queue.ts) */
export type JobRunTrigger = 'scheduled' | 'catch_up' | 'manual' | 'redraft'

/**
 * The slot ledger's status: a run's outcome plus the states only a ledger row
 * can have, still `running`, over its daily budget, or `missed` (covered by a
 * later catch-up run). The job row and session receipts keep JobRunStatus.
 */
export type JobSlotStatus = JobRunStatus | 'running' | 'skipped_budget' | 'missed'
export const JOB_SLOT_STATUSES: JobSlotStatus[] = [...JOB_RUN_STATUSES, 'running', 'skipped_budget', 'missed']

/** One row of the slot ledger (`job_runs`): every slot, run or not, gets one. */
export interface JobSlotRun {
  id: string
  jobId: string
  /** the schedule slot this row is for, UNIQUE with jobId; a manual run uses its start time */
  slot: number
  trigger: JobRunTrigger
  status: JobSlotStatus
  reason?: string
  sessionId?: string
  startedAt: number
  endedAt?: number
  costUsd?: number
}

/** What opens a ledger row; the store mints the id unless the caller needs it up front. */
export type NewJobSlotRun = Omit<JobSlotRun, 'id'> & { id?: string }

/** What closes one. */
export interface JobSlotFinish {
  status: JobSlotStatus
  reason?: string
  sessionId?: string
  endedAt: number
  costUsd?: number
}

export type JobNotify = 'never' | 'on_failure' | 'always'
export const JOB_NOTIFY: JobNotify[] = ['never', 'on_failure', 'always']

/** Built-in run limits when neither the job nor the workspace sets one. */
export const DEFAULT_JOB_TIMEOUT_MS = 240_000
export const MAX_JOB_TIMEOUT_MS = 60 * 60_000

/**
 * A brief for every item a job files (.docs/work-item-model.md): the item
 * arrives briefed, briefing → ready, your turn. Absent = no briefs.
 */
export interface JobBrief {
  /** model for the brief runs; absent = the workspace's brief default */
  model?: string
  /** the playbook to brief with (a playbooks/<name>.md); absent = the item's kind */
  template?: string
}

/**
 * A job whose runs use the browser pane (.docs/browser.md): the profile they
 * are signed in as, and the sites they may open. Absent = no browser.
 */
export interface JobBrowser {
  /** a profile id or name, as the file writes it; resolved to an id when a run starts */
  profile: string
  /** hosts `browser_open` may load (`*.pendo.io` covers its subdomains); omitted = any site */
  sites?: string[]
}

export interface Job {
  id: string
  /** slack only (connector-neutral machinery; Slack lives in the prompt) */
  source: 'slack'
  /** "PX topics in #novus-px" */
  title: string
  /**
   * Legacy (pre-connectors) place hint: '#channel' | '@dm'. Empty for jobs
   * created since; kept so old rows still say where they used to look.
   */
  scope: string
  /** the NL instructions: where to look and what counts; editable forever */
  instruction: string
  /** the tools runs may call, resolved at save time (never empty) */
  tools: JobToolGrant[]
  /** the project whose folder every run works in, and nowhere else */
  projectId: string
  /** set when the job cannot run until the user fixes it (e.g. its project was removed) */
  configError?: string
  /** skip a missed slot older than this: "6h" | "never" | "unlimited"; omitted = default by output */
  catchUpWindow?: string
  /** per-run limits; omitted = the workspace default */
  timeoutMs?: number
  maxBudgetUsd?: number
  /** dollars this job may spend per local day, across all its runs; omitted = no daily cap */
  dailyBudgetUsd?: number
  /** the file this job's config lives in (`jobs/<file>.md`); omitted = a row from before job files */
  file?: string
  /** when to post a macOS notification about a run */
  notify: JobNotify
  /** model alias or wire id for the run; omitted = Claude Code's own default */
  model?: string
  /** items (default) or one rolling digest with a report */
  output: JobOutput
  /**
   * A 5-field cron expression, the source of truth for when the job runs
   * (.docs/jobs-v2.md). Legacy rows without one derive it from `cadence`.
   */
  schedule: string
  /** legacy coarse cadence; retained for back-compat / draft suggestions */
  cadence: JobCadence
  /** daily/weekly: local time "09:00" */
  windowStart?: string
  /** weekly: 0-6 (JS getDay convention, Sunday = 0) */
  windowDay?: number
  enabled: boolean
  /** false = FYI-only rows (fyi kind, base score 5) */
  createsItems: boolean
  /** epoch ms the last run STARTED (or was skipped), what the due rule reads */
  lastRunStartedAt?: number
  /** epoch ms the last run attempt finished (any status) */
  lastRunAt?: number
  /** items the last run filed that were not already in the inbox */
  lastRunNew?: number
  /** why the last run happened */
  lastRunTrigger?: JobRunTrigger
  /** failed/timeout runs in a row; reset by an ok run */
  consecutiveFailures: number
  /** what the last run cost/produced, surfaced in the job list UI */
  lastRunTokens?: number
  lastRunMatches?: number
  /** the last run's outcome, so the list can show ok/failed honestly */
  lastRunStatus?: JobRunStatus
  /** the session id of the last run, for opening its transcript */
  lastRunSessionId?: string
  /** the last run's error message, when it failed */
  lastRunError?: string
  /** the template this job was seeded from (pre-installed as a copy), if any */
  templateId?: string
  /** brief every item this job files; absent = off */
  brief?: JobBrief
  /** drafted by a chat (draft_job) and not yet reviewed: saved off until you enable it */
  draft?: boolean
  /** skills a run may load, as Claude calls them (`junior:<name>`, `<name>`, `<plugin>:<name>`); omitted = none */
  skills?: string[]
  /** subagents a run may hand work to, named the same way; omitted = none */
  agents?: string[]
  /** how it files: reason, labels, tiers (filing.ts); omitted = found, any label, no tiers */
  filing?: import('./filing.js').JobFiling
  /** the browser profile and sites its runs use; omitted = no browser */
  browser?: JobBrowser
  createdAt: number
  updatedAt: number
}

export type NewJob = Pick<Job, 'title' | 'instruction' | 'schedule' | 'createsItems' | 'tools' | 'projectId'> & {
  /** legacy place hint; new jobs leave it empty */
  scope?: string
  model?: string
  output?: JobOutput
  catchUpWindow?: string | null
  timeoutMs?: number | null
  maxBudgetUsd?: number | null
  dailyBudgetUsd?: number | null
  file?: string
  notify?: JobNotify
  /** null turns briefs off */
  brief?: JobBrief | null
  draft?: boolean
  /** null or [] = none */
  skills?: string[] | null
  agents?: string[] | null
  /** null = the default filing */
  filing?: import('./filing.js').JobFiling | null
  /** null = no browser */
  browser?: JobBrowser | null
  /** legacy; defaults to a coarse bucket when omitted */
  cadence?: JobCadence
  windowStart?: string
  windowDay?: number
}

/**
 * What one finished (or skipped, or interrupted) run attempt writes back to the
 * row. Runs are stateless: nothing here feeds the next
 * run's prompt.
 */
export interface JobRunResult {
  lastRunAt: number
  lastRunTokens: number
  lastRunMatches: number
  /** of the matches, how many were new to the inbox */
  lastRunNew?: number
  status: JobRunStatus
  trigger?: JobRunTrigger
  sessionId?: string
  error?: string
}

/** What starting (or skipping) a slot writes: the due rule's clock. */
export interface JobRunStart {
  startedAt: number
  trigger?: JobRunTrigger
  sessionId?: string
}

/** The draft step's parse of a plain-text wish, every field stays editable. */
export interface JobDraft {
  title: string
  scope: string
  instruction: string
  cadence: JobCadence
  createsItems: boolean
}

/** One thread a preview run would have matched, with its why-line. */
export interface JobPreviewRow {
  /** the canonical id the real run would file under */
  id: string
  title: string
  url: string
  place: string
  from: string
  lastActivity: string
  why: string
  /** the label the run picked (core/work/labels.ts) */
  ask: string
  /** how the job files it (filing.ts) */
  reason?: string
  label?: string
  tier?: string
}

/** What a dry run returns: the would-be items or the would-be digest, and what it cost. Nothing is saved. */
export interface JobPreviewResult {
  output: JobOutput
  rows: JobPreviewRow[]
  digest?: { title: string; body: string }
  /** outbound calls the dry run refused: the real run would queue these for your approval */
  wouldQueue?: Array<{ tool: string; summary: string }>
  tokens: number
  costUsd?: number
  durationMs: number
}
