import path from 'node:path'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { removeSessionFiles } from '../attachments.js'
import type { EffortLevel, PermissionMode, Project, SessionKind } from '../../shared/protocol.js'
import type { ProviderId } from '../providers/types.js'
import type { StoredSession } from '../../core/store/types.js'
import { browserHub, WorkspaceRuntime } from '../workspace/runtime.js'
import { saveTeamRuns, teamRunOf } from '../team-run/state.js'
import { broadcast, broadcastSessionList } from '../ws/send.js'
import { expandHome } from '../folders.js'
import { checkoutById, mainCheckout, syncCheckouts } from './checkouts.js'
import { LiveSession } from './live-session.js'
import { extrasFor } from '../brief-run.js'

export async function deleteSession(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  rt.live.get(sessionId)?.stop()
  // Files attached to its messages go with it.
  await removeSessionFiles(rt.attachmentsDir, sessionId)
  // Its actions stay on record — they happened; only the tracker goes.
  rt.actionTrackers.delete(sessionId)
  // Its tab closes; its evidence stays on disk — the Verification note points at it.
  browserHub.forget(sessionId)
  rt.live.delete(sessionId)
  rt.rows.delete(sessionId)
  const run = teamRunOf(rt, sessionId)
  if (run) {
    rt.sessionTeam.delete(sessionId)
    // The lead gone, the run goes with it; a worker gone respawns on its next step.
    if (run.leadSessionId === sessionId) {
      for (const w of run.workers) if (w.sessionId && w.sessionId !== sessionId) rt.sessionTeam.delete(w.sessionId)
      rt.teamRuns.delete(run.id)
    } else for (const w of run.workers) if (w.sessionId === sessionId) w.sessionId = null
    await saveTeamRuns(rt)
  }
  await rt.store.sessions.remove(sessionId)
  broadcast(rt, { type: 'session_deleted', sessionId })
  broadcastSessionList(rt)
}

/**
 * The workspace's default project (decision 549a251e): where a session,
 * terminal or item lands when nothing names a project. null only while the
 * workspace has no projects at all — onboarding asks for one.
 */
export async function defaultProject(rt: WorkspaceRuntime): Promise<Project | null> {
  return (await rt.store.projects.list()).find((p) => p.isDefault) ?? null
}

/**
 * Add a folder as a project; the workspace's first project becomes its
 * default. Picking a folder that isn't a project adds it — there is no
 * "unsaved folder" state.
 */
export async function addProject(rt: WorkspaceRuntime, folder: string, name?: string, repo = ''): Promise<Project> {
  const resolved = path.resolve(expandHome(folder))
  const st = await stat(resolved).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`folder not found: ${resolved}`)
  const projects = await rt.store.projects.list()
  if (projects.some((p) => path.resolve(p.path) === resolved)) throw new Error(`${resolved} is already a project`)
  const project: Project = { id: randomUUID(), name: name || path.basename(resolved) || resolved, repo, path: resolved }
  await rt.store.projects.create(project)
  if (!projects.some((p) => p.isDefault)) {
    await rt.store.projects.setDefault(project.id)
    project.isDefault = true
  }
  await syncCheckouts(rt)
  return project
}

/** The project a new session runs in: the one named, else the one at `cwd` — added if it isn't one yet. */
export async function projectForSession(rt: WorkspaceRuntime, cwd: string, projectId?: string): Promise<Project> {
  const projects = await rt.store.projects.list()
  if (projectId) {
    const named = projects.find((p) => p.id === projectId)
    if (!named) throw new Error('unknown project')
    return named
  }
  const resolved = path.resolve(cwd)
  return projects.find((p) => path.resolve(p.path) === resolved) ?? (await addProject(rt, resolved))
}

