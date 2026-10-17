import path from 'node:path'
import type { Project, WorkItem, WorkspaceSettings } from '../shared/protocol.js'
import { DEFAULT_JOB_TIMEOUT_MS, MAX_JOB_TIMEOUT_MS } from '../core/job/types.js'
import { goalMaxTeam, GOALS_MAX_TEAM_KEY } from './goals.js'
import { log } from './log.js'
import { MAX_GOAL_TEAM } from '../core/goals/types.js'
import type { Provenance } from '../core/work/types.js'
import type { UpsertResult } from '../core/store/types.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { JOB_BUDGET_KEY, JOB_TIMEOUT_KEY } from './jobs/queue.js'
import { seedJobTemplates } from './jobs/ops.js'
import { broadcastSessionList, invalidateInbox } from './ws/send.js'

// settings, briefs and dispatch

const JOBS_ENABLED_KEY = 'jobs.enabled'
const BRIEFS_CAP_KEY = 'briefs.dailyCap'
const BRIEFS_MODEL_KEY = 'briefs.defaultModel'
const HIDDEN_MODELS_KEY = 'models.hidden'
const CUSTOM_MODELS_KEY = 'models.custom'
const DEFAULT_BRIEF_CAP = 20
export const BRIEF_TIMEOUT_MS = 300_000

/** The global jobs switch. Off by default: 0.7 is pull-before-push. */
export async function jobsEnabled(rt: WorkspaceRuntime): Promise<boolean> {
  return (await rt.store.config.get<boolean>(JOBS_ENABLED_KEY)) === true
}

export async function readSettings(rt: WorkspaceRuntime): Promise<WorkspaceSettings> {
  const cap = await rt.store.config.get<number>(BRIEFS_CAP_KEY)
  const model = await rt.store.config.get<string>(BRIEFS_MODEL_KEY)
  const timeout = await rt.store.config.get<number>(JOB_TIMEOUT_KEY)
  const budget = await rt.store.config.get<number>(JOB_BUDGET_KEY)
  return {
    jobsEnabled: await jobsEnabled(rt),
    jobTimeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_JOB_TIMEOUT_MS,
    jobBudgetUsd: typeof budget === 'number' && budget > 0 ? budget : null,
    briefsDailyCap: typeof cap === 'number' && cap > 0 ? cap : DEFAULT_BRIEF_CAP,
    briefsDefaultModel: typeof model === 'string' && model ? model : null,
    hiddenModels: await readIdList(rt, HIDDEN_MODELS_KEY),
    customModels: await readIdList(rt, CUSTOM_MODELS_KEY),
    goalsMaxTeam: await goalMaxTeam(rt.goalDeps),
  }
}

async function readIdList(rt: WorkspaceRuntime, key: string): Promise<string[]> {
  const v = await rt.store.config.get<unknown>(key)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/** A list of model ids from the wire: trimmed, unique, bounded. Anything else is an error, not a repair. */
function modelIdList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || x.trim() === '' || x.length > 120)) {
    throw new Error(`${field} must be a list of model ids`)
  }
  return [...new Set((v as string[]).map((x) => x.trim()))]
}

export async function writeSettings(rt: WorkspaceRuntime, raw: unknown): Promise<WorkspaceSettings> {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.jobsEnabled !== undefined) {
    if (typeof r.jobsEnabled !== 'boolean') throw new Error('jobsEnabled must be a boolean')
    await rt.store.config.set(JOBS_ENABLED_KEY, r.jobsEnabled)
    if (r.jobsEnabled) await seedJobTemplates(rt)
    log('info', 'job', `jobs ${r.jobsEnabled ? 'enabled' : 'disabled'}`, { workspace: rt.meta.id })
  }
  if (r.jobTimeoutMs !== undefined) {
    const t = r.jobTimeoutMs
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 30_000 || t > MAX_JOB_TIMEOUT_MS) throw new Error(`jobTimeoutMs must be whole milliseconds from 30000 to ${MAX_JOB_TIMEOUT_MS}`)
    await rt.store.config.set(JOB_TIMEOUT_KEY, t)
  }
  if (r.jobBudgetUsd !== undefined) {
    const b = r.jobBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 100)) throw new Error('jobBudgetUsd must be null or dollars from 0.01 to 100')
    await rt.store.config.set(JOB_BUDGET_KEY, b)
  }
  if (r.briefsDailyCap !== undefined) {
    const n = r.briefsDailyCap
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500) throw new Error('briefsDailyCap must be a whole number from 1 to 500')
    await rt.store.config.set(BRIEFS_CAP_KEY, n)
  }
  if (r.briefsDefaultModel !== undefined) {
    if (r.briefsDefaultModel !== null && typeof r.briefsDefaultModel !== 'string') throw new Error('briefsDefaultModel must be a string or null')
    await rt.store.config.set(BRIEFS_MODEL_KEY, r.briefsDefaultModel || null)
  }
  if (r.hiddenModels !== undefined) await rt.store.config.set(HIDDEN_MODELS_KEY, modelIdList(r.hiddenModels, 'hiddenModels'))
  if (r.customModels !== undefined) await rt.store.config.set(CUSTOM_MODELS_KEY, modelIdList(r.customModels, 'customModels'))
  if (r.goalsMaxTeam !== undefined) {
    const n = r.goalsMaxTeam
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_GOAL_TEAM) throw new Error(`goalsMaxTeam must be a whole number from 1 to ${MAX_GOAL_TEAM}`)
    await rt.store.config.set(GOALS_MAX_TEAM_KEY, n)
  }
  invalidateInbox(rt)
  return readSettings(rt)
}

