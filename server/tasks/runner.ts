/**
 * The task runner: Junior's queued tasks become short fresh sessions, at most
 * `maxRunning` at once, one per item at a time, each in the item's own
 * worktree, on the model its step calls for, within the per-task and daily
 * budgets (Settings → Automations). A session is one turn: it hands in with
 * submit_task, and its result ends the run (like a goal worker's).
 *
 * Junior runs the babysit playbook's tasks (fix-ci, fix-thread, rebase) and
 * the review playbook's first pass (review: read-only, hands in with
 * submit_review). The pure rules are core/babysit, core/review and
 * core/work/tasks.ts.
 */
import { existsSync } from 'node:fs'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { taskPrompt, type TaskPr } from '../../core/babysit/brief.js'
import type { TaskRunScope } from '../../core/babysit/policy.js'
import { capFor, modelFor, type BabysitSettings } from '../../core/babysit/settings.js'
import { heldBy, watchOf } from '../../core/work/handoff.js'
import { MAX_COMMENTS, passLine, passMarkdown, reviewPrompt, VERDICT_LABEL, type FirstPass, type ReviewCtx } from '../../core/review/brief.js'
import { POST_REVIEW_STEP, REVIEW_STEP } from '../../core/review/watch.js'
import { isStale } from '../../core/babysit/watch.js'
import type { ItemTask } from '../../core/work/tasks.js'
import type { WorkItem } from '../../core/work/types.js'
import {
  ANSWER_STEP,
  answerPrompt,
  APPROVE_PLAN_STEP,
  DEBUG_FIX_STEP,
  DEBUG_PLAN_STEP,
  debugFixPrompt,
  debugPlanPrompt,
  fixBranch,
  INVESTIGATE_STEP,
  investigatePrompt,
  isItemStep,
  MAX_REPLY_CHARS,
  planMarkdown,
  SEND_REPLY_STEP,
} from '../../core/playbooks/item.js'
import type { Checkout, Project } from '../../shared/protocol.js'
import { BABYSIT_WATCH_KEY, type BabysitWatchState } from '../babysit/watch.js'
import { REVIEW_WATCH_KEY, type ReviewWatchState } from '../review/watch.js'
import { createArtifactOp } from '../artifacts-ops.js'
import { babysitSettings, ghBabysitSource, onBabysitTick, onTaskAdded } from '../babysit/glue.js'
import { pExecFile, VERSION } from '../config.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import { power } from '../power.js'
import { checkoutList, makeWorktree, syncCheckouts } from '../session/checkouts.js'
import { createSession, getOrRevive } from '../session/sessions.js'
import { linkSessionToItem, watchesOn } from '../settings-ops.js'
import { okResult, errResult } from '../junior-mcp.js'
import { defaultBranch } from '../worktrees.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { broadcastSessionList, invalidateInbox } from '../ws/send.js'
import { taskNeedsYou } from './notify.js'
import { requestUnderApproval } from './ops.js'

/** A task session gives up after this: a hung run never holds a slot all day. */
export const TASK_SESSION_TIMEOUT_MS = 30 * 60_000

export type TaskRun = {
  taskId: string
  itemId: string
  sessionId: string
  /** the task's step: which hand-in tool the session gets */
  step?: string
  /** the head the session works on */
  headSha: string
  scope: TaskRunScope
  perTaskUsd: number
  release: () => void
  timer: ReturnType<typeof setTimeout>
}

/** Local midnight, ms: the daily budget's day. */
const dayStart = (now: number) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const dayKey = (now: number) => new Date(dayStart(now)).toISOString().slice(0, 10)

