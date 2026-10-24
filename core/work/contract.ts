/**
 * The repo contract: `<project>/.junior/junior.md`, checked into the repo, so
 * one teammate writes it and every Junior on the team reads it (plan item
 * `repo-contract-core`, pillar P4). Its frontmatter is the same small YAML
 * subset team recipes and learnings use, read strictly:
 *
 *   ---
 *   reviewers:
 *     - { path: "web/**", logins: [alice, bob] }
 *     - { path: "db/migrations/", logins: [acme/dba] }
 *   flaky:
 *     - { check: "e2e (*)", log: "ETIMEDOUT|socket hang up" }
 *   protected: ["db/migrations/", "*.lock", ".github/workflows/"]
 *   merge: squash
 *   checks: ["npm run typecheck", "pnpm test:unit"]
 *   ---
 *   Anything below the frontmatter is notes for people; the contract ignores it.
 *
 * The rule the whole file lives by: **a repo file can lower Junior's
 * autonomy, never raise it.** Anyone who can push to the repo can edit this
 * file, so nothing in it may let Junior do more than the user's own policy
 * and approvals already allow:
 *
 *   - `protected` paths are ones Junior never edits (held in chats, denied in jobs).
 *   - `reviewers` and `flaky` only inform: who to suggest, which red CI is noise.
 *   - `merge` only names the method when a merge happens; every merge is still the user's call.
 *   - `checks` names local commands that count as checks. They run on the Mac,
 *     inside the worktree, and only when a CI step runs exactly that command.
 *     Each must be one plain command: no shell operators, no network or
 *     publishing tools, no git. Nothing outbound becomes free.
 *
 * There is no allow-list of sends, no approvals, no autonomy level in here,
 * and `NoGrants` below makes adding one a compile error. Outbound effects are
 * judged by core/actions/policy.ts and the user's approvals, never by a file.
 *
 * Invisible Unicode (zero-width, bidi controls, tag characters) is taken out
 * before parsing, so what a reviewer sees in the diff is what Junior reads.
 * An unknown key is an error. A field with errors keeps its valid entries:
 * dropping the whole file on a typo would quietly lift its protections.
 *
 * Pure: the file's text comes in, no I/O.
 */
import { parseYaml, YamlError, type YamlValue } from '../teams/recipe.js'
import { stripInvisible } from '../../shared/juniorContext.js'

/** Where the contract lives, from the project's root. */
export const CONTRACT_FILE = '.junior/junior.md'

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

/** Paths matching `path` suggest these reviewers: GitHub logins, or `org/team`. */
export type ContractReviewers = { path: string; logins: readonly string[] }

/** A failing check whose name matches `check` (`*` = anything) and whose log matches `log` is flaky. */
export type ContractFlaky = { check: string; log: string }

export type RepoContract = {
  reviewers: readonly ContractReviewers[]
  flaky: readonly ContractFlaky[]
  /** path globs Junior never edits */
  protected: readonly string[]
  /** how this repo merges; null when the file doesn't say */
  merge: MergeMethod | null
  /** commands that count as local checks (exact, squashed whitespace) */
  checks: readonly string[]
}

export const CONTRACT_KEYS = ['reviewers', 'flaky', 'protected', 'merge', 'checks'] as const satisfies readonly (keyof RepoContract)[]

/**
 * The words a field that grants something would carry. A `RepoContract` key
 * containing one fails to compile at `noGrants` below: the contract has no
 * allow-list of sends, no approvals, no autonomy, nothing that frees a send.
 */
type GrantWord = 'allow' | 'approv' | 'grant' | 'autonom' | 'trust' | 'free' | 'auto' | 'send' | 'push' | 'skip' | 'bypass'
export type NoGrants<T> = [Extract<keyof T, `${string}${GrantWord}${string}`>] extends [never] ? true : false
export const noGrants: NoGrants<RepoContract> = true
// Every key the parser knows is a field of the contract, and every field is a key it knows.
const keysAreFields: [Exclude<keyof RepoContract, (typeof CONTRACT_KEYS)[number]>] extends [never] ? true : false = true
void keysAreFields

export const EMPTY_CONTRACT: RepoContract = Object.freeze({ reviewers: [], flaky: [], protected: [], merge: null, checks: [] })

