/**
 * Gates, the pure half. What a verdict does to a gate (the
 * back-off, the two-met rule for high-stakes gates), when a gate is past its
 * deadline, which tools the read-only checker gets, the fence that holds it to
 * them, its prompt, and the verdict it must hand back. No clock, no I/O: the
 * sweep in server/goals.ts carries the decisions out.
 */
import { defaultToolsFor, mcpToolName, type ProbedTool } from '../job/tools.js'
import { parseDuration } from './machine.js'
import type { FenceDecision } from '../teams/fence.js'
import { GATE_CHECK_SCHEDULE_MIN, GATE_CHECK_TAIL_MIN, GATE_VERDICT_KINDS, type Gate, type GateVerdict, type GateVerdictKind } from './types.js'

const MIN = 60_000

/** The checker's one write: its verdicts, on the run's own `gate` server. */
export const GATE_SERVER = 'gate'
export const GATE_VERDICT_TOOL = 'gate_verdict'
export const GATE_VERDICT_FULL = mcpToolName(GATE_SERVER, GATE_VERDICT_TOOL)
/** Connector tools are deferred; the checker loads the read tools it needs with this. */
export const GATE_TOOL_SEARCH = 'ToolSearch'

// High stakes: two "met" in a row

const HIGH_STAKES = /\b(merg(e|ed|es|ing)|deploy(s|ed|ing|ment)?|release[sd]?|prod|production|live traffic|go[- ]live|rollout|roll out)\b/i

/** A gate on a merge, a deploy, a release or anything touching production. */
export const isHighStakes = (text: string): boolean => HIGH_STAKES.test(text)

/** The "met" verdicts in a row a gate needs: what was asked, and never under 2 when the stakes are high. */
export function requiredConfirmations(asked: number, ...about: string[]): number {
  const n = Number.isInteger(asked) && asked >= 1 ? asked : 1
  return about.some(isHighStakes) ? Math.max(n, 2) : n
}

/**
 * How long until the next check, after `checks` checks: the gate's own
 * interval, else the schedule (5, 5, 10, … 40 minutes, then hourly). A
 * checker that says "check again in 2h" is heard up to the hourly tail, never
 * sooner than the schedule. It can slow a gate down, not speed it up.
 */
export function nextCheckDelay(checks: number, checkEveryMs: number | null, hint: string | null = null): number {
  if (checkEveryMs) return checkEveryMs
  const sched = (GATE_CHECK_SCHEDULE_MIN[checks] ?? GATE_CHECK_TAIL_MIN) * MIN
  const asked = hint ? parseDuration(hint) : null
  return asked ? Math.max(sched, Math.min(asked, GATE_CHECK_TAIL_MIN * MIN)) : sched
}

/** Between two "met" verdicts on a high-stakes gate: soon, but not in the same breath. */
export const CONFIRM_AFTER_MS = GATE_CHECK_SCHEDULE_MIN[0]! * MIN

export type VerdictOutcome =
  /** met, confirmed: the step is done and the lead wakes */
  | 'resolved'
  /** look again at nextCheckAt */
  | 'recheck'
  /** the checker can't tell: an approval in the Inbox */
  | 'to_user'

/** What one verdict does to an open gate. Anything but "met" breaks a run of confirmations. */
export function applyVerdict(gate: Gate, v: GateVerdict, now: number): { gate: Gate; outcome: VerdictOutcome } {
  const checks = gate.checks + 1
  const base = { ...gate, checks, lastVerdict: v }
  if (v.verdict === 'met') {
    const seen = gate.confirmationsSeen + 1
    if (seen >= gate.confirmationsNeeded) return { gate: { ...base, confirmationsSeen: seen, nextCheckAt: null }, outcome: 'resolved' }
    return { gate: { ...base, confirmationsSeen: seen, nextCheckAt: now + (gate.checkEveryMs ? Math.min(gate.checkEveryMs, CONFIRM_AFTER_MS) : CONFIRM_AFTER_MS) }, outcome: 'recheck' }
  }
  if (v.verdict === 'needs_user') return { gate: { ...base, confirmationsSeen: 0, nextCheckAt: null }, outcome: 'to_user' }
  return { gate: { ...base, confirmationsSeen: 0, nextCheckAt: now + nextCheckDelay(checks, gate.checkEveryMs, v.checkAgainIn) }, outcome: 'recheck' }
}

