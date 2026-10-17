import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { type Artifact, isArtifactAuthor, type Link, isLinkKind, isLinkRole, type LinkKind, type BriefJob, type BriefStatus } from '../../shared/protocol.js'
import type { ArtifactStore, LinkStore, NewLink, BriefJobStore, NewBriefJob } from './types.js'

// ---------------------------------------------------------------------------
// Artifacts index + links (.docs/next-version.md, phase 1)
// ---------------------------------------------------------------------------

type ArtifactRow = {
  id: string
  path: string
  title: string
  author: string
  refs: string
  created: number
  updated: number
  mtime: number
  size: number
  indexed_at: number
  warning: string | null
}

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id,
  path: r.path,
  title: r.title,
  author: isArtifactAuthor(r.author) ? r.author : 'human',
  refs: (() => {
    try {
      const v: unknown = JSON.parse(r.refs)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })(),
  created: r.created,
  updated: r.updated,
  mtime: r.mtime,
  size: r.size,
  ...(r.warning ? { warning: r.warning } : {}),
})

export class SqliteArtifacts implements ArtifactStore {
  constructor(private db: DatabaseSync) {}

  async upsert(a: Artifact): Promise<void> {
    // A different file now lives at this path (replaced, or re-created without
    // its id): the old row is stale and would violate the UNIQUE(path).
    this.db.prepare('DELETE FROM artifacts WHERE path = ? AND id != ?').run(a.path, a.id)
    this.db
      .prepare(
        `INSERT INTO artifacts (id, path, title, author, refs, created, updated, mtime, size, indexed_at, warning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, title = excluded.title, author = excluded.author, refs = excluded.refs,
           created = excluded.created, updated = excluded.updated, mtime = excluded.mtime,
           size = excluded.size, indexed_at = excluded.indexed_at, warning = excluded.warning`,
      )
      .run(a.id, a.path, a.title, a.author, JSON.stringify(a.refs), a.created, a.updated, a.mtime, a.size, Date.now(), a.warning ?? null)
  }

  async get(id: string): Promise<Artifact | null> {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    return r ? toArtifact(r) : null
  }

  async getByPath(p: string): Promise<Artifact | null> {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE path = ?').get(p) as ArtifactRow | undefined
    return r ? toArtifact(r) : null
  }

  async list(): Promise<Artifact[]> {
    const rows = this.db.prepare('SELECT * FROM artifacts ORDER BY updated DESC, title COLLATE NOCASE').all() as ArtifactRow[]
    return rows.map(toArtifact)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id)
  }
}

type LinkRow = {
  id: string
  from_kind: string
  from_id: string
  to_kind: string
  to_id: string
  role: string
  created_at: number
}

const toLink = (r: LinkRow): Link => ({
  id: r.id,
  fromKind: isLinkKind(r.from_kind) ? r.from_kind : 'artifact',
  fromId: r.from_id,
  toKind: isLinkKind(r.to_kind) ? r.to_kind : 'item',
  toId: r.to_id,
  role: isLinkRole(r.role) ? r.role : 'context',
  createdAt: r.created_at,
})

export class SqliteLinks implements LinkStore {
  constructor(private db: DatabaseSync) {}

  async add(l: NewLink): Promise<Link> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (id, from_kind, from_id, to_kind, to_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), l.fromKind, l.fromId, l.toKind, l.toId, l.role, Date.now())
    const r = this.db
      .prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ? AND role = ?')
      .get(l.fromKind, l.fromId, l.toKind, l.toId, l.role) as LinkRow
    return toLink(r)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id)
  }

  async removeFor(kind: LinkKind, id: string): Promise<void> {
    this.db
      .prepare('DELETE FROM links WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?)')
      .run(kind, id, kind, id)
  }

  async forTarget(kind: LinkKind, id: string): Promise<Link[]> {
    const rows = this.db.prepare('SELECT * FROM links WHERE to_kind = ? AND to_id = ? ORDER BY created_at').all(kind, id) as LinkRow[]
    return rows.map(toLink)
  }

  async forSource(kind: LinkKind, id: string): Promise<Link[]> {
    const rows = this.db.prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY created_at').all(kind, id) as LinkRow[]
    return rows.map(toLink)
  }

  async list(): Promise<Link[]> {
    return (this.db.prepare('SELECT * FROM links ORDER BY created_at').all() as LinkRow[]).map(toLink)
  }
}

