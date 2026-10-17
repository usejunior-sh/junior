import path from 'node:path'
import type { Checkout, CreateStep, Project } from '../../shared/protocol.js'
import { createWorktree, prepareWorktree, syncProjectCheckouts } from '../worktrees.js'
import { log } from '../log.js'
import { workspaceDir } from '../workspaces.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { broadcast } from '../ws/send.js'
import { errText } from '../errors.js'

// Checkouts (server/worktrees.ts): a project's main folder and its worktrees

export const checkoutList = (rt: WorkspaceRuntime): Checkout[] => [...rt.checkouts.values()]

/**
 * Re-read every project's checkouts from git and tell the clients when
 * anything moved (a worktree appeared or went, a branch switched). Runs on
 * the Changes poll, at the end of every turn and when projects change.
 */
export function syncCheckouts(rt: WorkspaceRuntime): Promise<void> {
  if (rt.checkoutSyncQueued) return rt.checkoutSyncQueued
  const run = async () => {
    rt.checkoutSyncQueued = null
    rt.checkoutSyncRunning = next
    try {
      const { checkouts, changed } = await syncProjectCheckouts(rt.store.checkouts, await rt.store.projects.list())
      if (!changed && rt.checkouts.size === checkouts.length) return
      rt.checkouts.clear()
      for (const c of checkouts) rt.checkouts.set(c.id, c)
      broadcast(rt, { type: 'checkouts', checkouts })
    } catch (err) {
      log('warn', 'checkouts', `could not read worktrees: ${errText(err)}`, { workspace: rt.meta.id })
    } finally {
      if (rt.checkoutSyncRunning === next) rt.checkoutSyncRunning = null
    }
  }
  const next: Promise<void> = (rt.checkoutSyncRunning ?? Promise.resolve()).then(run)
  rt.checkoutSyncQueued = next
  return next
}

/** A project's main checkout: the folder the user added. */
export const mainCheckout = (rt: WorkspaceRuntime, projectId: string | null | undefined): Checkout | undefined =>
  projectId ? checkoutList(rt).find((c) => c.projectId === projectId && c.kind === 'main') : undefined

/**
 * A checkout by id; a project id means its main checkout, so a link made
 * before checkouts (`/change/<projectId>/…`) still resolves.
 */
export const checkoutById = (rt: WorkspaceRuntime, id: string | null | undefined): Checkout | undefined =>
  id ? (rt.checkouts.get(id) ?? mainCheckout(rt, id)) : undefined

/**
 * Boot: rows for every project's folders, then every session saved before
 * checkouts gets its project's main one. Stored once, never re-derived from
 * `cwd`, a worktree's folder isn't the project's.
 */
export async function loadCheckouts(rt: WorkspaceRuntime): Promise<void> {
  for (const c of await rt.store.checkouts.list()) rt.checkouts.set(c.id, c)
  await syncCheckouts(rt)
  const n = await rt.store.sessions.backfillCheckouts((projectId) => mainCheckout(rt, projectId)?.id ?? null)
  if (n) log('info', 'checkouts', `stored a checkout on ${n} sessions`, { workspace: rt.meta.id })
}

/** New worktrees live in the workspace folder (`~/.triage-dev` in dev), never inside the repo. */
const worktreesRoot = (rt: WorkspaceRuntime) => path.join(workspaceDir(rt.meta.id), 'worktrees')

/**
 * Make a worktree of `project` on `branch` and get it ready: `git worktree
 * add`, then node_modules and `.env*` from the main folder. Discovery records
 * the row (one writer, so no duplicate), and then what only triage knows,
 * the base it was cut from and the item it was made for, goes on it.
 */
export async function makeWorktree(
  rt: WorkspaceRuntime,
  project: Project,
  branch: string,
  itemId?: string,
  onStep?: (step: CreateStep) => void,
  from?: string,
): Promise<Checkout> {
  onStep?.('worktree')
  const made = await createWorktree(project, branch, worktreesRoot(rt), from)
  onStep?.('files')
  const notes = await prepareWorktree(project.path, made.path)
  await syncCheckouts(rt)
  const row = checkoutList(rt).find((c) => c.projectId === project.id && path.resolve(c.path) === path.resolve(made.path))
  if (!row) throw new Error(`made ${made.path} but git doesn't list it as a worktree`)
  const patch = { base: made.base, itemId: itemId ?? null }
  await rt.store.checkouts.update(row.id, patch)
  const checkout = { ...row, ...patch }
  rt.checkouts.set(row.id, checkout)
  broadcast(rt, { type: 'checkouts', checkouts: checkoutList(rt) })
  log('info', 'checkouts', `made worktree ${made.branch} of ${project.name}${made.base ? ` from ${made.base}` : ''}`, {
    workspace: rt.meta.id,
    path: made.path,
    ...(notes.length ? { notes: notes.join('; ') } : {}),
  })
  return checkout
}

/** Sessions in a checkout that are mid-turn right now. */
export const runningIn = (rt: WorkspaceRuntime, checkoutId: string): number =>
  [...rt.rows.values()].filter((r) => {
    const st = rt.live.get(r.id)?.status
    return r.checkoutId === checkoutId && (st === 'running' || st === 'starting')
  }).length
