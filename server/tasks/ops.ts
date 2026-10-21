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

export { skipTaskOp, stopTaskOp } from './runner.js'

/**
 * You OK'd "Request Anirudha" (or named someone else): the request goes out,
 * as the item page showed it. A draft is marked ready first.
 */
export async function approveTaskOp(rt: WorkspaceRuntime, taskId: string, body: { reviewer?: string }): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.step !== 'request-review' || t.state !== 'waiting') throw new Error('only a waiting reviewer request can be approved')
  const pr = prOfItem(t.itemId)
  if (!pr) throw new Error('this task is not on a GitHub PR')
  const learned = typeof t.input?.reviewer === 'string' ? t.input.reviewer : null
  const reviewer = body.reviewer?.trim() || learned
  if (!reviewer) throw new Error('name a reviewer')
  const draft = t.input?.draft === true
  // Claim it first, so a double click sends once.
  const claimed = await rt.store.tasks.move(taskId, 'queued', {}, Date.now())
  if (!claimed) throw new Error('the task moved on before it could be approved')
  try {
    for (const args of requestCommands(pr, reviewer, draft)) await gh(args)
  } catch (err) {
    await rt.store.tasks.move(taskId, 'waiting', { error: err instanceof Error ? err.message : String(err) }, Date.now())
    tasksChanged(rt)
    throw err
  }
  // queued → running → done: the same stamps a task Junior ran gets
  await rt.store.tasks.move(taskId, 'running', {}, Date.now())
  const summary = draft ? `Marked ready and requested ${reviewer}` : `Requested ${reviewer}`
  const done = await rt.store.tasks.move(taskId, 'done', { output: { summary } }, Date.now())
  if (reviewer !== learned) await rememberReviewer(rt, pr.repo, reviewer)
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: summary, taskId })
  log('info', 'tasks', `${summary} on ${pr.repo}#${pr.number}`, { task: taskId, workspace: rt.meta.id })
  tasksChanged(rt)
  return done!
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