// ---------------------------------------------------------------------------
// Brief jobs (.docs/next-version.md, phase 2)
// ---------------------------------------------------------------------------

type BriefJobRow = {
  id: string
  item_id: string
  status: string
  playbook: string
  playbook_body: string | null
  model: string | null
  note: string | null
  session_id: string | null
  artifact_id: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

const BRIEF_STATUS_SET = new Set<string>(['queued', 'running', 'ready', 'failed'])

const toBriefJob = (r: BriefJobRow): BriefJob => ({
  id: r.id,
  itemId: r.item_id,
  status: BRIEF_STATUS_SET.has(r.status) ? (r.status as BriefStatus) : 'failed',
  playbook: r.playbook,
  playbookBody: r.playbook_body ?? null,
  model: r.model,
  note: r.note,
  sessionId: r.session_id,
  artifactId: r.artifact_id,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

export class SqliteBriefJobs implements BriefJobStore {
  constructor(private db: DatabaseSync) {}

  private row(id: string): BriefJobRow | undefined {
    return this.db.prepare('SELECT * FROM brief_jobs WHERE id = ?').get(id) as BriefJobRow | undefined
  }

  async create(j: NewBriefJob): Promise<BriefJob> {
    this.db
      .prepare(
        `INSERT INTO brief_jobs (id, item_id, status, playbook, playbook_body, model, note, session_id, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        j.id, j.itemId, j.running ? 'running' : 'queued', j.playbook, j.playbookBody ?? null, j.model ?? null, j.note ?? null,
        j.running?.sessionId ?? null, j.running?.startedAt ?? null, Date.now(),
      )
    return toBriefJob(this.row(j.id)!)
  }

  async get(id: string): Promise<BriefJob | null> {
    const r = this.row(id)
    return r ? toBriefJob(r) : null
  }

  async latestForItem(itemId: string): Promise<BriefJob | null> {
    const r = this.db
      .prepare('SELECT * FROM brief_jobs WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(itemId) as BriefJobRow | undefined
    return r ? toBriefJob(r) : null
  }

  async forSession(sessionId: string): Promise<BriefJob | null> {
    const r = this.db
      .prepare('SELECT * FROM brief_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as BriefJobRow | undefined
    return r ? toBriefJob(r) : null
  }

  async latestPerItem(): Promise<BriefJob[]> {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM brief_jobs b
         JOIN (SELECT item_id, MAX(created_at) AS c FROM brief_jobs GROUP BY item_id) m
           ON m.item_id = b.item_id AND m.c = b.created_at
         ORDER BY b.created_at DESC`,
      )
      .all() as BriefJobRow[]
    return rows.map(toBriefJob)
  }

  async list(status?: BriefStatus): Promise<BriefJob[]> {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM brief_jobs WHERE status = ? ORDER BY created_at').all(status)
        : this.db.prepare('SELECT * FROM brief_jobs ORDER BY created_at').all()
    ) as BriefJobRow[]
    return rows.map(toBriefJob)
  }

  async countStartedSince(sinceMs: number): Promise<number> {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM brief_jobs WHERE started_at IS NOT NULL AND started_at >= ?')
      .get(sinceMs) as { n: number }
    return r.n
  }

  async update(id: string, patch: Partial<Omit<BriefJob, 'id' | 'itemId' | 'playbook' | 'playbookBody'>>): Promise<void> {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    const col: Record<string, string> = {
      status: 'status',
      model: 'model',
      note: 'note',
      sessionId: 'session_id',
      artifactId: 'artifact_id',
      error: 'error',
      createdAt: 'created_at',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in col) || v === undefined) continue
      sets.push(`${col[k]} = ?`)
      vals.push(v as string | number | null)
    }
    if (!sets.length) return
    vals.push(id)
    this.db.prepare(`UPDATE brief_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  async failAllRunning(error: string): Promise<string[]> {
    const rows = this.db.prepare("SELECT id FROM brief_jobs WHERE status = 'running'").all() as { id: string }[]
    const now = Date.now()
    const upd = this.db.prepare("UPDATE brief_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
    for (const { id } of rows) upd.run(error, now, id)
    return rows.map((r) => r.id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM brief_jobs WHERE id = ?').run(id)
  }
}
