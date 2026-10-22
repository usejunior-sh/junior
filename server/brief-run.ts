import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { AgentCan, Artifact, BriefJob, BriefView } from '../shared/protocol.js'
import type { StoredSession } from '../core/store/types.js'
import { juniorSessionAppend } from '../shared/juniorContext.js'
import { runSpent, workerAppend } from '../core/teams/engine.js'
import { goalSessionMcpTools } from './goals.js'
import { workerAppend as goalWorkerAppend, LEAD_RUN_APPEND } from '../core/goals/run.js'
import { LEAD_DRAFT_APPEND } from '../core/goals/review.js'
import { BRIEF_SYSTEM_APPEND, briefRelPath, composeBriefPrompt, isPlaybookName, readPlaybook, seedDispatchTemplates, seedPlaybooks } from './briefs.js'
import { log } from './log.js'
import type { Job } from '../core/job/types.js'
import { itemImageAttachments } from './itemImages.js'
import { browserHub, browserMcpFor, WorkspaceRuntime } from './workspace/runtime.js'
import { broadcast, invalidateInbox } from './ws/send.js'
import { LiveSession, type SessionExtras } from './session/live-session.js'
import { TEAM_COMPACT_WINDOW, teamRunOf, workerSpec } from './team-run/state.js'
import { makeTeamMcp } from './team-run/mcp.js'
import { juniorAppend } from './junior-ops.js'
import { VERSION } from './config.js'
import { GOAL_RUN_DISALLOWED_TOOLS } from './goal-glue.js'
import { EDIT_TOOLS } from './session/changes.js'
import { errResult, okResult } from './junior-mcp.js'
import { errText } from './errors.js'
import { ANY_ITEM_ID_RE } from './validate.js'
import { createSession, getOrRevive } from './session/sessions.js'
import { BRIEF_TIMEOUT_MS, linkSessionToItem, projectFor, readSettings } from './settings-ops.js'
import { itemFilesForSession } from './items-ops.js'
import { ITEM_SYSTEM_APPEND, makeTaskMcp, REVIEW_SYSTEM_APPEND, TASK_SYSTEM_APPEND } from './tasks/runner.js'
import { READ_ONLY_STEPS } from '../core/playbooks/item.js'
import { REVIEW_STEP } from '../core/review/watch.js'

/** The artifact linked to an item as its brief, with the body on disk. */
export async function currentBrief(rt: WorkspaceRuntime, itemId: string): Promise<{ artifact: Artifact; body: string } | null> {
  const links = await rt.store.links.forTarget('item', itemId)
  const l = links.find((x) => x.fromKind === 'artifact' && x.role === 'brief')
  if (!l) return null
  const a = await rt.artifacts.read(l.fromId)
  return a ? { artifact: a.artifact, body: a.body } : null
}

export async function briefViewFor(rt: WorkspaceRuntime, itemId: string): Promise<BriefView> {
  const [job, item, cur, queued] = await Promise.all([
    rt.store.briefs.latestForItem(itemId),
    rt.store.items.get(itemId),
    currentBrief(rt, itemId),
    rt.store.briefs.list('queued'),
  ])
  const sourceMs = item ? Date.parse(item.updatedAt) : NaN
  // Stale is arithmetic, never a judgment: the source moved after the brief was written.
  const settled = !job || job.status === 'ready' || job.status === 'failed'
  const stale = !!cur && settled && Number.isFinite(sourceMs) && sourceMs > cur.artifact.updated
  const pos = job?.status === 'queued' ? queued.findIndex((q) => q.id === job.id) : -1
  return { job, stale, artifact: cur?.artifact ?? null, body: cur?.body ?? null, queuePosition: pos >= 0 ? pos : null }
}

const broadcastBrief = (rt: WorkspaceRuntime, job: BriefJob) => {
  broadcast(rt, { type: 'brief_status', job })
  // A brief moving moves the item's stage (briefing → ready).
  invalidateInbox(rt)
}

