/**
 * Jobs as files: one markdown file per job in the workspace folder, like
 * agents and teams.
 *
 *   <workspace>/jobs/<slug>.md       frontmatter = what the code enforces,
 *                                    body = the instruction
 *   <workspace>/jobs/.seeded.json    what triage wrote, so edits are never clobbered
 *
 * The schema is strict: an unknown key is an error, never ignored, so a typo
 * can't silently drop a limit. A file that doesn't validate never crashes
 * anything. Its job is held with a visible config error. The `id` is the
 * job's stable identity: SQLite keeps only state (the slot ledger, the
 * failure streak, config errors) on a row with that id.
 *
 * Tools are one entry per grant line: a built-in (`web`, `github`,
 * `files-write`) or `<server>/<tool>` for an MCP tool, the server as Claude
 * Code names it ("claude.ai Slack/slack_search_public").
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isValidCron } from '../core/job/cron.js'
import { isCatchUpSpec, parseDuration } from '../core/job/schedule.js'
import {
  BUILTIN_TOOLS,
  RESERVED_SERVER,
  builtinGrant,
  grantKey,
  leafOf,
  mcpToolName,
  serverLabel,
  type BuiltinToolId,
  type ConnectorScope,
  type JobToolGrant,
} from '../core/job/tools.js'
import { JOB_NOTIFY, type JobBrief, type JobNotify, type JobOutput } from '../core/job/types.js'
import type { LibrarySource } from '../shared/protocol.js'
import { parseFrontmatter, serializeFrontmatter, type FrontmatterValue } from './artifacts.js'
import { WORKSPACE_PLUGIN } from './library.js'
import { defaultPlaybook } from './briefs.js'
import { slugify } from './teams.js'

/** Everything a job file says. */
export type JobFileSpec = {
  id: string
  title: string
  schedule: string
  /** project id; '' = none picked yet */
  project: string
  tools: JobToolGrant[]
  model?: string
  output: JobOutput
  catchUp?: string
  timeoutMs?: number
  budgetUsd?: number
  dailyBudgetUsd?: number
  notify: JobNotify
  enabled: boolean
  /** brief every item this job files (`brief: true`, `brief_model`, `brief_template`) */
  brief?: JobBrief
  /** drafted by a chat, not yet reviewed, stays off until you enable it */
  draft?: boolean
  /** skills a run may load, as Claude calls them (`triage:<name>` for the workspace library's) */
  skills?: string[]
  /** subagents a run may hand work to, named the same way */
  agents?: string[]
  instruction: string
}

export const JOB_FILE_KEYS = [
  'id', 'title', 'schedule', 'project', 'tools', 'skills', 'agents', 'model', 'output', 'catch_up',
  'timeout', 'budget_usd', 'daily_budget_usd', 'notify', 'enabled',
  'brief', 'brief_model', 'brief_template', 'draft',
] as const

/** A skill or agent name as Claude calls it: `name`, or `namespace:name` for a plugin's (the workspace library is `triage:`). */
const LIBRARY_NAME_RE = /^[A-Za-z0-9][\w.-]*(?::[A-Za-z0-9][\w.-]*)?$/

/** A playbook name, as briefs read them (server/briefs.ts isPlaybookName). */
const PLAYBOOK_RE = /^[a-z][a-z0-9-]{0,40}$/

const KEYS = new Set<string>(JOB_FILE_KEYS)
const BUILTINS = Object.keys(BUILTIN_TOOLS) as BuiltinToolId[]
const OUTPUTS: JobOutput[] = ['items', 'digest']
const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 3_600_000

export type ParsedJobFile = {
  /** best effort, defaults filled in, usable even when `errors` is not empty */
  spec: JobFileSpec
  errors: string[]
  /** false when the file carries no id (a fresh id was minted into `spec.id`) */
  hadId: boolean
}

const titleCase = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
const str = (v: FrontmatterValue | undefined): string => (typeof v === 'string' ? v.trim() : '')

/** Dollars from a string, or an error. */
function dollars(key: string, v: string, max: number, errors: string[]): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    errors.push(`${key} must be dollars from 0.01 to ${max}`)
    return undefined
  }
  return n
}

