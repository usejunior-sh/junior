import { JOB_NOTIFY, JOB_OUTPUTS, type JobBrief, type JobCadence, type JobNotify, type JobOutput, MAX_JOB_TIMEOUT_MS, type NewJob } from '../core/job/types.js'
import type { ItemStatus } from '../core/work/state.js'
import { BASE } from '../core/work/score.js'
import { type ManualItemInput, MAX_IMAGE_BYTES, MAX_IMAGES_PER_ITEM, type WorkItem } from '../shared/protocol.js'
import { grantsFrom, grantsFromLegacy, type LegacyConnector } from '../core/job/tools.js'
import { isCatchUpSpec } from '../core/job/schedule.js'
import { isValidCron } from '../core/job/cron.js'
import { isPlaybookName } from './briefs.js'
import { isAsk } from '../core/work/asks.js'
import { parseDue } from '../core/work/due.js'
import { isItemLabel, ITEM_LABELS } from '../core/work/fields.js'
import { canonicalizeRefs } from '../core/work/link.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { itemImageEdits, itemUrls } from './items-ops.js'

// Input validation: the HTTP surface is untrusted:
// bodies are validated into domain shapes, and rejected rather than repaired.

const CADENCES = new Set<JobCadence>(['hourly', 'daily', 'weekly'])
export const ITEM_STATUSES = new Set<ItemStatus>(['open', 'done', 'snoozed', 'archived'])
const VALID_KINDS = new Set(Object.keys(BASE))
const VALID_SOURCES = new Set(['github', 'slack', 'linear', 'web'])
// upsert accepts only scanner sources; state/resolve accept manual items too.
const ITEM_ID_RE = /^(github|slack|linear|web):\S+$/
export const ANY_ITEM_ID_RE = /^(github|slack|linear|web|manual):\S+$/
/** Item saves carry images inline: the per-image cap, base64-inflated, times the per-item cap. */
export const MAX_ITEM_BODY_BYTES = Math.ceil(MAX_IMAGES_PER_ITEM * MAX_IMAGE_BYTES * 1.4) + 100_000
export const MAX_URLS_PER_ITEM = 20

type JobPatch = Partial<NewJob> & { enabled?: boolean; runOnceNow?: boolean }

const LEGACY_CONNECTORS: LegacyConnector[] = ['web', 'slack', 'linear', 'github']

