import { rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { type Job, JOB_OUTPUTS, type JobBrief, type JobOutput } from '../../core/job/types.js'
import type { JobFiling } from '../../core/job/filing.js'
import { type JobToolGrant, presetGrant, RESERVED_SERVER } from '../../core/job/tools.js'
import { log } from '../log.js'
import { checkGrants, checkLibrary, grantsFromLines, type JobFileSpec, type JobLibrary, parseJobFile, serializeJobFile, withKey } from '../job-files.js'
import { scheduleOf } from '../../core/job/schedule.js'
import type { JobFileReference, Project } from '../../shared/protocol.js'
import { vetoRefusal } from '../providers/capabilities.js'
import { isValidCron } from '../../core/job/cron.js'
import { listPlaybooks } from '../briefs.js'
import { type ConnectorProbe, WorkspaceRuntime } from '../workspace/runtime.js'
import { jobLibrary } from '../session/changes.js'
import { defaultProject } from '../session/sessions.js'
import { type JobPreview, runJobPreview } from './preview.js'
import { invalidateInbox } from '../ws/send.js'

/**
 * The Slack job (M4): seeded on, the way Slack work reaches the inbox. One
 * scan every 15 minutes in working hours, with the three tiers: what Junior
 * may start on alone, what it only shows you, and what it never files. A
 * question asked of you becomes a People waiting item with a draft reply
 * (the answer rule); a mention is FYI.
 */
export const SLACK_JOB_INSTRUCTION = `Find the Slack messages that need me: direct messages and threads where someone asks me something I have not answered yet, and channel messages that mention me. Skip anything I already answered, and anything where the latest message is mine. One item per thread.`

export const SLACK_TEMPLATE: Omit<JobFileSpec, 'id' | 'project'> = {
  title: 'Slack',
  schedule: '*/15 8-18 * * 1-5',
  tools: [presetGrant('claude.ai Slack')!],
  model: 'sonnet',
  output: 'items',
  budgetUsd: 0.5,
  dailyBudgetUsd: 5,
  notify: 'on_failure',
  enabled: true,
  filing: {
    reasons: ['asked', 'mentioned'],
    labels: [],
    tiers: {
      start: ['direct messages to me that ask me something', 'threads I am in where the latest message asks me something'],
      show: ['channel messages that mention me without asking me anything'],
      ignore: ['bot and alert channels', 'messages from bots and integrations'],
    },
  },
  instruction: SLACK_JOB_INSTRUCTION,
}

/** Templates from before M4, retired once the Slack job covers them: removed only if you never touched them. */
const RETIRED_TEMPLATES = ['mentions', 'unread-dms']

const NEEDS_PROJECT = 'pick the project this job runs in'

/**
 * Every job runs in a project folder and there is no
 * fallback folder. A job without one, saved before the rule, its project
 * since removed, or left in the retired scratch project, pauses with a config
 * error until the user picks a project. It never runs somewhere else.
 */
export async function migrateJobProjects(rt: WorkspaceRuntime): Promise<void> {
  // Retire the scratch projects a dev build created, and their folders if still empty.
  for (const p of await rt.store.projects.retireBuiltin()) {
    await rmdir(p.path).catch(() => {}) // only succeeds on an empty folder
    log('info', 'job', `removed the retired scratch project ${p.path}`, { workspace: rt.meta.id })
  }
  const projects = await rt.store.projects.list()
  for (const w of await rt.store.jobs.list()) {
    if (w.file) continue // a file job's project is checked on every sync
    if (w.projectId && projects.some((p) => p.id === w.projectId)) continue
    if (w.configError && !w.enabled) continue
    await rt.store.jobs.patchState(w.id, { projectId: null, enabled: false, configError: NEEDS_PROJECT })
    log('info', 'job', `paused "${w.title}": it has no project — pick one to run it`, { jobId: w.id, workspace: rt.meta.id })
  }
}

/**
 * The shipped templates as job files. The Slack job runs in the workspace's
 * default project (where Junior reads code to answer); with none yet it is
 * held, asking for one, and picks one up once a project is added.
 */
async function jobTemplateFiles(rt: WorkspaceRuntime): Promise<Record<string, JobFileSpec>> {
  const project = await defaultProject(rt)
  return { slack: { id: 'template-slack', project: project?.id ?? '', ...SLACK_TEMPLATE } }
}

/**
 * Install the built-in templates as files in `jobs/`, tracked in its
 * `.seeded.json` (teams' pattern): an untouched one follows upgrades, an edited
 * one is the user's, a deleted one stays deleted. Retired ones go if untouched.
 */
export async function seedJobTemplates(rt: WorkspaceRuntime): Promise<void> {
  await rt.jobFiles.seed(await jobTemplateFiles(rt))
  await rt.jobFiles.retire(RETIRED_TEMPLATES)
  await syncJobFiles(rt, { force: true })
}

/** A row saved before job files: shown, never run, until it is saved as a file. */
const LEGACY_JOB = 'saved before job files — open it and Save to move it into jobs/, or recreate it'

/** A job file's spec → the row's config columns. */
function jobConfigFrom(spec: JobFileSpec, file: string) {
  return {
    title: spec.title,
    instruction: spec.instruction,
    schedule: spec.schedule,
    tools: spec.tools,
    projectId: spec.project,
    model: spec.model,
    output: spec.output,
    catchUpWindow: spec.catchUp ?? null,
    timeoutMs: spec.timeoutMs ?? null,
    maxBudgetUsd: spec.budgetUsd ?? null,
    dailyBudgetUsd: spec.dailyBudgetUsd ?? null,
    notify: spec.notify,
    enabled: spec.enabled,
    brief: spec.brief ?? null,
    draft: !!spec.draft,
    skills: spec.skills ?? null,
    agents: spec.agents ?? null,
    filing: spec.filing ?? null,
    file,
  }
}

/** A job (row or patched row) → the file that says the same. */
export function jobSpecFrom(w: Job): JobFileSpec {
  return {
    id: w.id,
    title: w.title,
    schedule: scheduleOf(w),
    project: w.projectId ?? '',
    tools: w.tools,
    ...(w.model ? { model: w.model } : {}),
    output: w.output,
    ...(w.catchUpWindow ? { catchUp: w.catchUpWindow } : {}),
    ...(w.timeoutMs != null ? { timeoutMs: w.timeoutMs } : {}),
    ...(w.maxBudgetUsd != null ? { budgetUsd: w.maxBudgetUsd } : {}),
    ...(w.dailyBudgetUsd != null ? { dailyBudgetUsd: w.dailyBudgetUsd } : {}),
    notify: w.notify,
    enabled: w.enabled,
    ...(w.brief ? { brief: w.brief } : {}),
    // enabling a draft is its review
    ...(w.draft && !w.enabled ? { draft: true } : {}),
    ...(w.skills?.length ? { skills: w.skills } : {}),
    ...(w.agents?.length ? { agents: w.agents } : {}),
    ...(w.filing ? { filing: w.filing } : {}),
    instruction: w.instruction,
  }
}

type JobConfig = ReturnType<typeof jobConfigFrom>
const configKey = (w: Pick<Job, Exclude<keyof JobConfig, 'catchUpWindow' | 'timeoutMs' | 'maxBudgetUsd' | 'dailyBudgetUsd' | 'brief' | 'draft' | 'skills' | 'agents' | 'filing'>> & {
  catchUpWindow?: string | null
  timeoutMs?: number | null
  maxBudgetUsd?: number | null
  dailyBudgetUsd?: number | null
  brief?: JobBrief | null
  draft?: boolean
  skills?: string[] | null
  agents?: string[] | null
  filing?: JobFiling | null
}) =>
  JSON.stringify([
    w.title, w.instruction, w.schedule, w.tools, w.projectId || '', w.model ?? null, w.output, w.catchUpWindow ?? null,
    w.timeoutMs ?? null, w.maxBudgetUsd ?? null, w.dailyBudgetUsd ?? null, w.notify, w.enabled, w.file ?? null,
    w.brief ? [w.brief.model ?? null, w.brief.template ?? null] : null, !!w.draft,
    w.skills?.length ? w.skills : null, w.agents?.length ? w.agents : null, w.filing ?? null,
  ])

/**
 * Bring the rows in line with `jobs/*.md`. Cheap when nothing moved: it
 * re-reads only when a file, the project list or a connector probe changed
 * (or `force`). A file is never trusted blindly: anything that fails the
 * schema, names a missing project or a tool the probe doesn't know becomes a
 * config error on its row, which holds the job; it never throws. A file
 * without an id (hand-written) or with a copied one gets its own, written
 * back. A row whose file is gone is deleted like any job; a row from before
 * files is held as legacy.
 */
export function syncJobFiles(rt: WorkspaceRuntime, opts: { force?: boolean; deferFirstRun?: string } = {}): Promise<void> {
  const run = rt.jobSync.then(() => syncJobFilesNow(rt, opts))
  rt.jobSync = run.catch((err) => log('error', 'job', `job file sync failed: ${err}`, { workspace: rt.meta.id }))
  return run
}

async function syncJobFilesNow(rt: WorkspaceRuntime, { force = false, deferFirstRun }: { force?: boolean; deferFirstRun?: string }): Promise<void> {
  const files = await rt.jobFiles.scan()
  const projects = await rt.store.projects.list()
  // only listed when a job names a skill or an agent. A skill removed later holds that job at the next tick
  const named = files.some((f) => /^(skills|agents)\s*:/m.test(f.text))
  const lib: JobLibrary = named ? await jobLibrary(rt) : { skills: new Map(), agents: new Map() }
  const sig = JSON.stringify([
    named ? [[...lib.skills], [...lib.agents]] : null,
    rt.provider.id,
    files.map((f) => [f.name, f.mtimeMs]),
    projects.map((p) => [p.id, p.path]),
    rt.connectorCache?.probedAt ?? 0,
    [...rt.folderProbes].map(([k, v]) => [k, v.probedAt]),
  ])
  if (!force && sig === rt.jobSyncSig) return
  const rows = await rt.store.jobs.list()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const seen = new Set<string>()
  const now = Date.now()
  for (const f of files) {
    const parsed = parseJobFile(f.name, f.text)
    let spec = parsed.spec
    const errors = [...parsed.errors]
    if (!parsed.hadId || seen.has(spec.id)) {
      // a copied file arrives with its original's id: the copy gets its own
      if (parsed.hadId) spec = { ...spec, id: randomUUID() }
      await rt.jobFiles.stampId(f.name, spec.id).catch((err) => errors.push(`could not write an id into the file: ${err}`))
    }
    seen.add(spec.id)
    const checked = checkJobSpec(rt, spec, projects, lib)
    errors.push(...checked.errors)
    const cfg = jobConfigFrom({ ...spec, tools: checked.tools }, f.name)
    const configError = errors.length ? errors.join('; ') : null
    const row = byId.get(spec.id)
    if (!row) {
      await rt.store.jobs.create({
        ...cfg,
        id: spec.id,
        source: 'slack',
        scope: '',
        model: cfg.model,
        catchUpWindow: cfg.catchUpWindow ?? undefined,
        timeoutMs: cfg.timeoutMs ?? undefined,
        maxBudgetUsd: cfg.maxBudgetUsd ?? undefined,
        dailyBudgetUsd: cfg.dailyBudgetUsd ?? undefined,
        cadence: 'daily',
        createsItems: true,
        consecutiveFailures: 0,
        brief: cfg.brief ?? undefined,
        skills: cfg.skills ?? undefined,
        agents: cfg.agents ?? undefined,
        filing: cfg.filing ?? undefined,
        ...(configError ? { configError } : {}),
        // never run → due at once ("run once now"), unless the creator said wait
        ...(deferFirstRun === spec.id ? { lastRunStartedAt: now } : {}),
        createdAt: now,
        updatedAt: now,
      })
      log('info', 'job', `loaded ${f.name}.md${configError ? ` — held: ${configError}` : ''}`, { jobId: spec.id, workspace: rt.meta.id })
      continue
    }
    if (configKey(row) !== configKey(cfg)) {
      await rt.store.jobs.update(row.id, cfg)
      // Turned on: wait for the next slot, no burst of catch-up runs.
      if (cfg.enabled && !row.enabled) await rt.store.jobs.patchState(row.id, { lastRunStartedAt: now })
      log('info', 'job', `reloaded ${f.name}.md`, { jobId: row.id, workspace: rt.meta.id })
    }
    if ((row.configError ?? null) !== configError) {
      await rt.store.jobs.patchState(row.id, { configError })
      if (configError) log('warn', 'job', `${f.name}.md is held: ${configError}`, { jobId: row.id, workspace: rt.meta.id })
    }
  }
  for (const r of rows) {
    if (seen.has(r.id)) continue
    if (r.file) await deleteJob(rt, r.id, 'its file was deleted')
    else if (r.configError !== LEGACY_JOB) await rt.store.jobs.patchState(r.id, { configError: LEGACY_JOB })
  }
  // only a sync that got this far counts; one that threw is retried next tick
  rt.jobSyncSig = sig
}

/**
 * What a parsed job file can't do on this machine: name no project or a
 * missing one, or grant a tool the connector probes don't know. Fills each
 * grant's scope from the probe. The sync and the editor's save share it.
 */
function checkJobSpec(rt: WorkspaceRuntime, spec: JobFileSpec, projects: Project[], lib: JobLibrary): { tools: JobToolGrant[]; errors: string[] } {
  const errors: string[] = []
  const project = projects.find((p) => p.id === spec.project) ?? null
  if (!spec.project) errors.push(NEEDS_PROJECT)
  else if (!project) errors.push(`unknown project "${spec.project}" — pick another project for this job`)
  const refusal = vetoRefusal(rt.provider, 'job')
  if (refusal) errors.push(refusal)
  const probes = [rt.connectorCache, project ? rt.folderProbes.get(project.path) : undefined].filter((p): p is ConnectorProbe => p != null)
  const checked = checkGrants(spec.tools, probes.length ? probes.flatMap((p) => p.connectors) : null)
  return { tools: checked.tools, errors: [...errors, ...checked.errors, ...checkLibrary(spec, lib)] }
}

/** The editor's side list: project ids, every tool line the probes know, the skills and agents a job may name. */
export function jobFileReference(rt: WorkspaceRuntime, projects: Project[], lib: JobLibrary): JobFileReference {
  const servers = new Map<string, string[]>()
  const probes = [rt.connectorCache, ...rt.folderProbes.values()].filter((p): p is ConnectorProbe => p != null)
  for (const c of probes.flatMap((p) => p.connectors)) {
    if (c.server === RESERVED_SERVER || !c.tools.length) continue
    const lines = servers.get(c.server) ?? []
    for (const t of c.tools) if (!lines.includes(`${c.server}/${t.name}`)) lines.push(`${c.server}/${t.name}`)
    servers.set(c.server, lines)
  }
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    builtins: ['web', 'github', 'files-write'],
    servers: [...servers].map(([server, tools]) => ({ server, tools })).sort((a, b) => a.server.localeCompare(b.server)),
    skills: [...lib.skills].filter(([, src]) => src !== 'project').map(([name]) => name),
    agents: [...lib.agents].filter(([, src]) => src !== 'project').map(([name]) => name),
  }
}

