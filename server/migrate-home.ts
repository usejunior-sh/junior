/**
 * The Triage → Junior rename, once per machine: ~/.triage becomes ~/.junior
 * (and ~/.triage-dev becomes ~/.junior-dev). Runs before anything opens the
 * store, from the server and from the CLI, and does nothing once the old
 * folder is gone.
 *
 *   1. move the folder (merging into a ~/.junior the CLI may have just made)
 *   2. workspaces/<id>/triage.db (+ -wal, -shm) → junior.db
 *   3. every text value in every table: `/.triage/` → `/.junior/`, mcp__triage__ → mcp__junior__
 *   4. workspace files (jobs, teams, agents, library, playbooks, dispatch): the old names,
 *      keeping a seeded file that was untouched still untouched
 *   5. a project's own `.triage/` folder (team runs) → `.junior/`
 *   6. Claude Code's transcripts for sessions that ran under the old folder, so they resume
 *   7. git worktrees under workspaces/<id>/worktrees: their repo still points at the old path
 *
 * No fallbacks: nothing reads the old names after this.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PROTECT = ['novus-triage', 'triage-web', 'gh-triage', 'triage-growth', 'triage-development', 'heytriage']
const FILE_DIRS = ['jobs', 'teams', 'agents', 'library', 'playbooks', 'dispatch']
const TEXT = /\.(md|json|ya?ml|txt)$/

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
/** Claude Code's folder name for a cwd under ~/.claude/projects. */
const projectKey = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** Case-preserving triage → junior, leaving names that aren't the product's (folders, ids). */
export function renameText(s: string): string {
  const keep: string[] = []
  for (const p of PROTECT) s = s.split(p).join(`\u0001${keep.push(p) - 1}\u0002`)
  s = s.replaceAll('TRIAGE', 'JUNIOR').replaceAll('Triage', 'Junior').replaceAll('triage', 'junior')
  return s.replace(/\u0001(\d+)\u0002/g, (_, i: string) => keep[+i])
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function migrateHome(newDir: string, log: (m: string) => void = () => {}): void {
  const base = path.basename(newDir)
  if (base !== '.junior' && !base.startsWith('.junior-')) return
  const oldDir = path.join(path.dirname(newDir), base.replace('.junior', '.triage'))
  if (!existsSync(oldDir) || existsSync(path.join(newDir, 'workspaces.json'))) return
  try {
    const { pid } = JSON.parse(readFileSync(path.join(oldDir, 'server.json'), 'utf8')) as { pid?: number }
    if (pid && pid !== process.pid && alive(pid)) {
      throw new Error(`the old Triage server (pid ${pid}) still runs from ${oldDir} — stop it, then start Junior again`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('the old Triage')) throw err
  }

  // 1. the folder
  if (!existsSync(newDir)) renameSync(oldDir, newDir)
  else {
    for (const name of readdirSync(oldDir)) {
      if (!existsSync(path.join(newDir, name))) renameSync(path.join(oldDir, name), path.join(newDir, name))
    }
    try {
      rmdirSync(oldDir)
    } catch {
      log(`migrate: left ${oldDir} (it still holds files ${newDir} already had)`)
    }
  }
  const oldSeg = `/${path.basename(oldDir)}/`
  const newSeg = `/${base}/`
  const swaps: [string, string][] = [
    [oldSeg, newSeg],
    ['/.triage/', '/.junior/'],
    ['mcp__triage__', 'mcp__junior__'],
  ]

  const registry = path.join(newDir, 'workspaces.json')
  if (existsSync(registry)) {
    let s = readFileSync(registry, 'utf8')
    for (const [a, b] of swaps) s = s.replaceAll(a, b)
    writeFileSync(registry, s)
  }

  const wsRoot = path.join(newDir, 'workspaces')
  const workspaces = existsSync(wsRoot) ? readdirSync(wsRoot).filter((d) => statSync(path.join(wsRoot, d)).isDirectory()) : []
  const cwds = new Set<string>()
  const roots = new Set<string>()
  for (const id of workspaces) {
    const ws = path.join(wsRoot, id)
    // 2. the database
    for (const ext of ['', '-wal', '-shm']) {
      const from = path.join(ws, `triage.db${ext}`)
      if (existsSync(from) && !existsSync(path.join(ws, `junior.db${ext}`))) renameSync(from, path.join(ws, `junior.db${ext}`))
    }
    const dbFile = path.join(ws, 'junior.db')
    if (existsSync(dbFile)) {
      try {
        rewriteDb(dbFile, swaps, cwds, roots)
      } catch (err) {
        log(`migrate: ${id}: ${(err as Error).message}`)
      }
    }
    // 4. workspace files
    const rehash = new Map<string, string>()
    for (const dir of FILE_DIRS) rewriteFiles(path.join(ws, dir), rehash)
    const actions = path.join(ws, 'actions.md')
    if (existsSync(actions)) {
      const s = readFileSync(actions, 'utf8')
      const next = renameText(s)
      if (next !== s) {
        writeFileSync(actions, next)
        rehash.set(hash(s), hash(next))
      }
    }
    rewriteManifests(ws, rehash)
  }

  // 5. project folders
  for (const root of roots) {
    const from = path.join(root, '.triage')
    const to = path.join(root, '.junior')
    if (existsSync(from) && !existsSync(to)) renameSync(from, to)
  }

  // 6. transcripts, so `resume` finds them under the new cwd
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
  for (const cwd of cwds) {
    const to = projectKey(cwd)
    const from = projectKey(cwd.replace(newSeg, oldSeg).replace('/.junior/', '/.triage/'))
    if (from === to) continue
    const src = path.join(projects, from)
    const dst = path.join(projects, to)
    if (existsSync(src) && !existsSync(dst)) renameSync(src, dst)
  }
  // 7. worktrees: `repair` from inside one fixes its repo's pointer back to it
  for (const id of workspaces) repairWorktrees(path.join(wsRoot, id, 'worktrees'), log)
  log(`migrate: moved ${oldDir} → ${newDir} (${workspaces.length} workspaces)`)
}

function repairWorktrees(dir: string, log: (m: string) => void, depth = 0): void {
  if (depth > 3 || !existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = path.join(dir, entry.name)
    if (existsSync(path.join(p, '.git'))) {
      try {
        execFileSync('git', ['-C', p, 'worktree', 'repair'], { stdio: 'ignore' })
      } catch {
        log(`migrate: couldn't repair the worktree at ${p}`)
      }
    } else repairWorktrees(p, log, depth + 1)
  }
}

function rewriteDb(file: string, swaps: [string, string][], cwds: Set<string>, roots: Set<string>): void {
  const db = new DatabaseSync(file)
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]
    db.exec('BEGIN')
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
      for (const { name: col } of cols) {
        for (const [a, b] of swaps) {
          db.prepare(`UPDATE "${name}" SET "${col}" = replace("${col}", ?, ?) WHERE typeof("${col}") = 'text' AND instr("${col}", ?) > 0`).run(a, b, a)
        }
      }
    }
    db.exec('COMMIT')
    try {
      for (const r of db.prepare(`SELECT DISTINCT cwd FROM sessions WHERE cwd LIKE '%/.junior%'`).all() as { cwd: string }[]) cwds.add(r.cwd)
    } catch {
      /* no sessions table */
    }
    try {
      for (const r of db.prepare(`SELECT path FROM projects`).all() as { path: string }[]) roots.add(r.path)
    } catch {
      /* no projects table */
    }
    // Project folders that held team runs: `<root>/.junior/team-runs/…` now in the rewritten text.
    try {
      for (const r of db.prepare(`SELECT value FROM config WHERE instr(value, '/.junior/team-runs/') > 0`).all() as { value: string }[]) {
        for (const m of r.value.matchAll(/"([^"]+?)\/\.junior\/team-runs\//g)) roots.add(m[1])
      }
    } catch {
      /* no config table */
    }
  } finally {
    db.close()
  }
}

