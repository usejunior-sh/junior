import { readFile } from 'node:fs/promises'
import { type ActivityResponse, type ItemDetailResponse, type ItemEventsResponse, type ItemListResponse, type ItemStateResponse, type JobFileResponse, type JobRunsResponse, type LogLevel, type LogsResponse, type SessionContextResponse, type SystemResponse, USAGE_WINDOWS, type UsageResponse } from '../../shared/protocol.js'
import type { ItemStatus } from '../../core/work/state.js'
import { log, logSubsystems, recentLogs } from '../log.js'
import { linkByRefs } from '../../core/work/link.js'
import { rank } from '../../core/work/score.js'
import { serializeJobFile, starterJobFile } from '../job-files.js'
import { scanUsage } from '../../core/usage/ledger.js'
import { summarize as summarizeUsage } from '../../core/usage/summary.js'
import { readJsonBody } from './http-util.js'
import { ANY_ITEM_ID_RE, ITEM_STATUSES } from '../validate.js'
import { invalidateInbox } from '../ws/send.js'
import { listItemsByStatus } from '../inbox/sync.js'
import { itemDetailOp, sessionContextOp } from '../items-ops.js'
import { errText } from '../errors.js'
import { jobFileReference, jobSpecFrom, saveJobText } from '../jobs/ops.js'
import { jobLibrary } from '../session/changes.js'
import { enqueueJob } from '../jobs/queue.js'
import { claudeProjectRoots, systemStatus } from '../jobs/scheduler.js'
import type { ScopedCtx } from './ctx.js'

