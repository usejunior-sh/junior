/**
 * Which of a failing CI job's steps Junior may run on the user's Mac before
 * it pushes a fix (plan item `ci-local-steps`, pillar P3). A blind push burns
 * a CI cycle; running the job's checks first doesn't. But a workflow's `run:`
 * steps are arbitrary shell, so only steps that are plainly checks run:
 *
 *   - `npm|pnpm|yarn [run] <script>` for a package.json script named test,
 *     lint, typecheck, build, check or format:check, or prefixed with one
 *     (`test:unit`), with plain arguments only; or
 *   - a command the repo itself lists as a check (`checks:` in
 *     `.junior/junior.md`, passed in by the caller once the repo contract
 *     is read).
 *
 * Everything else is listed as "skipped, not a check" with the reason: any
 * `uses:` action, `make`, `docker`, `aws`, `gh`, release tools, a step that
 * names `secrets.`, shell operators, CI expressions Junior can't fill in.
 *
 * The job is found by the failing check's name, the way GitHub names a check
 * run: the job's `name:` (or its id), matrix values filled in, or appended in
 * parentheses when the name doesn't use them.
 *
 * Pure: the workflow files' text and a package.json lookup come in, no I/O.
 */
import { parse } from 'yaml'

/** The script names that count as checks; `test:unit` counts too (prefix + ':'). */
export const CHECK_SCRIPTS = ['test', 'lint', 'typecheck', 'build', 'check', 'format:check'] as const

/** A workflow file as read off disk: its path from the repo root, and its text. */
export type WorkflowFile = { path: string; text: string }

/** One step of the matched job, sorted. */
export type CiStep = {
  /** the step's `name:`, else its command or action, as CI shows it */
  label: string
  /** the shell it runs, matrix values filled in; absent for an action */
  command?: string
  /** the action it uses, for `uses:` steps */
  uses?: string
  /** where the command runs, from the repo root; '' for the root */
  cwd: string
  runnable: boolean
  /**
   * Installs the job's dependencies (`npm ci`, `pnpm install`, …): not a
   * check, so not runnable, but the checks need it in a fresh worktree.
   */
  setup?: true
  /** why a skipped step was skipped, in a few plain words */
  why?: string
}

/** The job behind a failing check, and its steps sorted into runnable and skipped. */
export type CiJob = {
  file: string
  jobId: string
  /** the check's name as GitHub shows it */
  name: string
  /** the matrix combination this check ran with, when Junior could read it */
  matrix?: Record<string, string>
  steps: CiStep[]
}

export type LocalChecks = { job: CiJob } | { job: null; why: string }

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v)
const scalar = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null)
const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g

/** A workflow's text → its jobs map; null when it doesn't parse or has none. */
export function workflowJobs(text: string): { name: string | null; jobs: Record<string, J> } | null {
  let doc: unknown
  try {
    doc = parse(text)
  } catch {
    return null
  }
  if (!isObj(doc) || !isObj(doc.jobs)) return null
  const jobs: Record<string, J> = {}
  for (const [id, j] of Object.entries(doc.jobs)) if (isObj(j)) jobs[id] = j
  return { name: scalar(doc.name), jobs }
}

/**
 * A job's matrix combinations, when the matrix is written out (not built by
 * an expression): the product of its keys, minus `exclude`, plus `include`.
 * null when it can't be read; [] only for no matrix at all.
 */
