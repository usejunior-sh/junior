/**
 * Onboarding as Junior's first message: the rows it offers (from firstRunOffers),
 * what each row's state reads, and applying the ticked ones through the
 * existing ops, injected as `api` so a test can drive it with fixtures.
 * Nothing applies until applyOffers runs. Pure and browser-safe.
 */
import type { FirstRunOffer } from './offers.js'
import { defaultToolsFor, leafOf, looksReadOnly, type ProbedTool } from '../job/tools.js'

/** One tickable row of the message: a project, a PR watch, or a source's job. */
export type OnboardRow =
  | { key: string; kind: 'project'; line: string; default: boolean; name: string; path: string; repo: string; why: string }
  | { key: string; kind: 'watch'; line: string; default: boolean; watch: 'babysit' | 'review' }
  | {
      key: string
      kind: 'job'
      line: string
      default: boolean
      server: string
      name: string
      /** a seeded job file to turn on, when the template is one ("slack") */
      library?: string
      title: string
      schedule: string
      instruction: string
    }

/** The offers, flattened to rows: one per suggested project, one per watch, one per job. */
export function onboardRows(offers: readonly FirstRunOffer[]): OnboardRow[] {
  const out: OnboardRow[] = []
  for (const o of offers) {
    if (o.kind === 'projects') {
      for (const p of o.projects) out.push({ key: `project:${p.path}`, kind: 'project', line: p.name, default: p.default, name: p.name, path: p.path, repo: p.repo, why: p.why })
    } else if (o.kind === 'watch') {
      out.push({ key: o.id, kind: 'watch', line: o.line, default: o.default, watch: o.watch })
    } else {
      out.push({
        key: o.id,
        kind: 'job',
        line: o.line,
        default: o.default,
        server: o.server,
        name: o.name,
        ...(o.template.library ? { library: o.template.library } : {}),
        title: o.template.title,
        schedule: o.template.schedule,
        instruction: o.template.instruction,
      })
    }
  }
  return out
}

/** The pre-ticked rows: each offer's suggested answer. */
export const defaultPicks = (rows: readonly OnboardRow[]): Set<string> => new Set(rows.filter((r) => r.default).map((r) => r.key))

export type RowState = 'idle' | 'running' | 'done' | 'fail'

/** What a row's state column says. */
export function rowVerb(row: Pick<OnboardRow, 'kind'> & { library?: string }, state: RowState): string {
  const kind = row.kind === 'job' && !row.library ? 'draft' : row.kind === 'project' ? 'add' : 'on'
  if (state === 'fail') return 'Didn’t work'
  const words = {
    add: { idle: 'Add', running: 'Adding…', done: 'Added' },
    on: { idle: 'Turn on', running: 'Turning on…', done: 'On' },
    draft: { idle: 'Draft, off', running: 'Drafting…', done: 'Drafted' },
  } as const
  return words[kind][state]
}

/** The ops applying runs, in the shape the HTTP API answers. Each throws with a line on failure. */
export type OnboardApi = {
  /** POST /api/projects; answers the new project's id */
  addProject(p: { name: string; path: string; repo: string; makeDefault: boolean }): Promise<{ id: string }>
  /** PUT /api/settings {babysitEnabled|reviewsEnabled: true} */
  turnOnWatch(watch: 'babysit' | 'review'): Promise<void>
  /** GET /api/jobs: read after projects are added, since adding one seeds the library's files */
  listJobs(): Promise<ReadonlyArray<{ id: string; file?: string }>>
  /** PUT /api/jobs?id= {enabled: true} */
  enableJob(id: string): Promise<void>
  /** POST /api/jobs/drafted: written to jobs/ and saved off */
  draftJob(d: { title: string; instruction: string; schedule: string; project: string; tools: string[] }): Promise<void>
  /** the tool lines (`<server>/<tool>`) a drafted job for this server may call */
  toolsFor(server: string): string[]
}

export type ApplyResult = {
  /** each applied row's outcome; a row not picked is absent */
  rows: Record<string, { state: 'done' | 'fail'; error?: string; drafted?: boolean }>
  /** the project jobs run in: the first project added (or the one passed in) */
  project: string | null
}

export const NEEDS_PROJECT = 'Needs a project'

const errLine = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Apply the picked rows, in order: projects (the first one becomes the
 * default), then the watches, then jobs, which need a project. A library job
 * is turned on in its seeded file; any other job is drafted, saved off. One
 * row failing never stops the rest. `project` is the project id from an
 * earlier pass, so Try again can rerun only the failed job rows.
 */
