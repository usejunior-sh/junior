/**
 * Advance approvals (Junior for engineers, M2): your OK, given before the
 * send. One names who + what + when ("DM Anirudha on Slack, any time"). A held
 * call it covers goes out alone, and the record says "allowed by: rule".
 *
 * Narrow on purpose: one recipient, one kind of send, matched in code on the
 * tool and the recipient, never on the message text. Listed in Settings →
 * Approvals, revocable; a revoked one is kept, so a log line can still say
 * what allowed it.
 *
 * Pure and browser-safe: time is always an argument.
 */
import { splitCommand, unwrap, wrappersOf } from '../actions/bash.js'

/** The kinds of send an approval can cover. */
export type ApprovalWhat = 'slack-dm' | 'slack-post' | 'request-review'
export const APPROVAL_WHATS: readonly ApprovalWhat[] = ['slack-dm', 'slack-post', 'request-review']
export const isApprovalWhat = (v: unknown): v is ApprovalWhat => APPROVAL_WHATS.includes(v as ApprovalWhat)

/** Who it reaches. The kind follows from the what. */
export type ApprovalWhoKind = 'slack-user' | 'slack-channel' | 'github-user'
export const WHO_KIND: Record<ApprovalWhat, ApprovalWhoKind> = {
  'slack-dm': 'slack-user',
  'slack-post': 'slack-channel',
  'request-review': 'github-user',
}

export type ApprovalWho = {
  kind: ApprovalWhoKind
  /** what the call carries: a Slack user id (U…), a channel id (C…/G…), a GitHub login */
  id: string
  /** what you read: "Anirudha", "#eng-reviews", "anirudha-k" */
  name: string
}

/** Any time, or only as one step of a playbook (babysit's reviewer request). */
export type ApprovalWhen = { kind: 'any' } | { kind: 'playbook'; playbook: string; step: string }

export type AdvanceApproval = {
  id: string
  who: ApprovalWho
  what: ApprovalWhat
  when: ApprovalWhen
  /** Junior's one line on why, as proposed */
  why: string
  createdAt: number
  /** past this it covers nothing; null = until revoked */
  expiresAt: number | null
  revokedAt: number | null
  /** the chat it was added from, when there was one */
  sessionId: string | null
  /** the proposal's tool call, so its card knows it was added */
  proposalId: string | null
  uses: number
  lastUsedAt: number | null
}

/** Where a call is made: a playbook step, for a task run. */
export type CallContext = { playbook?: { playbook: string; step: string } | null }

export const WHAT_LABEL: Record<ApprovalWhat, string> = {
  'slack-dm': 'DM on Slack',
  'slack-post': 'post in a Slack channel',
  'request-review': 'request a review on GitHub',
}

/** One line: "DM Anirudha on Slack", "request a review from anirudha-k". */
export function describeApproval(a: Pick<AdvanceApproval, 'who' | 'what' | 'when'>): string {
  const base =
    a.what === 'slack-dm' ? `DM ${a.who.name} on Slack` : a.what === 'slack-post' ? `post in ${a.who.name} on Slack` : `request a review from ${a.who.name}`
  return a.when.kind === 'playbook' ? `${base}, in ${a.when.playbook} (${a.when.step})` : base
}

/** Live: not revoked, not expired. */
export const isLive = (a: AdvanceApproval, now: number): boolean => a.revokedAt === null && (a.expiresAt === null || now < a.expiresAt)

const SLACK_USER_RE = /^[UW][A-Z0-9]{2,}$/
const SLACK_CHANNEL_RE = /^[CG][A-Z0-9]{2,}$/
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** Why a who doesn't fit the what, or null. */
export function whoProblem(what: ApprovalWhat, who: ApprovalWho): string | null {
  if (who.kind !== WHO_KIND[what]) return `${WHAT_LABEL[what]} needs a ${WHO_KIND[what]}, not a ${who.kind}`
  if (!who.name.trim()) return 'who needs a name you can read'
  if (who.kind === 'slack-user' && !SLACK_USER_RE.test(who.id)) return `"${who.id}" isn't a Slack user id (U…). Look it up with slack_search_users first.`
  if (who.kind === 'slack-channel' && !SLACK_CHANNEL_RE.test(who.id)) return `"${who.id}" isn't a Slack channel id (C…). Look it up with slack_search_channels first.`
  if (who.kind === 'github-user' && !GITHUB_LOGIN_RE.test(who.id)) return `"${who.id}" isn't a GitHub login`
  return null
}

/** A Slack send: a tool named `slack_send_message` on a server whose name says Slack. */
const isSlackSend = (tool: string): boolean => {
  const m = /^mcp__(.+)__([^_].*)$/.exec(tool)
  return !!m && /slack/i.test(m[1]!) && m[2] === 'slack_send_message'
}

/**
 * The recipient a call reaches, as an approval would name it, or null when
 * no approval kind can cover it.
 */