export function jobPatchFrom(raw: unknown): { patch: JobPatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: JobPatch = {}
  if (r.title !== undefined) {
    if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
    patch.title = r.title.trim()
  }
  if (r.scope !== undefined) {
    // legacy place hint; empty clears it
    if (typeof r.scope !== 'string' || (r.scope.trim() && !/^[#@]\S+$/.test(r.scope.trim()))) return { error: 'scope must be "#channel", "@dm", or empty' }
    patch.scope = r.scope.trim()
  }
  if (r.tools !== undefined) {
    const parsed = grantsFrom(r.tools)
    if ('error' in parsed) return { error: parsed.error }
    patch.tools = parsed.grants
  } else if (r.connectors !== undefined) {
    // legacy clients: the four fixed integrations → grants
    if (!Array.isArray(r.connectors) || r.connectors.length === 0 || !r.connectors.every((c) => LEGACY_CONNECTORS.includes(c as LegacyConnector))) {
      return { error: `connectors must be a non-empty list of: ${LEGACY_CONNECTORS.join(', ')}` }
    }
    patch.tools = grantsFromLegacy([...new Set(r.connectors as LegacyConnector[])])
  }
  if (r.projectId !== undefined) {
    // required: every job runs in a project folder
    if (typeof r.projectId !== 'string' || !r.projectId) return { error: 'projectId is required — pick the project this job runs in' }
    patch.projectId = r.projectId
  }
  if (r.catchUpWindow !== undefined) {
    if (r.catchUpWindow !== null && !isCatchUpSpec(r.catchUpWindow)) return { error: 'catchUpWindow must be "never", "unlimited", or a duration like "6h", or null' }
    patch.catchUpWindow = r.catchUpWindow as string | null
  }
  if (r.timeoutMs !== undefined) {
    const t = r.timeoutMs
    if (t !== null && (typeof t !== 'number' || !Number.isInteger(t) || t < 30_000 || t > MAX_JOB_TIMEOUT_MS)) {
      return { error: `timeoutMs must be null or whole milliseconds from 30000 to ${MAX_JOB_TIMEOUT_MS}` }
    }
    patch.timeoutMs = t as number | null
  }
  if (r.maxBudgetUsd !== undefined) {
    const b = r.maxBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 100)) return { error: 'maxBudgetUsd must be null or dollars from 0.01 to 100' }
    patch.maxBudgetUsd = b as number | null
  }
  if (r.dailyBudgetUsd !== undefined) {
    const b = r.dailyBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 1000)) return { error: 'dailyBudgetUsd must be null or dollars from 0.01 to 1000' }
    patch.dailyBudgetUsd = b as number | null
  }
  if (r.notify !== undefined) {
    if (!JOB_NOTIFY.includes(r.notify as JobNotify)) return { error: `notify must be one of: ${JOB_NOTIFY.join(', ')}` }
    patch.notify = r.notify as JobNotify
  }
  if (r.runOnceNow !== undefined) {
    if (typeof r.runOnceNow !== 'boolean') return { error: 'runOnceNow must be a boolean' }
    patch.runOnceNow = r.runOnceNow
  }
  if (r.output !== undefined) {
    if (!JOB_OUTPUTS.includes(r.output as JobOutput)) return { error: `output must be one of: ${JOB_OUTPUTS.join(', ')}` }
    patch.output = r.output as JobOutput
  }
  if (r.model !== undefined) {
    // an alias or wire id as the model picker reports it; null/empty = default
    if (r.model !== null && (typeof r.model !== 'string' || r.model.length > 120)) return { error: 'model must be a string or null' }
    patch.model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined
  }
  if (r.instruction !== undefined) {
    if (typeof r.instruction !== 'string' || !r.instruction.trim()) return { error: 'instruction must be a non-empty string' }
    patch.instruction = r.instruction.trim()
  }
  if (r.cadence !== undefined) {
    if (!CADENCES.has(r.cadence as JobCadence)) return { error: 'cadence must be hourly | daily | weekly' }
    patch.cadence = r.cadence as JobCadence
  }
  if (r.schedule !== undefined) {
    if (typeof r.schedule !== 'string' || !isValidCron(r.schedule)) {
      return { error: 'schedule must be a valid 5-field cron expression, e.g. "0 9 * * *"' }
    }
    patch.schedule = r.schedule.trim()
  }
  if (r.windowStart !== undefined && r.windowStart !== null) {
    if (typeof r.windowStart !== 'string' || !/^\d{1,2}:\d{2}$/.test(r.windowStart)) return { error: 'windowStart must be "HH:MM"' }
    patch.windowStart = r.windowStart
  }
  if (r.windowDay !== undefined && r.windowDay !== null) {
    if (typeof r.windowDay !== 'number' || !Number.isInteger(r.windowDay) || r.windowDay < 0 || r.windowDay > 6) return { error: 'windowDay must be 0-6' }
    patch.windowDay = r.windowDay
  }
  if (r.createsItems !== undefined) {
    if (typeof r.createsItems !== 'boolean') return { error: 'createsItems must be a boolean' }
    patch.createsItems = r.createsItems
  }
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { error: 'enabled must be a boolean' }
    patch.enabled = r.enabled
  }
  if (r.brief !== undefined) {
    const b = jobBriefFrom(r.brief)
    if (typeof b === 'string') return { error: b }
    patch.brief = b
  }
  return { patch }
}

/** The brief option off the wire: null = off, {} = on with the defaults. A string is the error. */
function jobBriefFrom(raw: unknown): JobBrief | null | string {
  if (raw === null || raw === false) return null
  if (raw === true) return {}
  if (typeof raw !== 'object') return 'brief must be null, true, or { model?, template? }'
  const o = raw as Record<string, unknown>
  if (o.model !== undefined && o.model !== null && (typeof o.model !== 'string' || o.model.length > 120)) return 'brief.model must be a string'
  if (o.template !== undefined && o.template !== null && !isPlaybookName(o.template)) return 'brief.template must be a playbook name'
  return {
    ...(typeof o.model === 'string' && o.model.trim() ? { model: o.model.trim() } : {}),
    ...(typeof o.template === 'string' && o.template ? { template: o.template } : {}),
  }
}

