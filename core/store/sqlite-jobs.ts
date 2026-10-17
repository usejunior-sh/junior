import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { type JobConnector, type JobRunStatus, JOB_RUN_STATUSES, type JobRunTrigger, type JobBrief, type Job, JOB_NOTIFY, type JobNotify, type JobCadence, type NewJob, type JobRunStart, type JobRunResult, type NewJobSlotRun, type JobSlotFinish, type JobSlotRun, type JobSlotStatus } from '../job/types.js'
import { cronFromCadence } from '../job/cron.js'
import { type JobToolGrant, grantsFrom, grantsFromLegacy } from '../job/tools.js'
import type { JobStore, JobStatePatch, JobRunLedger } from './types.js'

type JobRow = {
  id: string
  source: string
  title: string
  scope: string
  instruction: string
  cadence: string
  window_start: string | null
  window_day: number | null
  schedule: string | null
  enabled: number
  creates_items: number
  cursor: string | null
  last_run_at: number | null
  last_run_tokens: number | null
  last_run_matches: number | null
  last_run_status: string | null
  last_run_session_id: string | null
  last_run_error: string | null
  template_id: string | null
  connectors: string | null
  project_id: string | null
  model: string | null
  output: string | null
  tools: string | null
  config_error: string | null
  catch_up_window: string | null
  timeout_ms: number | null
  max_budget_usd: number | null
  daily_budget_usd: number | null
  file: string | null
  notify: string | null
  consecutive_failures: number | null
  last_run_started_at: number | null
  last_run_new: number | null
  last_run_trigger: string | null
  brief?: string | null
  draft?: number | null
  skills?: string | null
  agents?: string | null
  created_at: number
  updated_at: number
}

const CONNECTORS = new Set<JobConnector>(['slack', 'linear', 'github', 'web'])
/** Parse the stored connector list; a legacy row (NULL) was a Slack job. */
function toConnectors(raw: string | null): JobConnector[] {
  if (!raw) return ['slack']
  try {
    const arr = JSON.parse(raw) as unknown
    const out = Array.isArray(arr) ? arr.filter((c): c is JobConnector => CONNECTORS.has(c as JobConnector)) : []
    return out.length ? out : ['slack']
  } catch {
    return ['slack']
  }
}

export const toRunStatus = (v: string | null): JobRunStatus | undefined =>
  JOB_RUN_STATUSES.includes(v as JobRunStatus) ? (v as JobRunStatus) : undefined

const TRIGGERS: JobRunTrigger[] = ['scheduled', 'catch_up', 'manual', 'redraft']
export const toTrigger = (v: string | null): JobRunTrigger | undefined =>
  TRIGGERS.includes(v as JobRunTrigger) ? (v as JobRunTrigger) : undefined

/** Stored grants; a row from before grants (NULL) migrates from its legacy connectors. */
function toGrants(raw: string | null, legacy: string | null): JobToolGrant[] {
  if (raw) {
    try {
      const parsed = grantsFrom(JSON.parse(raw))
      if ('grants' in parsed) return parsed.grants
    } catch {
      /* fall through to the legacy list */
    }
  }
  return grantsFromLegacy(toConnectors(legacy))
}

/** The stored brief option: JSON, or NULL = off. */
function toJobBrief(raw: string | null | undefined): JobBrief | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
      ...(typeof o.template === 'string' && o.template ? { template: o.template } : {}),
    }
  } catch {
    return null
  }
}

/** A stored name list (skills, agents): JSON strings; anything else reads as none. */
function toNames(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
  } catch {
    return []
  }
}
const fromNames = (names: string[] | null | undefined): string | null => (names?.length ? JSON.stringify(names) : null)

