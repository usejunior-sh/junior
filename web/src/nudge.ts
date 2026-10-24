import type { NudgeTaskResponse } from '../../shared/protocol.js'
import type { ItemTask } from '../../core/work/tasks.js'

/**
 * The two nudge calls (server/tasks/nudge.ts). Draft only when you pick
 * "Draft nudge"; the server hands back a draft already waiting as it is.
 * Send carries the box's text: what goes out is always what you see.
 */
type Answer = { task: ItemTask; error?: undefined } | { task?: undefined; error: string }

async function post(path: string, body: Record<string, unknown>): Promise<Answer> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as NudgeTaskResponse
    return b.ok ? { task: b.task } : { error: b.error || 'failed' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export const draftNudge = (itemId: string, person: string): Promise<Answer> => post('/api/nudge/draft', { itemId, person })

export const sendNudge = (id: string, text: string, byHand: boolean): Promise<Answer> => post('/api/tasks/send-nudge', byHand ? { id, text, byHand: true } : { id, text })