/** Tool lines → grants: built-ins by id, MCP tools grouped by server. */
export function grantsFromLines(lines: string[], errors: string[]): JobToolGrant[] {
  const out: JobToolGrant[] = []
  const mcp = new Map<string, Set<string>>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (BUILTINS.includes(line as BuiltinToolId)) {
      if (!out.some((g) => grantKey(g.source) === `builtin:${line}`)) out.push(builtinGrant(line as BuiltinToolId))
      continue
    }
    const slash = line.lastIndexOf('/')
    if (slash <= 0 || slash === line.length - 1) {
      errors.push(`tools: "${line}" is neither a built-in (${BUILTINS.join(', ')}) nor <server>/<tool>`)
      continue
    }
    const server = line.slice(0, slash).trim()
    if (server === RESERVED_SERVER) {
      errors.push(`tools: "${RESERVED_SERVER}" is the run's own server; its write tool comes with every job`)
      continue
    }
    if (!mcp.has(server)) mcp.set(server, new Set())
    mcp.get(server)!.add(mcpToolName(server, line.slice(slash + 1).trim()))
  }
  for (const [server, tools] of mcp) out.push({ source: { kind: 'mcp', server, scope: 'unknown' }, tools: [...tools] })
  return out
}

/** Grants → tool lines, the inverse of grantsFromLines. */
export function linesFromGrants(grants: JobToolGrant[]): string[] {
  return grants.flatMap((g) => (g.source.kind === 'builtin' ? [g.source.id] : g.tools.map((t) => `${(g.source as { server: string }).server}/${leafOf(t)}`)))
}

/** A job file → its spec, plus every reason it can't run as written. Pure. */
export function parseJobFile(name: string, text: string): ParsedJobFile {
  const fm = parseFrontmatter(text)
  const errors: string[] = []
  if (!fm.present) errors.push('no frontmatter — the file must start with a --- block')
  else if (!fm.ok) errors.push('frontmatter has a line that is not "key: value"')
  const d = fm.data
  for (const k of Object.keys(d)) if (!KEYS.has(k)) errors.push(`unknown key "${k}" — allowed: ${JOB_FILE_KEYS.join(', ')}`)

  const id = str(d.id)
  const schedule = str(d.schedule)
  if (!schedule) errors.push('schedule is required (a cron line, e.g. "0 9 * * 1-5")')
  else if (!isValidCron(schedule)) errors.push(`schedule "${schedule}" is not a valid cron line`)

  const toolLines = Array.isArray(d.tools) ? d.tools : str(d.tools) ? [str(d.tools)] : []
  const tools = grantsFromLines(toolLines, errors)
  if (!tools.length) errors.push('tools must list at least one integration')

  const names = (key: 'skills' | 'agents'): string[] => {
    const raw = d[key]
    const list = Array.isArray(raw) ? raw.map((x) => x.trim()) : str(raw) ? [str(raw)] : []
    const out: string[] = []
    for (const n of list) {
      if (!n) continue
      if (!LIBRARY_NAME_RE.test(n)) errors.push(`${key}: "${n}" is not a name — write it as Claude calls it, e.g. triage:pr-review`)
      else if (!out.includes(n)) out.push(n)
    }
    return out
  }
  const skills = names('skills')
  const agents = names('agents')

  const output = (str(d.output) || 'items') as JobOutput
  if (!OUTPUTS.includes(output)) errors.push(`output must be one of: ${OUTPUTS.join(', ')}`)

  const catchUp = str(d.catch_up)
  if (catchUp && !isCatchUpSpec(catchUp)) errors.push('catch_up must be "never", "unlimited", or a duration like "6h"')

  const timeout = str(d.timeout)
  const timeoutMs = timeout ? parseDuration(timeout) : null
  if (timeout && (timeoutMs == null || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)) {
    errors.push('timeout must be minutes from 1m to 60m (or 1h)')
  }

  const budgetUsd = dollars('budget_usd', str(d.budget_usd), 100, errors)
  const dailyBudgetUsd = dollars('daily_budget_usd', str(d.daily_budget_usd), 1000, errors)

  const notify = (str(d.notify) || 'on_failure') as JobNotify
  if (!JOB_NOTIFY.includes(notify)) errors.push(`notify must be one of: ${JOB_NOTIFY.join(', ')}`)

  const enabledRaw = str(d.enabled) || 'true'
  if (enabledRaw !== 'true' && enabledRaw !== 'false') errors.push('enabled must be true or false')

  const instruction = fm.body.trim()
  if (!instruction) errors.push('the instruction (the body under the frontmatter) is empty')

  const briefRaw = str(d.brief) || 'false'
  if (briefRaw !== 'true' && briefRaw !== 'false') errors.push('brief must be true or false')
  const briefModel = str(d.brief_model)
  const briefTemplate = str(d.brief_template)
  if (briefRaw !== 'true' && (briefModel || briefTemplate)) errors.push('brief_model and brief_template need brief: true')
  if (briefTemplate && !PLAYBOOK_RE.test(briefTemplate)) errors.push(`brief_template "${briefTemplate}" is not a playbook name (a file in playbooks/, without .md)`)
  if (briefRaw === 'true' && output === 'digest') errors.push('brief works with output: items — a digest files no items to brief')
  const brief: JobBrief | undefined =
    briefRaw === 'true'
      ? { ...(briefModel ? { model: briefModel } : {}), ...(briefTemplate && PLAYBOOK_RE.test(briefTemplate) ? { template: briefTemplate } : {}) }
      : undefined

  const draftRaw = str(d.draft) || 'false'
  if (draftRaw !== 'true' && draftRaw !== 'false') errors.push('draft must be true or false')

  const spec: JobFileSpec = {
    id: id || randomUUID(),
    title: str(d.title) || titleCase(name),
    schedule: schedule || '0 9 * * *',
    project: str(d.project),
    tools,
    ...(skills.length ? { skills } : {}),
    ...(agents.length ? { agents } : {}),
    ...(str(d.model) ? { model: str(d.model) } : {}),
    output: OUTPUTS.includes(output) ? output : 'items',
    ...(catchUp && isCatchUpSpec(catchUp) ? { catchUp } : {}),
    ...(timeoutMs != null && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS ? { timeoutMs } : {}),
    ...(budgetUsd != null ? { budgetUsd } : {}),
    ...(dailyBudgetUsd != null ? { dailyBudgetUsd } : {}),
    notify: JOB_NOTIFY.includes(notify) ? notify : 'on_failure',
    enabled: enabledRaw !== 'false',
    ...(brief ? { brief } : {}),
    ...(draftRaw === 'true' ? { draft: true } : {}),
    instruction,
  }
  return { spec, errors, hadId: Boolean(id) }
}

