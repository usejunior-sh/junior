/**
 * Hand-offs from the client (server/handoff-ops.ts): hand an item to Junior,
 * pause it, resume it, or "not this one" to its suggestion. The row moves at
 * once; the inbox refetch the server's broadcast brings settles it.
 */
import type { HandoffReadiness, HandoffResponse, ItemStateResponse, ScoredItem, SettingsResponse, WatchId } from '../../shared/protocol.js'
import { markWatchOn } from '../../core/junior/watch-off.js'
import { quietKey } from '../../core/junior/ledger.js'
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

/**
 * Turn a watch on from a row it holds up: the same switch as Settings →
 * Automations (PUT /api/settings). A local setting, not a send. Null when it
 * went through; the rows stop saying "off" at once and the server's resync
 * settles them.
 */
export async function turnOnWatch(watch: WatchId): Promise<string | null> {
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(watch === 'babysit' ? { babysitEnabled: true } : { reviewsEnabled: true }),
    })
    const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as SettingsResponse
    if (!b.ok) return b.error
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  inboxStore.patch((items) => markWatchOn(items, watch))
  void inboxStore.refreshAfterChange()
  return null
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

/** The server's error line, first letter up: "no such item" → "No such item." */
const sentence = (s: string) => {
  const t = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?]$/.test(t) ? t : `${t}.`
}

async function postNotUseful(id: string, undo: boolean): Promise<string | null> {
  try {
    const r = await fetch('/api/items/not-useful', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...(undo ? { undo: true } : {}) }) })
    const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as ItemStateResponse
    if (b.ok) return null
    void inboxStore.refresh()
    return sentence(b.error)
  } catch (err) {
    void inboxStore.refresh()
    return sentence(err instanceof Error ? err.message : String(err))
  }
}

/**
 * "Not useful" from a Needs you row: it leaves at once, until something new
 * happens on it (core/junior/ledger.ts quieted). One item, one event: unlike
 * snooze and done, it doesn't fan out to linked signals. Null when it went
 * through; else the error, as a sentence.
 */
export function markNotUseful(item: ScoredItem): Promise<string | null> {
  const stamp = quietKey(item)
  inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, notUseful: stamp } : i)))
  return postNotUseful(item.id, false)
}

/**
 * Undo a "not useful" within seconds: the row is back at once. `marking` is
 * the mark's own request: the undo is sent only once it has landed, so the
 * two can't arrive out of order, and not at all if the mark never went through.
 */
export async function undoNotUseful(item: ScoredItem, marking?: Promise<string | null>): Promise<string | null> {
  inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, notUseful: undefined } : i)))
  if (marking && (await marking) !== null) return null
  return postNotUseful(item.id, true)
}

/** The verb on a suggestion's button. */
export const VERB: Record<string, string> = { babysit: 'Babysit', review: 'First pass', answer: 'Hand off', 'debug-fix': 'Hand off', investigate: 'Hand off' }