/**
 * Spawn-time extras by session kind. Every session gets the same thing first,
 * who it is inside Junior (shared/juniorContext.ts): the workspace, its own
 * junior session id, the artifacts folder. That is the layer that is knowable
 * at spawn and true for the session's whole life; what *exists* right now is a
 * tool call, never a prompt. Brief sessions get the headless contract and their
 * write tool on top.
 */
export async function extrasFor(rt: WorkspaceRuntime, row: StoredSession): Promise<SessionExtras> {
  const identity = juniorSessionAppend(row.kind, {
    sessionId: row.id,
    workspaceId: rt.meta.id,
    workspaceName: rt.meta.name,
    artifactsRoot: rt.artifacts.root,
    libraryRoot: rt.libraryDir,
    juniorName: rt.persona.name,
    ...(row.ultracode ? { ultracode: true } : {}),
  })
  const run = teamRunOf(rt, row.id)
  const worker = run && run.leadSessionId !== row.id ? [...run.workers].reverse().find((w) => w.sessionId === row.id) : undefined
  if (run && worker) {
    // Rebuilt per spawn like the brief server: one instance, one transport.
    const { agent, writes, can } = workerSpec(run, worker)
    const tools = rt.provider.agentTools(can as AgentCan[])
    // An agent allowed the browser gets the pane's own tools while Junior.app
    // hosts them; without the app it falls back to the user's chrome-devtools.
    const pane = (can as AgentCan[]).includes('browser') && browserHub.status.compatible
    if (pane) delete tools.mcpServers?.['chrome-devtools']
    const external = tools.mcpServers && Object.keys(tools.mcpServers).length ? tools.mcpServers : undefined
    return {
      systemAppend: `${identity}\n${workerAppend(run, worker, agent, writes)}`,
      mcp: { team: makeTeamMcp(rt, row.id), ...(pane ? { browser: browserMcpFor(rt, row) } : {}) },
      disallowedTools: tools.disallowedTools,
      // A worker loads only what its step needs: a short built-in list and
      // Junior's own servers (+ the browser if allowed), not every connector
      // and plugin in ~/.claude, whose schemas ride every call.
      tools: tools.tools,
      strictMcpConfig: true,
      ...(external ? { externalMcp: external } : {}),
      // Compact long before a 1M window would (it defaults to ~967K there): a
      // worker re-reads its whole history on every call, so history is cost.
      settings: { autoCompactWindow: TEAM_COMPACT_WINDOW },
      // What is left of the run's budget, so one runaway turn can't blow it.
      maxBudgetUsd: Math.max(0.25, run.budgetUsd - runSpent(run)),
    }
  }
  // A chat gets the browser pane's tools: with Junior.app closed they answer
  // "open Junior.app" rather than vanish, so a session never has to respawn.
  // It is one of Junior's chats, so it also gets the persona and today's plan.
  if (row.kind === 'chat') return { systemAppend: `${identity}${await juniorAppend(rt)}`, mcp: { browser: browserMcpFor(rt, row) } }
  // A goal run's session: its goal-bound tools, and its contract last.
  const goalRun = rt.goalRuns.get(row.id)
  if (goalRun) {
    const mcp = { goal: createSdkMcpServer({ name: 'goal', version: VERSION, alwaysLoad: true, tools: goalSessionMcpTools(rt.goalDeps, goalRun) }) }
    const spec = goalRun.spec
    if (spec.role === 'lead') return { systemAppend: `${identity}\n${LEAD_RUN_APPEND}`, mcp, disallowedTools: GOAL_RUN_DISALLOWED_TOOLS }
    return {
      systemAppend: `${identity}\n${goalWorkerAppend(goalRun.role, spec.writes, goalRun.agentPrompt)}\n\n${spec.context}`,
      mcp,
      disallowedTools: GOAL_RUN_DISALLOWED_TOOLS.filter((t) => spec.writes || !EDIT_TOOLS.has(t)),
    }
  }
  // A babysit task's session: its submit_task tool, its per-task budget, the headless contract last.
  const taskRun = rt.taskRuns.get(row.id)
  // Strict: none of ~/.claude's connectors and plugins, whose schemas would ride every call.
  if (taskRun) {
    const review = taskRun.step === REVIEW_STEP
    // A playbook task on an item that reads (answer, investigate, the plan) needs
    // the source's connector to read the thread or the issue: your connectors
    // load, and every send through them is refused (holdIfAction, read-only).
    if (taskRun.step && READ_ONLY_STEPS.includes(taskRun.step)) {
      return {
        systemAppend: `${identity}\n${ITEM_SYSTEM_APPEND}`,
        mcp: { task: makeTaskMcp(rt, row.id) },
        maxBudgetUsd: taskRun.perTaskUsd,
        disallowedTools: [...EDIT_TOOLS],
      }
    }
    return {
      systemAppend: `${identity}\n${review ? REVIEW_SYSTEM_APPEND : TASK_SYSTEM_APPEND}`,
      mcp: { task: makeTaskMcp(rt, row.id) },
      strictMcpConfig: true,
      maxBudgetUsd: taskRun.perTaskUsd,
      // A first pass reads; it never edits.
      ...(review ? { disallowedTools: [...EDIT_TOOLS] } : {}),
    }
  }
  // A goal's lead: the drafting contract last, like a brief's.
  if (row.kind === 'goal') return { systemAppend: `${identity}\n${LEAD_DRAFT_APPEND}` }
  if (row.kind !== 'brief') return { systemAppend: identity }
  let e = rt.briefExtras.get(row.id)
  if (!e) {
    // Identity first: the headless contract's "change nothing" must be the last
    // word a brief run reads, not something the identity block then softens.
    e = { systemAppend: `${identity}\n${BRIEF_SYSTEM_APPEND}` }
    rt.briefExtras.set(row.id, e)
  }
  // The server is rebuilt per spawn, never cached: one instance connects to one
  // transport, so a revived run handed the old object would lose write_brief.
  return { ...e, mcp: { brief: makeBriefMcp(rt, row.id) } }
}