const fmtTimeout = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`)

/** A spec → the file's text. Optional keys are written only when set. */
export function serializeJobFile(s: JobFileSpec): string {
  const data: Record<string, FrontmatterValue> = {
    id: s.id,
    title: s.title,
    schedule: s.schedule,
    project: s.project,
    tools: linesFromGrants(s.tools),
  }
  if (s.skills?.length) data.skills = s.skills
  if (s.agents?.length) data.agents = s.agents
  if (s.model) data.model = s.model
  data.output = s.output
  if (s.catchUp) data.catch_up = s.catchUp
  if (s.timeoutMs != null) data.timeout = fmtTimeout(s.timeoutMs)
  if (s.budgetUsd != null) data.budget_usd = String(s.budgetUsd)
  if (s.dailyBudgetUsd != null) data.daily_budget_usd = String(s.dailyBudgetUsd)
  data.notify = s.notify
  data.enabled = String(s.enabled)
  if (s.brief) {
    data.brief = 'true'
    if (s.brief.model) data.brief_model = s.brief.model
    if (s.brief.template) data.brief_template = s.brief.template
  }
  if (s.draft) data.draft = 'true'
  return serializeFrontmatter(data, `\n${s.instruction.trim()}\n`)
}

/**
 * Check a spec's MCP grants against what the connector probes found: every
 * server must be known and every tool one it offers. Fills in each grant's
 * scope from the probe. No probe yet → benefit of the doubt (the run fails
 * loudly if a tool truly isn't there). Pure.
 */
export function checkGrants(
  tools: JobToolGrant[],
  connectors: { server: string; scope: ConnectorScope; tools: { fullName: string }[] }[] | null,
): { tools: JobToolGrant[]; errors: string[] } {
  if (!connectors) return { tools, errors: [] }
  const errors: string[] = []
  const out = tools.map((g) => {
    if (g.source.kind !== 'mcp') return g
    const server = g.source.server
    const found = connectors.find((c) => c.server === server)
    if (!found) {
      errors.push(`tools: no connected server named "${server}"`)
      return g
    }
    // a server that isn't connected right now lists no tools; jobReady holds the run instead
    if (found.tools.length) {
      const offered = new Set(found.tools.map((t) => t.fullName))
      for (const t of g.tools) if (!offered.has(t)) errors.push(`tools: ${serverLabel(server)} has no tool "${leafOf(t)}"`)
    }
    return { ...g, source: { ...g.source, scope: found.scope } }
  })
  return { tools: out, errors }
}

/** The skills and agents a job run could load, by the name Claude calls each, with where it lives. */
export type JobLibrary = {
  skills: Map<string, LibrarySource>
  agents: Map<string, LibrarySource>
}

/**
 * Check a spec's `skills:` and `agents:` against what is on this machine.
 * A job run loads the workspace library, your personal ones and your
 * plugins', never a project's `.claude` folder, which would bring the
 * project's settings and hooks with it. Pure.
 */
export function checkLibrary(spec: Pick<JobFileSpec, 'skills' | 'agents'>, lib: JobLibrary): string[] {
  const errors: string[] = []
  for (const [key, kind, have] of [['skills', 'skill', lib.skills], ['agents', 'agent', lib.agents]] as const) {
    for (const name of spec[key] ?? []) {
      const source = have.get(name)
      if (!source) {
        const hint = have.has(`${WORKSPACE_PLUGIN}:${name}`) ? ` — the workspace library's is called ${WORKSPACE_PLUGIN}:${name}` : ''
        errors.push(`${key}: no ${kind} named "${name}"${hint}`)
      } else if (source === 'project') {
        errors.push(`${key}: "${name}" lives in a project's .claude folder, which job runs don't load — move it to the workspace library or your personal one`)
      }
    }
  }
  return errors
}

