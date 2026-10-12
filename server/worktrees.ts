/**
 * Worktrees, phase 1: see them (decision 549a251e, .docs/worktrees-ux.html).
 *
 * A project's checkouts are its main folder plus every `git worktree` of the
 * same repo. They are *discovered* with `git worktree list`, so worktrees made
 * outside triage — by you, by an agent mid-session — show up too. Rows are
 * stored so sessions and terminals can name one.
 *
 * Phase 2, make them: triage creates a worktree *before* the session starts,
 * so the session's folder is the worktree — never the agent mid-session. New
 * ones live outside the repo, under the workspace folder, so nothing needs
 * ignoring and nothing scans them. Triage never runs `git switch` in the main
 * folder; that one is the user's.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { slugify } from '../shared/branch.js'
import type { Checkout, CheckoutState, Project, RemovalCheck } from '../shared/protocol.js'
import type { CheckoutStore } from '../core/store/types.js'
import { aheadOf, currentBranch, listWorktrees, repoRoot, worktreeChanges } from './git.js'

const pExecFile = promisify(execFile)

/** What git says about one project's folders, mapped onto the project's own subfolder. */
export type SeenCheckouts = {
  mainBranch: string | null
  /** null = git couldn't say (not a repo, or it failed) — worktree rows are left alone */
  worktrees: { path: string; branch: string | null }[] | null
}

export type CheckoutPlan = {
  create: Checkout[]
  update: { id: string; patch: { branch?: string | null; state?: CheckoutState } }[]
}

/**
 * What one project's checkout rows need so they match what git reports. Pure.
 * Worktrees are matched by folder: one that went away is marked removed (its
 * sessions keep their history), one that came back is active again.
 */
export function reconcileCheckouts(
  project: Project,
  existing: readonly Checkout[],
  seen: SeenCheckouts,
  now: number,
  newId: () => string = randomUUID,
): CheckoutPlan {
  const plan: CheckoutPlan = { create: [], update: [] }
  const mine = existing.filter((c) => c.projectId === project.id)

  const main = mine.find((c) => c.kind === 'main')
  if (!main) {
    plan.create.push({
      id: newId(),
      projectId: project.id,
      kind: 'main',
      path: project.path,
      branch: seen.mainBranch,
      base: null,
      itemId: null,
      state: 'active',
      createdAt: now,
    })
  } else if (main.branch !== seen.mainBranch) {
    plan.update.push({ id: main.id, patch: { branch: seen.mainBranch } })
  }

  if (!seen.worktrees) return plan
  const listed = new Map(seen.worktrees.map((w) => [path.resolve(w.path), w]))
  const rows = mine.filter((c) => c.kind === 'worktree')
  for (const row of rows) {
    const w = listed.get(path.resolve(row.path))
    if (!w) {
      if (row.state !== 'removed') plan.update.push({ id: row.id, patch: { state: 'removed' } })
      continue
    }
    const patch: { branch?: string | null; state?: CheckoutState } = {}
    if (row.state !== 'active') patch.state = 'active'
    if (row.branch !== w.branch) patch.branch = w.branch
    if (Object.keys(patch).length) plan.update.push({ id: row.id, patch })
  }
  const known = new Set(rows.map((r) => path.resolve(r.path)))
  for (const [abs, w] of listed) {
    if (known.has(abs)) continue
    plan.create.push({
      id: newId(),
      projectId: project.id,
      kind: 'worktree',
      path: w.path,
      branch: w.branch,
      base: null,
      itemId: null,
      state: 'active',
      createdAt: now,
    })
  }
  return plan
}

const real = (p: string) => realpath(p).catch(() => path.resolve(p))

/**
 * Ask git about one project. A project that is a subfolder of its repo gets
 * the same subfolder of each worktree. Folders that are another project of
 * the workspace are left to that project.
 */
export async function seeCheckouts(project: Project, otherProjects: readonly string[]): Promise<SeenCheckouts> {
  const root = await repoRoot(project.path)
  if (!root) return { mainBranch: null, worktrees: null }
  const mainBranch = await currentBranch(project.path)
  try {
    const rel = path.relative(await real(root), await real(project.path))
    const rootReal = await real(root)
    const others = new Set(await Promise.all(otherProjects.map(real)))
    const worktrees: { path: string; branch: string | null }[] = []
    for (const w of await listWorktrees(project.path)) {
      if (w.prunable) continue
      const wReal = await real(w.path)
      if (wReal === rootReal) continue
      const folder = path.join(w.path, rel)
      if (others.has(await real(folder))) continue
      worktrees.push({ path: folder, branch: w.branch })
    }
    return { mainBranch, worktrees }
  } catch {
    return { mainBranch, worktrees: null }
  }
}

