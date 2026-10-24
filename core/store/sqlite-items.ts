import { DatabaseSync } from 'node:sqlite'
import type { ItemImage, FileRef } from '../../shared/protocol.js'
import type { WorkItem, Provenance } from '../work/types.js'
import { type ItemStatus, type ItemEventKind, shouldReopen, type StatusChange, eventForStatus, type ItemEvent, type ItemNoteKind, surfacedThisCycle } from '../work/state.js'
import { type FlowOverride, isStage, isTurn } from '../work/flow.js'
import type { WorkItemStore, UpsertResult, NewManualItem, StoredFlow, ItemFieldsPatch, ItemWindowEvent, SurfacedEntry } from './types.js'
import type { Decision } from '../work/fields.js'

type WorkItemRow = {
  id: string
  source: string
  kind: string
  status: string
  status_at: number
  snooze_until: number | null
  priority: number | null
  pinned: number
  returned: number
  source_updated_at: number
  ingested_at: number
  payload: string
  created_at: number
  updated_at: number
  due_at: number | null
  due_source: string | null
  stage?: string | null
  turn?: string | null
  flow_override?: string | null
}

/** A stored override, dropping anything that no longer reads as one. */
function parseOverride(raw: string | null | undefined): FlowOverride | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.at !== 'number') return null
    const out: FlowOverride = { at: o.at }
    if (isStage(o.stage)) out.stage = o.stage
    if (isTurn(o.turn)) out.turn = o.turn
    if (typeof o.note === 'string' && o.note) out.note = o.note
    return out.stage || out.turn || out.note ? out : null
  } catch {
    return null
  }
}

const VALID_STATUSES: ItemStatus[] = ['open', 'snoozed', 'done', 'archived']
const toStatus = (v: string): ItemStatus =>
  VALID_STATUSES.includes(v as ItemStatus) ? (v as ItemStatus) : 'open'

/**
 * Project a row into the rendered WorkItem. The payload holds the source-shaped
 * fields; the columns are authoritative for lifecycle (status/returned/priority/
 * ingestedAt), so they overwrite whatever the payload happened to carry.
 */
function toWorkItem(r: WorkItemRow): WorkItem {
  const base = JSON.parse(r.payload) as WorkItem
  // `note` is the pre-0.7 name of `description` on manual items; read it as a fallback.
  const description = base.description ?? base.note
  return {
    ...base,
    ...(description ? { description } : {}),
    status: toStatus(r.status),
    returned: r.returned === 1,
    ...(r.priority != null ? { priority: r.priority } : {}),
    ...(r.due_at != null ? { dueAt: r.due_at } : {}),
    ...(r.due_source === 'explicit' || r.due_source === 'you' ? { dueSource: r.due_source } : {}),
    ingestedAt: r.ingested_at,
  }
}

/** Lifecycle fields live in columns, not the payload, strip before storing. */
function payloadOf(item: WorkItem): string {
  const { status, returned, priority, ingestedAt, dueAt, dueSource, ...rest } = item
  void status; void returned; void priority; void ingestedAt; void dueAt; void dueSource
  return JSON.stringify(rest)
}

/** Append `add` to a provenance list, replacing an entry from the same run. */
function mergeProvenance(existing: Provenance[] | undefined, add?: Provenance): Provenance[] {
  const list = existing ? [...existing] : []
  if (!add) return list
  const key = (p: Provenance) => `${p.jobId ?? ''}|${p.runId ?? ''}`
  const i = list.findIndex((p) => key(p) === key(add))
  if (i >= 0) list[i] = add
  else list.push(add)
  return list.slice(-10)
}

/**
 * A find may fill reason and label (a job files them, core/job/filing.ts),
 * never overwrite them: once set, they are yours to change.
 */
const fieldsFill = (base: WorkItem, item: WorkItem): Pick<WorkItem, 'reason' | 'label'> => ({
  ...(base.reason ?? item.reason ? { reason: base.reason ?? item.reason } : {}),
  ...(base.label ?? item.label ? { label: base.label ?? item.label } : {}),
})

