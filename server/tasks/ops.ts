/**
 * What you do to a task from the item page: approve the reviewer request,
 * retry, stop, skip. The HTTP routes (server/routes/tasks.ts) and, later,
 * Junior's own tools funnel through these.
 */
import { requestCommands } from '../../core/babysit/reviewer.js'
import { BABYSIT_SETTINGS_KEY, babysitSettingsFrom, type BabysitSettings } from '../../core/babysit/settings.js'
import type { ItemTask } from '../../core/work/tasks.js'
import { gh, rememberReviewer } from '../babysit/glue.js'
import { log } from '../log.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { prOfItem, pumpTasks, tasksChanged } from './runner.js'
import { type AdvanceApproval, allowedDetailFor, describeApproval } from '../../core/approvals/approvals.js'
import { coveringApproval, useApproval } from '../approvals-ops.js'
import { recordFor } from '../../core/actions/track.js'
import type { ActionRecord } from '../../core/actions/types.js'
import { onActionChain } from '../session/actions-hold.js'
import { actionsChanged } from '../session/actions-record.js'
import { errText } from '../errors.js'

export { skipTaskOp, stopTaskOp } from './runner.js'

/**
 * You OK'd "Request Anirudha" (or named someone else): the request goes out,
 * as the item page showed it. A draft is marked ready first.
 */
export async function approveTaskOp(rt: WorkspaceRuntime, taskId: string, body: { reviewer?: string }): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.step !== 'request-review' || t.state !== 'waiting') throw new Error('only a waiting reviewer request can be approved')
  const learned = typeof t.input?.reviewer === 'string' ? t.input.reviewer : null
  const reviewer = body.reviewer?.trim() || learned
  if (!reviewer) throw new Error('name a reviewer')
  return sendRequest(rt, t, reviewer, null)
}

/**
 * Babysit's reviewer request, approved in advance (core/approvals): a live
 * approval for this reviewer, any time or at babysit's "request reviewer"
 * step, sends it alone. False = none covers it (or it failed): it waits for you.
 */
export async function requestUnderApproval(rt: WorkspaceRuntime, t: ItemTask): Promise<boolean> {
  const pr = prOfItem(t.itemId)
  const reviewer = typeof t.input?.reviewer === 'string' ? t.input.reviewer : null
  if (t.step !== 'request-review' || t.state !== 'waiting' || !pr || !reviewer) return false
  const command = `gh pr edit ${pr.number} -R ${pr.repo} --add-reviewer ${reviewer}`
  const rule = await coveringApproval(rt, 'Bash', { command }, { playbook: REQUEST_STEP })
  if (!rule) return false
  try {
    await sendRequest(rt, t, reviewer, rule)
    return true
  } catch (err) {
    log('warn', 'tasks', `an approved reviewer request failed, it waits for you: ${errText(err)}`, { task: t.id, workspace: rt.meta.id })
    return false
  }
}

/** Babysit's step that asks a reviewer: what an approval's `when` names. */
export const REQUEST_STEP = { playbook: 'babysit', step: 'request reviewer' }

