import { apiKeyHint, loginCommandFor, toAuthBackend, workspaceAuthDir, type WorkspaceMeta } from '../workspaces.js'
import type { Workspace } from '../../shared/protocol.js'
import { bootGoalRun, loadGoalHeld, replayGoalEvents } from '../goals.js'
import { log } from '../log.js'
import { registry, WorkspaceRuntime } from './runtime.js'
import { wireProviders } from './providers.js'
import { readPersona } from '../junior-ops.js'
import { jobsEnabled, migrateDefaultProject, settleJobsSwitch } from '../settings-ops.js'
import { loadCheckouts } from '../session/checkouts.js'
import { loadSessions } from '../session/sessions.js'
import { markInterruptedRuns } from '../jobs/run.js'
import { migrateJobProjects, seedJobTemplates, syncJobFiles } from '../jobs/ops.js'
import { bootBriefs } from '../brief-run.js'
import { goalEngineFor } from '../goal-glue.js'
import { errText } from '../errors.js'
import { loadTeamRuns } from '../team-run/state.js'
import { probeConnectors, probeModels } from './probes.js'
import { recoverActions } from '../session/actions-send.js'
import { backfillActions } from '../session/actions-record.js'

// Workspace management: registry CRUD + the live runtime bookkeeping. Auth is
// spawn-time: changing a workspace's backend stops its live subprocesses (the
// next message revives them with the new env) and re-probes.
export function wireWorkspace(meta: WorkspaceMeta): Workspace {
  return {
    id: meta.id,
    name: meta.name,
    color: meta.color,
    ...(meta.description ? { description: meta.description } : {}),
    authBackend: meta.authBackend,
    isDefault: meta.id === registry.defaultId,
    createdAt: meta.createdAt,
    ...(meta.authBackend === 'api-key' ? { apiKeyHint: apiKeyHint(meta) } : {}),
    ...(meta.authBackend === 'config-dir'
      ? { configDir: workspaceAuthDir(meta), loginCommand: loginCommandFor(meta) }
      : {}),
    providers: wireProviders(meta),
  }
}

export const wireWorkspaces = (): Workspace[] => registry.workspaces.map(wireWorkspace)

/**
 * "Which workspace am I bound to?": the current workspace a caller resolved to
 * (chat via cookie/param, external shim via TRIAGE_WORKSPACE) plus the roster of
 * all workspaces so the caller can see what else exists and how to switch. The
 * one answer both the in-process tool and the stdio shim's get_workspace return.
 */
export function workspaceInfo(rt: WorkspaceRuntime) {
  return {
    current: wireWorkspace(rt.meta),
    workspaces: registry.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      isDefault: w.id === registry.defaultId,
    })),
  }
}

/** Bring a runtime up: sessions, seeds, cached snapshot, background probes. */
export async function initRuntime(rt: WorkspaceRuntime): Promise<void> {
  rt.persona = await readPersona(rt)
  await migrateDefaultProject(rt)
  await loadCheckouts(rt)
  await loadSessions(rt)
  await markInterruptedRuns(rt)
  await migrateJobProjects(rt)
  // Seeding follows the jobs switch: on for a new workspace, as you left it for an older one.
  await settleJobsSwitch(rt)
  if (await jobsEnabled(rt)) await seedJobTemplates(rt)
  else await syncJobFiles(rt, { force: true }).catch(() => {})
  await bootBriefs(rt)
  // Plan review events the last daemon wrote but never finished: wake their lead, queue their steps.
  await replayGoalEvents(rt.goalDeps, goalEngineFor(rt)).catch((err) => log('error', 'goals', `replay failed: ${errText(err)}`, { workspace: rt.meta.id }))
  // the goals that were mid-session when the daemon died pick up from their handoff, and nothing they queued is filed twice.
  await loadGoalHeld(rt.goalDeps, rt.goalHeld).catch((err) => log('error', 'goals', `could not load held actions: ${errText(err)}`, { workspace: rt.meta.id }))
  await bootGoalRun(rt.goalDeps, goalEngineFor(rt)).catch((err) => log('error', 'goals', `could not resume running goals: ${errText(err)}`, { workspace: rt.meta.id }))
  await rt.teamLibrary.seed().catch((err) => log('error', 'teams', `could not seed agents and teams: ${err}`, { workspace: rt.meta.id }))
  await loadTeamRuns(rt)
  // The last snapshot makes the first page load instant, but only while it
  // is still fresh, and only in today's shape: one saved before stage/turn
  // carries no flows, one before the inbox tabs no counts, and serving either
  // leaves the sidebar wrong until the next sync.
  const saved = await rt.store.inbox.load()
  rt.inboxCache = saved && saved.counts !== undefined && saved.items.every((i) => i.flow) ? saved : null
  probeConnectors(rt).catch((err) => log('error', 'connectors', `probe failed: ${err}`, { workspace: rt.meta.id }))
  probeModels(rt).catch((err) => log('error', 'models', `probe failed: ${err}`, { workspace: rt.meta.id }))
  await rt.actionsFile.seed().catch((err) => log('warn', 'actions', `could not seed the actions file: ${errText(err)}`, { workspace: rt.meta.id }))
  // Queued actions: a send the last process died in is unknown; scheduled ones get their timers back.
  await recoverActions(rt).catch((err) => log('warn', 'actions', `could not recover queued actions: ${errText(err)}`, { workspace: rt.meta.id }))
  // After the connector probe, so past connector calls sort by their servers' own annotations too.
  void (rt.connectorInFlight ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => backfillActions(rt))
    .catch((err) => log('warn', 'actions', `backfill failed: ${errText(err)}`, { workspace: rt.meta.id }))
}

/** After an auth change: new env, fresh probes, and no subprocess on the old auth. */
export function applyAuthChange(rt: WorkspaceRuntime): void {
  rt.refreshEnv()
  for (const s of rt.live.values()) s.stop() // next message revives with the new env
  rt.connectorCache = null
  rt.modelCache.clear()
  rt.providerStatus = null
  probeConnectors(rt).catch(() => {})
  probeModels(rt).catch(() => {})
  log('info', 'workspaces', `auth backend now ${rt.meta.authBackend}`, { workspace: rt.meta.id })
}

type WorkspacePatch = {
  name?: string
  color?: string
  description?: string
  authBackend?: 'inherit' | 'api-key' | 'config-dir'
  apiKey?: string
}

export function workspacePatchFrom(raw: unknown): { patch: WorkspacePatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WorkspacePatch = {}
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'name must be a non-empty string' }
    patch.name = r.name.trim()
  }
  if (r.color !== undefined) {
    if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) return { error: 'color must be a hex color like "#7aa2f7"' }
    patch.color = r.color
  }
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') return { error: 'description must be a string' }
    patch.description = r.description.trim()
  }
  if (r.authBackend !== undefined) {
    const backend = toAuthBackend(r.authBackend)
    if (!backend) return { error: 'authBackend must be inherit | api-key | config-dir' }
    patch.authBackend = backend
  }
  if (r.apiKey !== undefined) {
    if (typeof r.apiKey !== 'string' || !r.apiKey.trim()) return { error: 'apiKey must be a non-empty string' }
    patch.apiKey = r.apiKey.trim()
  }
  return { patch }
}