type EventRow = { seq: number; at: number; actor: string; event: string; detail: string | null }

const toEvent = (r: EventRow): ItemEvent => ({
  seq: r.seq,
  at: r.at,
  actor: r.actor,
  event: r.event as ItemEventKind,
  ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
})

/** Who an ingestion transition is attributed to. */
function upsertActor(p: Provenance | undefined): string {
  if (p?.runId) return `job:${p.runId}`
  if (p?.jobId) return `job:${p.jobId}`
  return 'system'
}

const evDetail = (p?: Provenance): Record<string, unknown> =>
  p ? { ...(p.jobId ? { jobId: p.jobId } : {}), ...(p.runId ? { runId: p.runId } : {}), ...(p.why ? { why: p.why } : {}) } : {}

/**
 * The durable inbox: one row per work item, an append-only event log per item.
 * Never hard-deletes; the idempotent upsert and deterministic reopen rules live
 * here (.docs/jobs-v2.md).
 */
export class SqliteWorkItems implements WorkItemStore {
  constructor(private db: DatabaseSync) {}

  private row(id: string): WorkItemRow | undefined {
    return this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined
  }

  private appendEvent(
    itemId: string,
    at: number,
    actor: string,
    event: ItemEventKind,
    detail: Record<string, unknown>,
  ): void {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM item_events WHERE item_id = ?')
      .get(itemId) as { s: number }
    this.db
      .prepare('INSERT INTO item_events (item_id, seq, at, actor, event, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, r.s + 1, at, actor, event, Object.keys(detail).length ? JSON.stringify(detail) : null)
  }

  async upsert(item: WorkItem, provenance?: Provenance): Promise<UpsertResult> {
    const incoming = Date.parse(item.updatedAt)
    if (!Number.isFinite(incoming)) return { outcome: 'unchanged', reopened: false }
    const now = Date.now()
    const actor = upsertActor(provenance)
    const existing = this.row(item.id)

    if (!existing) {
      const foundBy = mergeProvenance(item.foundBy, provenance)
      const stored: WorkItem = { ...item, why: provenance?.why ?? item.why, foundBy }
      this.db
        .prepare(
          `INSERT INTO work_items (id, source, kind, status, status_at, snooze_until, priority, pinned,
             returned, source_updated_at, ingested_at, payload, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`,
        )
        .run(item.id, item.source, item.kind, now, item.priority ?? null, incoming, now, payloadOf(stored), now, now)
      this.setExplicitDue(item)
      this.appendEvent(item.id, now, actor, 'created', evDetail(provenance))
      return { outcome: 'inserted', reopened: false }
    }

    const base = JSON.parse(existing.payload) as WorkItem
    const foundBy = mergeProvenance(base.foundBy, provenance)
    const newer = incoming > existing.source_updated_at
    const reopened = newer && shouldReopen(toStatus(existing.status), incoming, existing.status_at)

    if (!newer && !provenance) return { outcome: 'unchanged', reopened: false }

    const stored: WorkItem = newer
      ? {
          ...base,
          kind: item.kind,
          title: item.title,
          url: item.url,
          repo: item.repo,
          author: item.author,
          peopleWaiting: item.peopleWaiting,
          updatedAt: item.updatedAt,
          isDraft: item.isDraft,
          ciFailing: item.ciFailing,
          refs: item.refs ?? base.refs,
          why: provenance?.why ?? item.why ?? base.why,
          ask: item.ask ?? base.ask,
          ...fieldsFill(base, item),
          foundBy,
        }
      : // a re-find re-judges: its why and ask replace the last find's
        { ...base, why: provenance?.why ?? base.why, ask: item.ask ?? base.ask, ...fieldsFill(base, item), foundBy }

    if (reopened) {
      this.db
        .prepare(
          `UPDATE work_items SET kind = ?, source_updated_at = ?, payload = ?, status = 'open',
             status_at = ?, snooze_until = NULL, returned = 1, updated_at = ? WHERE id = ?`,
        )
        .run(item.kind, incoming, payloadOf(stored), now, now, item.id)
      this.appendEvent(item.id, now, actor, 'reopened', { sourceUpdatedAt: incoming, ...evDetail(provenance) })
    } else if (newer) {
      this.db
        .prepare('UPDATE work_items SET kind = ?, source_updated_at = ?, payload = ?, updated_at = ? WHERE id = ?')
        .run(item.kind, incoming, payloadOf(stored), now, item.id)
      this.appendEvent(item.id, now, actor, 'updated', evDetail(provenance))
    } else {
      // provenance-only re-find: refresh foundBy/why, no new source activity, no event
      this.db
        .prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?')
        .run(payloadOf(stored), now, item.id)
    }
    this.setExplicitDue(item)
    return { outcome: 'updated', reopened }
  }

  /** A deadline the source stated; never over one the user set. */
  private setExplicitDue(item: WorkItem): void {
    if (item.dueAt == null) return
    this.db
      .prepare(
        `UPDATE work_items SET due_at = ?, due_source = 'explicit'
         WHERE id = ? AND (due_source IS NULL OR due_source != 'you')`,
      )
      .run(item.dueAt, item.id)
  }

  async setDue(id: string, due: { at: number | null } | null): Promise<void> {
    this.db
      .prepare('UPDATE work_items SET due_at = ?, due_source = ?, updated_at = ? WHERE id = ?')
      .run(due?.at ?? null, due ? 'you' : null, Date.now(), id)
  }

  async backfillProjects(assign: (item: WorkItem) => string | null): Promise<number> {
    const rows = this.db
      .prepare("SELECT id, payload FROM work_items WHERE json_extract(payload, '$.projectId') IS NULL")
      .all() as { id: string; payload: string }[]
    const set = this.db.prepare('UPDATE work_items SET payload = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const item = JSON.parse(r.payload) as WorkItem
        const projectId = assign(item)
        if (!projectId) continue
        set.run(payloadOf({ ...item, projectId }), r.id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
  }

  async createManual(item: NewManualItem): Promise<string> {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const wi: WorkItem = {
      id: item.id,
      source: 'manual',
      kind: 'manual',
      title: item.title,
      url: item.url ?? '',
      repo: '',
      author: '',
      peopleWaiting: 0,
      createdAt: iso,
      updatedAt: iso,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.description ? { description: item.description, why: item.description } : {}),
      ...(item.urls?.length ? { urls: item.urls } : {}),
    }
    this.db
      .prepare(
        `INSERT INTO work_items (id, source, kind, status, status_at, snooze_until, priority, pinned,
           returned, source_updated_at, ingested_at, payload, created_at, updated_at)
         VALUES (?, 'manual', 'manual', 'open', ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, now, item.priority || null, now, now, payloadOf(wi), now, now)
    this.appendEvent(item.id, now, 'user', 'created', {})
    return item.id
  }

  async updateManual(id: string, patch: Partial<Omit<NewManualItem, 'id'>>): Promise<void> {
    const r = this.row(id)
    if (!r) return
    const base = JSON.parse(r.payload) as WorkItem
    const next: WorkItem = { ...base }
    if (patch.title !== undefined) next.title = patch.title
    if (patch.url !== undefined) next.url = patch.url
    if (patch.urls !== undefined) next.urls = patch.urls.length > 0 ? patch.urls : undefined
    if (patch.description !== undefined) {
      next.description = patch.description || undefined
      // manual items show the description as their "why" on the card
      next.why = patch.description || undefined
      delete next.note
    }
    if (patch.projectId !== undefined) next.projectId = patch.projectId || undefined
    const priority = patch.priority !== undefined ? patch.priority || null : r.priority
    this.db
      .prepare('UPDATE work_items SET payload = ?, priority = ?, updated_at = ? WHERE id = ?')
      .run(payloadOf(next), priority, Date.now(), id)
  }

  async get(id: string): Promise<WorkItem | null> {
    const r = this.row(id)
    return r ? toWorkItem(r) : null
  }

  async list(status: ItemStatus = 'open'): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM work_items WHERE status = ? ORDER BY source_updated_at DESC')
      .all(status) as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  async listAll(): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM work_items ORDER BY source_updated_at DESC')
      .all() as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  async transition(id: string, change: StatusChange): Promise<void> {
    if (!this.row(id)) return
    const now = Date.now()
    const snooze = change.status === 'snoozed' ? change.snoozeUntil ?? null : null
    this.db
      .prepare(
        'UPDATE work_items SET status = ?, status_at = ?, snooze_until = ?, returned = 0, updated_at = ? WHERE id = ?',
      )
      .run(change.status, now, snooze, now, id)
    this.appendEvent(id, now, change.actor, eventForStatus(change.status), {
      ...(change.snoozeUntil ? { snoozeUntil: change.snoozeUntil } : {}),
      ...(change.detail ?? {}),
    })
  }

  async setPriority(id: string, priority: number | null): Promise<void> {
    this.db.prepare('UPDATE work_items SET priority = ?, updated_at = ? WHERE id = ?').run(priority, Date.now(), id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE work_items SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id)
  }

  async wakeSnoozed(now: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT id FROM work_items WHERE status = ? AND snooze_until IS NOT NULL AND snooze_until <= ?')
      .all('snoozed', now) as { id: string }[]
    const upd = this.db.prepare(
      "UPDATE work_items SET status = 'open', snooze_until = NULL, status_at = ?, updated_at = ? WHERE id = ?",
    )
    for (const { id } of rows) {
      upd.run(now, now, id)
      this.appendEvent(id, now, 'system', 'woken', {})
    }
    return rows.map((r) => r.id)
  }

  async flowState(): Promise<Map<string, StoredFlow>> {
    const rows = this.db.prepare('SELECT id, stage, turn, flow_override FROM work_items').all() as {
      id: string
      stage: string | null
      turn: string | null
      flow_override: string | null
    }[]
    const out = new Map<string, StoredFlow>()
    for (const r of rows) {
      if (r.stage == null && r.turn == null && r.flow_override == null) continue
      out.set(r.id, { stage: r.stage, turn: r.turn, override: parseOverride(r.flow_override) })
    }
    return out
  }

  async recordFlow(id: string, flow: { stage: string; turn: string }, detail: Record<string, unknown> = {}): Promise<void> {
    const r = this.row(id)
    if (!r || (r.stage === flow.stage && r.turn === flow.turn)) return
    this.db.prepare('UPDATE work_items SET stage = ?, turn = ? WHERE id = ?').run(flow.stage, flow.turn, id)
    // The first recording is a baseline, not a move.
    if (r.stage == null && r.turn == null) return
    this.appendEvent(id, Date.now(), 'system', 'moved', {
      from: { stage: r.stage, turn: r.turn },
      to: { stage: flow.stage, turn: flow.turn },
      ...detail,
    })
  }

  async setFlowOverride(id: string, override: FlowOverride | null, actor: string): Promise<void> {
    if (!this.row(id)) throw new Error('no such work item')
    this.db.prepare('UPDATE work_items SET flow_override = ? WHERE id = ?').run(override ? JSON.stringify(override) : null, id)
    this.appendEvent(id, override?.at ?? Date.now(), actor, 'flow-set', override ? { ...override } : { cleared: true })
  }

  async countDoneSince(since: number): Promise<number> {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE status = 'done' AND status_at >= ?").get(since) as { n: number }
    return r.n
  }

  async statusTimes(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const get = this.db.prepare('SELECT status_at FROM work_items WHERE id = ?')
    for (const id of new Set(ids)) {
      const r = get.get(id) as { status_at: number } | undefined
      if (r) out.set(id, r.status_at)
    }
    return out
  }

  async deletedIds(): Promise<Set<string>> {
    const rows = this.db
      .prepare(
        `SELECT w.id FROM work_items w WHERE w.status = 'archived' AND (
           SELECT e.detail FROM item_events e WHERE e.item_id = w.id AND e.event = 'archived' ORDER BY e.seq DESC LIMIT 1
         ) LIKE '%"reason":"deleted by user"%'`,
      )
      .all() as { id: string }[]
    return new Set(rows.map((r) => r.id))
  }

  async events(id: string): Promise<ItemEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, at, actor, event, detail FROM item_events WHERE item_id = ? ORDER BY seq')
      .all(id) as EventRow[]
    return rows.map(toEvent)
  }

  async markSurfaced(entries: readonly SurfacedEntry[], at: number): Promise<string[]> {
    const marked: string[] = []
    const read = this.db.prepare('SELECT at, event FROM item_events WHERE item_id = ? ORDER BY seq')
    this.db.exec('BEGIN')
    try {
      for (const { id, detail } of entries) {
        if (marked.includes(id) || this.row(id)?.status !== 'open') continue
        // the cycle rule is core/work/state.ts's, so this and the attention split can't disagree
        if (surfacedThisCycle(read.all(id) as { at: number; event: ItemEventKind }[])) continue
        this.appendEvent(id, at, 'system', 'surfaced', detail ?? {})
        marked.push(id)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return marked
  }

  async note(id: string, event: ItemNoteKind, actor: string, at: number, detail: Record<string, unknown> = {}): Promise<boolean> {
    if (!this.row(id)) return false
    this.appendEvent(id, at, actor, event, detail)
    return true
  }

  async unnote(id: string, event: ItemNoteKind, actor: string, since: number): Promise<boolean> {
    const last = this.db
      .prepare('SELECT seq, at FROM item_events WHERE item_id = ? AND event = ? AND actor = ? ORDER BY seq DESC LIMIT 1')
      .get(id, event, actor) as { seq: number; at: number } | undefined
    if (!last || last.at < since) return false
    this.db.prepare('DELETE FROM item_events WHERE item_id = ? AND seq = ?').run(id, last.seq)
    return true
  }

  async eventsBetween(since: number, until: number): Promise<ItemWindowEvent[]> {
    // idx_item_events_at (migration 38)
    const rows = this.db
      .prepare('SELECT item_id, seq, at, actor, event, detail FROM item_events WHERE at >= ? AND at < ? ORDER BY at, item_id, seq')
      .all(since, until) as (EventRow & { item_id: string })[]
    return rows.map((r) => ({ itemId: r.item_id, ...toEvent(r) }))
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const base = JSON.parse(r.payload) as WorkItem
    const next: WorkItem = { ...base }
    delete next.note
    if (description) next.description = description
    else delete next.description
    // A manual item's card quotes its description as the "why"; source items keep the scanner's.
    if (base.source === 'manual') next.why = description || undefined
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setFields(id: string, patch: ItemFieldsPatch): Promise<void> {
    this.patchPayload(id, (next) => {
      for (const k of ['reason', 'label', 'parent', 'playbook', 'handoff', 'notNow', 'notNowReason', 'notUseful', 'changesSeenAt'] as const) {
        if (!(k in patch)) continue
        const v = patch[k]
        if (v == null) delete next[k]
        else Object.assign(next, { [k]: v })
      }
    })
  }

  async setPlan(id: string, plan: string | null): Promise<void> {
    this.patchPayload(id, (next) => {
      const memory = { decisions: [], ...next.memory }
      if (plan) memory.plan = plan
      else delete memory.plan
      next.memory = memory
    })
  }

  async addDecision(id: string, decision: Decision): Promise<void> {
    this.patchPayload(id, (next) => {
      const memory = { decisions: [] as Decision[], ...next.memory }
      next.memory = { ...memory, decisions: [...memory.decisions, decision] }
    })
  }

  /** Read-modify-write one item's payload; the user-owned fields only, never lifecycle columns. */
  private patchPayload(id: string, edit: (next: WorkItem) => void): void {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    edit(next)
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setImages(id: string, images: ItemImage[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (images.length > 0) next.images = images
    else delete next.images
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setFiles(id: string, files: FileRef[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (files.length > 0) next.files = files
    else delete next.files
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setUrls(id: string, urls: string[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (urls.length > 0) next.urls = urls
    else delete next.urls
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }
}