/**
 * Set one frontmatter key in a file's text, touching no other line: replace
 * the key's line if there is one, else add it first or last in the block. A
 * text with no frontmatter gets one. Pure.
 */
export function withKey(text: string, key: string, value: string, where: 'first' | 'last'): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return ['---', `${key}: ${value}`, '---', text].join(nl)
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  const re = new RegExp(`^${key}\\s*:`)
  const at = lines.findIndex((l, i) => i > 0 && (end === -1 || i < end) && re.test(l))
  if (at !== -1) lines[at] = `${key}: ${value}`
  else lines.splice(where === 'first' || end === -1 ? 1 : end, 0, `${key}: ${value}`)
  return lines.join(nl)
}

/** Drop one frontmatter key's line, touching no other. Pure. */
export function withoutKey(text: string, key: string): string {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return text
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  const re = new RegExp(`^${key}\\s*:`)
  const at = lines.findIndex((l, i) => i > 0 && (end === -1 || i < end) && re.test(l))
  if (at === -1) return text
  lines.splice(at, 1)
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n')
}

/**
 * The text a new job starts from in the editor: every key, the optional
 * ones commented out, with the user's own projects to pick from. Pure.
 */
export function starterJobFile(projects: { id: string; name: string }[]): string {
  const first = projects[0]
  return [
    '---',
    'title: New job',
    '# cron, local time: minute hour day-of-month month weekday',
    'schedule: 0 9 * * 1-5',
    '# the project folder the run works in — its id, from the list on the right',
    `project: ${first ? first.id : ''}`,
    '# built-ins: web, github, files-write · an MCP tool: <server>/<tool>',
    'tools: [web]',
    '# skills and agents the run may use, as Claude calls them (Settings → Skills, Agents):',
    '# skills: [triage:pr-review]',
    '# agents: [triage:code-reviewer]',
    '# items (one work item per match) or digest (one report per run)',
    'output: items',
    '# never, on_failure or always — a macOS notification',
    'notify: on_failure',
    'enabled: true',
    '# optional:',
    '# model: sonnet',
    '# catch_up: 6h            (never, unlimited, or a duration like 30m, 6h, 2d)',
    '# timeout: 4m',
    '# budget_usd: 2           (per run)',
    '# daily_budget_usd: 5     (across a day of runs)',
    '# brief: true             (brief every item it files — output: items only)',
    '# brief_model: sonnet     (the brief runs\' model; default = Settings → Briefs)',
    '# brief_template: job-hit (a playbook in playbooks/; default = the item\'s kind)',
    '---',
    '',
    'What to look for, where, and what counts as a match.',
    '',
  ].join('\n')
}

/**
 * Jobs were called watches before v1.1: a workspace from then keeps its job
 * files in `watches/`, and the playbook and dispatch template for job hits as
 * `watch-hit.md`. Move them to the new names, once, before anything seeds the
 * new ones. A destination that exists wins and the old one stays put. A
 * playbook still saying exactly the old default becomes the new default, so
 * it doesn't read as edited.
 */
export function renameLegacyFolders(root: string): void {
  const move = (from: string, to: string) => {
    const src = path.join(root, from)
    const dst = path.join(root, to)
    if (!existsSync(src) || existsSync(dst)) return false
    renameSync(src, dst)
    return true
  }
  move('watches', 'jobs')
  move(path.join('dispatch', 'watch-hit.md'), path.join('dispatch', 'job-hit.md'))
  if (move(path.join('playbooks', 'watch-hit.md'), path.join('playbooks', 'job-hit.md'))) {
    const file = path.join(root, 'playbooks', 'job-hit.md')
    const text = readFileSync(file, 'utf8')
    const renamed = text.replace(/watch(es)?/gi, (m, es) => {
      const to = es ? 'jobs' : 'job'
      return m === m.toUpperCase() ? to.toUpperCase() : m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to
    })
    if (renamed === defaultPlaybook('job-hit')) writeFileSync(file, renamed, 'utf8')
  }
}