/** A full ingested WorkItem, validated field by field. Rejects, never repairs. */
export function workItemFrom(raw: unknown): { item: WorkItem } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ITEM_ID_RE.test(r.id)) return { error: 'id must look like "slack:...", "github:owner/repo#123", or "linear:KEY-123"' }
  const source = r.id.slice(0, r.id.indexOf(':'))
  if (r.source !== undefined && r.source !== source) return { error: `source must match the id prefix ("${source}")` }
  if (!VALID_SOURCES.has(source)) return { error: 'unknown source' }
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` }
  if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
  if (typeof r.url !== 'string' || !r.url.startsWith('http')) return { error: 'url must be an http(s) URL' }
  if (typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) return { error: 'updatedAt must be an ISO 8601 timestamp' }
  const createdAt = typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : r.updatedAt
  return {
    item: {
      id: r.id,
      source: source as WorkItem['source'],
      kind: r.kind as WorkItem['kind'],
      title: r.title.trim(),
      url: r.url,
      repo: typeof r.repo === 'string' ? r.repo : '',
      author: typeof r.author === 'string' ? r.author : '',
      peopleWaiting: typeof r.peopleWaiting === 'number' && r.peopleWaiting >= 0 ? Math.floor(r.peopleWaiting) : 0,
      createdAt,
      updatedAt: r.updatedAt,
      ...(typeof r.jobId === 'string' ? { jobId: r.jobId } : {}),
      ...(typeof r.why === 'string' && r.why ? { why: r.why } : {}),
      ...(isAsk(r.ask) ? { ask: r.ask } : {}),
      ...(parseDue(r.due) != null ? { dueAt: parseDue(r.due)! } : {}),
      ...(canonicalizeRefs(r.refs) ? { refs: canonicalizeRefs(r.refs) } : {}),
    },
  }
}

/**
 * A manual to-do's fields, validated. Project (if given) must exist; url (if
 * given) must be http(s); priority (if given) is 1–4. Title is required on
 * create; with `{ partial: true }` (an edit) only the fields present are
 * validated and returned, so a caller can patch one field without resending
 * the rest.
 */
export async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown): Promise<ManualItemInput>
export async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial: true }): Promise<Partial<ManualItemInput>>
export async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial?: boolean } = {}): Promise<Partial<ManualItemInput>> {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title && !opts.partial) throw new Error('a work item needs a title')
  const input: Partial<ManualItemInput> = {}
  if (title) input.title = title
  if (typeof r.projectId === 'string' && r.projectId) {
    const projects = await rt.store.projects.list()
    if (!projects.some((p) => p.id === r.projectId)) throw new Error('unknown project')
    input.projectId = r.projectId
  }
  // `description` is the 0.7 name; `note` is accepted as the old one for one release.
  const desc = typeof r.description === 'string' ? r.description : typeof r.note === 'string' ? r.note : undefined
  if (desc !== undefined && desc.trim()) input.description = desc.trim()
  if (typeof r.url === 'string' && r.url.trim()) {
    if (!/^https?:\/\//.test(r.url.trim())) throw new Error('link must be an http(s) URL')
    input.url = r.url.trim()
  }
  // When the key is present, 0/null means "none" (0) so an edit can clear it;
  // when absent, priority is left untouched on update.
  if ('priority' in r) {
    const p = r.priority
    if (p === null || p === 0) input.priority = 0
    else if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 4) input.priority = p
    else throw new Error('priority must be 1–4')
  }
  if (r.label !== undefined && r.label !== null) {
    if (!isItemLabel(r.label)) throw new Error(`label must be one of: ${ITEM_LABELS.join(', ')}`)
    input.label = r.label
  }
  const urls = itemUrls(r.urls)
  if (urls) input.urls = urls
  const images = itemImageEdits(r)
  if (images) input.images = images
  return input
}
