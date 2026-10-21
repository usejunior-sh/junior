/**
 * Capture: a session's event log, folded into action records. One fold for
 * both paths, the live stream (one event at a time, as it is persisted) and
 * the backfill (a stored log replayed), so a record reads the same however
 * it was made.
 *
 *   tool_use (sorted as an action)  → attempt
 *   permission_request / _resolved  → who allowed it, or that it was denied
 *   tool_result                     → succeeded (with its link) / failed / denied
 *
 * The tracker only emits ops; the caller applies them to the store with
 * `applyAttempt` / `applySettle` / `mergeActions`, which are pure too.
 */
import type { SessionEvent } from '../../shared/protocol.js'
import type { ActionStore } from '../store/types.js'
import { extractLink, pushedBranch, resultText } from './link.js'
import type { SortedAction } from './sort.js'
import type { ActionAllowedBy, ActionRecord, ActionStatus } from './types.js'

/** Who and where: fixed for a session, read once when its tracker starts. */
export type TrackContext = {
  sessionId: string
  sessionKind: string
  /** the session's permission mode (chats); null = the default (ask) */
  permissionMode: string | null
  jobId: string | null
  teamRunId: string | null
  itemId: string | null
}

export type SettlePatch = {
  status: ActionStatus
  link: string | null
  error: string | null
  allowedBy: ActionAllowedBy | null
  allowedDetail: string | null
  settledAt: number
  /** a push that named no branch: the branch the result says it updated */
  groupKey?: string
}

export type ActionOp =
  | { op: 'attempt'; record: ActionRecord }
  | { op: 'settle'; sessionId: string; toolUseId: string; patch: SettlePatch }

type Prompt = { id: string; behavior?: string }
type Pending = { name: string; input: Record<string, unknown>; sorted: SortedAction; prompt?: Prompt }
type LoosePrompt = { id: string; toolName: string; input: Record<string, unknown>; toolUseId?: string }

/** A Bash command is kept whole up to this. It is what the record is about. */
export const COMMAND_CAP = 20_000

/**
 * Args as stored: long strings clipped, so a 40 KB PR body doesn't ride in
 * every row. `keep` lifts the cap for named top-level fields (Bash's `command`).
 */
export function trimArgs(input: Record<string, unknown>, max = 600, keep: Record<string, number> = {}): Record<string, unknown> {
  const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}… (${v.length} chars)` : v)
  const out = trimInner(input, max)
  for (const [k, n] of Object.entries(keep)) if (typeof input[k] === 'string') out[k] = clip(input[k] as string, n)
  return out
}

function trimInner(input: Record<string, unknown>, max: number): Record<string, unknown> {
  const trim = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}… (${v.length} chars)` : v
    if (depth > 3) return Array.isArray(v) ? `[${v.length} items]` : v && typeof v === 'object' ? '{…}' : v
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => trim(x, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]))
    return v
  }
  return trim(input, 0) as Record<string, unknown>
}

