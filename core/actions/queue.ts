/**
 * Phase 2 of the actions spec (7ce2f076): queue → approve → dispatch.
 *
 * In a watch run or a team worker, a connector call that sorts as an action
 * is held instead of run: the agent is told it was queued, and the call waits
 * here for you. Every status change goes through `move`, which says what is
 * allowed from where and writes the history line for it:
 *
 *   (held call)  → needs_you                       queue      agent
 *   needs_you    → scheduled   sendAt = now + 15s  approve    you   (with args = edit, then approve)
 *   needs_you    → sent_back                       send back  you   (notes go to the drafting session)
 *   needs_you    → rejected                        reject     you
 *   needs_you    → expired     now ≥ expiresAt     expire     triage
 *   scheduled    → needs_you   now < sendAt        undo       you
 *   scheduled    → sending     now ≥ sendAt        claim      triage (one atomic update — never twice)
 *   sending      → succeeded | failed | unknown    settle     triage
 *   failed | unknown → scheduled                   retry      you
 *
 * The dispatch run is the only sender: a headless one-tool run, fenced so the
 * call goes out only with the approved args, exactly once (`dispatchFence`).
 * Pure: time is always an argument.
 */
import { extractLink } from './link.js'
import { trimArgs } from './track.js'
import type { ActionActor, ActionHistoryEntry, ActionRecord, ActionStatus } from './types.js'
import { shortActionId } from './view.js'

/** A held call waits this long for you, then expires. */
export const QUEUE_TTL_MS = 24 * 3_600_000
/** Approve → this long to undo before it goes out. */
export const UNDO_MS = 15_000
/** Send-back notes and reject reasons are kept up to this long. */
export const NOTE_CAP = 4_000

/** Stable JSON: object keys sorted, so two inputs compare by content, not key order. */
export function canonJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** Deep equality of two args objects — the dispatch fence's whole test. */
export const argsEqual = (a: unknown, b: unknown): boolean => canonJson(a) === canonJson(b)

/** A plain JSON object (what a tool's input is), not an array or a scalar. */
export const isArgsObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** What the agent is told when its call is held — the deny reason it reads. */
export function queuedMessage(actionId: string): string {
  return (
    `Queued for the user's approval as action #${shortActionId(actionId)}. ` +
    `It will be sent exactly as written once approved. Don't retry or work around it — ` +
    `carry on with the rest of your task, and mention the queued action in your summary.`
  )
}

/**
 * A watch's dry run (preview) never sends: a call that sorts as an action —
 * a connector write or an outbound command — is refused with this, and listed
 * in the preview as what the real run would queue for approval.
 */
export const DRY_RUN_MESSAGE = 'dry run: this would be queued for approval — nothing was sent. Carry on as if it had been queued.'

/** The dry run's veto, past the watch's own fence: what counts as an action is refused, the rest passes. */
export function dryRunDecision(sorted: { summary: string } | null): FenceDecision {
  return sorted ? { allow: false, reason: DRY_RUN_MESSAGE } : { allow: true }
}

/** What a session hears when you send its action back. */
export function sendBackMessage(actionId: string, tool: string, notes: string): string {
  return (
    `Action #${shortActionId(actionId)} (${tool}) was sent back with notes:\n\n${notes}\n\n` +
    `Redraft it and call the tool again. The new call will be queued for approval the same way.`
  )
}

/**
 * A held call as a record: the tracker's own record of the call (or the
 * attempt it already stored, if the call's message beat the hold), now
 * waiting on you, with the full args kept for dispatch.
 */
export function heldRecord(base: ActionRecord, fullArgs: Record<string, unknown>, now: number): ActionRecord {
  return {
    ...base,
    status: 'needs_you',
    args: trimArgs(fullArgs),
    link: null,
    error: null,
    allowedBy: null,
    allowedDetail: null,
    settledAt: null,
    updatedAt: now,
    queue: {
      args: fullArgs,
      queuedAt: now,
      expiresAt: now + QUEUE_TTL_MS,
      sendAt: null,
      note: null,
      edits: 0,
      delivery: null,
      costUsd: null,
    },
  }
}

/** The history line for a held call. */
export function heldEntry(rec: ActionRecord, fullArgs: Record<string, unknown>, now: number): ActionHistoryEntry {
  return { actionId: rec.id, at: now, actor: 'agent', event: 'queued', from: null, to: 'needs_you', note: null, args: fullArgs }
}

