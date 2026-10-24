/**
 * The hooks the runner and notifications attach to the watches: a task was
 * added, a tick ran. A leaf on purpose: the task runner registers its hooks
 * when it loads, and the watches (./glue.ts) import the runner back, so if the
 * registries lived in glue.ts, loading glue first would reach them before they
 * exist. Here they are always ready, whichever module loads first.
 */
import type { ItemTask } from '../../core/work/tasks.js'
import { fireAndLog } from '../supervise.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'

/** A task was added. A hook may return work nobody awaits. */
type AddedHook = (rt: WorkspaceRuntime, task: ItemTask, stuck: boolean) => void | Promise<unknown>
const addedHooks: AddedHook[] = []
export function onTaskAdded(fn: AddedHook): void {
  addedHooks.push(fn)
}

/** A watch added a task: the runner and notifications hear of it. One hook's failure is logged, never the watch's. */
export function taskAdded(rt: WorkspaceRuntime, task: ItemTask, stuck: boolean): void {
  for (const fn of addedHooks) fireAndLog(rt, 'babysit', () => fn(rt, task, stuck))
}

/** Hooks run after every tick: the runner's pump. */
type TickHook = (rt: WorkspaceRuntime) => void | Promise<unknown>
const tickHooks: TickHook[] = []
export function onBabysitTick(fn: TickHook): void {
  tickHooks.push(fn)
}
export function runTickHooks(rt: WorkspaceRuntime): void {
  for (const fn of tickHooks) fireAndLog(rt, 'babysit', () => fn(rt))
}