/** "github:acme/api#12" → acme/api, 12 */
export function prOfItem(itemId: string): { repo: string; number: number } | null {
  const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(itemId)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

/** Tasks changed: the inbox (and an open item page) redraws. */
export function tasksChanged(rt: WorkspaceRuntime): void {
  invalidateInbox(rt)
}

const recovered = new WeakSet<WorkspaceRuntime>()

/** Start what can start. Safe to call any time; one pass at a time per workspace. */
export async function pumpTasks(rt: WorkspaceRuntime): Promise<void> {
  if (rt.taskPumping) {
    rt.taskPumpAgain = true
    return
  }
  rt.taskPumping = true
  try {
    do {
      rt.taskPumpAgain = false
      await pumpOnce(rt)
    } while (rt.taskPumpAgain)
  } catch (err) {
    log('error', 'tasks', `pump failed: ${errText(err)}`, { workspace: rt.meta.id })
  } finally {
    rt.taskPumping = false
  }
}

async function pumpOnce(rt: WorkspaceRuntime): Promise<void> {
  // A daemon that stopped mid-task left it running with no session: run it again.
  if (!recovered.has(rt)) {
    recovered.add(rt)
    const back = await rt.store.tasks.requeueRunning()
    if (back.length) log('info', 'tasks', `requeued ${back.length} task(s) a stopped daemon left running`, { workspace: rt.meta.id })
  }
  const s = await babysitSettings(rt)
  const now = Date.now()
  const spent = await rt.store.tasks.spentSince(dayStart(now))
  // A task on an item you paused, or a watch's task on a PR you didn't hand off, is stopped when it comes up (startTask).
  // A task from a watch you switched off stays queued until you switch it back on.
  const on = await watchesOn(rt)
  const queued = (await rt.store.tasks.inState(['queued'])).filter((t) => {
    const w = watchOf(t)
    return t.owner === 'junior' && (!w || on[w])
  })
  if (queued.length === 0) return
  if (spent >= s.budget.perDayUsd) {
    if (rt.taskBudgetHitOn !== dayKey(now)) {
      rt.taskBudgetHitOn = dayKey(now)
      log('info', 'tasks', `daily budget reached ($${spent.toFixed(2)} of $${s.budget.perDayUsd}): ${queued.length} task(s) wait`, { workspace: rt.meta.id })
      taskNeedsYou(rt, { kind: 'budget', spent, limit: s.budget.perDayUsd, waiting: queued.length })
    }
    return
  }
  const busy = new Set([...rt.taskRuns.values()].map((r) => r.itemId))
  for (const t of queued) {
    if (rt.taskRuns.size >= s.maxRunning) break
    if (busy.has(t.itemId)) continue
    busy.add(t.itemId)
    try {
      await startTask(rt, t, s)
    } catch (err) {
      await finish(rt, t.id, 'failed', { error: errText(err) })
      log('error', 'tasks', `could not start "${t.title}": ${errText(err)}`, { task: t.id, item: t.itemId, workspace: rt.meta.id })
    }
  }
}

/** Move a task and tell whoever needs to know. A failed task is Junior stuck. */
async function finish(rt: WorkspaceRuntime, taskId: string, to: 'done' | 'failed' | 'skipped' | 'stopped' | 'waiting', patch: { error?: string; output?: ItemTask['output'] }): Promise<ItemTask | null> {
  const moved = await rt.store.tasks.move(taskId, to, patch, Date.now())
  if (moved && (to === 'failed' || to === 'waiting')) taskNeedsYou(rt, { kind: 'stuck', task: moved })
  if (moved) tasksChanged(rt)
  return moved
}

async function git(dir: string, args: string[]): Promise<string> {
  return (await pExecFile('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 })).stdout
}

/**
 * The item's worktree, at the PR's head as GitHub has it now. Made on its
 * first task, reused after. Your PR's branch is on origin; a PR you review
 * may come from a fork, so its head is fetched as GitHub's pull ref.
 */
async function taskCheckout(rt: WorkspaceRuntime, project: Project, itemId: string, pr: TaskPr, review: boolean): Promise<{ co: Checkout; sha: string }> {
  const ref = review ? `pull/${pr.number}/head` : pr.headRef
  await git(project.path, ['fetch', 'origin', ref])
  const sha = (await git(project.path, ['rev-parse', 'FETCH_HEAD'])).trim()
  let co = checkoutList(rt).find((c) => c.itemId === itemId && c.kind === 'worktree' && existsSync(c.path))
  if (!co) {
    const branch = `${review ? 'review' : 'babysit'}/${pr.repo.split('/')[1]}-${pr.number}`.replace(/[^\w./-]+/g, '-')
    co = await makeWorktree(rt, project, branch, itemId, undefined, sha)
  }
  // Junior's own folder: whatever an earlier task left is dropped for the PR as it is now.
  await git(co.path, ['reset', '--hard', sha])
  await git(co.path, ['clean', '-fd'])
  return { co, sha }
}

/** The PR an item's task works on, as its playbook's watch last read it. */
async function watchedPr(rt: WorkspaceRuntime, itemId: string, step: string | undefined): Promise<{ headSha: string | null; headRef?: string; baseRef?: string } | undefined> {
  if (step === REVIEW_STEP) return (await rt.store.config.get<ReviewWatchState>(REVIEW_WATCH_KEY))?.prs[itemId]
  return (await rt.store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY))?.prs[itemId]
}

const ghOut = (args: string[]) => pExecFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout, () => '')

/** What a first pass reads before it starts: the PR's words and its diff. */
async function reviewCtx(pr: { repo: string; number: number }): Promise<ReviewCtx> {
  const [view, diff] = await Promise.all([
    ghOut(['pr', 'view', String(pr.number), '-R', pr.repo, '--json', 'title,body,author,files']),
    ghOut(['pr', 'diff', String(pr.number), '-R', pr.repo]),
  ])
  let v: { title?: string; body?: string; author?: { login?: string }; files?: { path: string; additions: number; deletions: number }[] } = {}
  try {
    v = JSON.parse(view)
  } catch {}
  return {
    title: v.title ?? '',
    body: v.body ?? '',
    author: v.author?.login ?? 'someone',
    diff,
    files: (v.files ?? []).map((f) => `- ${f.path} (+${f.additions} −${f.deletions})`).join('\n'),
  }
}

async function startTask(rt: WorkspaceRuntime, t: ItemTask, s: BabysitSettings): Promise<void> {
  const item = await rt.store.items.get(t.itemId)
  if (!item) return void (await finish(rt, t.id, 'stopped', { error: 'the item is gone' }))
  // Junior works only what you handed it, and nothing you paused (core/work/handoff.ts).
  const held = heldBy(t.step, item.handoff)
  if (held) return void (await finish(rt, t.id, 'stopped', { error: held }))
  if (isItemStep(t.step)) return startItemTask(rt, t, s, item)
  const ref = prOfItem(item.id)
  const review = t.step === REVIEW_STEP
  const watch = await watchedPr(rt, item.id, t.step)
  if (!ref || !watch?.headRef || !watch.baseRef) throw new Error(review ? 'this review needs a PR that asks for your review' : 'this task needs a PR the babysitter is watching')
  if (isStale(t, watch.headSha)) return void (await finish(rt, t.id, 'skipped', { error: 'the PR moved on since: a fresh task comes if it still needs one' }))
  const project = item.projectId ? (await rt.store.projects.list()).find((p) => p.id === item.projectId) : undefined
  if (!project) throw new Error(`no project folder holds ${ref.repo}: add it as a project so Junior can work on it`)

  const pr: TaskPr = { ...ref, url: item.url, headRef: watch.headRef, baseRef: watch.baseRef }
  const { co: checkout, sha } = await taskCheckout(rt, project, item.id, pr, review)
  const ctx: { log?: string; diff?: string } = {}
  const rctx = review ? await reviewCtx(pr) : null
  if (t.step === 'fix-ci') {
    const runId = typeof t.input?.runId === 'number' ? t.input.runId : null
    const check = { name: String(t.input?.check ?? ''), status: 'failure' as const, id: '', runId, url: null, conclusion: null }
    ctx.log = await ghBabysitSource.failedLog(pr.repo, check).catch(() => '')
    ctx.diff = await pExecFile('gh', ['pr', 'diff', String(pr.number), '-R', pr.repo], { maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout, () => '')
  }

  const model = modelFor(t.step, s)
  const row = await createSession(rt, `${t.title} · ${pr.repo}#${pr.number}`, checkout.path, model, null, false, 'gated', {
    kind: 'task',
    projectId: project.id,
    checkoutId: checkout.id,
    spawn: false,
  })
  const run: TaskRun = {
    taskId: t.id,
    itemId: item.id,
    sessionId: row.id,
    ...(t.step ? { step: t.step } : {}),
    headSha: sha,
    scope: {
      headRef: pr.headRef,
      defaultBranch: (await defaultBranch(project.path).catch(() => null)) ?? pr.baseRef,
      threadId: t.step === 'fix-thread' ? String(t.input?.threadId ?? '') || null : null,
      ...(review ? { readOnly: true } : {}),
    },
    perTaskUsd: capFor(t.step, s),
    // The Mac stays awake while a task runs: a sleeping Mac hangs a headless run.
    release: power.hold(`task ${t.id}`),
    timer: setTimeout(() => void endTaskSession(rt, row.id, `timed out after ${TASK_SESSION_TIMEOUT_MS / 60_000} minutes`), TASK_SESSION_TIMEOUT_MS),
  }
  rt.taskRuns.set(row.id, run)
  const moved = await rt.store.tasks.move(t.id, 'running', { sessionId: row.id, model }, Date.now())
  if (!moved) {
    // stopped or skipped in the meantime
    rt.taskRuns.delete(row.id)
    clearTimeout(run.timer)
    run.release()
    return
  }
  tasksChanged(rt)
  try {
    await linkSessionToItem(rt, row.id, item.id, 'dispatch')
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not start the session')
    await live.sendUserMessage(rctx ? reviewPrompt(moved, pr, item.memory, rctx) : taskPrompt(moved, pr, item.memory, ctx))
    log('info', 'tasks', `started "${t.title}" on ${pr.repo}#${pr.number} (${model})`, { task: t.id, session: row.id, workspace: rt.meta.id })
  } catch (err) {
    await endTaskSession(rt, row.id, errText(err))
  }
}

/**
 * A playbook task on any item (core/playbooks/item.ts): answer, investigate
 * and debug-plan read the project folder and hand in; debug-fix works in its
 * own worktree on Junior's own branch and opens a draft PR.
 */
async function startItemTask(rt: WorkspaceRuntime, t: ItemTask, s: BabysitSettings, item: WorkItem): Promise<void> {
  const projects = await rt.store.projects.list()
  const project = projects.find((p) => p.id === item.projectId) ?? projects.find((p) => p.isDefault)
  if (!project) throw new Error('no project folder to work in: add one so Junior can read the code')
  const base = (await defaultBranch(project.path).catch(() => null)) ?? 'main'
  const fix = t.step === DEBUG_FIX_STEP
  let cwd = project.path
  let checkoutId: string | null = null
  let prompt: string
  const branch = fixBranch(item)
  if (fix) {
    const co = await fixCheckout(rt, project, item.id, branch, base)
    cwd = co.path
    checkoutId = co.id
    prompt = debugFixPrompt(item, { branch, base, ...(typeof t.input?.note === 'string' && t.input.note ? { note: t.input.note } : {}) })
  } else {
    const p = { name: project.name, path: project.path }
    prompt = t.step === ANSWER_STEP ? answerPrompt(item, p) : t.step === INVESTIGATE_STEP ? investigatePrompt(item, p) : debugPlanPrompt(item, p)
  }
  const model = modelFor(t.step, s)
  const row = await createSession(rt, `${t.title} · ${item.title}`.slice(0, 120), cwd, model, null, false, 'gated', {
    kind: 'task',
    projectId: project.id,
    ...(checkoutId ? { checkoutId } : {}),
    spawn: false,
  })
  const run: TaskRun = {
    taskId: t.id,
    itemId: item.id,
    sessionId: row.id,
    ...(t.step ? { step: t.step } : {}),
    headSha: '',
    scope: fix ? { headRef: branch, defaultBranch: base, draftPr: true } : { headRef: '', defaultBranch: base, readOnly: true },
    perTaskUsd: capFor(t.step, s),
    release: power.hold(`task ${t.id}`),
    timer: setTimeout(() => void endTaskSession(rt, row.id, `timed out after ${TASK_SESSION_TIMEOUT_MS / 60_000} minutes`), TASK_SESSION_TIMEOUT_MS),
  }
  rt.taskRuns.set(row.id, run)
  const moved = await rt.store.tasks.move(t.id, 'running', { sessionId: row.id, model }, Date.now())
  if (!moved) {
    rt.taskRuns.delete(row.id)
    clearTimeout(run.timer)
    run.release()
    return
  }
  tasksChanged(rt)
  try {
    await linkSessionToItem(rt, row.id, item.id, 'dispatch')
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not start the session')
    await live.sendUserMessage(prompt)
    log('info', 'tasks', `started "${t.title}" on ${item.id} (${model})`, { task: t.id, session: row.id, workspace: rt.meta.id })
  } catch (err) {
    await endTaskSession(rt, row.id, errText(err))
  }
}

/**
 * The fix's worktree: Junior's own branch from the default branch as origin
 * has it. Made on the first fix, reused by a retry (its commits kept).
 */
async function fixCheckout(rt: WorkspaceRuntime, project: Project, itemId: string, branch: string, base: string): Promise<Checkout> {
  const have = checkoutList(rt).find((c) => c.itemId === itemId && c.kind === 'worktree' && existsSync(c.path))
  if (have) return have
  await git(project.path, ['fetch', 'origin', base])
  const sha = (await git(project.path, ['rev-parse', 'FETCH_HEAD'])).trim()
  return makeWorktree(rt, project, branch, itemId, undefined, sha)
}

/**
 * A task's session ended, timed out, went over budget or was stopped. Once
 * per session. A task still running here never handed in. If its turn ended
 * with something to say, the work may be done: it waits on you with Junior's
 * last message. Otherwise it failed.
 */
export async function endTaskSession(rt: WorkspaceRuntime, sessionId: string, error: string | null, costUsd = 0, overBudget = false, lastWords = ''): Promise<void> {
  const run = rt.taskRuns.get(sessionId)
  if (!run) return
  rt.taskRuns.delete(sessionId)
  clearTimeout(run.timer)
  run.release()
  const live = rt.live.get(sessionId)
  if (live) {
    if (error) void live.interrupt()
    live.stop()
  }
  try {
    if (costUsd > 0) await rt.store.tasks.addCost(run.taskId, costUsd)
    const t = await rt.store.tasks.get(run.taskId)
    if (t?.state === 'running') {
      const said = lastWords.trim()
      if (!error && !overBudget && said) await finish(rt, t.id, 'waiting', { error: unhandedNote(said) })
      else {
        const why = overBudget ? `went over its $${run.perTaskUsd} budget` : (error ?? 'the session ended without handing in')
        await finish(rt, t.id, 'failed', { error: why })
      }
    }
  } catch (err) {
    log('error', 'tasks', `could not settle task ${run.taskId}: ${errText(err)}`, { workspace: rt.meta.id })
  }
  broadcastSessionList(rt)
  void syncCheckouts(rt)
  void pumpTasks(rt)
}

const UNHANDED_CHARS = 600

/** What a task that never handed in tells you: Junior's last message, clipped. */
export function unhandedNote(said: string): string {
  const one = said.replace(/\s+/g, ' ').trim()
  const cut = one.length > UNHANDED_CHARS ? `${one.slice(0, UNHANDED_CHARS - 1).trimEnd()}…` : one
  return `Junior ended without handing in. Its last message: ${cut}`
}

/** Stop a task: a running one's session ends, a queued or waiting one never runs. */
export async function stopTaskOp(rt: WorkspaceRuntime, taskId: string, by: 'you' | 'junior' = 'you', error?: string): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  const moved = await rt.store.tasks.move(taskId, 'stopped', { error: error ?? `stopped by ${by === 'you' ? 'you' : 'Junior'}` }, Date.now())
  if (!moved) throw new Error(`a ${t.state} task can't be stopped`)
  const run = [...rt.taskRuns.values()].find((r) => r.taskId === taskId)
  if (run) await endTaskSession(rt, run.sessionId, 'stopped')
  tasksChanged(rt)
  return moved
}

/** Skip a task that hasn't run: queued, or waiting on you. */
export async function skipTaskOp(rt: WorkspaceRuntime, taskId: string): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.state !== 'queued' && t.state !== 'waiting') throw new Error(`a ${t.state} task can't be skipped; stop it instead`)
  const moved = await rt.store.tasks.move(taskId, 'skipped', {}, Date.now())
  if (!moved) throw new Error('the task moved on before it could be skipped')
  tasksChanged(rt)
  return moved
}