export type ActionMove =
  /** with `args`: edit, then approve — the edited args are what goes out */
  | { type: 'approve'; args?: Record<string, unknown> }
  | { type: 'undo' }
  | { type: 'send_back'; notes: string }
  | { type: 'reject'; reason: string }
  | { type: 'expire' }
  | { type: 'claim' }
  | { type: 'settle'; status: 'succeeded' | 'failed' | 'unknown'; link?: string | null; error?: string | null; costUsd?: number | null }
  | { type: 'retry' }

export type MoveResult = { ok: true; next: ActionRecord; entry: ActionHistoryEntry } | { ok: false; error: string }

const ACTOR: Record<ActionMove['type'], ActionActor> = {
  approve: 'you',
  undo: 'you',
  send_back: 'you',
  reject: 'you',
  expire: 'triage',
  claim: 'triage',
  settle: 'triage',
  retry: 'you',
}

/** Where each move may start from. */
export const MOVE_FROM: Record<ActionMove['type'], readonly ActionStatus[]> = {
  approve: ['needs_you'],
  undo: ['scheduled'],
  send_back: ['needs_you'],
  reject: ['needs_you'],
  expire: ['needs_you'],
  claim: ['scheduled'],
  settle: ['sending'],
  retry: ['failed', 'unknown'],
}

const STATUS_WORD: Partial<Record<ActionStatus, string>> = {
  needs_you: 'waiting on you',
  scheduled: 'approved',
  sending: 'going out',
  sent_back: 'sent back',
  rejected: 'rejected',
  expired: 'expired',
  succeeded: 'sent',
  failed: 'failed',
  unknown: 'unknown',
}

const clipNote = (s: string): string => (s.length > NOTE_CAP ? `${s.slice(0, NOTE_CAP - 1)}…` : s)

/**
 * One move on a queued action: the next record and its history line, or why
 * not. Never mutates `rec`.
 */
export function move(rec: ActionRecord, m: ActionMove, now: number): MoveResult {
  const q = rec.queue
  if (!q) return { ok: false, error: 'this action was recorded as it ran — there is nothing to approve' }
  if (!MOVE_FROM[m.type].includes(rec.status)) {
    return { ok: false, error: `can't ${m.type.replace('_', ' ')} an action that is ${STATUS_WORD[rec.status] ?? rec.status}` }
  }
  const at = (to: ActionStatus, event: string, patch: Partial<ActionRecord>, note: string | null = null, args: Record<string, unknown> | null = null): MoveResult => ({
    ok: true,
    next: { ...rec, ...patch, status: to, updatedAt: Math.max(rec.updatedAt, now) },
    entry: { actionId: rec.id, at: now, actor: ACTOR[m.type], event, from: rec.status, to, note, args },
  })
  switch (m.type) {
    case 'approve': {
      if (now >= q.expiresAt) return { ok: false, error: 'this action expired — it can no longer be approved' }
      const edited = m.args !== undefined && !argsEqual(m.args, q.args)
      const args = edited ? m.args! : q.args
      return at(
        'scheduled',
        edited ? 'edited and approved' : 'approved',
        { ...(edited ? { args: trimArgs(args) } : {}), queue: { ...q, args, sendAt: now + UNDO_MS, edits: q.edits + (edited ? 1 : 0) } },
        null,
        edited ? args : null,
      )
    }
    case 'undo':
      if (q.sendAt !== null && now >= q.sendAt) return { ok: false, error: 'too late to undo — it is already going out' }
      return at('needs_you', 'undone', { queue: { ...q, sendAt: null } })
    case 'send_back': {
      const notes = m.notes.trim()
      if (!notes) return { ok: false, error: 'say what to change — send back needs notes' }
      return at('sent_back', 'sent back', { settledAt: now, queue: { ...q, note: clipNote(notes), delivery: null } }, clipNote(notes))
    }
    case 'reject': {
      const reason = m.reason.trim()
      return at('rejected', 'rejected', { settledAt: now, queue: { ...q, note: reason ? clipNote(reason) : null } }, reason ? clipNote(reason) : null)
    }
    case 'expire':
      if (now < q.expiresAt) return { ok: false, error: 'not expired yet' }
      return at('expired', 'expired', { settledAt: now })
    case 'claim':
      if (q.sendAt === null || now < q.sendAt) return { ok: false, error: 'not due yet' }
      return at('sending', 'sending', {})
    case 'settle':
      return at(
        m.status,
        m.status,
        {
          link: m.link ?? null,
          error: m.status === 'succeeded' ? null : m.error ?? null,
          settledAt: now,
          allowedBy: 'prompt',
          allowedDetail: q.edits ? 'edited, then approved' : 'approved',
          queue: { ...q, costUsd: m.costUsd ?? q.costUsd },
        },
        m.status === 'succeeded' ? null : m.error ?? null,
      )
    case 'retry':
      return at('scheduled', 'retried', { error: null, settledAt: null, queue: { ...q, sendAt: now + UNDO_MS } })
  }
}

