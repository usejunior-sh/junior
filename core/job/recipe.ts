/**
 * Job recipes: a job you can pass to a teammate by hand.
 *
 * Jobs are already files (`jobs/<slug>.md`, server/job-files.ts). A recipe
 * is that file with everything that belongs to this machine taken out:
 *
 *   - the job's id and its project (the teammate picks their own folder)
 *   - absolute paths, `~/` paths and `file://` links, anywhere in the text
 *   - workspace and project ids, and any UUID
 *   - env-like values (`GITHUB_TOKEN=…`, `token: …`) and known token shapes
 *
 * and it is always off (`enabled: false`). Importing goes the other way:
 * invisible Unicode is stripped first (a pasted file can hide instructions
 * in zero-width or bidi characters), the text is checked against the same
 * strict schema a job file is, and the job comes back off and drafted, with
 * the setup questions the job chat asks before anything runs.
 *
 * Pure. The strict schema lives with the job files on the server, so it is
 * handed in (`JobSchema`): core never imports server code.
 */

/** The parts of a job file spec a recipe reads or rewrites. */
export type RecipeJobSpec = {
  id: string
  title: string
  schedule: string
  /** project id; '' = none picked yet */
  project: string
  enabled: boolean
  draft?: boolean
  browser?: { profile: string; sites?: string[] }
  instruction: string
}

/** The strict job file schema: server/job-files.ts `parseJobFile` and `serializeJobFile`. */
export type JobSchema<S extends RecipeJobSpec> = {
  parse: (name: string, text: string) => { spec: S; errors: string[] }
  serialize: (spec: S) => string
}

/** What this machine knows that a recipe must not carry. */
export type RecipeContext = {
  /** the workspace's projects: their folders and ids are taken out */
  projects?: { id: string; path: string }[]
  /** workspace ids on this machine */
  workspaceIds?: string[]
  /** the user's home folder */
  home?: string
}

/** How much was taken out, by kind. */
export type RecipeScrubbed = { paths: number; ids: number; secrets: number }

export type RecipeExport = {
  /** the recipe, ready for the clipboard */
  text: string
  /** the schema's complaints about the exported text; empty for a healthy job */
  errors: string[]
  scrubbed: RecipeScrubbed
}

export type RecipeQuestionKey = 'project' | 'schedule' | 'browser'

/** One thing the job chat asks before the job is saved. Every question comes with its suggested answer. */
export type RecipeQuestion = {
  key: RecipeQuestionKey
  question: string
  /** the answer Junior suggests; '' when there is nothing to suggest */
  suggested: string
}

export type RecipeImport<S extends RecipeJobSpec> = {
  /** true when the recipe is a valid job file */
  ok: boolean
  /** best effort, off and drafted, no project; usable only when `ok` */
  spec: S
  /** the cleaned job file text, off and drafted, ready to save once the questions are answered */
  text: string
  errors: string[]
  questions: RecipeQuestion[]
  /** how many invisible characters were taken out */
  removedInvisible: number
}

/** The first frontmatter line of every recipe: a comment, so the strict schema doesn't see it. */
export const RECIPE_MARK = '# A Junior job recipe. Paste it into a new job chat to set it up.'

// Invisible Unicode

/**
 * Characters that render as nothing but still reach the model: zero-width
 * spaces and joiners, bidi overrides and isolates, word joiners and
 * invisible operators, the BOM, the soft hyphen, the Mongolian vowel
 * separator, tag characters and the supplementary variation selectors (both
 * used to smuggle text), and C0/C1 controls other than tab and newlines.
 * The ordinary variation selectors (U+FE00–FE0F) stay: emoji need them.
 */
const INVISIBLE_RE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Text without its invisible characters, and how many there were. */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0
  const out = text.replace(INVISIBLE_RE, () => {
    removed++
    return ''
  })
  return { text: out, removed }
}

// Scrubbing

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/**
 * Known token shapes: GitHub, Slack, Anthropic/OpenAI, AWS, GitLab, Linear,
 * npm, JWTs, and bearer headers.
 */
const TOKEN_RES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
]