/**
 * The task session's one tool. Looked up by session at call time, built per
 * spawn (one instance connects to one transport).
 */
export function makeTaskMcp(rt: WorkspaceRuntime, sessionId: string) {
  const step = rt.taskRuns.get(sessionId)?.step
  const handIn =
    step === REVIEW_STEP ? submitReviewTool(rt, sessionId)
    : step === ANSWER_STEP ? submitReplyTool(rt, sessionId)
    : step === INVESTIGATE_STEP ? submitBriefTool(rt, sessionId)
    : step === DEBUG_PLAN_STEP ? submitPlanTool(rt, sessionId)
    : submitTaskTool(rt, sessionId)
  return createSdkMcpServer({ name: 'task', version: VERSION, alwaysLoad: true, tools: [handIn] })
}

/** The running task a hand-in is for, or why there is none. */
async function runningTask(rt: WorkspaceRuntime, sessionId: string): Promise<{ run: TaskRun; t: ItemTask; item: WorkItem } | { error: string }> {
  const run = rt.taskRuns.get(sessionId)
  if (!run) return { error: 'This session has no task running (it ended or was stopped).' }
  const t = await rt.store.tasks.get(run.taskId)
  if (!t || t.state !== 'running') return { error: `This task is ${t?.state ?? 'gone'}: nothing to hand in.` }
  const item = await rt.store.items.get(run.itemId)
  if (!item) return { error: 'The item this task was for is gone.' }
  return { run, t, item }
}

