/**
 * Hand-offs from the client (server/handoff-ops.ts): hand an item to Junior,
 * pause it, resume it, or "not this one" to its suggestion. The row moves at
 * once; the inbox refetch the server's broadcast brings settles it.
 */
import type { HandoffReadiness, HandoffResponse, ScoredItem } from '../../shared/protocol.js'
import type { Handoff } from '../../core/work/fields.js'
import { inboxStore } from './inboxStore.js'
import { signalIds } from './components/inbox/rowHelpers.js'

export type HandoffVerb = 'start' | 'pause' | 'resume' | 'not-now'

const LOCAL: Record<HandoffVerb, (i: ScoredItem) => ScoredItem> = {
  start: (i) => ({ ...i, handoff: 'on' as Handoff, suggestion: undefined }),
  pause: (i) => ({ ...i, handoff: 'paused' as Handoff, ...(i.junior ? { junior: { ...i.junior, stage: 'paused' as const } } : {}) }),
  resume: (i) => ({ ...i, handoff: 'on' as Handoff }),
  'not-now': (i) => ({ ...i, notNow: i.updatedAt, suggestion: undefined }),
}

/**
 * Hand-off and its answer: `error` null when it went through, and then the
 * item's readiness (a PR whose watch is off reads "watch-off").
 */
export async function sendHandoff(verb: HandoffVerb, itemId: string, playbook?: string): Promise<{ error: string | null; readiness?: HandoffReadiness }> {
  inboxStore.patch((items) => items.map((i) => (i.id === itemId ? LOCAL[verb](i) : i)))
  try {
    const r = await fetch(`/api/handoff/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId, ...(playbook ? { playbook } : {}) }) })
    const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as HandoffResponse
    if (!b.ok) {
      void inboxStore.refresh()
      return { error: b.error ?? 'that didn’t go through' }
    }
    return { error: null, readiness: b.readiness }
  } catch (err) {
    void inboxStore.refresh()
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Null when it went through; else what went wrong, in a line. */
export async function handoff(verb: HandoffVerb, itemId: string, playbook?: string): Promise<string | null> {
  return (await sendHandoff(verb, itemId, playbook)).error
}

/** Snooze from the Junior page: the row leaves at once. */
export async function snoozeItem(item: ScoredItem, until: number): Promise<void> {
  inboxStore.patch((items) => items.filter((i) => i.id !== item.id))
  await Promise.all(
    signalIds(item).map((id) =>
      fetch('/api/items/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status: 'snoozed', snoozeUntil: until }) }).catch(() => {}),
    ),
  )
}

/** Done from the Junior page: the row leaves at once. */
export async function doneItem(item: ScoredItem): Promise<void> {
  inboxStore.patch((items) => items.filter((i) => i.id !== item.id))
  await Promise.all(
    signalIds(item).map((id) =>
      fetch('/api/items/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status: 'done' }) }).catch(() => {}),
    ),
  )
}

/** The verb on a suggestion's button. */
export const VERB: Record<string, string> = { babysit: 'Babysit', review: 'First pass', answer: 'Hand off', 'debug-fix': 'Hand off', investigate: 'Hand off' }
