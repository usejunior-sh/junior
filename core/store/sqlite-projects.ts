import { DatabaseSync } from 'node:sqlite'
import type { Project, Checkout } from '../../shared/protocol.js'
import type { ProjectStore, CheckoutStore, CheckoutPatch } from './types.js'

type ProjectRow = { id: string; name: string; repo: string; path: string; is_default?: number }

export class SqliteProjects implements ProjectStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Project[]> {
    const rows = this.db
      .prepare('SELECT id, name, repo, path, is_default FROM projects ORDER BY is_default DESC, name COLLATE NOCASE')
      .all() as ProjectRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path, ...(r.is_default ? { isDefault: true } : {}) }))
  }

  async create(p: Project): Promise<void> {
    this.db
      .prepare('INSERT INTO projects (id, name, repo, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, p.name, p.repo, p.path, Date.now())
  }

  async setDefault(id: string): Promise<void> {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE projects SET is_default = 0 WHERE is_default = 1').run()
      const r = this.db.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run(id)
      if (r.changes === 0) throw new Error('unknown project')
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async retireBuiltin(): Promise<Project[]> {
    // A short-lived dev build added a `builtin` column and a scratch project;
    // projects are always real folders now. Remove those rows, if any.
    const cols = new Set((this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((r) => r.name))
    if (!cols.has('builtin')) return []
    const rows = this.db.prepare('SELECT id, name, repo, path FROM projects WHERE builtin = 1').all() as ProjectRow[]
    this.db.prepare('DELETE FROM projects WHERE builtin = 1').run()
    return rows.map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path }))
  }

  async remove(id: string): Promise<void> {
    const r = this.db.prepare('SELECT is_default FROM projects WHERE id = ?').get(id) as { is_default: number } | undefined
    if (r?.is_default) throw new Error('the default project can only be replaced — make another project the default first')
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

type CheckoutRow = {
  id: string
  project_id: string
  kind: string
  path: string
  branch: string | null
  base: string | null
  item_id: string | null
  state: string
  created_at: number
}

const toCheckout = (r: CheckoutRow): Checkout => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind === 'worktree' ? 'worktree' : 'main',
  path: r.path,
  branch: r.branch,
  base: r.base,
  itemId: r.item_id,
  state: r.state === 'removed' ? 'removed' : 'active',
  createdAt: r.created_at,
})

export class SqliteCheckouts implements CheckoutStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Checkout[]> {
    const rows = this.db
      .prepare("SELECT * FROM checkouts ORDER BY project_id, kind = 'worktree', branch COLLATE NOCASE, created_at")
      .all() as CheckoutRow[]
    return rows.map(toCheckout)
  }

  async create(c: Checkout): Promise<void> {
    this.db
      .prepare('INSERT INTO checkouts (id, project_id, kind, path, branch, base, item_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.projectId, c.kind, c.path, c.branch, c.base, c.itemId, c.state, c.createdAt)
  }

  async update(id: string, patch: CheckoutPatch): Promise<void> {
    if (patch.branch !== undefined) this.db.prepare('UPDATE checkouts SET branch = ? WHERE id = ?').run(patch.branch, id)
    if (patch.state !== undefined) this.db.prepare('UPDATE checkouts SET state = ? WHERE id = ?').run(patch.state, id)
    if (patch.base !== undefined) this.db.prepare('UPDATE checkouts SET base = ? WHERE id = ?').run(patch.base, id)
    if (patch.itemId !== undefined) this.db.prepare('UPDATE checkouts SET item_id = ? WHERE id = ?').run(patch.itemId, id)
  }

  async removeForProject(projectId: string): Promise<void> {
    this.db.prepare('DELETE FROM checkouts WHERE project_id = ?').run(projectId)
  }
}
