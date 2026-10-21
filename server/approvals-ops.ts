import { randomUUID } from 'node:crypto'
import { type AdvanceApproval, allowedDetailFor, approvalFrom, type CallContext, describeApproval, matchApproval } from '../core/approvals/approvals.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { broadcast } from './ws/send.js'
import { log } from './log.js'
import { errText } from './errors.js'

// Advance approvals (core/approvals/approvals.ts): the ops behind Settings →
// Approvals, the Rule card in chat, and the hold. Only you add one: Junior
// proposes (propose_approval), the card's Add posts here.

const changed = (rt: WorkspaceRuntime) => broadcast(rt, { type: 'approvals_changed' })

export async function listApprovalsOp(rt: WorkspaceRuntime): Promise<AdvanceApproval[]> {
  return rt.store.approvals.list()
}

/**
 * Add one, from a proposal card (or by hand). One per proposal: adding the
 * same card twice returns the approval it already made.
 */
export async function addApprovalOp(rt: WorkspaceRuntime, raw: unknown): Promise<AdvanceApproval> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const proposalId = typeof r.proposalId === 'string' && r.proposalId.trim() ? r.proposalId.trim().slice(0, 200) : null
  const sessionId = typeof r.sessionId === 'string' && rt.rows.has(r.sessionId) ? r.sessionId : null
  if (proposalId) {
    const made = await rt.store.approvals.byProposal(proposalId)
    if (made) return made
  }
  const out = approvalFrom(r, { id: randomUUID(), now: Date.now(), sessionId, proposalId })
  if (!out.ok) throw new Error(out.error)
  await rt.store.approvals.put(out.approval)
  log('info', 'approvals', `added: ${describeApproval(out.approval)}`, { approval: out.approval.id, workspace: rt.meta.id })
  changed(rt)
  return out.approval
}

export async function revokeApprovalOp(rt: WorkspaceRuntime, raw: unknown): Promise<AdvanceApproval> {
  const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : ''
  const a = id ? await rt.store.approvals.get(id) : null
  if (!a) throw new Error('no such approval')
  if (!(await rt.store.approvals.revoke(id, Date.now()))) throw new Error('already revoked')
  log('info', 'approvals', `revoked: ${describeApproval(a)}`, { approval: id, workspace: rt.meta.id })
  changed(rt)
  return (await rt.store.approvals.get(id))!
}

/** The live approval that covers this call, or null. A store that fails covers nothing: the call is held. */
export async function coveringApproval(rt: WorkspaceRuntime, tool: string, args: Record<string, unknown>, ctx: CallContext = {}): Promise<AdvanceApproval | null> {
  try {
    return matchApproval(await rt.store.approvals.list(), tool, args, ctx, Date.now())
  } catch (err) {
    log('warn', 'approvals', `could not read approvals, holding the call: ${errText(err)}`, { workspace: rt.meta.id })
    return null
  }
}

/** Calls let through and not yet recorded. Past this many, the oldest go. */
const RULE_ALLOWED_CAP = 500

/**
 * An approval let a call through: the record will say so ("allowed by: rule"),
 * and the approval counts the use.
 */
export async function useApproval(rt: WorkspaceRuntime, a: AdvanceApproval, sessionId: string, toolUseId: string | undefined): Promise<void> {
  if (toolUseId) {
    rt.ruleAllowed.set(`${sessionId}:${toolUseId}`, allowedDetailFor(a))
    for (const k of rt.ruleAllowed.keys()) {
      if (rt.ruleAllowed.size <= RULE_ALLOWED_CAP) break
      rt.ruleAllowed.delete(k)
    }
  }
  log('info', 'approvals', `sent under an advance approval: ${describeApproval(a)}`, { approval: a.id, session: sessionId, workspace: rt.meta.id })
  try {
    await rt.store.approvals.used(a.id, Date.now())
    changed(rt)
  } catch (err) {
    log('warn', 'approvals', `could not count a use: ${errText(err)}`, { approval: a.id, workspace: rt.meta.id })
  }
}
