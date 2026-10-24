import path from 'node:path'
import type { Project, WorkItem, WorkspaceSettings } from '../shared/protocol.js'
import { DEFAULT_JOB_TIMEOUT_MS, MAX_JOB_TIMEOUT_MS } from '../core/job/types.js'
import { log } from './log.js'
import type { Provenance } from '../core/work/types.js'
import type { UpsertResult } from '../core/store/types.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { JOB_BUDGET_KEY, JOB_TIMEOUT_KEY } from './jobs/queue.js'
import { seedJobTemplates } from './jobs/ops.js'
import { broadcast, broadcastSessionList, invalidateInbox } from './ws/send.js'
import { browserProfiles } from './browser/profiles.js'
import { DEFAULT_PROFILE } from '../core/browser/profiles.js'
import type { WatchId, WatchSwitches } from '../core/work/handoff.js'
import { describeFocus, endFocus, focusFrom, inFocus, readFocus, type FocusHours } from '../core/work/focus.js'
import { dropWeight, liveWeights, putWeight, readWeights, type ScoreWeight, type ScoreWeightView, viewOf, weightFrom } from '../core/work/weights.js'

// settings, briefs and dispatch

const JOBS_ENABLED_KEY = 'jobs.enabled'
const BRIEFS_CAP_KEY = 'briefs.dailyCap'
const BRIEFS_MODEL_KEY = 'briefs.defaultModel'
const HIDDEN_MODELS_KEY = 'models.hidden'
const CUSTOM_MODELS_KEY = 'models.custom'
const BROWSER_PROFILE_KEY = 'browser.profile'
const FOCUS_HOURS_KEY = 'focus.hours'
const WATCH_KEYS: Record<WatchId, string> = { babysit: 'watch.babysit', review: 'watch.review' }
const DEFAULT_BRIEF_CAP = 20
export const BRIEF_TIMEOUT_MS = 300_000

/** The browser profile this workspace's sessions use unless one picks another; a deleted one reads as Default. */
export async function workspaceBrowserProfile(rt: WorkspaceRuntime): Promise<string> {
  const id = await rt.store.config.get<string>(BROWSER_PROFILE_KEY)
  return typeof id === 'string' && browserProfiles().get(id) ? id : DEFAULT_PROFILE
}

/** Set it, by id or name. Returns the id. */
export async function setWorkspaceBrowserProfile(rt: WorkspaceRuntime, ref: unknown): Promise<string> {
  const p = typeof ref === 'string' ? browserProfiles().find(ref) : null
  if (!p) throw new Error(`no browser profile ${typeof ref === 'string' ? `"${ref}"` : 'given'}`)
  await rt.store.config.set(BROWSER_PROFILE_KEY, p.id)
  return p.id
}

/** The global jobs switch: off for a new workspace, as you left it before. */
export async function jobsEnabled(rt: WorkspaceRuntime): Promise<boolean> {
  return (await rt.store.config.get<boolean>(JOBS_ENABLED_KEY)) === true
}

/** Which watches run here: one switch each, read on every tick. */
export async function watchesOn(rt: WorkspaceRuntime): Promise<WatchSwitches> {
  const on = async (w: WatchId) => (await rt.store.config.get<boolean>(WATCH_KEYS[w])) === true
  return { babysit: await on('babysit'), review: await on('review') }
}

const isFresh = async (rt: WorkspaceRuntime) => (await rt.store.sessions.list()).length === 0 && (await rt.store.items.listAll()).length === 0

/**
 * Boot: a workspace that never set its switches gets them written down. A new
 * one (no sessions, no items) starts with jobs and every watch off, so nothing
 * runs until you turn it on. One from before keeps jobs as they were (off) and
 * its watches on, as they always ran.
 */
