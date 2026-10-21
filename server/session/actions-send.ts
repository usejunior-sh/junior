import { mkdtemp, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ActionRecord } from '../../core/actions/types.js'
import { canonJson, connectorState, dispatchDisallowed, DispatchFence, dispatchOutcome, dispatchPrompt, type DispatchTrace, dueToExpire, dueToSend, move, sendBackMessage, settledMessage, TOOL_SEARCH } from '../../core/actions/queue.js'
import { log } from '../log.js'
import { shortActionId } from '../../core/actions/view.js'
import type { StoredSession } from '../../core/store/types.js'
import { budgetFor, humanSpan, localMidnight, scheduleOf } from '../../core/job/schedule.js'
import type { JobRunStatus } from '../../core/job/types.js'
import { frameTeamMessage } from '../teams.js'
import type { AgentCan, SessionEvent } from '../../shared/protocol.js'
import type { McpServers } from '../providers/types.js'
import { serverOf } from '../../core/actions/sort.js'
import { resultText } from '../../core/actions/link.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { errText } from '../errors.js'
import { armDispatch, disarmDispatch, DISPATCH_MODEL, DISPATCH_TIMEOUT_MS, holdIfAction, isTeamWorker, moveAction, onActionChain } from './actions-hold.js'
import { getOrRevive } from './sessions.js'
import { actionsChanged, noteActionEvent } from './actions-record.js'
import { folderMcpServers, jobLimits, jobProject, jobQuery } from '../jobs/preview.js'
import { ledger } from '../jobs/queue.js'
import { makeScanMcp } from '../jobs/scan-mcp.js'
import { broadcast, broadcastSessionList, invalidateInbox } from '../ws/send.js'
import { teamRunOf, workerSpec } from '../team-run/state.js'

/**
 * Send-back notes to the session that drafted the action, under exactly the
 * constraints it drafted under, never more:
 * - a job run: a headless continuation of its own Claude session (resume),
 *   built by jobQuery like the run itself, the same grants, the same
 *   fence, the hold wrap, so the redraft is held for approval again and can
 *   do nothing the job couldn't. One still running gets them when it ends.
 * - a team worker: revived as a worker (its tools, its permission mode, the
 *   hold veto), only while its run is still known; otherwise not at all.
 * Whatever happens is kept on the record, so the card can say whether they arrived.
 */
export async function deliverSendBack(rt: WorkspaceRuntime, rec: ActionRecord): Promise<void> {
  const row = rt.rows.get(rec.sessionId)
  const text = sendBackMessage(rec.id, rec.tool, rec.queue?.note ?? '')
  let delivery: string | null
  if (!row) delivery = 'not delivered: the session that drafted it was deleted'
  else if (row.provider !== 'claude') delivery = 'not delivered: that session runs on another agent'
  else if (row.kind === 'job-run') {
    if (!row.runStatus) delivery = null // still running: on its way at the end
    else if (!row.sdkSessionId) delivery = 'not delivered: the run never started an agent to resume'
    else {
      try {
        await continueJobRun(rt, row, text, () => void recordDelivery(rt, rec, 'delivered'))
        return
      } catch (err) {
        delivery = `not delivered: ${errText(err)}`
      }
    }
  } else if (rec.teamRunId && !isTeamWorker(rt, row.id)) {
    delivery = 'not delivered: its team run is over, so its worker can no longer be resumed under the run’s constraints'
  } else if (!row.sdkSessionId && !rt.live.has(row.id)) delivery = 'not delivered: the session never started, so there is nothing to resume'
  else {
    try {
      const live = await getOrRevive(rt, row.id)
      if (!live) delivery = 'not delivered: the session could not be resumed (its folder is gone)'
      else {
        await live.sendUserMessage(text, undefined, undefined, { from: 'triage' })
        delivery = 'delivered'
      }
    } catch (err) {
      delivery = `not delivered: ${errText(err)}`
    }
  }
  if (delivery !== null) await recordDelivery(rt, rec, delivery)
}

/**
 * A chat's approved action settled: tell the chat, so Junior carries on with
 * the link in hand instead of waiting on a send it can't see. Chats only: a
 * job run or a task has ended by now, and a team hands its work in.
 */
