import { randomUUID } from 'node:crypto'
import { type Job, type JobRunTrigger, MAX_JOB_TIMEOUT_MS } from '../../core/job/types.js'
import type { Project } from '../../shared/protocol.js'
import { mcpGrants, serverLabel } from '../../core/job/tools.js'
import { decide, humanSpan, parseCatchUp, scheduleOf, type SkipReason } from '../../core/job/schedule.js'
import { log } from '../log.js'
import { power, sleepWatch } from '../power.js'
import { settleRunStatus } from '../../core/goals/run-guard.js'
import { browserHub, type ConnectorProbe, WorkspaceRuntime } from '../workspace/runtime.js'
import { jobsEnabled } from '../settings-ops.js'
import { syncJobFiles } from './ops.js'
import { SCHEDULER_TICK_MS } from './scheduler.js'
import { runJob } from './run.js'
import { BROWSER_NEEDS_APP } from './preview.js'

/** how many job runs may execute at once (avoid the top-of-hour stampede) */
const JOB_CONCURRENCY = 2
/** how long past its timeout a run may hang (the SDK ignored the abort) before the watchdog frees its slot */
const WATCHDOG_GRACE_MS = 60_000
/** after a run's timeout aborts it, how long its stream may take to close before the run stops waiting on it */
export const RUN_KILL_GRACE_MS = 15_000
export const JOB_TIMEOUT_KEY = 'jobs.defaultTimeoutMs'
export const JOB_BUDGET_KEY = 'jobs.defaultBudgetUsd'

/** One run waiting for a slot in the queue. Waiting keeps its slot: the due
 * rule's clock only moves when the run actually starts. */
export type QueuedRun = { id: string; trigger: JobRunTrigger; slot: number }

/**
 * Is every MCP server this job uses up, per the latest probes? Only a server
 * the probe positively reports broken (needs auth, failed, disabled) blocks a
 * run. A server missing from a stale probe gets the benefit of the doubt, and
 * a run that truly can't reach it fails loudly with no-connector-tools. The
 * browser lives in Junior.app: a job that uses it skips while the app is closed.
 */
function jobReady(rt: WorkspaceRuntime, w: Job, project: Project | null): true | string {
  if (w.browser && !browserHub.status.compatible) return BROWSER_NEEDS_APP
  const probes = [rt.connectorCache, project ? rt.folderProbes.get(project.path) : undefined].filter(
    (p): p is ConnectorProbe => p != null,
  )
  if (!probes.length) return true
  for (const g of mcpGrants(w.tools)) {
    const found = probes.flatMap((p) => p.connectors).find((c) => c.server === g.source.server)
    if (found && (found.status === 'needs-auth' || found.status === 'failed' || found.status === 'disabled')) {
      return `${serverLabel(g.source.server)} ${found.status}`
    }
  }
  return true
}

const SKIP_TEXT: Record<SkipReason, string> = {
  overlap: 'previous run still in progress',
  window: 'missed slot older than the catch-up window',
  connector: 'a connector is not available',
}

/**
 * The slot ledger is additive: a failed write must never break a run or a
 * tick, so it is logged and swallowed.
 */
export function ledger(rt: WorkspaceRuntime, write: Promise<unknown>): Promise<void> {
  return write.then(
    () => {},
    (err) => log('warn', 'job', `slot ledger write failed: ${err}`, { workspace: rt.meta.id }),
  )
}