/** The folder an item's work lands in: its project, else the project whose repo it belongs to, else the default. */
export async function projectFor(rt: WorkspaceRuntime, item: WorkItem): Promise<Project | null> {
  const projects = await rt.store.projects.list()
  return (
    (item.projectId ? projects.find((p) => p.id === item.projectId) : undefined) ??
    projects.find((p) => p.repo && p.repo === item.repo) ??
    projects.find((p) => p.isDefault) ??
    null
  )
}

/**
 * Every source item lands with its project stored: the one it names, else the
 * project whose repo it belongs to, else the default, so adding a project
 * later doesn't move it. Only an insert takes it; a refresh keeps the stored one.
 */
export async function upsertItem(rt: WorkspaceRuntime, item: WorkItem, prov?: Provenance): Promise<UpsertResult> {
  const project = item.projectId ? null : await projectFor(rt, item)
  return rt.store.items.upsert(project ? { ...item, projectId: project.id } : item, prov)
}

/**
 * Boot: the workspace gets a default project if it has projects but none is
 * the default (the one most sessions ran in), and every session and item
 * saved before projects were stored gets one.
 * A workspace with no projects is left alone, onboarding asks for a folder.
 */
export async function migrateDefaultProject(rt: WorkspaceRuntime): Promise<void> {
  let projects = await rt.store.projects.list()
  if (projects.length === 0) return
  const resolved = projects.map((p) => ({ id: p.id, root: path.resolve(p.path) }))
  // Longest root first, so a project nested in another claims its own sessions.
  resolved.sort((a, b) => b.root.length - a.root.length)
  const owner = (cwd: string) => {
    const c = path.resolve(cwd)
    return resolved.find((p) => c === p.root || c.startsWith(p.root + path.sep))?.id ?? null
  }
  if (!projects.some((p) => p.isDefault)) {
    const counts = new Map<string, number>()
    for (const s of await rt.store.sessions.list()) {
      const id = s.projectId ?? owner(s.cwd)
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const pick = [...projects].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]
    await rt.store.projects.setDefault(pick.id)
    log('info', 'projects', `default project: ${pick.name} (${counts.get(pick.id) ?? 0} sessions)`, { workspace: rt.meta.id })
    projects = await rt.store.projects.list()
  }
  const fallback = projects.find((p) => p.isDefault)!.id
  const sessions = await rt.store.sessions.backfillProjects((cwd) => owner(cwd) ?? fallback)
  const items = await rt.store.items.backfillProjects((item) => {
    const byRepo = item.repo ? projects.find((p) => p.repo && p.repo === item.repo) : undefined
    return byRepo?.id ?? fallback
  })
  if (sessions || items) log('info', 'projects', `stored a project on ${sessions} sessions and ${items} items`, { workspace: rt.meta.id })
}

/** Record that a session works (dispatch) or documents (brief) an item; mirrored in memory for summaries. */
export async function linkSessionToItem(rt: WorkspaceRuntime, sessionId: string, itemId: string, role: 'dispatch' | 'brief'): Promise<void> {
  if (!(await rt.store.items.get(itemId))) return
  await rt.store.links.add({ fromKind: 'session', fromId: sessionId, toKind: 'item', toId: itemId, role })
  rt.sessionItem.set(sessionId, itemId)
  broadcastSessionList(rt)
}