/**
 * The editor's save: check the text exactly as the sync would (schema, project,
 * tools) and write it only when nothing is wrong. A new job gets a fresh id
 * (a pasted one that is taken is refused); an edit keeps its id, so its runs
 * and items stay attached.
 */
export async function saveJobText(rt: WorkspaceRuntime, id: string | null, raw: string): Promise<{ id: string } | { errors: string[] }> {
  const existing = id ? await rt.store.jobs.get(id) : null
  if (id && !existing) return { errors: ['unknown job id'] }
  if (raw.length > 64_000) return { errors: ['the file is too large (64 KB at most)'] }
  const parsed = parseJobFile(existing?.file ?? 'job', raw)
  const errors = [...parsed.errors]
  let text = raw
  let jobId = parsed.spec.id
  if (existing) {
    if (parsed.hadId && parsed.spec.id !== existing.id) errors.push(`id must stay ${existing.id} — it ties the job to its runs and items`)
    jobId = existing.id
    if (!parsed.hadId) text = withKey(text, 'id', jobId, 'first')
  } else if (!parsed.hadId) {
    text = withKey(text, 'id', jobId, 'first')
  } else if (await rt.store.jobs.get(jobId)) {
    errors.push(`id ${jobId} belongs to another job — delete the id line and one is made for you`)
  }
  errors.push(...checkJobSpec(rt, parsed.spec, await rt.store.projects.list(), await jobLibrary(rt)).errors)
  if (errors.length) return { errors }
  const name = existing?.file ?? rt.jobFiles.freeName(parsed.spec.title)
  await rt.jobFiles.writeText(name, text)
  await syncJobFiles(rt, { force: true })
  log('info', 'job', `${existing ? 'updated' : 'created'}: ${parsed.spec.title} (jobs/${name}.md)`, { jobId, workspace: rt.meta.id })
  return { id: jobId }
}

