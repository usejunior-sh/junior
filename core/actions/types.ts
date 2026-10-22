/**
 * Actions: an effect a session had that left this machine. A PR opened, a
 * comment posted, a ticket filed, a push. Browser-safe: the web imports these
 * types and labels.
 */

/** What kind of thing went out: what the daily count line counts. */
export type ActionKind = 'pr' | 'comment' | 'ticket' | 'post' | 'message' | 'email' | 'push' | 'merge' | 'release' | 'update' | 'other'

export const ACTION_KINDS: readonly ActionKind[] = ['pr', 'comment', 'ticket', 'post', 'message', 'email', 'push', 'merge', 'release', 'update', 'other']
export const isActionKind = (v: unknown): v is ActionKind => ACTION_KINDS.includes(v as ActionKind)

/** Singular and plural, for "Today: 3 PRs, 1 comment". */
export const KIND_LABEL: Record<ActionKind, [string, string]> = {
  pr: ['PR', 'PRs'],
  comment: ['comment', 'comments'],
  ticket: ['ticket', 'tickets'],
  post: ['post', 'posts'],
  message: ['message', 'messages'],
  email: ['email', 'emails'],
  push: ['push', 'pushes'],
  merge: ['merge', 'merges'],
  release: ['release', 'releases'],
  update: ['update', 'updates'],
  other: ['other action', 'other actions'],
}

/**
 * Where an action is. Recorded as it ran:
 *   attempted  the call was made and nothing has come back yet
 *   succeeded / failed / denied
 * Queued (core/actions/queue.ts: a job run's or a team worker's connector
 * call held for you instead of run):
 *   needs_you  waiting on your approve / edit / send back / reject
 *   scheduled  approved; goes out at `queue.sendAt` (undo until then)
 *   sending    claimed by the dispatcher; the one-tool run is out
 *   unknown    the dispatch run died after the tool may have run, check before retrying
 *   sent_back  returned to the session that drafted it, with your notes
 *   rejected   you said no
 *   expired    nobody answered in time
 */
export type ActionStatus =
  | 'attempted'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'needs_you'
  | 'scheduled'
  | 'sending'
  | 'unknown'
  | 'sent_back'
  | 'rejected'
  | 'expired'
export const ACTION_STATUSES: readonly ActionStatus[] = [
  'attempted',
  'succeeded',
  'failed',
  'denied',
  'needs_you',
  'scheduled',
  'sending',
  'unknown',
  'sent_back',
  'rejected',
  'expired',
]
export const isActionStatus = (v: unknown): v is ActionStatus => ACTION_STATUSES.includes(v as ActionStatus)

/**
 * A queued action's approval state. Absent on an action recorded
 * as it ran, only a held call has one.
 */
export type ActionQueue = {
  /** the call's input in full, never trimmed, what goes out, word for word (your edit, once edited) */
  args: Record<string, unknown>
  queuedAt: number
  /** past this, a waiting action expires */
  expiresAt: number
  /** approved: when it goes out; null while it waits on you */
  sendAt: number | null
  /** your latest send-back notes or reject reason */
  note: string | null
  /** how many times you edited the args */
  edits: number
  /** sent back: whether the drafting session got the notes, or why not */
  delivery: string | null
  /** the dispatch run's cost, when it reported one */
  costUsd: number | null
}

/** Who moved an action. */
export type ActionActor = 'agent' | 'you' | 'junior'

/** One step in a queued action's life, append-only, newest last. */
export type ActionHistoryEntry = {
  actionId: string
  at: number
  actor: ActionActor
  /** what happened: queued, approved, edited, undone, sent back, rejected, expired, sending, succeeded, failed, unknown, retried */
  event: string
  from: ActionStatus | null
  to: ActionStatus
  /** notes, a reason, an error */
  note: string | null
  /** the args as they stood after this step, when it changed them (queued = the original; edited = your version) */
  args: Record<string, unknown> | null
}

/**
 * Why a call counted as an action, every record says.
 * annotation: the MCP server's own tool annotations said it writes.
 * name verb: the tool's name has a write verb (create, send, comment…).
 * unknown: an MCP tool with neither a read nor a write verb, counted, to be safe.
 * bash pattern: a Bash command matched the outbound list.
 * override: the actions file names this tool as an action.
 */
export type ActionWhy = 'annotation' | 'name verb' | 'unknown' | 'bash pattern' | 'override'
export const ACTION_WHYS: readonly ActionWhy[] = ['annotation', 'name verb', 'unknown', 'bash pattern', 'override']
export const isActionWhy = (v: unknown): v is ActionWhy => ACTION_WHYS.includes(v as ActionWhy)

/**
 * Who let it run.
 * prompt: you, by answering a permission prompt.
 * mode: the session's permission mode (bypass or auto) let it through.
 * rule: an allow rule, your settings, an "always allow" earlier in the
 *       session, or a job's grants.
 * policy: Junior's own fixed policy for that kind of session (a brief).
 */
export type ActionAllowedBy = 'prompt' | 'mode' | 'rule' | 'policy'
export const ACTION_ALLOWED_BY: readonly ActionAllowedBy[] = ['prompt', 'mode', 'rule', 'policy']
export const isActionAllowedBy = (v: unknown): v is ActionAllowedBy => ACTION_ALLOWED_BY.includes(v as ActionAllowedBy)

export type ActionRecord = {
  /** `<sessionId>:<first tool_use id>`: deterministic, so a backfill can't duplicate */
  id: string
  sessionId: string
  /** chat, job-run or brief, a team worker is a chat with `teamRunId` */
  sessionKind: string
  tool: string
  kind: ActionKind
  /** one line: what happened ("Open PR: Fix the flaky test") */
  summary: string
  /** the call's input, long strings trimmed */
  args: Record<string, unknown>
  status: ActionStatus
  /** where it landed: the PR, the comment, the ticket */
  link: string | null
  /** what came back when it failed or was denied, trimmed */
  error: string | null
  why: ActionWhy
  /** the verb, the pattern or the annotation that decided it */
  whyDetail: string | null
  /** null while attempted, and for a denied call */
  allowedBy: ActionAllowedBy | null
  /** the mode's name, the rule's source, … */
  allowedDetail: string | null
  jobId: string | null
  teamRunId: string | null
  itemId: string | null
  /** set on records that collapse (one `git push` record per branch per session) */
  groupKey: string | null
  /** how many calls this record stands for (pushes to one branch) */
  count: number
  /** every tool_use id folded into this record, oldest first */
  calls: string[]
  attemptedAt: number
  settledAt: number | null
  updatedAt: number
  /** a held call's approval state; absent on one recorded as it ran */
  queue?: ActionQueue | null
}