/** What triage wrote, per file, the difference between "untouched" and "yours". */
type Manifest = { version: 1; files: Record<string, { hash: string | null; removed?: boolean }> }

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export type JobFile = { name: string; path: string; mtimeMs: number; text: string }

export class JobFiles {
  readonly dir: string
  private readonly manifestPath: string

  constructor(root: string) {
    this.dir = path.join(root, 'jobs')
    this.manifestPath = path.join(this.dir, '.seeded.json')
  }

  /** Every `<slug>.md` in the folder, read whole (they are small). */
  async scan(): Promise<JobFile[]> {
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const out: JobFile[] = []
    for (const f of names.sort()) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue
      const file = path.join(this.dir, f)
      try {
        const st = await stat(file)
        if (!st.isFile()) continue
        out.push({ name: f.slice(0, -3), path: file, mtimeMs: st.mtimeMs, text: await readFile(file, 'utf8') })
      } catch {}
    }
    return out
  }

  pathOf(name: string): string {
    return path.join(this.dir, `${name}.md`)
  }

  async write(name: string, spec: JobFileSpec): Promise<void> {
    await atomicWrite(this.pathOf(name), serializeJobFile(spec))
  }

  /**
   * Put `id: <id>` into a file's frontmatter, replacing any id it has, and
   * touching nothing else. The file stays the user's.
   */
  async stampId(name: string, id: string): Promise<void> {
    const file = this.pathOf(name)
    await atomicWrite(file, withKey(await readFile(file, 'utf8'), 'id', id, 'first'))
  }

  /**
   * Turn a job on or off by its `enabled:` line alone, comments and layout
   * stay. Turning a drafted job on is the review: its `draft:` line goes.
   */
  async setEnabled(name: string, on: boolean): Promise<void> {
    const file = this.pathOf(name)
    let text = withKey(await readFile(file, 'utf8'), 'enabled', String(on), 'last')
    if (on) text = withoutKey(text, 'draft')
    await atomicWrite(file, text)
  }

  /** Write a file exactly as given (the editor's text, already validated). */
  async writeText(name: string, text: string): Promise<void> {
    await atomicWrite(this.pathOf(name), text.endsWith('\n') ? text : `${text}\n`)
  }

  async remove(name: string): Promise<void> {
    await rm(this.pathOf(name), { force: true })
    const m = await this.manifest()
    const rel = `${name}.md`
    if (m.files[rel]?.hash) {
      m.files[rel].removed = true
      await this.saveManifest(m)
    }
  }

  /** A file name for a new job: the title's slug, suffixed until nothing holds it. */
  freeName(title: string): string {
    const base = slugify(title) || 'job'
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base.slice(0, 44)}-${n}`
      if (!existsSync(this.pathOf(name))) return name
    }
  }

  private async manifest(): Promise<Manifest> {
    try {
      const m = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest
      if (m && m.version === 1 && m.files) return m
    } catch {}
    return { version: 1, files: {} }
  }

  private async saveManifest(m: Manifest): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8')
  }

  /**
   * Bring the shipped templates in, as the teams library does: one not yet
   * seen is written; one the user never touched follows a newer shipped
   * version; an edited one is left alone; a deleted one stays deleted; a
   * user's own file of the same name wins.
   */
  async seed(templates: Record<string, JobFileSpec>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const m = await this.manifest()
    let changed = false
    for (const [name, spec] of Object.entries(templates)) {
      const rel = `${name}.md`
      const file = this.pathOf(name)
      const content = serializeJobFile(spec)
      const entry = m.files[rel]
      const exists = existsSync(file)
      if (!entry) {
        if (exists) m.files[rel] = { hash: null }
        else {
          await atomicWrite(file, content)
          m.files[rel] = { hash: hash(content) }
        }
        changed = true
        continue
      }
      if (entry.hash === null || entry.removed) continue
      if (!exists) {
        entry.removed = true
        changed = true
        continue
      }
      const cur = hash(await readFile(file, 'utf8'))
      if (cur === entry.hash && cur !== hash(content)) {
        await atomicWrite(file, content)
        entry.hash = hash(content)
        changed = true
      }
    }
    if (changed) await this.saveManifest(m)
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}