export async function applyOffers(
  rows: readonly OnboardRow[],
  picks: ReadonlySet<string>,
  api: OnboardApi,
  opts: { project?: string | null; onRow?: (key: string, state: RowState, error?: string) => void } = {},
): Promise<ApplyResult> {
  const out: ApplyResult = { rows: {}, project: opts.project ?? null }
  const picked = rows.filter((r) => picks.has(r.key))
  const mark = (key: string, state: 'done' | 'fail', error?: string, drafted?: boolean) => {
    out.rows[key] = { state, ...(error ? { error } : {}), ...(drafted ? { drafted } : {}) }
    opts.onRow?.(key, state, error)
  }
  const run = async (key: string, fn: () => Promise<void | 'drafted'>) => {
    opts.onRow?.(key, 'running')
    try {
      const how = await fn()
      mark(key, 'done', undefined, how === 'drafted')
    } catch (err) {
      mark(key, 'fail', errLine(err))
    }
  }

  for (const r of picked) {
    if (r.kind !== 'project') continue
    await run(r.key, async () => {
      const { id } = await api.addProject({ name: r.name, path: r.path, repo: r.repo, makeDefault: out.project === null })
      if (out.project === null) out.project = id
    })
  }
  for (const r of picked) {
    if (r.kind !== 'watch') continue
    await run(r.key, () => api.turnOnWatch(r.watch))
  }
  const jobs = picked.filter((r): r is Extract<OnboardRow, { kind: 'job' }> => r.kind === 'job')
  if (!jobs.length) return out
  if (out.project === null) {
    for (const r of jobs) mark(r.key, 'fail', NEEDS_PROJECT)
    return out
  }
  const project = out.project
  let files: ReadonlyArray<{ id: string; file?: string }> | null = null
  if (jobs.some((r) => r.library)) {
    try {
      files = await api.listJobs()
    } catch {
      files = [] // can't read the list: draft it instead
    }
  }
  for (const r of jobs) {
    await run(r.key, async () => {
      const seeded = r.library ? files?.find((j) => j.file === r.library) : undefined
      if (seeded) return api.enableJob(seeded.id)
      const tools = api.toolsFor(r.server)
      if (!tools.length) throw new Error(`I can't find read-only tools on ${r.name}. Set it up from Jobs.`)
      await api.draftJob({ title: r.title, instruction: r.instruction, schedule: r.schedule, project, tools })
      return 'drafted' as const
    })
  }
  return out
}

/**
 * The tool lines a drafted job for one server may call: its preset or the
 * tools it marks read-only, else the ones whose names read as reads.
 */
export function jobToolLines(server: string, tools: readonly ProbedTool[]): string[] {
  let full = defaultToolsFor(server, [...tools])
  if (!full.length) full = tools.filter((t) => t.destructive !== true && looksReadOnly(t.name)).map((t) => t.fullName)
  return full.map((t) => `${server}/${leafOf(t)}`)
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Junior's one reply once applying ends: what got set up, then what didn't. */
export function replyLine(rows: readonly OnboardRow[], result: ApplyResult): string {
  const done = (r: OnboardRow) => result.rows[r.key]?.state === 'done'
  const failed = rows.filter((r) => result.rows[r.key]?.state === 'fail').length
  const parts: string[] = []
  const projects = rows.filter((r) => r.kind === 'project' && done(r)).length
  if (projects) parts.push(`Added ${plural(projects, 'project', 'projects')}.`)
  if (rows.some((r) => r.kind === 'watch' && r.watch === 'babysit' && done(r))) parts.push('Babysitting is on.')
  if (rows.some((r) => r.kind === 'watch' && r.watch === 'review' && done(r))) parts.push('Reviews are on.')
  const jobs = rows.filter((r): r is Extract<OnboardRow, { kind: 'job' }> => r.kind === 'job' && done(r))
  for (const r of jobs) if (!result.rows[r.key]?.drafted) parts.push(`The ${r.title} job is on.`)
  const drafted = jobs.filter((r) => result.rows[r.key]?.drafted).length
  if (drafted) parts.push(`Drafted ${plural(drafted, 'job', 'jobs')}. ${drafted === 1 ? 'It stays' : 'They stay'} off until you try a run.`)
  if (failed) return [`${failed} didn’t work. The rest is set up.`, ...parts].join(' ')
  return ['Done.', ...parts].join(' ')
}