const DECISIONS = z.array(z.string().min(1).max(500)).max(10).optional().describe('what the next task on this item should know')

async function addDecisions(rt: WorkspaceRuntime, itemId: string, taskId: string, decisions: string[] | undefined): Promise<void> {
  const at = Date.now()
  for (const text of decisions ?? []) await rt.store.items.addDecision(itemId, { at, by: 'junior', text, taskId })
}

/** Babysit's tasks and the fix: done (what changed, the commit) or blocked (the question). */
function submitTaskTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool(
    'submit_task',
    "Hand in this session's task, once, at the end: done (what you changed, in one line, and the commit you pushed) or blocked (the question the user must answer). Then end your turn.",
    {
      outcome: z.enum(['done', 'blocked']),
      summary: z.string().min(1).max(300).describe('done: what changed, one line. blocked: the question for the user.'),
      sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional().describe('the commit you pushed'),
      decisions: DECISIONS,
    },
    async (a) => {
      const got = await runningTask(rt, sessionId)
      if ('error' in got) return errResult(got.error)
      const { run, t } = got
      await addDecisions(rt, run.itemId, t.id, a.decisions)
      if (a.outcome === 'done') await finish(rt, t.id, 'done', { output: { summary: a.summary, ...(a.sha ? { sha: a.sha } : {}) } })
      else await finish(rt, t.id, 'waiting', { error: a.summary })
      return okResult('Handed in. End your turn now.')
    },
  )
}