export async function createSession(
  rt: WorkspaceRuntime,
  title: string,
  cwd: string,
  model: string | null,
  effort: EffortLevel | null,
  fastMode: boolean,
  permissionMode: PermissionMode | null,
  opts: { kind?: SessionKind; spawn?: boolean; projectId?: string | null; checkoutId?: string | null; provider?: ProviderId; planning?: boolean } = {},
): Promise<StoredSession> {
  const projectId = opts.projectId ?? (await defaultProject(rt))?.id ?? null
  // Every session names its checkout at birth: the one asked for, else its project's main folder.
  if (projectId && !mainCheckout(rt, projectId)) await syncCheckouts(rt)
  const checkoutId = opts.checkoutId ?? mainCheckout(rt, projectId)?.id ?? null
  const row = await rt.store.sessions.create({
    id: randomUUID(),
    title,
    cwd,
    projectId,
    checkoutId,
    model,
    effort,
    fastMode,
    permissionMode,
    ...(opts.planning ? { planning: true } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  })
  rt.rows.set(row.id, row)
  // spawn: false = a row only; the first message starts it (getOrRevive).
  if (opts.spawn !== false) rt.live.set(row.id, new LiveSession(rt, row, 0, null, await extrasFor(rt, row)))
  return row
}

export async function getOrRevive(rt: WorkspaceRuntime, sessionId: string): Promise<LiveSession | null> {
  // A fresh start: end the old subprocess and begin a new Claude session instead
  // of resuming — the transcript page continues, the model's history doesn't.
  const fresh = rt.freshNext.delete(sessionId)
  const existing = rt.live.get(sessionId)
  if (existing && !fresh) return existing
  const row = rt.rows.get(sessionId)
  if (!row) return null
  // A worktree removed under a session leaves it no folder to start in. Say so in its
  // transcript rather than let the agent fail to launch with an error about something else.
  if (!existing && !(await stat(row.cwd).then((st) => st.isDirectory(), () => false))) {
    const co = checkoutById(rt, row.checkoutId)
    const message =
      co?.kind === 'worktree'
        ? `This session's worktree (${co.branch ?? row.cwd}) was removed, so it has no folder to run in. Recreate the worktree to continue here, or continue in the main folder.`
        : `This session's folder is gone: ${row.cwd}. Start a new session somewhere that exists.`
    const seq = (await rt.store.events.lastSeq(row.id)) + 1
    await rt.store.events.append(row.id, seq, { kind: 'error', message })
    broadcast(rt, { type: 'session_event', sessionId: row.id, event: { kind: 'error', message }, at: Date.now() })
    void syncCheckouts(rt)
    return null
  }
  if (existing) existing.stop()
  const lastSeq = await rt.store.events.lastSeq(row.id)
  const extras = await extrasFor(rt, row)
  // Two messages racing to revive the same session: the first one's subprocess wins.
  const raced = !fresh ? rt.live.get(row.id) : undefined
  if (raced) return raced
  const revived = new LiveSession(rt, row, lastSeq, fresh ? null : row.sdkSessionId, extras)
  rt.live.set(row.id, revived)
  if (fresh && row.sdkSessionId) revived.notice('fresh context — this member starts from the brief, not its earlier history')
  broadcastSessionList(rt)
  return revived
}

/**
 * Boot: load stored sessions, and expire permission prompts orphaned by the
 * previous process (their subprocess died with it — Allow can never apply).
 */
export async function loadSessions(rt: WorkspaceRuntime) {
  for (const row of await rt.store.sessions.list()) {
    rt.rows.set(row.id, row)

    const events = await rt.store.events.read(row.id)
    const unresolved = new Map<string, true>()
    for (const e of events) {
      if (e.event.kind === 'permission_request') unresolved.set(e.event.id, true)
      if (e.event.kind === 'permission_resolved') unresolved.delete(e.event.id)
    }
    let seq = events.length ? events[events.length - 1].seq : 0
    for (const id of unresolved.keys()) {
      seq += 1
      await rt.store.events.append(row.id, seq, { kind: 'permission_resolved', id, behavior: 'expired' })
    }
  }
}
