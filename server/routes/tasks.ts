import { errText } from '../errors.js'
import { approveTaskOp, babysitSettingsOp, retryTaskOp, skipTaskOp, stopTaskOp } from '../tasks/ops.js'
import { readJsonBody } from './http-util.js'
import type { ScopedCtx } from './ctx.js'

/**
 * Tasks on items (POST /api/tasks/<verb> {id, …}) and babysitting's settings
 * (GET/POST /api/babysit/settings). Every answer is { ok, … }.
 */
export async function taskRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  const verb = /^\/api\/tasks\/(approve|retry|stop|skip)$/.exec(url.pathname)?.[1]
  if (verb && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown; reviewer?: unknown; note?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new Error('id required')
      const task =
        verb === 'approve'
          ? await approveTaskOp(rt, id, { ...(typeof body.reviewer === 'string' ? { reviewer: body.reviewer } : {}) })
          : verb === 'retry'
            ? await retryTaskOp(rt, id, typeof body.note === 'string' ? body.note : undefined)
            : verb === 'stop'
              ? await stopTaskOp(rt, id)
              : await skipTaskOp(rt, id)
      json(200, { ok: true, task })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/babysit/settings' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const settings = await babysitSettingsOp(rt, req.method === 'POST' ? ((await readJsonBody(req)) ?? {}) : undefined)
      json(200, { ok: true, settings })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