/** A refusal rather than a failure: the call never ran. Our own and Claude Code's wordings. */
const DENIAL_RE =
  /^(?:Denied by the user|The session ended before this request was answered|This is a brief session|Permission to use \S+ (?:has been|was) denied)|(?:tool use was rejected|is not granted to this job|job runs may not|this job may only (?:run|use the skills|hand work to)|this job names no (?:skills|agents)|outside this job's folder)/i

const clipError = (s: string): string => (s.length > 400 ? `${s.slice(0, 399)}…` : s)

/** Stable JSON for comparing inputs (key order can differ between the prompt and the call). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

const pushKey = (sessionId: string, branch: string) => `push:${sessionId}:${branch || '?'}`

/**
 * The record for one call just made. The tracker's attempt, and the base a
 * held (queued) call is built on, so both read the same.
 */
export function recordFor(
  ctx: TrackContext,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  s: SortedAction,
  at: number,
): ActionRecord {
  return {
    id: `${ctx.sessionId}:${toolUseId}`,
    sessionId: ctx.sessionId,
    sessionKind: ctx.sessionKind,
    tool: name,
    kind: s.kind,
    summary: s.summary,
    args: trimArgs(input, 600, name === 'Bash' ? { command: COMMAND_CAP } : {}),
    status: 'attempted',
    link: null,
    error: null,
    why: s.why,
    whyDetail: s.whyDetail,
    allowedBy: null,
    allowedDetail: null,
    jobId: ctx.jobId,
    teamRunId: ctx.teamRunId,
    itemId: ctx.itemId,
    groupKey: s.pushBranch !== undefined ? pushKey(ctx.sessionId, s.pushBranch) : null,
    count: 1,
    calls: [toolUseId],
    attemptedAt: at,
    settledAt: null,
    updatedAt: at,
  }
}

export class ActionTracker {
  private readonly pending = new Map<string, Pending>()
  /** prompt id → the tool_use it asked about */
  private readonly promptOf = new Map<string, string>()
  /** prompts seen before their tool_use (or for calls that aren't actions); bounded */
  private loose: LoosePrompt[] = []

  constructor(
    readonly ctx: TrackContext,
    private readonly sort: (toolName: string, input: Record<string, unknown>) => SortedAction | null,
  ) {}

  /** Fold one event in; `at` = when it was stored. Returns what changed. */
  feed(ev: SessionEvent, at: number): ActionOp[] {
    if (ev.kind === 'permission_request') return this.onPrompt(ev)
    if (ev.kind === 'permission_resolved') return this.onResolved(ev.id, ev.behavior, at)
    if (ev.kind !== 'sdk') return []
    const m = ev.message
    const blocks = Array.isArray(m.message?.content) ? m.message.content : []
    const ops: ActionOp[] = []
    if (m.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
        const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
        const sorted = this.sort(b.name, input)
        if (!sorted) continue
        const p: Pending = { name: b.name, input, sorted }
        const li = this.loose.findIndex((l) => l.toolUseId === b.id || (!l.toolUseId && l.toolName === b.name && canon(l.input) === canon(input)))
        if (li !== -1) {
          p.prompt = { id: this.loose[li].id }
          this.promptOf.set(this.loose[li].id, b.id)
          this.loose.splice(li, 1)
        }
        this.pending.set(b.id, p)
        ops.push({ op: 'attempt', record: this.record(b.id, p, at) })
      }
    } else if (m.type === 'user') {
      for (const b of blocks) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const p = this.pending.get(b.tool_use_id)
        if (!p) continue
        this.pending.delete(b.tool_use_id)
        if (p.prompt) this.promptOf.delete(p.prompt.id)
        ops.push({ op: 'settle', sessionId: this.ctx.sessionId, toolUseId: b.tool_use_id, patch: this.outcome(p, resultText(b.content), b.is_error === true, at) })
      }
    }
    return ops
  }

  private onPrompt(ev: Extract<SessionEvent, { kind: 'permission_request' }>): ActionOp[] {
    // Exact when the event carries the call's id; else the oldest call it fits
    // that hasn't been asked about (logs from before the id was recorded).
    let id = ev.toolUseId && this.pending.has(ev.toolUseId) ? ev.toolUseId : undefined
    if (!id) {
      for (const [k, p] of this.pending) {
        if (!p.prompt && p.name === ev.toolName && canon(p.input) === canon(ev.input)) {
          id = k
          break
        }
      }
    }
    if (!id) {
      this.loose.push({ id: ev.id, toolName: ev.toolName, input: ev.input, ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}) })
      if (this.loose.length > 50) this.loose = this.loose.slice(-50)
      return []
    }
    this.pending.get(id)!.prompt = { id: ev.id }
    this.promptOf.set(ev.id, id)
    return []
  }

  private onResolved(promptId: string, behavior: string, at: number): ActionOp[] {
    const id = this.promptOf.get(promptId)
    const p = id ? this.pending.get(id) : undefined
    if (!id || !p?.prompt) return []
    p.prompt.behavior = behavior
    // A refused or expired prompt is final now: the call never ran, and an
    // expired one (the subprocess died) never gets a result to say so.
    if (behavior !== 'deny' && behavior !== 'expired') return []
    this.pending.delete(id)
    this.promptOf.delete(promptId)
    return [{ op: 'settle', sessionId: this.ctx.sessionId, toolUseId: id, patch: this.outcome(p, '', true, at) }]
  }

  /** The record for a call just made. */
  private record(toolUseId: string, p: Pending, at: number): ActionRecord {
    return recordFor(this.ctx, toolUseId, p.name, p.input, p.sorted, at)
  }

  /** How a call ended, and who let it run. */
  private outcome(p: Pending, text: string, isError: boolean, at: number): SettlePatch {
    const refused = p.prompt?.behavior === 'deny' || p.prompt?.behavior === 'expired'
    const status: ActionStatus = refused || (isError && DENIAL_RE.test(text.trim())) ? 'denied' : isError ? 'failed' : 'succeeded'
    const push = p.sorted.pushBranch !== undefined
    const branch = push && !p.sorted.pushBranch && status === 'succeeded' ? pushedBranch(text) : null
    const [allowedBy, allowedDetail] = status === 'denied' ? [null, null] : this.allowedBy(p)
    return {
      status,
      link: status === 'succeeded' ? extractLink(text, { push, bash: p.name === 'Bash' }) : null,
      error: status === 'succeeded' ? null : p.prompt?.behavior === 'expired' ? 'the session ended before the prompt was answered' : text ? clipError(text.trim()) : status === 'denied' ? 'denied' : null,
      allowedBy,
      allowedDetail,
      settledAt: at,
      ...(branch ? { groupKey: pushKey(this.ctx.sessionId, branch) } : {}),
    }
  }

  /** You, through a prompt; else the one policy (core/actions/policy.ts), a job's grants, a brief's policy, or an allow rule. */
  private allowedBy(p: Pending): [ActionAllowedBy, string | null] {
    if (p.prompt) return ['prompt', p.prompt.behavior === 'allow_always' ? 'always, for this session' : null]
    if (this.ctx.sessionKind === 'job-run') return ['rule', 'the job’s grants']
    if (this.ctx.sessionKind === 'brief') return ['policy', 'brief sessions']
    const mode = this.ctx.permissionMode
    // A chat's send that ran without a card: the policy made it free.
    if (mode === 'auto') return ['policy', p.sorted.kind === 'push' ? 'free: a push to your own branch' : p.sorted.kind === 'pr' ? 'free: a draft PR' : 'free']
    if (mode === 'bypassPermissions') return ['mode', 'never asks']
    return ['rule', mode === 'acceptEdits' ? 'an allow rule (accept-edits mode)' : 'an allow rule']
  }
}