export async function itemRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/items/state' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; status?: unknown; snoozeUntil?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const statusV = parsed?.status as ItemStatus
      if (!ANY_ITEM_ID_RE.test(id) || !ITEM_STATUSES.has(statusV)) {
        throw new Error('need an item id and a status (open|done|snoozed|archived)')
      }
      const snoozeUntil = typeof parsed?.snoozeUntil === 'number' ? parsed.snoozeUntil : undefined
      if (statusV === 'snoozed' && !snoozeUntil) throw new Error('snoozed needs snoozeUntil (epoch ms)')
      // A recorded transition on the durable item, never a delete (.docs/jobs-v2.md).
      await rt.store.items.transition(id, { status: statusV, actor: 'user', snoozeUntil })
      invalidateInbox(rt)
      log('info', 'inbox', `${statusV}: ${id} (by user)`, { id, status: statusV, actor: 'user', workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Ranked items in a status tab other than the open inbox (done/snoozed/archived).
  if (url.pathname === '/api/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const s = url.searchParams.get('status')
      const status: ItemStatus = ITEM_STATUSES.has(s as ItemStatus) ? (s as ItemStatus) : 'open'
      body = { ok: true, items: await listItemsByStatus(rt, status) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // One item, whole and unfiltered, what the MCP tool get_work_item reads,
  // and what the stdio shim reaches for over HTTP.
  if (url.pathname === '/api/items/detail' && req.method === 'GET') {
    let body: ItemDetailResponse
    try {
      body = { ok: true, detail: await itemDetailOp(rt, url.searchParams.get('id') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // What a session may know about itself: its workspace, its work item, its notes.
  if (url.pathname === '/api/sessions/context' && req.method === 'GET') {
    let body: SessionContextResponse
    try {
      body = { ok: true, context: await sessionContextOp(rt, url.searchParams.get('id') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // The append-only transition log for one item (its timeline).
  if (url.pathname === '/api/items/events' && req.method === 'GET') {
    let body: ItemEventsResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, events: await rt.store.items.events(id) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Activity: job runs (each a session) as a browsable history, newest first.
  if (url.pathname === '/api/activity' && req.method === 'GET') {
    let body: ActivityResponse
    try {
      const jobId = url.searchParams.get('jobId')
      const titles = new Map((await rt.store.jobs.list()).map((w) => [w.id, w.title]))
      const runs = [...rt.rows.values()]
        .filter((r) => r.kind === 'job-run' && (!jobId || r.jobId === jobId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((r) => ({
          sessionId: r.id,
          ...(r.jobId ? { jobId: r.jobId } : {}),
          jobTitle: (r.jobId && titles.get(r.jobId)) || r.title.replace(/^Job · /, ''),
          status: r.runStatus,
          ...(r.runTrigger ? { trigger: r.runTrigger } : {}),
          matches: r.runMatches,
          ...(r.runNew != null ? { newCount: r.runNew } : {}),
          tokens: r.runTokens,
          ...(r.runCostUsd != null ? { costUsd: r.runCostUsd } : {}),
          startedAt: r.createdAt,
          finishedAt: r.updatedAt,
          ...(r.runError ? { error: r.runError } : {}),
        }))
      body = { ok: true, runs }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // Every item a job has ever filed, any status. The job page's Items tab.
  if (url.pathname === '/api/jobs/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => it.jobId === id || (it.foundBy ?? []).some((p) => p.jobId === id))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // The job file editor: GET the text (an existing job's file, a legacy
  // row rendered as one, or a starter) plus a reference list; POST saves it.
  if (url.pathname === '/api/jobs/file') {
    let body: JobFileResponse
    let status = 200
    try {
      const id = url.searchParams.get('id')
      const projects = await rt.store.projects.list()
      if (req.method === 'GET') {
        const w = id ? await rt.store.jobs.get(id) : null
        if (id && !w) {
          status = 404
          throw new Error('unknown job id')
        }
        let text = starterJobFile(projects)
        if (w?.file) text = await readFile(rt.jobFiles.pathOf(w.file), 'utf8').catch(() => serializeJobFile(jobSpecFrom(w)))
        else if (w) text = serializeJobFile(jobSpecFrom(w))
        body = { ok: true, text, ...(w?.file ? { file: `jobs/${w.file}.md` } : {}), reference: jobFileReference(rt, projects, await jobLibrary(rt)) }
      } else if (req.method === 'POST') {
        const raw = (await readJsonBody(req)) as { text?: unknown }
        if (typeof raw?.text !== 'string') throw new Error('text must be a string')
        const saved = await saveJobText(rt, id, raw.text)
        body = 'errors' in saved ? { ok: false, error: 'the file has problems', errors: saved.errors } : { ok: true, id: saved.id }
      } else {
        status = 405
        throw new Error('GET or POST')
      }
    } catch (err) {
      if (status === 200) status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(status, body)
    return true
  }
  // The slot ledger for one job: the job page's Runs table.
  if (url.pathname === '/api/jobs/runs' && req.method === 'GET') {
    let body: JobRunsResponse
    let status = 200
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!(await rt.store.jobs.get(id))) {
        status = 404
        throw new Error('unknown job id')
      }
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      body = { ok: true, runs: await rt.store.jobRuns.list(id, limit) }
    } catch (err) {
      if (status === 200) status = 502
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(status, body)
    return true
  }
  // The items one run produced (provenance runId === sessionId).
  if (url.pathname === '/api/activity/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const runId = url.searchParams.get('runId') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => (it.foundBy ?? []).some((p) => p.runId === runId))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // Force-run one job now (the per-job Run button). The run appears under
  // Activity; scheduled cadence runs continue on their own.
  if (url.pathname === '/api/jobs/run' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const w = await rt.store.jobs.get(id)
      if (!w) throw new Error('unknown job id')
      if (w.configError) throw new Error(w.configError)
      enqueueJob(rt, id)
      log('info', 'job', `run requested: ${w.title}`, { jobId: id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Daemon status for the System modal (is it up, ticking, connected?).
  if (url.pathname === '/api/system' && req.method === 'GET') {
    let body: SystemResponse
    try {
      body = { ok: true, status: await systemStatus(rt) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // The daemon's recent activity log (filterable by level / subsystem / text).
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const level = url.searchParams.get('level')
    const body: LogsResponse = {
      ok: true,
      entries: recentLogs({
        level: (level as LogLevel) || undefined,
        subsystem: url.searchParams.get('subsystem') || undefined,
        q: url.searchParams.get('q') || undefined,
      }),
      subsystems: logSubsystems(),
    }
    json(200, body)
    return true
  }
  // What Claude Code has spent on this machine, read from its own transcripts.
  // Machine-wide on purpose: a session started in a terminal costs the same
  // money as one started here, and the user asked what they are spending.
  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const asked = Number(url.searchParams.get('days'))
    const days = USAGE_WINDOWS.includes(asked as (typeof USAGE_WINDOWS)[number]) ? asked : 30
    const now = Date.now()
    // From the start of the day `days - 1` ago, so "7 days" is seven columns.
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime() - (days - 1) * 86_400_000
    const began = Date.now()
    let body: UsageResponse
    try {
      const { entries, files, reread } = await scanUsage(claudeProjectRoots(), since)
      const usage = summarizeUsage(entries, since, now)
      usage.scan = { files, reread, ms: Date.now() - began }
      body = { ok: true, usage }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  return false
}