/** Approved and its time has come: the dispatcher may claim it. */
export const dueToSend = (rec: Pick<ActionRecord, 'status' | 'queue'>, now: number): boolean =>
  rec.status === 'scheduled' && rec.queue?.sendAt != null && rec.queue.sendAt <= now

/** Waited on you past its time. */
export const dueToExpire = (rec: Pick<ActionRecord, 'status' | 'queue'>, now: number): boolean =>
  rec.status === 'needs_you' && !!rec.queue && rec.queue.expiresAt <= now

/** The delay before a scheduled action's timer fires (0 = now). */
export const sendDelay = (rec: Pick<ActionRecord, 'queue'>, now: number): number => Math.max(0, (rec.queue?.sendAt ?? now) - now)

// ---------------------------------------------------------------------------
// Dispatch: the one-tool run that sends an approved action.
// ---------------------------------------------------------------------------

/** What the dispatch run is told: call this one tool with these args, once. */
export function dispatchPrompt(tool: string, args: Record<string, unknown>): string {
  return [
    // Connector tools are deferred (claude.ai ones always): load the one tool before calling it.
    `First call ToolSearch with query \`select:${tool}\` to load the tool.`,
    `Then call the tool \`${tool}\` exactly once, with exactly these arguments — the JSON below, unchanged:`,
    '',
    '```json',
    JSON.stringify(args, null, 2),
    '```',
    '',
    'Copy every value character for character: do not reword, reformat, fix, add or drop anything. Call no other tool besides ToolSearch.',
    'After the call, reply with one word: done. If the tool is not available, reply: no-tool.',
  ].join('\n')
}

export type FenceDecision = { allow: true } | { allow: false; reason: string }

/** The one helper the dispatch run may use besides the tool: loading a deferred tool's schema. Sends nothing. */
export const TOOL_SEARCH = 'ToolSearch'

/**
 * The dispatch fence, as a PreToolUse veto: the one tool, with args that
 * deep-equal the approved ones, once. Anything else is denied — another
 * tool, a changed value, a second call. ToolSearch (which only loads a
 * deferred tool's schema) passes and never counts as the one call.
 */
export class DispatchFence {
  /** the call went through the fence — from here, it may have run */
  allowed = false
  /** the tool_use the fence let through */
  allowedCall: string | null = null
  /** calls it turned away, with why — for the record when nothing went out */
  denials: string[] = []

  constructor(
    readonly tool: string,
    readonly args: Record<string, unknown>,
  ) {}

  decide(toolName: string, input: unknown, toolUseId?: string): FenceDecision {
    const deny = (reason: string): FenceDecision => {
      this.denials.push(reason)
      return { allow: false, reason }
    }
    if (toolName === TOOL_SEARCH && toolName !== this.tool) return { allow: true }
    if (toolName !== this.tool) return deny(`only ${this.tool} may be called in this run`)
    if (this.allowed) return deny('already called once — an approved action goes out exactly once')
    if (!argsEqual(input, this.args)) return deny(`the arguments differ from the approved ones${diffHint(input, this.args)} — call it again with the JSON exactly as given`)
    this.allowed = true
    this.allowedCall = toolUseId ?? null
    return { allow: true }
  }
}

/** Which top-level field differs, so the run can correct itself on its second turn. */
function diffHint(input: unknown, approved: Record<string, unknown>): string {
  if (!isArgsObject(input)) return ''
  const keys = [...new Set([...Object.keys(input), ...Object.keys(approved)])].sort()
  const off = keys.filter((k) => canonJson(input[k]) !== canonJson(approved[k]))
  return off.length ? ` (${off.slice(0, 3).join(', ')})` : ''
}

/**
 * The action's connector as the dispatch run's init message saw it:
 * listed       its tool is in the run's tool list
 * connected    the server is up (its tools deferred — ToolSearch loads them)
 * pending      still connecting (claude.ai connectors start this way)
 * failed       the server is there but failed, needs auth, or is disabled
 * missing      no server of that name in the run at all
 * null         the init said nothing about servers
 */
