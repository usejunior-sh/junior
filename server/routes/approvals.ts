import { errText } from '../errors.js'
import { addApprovalOp, listApprovalsOp, revokeApprovalOp } from '../approvals-ops.js'
import { readJsonBody } from './http-util.js'
import { juniorLogOp, juniorLogSeenOp } from '../junior-log.js'
import type { ScopedCtx } from './ctx.js'

/**
 * Advance approvals (core/approvals): GET /api/approvals (every one, revoked
 * included), POST /api/approvals (add, from a Rule card), POST
 * /api/approvals/revoke {id}. Every answer is { ok, … }.
 *
 * And Junior's log, the record of what those approvals let out (core/junior/log.ts):
 * GET /api/junior/log?filter=all|sent&before=<ms>&limit=<n>, POST /api/junior/log/seen {at}.
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
  if (url.pathname === '/api/junior/log' && req.method === 'GET') {
    const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : null)
    json(200, { ok: true, log: await juniorLogOp(rt, { filter: url.searchParams.get('filter'), before: num('before'), limit: num('limit') }) })
    return true
  }
  if (url.pathname === '/api/junior/log/seen' && req.method === 'POST') {
    const body = ((await readJsonBody(req)) ?? {}) as { at?: unknown }
    json(200, { ok: true, seenAt: await juniorLogSeenOp(rt, body.at) })
    return true
  }
  return false
}
