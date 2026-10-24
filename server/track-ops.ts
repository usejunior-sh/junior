/**
 * The track record's read: held actions from the store, each with its
 * history, ready for `trackRecord` (core/approvals/track.ts). Kept apart so
 * track.ts stays pure and browser-safe. Data only: nothing here writes.
 */
import type { ActionKind } from '../core/actions/types.js'
import type { ActionStore } from '../core/store/types.js'
import { type TrackInput, type TrackOptions, type TrackRecord, type TrackScope, trackRecord } from '../core/approvals/track.js'

/** Held actions of a kind, attempted in [since, until], with their history. Newest first. */
export async function readTrackInputs(actions: ActionStore, q: { kind?: ActionKind; since: number; until?: number }): Promise<TrackInput[]> {
  const records = await actions.held(q)
  const history = await actions.history(records.map((r) => r.id))
  return records.map((record) => ({ record, history: history.get(record.id) ?? [] }))
}

/** Read and count in one go. Defaults to the last 90 days. */
export async function readTrackRecord(actions: ActionStore, scope: TrackScope, opts: TrackOptions): Promise<TrackRecord> {
  const windowMs = opts.windowMs ?? 90 * 86_400_000
  const inputs = await readTrackInputs(actions, { kind: scope.kind, since: opts.now - windowMs, until: opts.now })
  return trackRecord(inputs, scope, { ...opts, windowMs })
}