export function matrixCombos(job: J): Record<string, string>[] | null {
  const m = job.strategy?.matrix
  if (m === undefined || m === null) return []
  if (!isObj(m)) return null
  const keys = Object.keys(m).filter((k) => k !== 'include' && k !== 'exclude')
  let combos: Record<string, string>[] = keys.length ? [{}] : []
  for (const k of keys) {
    const vals = m[k]
    if (!Array.isArray(vals)) return null
    const strs = vals.map(scalar)
    if (strs.some((s) => s === null)) return null
    combos = combos.flatMap((c) => (strs as string[]).map((v) => ({ ...c, [k]: v })))
  }
  const fits = (c: Record<string, string>, e: J) => Object.entries(e).every(([k, v]) => c[k] === scalar(v))
  if (m.exclude !== undefined) {
    if (!Array.isArray(m.exclude)) return null
    combos = combos.filter((c) => !m.exclude.some((e: unknown) => isObj(e) && fits(c, e)))
  }
  if (m.include !== undefined) {
    if (!Array.isArray(m.include)) return null
    for (const inc of m.include) {
      if (!isObj(inc)) return null
      const add: Record<string, string> = {}
      for (const [k, v] of Object.entries(inc)) {
        const s = scalar(v)
        if (s === null) return null
        add[k] = s
      }
      // An include extends every combo its original keys agree with; one that fits none is a combo of its own.
      const own = Object.entries(add).filter(([k]) => keys.includes(k))
      const hit = combos.filter((c) => own.every(([k, v]) => c[k] === v))
      if (hit.length && keys.length) for (const c of hit) Object.assign(c, add)
      else combos.push(add)
    }
  }
  return combos
}

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `${{ matrix.node }}` → the combo's value; null when the expression is anything else. */
function fillMatrix(s: string, combo: Record<string, string> | undefined): string | null {
  let ok = true
  const out = s.replace(EXPR, (_, e: string) => {
    const k = /^matrix\.([\w-]+)$/.exec(e)?.[1]
    const v = k && combo ? combo[k] : undefined
    if (v === undefined) ok = false
    return v ?? ''
  })
  return ok ? out : null
}