/**
 * A chat drafts a job (MCP draft_job): the file is written exactly as a
 * form or a hand edit would write it, but saved off and marked a draft. Only
 * the user's click on the job page turns it on. A model never schedules
 * runs by itself. Checked like any job file; anything wrong is refused with
 * the reasons, so the chat can fix them and try again.
 */
export async function draftJobOp(rt: WorkspaceRuntime, raw: unknown): Promise<{ id: string; title: string; file: string; warnings: string[] }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
  const title = text('title')
  const instruction = text('instruction')
  const schedule = text('schedule')
  if (!title) throw new Error('title is required')
  if (!instruction) throw new Error('instruction is required — where to look and what counts as a match')
  if (!schedule || !isValidCron(schedule)) throw new Error('schedule must be a 5-field cron line, local time — e.g. "0 * * * *" for hourly, "0 9 * * 1-5" for weekdays at 9')

  const projects = await rt.store.projects.list()
  const want = text('project')
  const project = want
    ? projects.find((p) => p.id === want) ?? projects.find((p) => p.name.toLowerCase() === want.toLowerCase())
    : await defaultProject(rt)
  if (!project) throw new Error(want ? `no project "${want}" — pass a project id or name: ${projects.map((p) => p.name).join(', ')}` : 'this workspace has no project yet')

  const errors: string[] = []
  const lines = Array.isArray(r.tools) ? r.tools.filter((t): t is string => typeof t === 'string') : []
  const tools = grantsFromLines(lines.length ? lines : ['web'], errors)
  const output = text('output') || 'items'
  if (!JOB_OUTPUTS.includes(output as JobOutput)) errors.push(`output must be one of: ${JOB_OUTPUTS.join(', ')}`)
  const names = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])
  const skills = names('skills')
  const agents = names('agents')
  const brief = r.brief === true ? { ...(text('brief_model') ? { model: text('brief_model') } : {}), ...(text('brief_template') ? { template: text('brief_template') } : {}) } : undefined
  const spec: JobFileSpec = {
    id: randomUUID(),
    title,
    schedule,
    project: project.id,
    tools,
    ...(text('model') ? { model: text('model') } : {}),
    output: output as JobOutput,
    notify: 'on_failure',
    enabled: false,
    ...(brief ? { brief } : {}),
    draft: true,
    ...(skills.length ? { skills } : {}),
    ...(agents.length ? { agents } : {}),
    instruction,
  }
  // The file's own schema is the check: what it would refuse, this refuses.
  errors.push(...parseJobFile('draft', serializeJobFile(spec)).errors)
  errors.push(...checkJobSpec(rt, spec, projects, await jobLibrary(rt)).errors)
  if (errors.length) throw new Error(errors.join('; '))
  const warnings: string[] = []
  if (brief?.template && !(await listPlaybooks(rt.playbookDir)).some((p) => p.kind === brief.template)) {
    warnings.push(`no playbook named "${brief.template}" yet — briefs will use the generic one until playbooks/${brief.template}.md exists`)
  }
  const name = rt.jobFiles.freeName(title)
  await rt.jobFiles.write(name, spec)
  await syncJobFiles(rt, { force: true })
  log('info', 'job', `drafted: ${title} (jobs/${name}.md) — off until reviewed`, { jobId: spec.id, workspace: rt.meta.id })
  return { id: spec.id, title, file: `jobs/${name}.md`, warnings }
}

