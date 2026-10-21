import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Job, JobRunStatus } from '../../core/job/types.js'
import { log } from '../log.js'
import { budgetFor, describeLateness, humanSpan, localMidnight, missedSlots, scheduleOf } from '../../core/job/schedule.js'
import { grantLabel } from '../../core/job/tools.js'
import type { SessionEvent } from '../../shared/protocol.js'
import { HardStop, settleRunStatus, untilStopped } from '../../core/goals/run-guard.js'
import { sleepWatch } from '../power.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { ledger, type QueuedRun, RUN_KILL_GRACE_MS } from './queue.js'
import { jobLimits, jobProject, jobQuery, noConnectorError } from './preview.js'
import { broadcast, broadcastSessionList, invalidateInbox } from '../ws/send.js'
import { noteActionEvent } from '../session/actions-record.js'
import { makeScanMcp } from './scan-mcp.js'
import { holdIfAction } from '../session/actions-hold.js'
import { deliverPendingSendBacks } from '../session/actions-send.js'
import { syncInbox } from '../inbox/sync.js'

/** A macOS notification about a finished run, per the job's notify setting. */
function notifyRun(rt: WorkspaceRuntime, w: Job, status: JobRunStatus, detail?: string): void {
  if (process.platform !== 'darwin' || w.notify === 'never') return
  const failed = status === 'failed' || status === 'timeout'
  if (w.notify === 'on_failure' && !failed) return
  if (!failed && status !== 'ok') return
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const text = failed ? `${w.title} ${status === 'timeout' ? 'timed out' : 'failed'}${detail ? `: ${detail.slice(0, 120)}` : ''}` : `${w.title}: ${detail ?? 'ok'}`
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q('triage')}`], (err) => {
    if (err) log('warn', 'job', `notification failed: ${err.message}`, { jobId: w.id, workspace: rt.meta.id })
  })
}

/**
 * Run one job to completion as a headless session. Persists the transcript to
 * the event log (so it is observable like any session) and records the run's
 * receipt on the job row and its own session row. Stateless: nothing from this run feeds the next one's prompt.
 */
export async function runJob(
  rt: WorkspaceRuntime,
  run: QueuedRun,
  startedMs: number,
  runId: string,
  armWatchdog: (timeoutMs: number) => void = () => {},
  onStop: (stop: () => void) => void = () => {},
): Promise<void> {
  const job = await rt.store.jobs.get(run.id)
  if (!job) {
    await ledger(rt, rt.store.jobRuns.finish(run.id, run.slot, { status: 'skipped', reason: 'the job was removed', endedAt: Date.now() }))
    return
  }
  // A catch-up run stands in for every slot it slept through: each gets a
  // `missed` row pointing at this run, so the gap shows in the ledger.
  // It is also told how late it is, so it covers the gap and skips what's stale.
  let lateness: string | undefined
  if (run.trigger === 'catch_up') {
    const missed = missedSlots(scheduleOf(job), run.slot, startedMs)
    if (missed.length) await ledger(rt, rt.store.jobRuns.insertMissed(job.id, missed, runId, startedMs))
    lateness = describeLateness(run.slot, missed, startedMs) ?? undefined
  }
  // The daily budget: over it, the slot is a `skipped_budget` row and no run;
  // under it, this run may spend at most what is left of the day.
  const limits = await jobLimits(rt, job)
  const spent = job.dailyBudgetUsd != null ? await rt.store.jobRuns.spentSince(job.id, localMidnight(startedMs)) : 0
  const budget = budgetFor(limits.maxBudgetUsd, job.dailyBudgetUsd, spent)
  if (budget.skip) {
    const now = Date.now()
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status: 'skipped_budget', reason: budget.reason, endedAt: now }))
    await rt.store.jobs.recordRun(job.id, { lastRunAt: now, lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', trigger: run.trigger, error: `skipped (budget): ${budget.reason}` })
    log('warn', 'job', `${job.title}: skipped, ${budget.reason}`, { jobId: job.id, workspace: rt.meta.id })
    return
  }
  const runLimits = { timeoutMs: limits.timeoutMs, ...(budget.maxBudgetUsd != null ? { maxBudgetUsd: budget.maxBudgetUsd } : {}) }
  armWatchdog(runLimits.timeoutMs)
  const projectRow = (await rt.store.projects.list()).find((p) => p.id === job.projectId) ?? null
  if (!projectRow) {
    // The project went away: pause with a config error, never fall back to another folder.
    await rt.store.jobs.patchState(job.id, { enabled: false, configError: 'project removed — pick another project for this job' })
    await rt.store.jobs.recordRun(job.id, { lastRunAt: Date.now(), lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', trigger: run.trigger, error: 'skipped: the job has no project' })
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status: 'skipped', reason: 'the job has no project', endedAt: Date.now() }))
    log('warn', 'job', `paused ${job.title}: its project was removed`, { jobId: job.id, workspace: rt.meta.id })
    return
  }
  const session = await rt.store.sessions.create({
    id: randomUUID(),
    title: `Job · ${job.title}`,
    cwd: projectRow.path,
    projectId: projectRow.id,
    kind: 'job-run',
    jobId: job.id,
    runTrigger: run.trigger,
  })
  rt.rows.set(session.id, session)
  await rt.store.jobs.markRunStarted(job.id, { startedAt: startedMs, trigger: run.trigger, sessionId: session.id })
  await ledger(rt, rt.store.jobRuns.attachSession(job.id, run.slot, session.id))
  broadcastSessionList(rt)
  log('info', 'job', `run started: ${job.title} (${run.trigger})`, { jobId: job.id, runId: session.id, tools: job.tools.map(grantLabel), project: projectRow.name, model: job.model, workspace: rt.meta.id })

  let seq = 0
  const emit = (event: SessionEvent, persist = true) => {
    if (persist) {
      seq += 1
      rt.store.events.append(session.id, seq, event).catch(() => {})
      noteActionEvent(rt, session, event)
    }
    broadcast(rt, { type: 'session_event', sessionId: session.id, event })
  }

  let matches = 0
  let newCount = 0
  let tokens = 0
  let costUsd: number | undefined
  let status: JobRunStatus = 'failed'
  let error: string | undefined
  let timedOut = false
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  // The hard stop: the loop below stops waiting on the run's stream, so a run
  // past its timeout is always recorded, even when the stream never closes.
  let hardStop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => (hardStop = resolve))
  onStop(() => {
    abort.abort()
    hardStop()
  })
  const scanMcp = makeScanMcp(rt, job, session.id, (outcome) => {
    matches += 1
    if (outcome === 'inserted') newCount += 1
  })

  try {
    const project = await jobProject(rt, job.projectId)
    timer = setTimeout(() => {
      timedOut = true
      // The SDK closes the subprocess on abort (stdin EOF, then a kill); a
      // stream still open past the grace is let go.
      abort.abort()
      killTimer = setTimeout(hardStop, RUN_KILL_GRACE_MS)
    }, runLimits.timeoutMs)
    const runSpec = await jobQuery(
      rt,
      { instruction: job.instruction, tools: job.tools, project, model: job.model, output: job.output, schedule: scheduleOf(job), scope: job.scope, lateness, skills: job.skills, agents: job.agents, filing: job.filing },
      scanMcp,
      abort,
      runLimits,
    )
    // Past the fence, an outbound connector call is held for you, not run
    // (core/actions/queue.ts). Dry runs (previews) never hold: they record nothing.
    const fence = runSpec.veto
    if (fence) {
      runSpec.veto = async (toolName, input, ctx) => {
        const d = await fence(toolName, input, ctx)
        return d.allow ? holdIfAction(rt, session, toolName, input, ctx) : d
      }
    }
    const q = rt.provider.run(runSpec)
    let sawResult = false
    let resultText = ''
    let overBudget = false
    for await (const ev of untilStopped(q, stopped)) {
      if (ev.kind === 'started' && ev.sessionId) {
        session.sdkSessionId = ev.sessionId
        rt.store.sessions.setSdkSessionId(session.id, ev.sessionId).catch(() => {})
      }
      emit({ kind: 'sdk', message: ev.record }, ev.kind !== 'stream')
      if (ev.kind === 'result') {
        sawResult = true
        resultText = ev.text
        overBudget = ev.overBudget
        tokens = ev.tokens
        if (ev.costUsd != null) costUsd = ev.costUsd
      }
    }
    if (overBudget) throw new Error(`budget cap reached ($${runLimits.maxBudgetUsd?.toFixed(2)})`)
    if (resultText.includes('no-connector-tools') || resultText.includes('no-slack-tools')) throw new Error(noConnectorError(job.tools))
    if (!sawResult) throw new Error('scan ended without a result')
    status = 'ok'
  } catch (err) {
    if (timedOut) {
      status = 'timeout'
      error = `timed out after ${humanSpan((await jobLimits(rt, job)).timeoutMs)}${err instanceof HardStop ? ', and stopped' : ''}`
    } else if (err instanceof HardStop) {
      status = 'interrupted'
      error = 'stopped by the watchdog'
    } else {
      error = err instanceof Error ? err.message : String(err)
    }
    // A run the Mac slept through is `slept`, not a failure of the job.
    ;({ status, error } = settleRunStatus(status, sleepWatch.sleptBetween(startedMs, Date.now()), error))
    emit({ kind: 'error', message: error ?? status })
  } finally {
    if (timer) clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    await rt.store.jobs.recordRun(job.id, {
      lastRunAt: Date.now(),
      lastRunTokens: tokens,
      lastRunMatches: matches,
      lastRunNew: newCount,
      status,
      trigger: run.trigger,
      sessionId: session.id,
      error,
    })
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status, reason: error, sessionId: session.id, endedAt: Date.now(), costUsd }))
    // the run's own receipt, on its session row, powers the Activity view
    session.runStatus = status
    session.runMatches = matches
    session.runNew = newCount
    session.runTokens = tokens
    session.runCostUsd = costUsd
    session.runError = error
    session.updatedAt = Date.now()
    await rt.store.sessions.recordJobRun(session.id, { status, matches, newCount, tokens, costUsd, error })
    log(
      status === 'ok' ? 'info' : 'error',
      'job',
      `run ${status}: ${job.title}${status === 'ok' ? ` — ${newCount} new, ${matches - newCount} already filed, ${Math.round(tokens / 1000)}k tok${costUsd != null ? `, $${costUsd.toFixed(2)}` : ''}` : ''}${error ? ` — ${error}` : ''}`,
      { jobId: job.id, runId: session.id, status, trigger: run.trigger, matches, newCount, tokens, durationMs: Date.now() - startedMs, workspace: rt.meta.id, ...(error ? { error } : {}) },
    )
    rt.actionTrackers.delete(session.id)
    // Notes on an action sent back while the run was still going reach it now.
    void deliverPendingSendBacks(rt, session.id)
    notifyRun(rt, job, status, status === 'ok' ? `${newCount} new` : error)
    if (status === 'ok') {
      invalidateInbox(rt)
      void syncInbox(rt)
    }
    broadcastSessionList(rt)
  }
}

/**
 * Boot: a job run still without a final status died with the previous
 * process. Mark it interrupted, on its session and, when it was the job's
 * latest run, on the job, instead of leaving it "running" forever. No
 * retry: the next run's look-back window overlaps the lost one.
 */
export async function markInterruptedRuns(rt: WorkspaceRuntime): Promise<void> {
  const error = 'interrupted: triage stopped during the run'
  await ledger(rt, rt.store.jobRuns.sweepInterrupted(Date.now(), error))
  for (const row of rt.rows.values()) {
    if (row.kind !== 'job-run' || row.runStatus) continue
    const events = await rt.store.events.read(row.id)
    const seq = events.length ? events[events.length - 1].seq : 0
    await rt.store.events.append(row.id, seq + 1, { kind: 'error', message: error })
    await rt.store.sessions.recordJobRun(row.id, { status: 'interrupted', matches: row.runMatches ?? 0, tokens: row.runTokens ?? 0, error })
    row.runStatus = 'interrupted'
    row.runError = error
    const w = row.jobId ? await rt.store.jobs.get(row.jobId) : null
    if (w && w.lastRunSessionId === row.id) {
      await rt.store.jobs.recordRun(w.id, { lastRunAt: row.updatedAt, lastRunTokens: 0, lastRunMatches: 0, status: 'interrupted', sessionId: row.id, error })
    }
    log('warn', 'job', `marked interrupted: ${row.title}`, { runId: row.id, jobId: row.jobId, workspace: rt.meta.id })
  }
}