async function tellChat(rt: WorkspaceRuntime, rec: ActionRecord): Promise<void> {
  const row = rt.rows.get(rec.sessionId)
  if (!row || row.kind !== 'chat' || row.provider !== 'claude' || rec.teamRunId) return
  if (!row.sdkSessionId && !rt.live.has(row.id)) return
  try {
    const live = await getOrRevive(rt, row.id)
    await live?.sendUserMessage(settledMessage(rec), undefined, undefined, { from: 'triage' })
  } catch (err) {
    log('warn', 'actions', `could not tell the chat #${shortActionId(rec.id)} settled: ${errText(err)}`, { action: rec.id, session: row.id, workspace: rt.meta.id })
  }
}

/** Keep on a sent-back record whether its notes reached the session (once. A later word doesn't overwrite "delivered"). */
async function recordDelivery(rt: WorkspaceRuntime, rec: ActionRecord, delivery: string): Promise<void> {
  await onActionChain(rt, async () => {
    const cur = await rt.store.actions.get(rec.id)
    if (!cur?.queue || cur.status !== 'sent_back' || cur.queue.delivery === 'delivered') return
    await rt.store.actions.put({ ...cur, queue: { ...cur.queue, delivery }, updatedAt: Math.max(cur.updatedAt, Date.now()) })
    await rt.store.actions.addHistory({
      actionId: cur.id,
      at: Date.now(),
      actor: 'triage',
      event: delivery === 'delivered' ? 'notes delivered' : 'notes not delivered',
      from: 'sent_back',
      to: 'sent_back',
      note: delivery === 'delivered' ? null : delivery,
      args: null,
    })
  }).catch((err) => log('warn', 'actions', `could not record a send-back delivery: ${errText(err)}`, { action: rec.id, workspace: rt.meta.id }))
  actionsChanged(rt, new Set([rec.sessionId]))
  log(delivery === 'delivered' ? 'info' : 'warn', 'actions', `send back #${shortActionId(rec.id)}: ${delivery}`, { action: rec.id, session: rec.sessionId, workspace: rt.meta.id })
}

/** Job-run continuations in flight, by session: a second send-back waits for the first. */
const jobContinuations = new Map<string, Promise<void>>()

/**
 * Continue a finished job run's own Claude session with one message from
 * triage, headless, under the job's own run spec (jobQuery: grants,
 * allowlist, unattended, the fence) plus the hold. The same box the run had.
 * The transcript continues on its session row. `onStarted` fires once the
 * agent is up with the message.
 */
