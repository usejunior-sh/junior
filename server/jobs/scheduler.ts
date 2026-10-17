import type { Job } from '../../core/job/types.js'
import { isOverdue, scheduleOf } from '../../core/job/schedule.js'
import { claude } from '../providers/claude.js'
import { dbFileFor, envOverridesFor, loadRegistry } from '../workspaces.js'
import type { SystemStatus } from '../../shared/protocol.js'
import { launchAgentInstalled } from '../launchd.js'
import { logFilePath } from '../log.js'
import { registry, WorkspaceRuntime } from '../workspace/runtime.js'
import { BUILD, PORT, SERVER_STARTED, VERSION } from '../config.js'
import { slackConnected } from '../inbox/sync.js'
import { lastSchedulerTickAt } from '../ticks.js'
import { jobsEnabled } from '../settings-ops.js'

export const SCHEDULER_TICK_MS = 60_000

// ---------------------------------------------------------------------------
// Job runs (.docs/jobs-v2.md): one run per job, each a real session so
// its transcript is the run's receipt. A small queue caps concurrency and
// jitters starts so the top of the hour doesn't stampede; a per-job in-flight
// guard turns "already running" into a recorded 'skipped', never a silent no-op.
// The output contract is TOOL CALLS: the run gets a permalink-shaped
// upsert_work_item that stamps identity, kind, and provenance, so a work item
// exists because a tool call created it — no JSON parsing, no cursor-advance-on-
// garbled-output bug. Cursors advance only on a successful run.
// ---------------------------------------------------------------------------
/** Which jobs are overdue — no `ok` ledger row within grace (isOverdue). */
export async function overdueJobs(rt: WorkspaceRuntime, jobs: Job[], now: number): Promise<Set<string>> {
  const lastOk = await rt.store.jobRuns.lastOkAt().catch(() => new Map<string, number>())
  return new Set(jobs.filter((w) => isOverdue(scheduleOf(w), w, lastOk.get(w.id), now)).map((w) => w.id))
}

/** The daemon's live status for one workspace, for the System modal. */
/**
 * Where Claude Code keeps its transcripts. The user's own `~/.claude` (or
 * whatever `CLAUDE_CONFIG_DIR` points at), plus the private config dir of
 * every Claude workspace on the `config-dir` auth backend — those sessions are
 * the user's spend too, and they log somewhere else. Claude's only: the usage
 * ledger reads Claude Code's transcript format.
 */
export function claudeProjectRoots(): string[] {
  const roots = new Set<string>()
  roots.add(claude.discovery.transcriptDir(undefined))
  for (const ws of loadRegistry().workspaces) {
    if (ws.provider === 'claude' && ws.authBackend === 'config-dir') roots.add(claude.discovery.transcriptDir(envOverridesFor(ws)))
  }
  return [...roots]
}

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
