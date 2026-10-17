import { DatabaseSync } from 'node:sqlite'
import { type EffortLevel, type PermissionMode, type ProviderId, isProviderId, type SessionEvent, type InboxSnapshot } from '../../shared/protocol.js'
import type { StoredSession, SessionStore, NewSession, SessionKind, JobRunRecord, StoredTurn, TurnStore, EventStore, StoredEvent, InboxStore, ConfigStore } from './types.js'
import { toRunStatus, toTrigger } from './sqlite-jobs.js'

type SessionRow = {
  id: string
  title: string
  cwd: string
  project_id: string | null
  checkout_id: string | null
  sdk_session_id: string | null
  model: string | null
  effort: string | null
  fast_mode: number
  planning?: number
  permission_mode: string | null
  provider: string | null
  pinned: number
  kind: string | null
  job_id: string | null
  run_status: string | null
  run_trigger: string | null
  run_matches: number | null
  run_new: number | null
  run_tokens: number | null
  run_cost_usd: number | null
  run_error: string | null
  created_at: number
  updated_at: number
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/** Storage is text; anything the app no longer recognizes reads back as null. */
const toEffort = (v: string | null): EffortLevel | null =>
  EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : null

/**
 * Same rule, and it matters more here: a mode we stop recognizing must fall
 * back to asking, never to a permissive mode inferred from a stale string.
 */
const toPermissionMode = (v: string | null): PermissionMode | null =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : null

/** An agent this build doesn't know reads back as Claude, the one every row started on. */
const toProvider = (v: string | null): ProviderId => (isProviderId(v) ? v : 'claude')

const toSession = (r: SessionRow): StoredSession => ({
  id: r.id,
  title: r.title,
  cwd: r.cwd,
  projectId: r.project_id,
  checkoutId: r.checkout_id ?? null,
  sdkSessionId: r.sdk_session_id,
  model: r.model,
  effort: toEffort(r.effort),
  fastMode: r.fast_mode === 1,
  planning: r.planning === 1,
  permissionMode: toPermissionMode(r.permission_mode),
  provider: toProvider(r.provider),
  pinned: r.pinned === 1,
  kind: r.kind === 'job-run' || r.kind === 'brief' || r.kind === 'goal' ? r.kind : 'chat',
  jobId: r.job_id,
  runStatus: toRunStatus(r.run_status),
  runTrigger: toTrigger(r.run_trigger),
  runMatches: r.run_matches ?? undefined,
  runNew: r.run_new ?? undefined,
  runTokens: r.run_tokens ?? undefined,
  runCostUsd: r.run_cost_usd ?? undefined,
  runError: r.run_error ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class SqliteSessions implements SessionStore {
  constructor(private db: DatabaseSync) {}

  async create(s: NewSession): Promise<StoredSession> {
    const now = Date.now()
    const model = s.model ?? null
    const effort = s.effort ?? null
    const fastMode = s.fastMode ?? false
    const permissionMode = s.permissionMode ?? null
    const provider: ProviderId = s.provider ?? 'claude'
    const kind: SessionKind = s.kind ?? 'chat'
    const jobId = s.jobId ?? null
    const checkoutId = s.checkoutId ?? null
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, project_id, checkout_id, sdk_session_id, model, effort, fast_mode, planning, permission_mode, provider, kind, job_id, run_trigger, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.cwd, s.projectId, checkoutId, model, effort, fastMode ? 1 : 0, s.planning ? 1 : 0, permissionMode, provider, kind, jobId, s.runTrigger ?? null, now, now)
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      projectId: s.projectId,
      checkoutId,
      model,
      effort,
      fastMode,
      planning: s.planning ?? false,
      permissionMode,
      provider,
      kind,
      jobId,
      ...(s.runTrigger ? { runTrigger: s.runTrigger } : {}),
      pinned: false,
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  async get(id: string): Promise<StoredSession | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r ? toSession(r) : null
  }

  async list(): Promise<StoredSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as SessionRow[]
    return rows.map(toSession)
  }

  async backfillProjects(assign: (cwd: string) => string | null): Promise<number> {
    const rows = this.db.prepare('SELECT id, cwd FROM sessions WHERE project_id IS NULL').all() as { id: string; cwd: string }[]
    const set = this.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const projectId = assign(r.cwd)
        if (!projectId) continue
        set.run(projectId, r.id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
  }

  async backfillCheckouts(assign: (projectId: string | null) => string | null): Promise<number> {
    const rows = this.db.prepare('SELECT id, project_id FROM sessions WHERE checkout_id IS NULL').all() as { id: string; project_id: string | null }[]
    const set = this.db.prepare('UPDATE sessions SET checkout_id = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const checkoutId = assign(r.project_id)
        if (!checkoutId) continue
        set.run(checkoutId, r.id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  async setModel(id: string, model: string | null, effort: EffortLevel | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET model = ?, effort = ? WHERE id = ?').run(model, effort, id)
  }

  async setPlanning(id: string, planning: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET planning = ? WHERE id = ?').run(planning ? 1 : 0, id)
  }

  async setFastMode(id: string, fastMode: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET fast_mode = ? WHERE id = ?').run(fastMode ? 1 : 0, id)
  }

  async setPermissionMode(id: string, mode: PermissionMode | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id)
  }

  async rename(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  /**
   * Delete a session and its log. The event rows reference the session, so
   * they go first, with foreign keys on, the other order fails.
   */
  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async touch(id: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  async recordJobRun(id: string, run: JobRunRecord): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET run_status = ?, run_matches = ?, run_new = ?, run_tokens = ?, run_cost_usd = ?, run_error = ?, updated_at = ? WHERE id = ?')
      .run(run.status, run.matches, run.newCount ?? null, run.tokens, run.costUsd ?? null, run.error ?? null, Date.now(), id)
  }
}

type TurnRow = {
  session_id: string
  seq: number
  root: string
  pre_tree: string
  post_tree: string | null
  started_at: number
  ended_at: number | null
  touched: string
}

const turnFrom = (r: TurnRow): StoredTurn => ({
  sessionId: r.session_id,
  seq: r.seq,
  root: r.root,
  preTree: r.pre_tree,
  postTree: r.post_tree,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  touched: parseJsonArray(r.touched),
})

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export class SqliteTurns implements TurnStore {
  constructor(private db: DatabaseSync) {}

  async begin(t: { sessionId: string; seq: number; root: string; preTree: string; startedAt: number }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_turns (session_id, seq, root, pre_tree, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET root = excluded.root, pre_tree = excluded.pre_tree,
           started_at = excluded.started_at, post_tree = NULL, ended_at = NULL`,
      )
      .run(t.sessionId, t.seq, t.root, t.preTree, t.startedAt)
  }

  async end(
    sessionId: string,
    seq: number,
    post: { postTree: string | null; endedAt: number; touched: string[] },
  ): Promise<void> {
    this.db
      .prepare('UPDATE session_turns SET post_tree = ?, ended_at = ?, touched = ? WHERE session_id = ? AND seq = ?')
      .run(post.postTree, post.endedAt, JSON.stringify(post.touched), sessionId, seq)
  }

  async list(sessionId: string): Promise<StoredTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as TurnRow[]
    return rows.map(turnFrom)
  }

  async othersInRoot(root: string, exceptSessionId: string): Promise<StoredTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_turns WHERE root = ? AND session_id != ? ORDER BY started_at')
      .all(root, exceptSessionId) as TurnRow[]
    return rows.map(turnFrom)
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM session_turns WHERE session_id = ?')
      .get(sessionId) as { n: number }
    return r.n
  }

  async removeFor(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId)
  }
}

export class SqliteEvents implements EventStore {
  constructor(private db: DatabaseSync) {}

  async append(sessionId: string, seq: number, event: SessionEvent): Promise<void> {
    this.db
      .prepare('INSERT INTO session_events (session_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, seq, event.kind, JSON.stringify(event), Date.now())
  }

  async read(sessionId: string, afterSeq = 0): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, payload, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, afterSeq) as { seq: number; payload: string; created_at: number }[]
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as SessionEvent, createdAt: r.created_at }))
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM session_events WHERE session_id = ?')
      .get(sessionId) as { s: number }
    return r.s
  }
}

export class SqliteInbox implements InboxStore {
  constructor(private db: DatabaseSync) {}

  async save(snapshot: InboxSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO inbox_snapshot (id, synced_at, payload) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET synced_at = excluded.synced_at, payload = excluded.payload`,
      )
      .run(snapshot.syncedAt, JSON.stringify({ items: snapshot.items, notices: snapshot.notices }))
  }

  async load(): Promise<InboxSnapshot | null> {
    const r = this.db.prepare('SELECT synced_at, payload FROM inbox_snapshot WHERE id = 1').get() as
      | { synced_at: number; payload: string }
      | undefined
    if (!r) return null
    const body = JSON.parse(r.payload) as Pick<InboxSnapshot, 'items' | 'notices'>
    return { syncedAt: r.synced_at, items: body.items, notices: body.notices }
  }
}

export class SqliteConfig implements ConfigStore {
  constructor(private db: DatabaseSync) {}

  async get<T>(key: string): Promise<T | null> {
    const r = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return r ? (JSON.parse(r.value) as T) : null
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value))
  }
}
