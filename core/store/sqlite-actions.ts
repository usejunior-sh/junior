import { DatabaseSync } from 'node:sqlite'
import { type ActionRecord, isActionKind, isActionStatus, isActionWhy, isActionAllowedBy, type ActionActor, type ActionStatus, type ActionHistoryEntry } from '../actions/types.js'
import type { ActionStore, ActionQuery } from './types.js'

type ActionRow = {
  id: string
  session_id: string
  session_kind: string
  tool: string
  kind: string
  summary: string
  args: string
  status: string
  link: string | null
  error: string | null
  why: string
  why_detail: string | null
  allowed_by: string | null
  allowed_detail: string | null
  job_id: string | null
  team_run_id: string | null
  item_id: string | null
  group_key: string | null
  count: number
  attempted_at: number
  settled_at: number | null
  updated_at: number
  queue_args: string | null
  queued_at: number | null
  expires_at: number | null
  send_at: number | null
  queue_note: string | null
  edits: number | null
  delivery: string | null
  cost_usd: number | null
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Storage is text; a value this build doesn't know reads back as the safest neighbour. */
function toAction(r: ActionRow, calls: string[]): ActionRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    sessionKind: r.session_kind,
    tool: r.tool,
    kind: isActionKind(r.kind) ? r.kind : 'other',
    summary: r.summary,
    args: parseArgs(r.args),
    status: isActionStatus(r.status) ? r.status : 'attempted',
    link: r.link,
    error: r.error,
    why: isActionWhy(r.why) ? r.why : 'unknown',
    whyDetail: r.why_detail,
    allowedBy: isActionAllowedBy(r.allowed_by) ? r.allowed_by : null,
    allowedDetail: r.allowed_detail,
    jobId: r.job_id,
    teamRunId: r.team_run_id,
    itemId: r.item_id,
    groupKey: r.group_key,
    count: r.count,
    calls,
    attemptedAt: r.attempted_at,
    settledAt: r.settled_at,
    updatedAt: r.updated_at,
    queue:
      r.queue_args !== null && r.queue_args !== undefined
        ? {
            args: parseArgs(r.queue_args),
            queuedAt: r.queued_at ?? r.attempted_at,
            expiresAt: r.expires_at ?? r.attempted_at,
            sendAt: r.send_at,
            note: r.queue_note,
            edits: r.edits ?? 0,
            delivery: r.delivery,
            costUsd: r.cost_usd,
          }
        : null,
  }
}

type ActionHistoryRow = {
  action_id: string
  at: number
  actor: string
  event: string
  from_status: string | null
  to_status: string
  note: string | null
  args: string | null
}

const isActor = (v: string): v is ActionActor => v === 'agent' || v === 'you' || v === 'triage'

export class SqliteActions implements ActionStore {
  constructor(private db: DatabaseSync) {}

