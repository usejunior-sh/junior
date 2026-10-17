import path from 'node:path'
import type { JobLibrary } from '../job-files.js'
import { type LibraryRoot, libraryRoots, listLibrary } from '../library.js'
import type { ChangedFile, Checkout, CheckoutChanges, LibraryEntry, LibrarySource, Project, ProjectChanges, SessionChanges, SessionTurnSummary } from '../../shared/protocol.js'
import type { ToolCall } from '../providers/types.js'
import { log } from '../log.js'
import type { StoredSession, StoredTurn } from '../../core/store/types.js'
import { aheadOf, filePatch, repoRoot, snapshotTree, type TreeChange, treeDiff, worktreeChanges } from '../git.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { errText } from '../errors.js'
import { expandHome } from '../folders.js'
import { broadcast } from '../ws/send.js'
import { checkoutList } from './checkouts.js'

// Session changes: reconstructing what one session did to a shared worktree

export type OpenTurn = { seq: number; root: string; startedAt: number; touched: Set<string> }

/** Tools whose `file_path` counts as this session naming a file itself. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Skills and agents (server/library.ts): the settings tabs read and write the
// files; anything that changes them reloads every live session, so a new skill
// is in `/` and a new agent is spawnable without starting over.

/** Every skill and agent on this machine a job could name, keyed by the name Claude calls it. */
export async function jobLibrary(rt: WorkspaceRuntime): Promise<JobLibrary> {
  const roots = await libraryRootsFor(rt)
  const [skills, agents] = await Promise.all([listLibrary('skill', roots), listLibrary('agent', roots)])
  // first one wins, as the tabs list them: the workspace library, then personal, projects, plugins
  const byName = (entries: LibraryEntry[]) => {
    const m = new Map<string, LibrarySource>()
    for (const e of entries) if (!m.has(e.name)) m.set(e.name, e.source)
    return m
  }
  return { skills: byName(skills), agents: byName(agents) }
}

/** The roots this workspace's sessions see: its library, ~/.claude, its projects' .claude, plugins. */
export async function libraryRootsFor(rt: WorkspaceRuntime): Promise<LibraryRoot[]> {
  return libraryRoots({
    workspaceLibrary: rt.libraryDir,
    env: rt.envFor('claude'),
    projects: (await rt.store.projects.list()).map((p) => ({ name: p.name, path: p.path })),
  })
}

/**
 * A tool call that may have written a skill or agent. Generous on purpose: a
 * false hit costs one reload; a miss means the new skill waits for a new session.
 */
const LIBRARY_PATH_RE = /(^|[\/])(skills|agents)[\/]/
export function writesLibrary(call: ToolCall): boolean {
  const input = (call.input ?? {}) as { file_path?: unknown; command?: unknown }
  if (EDIT_TOOLS.has(call.name)) return typeof input.file_path === 'string' && LIBRARY_PATH_RE.test(input.file_path)
  if (call.name === 'Bash') return typeof input.command === 'string' && /\.claude[\/](skills|agents)|library[\/](skills|agents)/.test(input.command)
  return false
}

/** Reload skills and agents in every live session, and tell the settings tabs to refetch. */
export function reloadLibraryEverywhere(rt: WorkspaceRuntime): void {
  for (const live of rt.live.values()) {
    void live.reloadLibrary().catch((err) => log('warn', 'library', `reload failed: ${errText(err)}`, { session: live.row.id }))
  }
  // Draft tabs probed their folder's `/` list before the change; the next `/` asks again.
  for (const key of [...rt.commandCache.keys()]) {
    if (![...rt.live.values()].some((l) => expandHome(l.row.cwd) === key)) rt.commandCache.delete(key)
  }
  broadcast(rt, { type: 'library_changed' })
}

/** A session's repo root, resolved once per session and cached. */
export async function sessionRepoRoot(rt: WorkspaceRuntime, row: StoredSession): Promise<string | null> {
  const hit = rt.repoRoots.get(row.id)
  if (hit !== undefined) return hit
  const root = await repoRoot(row.cwd)
  rt.repoRoots.set(row.id, root)
  return root
}

/** Working-tree snapshots are ~100 ms; a burst of requests shares one. */
const nowTrees = new Map<string, { at: number; tree: Promise<string | null> }>()
function currentTree(root: string): Promise<string | null> {
  const hit = nowTrees.get(root)
  if (hit && Date.now() - hit.at < 1500) return hit.tree
  const tree = snapshotTree(root)
  nowTrees.set(root, { at: Date.now(), tree })
  return tree
}

/** A turn's delta, memoised, the trees either side of a finished turn never move. */
async function turnDelta(
  rt: WorkspaceRuntime,
  root: string,
  t: StoredTurn,
  to: string | null,
  live: boolean,
): Promise<TreeChange[]> {
  if (!to) return []
  const key = `${t.sessionId}:${t.seq}`
  if (!live) {
    const hit = rt.turnDeltas.get(key)
    if (hit) return hit
  }
  const delta = await treeDiff(root, t.preTree, to)
  if (!live) rt.turnDeltas.set(key, delta)
  return delta
}

/** Do two turn windows overlap in time? An unfinished turn runs until now. */
const overlaps = (a: StoredTurn, b: StoredTurn): boolean =>
  a.startedAt <= (b.endedAt ?? Date.now()) && b.startedAt <= (a.endedAt ?? Date.now())

/**
 * What this session changed, and how sure we are about each file.
 *
 * Sessions share a working tree, so `git status` cannot answer this. Each of a
 * session's turns is bracketed by two trees, and the agent only edits while
 * its own turn runs, so the union of the per-turn deltas is this session's
 * file set, and anything another session moved outside those windows is simply
 * not in it. Within a window we can still be fooled by a *concurrent* session,
 * which is what `confidence` reports rather than hides.
 */