const toJob = (r: JobRow): Job => ({
  id: r.id,
  source: 'slack',
  title: r.title,
  scope: r.scope,
  instruction: r.instruction,
  tools: toGrants(r.tools, r.connectors),
  // Required since job-spec item 2; a legacy NULL is migrated to the scratch
  // project at boot, and reads as '' (no project) until then.
  projectId: r.project_id ?? '',
  ...(r.config_error ? { configError: r.config_error } : {}),
  ...(r.catch_up_window ? { catchUpWindow: r.catch_up_window } : {}),
  ...(r.timeout_ms != null ? { timeoutMs: r.timeout_ms } : {}),
  ...(r.max_budget_usd != null ? { maxBudgetUsd: r.max_budget_usd } : {}),
  ...(r.daily_budget_usd != null ? { dailyBudgetUsd: r.daily_budget_usd } : {}),
  ...(r.file ? { file: r.file } : {}),
  notify: JOB_NOTIFY.includes(r.notify as JobNotify) ? (r.notify as JobNotify) : 'on_failure',
  consecutiveFailures: r.consecutive_failures ?? 0,
  model: r.model ?? undefined,
  output: r.output === 'digest' ? 'digest' : 'items',
  cadence: r.cadence as JobCadence,
  windowStart: r.window_start ?? undefined,
  windowDay: r.window_day ?? undefined,
  // Precise schedule is the source of truth; legacy rows derive it from cadence.
  schedule: r.schedule ?? cronFromCadence(r.cadence as JobCadence, r.window_start ?? undefined, r.window_day ?? undefined),
  enabled: r.enabled === 1,
  createsItems: r.creates_items === 1,
  lastRunStartedAt: r.last_run_started_at ?? undefined,
  lastRunAt: r.last_run_at ?? undefined,
  lastRunNew: r.last_run_new ?? undefined,
  lastRunTrigger: toTrigger(r.last_run_trigger),
  lastRunTokens: r.last_run_tokens ?? undefined,
  lastRunMatches: r.last_run_matches ?? undefined,
  lastRunStatus: toRunStatus(r.last_run_status),
  lastRunSessionId: r.last_run_session_id ?? undefined,
  lastRunError: r.last_run_error ?? undefined,
  templateId: r.template_id ?? undefined,
  ...(toJobBrief(r.brief) ? { brief: toJobBrief(r.brief)! } : {}),
  ...(r.draft ? { draft: true } : {}),
  ...(toNames(r.skills).length ? { skills: toNames(r.skills) } : {}),
  ...(toNames(r.agents).length ? { agents: toNames(r.agents) } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class SqliteJobs implements JobStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Job[]> {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at').all() as JobRow[]
    return rows.map(toJob)
  }

  async get(id: string): Promise<Job | null> {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return r ? toJob(r) : null
  }

  async create(w: Job): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO jobs (id, source, title, scope, instruction, cadence, window_start, window_day,
           schedule, enabled, creates_items, cursor, last_run_at, last_run_tokens, last_run_matches, template_id,
           tools, project_id, model, output, catch_up_window, timeout_ms, max_budget_usd, daily_budget_usd, file, notify,
           config_error, last_run_started_at, consecutive_failures, brief, draft, skills, agents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id, w.source, w.title, w.scope, w.instruction, w.cadence,
        w.windowStart ?? null, w.windowDay ?? null,
        w.schedule,
        w.enabled ? 1 : 0, w.createsItems ? 1 : 0,
        w.templateId ?? null,
        JSON.stringify(w.tools), w.projectId || null, w.model ?? null, w.output,
        w.catchUpWindow ?? null, w.timeoutMs ?? null, w.maxBudgetUsd ?? null, w.dailyBudgetUsd ?? null, w.file ?? null, w.notify,
        w.configError ?? null, w.lastRunStartedAt ?? null,
        w.brief ? JSON.stringify(w.brief) : null, w.draft ? 1 : 0,
        fromNames(w.skills), fromNames(w.agents),
        w.createdAt, w.updatedAt,
      )
  }

  async update(id: string, patch: Partial<NewJob> & { enabled?: boolean }): Promise<void> {
    const current = await this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    // null in a patch clears an optional limit back to "use the default"
    const opt = <T,>(v: T | null | undefined): T | null => (v === undefined || v === null ? null : v)
    this.db
      .prepare(
        `UPDATE jobs SET title = ?, scope = ?, instruction = ?, cadence = ?, window_start = ?,
           window_day = ?, schedule = ?, enabled = ?, creates_items = ?, tools = ?, project_id = ?, model = ?, output = ?,
           catch_up_window = ?, timeout_ms = ?, max_budget_usd = ?, daily_budget_usd = ?, file = ?, notify = ?,
           brief = ?, draft = ?, skills = ?, agents = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title, next.scope ?? '', next.instruction, next.cadence,
        next.windowStart ?? null, next.windowDay ?? null,
        next.schedule,
        next.enabled ? 1 : 0, next.createsItems ? 1 : 0,
        JSON.stringify(next.tools), next.projectId || null, next.model ?? null, next.output ?? 'items',
        opt(next.catchUpWindow), opt(next.timeoutMs), opt(next.maxBudgetUsd), opt(next.dailyBudgetUsd), next.file ?? null, next.notify ?? 'on_failure',
        next.brief ? JSON.stringify(next.brief) : null, next.draft ? 1 : 0,
        fromNames(next.skills), fromNames(next.agents),
        Date.now(), id,
      )
  }

  async patchState(id: string, patch: JobStatePatch): Promise<void> {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0) }
    if (patch.configError !== undefined) { sets.push('config_error = ?'); vals.push(patch.configError) }
    if (patch.lastRunStartedAt !== undefined) { sets.push('last_run_started_at = ?'); vals.push(patch.lastRunStartedAt) }
    if (patch.projectId !== undefined) { sets.push('project_id = ?'); vals.push(patch.projectId) }
    if (!sets.length) return
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  async markRunStarted(id: string, start: JobRunStart): Promise<void> {
    this.db
      .prepare(
        `UPDATE jobs SET last_run_started_at = ?, last_run_trigger = COALESCE(?, last_run_trigger),
           last_run_session_id = COALESCE(?, last_run_session_id) WHERE id = ?`,
      )
      .run(start.startedAt, start.trigger ?? null, start.sessionId ?? null, id)
  }

  /**
   * Write back one run attempt. Status/session/error are always recorded so the
   * list can tell "looked, found nothing" from "the scan broke". The failure
   * streak counts failed/timeout runs in a row; an ok run resets it; skips and
   * interruptions leave it alone.
   */
  async recordRun(id: string, run: JobRunResult): Promise<void> {
    const streak =
      run.status === 'ok' ? '0' : run.status === 'failed' || run.status === 'timeout' ? 'consecutive_failures + 1' : 'consecutive_failures'
    this.db
      .prepare(
        `UPDATE jobs SET last_run_at = ?, last_run_tokens = ?, last_run_matches = ?, last_run_new = ?,
           last_run_status = ?, last_run_session_id = COALESCE(?, last_run_session_id), last_run_error = ?,
           last_run_trigger = COALESCE(?, last_run_trigger), consecutive_failures = ${streak} WHERE id = ?`,
      )
      .run(run.lastRunAt, run.lastRunTokens, run.lastRunMatches, run.lastRunNew ?? null,
        run.status, run.sessionId ?? null, run.error ?? null, run.trigger ?? null, id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }
}

type JobRunRow = {
  id: string
  job_id: string
  slot: number
  trigger: string
  status: string
  reason: string | null
  session_id: string | null
  started_at: number
  ended_at: number | null
  cost_usd: number | null
}

export class SqliteJobRuns implements JobRunLedger {
  constructor(private db: DatabaseSync) {}

  async insert(run: NewJobSlotRun): Promise<boolean> {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO job_runs (id, job_id, slot, trigger, status, reason, session_id, started_at, ended_at, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id ?? randomUUID(), run.jobId, run.slot, run.trigger, run.status, run.reason ?? null, run.sessionId ?? null,
        run.startedAt, run.endedAt ?? null, run.costUsd ?? null)
    return Number(res.changes) > 0
  }

  async attachSession(jobId: string, slot: number, sessionId: string): Promise<void> {
    this.db.prepare('UPDATE job_runs SET session_id = ? WHERE job_id = ? AND slot = ?').run(sessionId, jobId, slot)
  }

  async finish(jobId: string, slot: number, end: JobSlotFinish): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE job_runs SET status = ?, reason = ?, session_id = COALESCE(?, session_id), ended_at = ?, cost_usd = ?
         WHERE job_id = ? AND slot = ? AND status = 'running'`,
      )
      .run(end.status, end.reason ?? null, end.sessionId ?? null, end.endedAt, end.costUsd ?? null, jobId, slot)
    return Number(res.changes) > 0
  }

  async insertMissed(jobId: string, slots: number[], runId: string, at: number): Promise<number> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO job_runs (id, job_id, slot, trigger, status, reason, started_at, ended_at)
       VALUES (?, ?, ?, 'catch_up', 'missed', ?, ?, ?)`,
    )
    let written = 0
    this.db.exec('BEGIN')
    try {
      for (const slot of slots) written += Number(stmt.run(randomUUID(), jobId, slot, `covered by ${runId}`, at, at).changes)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return written
  }

  async spentSince(jobId: string, since: number): Promise<number> {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM job_runs WHERE job_id = ? AND started_at >= ?')
      .get(jobId, since) as { spent: number }
    return row.spent
  }

  async lastOkAt(): Promise<Map<string, number>> {
    const rows = this.db
      .prepare(`SELECT job_id, MAX(COALESCE(ended_at, started_at)) AS at FROM job_runs WHERE status = 'ok' GROUP BY job_id`)
      .all() as { job_id: string; at: number }[]
    return new Map(rows.map((r) => [r.job_id, r.at]))
  }

  async list(jobId: string, limit = 100): Promise<JobSlotRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY slot DESC LIMIT ?')
      .all(jobId, limit) as JobRunRow[]
    return rows.map(toSlotRun)
  }

  async sweepInterrupted(endedAt: number, reason: string): Promise<number> {
    const res = this.db
      .prepare(`UPDATE job_runs SET status = 'interrupted', reason = ?, ended_at = ? WHERE status = 'running'`)
      .run(reason, endedAt)
    return Number(res.changes)
  }
}

function toSlotRun(r: JobRunRow): JobSlotRun {
  return {
    id: r.id,
    jobId: r.job_id,
    slot: r.slot,
    trigger: r.trigger as JobRunTrigger,
    status: r.status as JobSlotStatus,
    reason: r.reason ?? undefined,
    sessionId: r.session_id ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    costUsd: r.cost_usd ?? undefined,
  }
}
