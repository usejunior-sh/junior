/**
 * Junior's log (Junior for engineers, M2): one feed of everything Junior did,
 * across items, newest first. Two views: All, and Sent (only what left your
 * Mac). Each Sent line says who allowed it: you, a rule (an advance
 * approval), or the policy (a push to your own branch, a draft PR). The log
 * is Junior's track record, and the unread dot on the Junior tab.
 *
 * Built from records the store already keeps: actions, finished tasks, job
 * runs. Pure and browser-safe: time is always an argument.
 */
import type { ActionAllowedBy, ActionKind, ActionStatus } from '../actions/types.js'
import { impactShown } from '../actions/view.js'
import { approvalIdIn } from '../approvals/approvals.js'
import { impactLine } from '../cards/impact.js'
import type { TaskState } from '../work/tasks.js'

export type LogFilter = 'all' | 'sent'

export type LogTone = 'green' | 'red' | 'yellow' | 'blue' | 'mute'

/** Who let a send go out. */
export type LogAllowed = { by: 'you' | 'rule' | 'free' | 'job' | 'other'; text: string }

export type LogLine = {
  /** stable: the record's own id, prefixed by its source */
  id: string
  at: number
  source: 'send' | 'task' | 'job'
  /** it left this machine */
  sent: boolean
  title: string
  /** a send's impact line: what it does, who sees it, as whom, can it be taken back (core/cards/impact.ts); only on one that reached someone, may have, or still could */
  impact?: string
  /** short state: "sent", "waiting on you", "fixed", "failed" */
  state: string
  tone: LogTone
  kind?: ActionKind
  allowed?: LogAllowed
  link?: string | null
  error?: string | null
  itemId?: string | null
  sessionId?: string | null
  /** where it came from, short: a chat's title, "babysit", a job's name */
  origin?: string | null
}

/** What the log reads, as the store keeps it (only the fields it needs). */
export type LogAction = {
  id: string
  sessionId: string
  sessionKind: string
  tool: string
  kind: ActionKind
  summary: string
  /** the call's input, long strings trimmed */
  args: Record<string, unknown>
  groupKey: string | null
  /** a held call's full args (your edit, once edited): what went out, word for word */
  queue?: { args?: Record<string, unknown> } | null
  status: ActionStatus
  link: string | null
  error: string | null
  allowedBy: ActionAllowedBy | null
  allowedDetail: string | null
  itemId: string | null
  attemptedAt: number
  settledAt: number | null
  updatedAt: number
}
export type LogTask = {
  id: string
  itemId: string
  title: string
  owner: string
  state: TaskState
  step?: string
  output?: { summary?: string }
  error?: string
  sessionId?: string
  endedAt?: number
}
export type LogJobRun = { sessionId: string; title: string; status: string; error?: string | null; matches?: number; at: number }

const ACTION_STATE: Record<ActionStatus, [string, LogTone]> = {
  attempted: ['going out', 'blue'],
  succeeded: ['sent', 'green'],
  failed: ['failed', 'red'],
  denied: ['you denied it', 'mute'],
  needs_you: ['waiting on you', 'yellow'],
  scheduled: ['approved', 'blue'],
  sending: ['sending', 'blue'],
  unknown: ['unknown', 'yellow'],
  sent_back: ['sent back', 'mute'],
  rejected: ['rejected', 'mute'],
  expired: ['expired', 'mute'],
}

const TASK_STATE: Partial<Record<TaskState, [string, LogTone]>> = {
  done: ['done', 'green'],
  failed: ['failed', 'red'],
  stopped: ['stopped', 'mute'],
  skipped: ['skipped', 'mute'],
}

/** "rule · DM Anirudha on Slack" (the approval's id dropped: the line is what you read). */
export function allowedOf(a: Pick<LogAction, 'allowedBy' | 'allowedDetail' | 'sessionKind'>): LogAllowed | undefined {
  const d = a.allowedDetail
  switch (a.allowedBy) {
    case 'prompt':
      return { by: 'you', text: d ? `you · ${d}` : 'you' }
    case 'rule':
      if (approvalIdIn(d)) return { by: 'rule', text: `rule · ${d!.replace(/\s*\(#[0-9a-f]{6}\)$/, '')}` }
      return a.sessionKind === 'job-run' ? { by: 'job', text: d ?? 'the job’s grants' } : { by: 'other', text: d ?? 'an allow rule' }
    case 'policy':
      return { by: 'free', text: d ?? 'Junior’s policy' }
    case 'mode':
      return { by: 'other', text: d ?? 'the session’s mode' }
    default:
      return undefined
  }
}

/** The impact line, from the args that went out (or wait to); nothing rather than a broken log over one odd record. */
function impactOfLine(a: LogAction): string | undefined {
  if (!impactShown(a.status)) return undefined
  try {
    return impactLine({ tool: a.tool, args: a.queue?.args ?? a.args ?? {}, kind: a.kind, link: a.link, groupKey: a.groupKey })
  } catch {
    return undefined
  }
}

export function actionLine(a: LogAction, origin: string | null): LogLine {
  const [state, tone] = ACTION_STATE[a.status]
  const sent = a.status === 'succeeded'
  const impact = impactOfLine(a)
  return {
    id: `send:${a.id}`,
    at: a.settledAt ?? a.updatedAt ?? a.attemptedAt,
    source: 'send',
    sent,
    title: a.summary,
    ...(impact ? { impact } : {}),
    state,
    tone,
    kind: a.kind,
    ...(a.status === 'succeeded' || a.status === 'failed' ? { allowed: allowedOf(a) } : {}),
    link: a.link,
    error: a.error,
    itemId: a.itemId,
    sessionId: a.sessionId.startsWith('task-') ? null : a.sessionId,
    origin,
  }
}

/** A finished task of Junior's. A reviewer request is its action's line instead. */
export function taskLine(t: LogTask): LogLine | null {
  const st = TASK_STATE[t.state]
  if (!st || t.owner !== 'junior' || !t.endedAt || t.step === 'request-review') return null
  return {
    id: `task:${t.id}`,
    at: t.endedAt,
    source: 'task',
    sent: false,
    title: t.output?.summary ? `${t.title}: ${t.output.summary}` : t.title,
    state: st[0],
    tone: st[1],
    error: t.error ?? null,
    itemId: t.itemId,
    sessionId: t.sessionId ?? null,
    origin: 'babysit',
  }
}

export function jobLine(r: LogJobRun): LogLine {
  const ok = r.status === 'ok'
  const found = typeof r.matches === 'number' ? ` · ${r.matches} found` : ''
  return {
    id: `job:${r.sessionId}`,
    at: r.at,
    source: 'job',
    sent: false,
    title: `Ran ${r.title}${found}`,
    state: ok ? 'done' : r.status,
    tone: ok ? 'green' : r.status === 'skipped' || r.status === 'slept' ? 'mute' : 'red',
    error: r.error ?? null,
    sessionId: r.sessionId,
    origin: r.title,
  }
}

/**
 * The feed: lines newest first, `before` (exclusive) for the next page, at
 * most `limit`. Sent keeps only what left this machine.
 */
export function logPage(lines: readonly LogLine[], filter: LogFilter, before: number | null, limit: number): { lines: LogLine[]; more: boolean } {
  const kept = lines.filter((l) => (filter === 'sent' ? l.sent : true) && (before === null || l.at < before))
  kept.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
  return { lines: kept.slice(0, limit), more: kept.length > limit }
}

/** The newest line's time: the unread dot is on while it is past when you last looked. */
export const latestAt = (lines: readonly LogLine[]): number => lines.reduce((m, l) => Math.max(m, l.at), 0)
