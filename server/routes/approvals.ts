import { errText } from '../errors.js'
import { addApprovalOp, listApprovalsOp, revokeApprovalOp } from '../approvals-ops.js'
import { readJsonBody } from './http-util.js'
import type { ScopedCtx } from './ctx.js'

/**
 * Advance approvals (core/approvals): GET /api/approvals (every one, revoked
 * included), POST /api/approvals (add, from a Rule card), POST
 * /api/approvals/revoke {id}. Every answer is { ok, … }.
 */
export async function approvalRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/approvals' && req.method === 'GET') {
    json(200, { ok: true, approvals: await listApprovalsOp(rt) })
    return true
  }
  if ((url.pathname === '/api/approvals' || url.pathname === '/api/approvals/revoke') && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) ?? {}
      const approval = url.pathname.endsWith('/revoke') ? await revokeApprovalOp(rt, body) : await addApprovalOp(rt, body)
      json(200, { ok: true, approval })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
