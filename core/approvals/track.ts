/**
 * Track record: how your decisions on Junior's held sends went, counted.
 * The numbers behind "You approved my last 12 dependency PRs unchanged".
 *
 * Input is the held actions (core/actions/queue.ts: the ones with a `queue`)
 * and each one's history. Every one gets exactly one outcome:
 *
 *   rejected    you said no
 *   sent-back   you asked for changes
 *   undone      you approved, then took it back (even if approved again)
 *   edited      you changed what went out (whitespace-only changes don't count)
 *   quick       approved unchanged in under QUICK_MS: counted, never a streak
 *   as-drafted  approved unchanged, after a real look
 *   expired     nobody answered in time: not a decision
 *   waiting     not decided yet: not a decision
 *
 * The streak is the run of as-drafted approvals, newest first, up to the
 * last edited, sent-back, rejected or undone one. Quick approvals and
 * undecided records neither extend nor break it.
 *
 * Data only: nothing here creates a rule, an approval or a proposal.
 * Pure and browser-safe: time is always an argument.
 */
import { callTarget } from './approvals.js'
import type { ActionHistoryEntry, ActionKind, ActionRecord } from '../actions/types.js'

/** Approved faster than this, it was a reflex, not a review. */
export const QUICK_MS = 2_000

/** Who a send reaches, by kind. */
export type RecipientClass = 'person' | 'channel' | 'repo' | 'unknown'

export type TrackOutcome = 'as-drafted' | 'quick' | 'edited' | 'sent-back' | 'rejected' | 'undone' | 'expired' | 'waiting'

/** What to count. Every field narrows; an empty scope counts everything. */
export type TrackScope = {
  kind?: ActionKind
  /** `owner/name`, case-insensitive */
  repo?: string
  recipient?: RecipientClass
  /** only sends one job drafted */
  jobId?: string
}

export type TrackInput = { record: ActionRecord; history: readonly ActionHistoryEntry[] }

/** One record, judged. */
export type TrackJudged = {
  id: string
  outcome: TrackOutcome
  queuedAt: number
  /** your first decision on it: approve, edit and approve, send back, reject */
  decidedAt: number | null
  /** queued → decided, where both are known */
  decisionMs: number | null
}

export type TrackRecord = {
  /** decided records: every outcome but expired and waiting */
  total: number
  approvedAsDrafted: number
  quick: number
  edited: number
  sentBack: number
  rejected: number
  undone: number
  expired: number
  waiting: number
  /** as-drafted approvals in a row, newest first */
  streak: number
  /** median queued → decided over decided records with both times, null when none */
  medianDecisionMs: number | null
  /** the newest decision counted, null when none */
  lastDecidedAt: number | null
}

export type TrackOptions = {
  now: number
  /** only records queued in the last `windowMs` (default: all time) */
  windowMs?: number
}

const DECISIONS = new Set(['approved', 'edited and approved', 'sent back', 'rejected'])
const APPROVED_STATUSES = new Set(['scheduled', 'sending', 'succeeded', 'failed', 'unknown'])

/** Strings with every run of whitespace made one space, and trimmed: so a stray newline isn't an edit. */
export function normalizeWhitespace(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim()
  if (Array.isArray(v)) return v.map(normalizeWhitespace)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeWhitespace(x)]))
  return v
}

/** Stable JSON, object keys sorted: queue.ts's canonJson, kept here so this file stays browser-safe. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** Same content once whitespace is normalised. */
export const sameText = (a: unknown, b: unknown): boolean => canon(normalizeWhitespace(a)) === canon(normalizeWhitespace(b))

/**
 * Did what went out differ from the draft? Compares the queued args (the
 * history's `queued` line) with the args as approved. Without the original
 * on file, falls back to the queue's own edit count, which can't see
 * whitespace.
 */
export function wasEdited(input: TrackInput): boolean {
  const q = input.record.queue
  if (!q) return false
  const original = input.history.find((e) => e.event === 'queued' && e.args)?.args
  if (original) return !sameText(original, q.args)
  return q.edits > 0
}

/** Judge one held record. Null for a record that was never held (nothing to decide). */
export function judge(input: TrackInput): TrackJudged | null {
  const { record: r, history } = input
  const q = r.queue
  if (!q) return null
  const first = history.find((e) => e.actor === 'you' && DECISIONS.has(e.event))
  const base = { id: r.id, queuedAt: q.queuedAt }
  const timed = (outcome: TrackOutcome, decidedAt: number | null = first?.at ?? null): TrackJudged => ({
    ...base,
    outcome,
    decidedAt,
    decisionMs: decidedAt !== null && decidedAt >= q.queuedAt ? decidedAt - q.queuedAt : null,
  })
  // A no is final, whatever came before it. Without history, settling is when you said it.
  if (r.status === 'rejected') return timed('rejected', first?.at ?? r.settledAt)
  if (r.status === 'sent_back') return timed('sent-back', first?.at ?? r.settledAt)
  if (history.some((e) => e.event === 'undone')) return timed('undone')
  if (r.status === 'expired') return { ...base, outcome: 'expired', decidedAt: null, decisionMs: null }
  if (r.status === 'needs_you' || !APPROVED_STATUSES.has(r.status)) return { ...base, outcome: 'waiting', decidedAt: null, decisionMs: null }
  if (wasEdited(input)) return timed('edited')
  const j = timed('as-drafted')
  return j.decisionMs !== null && j.decisionMs < QUICK_MS ? { ...j, outcome: 'quick' } : j
}