/** `GITHUB_TOKEN=abc`, `export FOO="bar"`: an upper-case env name and its value. */
const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]{2,})=("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/g

/** `token: abc`, `api_key = abc`, `password: abc`. */
const SECRET_FIELD_RE = /\b(api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`,;]+)/gi

/** Characters a path segment never contains here: space, quotes, brackets, separators, globs. */
const SEG = `[^\\s/"'\`<>()\\[\\]{},;|*]+`

/**
 * An absolute path with two or more segments (`/Users/sam/code`), starting
 * at a boundary: never inside a URL (`host/a/b`), a date (`10/24/2026`), a
 * relative path (`./a/b`) or a cron step (`*\/5`). One segment (`/review`, a
 * slash command) stays.
 */
const ABS_PATH_RE = new RegExp(`(?<![\\w.~\\\\/*>-])(?:/${SEG}){2,}/?`, 'g')
const HOME_PATH_RE = new RegExp(`(?<![\\w.~\\\\/>-])~[\\w.-]*/(?:${SEG}/?)*`, 'g')
const FILE_URL_RE = /\bfile:\/\/[^\s"'`<>)\]]*/gi
const WIN_PATH_RE = /(?<![\w])[A-Za-z]:\\[^\s"'`<>|]*/g

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A placeholder the scrubber wrote: never scrubbed again. */
const isPlaceholder = (v: string) => /^<[a-z ]+>$/.test(v)

/**
 * Take everything machine-specific out of a text: this machine's project
 * folders and ids, other absolute paths, UUIDs, and secrets. Pure.
 */
export function scrubText(text: string, ctx: RecipeContext = {}): { text: string; scrubbed: RecipeScrubbed } {
  const scrubbed: RecipeScrubbed = { paths: 0, ids: 0, secrets: 0 }
  let out = text
  const sub = (re: RegExp, kind: keyof RecipeScrubbed, to: string | ((m: string, ...g: string[]) => string)) => {
    out = out.replace(re, (m: string, ...g: unknown[]) => {
      scrubbed[kind]++
      return typeof to === 'string' ? to : to(m, ...(g as string[]))
    })
  }

  // secrets first, so a token inside a path or URL still goes
  for (const re of TOKEN_RES) sub(re, 'secrets', (m, scheme) => (/^(Bearer|Basic)\s/.test(m) ? `${scheme} <secret>` : '<secret>'))
  out = out.replace(ENV_ASSIGN_RE, (m, name: string, value: string) => {
    if (isPlaceholder(value)) return m
    scrubbed.secrets++
    return `${name}=<secret>`
  })
  out = out.replace(SECRET_FIELD_RE, (m, key: string, sep: string, value: string) => {
    if (isPlaceholder(value)) return m
    scrubbed.secrets++
    return `${key}${sep}<secret>`
  })

  // this machine's own folders, longest first, so a nested project wins
  const folders = (ctx.projects ?? [])
    .map((p) => p.path.replace(/[\\/]+$/, ''))
    .filter((p) => p.length > 1)
    .sort((a, b) => b.length - a.length)
  for (const f of folders) sub(new RegExp(`${escapeRe(f)}(?=$|[\\\\/\\s"'\`)\\]>,;:.])`, 'g'), 'paths', '<project folder>')
  sub(FILE_URL_RE, 'paths', '<path>')
  sub(WIN_PATH_RE, 'paths', '<path>')
  sub(HOME_PATH_RE, 'paths', '<path>')
  sub(ABS_PATH_RE, 'paths', '<path>')
  const home = ctx.home?.replace(/[\\/]+$/, '')
  if (home && home.length > 1) sub(new RegExp(`${escapeRe(home)}(?![\\w.-])`, 'g'), 'paths', '~')

  // ids: UUIDs anywhere, and this machine's own ids when they are distinctive
  sub(UUID_RE, 'ids', '<id>')
  const ids = [...(ctx.projects ?? []).map((p) => p.id), ...(ctx.workspaceIds ?? [])]
    .filter((id) => id.length >= 6 && id !== 'default')
    .sort((a, b) => b.length - a.length)
  for (const id of ids) sub(new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`, 'g'), 'ids', '<id>')

  return { text: out, scrubbed }
}

// Frontmatter lines

/** The index of the closing `---` of a text's frontmatter, or -1. */
function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return -1
  return lines.findIndex((l, i) => i > 0 && l.trim() === '---')
}

/** Drop frontmatter keys' lines, and the block-list items under them. */
function dropKeys(text: string, keys: string[]): string {
  const lines = text.split(/\r?\n/)
  const end = frontmatterEnd(lines)
  if (end === -1) return text
  const re = new RegExp(`^(?:${keys.map(escapeRe).join('|')})\\s*:`)
  const out: string[] = [lines[0]]
  for (let i = 1; i < end; i++) {
    if (re.test(lines[i])) {
      while (i + 1 < end && /^\s+-\s/.test(lines[i + 1])) i++
      continue
    }
    out.push(lines[i])
  }
  return [...out, ...lines.slice(end)].join('\n')
}

/** Put a line right after the opening `---`. */
function afterOpening(text: string, line: string): string {
  return text.replace(/^---\r?\n/, `---\n${line}\n`)
}

// Export and import

/**
 * A job file → a recipe: no id, no project, off, nothing machine-specific.
 * The exported text is checked against the schema again, so a recipe that
 * wouldn't import says so here. Pure.
 */
export function toRecipe<S extends RecipeJobSpec>(jobText: string, schema: JobSchema<S>, ctx: RecipeContext = {}): RecipeExport {
  const { spec } = schema.parse('job', stripInvisible(jobText).text)
  const off: S = { ...spec, id: '', project: '', enabled: false }
  delete off.draft
  let text = dropKeys(schema.serialize(off), ['id', 'project', 'draft'])
  const { text: clean, scrubbed } = scrubText(text, ctx)
  text = afterOpening(clean, RECIPE_MARK)
  const { errors } = schema.parse('recipe', text)
  return { text, errors, scrubbed }
}

/** True when a pasted text looks like a recipe or a job file: frontmatter with a schedule and a body. */
export function looksLikeRecipe(text: string): boolean {
  const t = stripInvisible(text).text.trimStart()
  return t.startsWith(RECIPE_MARK) || (/^---\r?\n/.test(t) && /^schedule\s*:/m.test(t) && /^tools\s*:/m.test(t))
}

/**
 * A recipe → a job, off and drafted, with no project, plus the setup
 * questions the job chat asks before saving it. Invisible Unicode goes
 * first; then the strict schema decides. An id or project the recipe
 * carries is ignored: the job gets a fresh id and the user's own folder.
 * Pure.
 */
export function fromRecipe<S extends RecipeJobSpec>(
  text: string,
  schema: JobSchema<S>,
  opts: { projects?: { id: string; name: string; isDefault?: boolean }[] } = {},
): RecipeImport<S> {
  const { text: visible, removed } = stripInvisible(text)
  const trimmed = visible.replace(/^\s+(?=---)/, '')
  const errors: string[] = []
  if (!/^---\r?\n/.test(trimmed)) errors.push('a recipe starts with a --- block; this text has none')

  // their id is theirs: without it the schema mints a fresh one
  const parsed = schema.parse('recipe', dropKeys(trimmed, ['id']))
  errors.push(...parsed.errors.filter((e) => !errors.includes(e)))

  const spec: S = { ...parsed.spec, project: '', enabled: false, draft: true }
  const out = errors.length ? trimmed : dropKeys(schema.serialize(spec), ['id'])

  const questions: RecipeQuestion[] = []
  const projects = opts.projects ?? []
  const pick = projects.find((p) => p.isDefault) ?? projects[0]
  questions.push({
    key: 'project',
    question: 'Which project folder should it work in?',
    suggested: pick ? pick.id : '',
  })
  questions.push({
    key: 'schedule',
    question: `It runs on "${spec.schedule}". Keep that schedule?`,
    suggested: spec.schedule,
  })
  if (spec.browser) {
    questions.push({
      key: 'browser',
      question: `It uses a browser profile called "${spec.browser.profile}". Which of yours should it use?`,
      suggested: spec.browser.profile,
    })
  }

  return { ok: errors.length === 0, spec, text: out, errors, questions, removedInvisible: removed }
}