function continueJobRun(rt: WorkspaceRuntime, row: StoredSession, text: string, onStarted: () => void): Promise<void> {
  const key = `${rt.meta.id}:${row.id}`
  const prev = jobContinuations.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    const job = row.jobId ? await rt.store.jobs.get(row.jobId) : null
    if (!job) throw new Error('the job that drafted it was deleted')
    const project = await jobProject(rt, job.projectId)
    const limits = await jobLimits(rt, job)
    // A redraft is a job run like any other: it counts against the job's
    // daily budget and gets its own row in the run ledger (trigger `redraft`).
    const startedAt = Date.now()
    const slot = startedAt
    const spent = job.dailyBudgetUsd != null ? await rt.store.jobRuns.spentSince(job.id, localMidnight(startedAt)) : 0
    const budget = budgetFor(limits.maxBudgetUsd, job.dailyBudgetUsd, spent)
    if (budget.skip) {
      await ledger(rt, rt.store.jobRuns.insert({ jobId: job.id, slot, trigger: 'redraft', status: 'skipped_budget', reason: budget.reason, sessionId: row.id, startedAt, endedAt: startedAt }))
      throw new Error(`the job is over its daily budget (${budget.reason}) — the notes stay here`)
    }
    await ledger(rt, rt.store.jobRuns.insert({ jobId: job.id, slot, trigger: 'redraft', status: 'running', sessionId: row.id, startedAt }))
    let status: JobRunStatus = 'failed'
    let reason: string | undefined
    let costUsd: number | undefined
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), limits.timeoutMs)
    const scanMcp = makeScanMcp(rt, job, row.id, () => {})
    try {
      const spec = await jobQuery(
        rt,
        { instruction: job.instruction, tools: job.tools, project, model: job.model, output: job.output, schedule: scheduleOf(job), scope: job.scope, skills: job.skills, agents: job.agents },
        scanMcp,
        abort,
        budget.maxBudgetUsd != null ? { maxBudgetUsd: budget.maxBudgetUsd } : {},
      )
      const fence = spec.veto
      if (!fence) throw new Error('no fence for this job run')
      spec.veto = async (toolName, input, ctx) => {
        const d = await fence(toolName, input, ctx)
        return d.allow ? holdIfAction(rt, row, toolName, input, ctx) : d
      }
      spec.prompt = frameTeamMessage('triage', text)
      spec.resume = row.sdkSessionId ?? undefined
      let seq = await rt.store.events.lastSeq(row.id)
      const emit = (event: SessionEvent, persist = true) => {
        if (persist) {
          seq += 1
          rt.store.events.append(row.id, seq, event).catch(() => {})
          noteActionEvent(rt, row, event)
        }
        broadcast(rt, { type: 'session_event', sessionId: row.id, event, at: Date.now() })
      }
      emit({ kind: 'local_user', text, from: 'triage' })
      let started = false
      try {
        for await (const ev of rt.provider.run(spec)) {
          if (ev.kind === 'started') {
            if (!started) onStarted()
            started = true
            if (ev.sessionId && ev.sessionId !== row.sdkSessionId) {
              row.sdkSessionId = ev.sessionId
              rt.store.sessions.setSdkSessionId(row.id, ev.sessionId).catch(() => {})
            }
          }
          emit({ kind: 'sdk', message: ev.record }, ev.kind !== 'stream')
          if (ev.kind === 'result' && ev.costUsd != null) costUsd = ev.costUsd
        }
        if (!started) throw new Error('the run ended before it started')
        status = 'ok'
      } catch (err) {
        status = abort.signal.aborted ? 'timeout' : 'failed'
        reason = abort.signal.aborted ? `the redraft timed out after ${humanSpan(limits.timeoutMs)}` : errText(err)
        emit({ kind: 'error', message: reason })
        throw err
      }
      row.updatedAt = Date.now()
      void rt.store.sessions.touch(row.id)
      broadcastSessionList(rt)
    } finally {
      clearTimeout(timer)
      rt.actionTrackers.delete(row.id)
      await ledger(rt, rt.store.jobRuns.finish(job.id, slot, { status, ...(reason ? { reason } : {}), sessionId: row.id, endedAt: Date.now(), ...(costUsd != null ? { costUsd } : {}) }))
      log(status === 'ok' ? 'info' : 'warn', 'job', `redraft ${status}: ${job.title}${costUsd != null ? ` — $${costUsd.toFixed(2)}` : ''}${reason ? ` — ${reason}` : ''}`, {
        jobId: job.id,
        runId: row.id,
        trigger: 'redraft',
        workspace: rt.meta.id,
      })
    }
  })
  jobContinuations.set(key, run)
  void run.finally(() => {
    if (jobContinuations.get(key) === run) jobContinuations.delete(key)
  }).catch(() => {})
  return run
}

/** A job run just ended: notes sent back while it ran go to it now. */
export async function deliverPendingSendBacks(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const waiting = (await rt.store.actions.list({ sessionId, status: ['sent_back'], limit: 100 })).filter((a) => a.queue && a.queue.delivery === null)
  for (const a of waiting) await deliverSendBack(rt, a)
}

/**
 * Where a dispatch run gets its connector: the drafting session's folder, its
 * folder's own MCP server of that name (as a job run loads them, passed
 * explicitly, the project's settings and hooks never loaded), a team worker's
 * agent-declared server, and the user's own config (user-scope servers and
 * claude.ai connectors).
 */
async function dispatchOrigin(rt: WorkspaceRuntime, rec: ActionRecord): Promise<{ cwd: string; mcpServers: McpServers }> {
  const server = serverOf(rec.tool)
  const row = rt.rows.get(rec.sessionId)
  let cwd = row?.cwd ?? null
  if (rec.jobId) {
    const w = await rt.store.jobs.get(rec.jobId).catch(() => null)
    const project = w ? (await rt.store.projects.list()).find((p) => p.id === w.projectId) : undefined
    if (project) cwd = project.path
  }
  const isDir = !!cwd && (await stat(cwd).then((st) => st.isDirectory(), () => false))
  // A command runs where it was drafted, or not at all: `git push` from a temp folder pushes nothing it meant to.
  if (rec.tool === 'Bash') {
    if (!cwd || !isDir) throw new Error(`the folder it was drafted in is gone${cwd ? ` (${cwd})` : ''}`)
    return { cwd, mcpServers: {} }
  }
  if (!cwd || !isDir) cwd = await mkdtemp(path.join(os.tmpdir(), 'triage-dispatch-'))
  const servers: McpServers = {}
  const folder = await folderMcpServers(rt, cwd).catch(() => null)
  if (folder?.servers[server]) servers[server] = folder.servers[server]
  // A team worker's agent file may declare the server itself (extrasFor loads it the same way).
  const run = row ? teamRunOf(rt, row.id) : undefined
  const worker = run && row && run.leadSessionId !== row.id ? [...run.workers].reverse().find((w) => w.sessionId === row.id) : undefined
  if (run && worker) {
    const ext = rt.provider.agentTools(workerSpec(run, worker).can as AgentCan[]).mcpServers as McpServers | undefined
    if (ext?.[server]) servers[server] = ext[server]
  }
  return { cwd, mcpServers: servers }
}