/** `owner/name` from a GitHub URL, `-R`/`--repo`, or a connector's repo fields. */
export function repoOf(r: Pick<ActionRecord, 'args' | 'link' | 'tool'> & { queue?: ActionRecord['queue'] }): string | null {
  const args = r.queue?.args ?? r.args
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const owner = str(args.owner)
  const name = str(args.repo) ?? str(args.repository)
  if (name && /^[\w.-]+\/[\w.-]+$/.test(name)) return name.toLowerCase()
  if (owner && name && /^[\w.-]+$/.test(name)) return `${owner}/${name}`.toLowerCase()
  if (r.tool === 'Bash') {
    const m = /(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?([\w.-]+\/[\w.-]+)/.exec(String(args.command ?? ''))
    if (m) return m[1].toLowerCase()
  }
  const url = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(r.link ?? '')
  return url ? `${url[1]}/${url[2]}`.toLowerCase() : null
}

/** Who a send reaches: a person (a DM, an email, a review request), a channel, a repo, or unknown. */
export function recipientOf(r: Pick<ActionRecord, 'args' | 'link' | 'tool'> & { queue?: ActionRecord['queue'] }): RecipientClass {
  const args = r.queue?.args ?? r.args
  const target = callTarget(r.tool, args)
  if (target) return target.what === 'slack-post' ? 'channel' : 'person'
  if (['to', 'recipient', 'recipients', 'user', 'user_id'].some((k) => args[k] !== undefined)) return 'person'
  if (['channel', 'channel_id', 'channel_name'].some((k) => args[k] !== undefined)) return 'channel'
  return repoOf(r) ? 'repo' : 'unknown'
}

export function inScope(r: ActionRecord, scope: TrackScope): boolean {
  if (scope.kind && r.kind !== scope.kind) return false
  if (scope.jobId && r.jobId !== scope.jobId) return false
  if (scope.repo && repoOf(r) !== scope.repo.trim().toLowerCase()) return false
  if (scope.recipient && recipientOf(r) !== scope.recipient) return false
  return true
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Judge every in-scope held record, newest first. */
export function judgeAll(inputs: readonly TrackInput[], scope: TrackScope, opts: TrackOptions): TrackJudged[] {
  const from = opts.windowMs !== undefined ? opts.now - opts.windowMs : -Infinity
  const out: TrackJudged[] = []
  for (const input of inputs) {
    const q = input.record.queue
    if (!q || q.queuedAt < from || q.queuedAt > opts.now || !inScope(input.record, scope)) continue
    const j = judge(input)
    // a decision after `now` hasn't happened yet, on this clock
    if (j) out.push(j.decidedAt !== null && j.decidedAt > opts.now ? { ...j, outcome: 'waiting', decidedAt: null, decisionMs: null } : j)
  }
  const at = (j: TrackJudged) => j.decidedAt ?? j.queuedAt
  return out.sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The track record for a scope. */
export function trackRecord(inputs: readonly TrackInput[], scope: TrackScope, opts: TrackOptions): TrackRecord {
  const judged = judgeAll(inputs, scope, opts)
  const n = (o: TrackOutcome) => judged.filter((j) => j.outcome === o).length
  let streak = 0
  for (const j of judged) {
    if (j.outcome === 'as-drafted') streak++
    else if (j.outcome === 'edited' || j.outcome === 'sent-back' || j.outcome === 'rejected' || j.outcome === 'undone') break
  }
  const decided = judged.filter((j) => j.outcome !== 'expired' && j.outcome !== 'waiting')
  return {
    total: decided.length,
    approvedAsDrafted: n('as-drafted'),
    quick: n('quick'),
    edited: n('edited'),
    sentBack: n('sent-back'),
    rejected: n('rejected'),
    undone: n('undone'),
    expired: n('expired'),
    waiting: n('waiting'),
    streak,
    medianDecisionMs: median(decided.flatMap((j) => (j.decisionMs !== null ? [j.decisionMs] : []))),
    lastDecidedAt: decided.reduce<number | null>((m, j) => (j.decidedAt !== null && (m === null || j.decidedAt > m) ? j.decidedAt : m), null),
  }
}