/** The check name GitHub gives one combo of a job. */
function checkNameOf(jobId: string, job: J, combo: Record<string, string>): string {
  const raw = scalar(job.name) ?? jobId
  const usesMatrix = /\$\{\{\s*matrix\./.test(raw)
  const filled = raw.replace(EXPR, (_, e: string) => {
    const k = /^matrix\.([\w-]+)$/.exec(e)?.[1]
    return k && combo[k] !== undefined ? combo[k]! : `\${{ ${e} }}`
  })
  const vals = Object.values(combo)
  return usesMatrix || vals.length === 0 ? filled : `${filled} (${vals.join(', ')})`
}

/** The same, as a pattern, for a matrix Junior can't spell out: every expression matches anything. */
function checkPatternOf(jobId: string, job: J): RegExp {
  const raw = scalar(job.name) ?? jobId
  const body = raw
    .split(EXPR)
    .map((part, i) => (i % 2 ? '.+?' : regexEscape(part)))
    .join('')
  const hasMatrix = job.strategy?.matrix !== undefined
  return new RegExp(`^${body}${hasMatrix && !/\$\{\{\s*matrix\./.test(raw) ? ' \\(.+\\)' : ''}$`)
}

/**
 * The job behind a failing check, across the repo's workflow files. A name
 * written "<workflow> / <job>" is tried as the job part too. An exact name
 * wins over a pattern; the first file in path order wins a tie.
 */
export function findCiJob(files: WorkflowFile[], check: string): { file: string; jobId: string; job: J; combo?: Record<string, string>; name: string } | { why: string } {
  const wanted = [check.trim()]
  const slash = check.lastIndexOf(' / ')
  if (slash > 0) wanted.push(check.slice(slash + 3).trim())
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const parsed = sorted.map((f) => ({ f, wf: workflowJobs(f.text) }))
  if (!parsed.some((p) => p.wf)) return { why: files.length ? 'no workflow file could be read' : 'the repo has no workflow files' }
  for (const name of wanted)
    for (const { f, wf } of parsed) {
      if (!wf) continue
      for (const [jobId, job] of Object.entries(wf.jobs)) {
        const combos = matrixCombos(job)
        for (const combo of combos ?? []) if (checkNameOf(jobId, job, combo) === name) return { file: f.path, jobId, job, combo, name }
        if (combos && combos.length === 0 && checkNameOf(jobId, job, {}) === name) return { file: f.path, jobId, job, name }
      }
    }
  for (const name of wanted)
    for (const { f, wf } of parsed) {
      if (!wf) continue
      for (const [jobId, job] of Object.entries(wf.jobs)) if (checkPatternOf(jobId, job).test(name)) return { file: f.path, jobId, job, name }
    }
  return { why: `no job in .github/workflows is named "${check}"` }
}

/** Shell that turns one command into more than a command. `&&` between checks is split first. */
const SHELL_OPS = /[;|&<>`$(){}\\*?!#~]|^\s*\w+=/

/** Plain arguments only: flags, paths, values. */
const PLAIN_ARG = /^[\w@%+=:,./-]+$/

/** The package.json script one command runs, or why it isn't a check. */
function checkScript(cmd: string, scripts: readonly string[] | null): { script: string } | { why: string } {
  const words = cmd.trim().split(/\s+/)
  const pm = words[0] ?? ''
  if (pm !== 'npm' && pm !== 'pnpm' && pm !== 'yarn') return { why: `runs ${pm || 'nothing'}, not a check script` }
  let rest = words.slice(1)
  let script: string | undefined
  if (rest[0] === 'run' || rest[0] === 'run-script') {
    script = rest[1]
    rest = rest.slice(2)
  } else if (pm === 'npm' && (rest[0] === 'test' || rest[0] === 't')) {
    script = 'test'
    rest = rest.slice(1)
  } else if (pm !== 'npm' && rest[0] && !rest[0].startsWith('-')) {
    script = rest[0]
    rest = rest.slice(1)
  }
  if (!script) return { why: `${`${pm} ${words[1] ?? ''}`.trim()} is not a check script` }
  const s = script
  const isCheck = CHECK_SCRIPTS.some((n) => s === n || s.startsWith(`${n}:`))
  if (!isCheck) return { why: `"${s}" is not a check script` }
  if (scripts === null) return { why: 'no package.json where it runs' }
  if (!scripts.includes(s)) return { why: `package.json has no "${s}" script` }
  if (!rest.every((a) => PLAIN_ARG.test(a))) return { why: 'has arguments beyond plain flags' }
  return { script: s }
}

/** `npm ci`, `npm install`, `pnpm i`, `yarn install`, bare `yarn`: flags only, no package names (that would add one). */
export function isInstall(cmd: string): boolean {
  const [pm, sub, ...rest] = cmd.trim().split(/\s+/)
  const flagsOnly = (a: string[]) => a.every((x) => /^--?[\w-]+(=[\w.@/-]+)?$/.test(x))
  if (pm === 'npm') return (sub === 'ci' || sub === 'install' || sub === 'i') && flagsOnly(rest)
  if (pm === 'pnpm') return (sub === 'install' || sub === 'i') && flagsOnly(rest)
  if (pm === 'yarn') return sub === undefined || ((sub === 'install' || sub.startsWith('-')) && flagsOnly(sub === 'install' ? rest : [sub, ...rest]))
  return false
}

const squash = (s: string) => s.trim().replace(/\s+/g, ' ')

/** A `run:` text's lines, comments and blank lines dropped, each squashed. */
const lines = (run: string) =>
  run
    .split('\n')
    .map(squash)
    .filter((l) => l && !l.startsWith('#'))

/** A working-directory from the repo root: `./web/` → `web`, `.` → ''. */
const repoDir = (d: string) => d.trim().replace(/^(\.\/)+/, '').replace(/^\.$/, '').replace(/\/+$/, '')
const outside = (d: string) => d.startsWith('/') || d.split('/').includes('..')

/** One `run:` text → its commands, or null when it uses shell beyond `cmd && cmd` and one command a line. */
function commandsOf(run: string): string[] | null {
  const cmds = lines(run).flatMap((l) => l.split('&&').map((c) => c.trim()))
  if (cmds.some((c) => !c)) return null
  return cmds
}

/**
 * Sort one step. `declared` is the repo's own list of check commands (from
 * `.junior/junior.md`); a step whose whole command is on it runs as written,
 * unless it names a secret.
 */
export function sortStep(step: J, opts: { combo?: Record<string, string>; jobDir?: string; scriptsIn: (dir: string) => readonly string[] | null; declared?: readonly string[] }): CiStep {
  const name = scalar(step.name)
  const uses = scalar(step.uses)
  const cwd = repoDir(scalar(step['working-directory']) ?? opts.jobDir ?? '')
  if (uses) return { label: name ?? uses, uses, cwd, runnable: false, why: 'an action, not a command' }
  const raw = scalar(step.run)
  if (raw === null) return { label: name ?? 'a step with nothing to run', cwd, runnable: false, why: 'nothing to run' }
  const label = name ?? squash(raw.split('\n')[0] ?? raw)
  const skip = (why: string, command = squash(raw)): CiStep => ({ label, command, cwd, runnable: false, why })
  // A secret anywhere in the step (its command, env or with) means it reaches something outside the Mac.
  if (/\bsecrets\./.test(JSON.stringify(step))) return skip('names a secret')
  if (/\$\{\{/.test(cwd)) return skip('runs in a folder set by a CI expression')
  if (outside(cwd)) return skip('runs outside the repo')
  const filled = fillMatrix(raw, opts.combo)
  if (filled === null) return skip('uses a CI expression Junior can fill in only on CI')
  const command = lines(filled).join(' && ')
  const declared = (opts.declared ?? []).map(squash)
  if (declared.includes(squash(filled)) || declared.includes(command)) return { label, command, cwd, runnable: true }
  const cmds = commandsOf(filled)
  if (!cmds) return skip('not a check', command)
  let checks = 0
  for (const c of cmds) {
    if (SHELL_OPS.test(c)) return skip('uses shell beyond a plain command', command)
    if (isInstall(c)) continue
    const got = checkScript(c, opts.scriptsIn(cwd))
    if ('why' in got) return skip(got.why, command)
    checks++
  }
  if (!checks) return { label, command: cmds.join(' && '), cwd, runnable: false, setup: true, why: 'installs dependencies' }
  return { label, command: cmds.join(' && '), cwd, runnable: true }
}

/**
 * The failing check's job and its steps sorted. `scriptsIn(dir)` names the
 * scripts of the package.json in that folder (from the repo root, '' for the
 * root), or null when there is none.
 */
export function localChecks(files: WorkflowFile[], check: string, scriptsIn: (dir: string) => readonly string[] | null, declared: readonly string[] = []): LocalChecks {
  if (!check.trim()) return { job: null, why: 'the failing check has no name' }
  const found = findCiJob(files, check)
  if ('why' in found) return { job: null, why: found.why }
  const { file, jobId, job, combo, name } = found
  const base = { file, jobId, name, ...(combo && Object.keys(combo).length ? { matrix: combo } : {}) }
  if (scalar(job.uses)) return { job: { ...base, steps: [{ label: `calls ${scalar(job.uses)}`, uses: scalar(job.uses)!, cwd: '', runnable: false, why: 'a reusable workflow, its steps live elsewhere' }] } }
  const jobDir = scalar(job.defaults?.run?.['working-directory']) ?? undefined
  const steps = (Array.isArray(job.steps) ? job.steps : []).filter(isObj).map((s: J) => sortStep(s, { ...(combo ? { combo } : {}), ...(jobDir ? { jobDir } : {}), scriptsIn, declared }))
  return { job: { ...base, steps } }
}

/** Every folder a workflow job runs commands in, so the caller knows which package.json files to read. */
export function workingDirs(files: WorkflowFile[]): string[] {
  const dirs = new Set([''])
  for (const f of files) {
    const wf = workflowJobs(f.text)
    for (const job of Object.values(wf?.jobs ?? {})) {
      const jd = scalar(job.defaults?.run?.['working-directory'])
      if (jd) dirs.add(repoDir(jd))
      for (const s of Array.isArray(job.steps) ? job.steps : []) {
        const d = isObj(s) ? scalar(s['working-directory']) : null
        if (d) dirs.add(repoDir(d))
      }
    }
  }
  return [...dirs].filter((d) => !/\$\{\{/.test(d) && !outside(d))
}
