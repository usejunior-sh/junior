/**
 * Tasks: one piece of work on an item, owned by you or Junior. An item grows
 * a task list: its playbook adds some, PR events add more (CI red → "Fix CI"),
 * and you or Junior add the rest. Each Junior task runs as a short fresh
 * session; what it learned goes back on the item (fields.ts memory), what it
 * produced is its output line.
 *
 * Pure: types, the state rules and the row's progress line. The store is
 * core/store (ItemTaskStore), the runner server/tasks.
 */

export type TaskOwner = 'you' | 'junior'
export type TaskState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'stopped'
/** Why the task was added: its playbook, an event on the item, you, or Junior. */
export type TaskWhy = 'playbook' | 'event' | 'you' | 'junior'

export interface TaskOutput {
  /** one line: "removed the unused import in api.ts" */
  summary: string
  /** a longer write-up, when there is one */
  artifactId?: string
  /** the commit it pushed, when it pushed one; a review's: the head it read */
  sha?: string
  /** a first-pass review's verdict (core/review/brief.ts) */
  verdict?: 'approve' | 'comment' | 'request_changes'
}

export interface ItemTask {
  id: string
  itemId: string
  /** "Fix lint", "Rebase on main", "Request Anirudha" */
  title: string
  owner: TaskOwner
  state: TaskState
  why: TaskWhy
  /** the detail behind `why`: "CI red: lint", "babysit" */
  whyDetail?: string
  /** what the runner does: a playbook step, e.g. 'fix-ci', 'fix-thread', 'rebase', 'request-review' */
  step?: string
  /** step input the runner needs (check names, thread ids, the sha); JSON-safe */
  input?: Record<string, unknown>
  /** dedupe key, unique per item: the same event never adds a second task ("checks_failed@abc123") */
  key?: string
  output?: TaskOutput
  /** why it failed or stopped */
  error?: string
  sessionId?: string
  model?: string
  costUsd?: number
  attempts: number
  createdAt: number
  startedAt?: number
  endedAt?: number
}

export type NewTask = Pick<ItemTask, 'itemId' | 'title' | 'owner' | 'why'> &
  Partial<Pick<ItemTask, 'whyDetail' | 'step' | 'input' | 'key' | 'model'>> & { id?: string; state?: 'queued' | 'waiting' }

export const TASK_STATES: readonly TaskState[] = ['queued', 'running', 'waiting', 'done', 'failed', 'skipped', 'stopped']
const FINISHED: ReadonlySet<TaskState> = new Set(['done', 'failed', 'skipped', 'stopped'])

export const isTaskState = (v: unknown): v is TaskState => typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v)
export const isFinished = (t: Pick<ItemTask, 'state'>) => FINISHED.has(t.state)

/**
 * The moves a task may make. Running only from queued (the runner takes it);
 * a finished task never moves again, so a late result can't revive a task
 * you stopped. Waiting = on you (an approval, an answer), and goes back to
 * queued or on to finished.
 */
const MOVES: Record<TaskState, readonly TaskState[]> = {
  queued: ['running', 'waiting', 'skipped', 'stopped'],
  running: ['done', 'failed', 'waiting', 'stopped', 'queued'],
  waiting: ['queued', 'done', 'skipped', 'stopped'],
  done: [],
  failed: [],
  skipped: [],
  stopped: [],
}

export function canMove(from: TaskState, to: TaskState): boolean {
  return MOVES[from].includes(to)
}

/** What a running task is doing, as the row says it: "Fix lint" → "fixing lint". */
function doing(t: ItemTask): string {
  const [verb, ...rest] = t.title.split(' ')
  const ing = ING[verb.toLowerCase()]
  return ing ? [ing, ...rest].join(' ') : t.title.charAt(0).toLowerCase() + t.title.slice(1)
}
const ING: Record<string, string> = {
  fix: 'fixing',
  rebase: 'rebasing',
  rerun: 'rerunning',
  request: 'requesting',
  review: 'reviewing',
  post: 'posting',
  check: 'checking',
  answer: 'answering',
  plan: 'planning',
  investigate: 'investigating',
  resolve: 'resolving',
}

/**
 * The Junior tab row's one line: "2 of 3 · fixing Bugbot comment". Counts
 * skip skipped tasks; null when the item has no tasks.
 */
export function progressLine(tasks: readonly ItemTask[]): string | null {
  const counted = tasks.filter((t) => t.state !== 'skipped')
  if (counted.length === 0) return null
  const done = counted.filter((t) => t.state === 'done').length
  const head = `${done} of ${counted.length}`
  const running = counted.find((t) => t.state === 'running')
  if (running) return `${head} · ${doing(running)}`
  const waiting = counted.find((t) => t.state === 'waiting')
  if (waiting) return `${head} · waiting on you: ${waiting.title}`
  const failed = [...counted].reverse().find((t) => t.state === 'failed')
  if (failed && !counted.some((t) => t.state === 'queued')) return `${head} · stuck: ${failed.title}`
  const queued = counted.find((t) => t.state === 'queued')
  if (queued) return `${head} · next: ${queued.title}`
  return head
}

/** What the inbox row and the Junior tab need of an item's tasks. */
export type TaskSummary = {
  /** progressLine: "2 of 3 · fixing Bugbot comment" */
  line: string | null
  running: boolean
  queued: number
  /** tasks waiting on you, and Junior's failures since its last finished task */
  needsYou: number
  /** the newest task waiting on you, for its button */
  next: Pick<ItemTask, 'id' | 'title' | 'step' | 'owner' | 'error'> | null
  /** the newest done task's line, for "Fix lint ✓" */
  lastDone: string | null
}

export function taskSummary(tasks: readonly ItemTask[]): TaskSummary | null {
  if (tasks.length === 0) return null
  const lastDoneAt = Math.max(0, ...tasks.filter((t) => t.state === 'done').map((t) => t.endedAt ?? t.createdAt))
  const waiting = tasks.filter((t) => t.state === 'waiting')
  const failed = tasks.filter((t) => t.state === 'failed' && t.createdAt > lastDoneAt)
  const asks = [...waiting, ...failed].sort((a, b) => b.createdAt - a.createdAt)
  const done = [...tasks].reverse().find((t) => t.state === 'done')
  return {
    line: progressLine(tasks),
    running: tasks.some((t) => t.state === 'running'),
    queued: tasks.filter((t) => t.state === 'queued' && t.owner === 'junior').length,
    needsYou: asks.length,
    next: asks[0] ? { id: asks[0].id, title: asks[0].title, owner: asks[0].owner, ...(asks[0].step ? { step: asks[0].step } : {}), ...(asks[0].error ? { error: asks[0].error } : {}) } : null,
    lastDone: done ? `${done.title} \u2713${done.output?.summary ? ` · ${done.output.summary}` : ''}` : null,
  }
}