export function callTarget(tool: string, args: Record<string, unknown>): { what: ApprovalWhat; id: string } | null {
  if (isSlackSend(tool)) {
    const ch = typeof args.channel_id === 'string' ? args.channel_id.trim() : ''
    if (SLACK_USER_RE.test(ch)) return { what: 'slack-dm', id: ch }
    if (SLACK_CHANNEL_RE.test(ch)) return { what: 'slack-post', id: ch }
    return null
  }
  if (tool === 'Bash') {
    const login = reviewerOf(String(args.command ?? ''))
    return login ? { what: 'request-review', id: login } : null
  }
  return null
}

/**
 * `gh pr edit <n> [-R o/r] --add-reviewer <login>`, alone: the reviewer it
 * asks. Anything else in the command, another flag that edits the PR, or a
 * second reviewer, and no approval covers it.
 */
export function reviewerOf(command: string): string | null {
  const parts = splitCommand(command)
  // xargs could add a second reviewer, or another edit, from its input.
  if (parts.length !== 1 || wrappersOf(parts[0]!).includes('xargs')) return null
  const w = unwrap(parts[0]!)
  if (w[0] !== 'gh' || w[1] !== 'pr' || w[2] !== 'edit') return null
  let login: string | null = null
  for (let i = 3; i < w.length; i++) {
    const t = w[i]!
    if (t === '--add-reviewer') {
      if (login !== null) return null
      login = w[++i] ?? null
    } else if (t.startsWith('--add-reviewer=')) {
      if (login !== null) return null
      login = t.slice('--add-reviewer='.length)
    } else if (t === '-R' || t === '--repo') i++
    else if (t.startsWith('--repo=') || /^\d+$/.test(t) || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(t)) continue
    else return null
  }
  return login && GITHUB_LOGIN_RE.test(login) && !login.includes(',') ? login : null
}

/** The live approval that covers this call, or null. The oldest wins, so the record names the same one every time. */
export function matchApproval(list: readonly AdvanceApproval[], tool: string, args: Record<string, unknown>, ctx: CallContext, now: number): AdvanceApproval | null {
  const target = callTarget(tool, args)
  if (!target) return null
  const hits = list.filter((a) => {
    if (!isLive(a, now) || a.what !== target.what) return false
    const same = a.who.kind === 'github-user' ? a.who.id.toLowerCase() === target.id.toLowerCase() : a.who.id === target.id
    if (!same) return false
    if (a.when.kind === 'any') return true
    return !!ctx.playbook && ctx.playbook.playbook === a.when.playbook && ctx.playbook.step === a.when.step
  })
  hits.sort((a, b) => a.createdAt - b.createdAt)
  return hits[0] ?? null
}

/** What the record says allowed it: "rule: DM Anirudha on Slack (#a1b2c3)". */
export const allowedDetailFor = (a: AdvanceApproval): string => `${describeApproval(a)} (#${a.id.slice(0, 6)})`

/** The approval an allowedDetail names, by its short id, or null. */
export const approvalIdIn = (detail: string | null): string | null => (detail ? (/\(#([0-9a-f]{6})\)$/.exec(detail)?.[1] ?? null) : null)

/** A proposal or a posted approval → a valid one, or why not. */
export function approvalFrom(
  raw: unknown,
  meta: { id: string; now: number; sessionId: string | null; proposalId: string | null },
): { ok: true; approval: AdvanceApproval } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!isApprovalWhat(r.what)) return { ok: false, error: `what must be one of ${APPROVAL_WHATS.join(', ')}` }
  const w = (r.who && typeof r.who === 'object' ? r.who : {}) as Record<string, unknown>
  const who: ApprovalWho = {
    kind: WHO_KIND[r.what],
    id: typeof w.id === 'string' ? w.id.trim() : '',
    name: typeof w.name === 'string' ? w.name.trim().slice(0, 80) : '',
  }
  const bad = whoProblem(r.what, who)
  if (bad) return { ok: false, error: bad }
  const wn = (r.when && typeof r.when === 'object' ? r.when : { kind: 'any' }) as Record<string, unknown>
  let when: ApprovalWhen = { kind: 'any' }
  if (wn.kind === 'playbook') {
    const playbook = typeof wn.playbook === 'string' ? wn.playbook.trim() : ''
    const step = typeof wn.step === 'string' ? wn.step.trim() : ''
    if (!playbook || !step) return { ok: false, error: 'a playbook approval names the playbook and its step' }
    when = { kind: 'playbook', playbook, step }
  } else if (wn.kind !== undefined && wn.kind !== 'any') return { ok: false, error: 'when is "any" or a playbook step' }
  const exp = r.expiresAt
  if (exp !== undefined && exp !== null && (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= meta.now)) return { ok: false, error: 'expiresAt must be a time in the future' }
  return {
    ok: true,
    approval: {
      id: meta.id,
      who,
      what: r.what,
      when,
      why: typeof r.why === 'string' ? r.why.trim().slice(0, 400) : '',
      createdAt: meta.now,
      expiresAt: typeof exp === 'number' ? exp : null,
      revokedAt: null,
      sessionId: meta.sessionId,
      proposalId: meta.proposalId,
      uses: 0,
      lastUsedAt: null,
    },
  }
}