/**
 * The brief session's one write: the server picks the file (one per item),
 * writes the frontmatter, commits, links it as the item's brief. Looks the
 * job up by session at call time, so the same server serves every run and
 * iteration in that session.
 */
function makeBriefMcp(rt: WorkspaceRuntime, sessionId: string) {
  return createSdkMcpServer({
    name: 'brief',
    version: VERSION,
    tools: [
      tool(
        'write_brief',
        'Save the brief for this work item. Call exactly once, with the WHOLE document (it replaces any previous brief). The server chooses the file and links it to the item.',
        {
          title: z.string().describe('a short title — the verdict or the one-line summary'),
          body: z.string().describe('the full markdown body'),
          refs: z.array(z.string()).optional().describe('PR/issue URLs or Linear keys the brief cites'),
        },
        async (args) => {
          try {
            // A run writes under its running job. After it, the user may open
            // this session and ask for changes: the rewrite lands on the
            // brief the last job made, so talking to the brief works too.
            const job = await rt.store.briefs.forSession(sessionId)
            if (!job) return errResult('no brief job belongs to this session')
            if (job.status === 'queued') return errResult('a re-brief of this item is queued — it will rewrite the brief; try again after it runs')
            const item = await rt.store.items.get(job.itemId)
            if (!item) return errResult('the work item no longer exists')
            const refs = [...(item.refs ?? []), ...(args.refs ?? [])]
            const artifact = await rt.artifacts.writeAt(briefRelPath(item.id), {
              title: args.title.trim() || item.title,
              body: args.body,
              author: 'model',
              ...(refs.length ? { refs } : {}),
            })
            await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: item.id, role: 'brief' })
            await rt.store.briefs.update(job.id, { artifactId: artifact.id })
            if (job.status === 'running') rt.briefWrote.add(job.id)
            else if (job.status === 'failed') {
              // a run that failed, rescued by the user in the session: the brief exists now
              const finishedAt = Date.now()
              await rt.store.briefs.update(job.id, { status: 'ready', error: null, finishedAt })
              broadcastBrief(rt, { ...job, status: 'ready', error: null, finishedAt, artifactId: artifact.id })
            }
            log('info', 'briefs', `brief written: ${item.title}`, { jobId: job.id, itemId: item.id, artifactId: artifact.id, workspace: rt.meta.id })
            return okResult(`ok: brief saved to ${artifact.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}

/** Queue briefs for items. An item already queued or running keeps its job; a ready one continues its session. */
export async function enqueueBriefsOp(rt: WorkspaceRuntime, raw: unknown): Promise<BriefJob[]> {
  const r = (raw ?? {}) as Record<string, unknown>
  const ids = Array.isArray(r.itemIds) ? r.itemIds.filter((x): x is string => typeof x === 'string' && ANY_ITEM_ID_RE.test(x)) : []
  if (!ids.length) throw new Error('need itemIds')
  if (ids.length > 50) throw new Error('at most 50 items at once')
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null
  const model = typeof r.model === 'string' && r.model ? r.model : null
  if (r.playbook !== undefined && !isPlaybookName(r.playbook)) throw new Error('playbook must be a kind name')
  if (r.playbookBody !== undefined && typeof r.playbookBody !== 'string') throw new Error('playbookBody must be text')
  if (typeof r.playbookBody === 'string' && r.playbookBody.length > 20_000) throw new Error('the template is too long (20,000 characters at most)')
  const edited = typeof r.playbookBody === 'string' && r.playbookBody.trim() ? r.playbookBody : null
  const jobs: BriefJob[] = []
  for (const id of ids) {
    const item = await rt.store.items.get(id)
    if (!item) throw new Error(`no work item ${id}`)
    const latest = await rt.store.briefs.latestForItem(id)
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      jobs.push(latest)
      continue
    }
    const playbook = (r.playbook as string | undefined) ?? item.kind
    // Kept only when it differs from the file, so an untouched template keeps following the file.
    const playbookBody = edited && edited !== (await readPlaybook(rt.playbookDir, playbook)).body ? edited : null
    const job = await rt.store.briefs.create({ id: randomUUID(), itemId: id, playbook, playbookBody, model, note })
    // A re-brief of a finished brief continues the session that wrote it. It already knows the item.
    if (latest?.status === 'ready' && latest.sessionId && rt.rows.has(latest.sessionId)) {
      await rt.store.briefs.update(job.id, { sessionId: latest.sessionId })
      job.sessionId = latest.sessionId
    }
    jobs.push(job)
    broadcastBrief(rt, job)
    log('info', 'briefs', `queued: ${item.title}`, { jobId: job.id, itemId: id, workspace: rt.meta.id })
  }
  pumpBriefQueue(rt)
  return jobs
}

/**
 * Queue the brief a job asks for on an item it just filed. Never fails the
 * scan: a brief that can't be queued (the daily cap) shows on the item as a
 * failed brief, which Today raises under Something broke.
 */
export function briefFiledItem(rt: WorkspaceRuntime, job: Job, itemId: string, runId: string): void {
  const b = job.brief ?? {}
  enqueueBriefsOp(rt, {
    itemIds: [itemId],
    ...(b.model ? { model: b.model } : {}),
    ...(b.template ? { playbook: b.template } : {}),
  })
    .then(() => log('info', 'job', `brief queued for ${itemId}`, { jobId: job.id, runId, itemId, workspace: rt.meta.id }))
    .catch((err) => log('error', 'job', `could not queue a brief for ${itemId}: ${errText(err)}`, { jobId: job.id, runId, itemId, workspace: rt.meta.id }))
}

/**
 * "You missed X": the item page's feedback goes straight into the session that
 * wrote the brief, as the user's own message, the same as typing it there,
 * and that session rewrites the brief with write_brief. Tracked as a job, so
 * the item shows briefing → ready. Not queued: it is a reply to a session that
 * already knows the item. With that session gone, it queues a fresh run
 * carrying the feedback as its note.
 */
export async function iterateBriefOp(rt: WorkspaceRuntime, raw: unknown): Promise<BriefJob> {
  const r = (raw ?? {}) as Record<string, unknown>
  const itemId = typeof r.itemId === 'string' ? r.itemId : ''
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!ANY_ITEM_ID_RE.test(itemId)) throw new Error('need an itemId')
  if (!text) throw new Error('say what to change')
  const latest = await rt.store.briefs.latestForItem(itemId)
  if (!latest || (latest.status !== 'ready' && latest.status !== 'failed')) throw new Error('no finished brief to iterate on yet')
  const row = latest.sessionId ? rt.rows.get(latest.sessionId) : undefined
  const base = { id: randomUUID(), itemId, playbook: latest.playbook, model: latest.model, note: text }
  if (!row) {
    const job = await rt.store.briefs.create(base)
    broadcastBrief(rt, job)
    pumpBriefQueue(rt)
    return job
  }
  await assertBriefCap(rt)
  // Born running, so the queue never sees it and sends a second prompt.
  const job = await rt.store.briefs.create({ ...base, running: { sessionId: row.id, startedAt: Date.now() } })
  broadcastBrief(rt, job)
  try {
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not reopen the brief session')
    armBriefTimer(rt, job.id, live)
    await live.sendUserMessage(text)
  } catch (err) {
    await finishBrief(rt, job.id, 'failed', errText(err))
    throw err
  }
  log('info', 'briefs', `feedback sent to the brief session: ${itemId}`, { jobId: job.id, itemId, sessionId: row.id, workspace: rt.meta.id })
  return job
}

/** The daily cap on brief runs (Settings → Briefs). */
async function assertBriefCap(rt: WorkspaceRuntime): Promise<void> {
  const settings = await readSettings(rt)
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  if ((await rt.store.briefs.countStartedSince(dayStart.getTime())) >= settings.briefsDailyCap) {
    throw new Error(`the daily cap of ${settings.briefsDailyCap} brief runs is reached — raise it in Settings → Briefs, or try tomorrow`)
  }
}

/** A brief turn that runs past the limit fails, and its subprocess is stopped. */
function armBriefTimer(rt: WorkspaceRuntime, jobId: string, live: LiveSession): void {
  rt.briefTimers.set(
    jobId,
    setTimeout(() => {
      void finishBrief(rt, jobId, 'failed', 'timed out after 5 minutes').then(() => {
        void live.interrupt()
        live.stop()
      })
    }, BRIEF_TIMEOUT_MS),
  )
}

function pumpBriefQueue(rt: WorkspaceRuntime): void {
  if (rt.briefActive || rt.briefPumping) return
  rt.briefPumping = true
  void (async () => {
    const [next] = await rt.store.briefs.list('queued')
    if (!next) return
    rt.briefActive = next.id
    try {
      await startBriefRun(rt, next)
    } catch (err) {
      await finishBrief(rt, next.id, 'failed', errText(err))
    }
  })()
    .catch((err) => log('error', 'briefs', `pump failed: ${err}`, { workspace: rt.meta.id }))
    .finally(() => {
      rt.briefPumping = false
    })
}

async function startBriefRun(rt: WorkspaceRuntime, job: BriefJob): Promise<void> {
  await assertBriefCap(rt)
  const settings = await readSettings(rt)
  const item = await rt.store.items.get(job.itemId)
  if (!item) throw new Error('the work item no longer exists')
  const playbook = job.playbookBody ?? (await readPlaybook(rt.playbookDir, job.playbook)).body
  const existing = await currentBrief(rt, item.id)
  const reuse = job.sessionId ? rt.rows.get(job.sessionId) ?? null : null
  let row: StoredSession
  if (reuse) row = reuse
  else {
    const project = await projectFor(rt, item)
    row = await createSession(
      rt,
      `Brief · ${item.title.slice(0, 70)}`,
      project?.path ?? os.homedir(),
      job.model ?? settings.briefsDefaultModel,
      null,
      false,
      'gated',
      { kind: 'brief', projectId: project?.id ?? null },
    )
    await linkSessionToItem(rt, row.id, item.id, 'brief')
  }
  const startedAt = Date.now()
  await rt.store.briefs.update(job.id, { status: 'running', sessionId: row.id, startedAt, error: null })
  rt.briefWrote.delete(job.id)
  broadcastBrief(rt, { ...job, status: 'running', sessionId: row.id, startedAt, error: null })
  const live = await getOrRevive(rt, row.id)
  if (!live) throw new Error('could not start the brief session')
  armBriefTimer(rt, job.id, live)
  const scored = rt.inboxCache?.items.find((i) => i.id === item.id)
  const iteration = !!reuse && !!job.note && !!existing
  // Screenshots the human put on the item ride the first message as real
  // image blocks: a brief about a broken UI needs to see it.
  const images = await itemImageAttachments(rt.attachmentsDir, item.id, item.images)
  // Files of any type go in as paths the session can Read.
  const { files, note: missingNote } = await itemFilesForSession(rt, row.id, item)
  const briefPrompt = composeBriefPrompt({
      item,
      reason: scored?.rankWhy,
      playbookName: job.playbook,
      playbook,
      note: job.note,
      existing: existing?.body ?? null,
      iteration,
      imageCount: images?.length ?? 0,
    })
  await live.sendUserMessage(missingNote ? `${briefPrompt}\n\n${missingNote}` : briefPrompt, images, undefined, files.length ? { files } : {})
  log('info', 'briefs', `run started: ${item.title}${iteration ? ' (iteration)' : ''}`, {
    jobId: job.id,
    itemId: item.id,
    sessionId: row.id,
    playbook: job.playbook,
    workspace: rt.meta.id,
  })
}

export async function finishBrief(rt: WorkspaceRuntime, jobId: string, status: 'ready' | 'failed', error?: string): Promise<void> {
  const job = await rt.store.briefs.get(jobId)
  const timer = rt.briefTimers.get(jobId)
  if (timer) clearTimeout(timer)
  rt.briefTimers.delete(jobId)
  rt.briefWrote.delete(jobId)
  if (job && (job.status === 'running' || job.status === 'queued')) {
    const finishedAt = Date.now()
    await rt.store.briefs.update(jobId, { status, error: error ?? null, finishedAt })
    broadcastBrief(rt, { ...job, status, error: error ?? null, finishedAt })
    // Nothing more to do in the subprocess; iteration revives it with `resume`.
    if (job.sessionId) rt.live.get(job.sessionId)?.stop()
    log(status === 'ready' ? 'info' : 'error', 'briefs', `run ${status}: ${job.itemId}${error ? ` — ${error}` : ''}`, {
      jobId,
      itemId: job.itemId,
      status,
      workspace: rt.meta.id,
      ...(error ? { error } : {}),
    })
  }
  if (rt.briefActive === jobId) rt.briefActive = null
  pumpBriefQueue(rt)
}

/** The run's turn ended: ready if write_brief landed, else the model finished without writing. */
export async function onBriefTurnDone(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const job = await rt.store.briefs.forSession(sessionId)
  if (!job || job.status !== 'running') return
  const wrote = rt.briefWrote.has(job.id)
  await finishBrief(rt, job.id, wrote ? 'ready' : 'failed', wrote ? undefined : 'the run finished without calling write_brief')
}

/** The subprocess died mid-run (crash, interrupt, auth): the job cannot complete. */
export async function onBriefSessionEnded(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const job = await rt.store.briefs.forSession(sessionId)
  if (!job || job.status !== 'running') return
  await finishBrief(rt, job.id, 'failed', 'the brief session ended before it finished')
}

/** Boot: seed the prose files, mirror session→item links, fail runs the old daemon took down, pump. */
export async function bootBriefs(rt: WorkspaceRuntime): Promise<void> {
  await seedPlaybooks(rt.playbookDir).catch((err) => log('error', 'briefs', `could not seed playbooks: ${err}`, { workspace: rt.meta.id }))
  await seedDispatchTemplates(rt.dispatchDir).catch((err) => log('error', 'briefs', `could not seed dispatch templates: ${err}`, { workspace: rt.meta.id }))
  for (const l of await rt.store.links.list()) {
    if (l.fromKind === 'session' && l.toKind === 'item') rt.sessionItem.set(l.fromId, l.toId)
  }
  const failed = await rt.store.briefs.failAllRunning('the daemon restarted while this brief was running — re-brief to try again')
  if (failed.length) log('warn', 'briefs', `failed ${failed.length} run(s) interrupted by the restart`, { jobIds: failed, workspace: rt.meta.id })
  pumpBriefQueue(rt)
}