export const pastDeadline = (gate: Pick<Gate, 'status' | 'deadlineAt'>, now: number): boolean => gate.status === 'open' && gate.deadlineAt <= now

// The checker's tools and its fence

export type ProbedServer = { server: string; name?: string; tools: ProbedTool[] }

const norm = (s: string) => s.trim().toLowerCase().replace(/^claude\.ai\s+/, '')

/**
 * The read tools of the connectors a gate names, by server ("claude.ai
 * Linear") or display name ("Linear"), case-blind: the server's curated read
 * preset, else the tools it marks read-only and not destructive. A connector
 * nobody probed gives nothing: the checker then says it can't tell.
 */
export function gateReadTools(connectors: readonly string[], probes: readonly ProbedServer[]): string[] {
  const want = new Set(connectors.map(norm))
  const out = new Set<string>()
  for (const p of probes) {
    if (!want.has(norm(p.server)) && !(p.name && want.has(norm(p.name)))) continue
    for (const t of defaultToolsFor(p.server, p.tools)) out.add(t)
  }
  return [...out].sort()
}

/** The servers a gate's connectors resolved to. The rest are dropped from the run. */
export function gateServers(connectors: readonly string[], probes: readonly ProbedServer[]): string[] {
  const want = new Set(connectors.map(norm))
  return [...new Set(probes.filter((p) => want.has(norm(p.server)) || (p.name && want.has(norm(p.name)))).map((p) => p.server))].sort()
}

/**
 * The checker's fence, a PreToolUse veto that runs before any allow rule: the
 * named read tools, ToolSearch to load them, and the verdict tool. Nothing
 * else: no shell, no file tool (not even Read), no connector write.
 */
export function gateFenceDecision(readTools: ReadonlySet<string>, toolName: string): FenceDecision {
  if (toolName === GATE_VERDICT_FULL || toolName === GATE_TOOL_SEARCH || readTools.has(toolName)) return { allow: true }
  return { allow: false, reason: `a gate checker only reads: ${toolName} isn't one of the read tools of the connectors this gate names` }
}

/** The condition and the ids, nothing else: no plan, no ledger, no goal. */
export function gateCheckPrompt(gates: readonly Pick<Gate, 'id' | 'condition' | 'refs' | 'connectors'>[]): string {
  const lines = [
    'You check conditions in the outside world. Read only; change nothing.',
    `For each gate below, look the condition up with the read tools you have (load them with ${GATE_TOOL_SEARCH} if they are deferred), then call ${GATE_VERDICT_TOOL} once with one verdict per gate id:`,
    '- met: you saw evidence the condition holds now',
    "- not_met: you saw it doesn't hold yet",
    "- needs_user: it can't be decided by reading (a judgment call, a missing permission, an ambiguous condition)",
    "- error: you couldn't read what you need (no tool, an error)",
    'Evidence is one short line of what you saw. checkAgainIn is optional ("2h") when you can tell it will be a while.',
    'Then stop.',
    '',
  ]
  for (const g of gates) {
    lines.push(`Gate ${g.id}`, `  Condition: ${g.condition}`)
    if (g.refs.length) lines.push(`  Ids: ${g.refs.join(', ')}`)
    if (g.connectors.length) lines.push(`  Look in: ${g.connectors.join(', ')}`)
  }
  return lines.join('\n')
}

/** One verdict, validated; null for anything off-format. */
export function verdictFrom(raw: unknown): GateVerdict | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!GATE_VERDICT_KINDS.includes(r.verdict as GateVerdictKind)) return null
  const evidence = typeof r.evidence === 'string' ? r.evidence.trim().slice(0, 1_000) : ''
  const hint = typeof r.checkAgainIn === 'string' && parseDuration(r.checkAgainIn) !== null ? r.checkAgainIn.trim() : null
  return { verdict: r.verdict as GateVerdictKind, evidence, checkAgainIn: hint }
}

/** A gate the checker left out, or answered off-format. */
export const NO_VERDICT: GateVerdict = { verdict: 'error', evidence: 'the checker returned no verdict for this gate', checkAgainIn: null }