/** The request itself: claimed, sent, recorded on the task, the item and the actions log. */
async function sendRequest(rt: WorkspaceRuntime, t: ItemTask, reviewer: string, rule: AdvanceApproval | null): Promise<ItemTask> {
  const pr = prOfItem(t.itemId)
  if (!pr) throw new Error('this task is not on a GitHub PR')
  const learned = typeof t.input?.reviewer === 'string' ? t.input.reviewer : null
  const draft = t.input?.draft === true
  // Claim it first, so a double click sends once.
  const claimed = await rt.store.tasks.move(t.id, 'queued', {}, Date.now())
  if (!claimed) throw new Error('the task moved on before it could be approved')
  const commands = requestCommands(pr, reviewer, draft)
  const at = Date.now()
  try {
    for (const args of commands) await gh(args)
  } catch (err) {
    await rt.store.tasks.move(t.id, 'waiting', { error: err instanceof Error ? err.message : String(err) }, Date.now())
    await recordRequest(rt, t, pr, reviewer, commands, rule, at, err instanceof Error ? err.message : String(err))
    tasksChanged(rt)
    throw err
  }
  // queued → running → done: the same stamps a task Junior ran gets
  await rt.store.tasks.move(t.id, 'running', {}, Date.now())
  const summary = draft ? `Marked ready and requested ${reviewer}` : `Requested ${reviewer}`
  const done = await rt.store.tasks.move(t.id, 'done', { output: { summary } }, Date.now())
  if (reviewer !== learned) await rememberReviewer(rt, pr.repo, reviewer)
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: rule ? 'junior' : 'you', text: rule ? `${summary} (approved in advance: ${describeApproval(rule)})` : summary, taskId: t.id })
  await recordRequest(rt, t, pr, reviewer, commands, rule, at, null)
  if (rule) await useApproval(rt, rule, `task-${t.id}`, undefined)
  log('info', 'tasks', `${summary} on ${pr.repo}#${pr.number}${rule ? ' (approved in advance)' : ''}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  return done!
}

/** The request as an action record, so Junior's log lists it with who allowed it. */
async function recordRequest(
  rt: WorkspaceRuntime,
  t: ItemTask,
  pr: { repo: string; number: number },
  reviewer: string,
  commands: string[][],
  rule: AdvanceApproval | null,
  at: number,
  error: string | null,
): Promise<void> {
  const command = commands.map((c) => ['gh', ...c].join(' ')).join(' && ')
  const now = Date.now()
  const rec: ActionRecord = {
    ...recordFor(
      { sessionId: `task-${t.id}`, sessionKind: 'task', permissionMode: null, jobId: null, teamRunId: null, itemId: t.itemId },
      `request-${at}`,
      'Bash',
      { command },
      { kind: 'update', why: 'bash pattern', whyDetail: 'gh pr edit', summary: `Request a review from ${reviewer} on ${pr.repo}#${pr.number}` },
      at,
    ),
    status: error ? 'failed' : 'succeeded',
    link: `https://github.com/${pr.repo}/pull/${pr.number}`,
    error,
    allowedBy: rule ? 'rule' : 'prompt',
    allowedDetail: rule ? allowedDetailFor(rule) : 'on the item page',
    settledAt: now,
    updatedAt: now,
  }
  await onActionChain(rt, () => rt.store.actions.put(rec))
    .then(() => actionsChanged(rt, new Set([rec.sessionId])))
    .catch((err) => log('warn', 'tasks', `could not record the reviewer request: ${errText(err)}`, { task: t.id, workspace: rt.meta.id }))
}

/**
 * Run a task again: Junior's failed or blocked task gets a fresh copy with
 * your note, which also goes on the item's memory. The old one stays as it
 * ended (a blocked one is closed as skipped).
 */
export async function retryTaskOp(rt: WorkspaceRuntime, taskId: string, note?: string): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.owner !== 'junior' || (t.state !== 'failed' && t.state !== 'waiting')) throw new Error('only a failed or blocked task of Junior’s can be retried')
  if (t.state === 'waiting' && !(await rt.store.tasks.move(taskId, 'skipped', {}, Date.now()))) throw new Error('the task moved on')
  if (note?.trim()) await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: note.trim().slice(0, 2000), taskId })
  const again = await rt.store.tasks.add({ itemId: t.itemId, title: t.title, owner: 'junior', why: 'you', whyDetail: 'retried', ...(t.step ? { step: t.step } : {}), ...(t.input ? { input: t.input } : {}) }, Date.now())
  if (!again) throw new Error('could not add the retry')
  tasksChanged(rt)
  void pumpTasks(rt)
  return again
}

export async function babysitSettingsOp(rt: WorkspaceRuntime, patch?: unknown): Promise<BabysitSettings> {
  const now = babysitSettingsFrom(await rt.store.config.get(BABYSIT_SETTINGS_KEY))
  if (patch === undefined) return now
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<BabysitSettings>
  const next = babysitSettingsFrom({ ...now, ...p, models: { ...now.models, ...(p.models ?? {}) }, budget: { ...now.budget, ...(p.budget ?? {}) } })
  await rt.store.config.set(BABYSIT_SETTINGS_KEY, next)
  // A raised budget or switching on can free queued work now.
  rt.taskBudgetHitOn = null
  void pumpTasks(rt)
  return next
}
