/**
 * A thread job's run (mode: thread). The job is a standing message to one
 * agent, Junior by default: each run opens a thread from that agent's DM,
 * sends the job's instruction marked as a job run, and waits for the
 * thread's first turn. The thread is an ordinary chat (the agent's prompt,
 * tools and skills, the one send policy), so its reply reaches the DM like
 * any thread's (server/session/thread-report.ts). A reply of "Nothing new."
 * stays quiet and puts the thread away.
 *
 * The run's slot ends with that first turn: done, waiting on the user, or
 * stopped. A thread still open when the next slot comes skips that slot.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Job, JobRunStatus } from '../../core/job/types.js'
import type { Project } from '../../shared/protocol.js'
import type { UpsertOutcome } from '../../core/store/types.js'
import type { WorkItem, Provenance } from '../../core/work/types.js'
import { ASK_ORDER, type Ask } from '../../core/work/asks.js'
import { chatPermissionMode } from '../../core/actions/policy.js'
import { agentTitle } from '../../core/junior/agents.js'
import { dmKey, findDm } from '../../core/junior/dms.js'
import { describeCron } from '../../core/job/cron.js'
import { scheduleOf } from '../../core/job/schedule.js'
import { settleRunStatus } from '../../core/job/run-guard.js'
import { isNothingNew, jobThreadTitle, type JobRunMark } from '../../core/job/thread.js'
import { safeWhen } from '../../core/sources/slack.js'
import { chatAgentNamed } from '../chat-agents.js'
import { VERSION } from '../config.js'
import { errText } from '../errors.js'
import { errResult, okResult } from '../junior-mcp.js'
import { log } from '../log.js'
import { sleepWatch } from '../power.js'
import { createSession, getOrRevive } from '../session/sessions.js'
import { upsertItem } from '../settings-ops.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { broadcastSessionList, invalidateInbox } from '../ws/send.js'
import { ledger, type QueuedRun } from './queue.js'
import { identityFromUrl } from './scan-mcp.js'

/** How a thread's first turn ended, as the run hears it. */
export type JobThreadEnd =
  | { kind: 'done'; said: string; costUsd: number; overBudget: boolean }
  | { kind: 'blocked'; what: string }
  | { kind: 'ended'; error: string }

/** A thread job's run, waiting on its thread (rt.jobThreads, keyed by the thread's id). */
export type JobThreadWatch = {
  jobId: string
  /** the run's spend cap, set on the thread's subprocess at spawn */
  maxBudgetUsd?: number
  /** job_handled filed an item */
  filed: (outcome: UpsertOutcome) => void
  /** the first turn ended; called once, later calls are ignored */
  settle: (end: JobThreadEnd) => void
}

type Limits = { timeoutMs: number; maxBudgetUsd?: number }

/** The job's DM-side owner: its chat agent, or null for Junior. An owner gone since is an error, never Junior. */
async function ownerOf(rt: WorkspaceRuntime, job: Job) {
  if (!job.agent) return null
  const agent = await chatAgentNamed(rt, job.agent)
  if (!agent) throw new Error(`the agent "${job.agent}" is gone or no longer a chat agent — pick another owner for this job`)
  return agent
}

/** Is the thread a previous run opened still busy, or waiting on the user? */
function stillOpen(rt: WorkspaceRuntime, job: Job): boolean {
  const prev = job.lastRunSessionId ? rt.rows.get(job.lastRunSessionId) : undefined
  if (!prev || prev.kind !== 'chat' || prev.jobId !== job.id) return false
  const live = rt.live.get(prev.id)
  return !!live && (live.waiting || live.status === 'running' || live.status === 'starting')
}