  /** Rows → records, each with its calls in the order they were folded in. One calls query per 500 rows. */
  private hydrate(rows: ActionRow[]): ActionRecord[] {
    if (!rows.length) return []
    const calls = new Map<string, string[]>()
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.id)
      const found = this.db
        .prepare(`SELECT action_id, tool_use_id FROM action_calls WHERE action_id IN (${ids.map(() => '?').join(', ')}) ORDER BY rowid`)
        .all(...ids) as { action_id: string; tool_use_id: string }[]
      for (const c of found) {
        const list = calls.get(c.action_id)
        if (list) list.push(c.tool_use_id)
        else calls.set(c.action_id, [c.tool_use_id])
      }
    }
    return rows.map((r) => toAction(r, calls.get(r.id) ?? []))
  }

  private one(sql: string, ...params: string[]): ActionRecord | null {
    const r = this.db.prepare(sql).get(...params) as ActionRow | undefined
    return r ? this.hydrate([r])[0] : null
  }

  async get(id: string): Promise<ActionRecord | null> {
    return this.one('SELECT * FROM actions WHERE id = ?', id)
  }

  async byCall(sessionId: string, toolUseId: string): Promise<ActionRecord | null> {
    return this.one(
      'SELECT a.* FROM action_calls c JOIN actions a ON a.id = c.action_id WHERE c.session_id = ? AND c.tool_use_id = ?',
      sessionId,
      toolUseId,
    )
  }

  async byGroup(groupKey: string): Promise<ActionRecord | null> {
    return this.one('SELECT * FROM actions WHERE group_key = ?', groupKey)
  }

  async put(a: ActionRecord): Promise<void> {
    const q = a.queue ?? null
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT INTO actions (id, session_id, session_kind, tool, kind, summary, args, status, link, error, why, why_detail,
             allowed_by, allowed_detail, job_id, team_run_id, item_id, group_key, count, attempted_at, settled_at, updated_at,
             queue_args, queued_at, expires_at, send_at, queue_note, edits, delivery, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             session_kind = excluded.session_kind, tool = excluded.tool, kind = excluded.kind, summary = excluded.summary,
             args = excluded.args, status = excluded.status, link = excluded.link, error = excluded.error, why = excluded.why,
             why_detail = excluded.why_detail, allowed_by = excluded.allowed_by, allowed_detail = excluded.allowed_detail,
             job_id = excluded.job_id, team_run_id = excluded.team_run_id, item_id = excluded.item_id,
             group_key = excluded.group_key, count = excluded.count, attempted_at = excluded.attempted_at,
             settled_at = excluded.settled_at, updated_at = excluded.updated_at,
             queue_args = excluded.queue_args, queued_at = excluded.queued_at, expires_at = excluded.expires_at,
             send_at = excluded.send_at, queue_note = excluded.queue_note, edits = excluded.edits,
             delivery = excluded.delivery, cost_usd = excluded.cost_usd`,
        )
        .run(
          a.id, a.sessionId, a.sessionKind, a.tool, a.kind, a.summary, JSON.stringify(a.args), a.status, a.link, a.error, a.why,
          a.whyDetail, a.allowedBy, a.allowedDetail, a.jobId, a.teamRunId, a.itemId, a.groupKey, a.count, a.attemptedAt,
          a.settledAt, a.updatedAt,
          q ? JSON.stringify(q.args) : null, q?.queuedAt ?? null, q?.expiresAt ?? null, q?.sendAt ?? null, q?.note ?? null,
          q?.edits ?? 0, q?.delivery ?? null, q?.costUsd ?? null,
        )
      const call = this.db.prepare(
        `INSERT INTO action_calls (session_id, tool_use_id, action_id) VALUES (?, ?, ?)
         ON CONFLICT (session_id, tool_use_id) DO UPDATE SET action_id = excluded.action_id`,
      )
      for (const c of a.calls) call.run(a.sessionId, c, a.id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM action_calls WHERE action_id = ?').run(id)
    this.db.prepare('DELETE FROM actions WHERE id = ?').run(id)
  }

  async list(q: ActionQuery = {}): Promise<ActionRecord[]> {
    const where: string[] = []
    const params: Array<string | number> = []
    if (q.kind) {
      where.push('kind = ?')
      params.push(q.kind)
    }
    if (q.sessionId) {
      where.push('session_id = ?')
      params.push(q.sessionId)
    }
    if (q.since !== undefined) {
      where.push('attempted_at >= ?')
      params.push(q.since)
    }
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => '?').join(', ')})`)
      params.push(...q.status)
    }
    if (q.itemId !== undefined || q.sessionIds?.length) {
      const any: string[] = []
      if (q.itemId !== undefined) {
        any.push('item_id = ?')
        params.push(q.itemId)
      }
      if (q.sessionIds?.length) {
        any.push(`session_id IN (${q.sessionIds.map(() => '?').join(', ')})`)
        params.push(...q.sessionIds)
      }
      where.push(`(${any.join(' OR ')})`)
    }
    const limit = Math.max(1, Math.min(q.limit ?? 500, 5000))
    const rows = this.db
      .prepare(`SELECT * FROM actions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY attempted_at DESC, id LIMIT ${limit}`)
      .all(...params) as ActionRow[]
    return this.hydrate(rows)
  }

  async claim(id: string, from: ActionStatus, to: ActionStatus, at: number, opts: { dueBy?: number } = {}): Promise<boolean> {
    // One statement: whoever runs it first moves the row; anyone after sees 0 changes.
    const r = this.db
      .prepare(
        `UPDATE actions SET status = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND status = ?${opts.dueBy !== undefined ? ' AND send_at IS NOT NULL AND send_at <= ?' : ''}`,
      )
      .run(...[to, at, id, from, ...(opts.dueBy !== undefined ? [opts.dueBy] : [])])
    return Number(r.changes) === 1
  }

  async addHistory(e: ActionHistoryEntry): Promise<void> {
    this.db
      .prepare('INSERT INTO action_history (action_id, at, actor, event, from_status, to_status, note, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.actionId, e.at, e.actor, e.event, e.from, e.to, e.note, e.args ? JSON.stringify(e.args) : null)
  }

  async history(ids: string[]): Promise<Map<string, ActionHistoryEntry[]>> {
    const out = new Map<string, ActionHistoryEntry[]>()
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500)
      if (!batch.length) continue
      const rows = this.db
        .prepare(`SELECT action_id, at, actor, event, from_status, to_status, note, args FROM action_history WHERE action_id IN (${batch.map(() => '?').join(', ')}) ORDER BY id`)
        .all(...batch) as ActionHistoryRow[]
      for (const r of rows) {
        const e: ActionHistoryEntry = {
          actionId: r.action_id,
          at: r.at,
          actor: isActor(r.actor) ? r.actor : 'triage',
          event: r.event,
          from: r.from_status && isActionStatus(r.from_status) ? r.from_status : null,
          to: isActionStatus(r.to_status) ? r.to_status : 'attempted',
          note: r.note,
          args: r.args ? parseArgs(r.args) : null,
        }
        const list = out.get(r.action_id)
        if (list) list.push(e)
        else out.set(r.action_id, [e])
      }
    }
    return out
  }
}