/**
 * One project's uncommitted work for the Changes rail, per checkout: the main
 * folder and every live worktree, each against its own HEAD. Never throws: a
 * broken repo is a row, not a 500.
 */
export async function projectChanges(rt: WorkspaceRuntime, project: Project): Promise<ProjectChanges> {
  const checkouts = checkoutList(rt).filter((c) => c.projectId === project.id && c.state === 'active')
  const main = checkouts.find((c) => c.kind === 'main')
  const isRepo = !!(await repoRoot(project.path))
  const one = async (checkout: Checkout): Promise<CheckoutChanges> => {
    const empty: CheckoutChanges = { checkout, files: [], insertions: 0, deletions: 0 }
    if (!isRepo) return empty
    try {
      const [files, ahead] = await Promise.all([
        worktreeChanges(checkout.path),
        checkout.kind === 'worktree' && main?.branch ? aheadOf(checkout.path, main.branch) : null,
      ])
      return {
        ...empty,
        files,
        insertions: files.reduce((n, f) => n + f.insertions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        ...(ahead !== null ? { ahead } : {}),
      }
    } catch (err) {
      return { ...empty, error: errText(err) }
    }
  }
  return { project, isRepo, checkouts: await Promise.all(checkouts.map(one)) }
}

export async function computeSessionChanges(rt: WorkspaceRuntime, row: StoredSession): Promise<SessionChanges> {
  const empty = { files: [], turns: [], insertions: 0, deletions: 0 }
  const root = await sessionRepoRoot(rt, row)
  if (!root) return { root: null, unavailable: 'This session is not running inside a git repository.', ...empty }

  const turns = await rt.store.turns.list(row.id)
  if (!turns.length) return { root, unavailable: 'No turns have run in this session yet.', ...empty }

  const now = await currentTree(root)
  if (!now) return { root, unavailable: 'Could not read the working tree.', ...empty }

  // Everything another session did to this repo since our baseline. Turns that
  // finished before we started cannot have polluted our own window.
  const since = turns[0].startedAt
  const foreign = (await rt.store.turns.othersInRoot(root, row.id)).filter((t) => (t.endedAt ?? Date.now()) >= since)

  // our own per-turn deltas: the file set, and which turn moved what
  const mine = new Map<string, { turns: number[]; ambiguous: boolean }>()
  const turnSummaries: SessionTurnSummary[] = []
  for (const [i, t] of turns.entries()) {
    const last = i === turns.length - 1
    const to = t.postTree ?? (last ? now : (turns[i + 1]?.preTree ?? null))
    const delta = await turnDelta(rt, root, t, to, t.postTree === null)
    const clashing = foreign.filter((f) => overlaps(t, f))
    for (const c of delta) {
      const e = mine.get(c.path) ?? { turns: [], ambiguous: false }
      e.turns.push(t.seq)
      // Only uncertain when someone else was running *and* no tool of ours
      // named the file during this turn.
      if (clashing.length && !t.touched.includes(path.join(root, c.path))) e.ambiguous = true
      mine.set(c.path, e)
    }
    turnSummaries.push({
      seq: t.seq,
      files: delta.length,
      insertions: delta.reduce((n, c) => n + c.insertions, 0),
      deletions: delta.reduce((n, c) => n + c.deletions, 0),
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      overlapped: [...new Set(clashing.map((c) => c.sessionId))].map((id) => sessionTitle(rt, id)),
    })
  }

  // which of those files another session also moved
  const alsoBy = new Map<string, Set<string>>()
  for (const f of foreign) {
    const to = f.postTree ?? now
    const delta = await turnDelta(rt, root, f, to, f.postTree === null)
    for (const c of delta) {
      if (!mine.has(c.path)) continue
      const set = alsoBy.get(c.path) ?? new Set<string>()
      set.add(f.sessionId)
      alsoBy.set(c.path, set)
    }
  }

  // the numbers: net baseline → now, so a file edited twice counts once
  const net = await treeDiff(root, turns[0].preTree, now)
  const touchedAbs = new Set(turns.flatMap((t) => t.touched))
  const files: ChangedFile[] = []
  for (const c of net) {
    const ours = mine.get(c.path)
    if (!ours) continue // moved in this folder, but never inside one of our turns
    const also = [...(alsoBy.get(c.path) ?? [])]
    files.push({
      path: c.path,
      status: c.status,
      insertions: c.insertions,
      deletions: c.deletions,
      isBinary: c.isBinary,
      touched: touchedAbs.has(path.join(root, c.path)),
      confidence: also.length ? 'shared' : ours.ambiguous ? 'ambiguous' : 'exact',
      alsoChangedBy: also.map((id) => sessionTitle(rt, id)),
      turns: ours.turns,
    })
  }

  return {
    root,
    files,
    turns: turnSummaries,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}

const sessionTitle = (rt: WorkspaceRuntime, id: string): string => rt.rows.get(id)?.title ?? 'another session'

/** One file's patch, from this session's baseline to the working tree. */
export async function sessionFilePatch(
  rt: WorkspaceRuntime,
  row: StoredSession,
  file: string,
): Promise<{ patch: string; truncated: boolean } | null> {
  const root = await sessionRepoRoot(rt, row)
  if (!root) return null
  const turns = await rt.store.turns.list(row.id)
  if (!turns.length) return null
  const now = await currentTree(root)
  if (!now) return null
  return filePatch(root, turns[0].preTree, now, file)
}