/**
 * The answer's hand-in: the draft reply. It becomes "Send reply", a task on
 * you with the reply on an editable card. Nothing is sent from here.
 */
function submitReplyTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool(
    'submit_reply',
    'Hand in the draft reply, once, at the end. Nothing is sent: the user reads it, edits it if they want, and sends it. Then end your turn.',
    {
      reply: z.string().min(1).max(MAX_REPLY_CHARS).describe('the message as the user would send it, Slack markdown'),
      summary: z.string().min(1).max(300).describe('one line for the user: what you answered'),
      unsure: z.string().max(500).optional().describe('what you could not confirm, if anything'),
      decisions: DECISIONS,
    },
    async (a) => {
      const got = await runningTask(rt, sessionId)
      if ('error' in got) return errResult(got.error)
      const { run, t, item } = got
      await addDecisions(rt, run.itemId, t.id, a.decisions)
      await finish(rt, t.id, 'done', { output: { summary: a.summary } })
      const send = await rt.store.tasks.add(
        {
          itemId: item.id,
          title: `Send reply${item.author ? ` to ${item.author}` : ''}`,
          owner: 'you',
          state: 'waiting',
          why: 'playbook',
          whyDetail: "Junior's draft",
          step: SEND_REPLY_STEP,
          key: `send:${t.id}`,
          input: { reply: a.reply.trim(), ...(a.unsure?.trim() ? { unsure: a.unsure.trim() } : {}), answerTaskId: t.id },
        },
        Date.now(),
      )
      if (send) taskNeedsYou(rt, { kind: 'reply', task: send })
      tasksChanged(rt)
      return okResult('Handed in. End your turn now.')
    },
  )
}