export type ConnectorState = 'listed' | 'connected' | 'pending' | 'failed' | 'missing'

/** Read the connector's state off a run's init message (`tools`, `mcp_servers`). */
export function connectorState(init: unknown, tool: string): ConnectorState | null {
  const r = (init ?? {}) as { tools?: unknown; mcp_servers?: unknown }
  if (Array.isArray(r.tools) && r.tools.includes(tool)) return 'listed'
  if (!Array.isArray(r.mcp_servers)) return null
  const server = serverOfTool(tool)
  const s = (r.mcp_servers as Array<{ name?: unknown; status?: unknown }>).find(
    (x) => typeof x.name === 'string' && x.name.replace(/[^A-Za-z0-9_-]/g, '_') === server,
  )
  if (!s) return 'missing'
  if (s.status === 'connected') return 'connected'
  if (s.status === 'pending') return 'pending'
  return 'failed'
}

/** `mcp__<server>__<leaf>` → the server segment (as sort.ts serverOf; kept here so this file stays leaf-free). */
const serverOfTool = (tool: string): string => {
  const rest = tool.startsWith('mcp__') ? tool.slice(5) : tool
  const cut = rest.lastIndexOf('__')
  return cut === -1 ? rest : rest.slice(0, cut)
}

/**
 * Every other connector the dispatch run would load from the user's config,
 * as `mcp__<server>` entries for `disallowedTools` — so the run carries one
 * server's schemas, not every connector's (cost), and can reach nothing else.
 */
export function dispatchDisallowed(knownServers: readonly string[], tool: string): string[] {
  const own = serverOfTool(tool)
  const out = new Set<string>()
  for (const srv of knownServers) {
    const norm = srv.replace(/[^a-zA-Z0-9_-]/g, '_')
    if (norm && norm !== own) out.add(`mcp__${norm}`)
  }
  return [...out].sort()
}

/** What the dispatch run saw, reduced to what decides the outcome. */
export type DispatchTrace = {
  /** the fence let the call through */
  allowed: boolean
  /** the call's result, when it came back */
  result?: { isError: boolean; text: string }
  /** the connector at the run's start; null = not known */
  connector: ConnectorState | null
  /** the run said it had no such tool (the prompt's `no-tool`) */
  noTool?: boolean
  /** how the run ended badly, if it did */
  runError?: string
  /** what the fence turned away */
  denials?: string[]
}

export type DispatchOutcome = { status: 'succeeded' | 'failed' | 'unknown'; link: string | null; error: string | null }

const clipError = (s: string): string => (s.length > 400 ? `${s.slice(0, 399)}…` : s)

/**
 * How a dispatch run ended, for the record:
 * - never let through: nothing went out — failed (a missing connector says so), safe to retry
 * - let through, result back: succeeded with its link, or failed with what came back
 * - let through, no result (the run died, timed out, was stopped): unknown —
 *   it may have gone out; never retried by itself
 */
export function dispatchOutcome(t: DispatchTrace, serverName: string): DispatchOutcome {
  if (!t.allowed) {
    // Only when the server is truly absent or broken — a pending one may just have been slow, and a
    // claude.ai connector is often left out of the init list altogether: missing from it says
    // nothing until the run itself also found no such tool.
    const claudeAi = serverName.startsWith('claude_ai_')
    if (t.connector === 'failed' || (t.connector === 'missing' && (!claudeAi || t.noTool))) {
      return { status: 'failed', link: null, error: `connector not connected: ${serverName}` }
    }
    if (t.noTool) {
      return {
        status: 'failed',
        link: null,
        error: `the dispatch run could not load ${serverName}'s tool${t.connector === 'pending' ? ' — the connector was still connecting' : ''}; nothing was sent, retry`,
      }
    }
    const why = t.runError ?? t.denials?.[t.denials.length - 1]
    return { status: 'failed', link: null, error: clipError(`the dispatch run did not make the call${why ? ` — ${why}` : ''}`) }
  }
  if (!t.result) {
    return {
      status: 'unknown',
      link: null,
      error: clipError(`the dispatch run ended after the call was let through, before its result came back${t.runError ? ` (${t.runError})` : ''} — check before retrying`),
    }
  }
  if (t.result.isError) return { status: 'failed', link: null, error: clipError(t.result.text.trim() || 'the tool returned an error') }
  return { status: 'succeeded', link: extractLink(t.result.text), error: null }
}