/** Record a skipped slot as a run receipt and move the due rule's clock. */
async function recordSkip(rt: WorkspaceRuntime, w: Job, reason: SkipReason, slot: number, detail?: string): Promise<void> {
  const now = Date.now()
  await rt.store.jobs.markRunStarted(w.id, { startedAt: now })
  const error = `skipped (${reason}): ${detail ?? SKIP_TEXT[reason]}`
  await ledger(rt, rt.store.jobRuns.insert({ jobId: w.id, slot, trigger: 'scheduled', status: 'skipped', reason: `${reason}: ${detail ?? SKIP_TEXT[reason]}`, startedAt: now, endedAt: now }))
  await rt.store.jobs.recordRun(w.id, { lastRunAt: now, lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', error })
  log('warn', 'scheduler', `${w.title}: ${error}`, { jobId: w.id, reason, workspace: rt.meta.id })
}

/**
 * The scheduler tick for one workspace: decide per
 * job, record skips, queue due runs oldest slot first.
 */
export async function runDueJobs(rt: WorkspaceRuntime, now = Date.now()): Promise<void> {
  // The global switch (Settings → Sources): off means the scheduler never runs a job.
  if (!(await jobsEnabled(rt))) return
  await syncJobFiles(rt).catch(() => {}) // logged by the sync; a bad file never stops the tick
  const projects = await rt.store.projects.list()
  for (const w of await rt.store.jobs.list()) {
    if (!w.enabled || w.configError) continue
    if (rt.runQueue.some((q) => q.id === w.id)) continue // waiting already; keeps its slot
    const project = projects.find((p) => p.id === w.projectId) ?? null
    const d = decide({
      schedule: scheduleOf(w),
      lastRunStartedAt: w.lastRunStartedAt,
      now,
      tickMs: SCHEDULER_TICK_MS,
      running: rt.runningJobs.has(w.id),
      ready: jobReady(rt, w, project),
      catchUp: parseCatchUp(w.catchUpWindow, w.output),
    })
    if (d.action === 'idle') continue
    if (d.action === 'skip') {
      await recordSkip(rt, w, d.reason, d.slot, d.detail)
      continue
    }
    rt.runQueue.push({ id: w.id, trigger: d.trigger, slot: d.slot })
  }
  pumpRunQueue(rt)
}

/**
 * Queue a single job to run now (the per-job "Run" button. A manual run,
 * independent of the schedule). Respects the in-flight guard so a double-click
 * can't start two runs of the same job.
 */
export function enqueueJob(rt: WorkspaceRuntime, id: string): 'queued' | 'running' {
  if (rt.runningJobs.has(id)) return 'running'
  if (!rt.runQueue.some((q) => q.id === id)) rt.runQueue.push({ id, trigger: 'manual', slot: Date.now() })
  pumpRunQueue(rt)
  return 'queued'
}

function pumpRunQueue(rt: WorkspaceRuntime): void {
  // oldest slot first, as wakecron does; the rest keep their slot for later
  rt.runQueue.sort((a, b) => a.slot - b.slot)
  while (rt.activeRuns < JOB_CONCURRENCY && rt.runQueue.length > 0) {
    const run = rt.runQueue.shift()!
    if (rt.runningJobs.has(run.id)) continue
    rt.runningJobs.add(run.id)
    rt.activeRuns += 1
    // The due rule's clock moves when the run starts, now, not after the
    // jitter, so a tick in between can't see a stale slot and skip it.
    const startedAt = Date.now()
    const runId = randomUUID()
    void rt.store.jobs.markRunStarted(run.id, { startedAt, trigger: run.trigger })
    void ledger(rt, rt.store.jobRuns.insert({ id: runId, jobId: run.id, slot: run.slot, trigger: run.trigger, status: 'running', startedAt }))
    const jitter = run.trigger === 'manual' ? 0 : Math.floor(Math.random() * 3_000)
    // Keep the Mac awake while the run is out: one that starts on a DarkWake
    // otherwise freezes when the Mac sleeps again seconds later.
    const letGo = power.hold(`job ${run.id}`)
    // The run's slot is freed exactly once: when it settles, or by the
    // watchdog if it hangs past its timeout, else every later slot of this
    // job would skip as overlap until a restart.
    let released = false
    let dog: NodeJS.Timeout | undefined
    let stopRun: (() => void) | undefined
    const release = () => {
      if (released) return
      released = true
      clearTimeout(dog)
      letGo()
      rt.activeRuns -= 1
      rt.runningJobs.delete(run.id)
      pumpRunQueue(rt)
    }
    const arm = (timeoutMs: number) => {
      clearTimeout(dog)
      dog = setTimeout(() => {
        if (released) return
        const reason = `watchdog: still running ${humanSpan(Date.now() - startedAt)} after start, past its ${humanSpan(timeoutMs)} timeout`
        log('error', 'job', `${reason} — stopping it and freeing its slot`, { jobId: run.id, workspace: rt.meta.id })
        // Abort the run (the SDK closes its subprocess) and stop waiting on its stream.
        stopRun?.()
        const end = settleRunStatus('interrupted', sleepWatch.sleptBetween(startedAt, Date.now()), reason)
        void ledger(rt, rt.store.jobRuns.finish(run.id, run.slot, { status: end.status, reason: end.error, endedAt: Date.now() }))
        release()
      }, Math.max(0, startedAt + timeoutMs + WATCHDOG_GRACE_MS - Date.now()))
    }
    // until runJob knows the job's own timeout, the longest one allowed
    arm(MAX_JOB_TIMEOUT_MS)
    setTimeout(() => {
      runJob(rt, run, startedAt, runId, arm, (stop) => (stopRun = stop))
        .catch(async (err) => {
          log('error', 'job', `run crashed: ${err}`, { workspace: rt.meta.id })
          // a no-op when runJob already closed the row
          await ledger(rt, rt.store.jobRuns.finish(run.id, run.slot, { status: 'failed', reason: `run crashed: ${err}`, endedAt: Date.now() }))
        })
        .finally(release)
    }, jitter)
  }
}
