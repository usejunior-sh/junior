import { randomUUID } from 'node:crypto'
import type { JobDraftResponse, JobPreviewStartResponse, JobPreviewStatusResponse, JobsResponse } from '../../shared/protocol.js'
import { cronFromCadence } from '../../core/job/cron.js'
import type { JobFileSpec } from '../job-files.js'
import { log } from '../log.js'
import { grantLabel } from '../../core/job/tools.js'
import type { Job } from '../../core/job/types.js'
import { draftJob } from '../../core/sources/slack.js'
import { jobPatchFrom } from '../validate.js'
import { readJsonBody } from './http-util.js'
import { deleteJob, draftJobOp, draftJobText, jobSpecFrom, syncJobFiles } from '../jobs/ops.js'
import { startJobPreview } from '../jobs/preview.js'
import { errText } from '../errors.js'
import type { ScopedCtx } from './ctx.js'

export async function jobRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/jobs') {
    let body: JobsResponse
    let status = 200
    try {
      // Jobs are files: create and edit write `jobs/<name>.md`, then sync
      // the row from it — the same path a hand edit takes.
      if (req.method === 'POST') {
        const parsed = jobPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        const p = parsed.patch
        if (!p.title || !p.instruction || !p.tools?.length) {
          throw new Error('a job needs a title, instructions, and at least one integration')
        }
        if (!p.projectId) throw new Error('pick the project this job runs in')
        if (!(await rt.store.projects.list()).some((pr) => pr.id === p.projectId)) throw new Error('unknown project')
        // Schedule is the source of truth; accept a legacy cadence as a fallback.
        const schedule = p.schedule ?? (p.cadence ? cronFromCadence(p.cadence, p.windowStart, p.windowDay) : '0 9 * * *')
        const spec: JobFileSpec = {
          id: randomUUID(),
          title: p.title,
          schedule,
          project: p.projectId,
          tools: p.tools,
          ...(p.model ? { model: p.model } : {}),
          output: p.output ?? 'items',
          ...(p.catchUpWindow ? { catchUp: p.catchUpWindow } : {}),
          ...(p.timeoutMs != null ? { timeoutMs: p.timeoutMs } : {}),
          ...(p.maxBudgetUsd != null ? { budgetUsd: p.maxBudgetUsd } : {}),
          ...(p.dailyBudgetUsd != null ? { dailyBudgetUsd: p.dailyBudgetUsd } : {}),
          notify: p.notify ?? 'on_failure',
          enabled: p.enabled ?? true,
          ...(p.brief ? { brief: p.brief } : {}),
          instruction: p.instruction,
        }
        const name = rt.jobFiles.freeName(p.title)
        await rt.jobFiles.write(name, spec)
        // "Run once now" off: the first run waits for the next slot.
        await syncJobFiles(rt, { force: true, ...(p.runOnceNow === false ? { deferFirstRun: spec.id } : {}) })
        log('info', 'job', `created: ${p.title} (jobs/${name}.md)`, { tools: p.tools.map(grantLabel), schedule, workspace: rt.meta.id })
        // active on the next scheduler tick (never run → due immediately, unless runOnceNow was off)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.jobs.get(id) : null
        if (!id || !existing) throw new Error('unknown job id')
        const parsed = jobPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        if (parsed.patch.projectId && !(await rt.store.projects.list()).some((pr) => pr.id === parsed.patch.projectId)) {
          throw new Error('unknown project')
        }
        const { runOnceNow: _ignored, ...patch } = parsed.patch
        // The on/off switch edits only the `enabled:` line, so a hand-kept file stays as written.
        const onlyToggle = Object.keys(patch).every((k) => k === 'enabled') && patch.enabled !== undefined
        // A legacy row gets its first file here — saving it is the way across.
        const name = existing.file ?? rt.jobFiles.freeName(patch.title ?? existing.title)
        const merged = { ...existing, ...patch } as Job
        if (patch.schedule) merged.schedule = patch.schedule
        if (onlyToggle && existing.file) await rt.jobFiles.setEnabled(existing.file, patch.enabled!)
        else await rt.jobFiles.write(name, jobSpecFrom(merged))
        await syncJobFiles(rt, { force: true })
        const after = await rt.store.jobs.get(id)
        if (patch.enabled === true && after?.configError) throw new Error(after.configError)
        log('info', 'job', `updated: ${merged.title} (jobs/${name}.md)`, { jobId: id, workspace: rt.meta.id })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.jobs.get(id) : null
        if (id && existing) {
          if (existing.file) await rt.jobFiles.remove(existing.file)
          await deleteJob(rt, id, 'deleted by the user')
        }
      } else {
        await syncJobFiles(rt)
      }
      body = { ok: true, jobs: await rt.store.jobs.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return true
  }
  // Dry run of the form's current state (.docs/jobs.md "Preview step"):
  // POST starts it and hands back an ephemeral session id to subscribe to for
  // the live transcript; GET polls its outcome. Nothing is written anywhere.
  if (url.pathname === '/api/jobs/preview' && req.method === 'POST') {
    let body: JobPreviewStartResponse
    try {
      const parsed = jobPatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.instruction || !p.tools?.length) throw new Error('a preview needs instructions and at least one integration')
      if (!p.projectId) throw new Error('pick the project this job runs in')
      const previewId = startJobPreview(rt, {
        instruction: p.instruction,
        tools: p.tools,
        projectId: p.projectId,
        model: p.model,
        output: p.output ?? 'items',
        schedule: p.schedule ?? '0 9 * * *',
      })
      body = { ok: true, previewId }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/jobs/preview' && req.method === 'GET') {
    const pv = rt.previews.get(url.searchParams.get('id') ?? '')
    const body: JobPreviewStatusResponse = pv
      ? { ok: true, status: pv.status, ...(pv.result ? { result: pv.result } : {}), ...(pv.error ? { error: pv.error } : {}) }
      : { ok: false, error: 'unknown or expired preview' }
    json(body.ok ? 200 : 404, body)
    return true
  }
  // MCP draft_job over HTTP (the stdio shim and POST /mcp): saved off, a draft.
  if (url.pathname === '/api/jobs/drafted' && req.method === 'POST') {
    let body: { ok: true; text: string; id: string } | { ok: false; error: string }
    try {
      const d = await draftJobOp(rt, await readJsonBody(req))
      body = { ok: true, text: draftJobText(d), id: d.id }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/jobs/draft' && req.method === 'POST') {
    let body: JobDraftResponse
    try {
      const parsed = (await readJsonBody(req)) as { text?: unknown } | null
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (!text) throw new Error('describe the job in plain text first')
      const draft = await draftJob(rt.provider, text, undefined, rt.env)
      if (!draft) throw new Error('could not parse that into a job — fill the form manually')
      body = { ok: true, draft }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  return false
}
