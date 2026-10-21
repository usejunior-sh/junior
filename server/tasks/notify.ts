/**
 * Mac notifications for tasks: only when you have to act (plan artifact
 * cb50520f, "Notifications"). A reviewer request waiting for your OK, Junior
 * stuck on a task, the daily budget spent. Routine work (a fix pushed, a
 * rebase done) shows in the item's task list, never here.
 *
 * Server-side `osascript`, like a job's notify: the daemon runs whether or
 * not Triage.app is open. macOS only; elsewhere, the log line is all.
 */
import type { ItemTask } from '../../core/work/tasks.js'
import { pExecFile } from '../config.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'

export type NeedsYou =
  | { kind: 'review'; task: ItemTask }
  | { kind: 'stuck'; task: ItemTask }
  | { kind: 'budget'; spent: number; limit: number; waiting: number }

/** The notification's title and line, or null for one that shouldn't ping. Pure. */
export function needsYouText(n: NeedsYou, pr: string | null): { title: string; body: string } | null {
  switch (n.kind) {
    case 'review':
      return { title: `${pr ?? 'Your PR'} is green`, body: `${n.task.title}? Junior waits for your OK.` }
    case 'stuck':
      return { title: `Junior is stuck${pr ? ` on ${pr}` : ''}`, body: n.task.error ? `${n.task.title}: ${n.task.error}` : n.task.title }
    case 'budget':
      return { title: 'Junior paused: daily budget spent', body: `$${n.spent.toFixed(2)} of $${n.limit}. ${n.waiting} task${n.waiting === 1 ? '' : 's'} wait${n.waiting === 1 ? 's' : ''} for tomorrow or a higher budget.` }
  }
}

const prName = (itemId: string) => /^github:([\w.-]+\/[\w.-]+#\d+)$/.exec(itemId)?.[1] ?? null

/** AppleScript string literal: backslashes and quotes escaped. */
const as = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 240)}"`

export function taskNeedsYou(rt: WorkspaceRuntime, n: NeedsYou): void {
  const text = needsYouText(n, 'task' in n ? prName(n.task.itemId) : null)
  if (!text) return
  log('info', 'tasks', `needs you: ${text.title} — ${text.body}`, { workspace: rt.meta.id })
  if (process.platform !== 'darwin' || process.env.TRIAGE_NO_NOTIFY) return
  pExecFile('osascript', ['-e', `display notification ${as(text.body)} with title ${as(text.title)} subtitle "Triage"`]).catch((err) =>
    log('warn', 'tasks', `could not notify: ${errText(err)}`, { workspace: rt.meta.id }),
  )
}
