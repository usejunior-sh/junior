import { errText } from '../errors.js'
import { listPinsOp, unpinOp } from '../pins-ops.js'
import { readJsonBody } from './http-util.js'
import type { ScopedCtx } from './ctx.js'

/**
 * Pinned notes (core/junior/pins.ts), the user's side: GET /api/pins (the
 * ones that hold now) and POST /api/pins/unpin {id}. Every answer is
 * { ok, … }. Pinning is Junior's, through the junior MCP's pin_note.
 */
export async function pinRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/pins' && req.method === 'GET') {
    try {
      json(200, { ok: true, pins: await listPinsOp(rt) })
    } catch (err) {
      json(500, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/pins/unpin' && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown }
      await unpinOp(rt, body.id)
      json(200, { ok: true, pins: await listPinsOp(rt) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
