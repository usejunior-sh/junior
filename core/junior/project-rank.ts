/**
 * Which folders to offer as projects on day one: the git repos where Claude
 * Code already runs most (ideas.md "AI-driven project folder suggestions",
 * done without a model). The scan of Claude's projects folder lives in
 * server/project-suggestions.ts; everything here is pure and browser-safe,
 * with time passed in as `now`.
 *
 * Claude Code keeps one folder per launch directory under
 * `<CLAUDE_CONFIG_DIR>/projects/`, named by replacing every character that
 * isn't a letter or digit with `-`, and one `<session>.jsonl` per session.
 */

/** One folder Claude Code ran in, resolved to the repo it belongs to. */
export type ProjectSighting = {
  /** the launch directory, absolute */
  path: string
  /** the root of the git repo it sits in (a worktree resolves to its main repo) */
  repoRoot: string
  /** owner/name from the repo's origin remote, when it's on GitHub */
  repo?: string
  /** one entry per session file: when it was last written, ms since epoch */
  sessions: number[]
}

/** One repo worth offering as a project. */
export type ProjectSuggestion = {
  /** the repo root, absolute: what a project's folder would be */
  path: string
  /** the folder's own name, as a default project name */
  name: string
  /** owner/name, or '' when the repo has no GitHub origin */
  repo: string
  /** Claude Code sessions run anywhere in this repo (worktrees included) */
  sessions: number
  /** the newest session, ms since epoch */
  lastActiveAt: number
  /** sessions weighed by age (halving every `halfLifeDays`): the sort key */
  score: number
  /** a short line saying why: "14 sessions, last today" */
  why: string
}

export type RankOptions = {
  now: number
  /** folders already added as projects: never suggested again */
  existing?: string[]
  /** the user's home folder: never a project, even with a dotfiles repo in it */
  home?: string
  /** how many to return (default 8) */
  limit?: number
  /** a session's weight halves every this many days (default 14) */
  halfLifeDays?: number
  /** sessions older than this don't count at all (default 180) */
  maxAgeDays?: number
}

const DAY = 24 * 60 * 60 * 1000

/** The folder name Claude Code files a launch directory's sessions under. */
export const projectKey = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** Strip trailing slashes so `/a/b/` and `/a/b` compare equal (root stays `/`). */
export const normPath = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

const baseName = (p: string): string => {
  const parts = normPath(p).split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * The paths a project key could stand for, checked against the disk through
 * `isDir` / `exists`. Every `-` was one of `/ - . _ space`, so this walks the
 * dashes left to right and only descends into folders that exist. Returns the
 * first full path that exists, or null. `budget` caps the probes, so a key
 * full of dashes can't blow up.
 */
export function decodeProjectKey(
  key: string,
  isDir: (p: string) => boolean,
  exists: (p: string) => boolean = isDir,
  budget = 4000,
): string | null {
  if (!key.startsWith('-')) return null
  const body = key.slice(1)
  const SEPS = ['/', '-', '.', '_', ' ']
  let probes = 0
  // `dir` is the last confirmed folder; `seg` is the segment being built after it
  const walk = (i: number, dir: string, seg: string): string | null => {
    if (probes > budget) return null
    if (i === body.length) {
      const full = dir === '/' ? `/${seg}` : `${dir}/${seg}`
      probes++
      return seg && exists(full) ? full : null
    }
    const ch = body[i]!
    if (ch !== '-') return walk(i + 1, dir, seg + ch)
    for (const sep of SEPS) {
      if (sep === '/') {
        // close the segment: it has to be a real folder to go on
        if (!seg) continue
        const next = dir === '/' ? `/${seg}` : `${dir}/${seg}`
        probes++
        if (!isDir(next)) continue
        const hit = walk(i + 1, next, '')
        if (hit) return hit
      } else {
        const hit = walk(i + 1, dir, seg + sep)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(0, '/', '')
}

/** owner/name from a git remote URL, when it points at GitHub; else null. */
export function repoFromRemoteUrl(url: string): string | null {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** The `origin` remote's URL from a `.git/config` file's text, or null. */
export function originUrlFromGitConfig(text: string): string | null {
  let inOrigin = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line)
      continue
    }
    if (!inOrigin) continue
    const m = /^url\s*=\s*(.+)$/.exec(line)
    if (m) return m[1]!.trim()
  }
  return null
}

const ago = (ms: number): string => {
  const days = Math.floor(ms / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

/**
 * Rank sightings into suggestions: merge every sighting of one repo, drop
 * existing projects, the home folder and repos with no recent session, then
 * sort by sessions weighed by age (ties: newest first, then path).
 */
export function rankProjects(sightings: ProjectSighting[], opts: RankOptions): ProjectSuggestion[] {
  const { now, limit = 8, halfLifeDays = 14, maxAgeDays = 180 } = opts
  const existing = new Set((opts.existing ?? []).map(normPath))
  const home = opts.home ? normPath(opts.home) : null
  const byRoot = new Map<string, { repo: string; times: number[] }>()
  for (const s of sightings) {
    const root = normPath(s.repoRoot)
    if (!root || root === '/' || root === home || existing.has(root)) continue
    const entry = byRoot.get(root) ?? { repo: '', times: [] }
    if (!entry.repo && s.repo) entry.repo = s.repo
    for (const t of s.sessions) if (Number.isFinite(t) && now - t <= maxAgeDays * DAY) entry.times.push(t)
    byRoot.set(root, entry)
  }
  const out: ProjectSuggestion[] = []
  for (const [root, { repo, times }] of byRoot) {
    if (!times.length) continue
    const lastActiveAt = Math.max(...times)
    let score = 0
    for (const t of times) score += Math.pow(0.5, Math.max(0, now - t) / (halfLifeDays * DAY))
    const n = times.length
    out.push({
      path: root,
      name: baseName(root),
      repo,
      sessions: n,
      lastActiveAt,
      score: Math.round(score * 1000) / 1000,
      why: `${n} Claude Code session${n === 1 ? '' : 's'}, last ${ago(now - lastActiveAt)}`,
    })
  }
  out.sort((a, b) => b.score - a.score || b.lastActiveAt - a.lastActiveAt || a.path.localeCompare(b.path))
  return out.slice(0, Math.max(0, limit))
}
