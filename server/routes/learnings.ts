import { errText } from '../errors.js'
import { editLearningOp, forgetLearningOp, keepLearningOp, listLearningsOp } from '../learnings-ops.js'
import { readJsonBody } from './http-util.js'
import type { ScopedCtx } from './ctx.js'

/**
 * Learnings with receipts (core/junior/learnings.ts), the user's side:
 * GET /api/learnings[?all=1], POST /api/learnings/keep {id},
 * POST /api/learnings/edit {id, text?, scope?, confirm?},
 * POST /api/learnings/forget {id}. Every answer is { ok, … }.
 * There is no propose route: proposing is Junior's, through the junior MCP.
 */
export async function learningRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/learnings' && req.method === 'GET') {
    try {
      const all = url.searchParams.get('all') === '1'
      json(200, { ok: true, ...(await listLearningsOp(rt, { all })) })
    } catch (err) {
      json(500, { ok: false, error: errText(err) })
    }
    return true
  }
  const m = /^\/api\/learnings\/(keep|edit|forget)$/.exec(url.pathname)
  if (m && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) ?? {}
      const learning = m[1] === 'keep' ? await keepLearningOp(rt, body) : m[1] === 'edit' ? await editLearningOp(rt, body) : await forgetLearningOp(rt, body)
      json(200, { ok: true, learning })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