/** Investigate's hand-in: the options brief, an artifact on the item. */
function submitBriefTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool(
    'submit_brief',
    'Hand in the options brief, once, at the end. It is saved on the item for the user. Then end your turn.',
    {
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(40_000).describe('the whole brief, markdown'),
      summary: z.string().min(1).max(300).describe('one line: your recommendation'),
      decisions: DECISIONS,
    },
    async (a) => {
      const got = await runningTask(rt, sessionId)
      if ('error' in got) return errResult(got.error)
      const { run, t, item } = got
      try {
        const { artifact } = await createArtifactOp(
          rt,
          { title: a.title, format: 'md', body: a.body, note: 'Options, by Junior', ...(item.url ? { refs: [item.url] } : {}), links: [{ kind: 'item', id: item.id, role: 'context' }] },
          'model',
          { sessionId },
        )
        await addDecisions(rt, run.itemId, t.id, a.decisions)
        await finish(rt, t.id, 'done', { output: { summary: a.summary, artifactId: artifact.id } })
        return okResult('Handed in. End your turn now.')
      } catch (err) {
        return errResult(`Could not save the brief: ${errText(err)}`)
      }
    },
  )
}

/**
 * Debug-fix's first hand-in: the plan. It becomes the Plan artifact and the
 * item's plan, and "Approve plan", a task on you: Junior changes nothing
 * until you approve it.
 */
function submitPlanTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool(
    'submit_plan',
    'Hand in the plan for the fix, once, at the end. Nothing changes until the user approves it. Then end your turn.',
    {
      plan: z.string().min(1).max(20_000).describe('the plan, markdown: cause, fix, test, risk'),
      summary: z.string().min(1).max(300).describe('one line: the cause and the fix'),
      confidence: z.enum(['high', 'medium', 'low']),
      decisions: DECISIONS,
    },
    async (a) => {
      const got = await runningTask(rt, sessionId)
      if ('error' in got) return errResult(got.error)
      const { run, t, item } = got
      try {
        const { artifact } = await createArtifactOp(
          rt,
          { title: `Plan: ${item.title}`.slice(0, 200), format: 'md', body: planMarkdown(item, a.plan, a.confidence), note: `Plan, ${a.confidence} confidence`, ...(item.url ? { refs: [item.url] } : {}), links: [{ kind: 'item', id: item.id, role: 'context' }] },
          'model',
          { sessionId },
        )
        await rt.store.items.setPlan(item.id, a.plan.trim())
        await addDecisions(rt, run.itemId, t.id, a.decisions)
        await finish(rt, t.id, 'done', { output: { summary: `${a.summary} (${a.confidence} confidence)`, artifactId: artifact.id } })
        const approve = await rt.store.tasks.add(
          {
            itemId: item.id,
            title: 'Approve plan',
            owner: 'you',
            state: 'waiting',
            why: 'playbook',
            whyDetail: 'debug-fix stops at the plan',
            step: APPROVE_PLAN_STEP,
            key: `approve:${t.id}`,
            input: { artifactId: artifact.id, planTaskId: t.id, confidence: a.confidence },
          },
          Date.now(),
        )
        if (approve) taskNeedsYou(rt, { kind: 'plan', task: approve })
        tasksChanged(rt)
        return okResult('Handed in. End your turn now.')
      } catch (err) {
        return errResult(`Could not save the plan: ${errText(err)}`)
      }
    },
  )
}

/**
 * A first pass's one tool: the verdict, the summary and the comments. The
 * pass becomes the Review artifact on the item and the task's line, and
 * posting it becomes a task on you, held for your OK.
 */
function submitReviewTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool(
    'submit_review',
    'Hand in your first-pass review, once, at the end: the verdict, a 2–4 line summary, and the comments you suggest. Nothing is posted: the user reads it first. Then end your turn.',
    {
      verdict: z.enum(['approve', 'comment', 'request_changes']),
      summary: z.string().min(1).max(1200).describe('2–4 plain lines: what the PR does, and what matters most in your read'),
      comments: z
        .array(
          z.object({
            path: z.string().min(1).max(400).describe('file path from the repo root'),
            line: z.number().int().positive().describe('line in the new file (or the old one, with side LEFT)'),
            side: z.enum(['LEFT', 'RIGHT']).optional(),
            body: z.string().min(1).max(2000).describe('the comment as you would post it'),
          }),
        )
        .max(MAX_COMMENTS)
        .default([]),
      skipped: z.string().max(500).optional().describe('what you did not read, on a big PR'),
      decisions: z.array(z.string().min(1).max(500)).max(10).optional().describe('what a later pass on this PR should know'),
    },
    async (a) => {
      const run = rt.taskRuns.get(sessionId)
      if (!run) return errResult('This session has no task running (it ended or was stopped).')
      const t = await rt.store.tasks.get(run.taskId)
      if (!t || t.state !== 'running') return errResult(`This task is ${t?.state ?? 'gone'}: nothing to hand in.`)
      const item = await rt.store.items.get(run.itemId)
      const ref = prOfItem(run.itemId)
      if (!item || !ref) return errResult('The PR this review was for is gone.')
      const pass: FirstPass = { verdict: a.verdict, summary: a.summary.trim(), comments: a.comments, ...(a.skipped?.trim() ? { skipped: a.skipped.trim() } : {}), sha: run.headSha }
      const at = Date.now()
      try {
        const { artifact } = await createArtifactOp(
          rt,
          {
            title: `Review: ${ref.repo}#${ref.number}`,
            format: 'md',
            body: passMarkdown({ ...ref, url: item.url, title: item.title, author: item.author }, pass),
            note: `First pass at ${pass.sha.slice(0, 7)}: ${VERDICT_LABEL[pass.verdict]}`,
            refs: [item.url],
            links: [{ kind: 'item', id: item.id, role: 'context' }],
          },
          'model',
          { sessionId },
        )
        for (const text of a.decisions ?? []) await rt.store.items.addDecision(run.itemId, { at, by: 'junior', text, taskId: t.id })
        await finish(rt, t.id, 'done', { output: { summary: passLine(pass), artifactId: artifact.id, sha: pass.sha, verdict: pass.verdict } })
        const post = await rt.store.tasks.add(
          {
            itemId: run.itemId,
            title: 'Post review',
            owner: 'you',
            state: 'waiting',
            why: 'playbook',
            whyDetail: `Junior's pass: ${VERDICT_LABEL[pass.verdict]}`,
            step: POST_REVIEW_STEP,
            key: `post:${t.id}`,
            input: { pass, artifactId: artifact.id, reviewTaskId: t.id },
          },
          Date.now(),
        )
        if (post) taskNeedsYou(rt, { kind: 'post-review', task: post, verdict: pass.verdict })
        tasksChanged(rt)
        return okResult('Handed in. End your turn now.')
      } catch (err) {
        return errResult(`Could not save the review: ${errText(err)}`)
      }
    },
  )
}

/** The system prompt's last word for a task session. */
export const TASK_SYSTEM_APPEND = `
This is a headless task session: nobody reads this chat while it runs. Do the one task in the first message, then call submit_task and stop. Don't ask questions in chat: hand in blocked with the question instead.`

/** A playbook task on an item that reads (answer, investigate, the plan): read-only, its own hand-in tool. */
export const ITEM_SYSTEM_APPEND = `
This is a headless task session: nobody reads this chat while it runs. Do the one task in the first message: read, change nothing, send nothing. Then call your submit tool once and stop. Don't ask questions in chat: put what you are unsure of in what you hand in.`

/** The same for a first-pass review: read-only, and it hands in with submit_review. */
export const REVIEW_SYSTEM_APPEND = `
This is a headless review session: nobody reads this chat while it runs. Read the PR in the first message, change nothing, then call submit_review once and stop. Don't ask questions in chat: put what you are unsure of in the summary or a comment.`

onTaskAdded((rt, task, stuck) => {
  if (stuck) taskNeedsYou(rt, { kind: 'stuck', task })
  // Approved in advance: the request goes out alone and nothing pings you. Else it waits for you.
  else if (task.step === 'request-review')
    void requestUnderApproval(rt, task).then((sent) => {
      if (!sent) taskNeedsYou(rt, { kind: 'review', task })
    })
  void pumpTasks(rt)
})
onBabysitTick((rt) => void pumpTasks(rt))