export async function runJobThread(
  rt: WorkspaceRuntime,
  job: Job,
  run: QueuedRun,
  startedMs: number,
  limits: Limits,
  lateness: string | undefined,
  project: Project,
  onStop: (stop: () => void) => void,
  notify: (status: JobRunStatus, detail?: string) => void,
): Promise<void> {
  if (stillOpen(rt, job)) {
    const now = Date.now()
    const reason = 'the last run’s thread is still open'
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status: 'skipped', reason, sessionId: job.lastRunSessionId, endedAt: now }))
    await rt.store.jobs.recordRun(job.id, { lastRunAt: now, lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', trigger: run.trigger, sessionId: job.lastRunSessionId, error: `skipped: ${reason}` })
    log('info', 'job', `${job.title}: skipped, ${reason}`, { jobId: job.id, workspace: rt.meta.id })
    return
  }

  let status: JobRunStatus = 'failed'
  let error: string | undefined
  let note: string | undefined
  let costUsd: number | undefined
  let filed = 0
  let fresh = 0
  let threadId: string | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    const agent = await ownerOf(rt, job)
    // The owner's DM: the one it has, else a new one, as opening it from the sidebar would make.
    const dm =
      findDm(rt.rows.values(), dmKey(agent?.name)) ??
      (await createSession(rt, agentTitle(rt.persona.name, agent?.label), project.path, null, null, false, chatPermissionMode('claude'), {
        kind: 'dm',
        spawn: false,
        projectId: project.id,
        ...(agent ? { agent: agent.name } : {}),
      }))
    const at = Date.now()
    const thread = await createSession(rt, jobThreadTitle(job.title, at), project.path, job.model ?? null, null, false, chatPermissionMode('claude'), {
      spawn: false,
      projectId: project.id,
      startedBy: dm.id,
      ...(agent ? { agent: agent.name } : {}),
      jobId: job.id,
      runTrigger: run.trigger,
    })
    threadId = thread.id
    await rt.store.jobs.markRunStarted(job.id, { startedAt: startedMs, trigger: run.trigger, sessionId: thread.id })
    await ledger(rt, rt.store.jobRuns.attachSession(job.id, run.slot, thread.id))
    broadcastSessionList(rt)
    log('info', 'job', `run started: ${job.title} (${run.trigger}), thread ${thread.id} from ${agent?.label ?? rt.persona.name}'s DM`, { jobId: job.id, runId: thread.id, workspace: rt.meta.id })

    let settle: (end: JobThreadEnd) => void = () => {}
    const ended = new Promise<JobThreadEnd>((resolve) => {
      let done = false
      settle = (end) => {
        if (done) return
        done = true
        resolve(end)
      }
    })
    // Registered before the spawn: the thread's extras read the budget and the seen-list tools from it.
    rt.jobThreads.set(thread.id, {
      jobId: job.id,
      ...(limits.maxBudgetUsd != null ? { maxBudgetUsd: limits.maxBudgetUsd } : {}),
      filed: (o) => {
        filed += 1
        if (o === 'inserted') fresh += 1
      },
      settle,
    })
    const stop = (why: string) => {
      void rt.live.get(thread.id)?.interrupt().catch(() => {})
      settle({ kind: 'ended', error: why })
    }
    onStop(() => stop('stopped by the watchdog'))
    timer = setTimeout(() => stop('timed out'), limits.timeoutMs)

    const live = await getOrRevive(rt, thread.id)
    if (!live) throw new Error('the thread could not start')
    const mark: JobRunMark = {
      id: job.id,
      title: job.title,
      runAt: at,
      trigger: run.trigger,
      every: describeCron(scheduleOf(job)),
      ...(lateness ? { lateness } : {}),
    }
    // From the DM, so the reply reports up; marked a job run, so it never reads as the user's.
    live.sendUserMessage(job.instruction, undefined, undefined, { fromSession: dm.id, job: mark }).catch((err: unknown) => settle({ kind: 'ended', error: `could not send the job's message: ${errText(err)}` }))

    const end = await ended
    if (end.kind === 'done') {
      costUsd = end.costUsd
      if (end.overBudget) throw new Error(`budget cap reached ($${limits.maxBudgetUsd?.toFixed(2)})`)
      status = 'ok'
      note = isNothingNew(end.said) ? 'nothing new' : undefined
    } else if (end.kind === 'blocked') {
      status = 'ok'
      note = `waiting on you: ${end.what}`
    } else {
      status = end.error === 'timed out' ? 'timeout' : end.error.startsWith('stopped') ? 'interrupted' : 'failed'
      error = end.error
    }
  } catch (err) {
    error = errText(err)
  } finally {
    if (timer) clearTimeout(timer)
    if (threadId) rt.jobThreads.delete(threadId)
    if (status !== 'ok') ({ status, error } = settleRunStatus(status, sleepWatch.sleptBetween(startedMs, Date.now()), error))
    await rt.store.jobs.recordRun(job.id, {
      lastRunAt: Date.now(),
      lastRunTokens: 0,
      lastRunMatches: filed,
      lastRunNew: fresh,
      status,
      trigger: run.trigger,
      ...(threadId ? { sessionId: threadId } : {}),
      error,
    })
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status, reason: error ?? note, ...(threadId ? { sessionId: threadId } : {}), endedAt: Date.now(), costUsd }))
    if (threadId) {
      const row = rt.rows.get(threadId)
      if (row) {
        row.runStatus = status
        row.runMatches = filed
        row.runNew = fresh
        row.runCostUsd = costUsd
        row.runError = error
      }
      await rt.store.sessions.recordJobRun(threadId, { status, matches: filed, newCount: fresh, tokens: 0, costUsd, error })
    }
    log(
      status === 'ok' ? 'info' : 'error',
      'job',
      `run ${status}: ${job.title}${note ? ` — ${note}` : ''}${filed ? ` — ${fresh} new, ${filed - fresh} already filed` : ''}${costUsd != null ? `, $${costUsd.toFixed(2)}` : ''}${error ? ` — ${error}` : ''}`,
      { jobId: job.id, runId: threadId, status, trigger: run.trigger, durationMs: Date.now() - startedMs, workspace: rt.meta.id, ...(error ? { error } : {}) },
    )
    notify(status, status === 'ok' ? (note ?? 'replied') : error)
    if (filed) invalidateInbox(rt)
    broadcastSessionList(rt)
  }
}

