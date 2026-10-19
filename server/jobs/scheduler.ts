import type { Job } from '../../core/job/types.js'
import { isOverdue, scheduleOf } from '../../core/job/schedule.js'
import { dbFileFor } from '../workspaces.js'
import type { SystemStatus } from '../../shared/protocol.js'
import { launchAgentInstalled } from '../launchd.js'
import { logFilePath } from '../log.js'
import { registry, WorkspaceRuntime } from '../workspace/runtime.js'
import { BUILD, PORT, SERVER_STARTED, VERSION } from '../config.js'
import { slackConnected } from '../inbox/sync.js'
import { lastSchedulerTickAt } from '../ticks.js'
import { jobsEnabled } from '../settings-ops.js'

export const SCHEDULER_TICK_MS = 60_000

// Job runs (.docs/jobs-v2.md): one run per job, each a real session so
// its transcript is the run's receipt. A small queue caps concurrency and
// jitters starts so the top of the hour doesn't stampede; a per-job in-flight
// guard turns "already running" into a recorded 'skipped', never a silent no-op.
// The output contract is TOOL CALLS: the run gets a permalink-shaped
// upsert_work_item that stamps identity, kind, and provenance, so a work item
// exists because a tool call created it. No JSON parsing, no cursor-advance-on-
// garbled-output bug. Cursors advance only on a successful run.
/** Which jobs are overdue: no `ok` ledger row within grace (isOverdue). */
export async function overdueJobs(rt: WorkspaceRuntime, jobs: Job[], now: number): Promise<Set<string>> {
  const lastOk = await rt.store.jobRuns.lastOkAt().catch(() => new Map<string, number>())
  return new Set(jobs.filter((w) => isOverdue(scheduleOf(w), w, lastOk.get(w.id), now)).map((w) => w.id))
}

/** The daemon's live status for one workspace, for the System modal. */
export async function systemStatus(rt: WorkspaceRuntime): Promise<SystemStatus> {
  const now = Date.now()
  const jobs = await rt.store.jobs.list()
  const enabled = jobs.filter((w) => w.enabled)
  return {
    version: VERSION,
    build: BUILD,
    startedAt: SERVER_STARTED,
    uptimeMs: now - SERVER_STARTED,
    port: PORT,
    workspace: rt.meta.name,
    db: dbFileFor(rt.meta.id, registry.defaultId),
    liveSessions: rt.live.size,
    slackConnected: slackConnected(rt),
    connectorsProbedAt: rt.connectorCache?.probedAt ?? null,
    connectorCount: rt.connectorCache?.connectors.length ?? null,
    schedulerLastTickAt: lastSchedulerTickAt,
    runningJobs: rt.runningJobs.size,
    jobsEnabled: await jobsEnabled(rt),
    inboxSyncedAt: rt.inboxCache?.syncedAt ?? null,
    githubReconcileAt: rt.githubReconcileAt || null,
    githubNotice: rt.githubNotice,
    jobs: {
      total: jobs.length,
      enabled: enabled.length,
      overdue: (await overdueJobs(rt, enabled, now)).size,
      failing: enabled.filter((w) => w.lastRunStatus === 'failed' || w.lastRunStatus === 'timeout').length,
      configErrors: jobs.filter((w) => w.configError).length,
    },
    launchAgent: launchAgentInstalled(),
    logDir: logFilePath(),
  }
}