/** Rewrites the old names; `rehash` maps each file's old hash to its new one. */
function rewriteFiles(dir: string, rehash: Map<string, string>): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'node_modules') rewriteFiles(p, rehash)
    } else if (TEXT.test(entry.name) && !entry.name.endsWith('.seeded.json')) {
      const s = readFileSync(p, 'utf8')
      const next = renameText(s)
      if (next === s) continue
      writeFileSync(p, next)
      rehash.set(hash(s), hash(next))
    }
  }
}

/** A seeded file the user never touched stays untouched, so it still follows upgrades. */
function rewriteManifests(ws: string, rehash: Map<string, string>): void {
  const manifests = [path.join(ws, '.actions.seeded.json'), ...FILE_DIRS.map((d) => path.join(ws, d, '.seeded.json'))]
  for (const m of manifests) {
    if (!existsSync(m)) continue
    try {
      const data = JSON.parse(readFileSync(m, 'utf8')) as { hash?: string | null; files?: Record<string, { hash: string | null }> }
      if (data.hash) data.hash = rehash.get(data.hash) ?? data.hash
      for (const entry of Object.values(data.files ?? {})) if (entry.hash) entry.hash = rehash.get(entry.hash) ?? entry.hash
      writeFileSync(m, JSON.stringify(data, null, 2) + '\n')
    } catch {
      /* a bad manifest is the seeder's problem, not the rename's */
    }
  }
}