export type ParsedContract = {
  contract: RepoContract
  errors: string[]
  /** invisible characters taken out before parsing */
  stripped: number
}

/** Longer than this and the file isn't read at all (it's not a contract, it's a log someone saved). */
export const CONTRACT_MAX_CHARS = 64_000
/** Entries per list. */
export const CONTRACT_MAX_ENTRIES = 100
const MAX_GLOB = 200
const MAX_REGEX = 200
const MAX_COMMAND = 200

// ---------------------------------------------------------------------------
// Values

const isMap = (v: YamlValue | undefined): v is { [key: string]: YamlValue } => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: YamlValue | undefined): string => (typeof v === 'string' ? v.trim() : '')

/** A list value: a YAML list, or one bare scalar as a list of one. */
function listOf(key: string, v: YamlValue, errors: string[]): YamlValue[] | null {
  const items = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : typeof v === 'string' ? [] : null
  if (!items) {
    errors.push(`${key}: expected a list`)
    return null
  }
  if (items.length > CONTRACT_MAX_ENTRIES) {
    errors.push(`${key}: at most ${CONTRACT_MAX_ENTRIES} entries (the first ${CONTRACT_MAX_ENTRIES} are read)`)
    return items.slice(0, CONTRACT_MAX_ENTRIES)
  }
  return items
}

