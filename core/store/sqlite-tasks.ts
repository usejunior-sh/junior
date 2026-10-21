import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ItemTaskStore, TaskMovePatch } from './types.js'
import { canMove, isFinished, isTaskState, type ItemTask, type NewTask, type TaskOutput, type TaskState } from '../work/tasks.js'

type TaskRow = {
  id: string
  item_id: string
  title: string
  owner: string
  state: string
  why: string
  why_detail: string | null
  step: string | null
  input: string | null
  key: string | null
  output: string | null
  error: string | null
  session_id: string | null
  model: string | null
  cost_usd: number | null
  attempts: number
  created_at: number
  started_at: number | null
  ended_at: number | null
}

const WHYS = new Set(['playbook', 'event', 'you', 'junior'])

function json<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function toTask(r: TaskRow): ItemTask {
  return {
    id: r.id,
    itemId: r.item_id,
    title: r.title,
    owner: r.owner === 'you' ? 'you' : 'junior',
    // a state this build doesn't know reads as stopped: never run again by mistake
    state: isTaskState(r.state) ? r.state : 'stopped',
    why: (WHYS.has(r.why) ? r.why : 'junior') as ItemTask['why'],
    ...(r.why_detail ? { whyDetail: r.why_detail } : {}),
    ...(r.step ? { step: r.step } : {}),
    ...(r.input ? { input: json<Record<string, unknown>>(r.input) } : {}),
    ...(r.key ? { key: r.key } : {}),
    ...(r.output ? { output: json<TaskOutput>(r.output) } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.cost_usd != null ? { costUsd: r.cost_usd } : {}),
    attempts: r.attempts,
    createdAt: r.created_at,
    ...(r.started_at != null ? { startedAt: r.started_at } : {}),
    ...(r.ended_at != null ? { endedAt: r.ended_at } : {}),
  }
}

export class SqliteItemTasks implements ItemTaskStore {
  constructor(private db: DatabaseSync) {}

  async add(t: NewTask, now: number): Promise<ItemTask | null> {
    const id = t.id ?? randomUUID()
    const made = this.db
      .prepare(
        `INSERT OR IGNORE INTO item_tasks (id, item_id, title, owner, state, why, why_detail, step, input, key, model, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        t.itemId,
        t.title,
        t.owner,
        t.state ?? 'queued',
        t.why,
        t.whyDetail ?? null,
        t.step ?? null,
        t.input ? JSON.stringify(t.input) : null,
        t.key ?? null,
        t.model ?? null,
        now,
      ).changes
    return made ? this.get(id) : null
  }

  async get(id: string): Promise<ItemTask | null> {
    const r = this.db.prepare('SELECT * FROM item_tasks WHERE id = ?').get(id) as TaskRow | undefined
    return r ? toTask(r) : null
  }

  async list(itemId: string): Promise<ItemTask[]> {
    const rows = this.db.prepare('SELECT * FROM item_tasks WHERE item_id = ? ORDER BY created_at, rowid').all(itemId) as TaskRow[]
    return rows.map(toTask)
  }

  async forItems(itemIds: readonly string[]): Promise<Map<string, ItemTask[]>> {
    const out = new Map<string, ItemTask[]>()
    // chunks keep under SQLite's bound-parameter limit
    for (let i = 0; i < itemIds.length; i += 500) {
      const ids = itemIds.slice(i, i + 500)
      const rows = this.db
        .prepare(`SELECT * FROM item_tasks WHERE item_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at, rowid`)
        .all(...ids) as TaskRow[]
      for (const r of rows) {
        const t = toTask(r)
        out.set(t.itemId, [...(out.get(t.itemId) ?? []), t])
      }
    }
    return out
  }

  async inState(states: readonly TaskState[]): Promise<ItemTask[]> {
    if (states.length === 0) return []
    const rows = this.db
      .prepare(`SELECT * FROM item_tasks WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, rowid`)
      .all(...states) as TaskRow[]
    return rows.map(toTask)
  }

  async byKey(itemId: string, key: string): Promise<ItemTask | null> {
    const r = this.db.prepare('SELECT * FROM item_tasks WHERE item_id = ? AND key = ?').get(itemId, key) as TaskRow | undefined
    return r ? toTask(r) : null
  }

  async move(id: string, to: TaskState, patch: TaskMovePatch, now: number): Promise<ItemTask | null> {
    const t = await this.get(id)
    if (!t || !canMove(t.state, to)) return null
    const sets = ['state = ?']
    const args: (string | number | null)[] = [to]
    if (to === 'running') sets.push('started_at = ?', 'attempts = attempts + 1'), args.push(now)
    if (isFinished({ state: to })) sets.push('ended_at = ?'), args.push(now)
    if (patch.output !== undefined) sets.push('output = ?'), args.push(JSON.stringify(patch.output))
    if (patch.error !== undefined) sets.push('error = ?'), args.push(patch.error)
    if (patch.sessionId !== undefined) sets.push('session_id = ?'), args.push(patch.sessionId)
    if (patch.model !== undefined) sets.push('model = ?'), args.push(patch.model)
    // the WHERE re-checks the state, so two movers can't both win
    const changed = this.db.prepare(`UPDATE item_tasks SET ${sets.join(', ')} WHERE id = ? AND state = ?`).run(...args, id, t.state).changes
    return changed ? this.get(id) : null
  }

  async addCost(id: string, usd: number): Promise<void> {
    if (!(usd > 0)) return
    this.db.prepare('UPDATE item_tasks SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?').run(usd, id)
  }

  async requeueRunning(): Promise<string[]> {
    const rows = this.db.prepare("SELECT id FROM item_tasks WHERE state = 'running'").all() as { id: string }[]
    this.db.prepare("UPDATE item_tasks SET state = 'queued' WHERE state = 'running'").run()
    return rows.map((r) => r.id)
  }

  async spentSince(since: number): Promise<number> {
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM item_tasks WHERE started_at >= ?').get(since) as { usd: number }
    return r.usd
  }
}