/**
 * The one-tool run that sends an approved action. Headless, in the
 * workspace's auth; no built-in tools, the one connector tool allowed and
 * nothing else; the fence lets that call through only with the approved args,
 * once. Never throws: whatever happened is in the trace.
 */
async function runDispatch(rt: WorkspaceRuntime, rec: ActionRecord): Promise<{ trace: DispatchTrace; costUsd: number | null }> {
  const q = rec.queue!
  const fence = new DispatchFence(rec.tool, q.args)
  const trace: DispatchTrace = { allowed: false, connector: null }
  let costUsd: number | null = null
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), DISPATCH_TIMEOUT_MS)
  try {
    const origin = await dispatchOrigin(rt, rec)
    // Every other connector the user has: out of the run's context entirely (the fence would deny them anyway).
    const known = [...(rt.folderProbes.get(origin.cwd)?.connectors ?? []), ...(rt.connectorCache?.connectors ?? [])].map((c) => c.server)
    const disallowedTools = dispatchDisallowed([...known, ...Object.keys(origin.mcpServers)], rec.tool)
    const bash = rec.tool === 'Bash'
    const run = rt.provider.run({
      prompt: dispatchPrompt(rec.tool, q.args),
      cwd: origin.cwd,
      // The user's own MCP servers and claude.ai connectors; never the project's settings, skills or hooks.
      userConfig: true,
      // ToolSearch only: connector tools are deferred (claude.ai ones start pending), so the run loads the one it needs.
      // A held command needs only the shell.
      tools: bash ? ['Bash'] : [TOOL_SEARCH],
      allowedTools: bash ? ['Bash'] : [TOOL_SEARCH, rec.tool],
      ...(disallowedTools.length ? { disallowedTools } : {}),
      unattended: true,
      veto: (toolName, input, ctx) => fence.decide(toolName, input, ctx?.toolUseId),
      model: DISPATCH_MODEL,
      // ToolSearch, the call, the one-word reply.
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      mcpServers: origin.mcpServers,
      abort,
      ...(rt.env ? { env: rt.env } : {}),
    })
    for await (const ev of run) {
      if (ev.kind === 'started') trace.connector = connectorState(ev.record, rec.tool)
      if (ev.kind === 'message' && ev.role === 'user' && fence.allowed && !trace.result) {
        const blocks = Array.isArray(ev.record.message?.content) ? ev.record.message.content : []
        for (const b of blocks) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
          if (fence.allowedCall && b.tool_use_id !== fence.allowedCall) continue
          trace.result = { isError: b.is_error === true, text: resultText(b.content) }
          break
        }
      }
      if (ev.kind === 'result') {
        if (ev.costUsd != null) costUsd = ev.costUsd
        // The run's own word that it had no such tool, even after ToolSearch (the prompt asks it to say so).
        if (!fence.allowed && /\bno-tool\b/.test(ev.text)) trace.noTool = true
      }
    }
  } catch (err) {
    trace.runError = abort.signal.aborted ? `timed out after ${humanSpan(DISPATCH_TIMEOUT_MS)}` : errText(err)
  } finally {
    clearTimeout(timer)
  }
  trace.allowed = fence.allowed
  trace.denials = fence.denials
  return { trace, costUsd }
}

/**
 * Send one approved action whose time has come. Claimed first, one atomic
 * scheduled → sending update, so a timer and the minute tick racing for it
 * send it once; whoever loses does nothing.
 */