/** Bring every project's checkout rows up to date with git. Returns the full list and whether anything moved. */
export async function syncProjectCheckouts(
  store: CheckoutStore,
  projects: readonly Project[],
  now = Date.now(),
): Promise<{ checkouts: Checkout[]; changed: boolean }> {
  const existing = await store.list()
  const seen = await Promise.all(
    projects.map((p) => seeCheckouts(p, projects.filter((o) => o.id !== p.id).map((o) => o.path))),
  )
  let changed = false
  for (const [i, project] of projects.entries()) {
    const plan = reconcileCheckouts(project, existing, seen[i], now)
    for (const c of plan.create) await store.create(c)
    for (const u of plan.update) await store.update(u.id, u.patch)
    if (plan.create.length || plan.update.length) changed = true
  }
  return { checkouts: changed ? await store.list() : existing, changed }
}

// ---------------------------------------------------------------------------
// Phase 2: make them, prepare them, remove them
// ---------------------------------------------------------------------------

async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pExecFile('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (err) {
    // git's own words are the useful part ("fatal: 'x' is already checked out at …").
    const stderr = (err as { stderr?: unknown }).stderr
    const msg = typeof stderr === 'string' && stderr.trim() ? stderr.trim().replace(/^fatal:\s*/i, '') : String(err)
    throw new Error(msg)
  }
}

const exists = (p: string) => stat(p).then(() => true, () => false)

async function hasLocalBranch(dir: string, branch: string): Promise<boolean> {
  return git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
}

/**
 * The branch new work starts from: origin's HEAD when there's a local branch
 * of that name, else `main` or `master`, else whatever the main folder has
 * checked out. A local branch, never `origin/…` — the base is a name the user
 * recognises in `git branch`.
 */