/** What draft_job hands back: where the draft is and how to turn it on. */
export function draftJobText(d: { id: string; title: string; file: string; warnings: string[] }, canTry = false): string {
  return [
    `ok: drafted the job “${d.title}” (${d.file}, id ${d.id}). It is saved OFF and will not run until the user reviews and enables it.`,
    `Review and enable: #/jobs/${d.id}`,
    ...d.warnings.map((w) => `note: ${w}`),
    canTry
      ? 'Tell the user it is drafted and off, and offer a trial run (try_job) so they see what it would file before turning it on — do not claim it is running.'
      : 'Tell the user it is drafted and waiting for their review — do not claim it is running.',
  ].join('\n')
}

/**
 * A chat's trial run of a job (MCP try_job): the dry run the job page offers,
 * on the job's file as it stands. The same prompt, tools and fences as a
 * real run, with nothing filed and nothing sent. It waits for the run, so the
 * chat can show the user what the job would have done before they turn it on.
 */
export async function tryJobOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const job = id ? await rt.store.jobs.get(id) : null
  if (!job) throw new Error(`no job "${id}" — pass the id draft_job returned`)
  if (job.configError) throw new Error(`the job is held: ${job.configError} — fix its file first`)
  if (!job.projectId) throw new Error('the job has no project — pick one first')
  const pv: JobPreview = { id: randomUUID(), status: 'running', events: [], startedAt: Date.now() }
  rt.previews.set(pv.id, pv)
  await runJobPreview(rt, pv, {
    instruction: job.instruction,
    tools: job.tools,
    projectId: job.projectId,
    model: job.model,
    output: job.output,
    schedule: scheduleOf(job),
    skills: job.skills,
    agents: job.agents,
    filing: job.filing,
  })
  if (pv.status !== 'ready' || !pv.result) throw new Error(pv.error ?? 'the trial run ended without a result')
  const res = pv.result
  const cost = [`${Math.round(res.tokens / 1000)}k tokens`, ...(res.costUsd != null ? [`$${res.costUsd.toFixed(2)}`] : [])].join(', ')
  const found =
    res.output === 'digest'
      ? res.digest
        ? [`It would write the digest “${res.digest.title}”:`, '', res.digest.body.slice(0, 4000)]
        : ['It wrote no digest.']
      : res.rows.length
        ? [`It would file ${res.rows.length} item(s):`, ...res.rows.map((x) => `- ${x.title} — ${x.url} (${[x.ask, x.reason, x.label, x.tier].filter(Boolean).join(', ')}) — ${x.why}`)]
        : ['It found nothing to file.']
  return [
    `ok: trial run of “${job.title}” finished (${cost}). Nothing was filed or sent.`,
    ...found,
    ...(res.wouldQueue?.length ? ['A real run would hold these for the user’s approval first:', ...res.wouldQueue.map((q) => `- ${q.tool}: ${q.summary}`)] : []),
    `The job is ${job.enabled ? 'on' : 'still OFF'}. Show the user what it found; if it looks right they turn it on at #/jobs/${job.id}, else change the job with them and draft it again.`,
  ].join('\n')
}

/**
 * Drop a job's row. Never hard-delete its items: this job's open and
 * snoozed ones are archived with a recorded reason (.docs/jobs-v2.md).
 */
export async function deleteJob(rt: WorkspaceRuntime, id: string, why: string): Promise<void> {
  let archived = 0
  for (const it of await rt.store.items.listAll()) {
    const fromJob = it.jobId === id || (it.foundBy ?? []).some((p) => p.jobId === id)
    if (fromJob && (it.status === 'open' || it.status === 'snoozed')) {
      await rt.store.items.transition(it.id, { status: 'archived', actor: 'system', detail: { reason: 'job deleted' } })
      archived += 1
    }
  }
  await rt.store.jobs.remove(id)
  invalidateInbox(rt)
  log('info', 'job', `deleted job ${id} (${why}); archived ${archived} item(s)`, { jobId: id, archived, workspace: rt.meta.id })
}