/**
 * A thread job's seen list, as two tools on the thread: has an earlier run
 * handled this link, and mark it handled. Handled = a work item this job
 * filed (its `foundBy` names the job), so the list is the inbox itself:
 * de-duplicated by id, and visible to the user.
 */
export function makeJobThreadMcp(rt: WorkspaceRuntime, job: Job, threadId: string) {
  return createSdkMcpServer({
    name: 'job',
    version: VERSION,
    tools: [
      tool(
        'job_seen',
        `Has an earlier run of the job "${job.title}" already handled this link? Call before working one thing (a PR, an error, a thread).`,
        { url: z.string().describe('the link: a GitHub PR/issue URL, a Slack permalink, a Linear issue URL or key, or a web page URL') },
        async (args) => {
          const ident = identityFromUrl(args.url)
          if (!ident) return errResult('url must be a GitHub PR/issue URL, a Slack permalink, a Linear issue URL or key, or a web page URL')
          const item = await rt.store.items.get(ident.id).catch(() => null)
          const by = item?.foundBy?.filter((p) => p.jobId === job.id) ?? []
          if (!by.length) return okResult(`not handled yet: ${ident.id}`)
          const last = by.reduce((a, b) => (b.at > a.at ? b : a))
          return okResult(`already handled by an earlier run (${new Date(last.at).toISOString()}${last.why ? `: ${last.why}` : ''}). Skip it unless it changed since.`)
        },
      ),
      tool(
        'job_handled',
        `Mark one thing handled by this run of "${job.title}", so later runs skip it. It is filed as a work item for the user, with your one-line outcome.`,
        {
          url: z.string().describe('the link you handled'),
          title: z.string().describe('a one-line summary of the thing'),
          outcome: z.string().describe('one line: what you found or did, e.g. "2 findings, safe to merge after the null check"'),
          ask: z.enum(ASK_ORDER as [Ask, ...Ask[]]).describe('what it asks of the user now: review, reply, decide, do, follow-up or read'),
          lastActivity: z.string().optional().describe('ISO 8601 timestamp of its newest activity'),
        },
        async (args) => {
          try {
            const ident = identityFromUrl(args.url)
            if (!ident) return errResult('url must be a GitHub PR/issue URL, a Slack permalink, a Linear issue URL or key, or a web page URL')
            const now = Date.now()
            const when = safeWhen(args.lastActivity ?? '', now)
            const item: WorkItem = {
              id: ident.id,
              source: ident.source,
              kind: 'job-hit',
              title: args.title,
              url: ident.url,
              repo: ident.home,
              author: '',
              peopleWaiting: 0,
              createdAt: when,
              updatedAt: when,
              ask: args.ask,
              reason: 'found',
            }
            const prov: Provenance = { jobId: job.id, runId: threadId, at: now, why: args.outcome }
            const { outcome } = await upsertItem(rt, item, prov)
            rt.jobThreads.get(threadId)?.filed(outcome)
            invalidateInbox(rt)
            log('info', 'job', `handled (${outcome}): ${args.title}`, { id: item.id, jobId: job.id, runId: threadId, workspace: rt.meta.id })
            return okResult(outcome === 'inserted' ? `filed: ${item.id}` : `noted again: ${item.id}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}