export async function defaultBranch(dir: string): Promise<string | null> {
  const remote = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then((o) => o.trim(), () => '')
  const candidates = [remote.replace(/^origin\//, ''), 'main', 'master'].filter(Boolean)
  for (const b of candidates) if (await hasLocalBranch(dir, b)) return b
  return currentBranch(dir)
}

/** Where a new worktree goes: `<root>/<project>/<branch>`, one folder per branch, outside the repo. */
export function worktreeFolder(root: string, project: Project, branch: string): string {
  return path.join(root, slugify(project.name, 8, 60) || project.id, branch.replace(/[^\w.-]+/g, '-'))
}

export type MadeWorktree = { path: string; branch: string; base: string | null }

/**
 * `git worktree add` for a project. A new branch is cut from the default
 * branch; a branch that already exists is checked out as it is (continuing
 * that work). A project that is a subfolder of its repo gets the same
 * subfolder of the new worktree.
 */
export async function createWorktree(project: Project, branch: string, folderRoot: string): Promise<MadeWorktree> {
  const root = await repoRoot(project.path)
  if (!root) throw new Error(`${project.name} isn't a git repo — worktrees need one`)
  const name = branch.trim()
  await git(root, ['check-ref-format', '--branch', name]).catch(() => {
    throw new Error(`"${name}" isn't a valid branch name`)
  })
  const folder = worktreeFolder(folderRoot, project, name)
  if (await exists(folder)) {
    const taken = (await listWorktrees(root)).some((w) => path.resolve(w.path) === path.resolve(folder))
    throw new Error(
      taken
        ? `${name} already has a worktree — pick it under Checkout to continue there, or name a new branch`
        : `${folder} is already there (not a worktree) — name another branch, or move that folder`,
    )
  }
  await mkdir(path.dirname(folder), { recursive: true })
  const rel = path.relative(await real(root), await real(project.path))
  let base: string | null = null
  if (await hasLocalBranch(root, name)) {
    await git(root, ['worktree', 'add', folder, name])
  } else {
    base = await defaultBranch(root)
    await git(root, ['worktree', 'add', '-b', name, folder, ...(base ? [base] : [])])
  }
  return { path: path.join(await real(folder), rel), branch: name, base }
}

/**
 * Clone a whole folder tree in one `clonefile(2)` call — APFS copies the tree
 * in the kernel, ~1s for a 60k-file node_modules where `cp -c` (one clone per
 * file) takes ~25s. Reached through JavaScript for Automation, which ships
 * with macOS, so there's nothing to install. Fails across volumes or off
 * APFS; the caller falls back.
 */
async function cloneTree(src: string, dest: string): Promise<void> {
  const script = `function run(argv) {
    ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'unsigned int']])
    return String($.clonefile(argv[0], argv[1], 0))
  }`
  const { stdout } = await pExecFile('osascript', ['-l', 'JavaScript', '-e', script, src, dest], { timeout: 60_000 })
  if (stdout.trim() !== '0') throw new Error(`clonefile returned ${stdout.trim()}`)
}

/**
 * What a fresh worktree lacks that the main folder has: untracked `.env*`
 * files, and `node_modules`. node_modules is an APFS clone — as fast as a
 * symlink and no extra disk until a file changes, yet its own copy, so an
 * install on this branch can't rewrite main's. Never fatal: returns what it
 * couldn't do, and the agent can install itself.
 */
export async function prepareWorktree(from: string, to: string): Promise<string[]> {
  const notes: string[] = []
  const entries = await readdir(from, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isFile() || !/^\.env/.test(e.name)) continue
    const dest = path.join(to, e.name)
    if (await exists(dest)) continue
    await copyFile(path.join(from, e.name), dest).catch((err) => notes.push(`could not copy ${e.name}: ${err}`))
  }
  const src = path.join(from, 'node_modules')
  const dest = path.join(to, 'node_modules')
  if ((await exists(src)) && !(await exists(dest))) {
    if (process.platform !== 'darwin') notes.push('node_modules not copied (clone copies are macOS-only) — install in the worktree')
    else {
      try {
        await cloneTree(src, dest)
      } catch {
        // One call failed (another volume, no APFS, no osascript): clone file by file instead.
        await rm(dest, { recursive: true, force: true }).catch(() => {})
        try {
          await pExecFile('cp', ['-c', '-R', src, dest], { timeout: 5 * 60_000 })
        } catch (err) {
          await rm(dest, { recursive: true, force: true }).catch(() => {})
          notes.push(`node_modules not cloned (${String(err).split('\n')[0]}) — install in the worktree`)
        }
      }
    }
  }
  return notes
}

/**
 * Bring back a removed worktree at the *same* folder — Claude Code keys a
 * session's transcript by its folder, so only the same path lets the session
 * resume. Its branch is checked out again if it still exists, else re-cut
 * from the default branch under the same name. Stale registrations (a folder
 * deleted by hand) are pruned first, which only drops entries whose folders
 * are already gone.
 */
export async function recreateWorktree(checkout: Checkout, project: Project): Promise<void> {
  const root = await repoRoot(project.path)
  if (!root) throw new Error(`${project.name} isn't a git repo any more`)
  const rel = path.relative(await real(root), await real(project.path))
  const folder = rel && checkout.path.endsWith(path.sep + rel) ? checkout.path.slice(0, -(rel.length + 1)) : checkout.path
  if (await exists(folder)) throw new Error(`${folder} is already there — move it first`)
  await mkdir(path.dirname(folder), { recursive: true })
  await git(root, ['worktree', 'prune'])
  const branch = checkout.branch
  if (branch && (await hasLocalBranch(root, branch))) await git(root, ['worktree', 'add', folder, branch])
  else {
    const base = checkout.base ?? (await defaultBranch(root))
    if (branch) await git(root, ['worktree', 'add', '-b', branch, folder, ...(base ? [base] : [])])
    else await git(root, ['worktree', 'add', '--detach', folder, ...(base ? [base] : [])])
  }
}

/** What removing a worktree would lose. `running` is the caller's to count — sessions aren't git's. */
export async function checkRemoval(checkout: Checkout, mainPath: string, running: number): Promise<RemovalCheck> {
  const base = checkout.base ?? (await defaultBranch(mainPath))
  const [files, unmerged] = await Promise.all([
    worktreeChanges(checkout.path).catch(() => []),
    base ? aheadOf(checkout.path, base) : Promise.resolve(null),
  ])
  return {
    branch: checkout.branch,
    base,
    unmerged,
    uncommitted: files.length,
    running,
    safe: unmerged === 0 && files.length === 0 && running === 0,
  }
}

/**
 * `git worktree remove` (forced when asked: uncommitted files go with it),
 * then the local branch. The branch goes with `-D` only when its commits are
 * known to be in the base or the user said remove anyway; otherwise `-d`,
 * which git refuses for unmerged work.
 */
export async function removeWorktree(
  checkout: Checkout,
  opts: { force: boolean; deleteBranch: boolean; merged: boolean },
): Promise<string[]> {
  const notes: string[] = []
  const root = (await repoRoot(checkout.path)) ?? checkout.path
  // Run from the repo's own folder: a worktree can't remove itself from inside.
  const listed = await listWorktrees(root)
  const primary = listed.find((w) => w.primary)?.path ?? root
  await git(primary, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), root])
  if (opts.deleteBranch && checkout.branch) {
    const flag = opts.force || opts.merged ? '-D' : '-d'
    await git(primary, ['branch', flag, checkout.branch]).catch((err) => notes.push(`kept branch ${checkout.branch}: ${err instanceof Error ? err.message : err}`))
  }
  return notes
}