export async function settleSwitches(rt: WorkspaceRuntime): Promise<void> {
  const unset = async (key: string) => (await rt.store.config.get<boolean>(key)) == null
  const keys = [JOBS_ENABLED_KEY, ...Object.values(WATCH_KEYS)]
  const todo = (await Promise.all(keys.map(unset))).some(Boolean)
  if (!todo) return
  const fresh = await isFresh(rt)
  if (await unset(JOBS_ENABLED_KEY)) await rt.store.config.set(JOBS_ENABLED_KEY, false)
  for (const key of Object.values(WATCH_KEYS)) if (await unset(key)) await rt.store.config.set(key, !fresh)
  log('info', 'job', fresh ? 'a new workspace: jobs and watches start off' : 'switches settled: watches on as before', { workspace: rt.meta.id })
}

export async function readSettings(rt: WorkspaceRuntime): Promise<WorkspaceSettings> {
  const cap = await rt.store.config.get<number>(BRIEFS_CAP_KEY)
  const model = await rt.store.config.get<string>(BRIEFS_MODEL_KEY)
  const timeout = await rt.store.config.get<number>(JOB_TIMEOUT_KEY)
  const budget = await rt.store.config.get<number>(JOB_BUDGET_KEY)
  const watches = await watchesOn(rt)
  return {
    jobsEnabled: await jobsEnabled(rt),
    babysitEnabled: watches.babysit,
    reviewsEnabled: watches.review,
    jobTimeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_JOB_TIMEOUT_MS,
    jobBudgetUsd: typeof budget === 'number' && budget > 0 ? budget : null,
    briefsDailyCap: typeof cap === 'number' && cap > 0 ? cap : DEFAULT_BRIEF_CAP,
    briefsDefaultModel: typeof model === 'string' && model ? model : null,
    hiddenModels: await readIdList(rt, HIDDEN_MODELS_KEY),
    customModels: await readIdList(rt, CUSTOM_MODELS_KEY),
    browserProfile: await workspaceBrowserProfile(rt),
    focusHours: await readFocusHours(rt),
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

/** A settings patch that flips a watch switch (babysitEnabled, reviewsEnabled). */
export function touchesWatches(raw: unknown): boolean {
  const r = (raw ?? {}) as Record<string, unknown>
  return typeof r.babysitEnabled === 'boolean' || typeof r.reviewsEnabled === 'boolean'
}

export async function writeSettings(rt: WorkspaceRuntime, raw: unknown): Promise<WorkspaceSettings> {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.jobsEnabled !== undefined) {
    if (typeof r.jobsEnabled !== 'boolean') throw new Error('jobsEnabled must be a boolean')
    await rt.store.config.set(JOBS_ENABLED_KEY, r.jobsEnabled)
    if (r.jobsEnabled) await seedJobTemplates(rt)
    log('info', 'job', `jobs ${r.jobsEnabled ? 'enabled' : 'disabled'}`, { workspace: rt.meta.id })
  }
  for (const [field, w] of [['babysitEnabled', 'babysit'], ['reviewsEnabled', 'review']] as const) {
    if (r[field] === undefined) continue
    if (typeof r[field] !== 'boolean') throw new Error(`${field} must be a boolean`)
    await rt.store.config.set(WATCH_KEYS[w], r[field])
    log('info', w, `${w} watch ${r[field] ? 'on' : 'off'}`, { workspace: rt.meta.id })
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
  if (r.browserProfile !== undefined) {
    const id = await setWorkspaceBrowserProfile(rt, r.browserProfile)
    broadcast(rt, { type: 'browser_profiles', profiles: browserProfiles().list(), workspaceDefault: id })
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

// Score weights you set (core/work/weights.ts): "this person matters", kept in
// one config value. Every reader and writer goes through these ops: the HTTP
// route, and the inbox ranking. A change re-ranks on the next inbox read.

const SCORE_WEIGHTS_KEY = 'score.weights'
const weightWrites = new WeakMap<WorkspaceRuntime, Promise<unknown>>()

/** One writer at a time per workspace, so two quick corrections can't drop one. */
function serialWeights<T>(rt: WorkspaceRuntime, fn: () => Promise<T>): Promise<T> {
  const next = (weightWrites.get(rt) ?? Promise.resolve()).catch(() => undefined).then(fn)
  weightWrites.set(rt, next)
  return next
}

/** Every stored weight, expired ones included (the ranking drops those at its own `now`). */
export async function readScoreWeights(rt: WorkspaceRuntime): Promise<ScoreWeight[]> {
  return readWeights(await rt.store.config.get<unknown>(SCORE_WEIGHTS_KEY))
}

/** The live weights, newest first, each with when it expires and how it reads. */
export async function listScoreWeightsOp(rt: WorkspaceRuntime, now = Date.now()): Promise<ScoreWeightView[]> {
  return liveWeights(await readScoreWeights(rt), now).map(viewOf)
}

/** Set a weight { key, delta, reason? }. The same key again replaces it and renews its 60 days. */
export async function setScoreWeightOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<{ weight: ScoreWeightView; weights: ScoreWeightView[] }> {
  const out = weightFrom(raw, now)
  if (!out.ok) throw new Error(out.error)
  const weight = out.weight
  await serialWeights(rt, async () => {
    await rt.store.config.set(SCORE_WEIGHTS_KEY, putWeight(await readScoreWeights(rt), weight, now))
  })
  log('info', 'inbox', `weight set: ${viewOf(weight).label}`, { key: weight.key, delta: weight.delta, workspace: rt.meta.id })
  invalidateInbox(rt)
  return { weight: viewOf(weight), weights: await listScoreWeightsOp(rt, now) }
}

/** Clear one weight by key ({ key }). Expired ones are pruned on the way. */
export async function clearScoreWeightOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<{ weights: ScoreWeightView[] }> {
  const key = (raw as { key?: unknown } | null)?.key
  if (typeof key !== 'string' || !key.trim()) throw new Error('key is required')
  const removed = await serialWeights(rt, async () => {
    const out = dropWeight(await readScoreWeights(rt), key, now)
    if (out.removed) await rt.store.config.set(SCORE_WEIGHTS_KEY, out.weights)
    return out.removed
  })
  if (!removed) throw new Error(`no weight for ${key}`)
  log('info', 'inbox', `weight cleared: ${key}`, { workspace: rt.meta.id })
  invalidateInbox(rt)
  return { weights: await listScoreWeightsOp(rt, now) }
}

// Focus hours (core/work/focus.ts): set by chat (the junior MCP's
// set_focus_hours), one config value per workspace. No form, no settings field.

/** The workspace's focus hours; null = none set. */
export async function readFocusHours(rt: WorkspaceRuntime): Promise<FocusHours | null> {
  return readFocus(await rt.store.config.get<unknown>(FOCUS_HOURS_KEY))
}

export interface FocusView {
  focus: FocusHours | null
  /** in a focus window right now: until when (epoch ms) */
  now: { until: number } | null
  /** the setting in words */
  text: string
}

const focusView = (focus: FocusHours | null, now: number): FocusView => ({ focus, now: inFocus(focus, now), text: describeFocus(focus) })

/** Focus hours and whether they are on right now. */
export async function getFocusHoursOp(rt: WorkspaceRuntime, now = Date.now()): Promise<FocusView> {
  return focusView(await readFocusHours(rt), now)
}

/**
 * Set them from { windows: [{ days, start, end }], waitMinutes? }; an empty
 * list clears them. A new setting starts fresh: an earlier "End focus" is dropped.
 */
export async function setFocusHoursOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<FocusView> {
  const out = focusFrom(raw)
  if (!out.ok) throw new Error(out.error)
  await rt.store.config.set(FOCUS_HOURS_KEY, out.value)
  log('info', 'inbox', out.value ? `focus hours set: ${describeFocus(out.value)}` : 'focus hours cleared', { workspace: rt.meta.id })
  invalidateInbox(rt)
  return focusView(out.value, now)
}

/** "End focus": the rest of the current window is skipped; the next one starts as set. */
export async function endFocusOp(rt: WorkspaceRuntime, now = Date.now()): Promise<FocusView> {
  const focus = await readFocusHours(rt)
  if (!focus || !inFocus(focus, now)) return focusView(focus, now)
  const ended = endFocus(focus, now)
  await rt.store.config.set(FOCUS_HOURS_KEY, ended)
  log('info', 'inbox', 'focus ended early', { workspace: rt.meta.id, until: ended.endedUntil })
  invalidateInbox(rt)
  return focusView(ended, now)
}