/** Why a path glob can't be used, or null. */
export function globProblem(glob: string): string | null {
  if (!glob) return 'empty'
  if (glob.length > MAX_GLOB) return `longer than ${MAX_GLOB} characters`
  if (glob.startsWith('!')) return 'a "!" pattern would take protection away; the contract only adds it'
  if (/[[\]{}\\]/.test(glob)) return 'only *, ** and ? are supported'
  if (/\s/.test(glob.replace(/ /g, ''))) return 'has a tab or line break'
  const body = glob.replace(/^\//, '').replace(/\/$/, '')
  if (!body) return 'names the whole repo'
  if (body.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return 'uses "..", "." or "//"'
  return null
}

/**
 * A path glob → a RegExp over repo-relative paths (`/` separators).
 * `*` is any run within one name, `**` crosses folders, `?` one character.
 * A glob without a `/` matches a name at any depth (`*.lock`); a leading `/`
 * anchors it at the root. A match covers everything under it, so
 * `db/migrations` protects every file in that folder.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim()
  const anchored = g.startsWith('/')
  g = g.replace(/^\/+/, '').replace(/\/+$/, '')
  const anyDepth = !anchored && !g.includes('/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^$()|]/g, '\\$&')
  }
  return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${re}(?:/.*)?$`)
}

/** Does a repo-relative path match this glob? */
export const matchesGlob = (filePath: string, glob: string): boolean => globToRegExp(glob).test(normalisePath(filePath))

const normalisePath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')

function globsOf(key: string, v: YamlValue, errors: string[]): string[] {
  const out: string[] = []
  for (const [i, item] of (listOf(key, v, errors) ?? []).entries()) {
    const g = text(item)
    const bad = typeof item === 'string' ? globProblem(g) : 'expected a path glob'
    if (bad) errors.push(`${key}[${i}]: ${bad}`)
    else if (!out.includes(g)) out.push(g)
  }
  return out
}

/** A GitHub login, or an `org/team` slug. A leading `@` is fine. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][\w.-]{0,99})?$/

function reviewersOf(v: YamlValue, errors: string[]): ContractReviewers[] {
  const out: ContractReviewers[] = []
  for (const [i, item] of (listOf('reviewers', v, errors) ?? []).entries()) {
    const at = `reviewers[${i}]`
    if (!isMap(item)) {
      errors.push(`${at}: expected { path, logins }`)
      continue
    }
    for (const k of Object.keys(item)) if (k !== 'path' && k !== 'logins') errors.push(`${at}: unknown key "${k}" (expected path, logins)`)
    const glob = text(item.path)
    const bad = globProblem(glob)
    if (bad) errors.push(`${at}.path: ${bad}`)
    const logins: string[] = []
    const raw = item.logins === undefined ? null : listOf(`${at}.logins`, item.logins, errors)
    if (!raw || !raw.length) errors.push(`${at}.logins: at least one GitHub login`)
    for (const [j, l] of (raw ?? []).entries()) {
      const login = text(l).replace(/^@/, '')
      if (!LOGIN_RE.test(login)) errors.push(`${at}.logins[${j}]: "${login}" is not a GitHub login or org/team`)
      else if (!logins.includes(login)) logins.push(login)
    }
    if (!bad && logins.length) out.push({ path: glob, logins })
  }
  return out
}

/** Why a log pattern can't be used, or null. Patterns that can backtrack forever are refused. */
export function regexProblem(src: string): string | null {
  if (!src) return 'empty'
  if (src.length > MAX_REGEX) return `longer than ${MAX_REGEX} characters`
  try {
    new RegExp(src, 'i')
  } catch {
    return 'not a valid regular expression'
  }
  // A quantified group that itself holds a quantifier: (a+)+, (x*)*, (a|aa){2,}.
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(src)) return 'a repeated group with a repeat inside can run for ever'
  if (/\\[1-9]/.test(src)) return 'back-references are not supported'
  return null
}

function flakyOf(v: YamlValue, errors: string[]): ContractFlaky[] {
  const out: ContractFlaky[] = []
  for (const [i, item] of (listOf('flaky', v, errors) ?? []).entries()) {
    const at = `flaky[${i}]`
    if (!isMap(item)) {
      errors.push(`${at}: expected { check, log }`)
      continue
    }
    for (const k of Object.keys(item)) if (k !== 'check' && k !== 'log') errors.push(`${at}: unknown key "${k}" (expected check, log)`)
    const check = text(item.check)
    const log = text(item.log)
    let ok = true
    if (!check || check.length > MAX_GLOB) {
      errors.push(`${at}.check: the check's name as GitHub shows it (* matches anything)`)
      ok = false
    }
    const bad = regexProblem(log)
    if (bad) {
      errors.push(`${at}.log: ${bad}`)
      ok = false
    }
    if (ok) out.push({ check, log })
  }
  return out
}

/** Shell that turns one command into more than a command. */
const SHELL_OPS = /[;|&<>`$(){}\\*?!#~'"]|^\s*\w+=/
/** Plain arguments only: flags, paths, values. */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/
/** Programs that reach past the Mac, change git, or run arbitrary code: never a check. */
const NOT_A_CHECK = new Set([
  'git', 'gh', 'hub', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp',
  'docker', 'podman', 'kubectl', 'helm', 'aws', 'gcloud', 'az', 'terraform', 'pulumi', 'vercel', 'netlify', 'fly', 'heroku', 'firebase',
  'npx', 'bunx', 'pnpx', 'open', 'osascript', 'sudo', 'su', 'eval', 'exec', 'xargs', 'env', 'nohup', 'sh', 'bash', 'zsh', 'fish', 'node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun',
  'rm', 'mv', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'launchctl', 'junior', 'claude', 'codex', 'make',
])
/** Package-manager subcommands that publish, sign in, or run a package that isn't installed. */
const PM_NOT_A_CHECK = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'login', 'logout', 'adduser', 'token', 'exec', 'dlx', 'x', 'create', 'init', 'version', 'release', 'add', 'remove', 'install', 'i', 'ci', 'update', 'upgrade', 'link', 'pack', 'deploy'])

/** Why a declared check command can't count as a check, or null. */
export function checkCommandProblem(cmd: string): string | null {
  if (!cmd) return 'empty'
  if (cmd.length > MAX_COMMAND) return `longer than ${MAX_COMMAND} characters`
  if (/\bsecrets\./.test(cmd) || /\$\{\{/.test(cmd)) return 'names a secret or a CI expression'
  if (SHELL_OPS.test(cmd)) return 'one plain command only: no shell operators, quotes or variables'
  const words = cmd.split(' ')
  if (!words.every((w) => PLAIN_WORD.test(w))) return 'plain arguments only'
  const prog = words[0].split('/').pop() ?? ''
  if (words[0].includes('/') && (words[0].startsWith('/') || words[0].split('/').includes('..'))) return 'runs a program outside the repo'
  if (NOT_A_CHECK.has(prog)) return `${prog} is not a check`
  if ((prog === 'npm' || prog === 'pnpm' || prog === 'yarn') && words[1] && PM_NOT_A_CHECK.has(words[1])) return `${prog} ${words[1]} is not a check`
  return null
}

const squash = (s: string) => s.trim().replace(/\s+/g, ' ')

function checksOf(v: YamlValue, errors: string[]): string[] {
  const out: string[] = []
  for (const [i, item] of (listOf('checks', v, errors) ?? []).entries()) {
    const cmd = typeof item === 'string' ? squash(item) : ''
    const bad = typeof item === 'string' ? checkCommandProblem(cmd) : 'expected a command'
    if (bad) errors.push(`checks[${i}]: ${bad}`)
    else if (!out.includes(cmd)) out.push(cmd)
  }
  return out
}

// ---------------------------------------------------------------------------
// The file

function splitFile(src: string): { yaml: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  return m ? { yaml: m[1] } : null
}

/**
 * `.junior/junior.md`'s text → the contract. A file without frontmatter is
 * notes only: an empty contract, no errors. Errors never throw; every valid
 * entry is kept (see the header for why).
 */
export function parseContract(raw: string): ParsedContract {
  const { text: src, removed: stripped } = stripInvisible(raw.replace(/^﻿/, ''))
  const errors: string[] = []
  if (src.length > CONTRACT_MAX_CHARS) return { contract: EMPTY_CONTRACT, errors: [`the file is longer than ${CONTRACT_MAX_CHARS.toLocaleString('en-US')} characters, so it isn't read`], stripped }
  const parts = splitFile(src)
  if (!parts) return { contract: EMPTY_CONTRACT, errors, stripped }
  let doc: YamlValue
  try {
    doc = parseYaml(parts.yaml, 2)
  } catch (err) {
    return { contract: EMPTY_CONTRACT, errors: [err instanceof YamlError ? err.message : String(err)], stripped }
  }
  if (!isMap(doc)) return { contract: EMPTY_CONTRACT, errors: ['the frontmatter is a map of keys'], stripped }
  for (const k of Object.keys(doc)) {
    if (!(CONTRACT_KEYS as readonly string[]).includes(k)) errors.push(`unknown key "${k}" (expected ${CONTRACT_KEYS.join(', ')})`)
  }
  let merge: MergeMethod | null = null
  if (doc.merge !== undefined && doc.merge !== '') {
    const m = text(doc.merge)
    if ((MERGE_METHODS as readonly string[]).includes(m)) merge = m as MergeMethod
    else errors.push(`merge: one of ${MERGE_METHODS.join(', ')}`)
  }
  const contract: RepoContract = {
    reviewers: doc.reviewers === undefined ? [] : reviewersOf(doc.reviewers, errors),
    flaky: doc.flaky === undefined ? [] : flakyOf(doc.flaky, errors),
    protected: doc.protected === undefined ? [] : globsOf('protected', doc.protected, errors),
    merge,
    checks: doc.checks === undefined ? [] : checksOf(doc.checks, errors),
  }
  return { contract, errors, stripped }
}

// ---------------------------------------------------------------------------
// Reading it

/** The protected glob a repo-relative path falls under, or null when Junior may edit it. */
export function protectedBy(c: RepoContract, filePath: string): string | null {
  return c.protected.find((g) => matchesGlob(filePath, g)) ?? null
}

/** Reviewers suggested for a change touching these paths, in the contract's order, each once. */
export function reviewersFor(c: RepoContract, paths: readonly string[]): string[] {
  const out: string[] = []
  for (const r of c.reviewers) {
    if (!paths.some((p) => matchesGlob(p, r.path))) continue
    for (const l of r.logins) if (!out.includes(l)) out.push(l)
  }
  return out
}

/** Only the tail of a log is searched: where the failure is, and a bound on the work. */
export const FLAKY_LOG_TAIL = 64_000

const checkName = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')

/** The contract's flaky entry that matches this failing check and its log, or null. */
export function flakyMatch(c: RepoContract, check: string, log: string): ContractFlaky | null {
  const tail = log.length > FLAKY_LOG_TAIL ? log.slice(-FLAKY_LOG_TAIL) : log
  return c.flaky.find((f) => checkName(f.check).test(check.trim()) && new RegExp(f.log, 'i').test(tail)) ?? null
}
