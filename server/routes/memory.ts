import { errText } from '../errors.js'
import { memoryFile, readMemory } from '../memory-ops.js'
import type { ScopedCtx } from './ctx.js'

/**
 * Junior's memory (core/junior/memory.ts), the user's side: GET /api/memory,
 * the lines in `<workspace>/memory.md`, oldest first. Read only; Junior writes
 * through the junior MCP (remember, forget), the user edits the file by hand.
 */
export async function memoryRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/memory' && req.method === 'GET') {
    try {
      json(200, { ok: true, lines: await readMemory(rt.meta.id), path: memoryFile(rt.meta.id) })
    } catch (err) {
      json(500, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