export async function dispatchAction(rt: WorkspaceRuntime, id: string): Promise<void> {
  disarmDispatch(rt, id)
  if (rt.dispatching.has(id)) return
  const now = Date.now()
  const claimed = await onActionChain(rt, async () => {
    const rec = await rt.store.actions.get(id)
    if (!rec || !dueToSend(rec, now)) return null
    const r = move(rec, { type: 'claim' }, now)
    if (!r.ok) return null
    if (!(await rt.store.actions.claim(id, 'scheduled', 'sending', now, { dueBy: now }))) return null
    await rt.store.actions.addHistory(r.entry)
    return r.next
  }).catch((err) => {
    log('warn', 'actions', `could not claim an action to send: ${errText(err)}`, { action: id, workspace: rt.meta.id })
    return null
  })
  if (!claimed) return
  rt.dispatching.add(id)
  actionsChanged(rt, new Set([claimed.sessionId]))
  log('info', 'actions', `sending: ${claimed.summary} (#${shortActionId(id)})`, { action: id, tool: claimed.tool, workspace: rt.meta.id })
  try {
    const { trace, costUsd } = await runDispatch(rt, claimed)
    const bash = claimed.tool === 'Bash'
    const out = dispatchOutcome(trace, bash ? 'Bash' : serverOf(claimed.tool), { bash, push: bash && claimed.kind === 'push' })
    const done = await moveAction(rt, id, { type: 'settle', status: out.status, link: out.link, error: out.error, costUsd })
    void tellChat(rt, done)
    log(out.status === 'succeeded' ? 'info' : 'warn', 'actions', `${out.status}: ${done.summary} (#${shortActionId(id)})${out.error ? ` — ${out.error}` : ''}`, {
      action: id,
      tool: claimed.tool,
      ...(costUsd != null ? { costUsd } : {}),
      workspace: rt.meta.id,
    })
  } catch (err) {
    // The run's own failures are in its trace; this is the record failing to settle. It may have gone out.
    log('error', 'actions', `dispatch of #${shortActionId(id)} ended badly: ${errText(err)}`, { action: id, workspace: rt.meta.id })
    await moveAction(rt, id, { type: 'settle', status: 'unknown', error: `triage lost track of the send: ${errText(err)} — check before retrying` }).catch(() => {})
  } finally {
    rt.dispatching.delete(id)
  }
}

/**
 * The minute tick's share: expire what waited too long, send what is due
 * (a timer lost to a restart), and re-arm timers for what is still ahead.
 */
export async function tickActions(rt: WorkspaceRuntime, now = Date.now()): Promise<void> {
  const open = await rt.store.actions.list({ status: ['needs_you', 'scheduled'], limit: 5000 })
  let expired = 0
  for (const a of open) {
    if (dueToExpire(a, now)) {
      await moveAction(rt, a.id, { type: 'expire' }, now).then(
        () => (expired += 1),
        () => {},
      )
    } else if (dueToSend(a, now)) void dispatchAction(rt, a.id)
    else if (a.status === 'scheduled' && !rt.actionTimers.has(a.id)) armDispatch(rt, a)
  }
  if (expired) {
    invalidateInbox(rt)
    log('info', 'actions', `expired ${expired} action(s) nobody answered`, { workspace: rt.meta.id })
  }
}

/**
 * Boot: an action left `sending` died with the previous process mid-send. It
 * may have gone out, so it is unknown, never retried by itself. Scheduled
 * ones get their timers back (or go now, if their time passed).
 */
export async function recoverActions(rt: WorkspaceRuntime): Promise<void> {
  const now = Date.now()
  for (const a of await rt.store.actions.list({ status: ['sending'], limit: 5000 })) {
    await onActionChain(rt, async () => {
      if (!(await rt.store.actions.claim(a.id, 'sending', 'unknown', now))) return
      const cur = await rt.store.actions.get(a.id)
      if (!cur) return
      const error = 'triage stopped while this was being sent — it may have gone out; check before retrying'
      await rt.store.actions.put({ ...cur, error, settledAt: now })
      await rt.store.actions.addHistory({ actionId: a.id, at: now, actor: 'triage', event: 'unknown', from: 'sending', to: 'unknown', note: error, args: null })
    }).catch((err) => log('warn', 'actions', `could not recover ${a.id}: ${errText(err)}`, { workspace: rt.meta.id }))
  }
  // Notes sent back to a job run that died before it ended never reached it: try now.
  for (const a of await rt.store.actions.list({ status: ['sent_back'], limit: 500 })) {
    if (a.queue && a.queue.delivery === null) void deliverSendBack(rt, a)
  }
  // The held-call map is memory: rebuild it, so an agent revived after a restart still hears the same id.
  for (const a of await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })) {
    if (a.queue) rt.heldCalls.set(`${a.sessionId}\u0000${a.tool}\u0000${canonJson(a.queue.args)}`, a.id)
  }
  await tickActions(rt, now)
}