// Applying ops to stored records: pure, so collapse and merge are testable.

/**
 * A new attempt against what the store already has. Its call already folded
 * in = nothing to do (a backfill run twice). A collapsing record (pushes to
 * one branch) gains a call; anything else is the attempt itself.
 */
export function applyAttempt(existing: ActionRecord | null, attempt: ActionRecord): ActionRecord | null {
  if (!existing) return attempt
  if (existing.calls.includes(attempt.calls[0])) return null
  return {
    ...existing,
    count: existing.count + 1,
    calls: [...existing.calls, ...attempt.calls],
    status: 'attempted',
    args: attempt.args,
    summary: attempt.summary,
    updatedAt: Math.max(existing.updatedAt, attempt.attemptedAt),
  }
}

/** A settle against the record its call belongs to. A collapsed record shows its latest outcome. */
export function applySettle(rec: ActionRecord, patch: SettlePatch): ActionRecord {
  return {
    ...rec,
    status: patch.status,
    link: patch.link ?? rec.link,
    error: patch.error,
    allowedBy: patch.allowedBy ?? rec.allowedBy,
    allowedDetail: patch.allowedBy ? patch.allowedDetail : rec.allowedDetail,
    settledAt: patch.settledAt,
    updatedAt: Math.max(rec.updatedAt, patch.settledAt),
    ...(patch.groupKey ? { groupKey: patch.groupKey } : {}),
  }
}

/**
 * Two records for one push group (a bare `git push` whose branch turned out
 * to be one already pushed to): one record, both calls, the earlier start,
 * the later outcome.
 */
export function mergeActions(into: ActionRecord, from: ActionRecord): ActionRecord {
  const later = from.updatedAt >= into.updatedAt ? from : into
  return {
    ...into,
    count: into.count + from.count,
    calls: [...new Set([...into.calls, ...from.calls])],
    attemptedAt: Math.min(into.attemptedAt, from.attemptedAt),
    status: later.status,
    link: later.link ?? into.link ?? from.link,
    error: later.error,
    allowedBy: later.allowedBy ?? into.allowedBy,
    allowedDetail: later.allowedBy ? later.allowedDetail : into.allowedDetail,
    settledAt: later.settledAt,
    updatedAt: Math.max(into.updatedAt, from.updatedAt),
  }
}

/**
 * Apply ops to the store, in order. An attempt whose call is already stored
 * is a no-op (a backfill run twice); a collapsing one (git push) joins its
 * branch's record. A settle updates the record its call belongs to, and a
 * bare push whose branch the result names joins that branch's record.
 * Returns the sessions whose records changed.
 */
export async function applyActionOps(store: ActionStore, ops: ActionOp[]): Promise<Set<string>> {
  const touched = new Set<string>()
  for (const op of ops) {
    if (op.op === 'attempt') {
      const a = op.record
      if (await store.byCall(a.sessionId, a.calls[0])) continue
      const next = applyAttempt(a.groupKey ? await store.byGroup(a.groupKey) : null, a)
      if (!next) continue
      await store.put(next)
      touched.add(a.sessionId)
    } else {
      const rec = await store.byCall(op.sessionId, op.toolUseId)
      if (!rec) continue
      // A held call's result is triage's own "queued" refusal: the record's
      // life is the queue's from here (core/actions/queue.ts), not the call's.
      if (rec.queue) continue
      let next = applySettle(rec, op.patch)
      if (op.patch.groupKey && op.patch.groupKey !== rec.groupKey) {
        const other = await store.byGroup(op.patch.groupKey)
        if (other && other.id !== rec.id) {
          await store.remove(rec.id)
          next = mergeActions(other, { ...next, groupKey: other.groupKey })
        }
      }
      await store.put(next)
      touched.add(op.sessionId)
    }
  }
  return touched
}

/**
 * An agent repeated a held call (same tool, same args) under a new tool_use:
 * point that call at the action already waiting rather than file a second
 * one. A record the tracker already made for the new call (its message beat
 * the hook) is dropped. Returns the held record, or null when it is gone.
 */
export async function joinHeldCall(store: ActionStore, sessionId: string, toolUseId: string, actionId: string): Promise<ActionRecord | null> {
  const held = await store.get(actionId)
  if (!held?.queue) return null
  const phantom = await store.byCall(sessionId, toolUseId)
  if (phantom && phantom.id !== held.id) await store.remove(phantom.id)
  if (held.calls.includes(toolUseId)) return held
  const next = { ...held, calls: [...held.calls, toolUseId] }
  await store.put(next)
  return next
}
