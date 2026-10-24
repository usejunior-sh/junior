/**
 * The repo contract, applied (plan item `repo-contract-apply`, pillar P4).
 * core/work/contract.ts parses `.junior/junior.md`; this file decides what a
 * tool call means against it, and writes the lines a prompt carries:
 *
 *   - `protectedEdit`: does this call change a protected path? File tools
 *     (Write, Edit, MultiEdit, NotebookEdit) by their path; a shell command
 *     when it writes into one (a redirect, rm, mv, cp, tee, sed -i, …). The
 *     contract file itself is always protected: Junior editing the file that
 *     limits it would be Junior raising its own autonomy.
 *   - `repoNotes`: "From the repo's .junior/: …", the lines a task's or a
 *     brief's prompt carries so the agent knows the repo's rules up front.
 *
 * The session's hold (server/session/actions-hold.ts) asks in a chat and
 * refuses in a job or task run. Server-only (node:path); no I/O.
 */
import path from 'node:path'
import { splitCommand } from '../actions/bash.js'
import { CONTRACT_FILE, protectedBy, type RepoContract } from './contract.js'

/** The tools that change a file, by the name of their path argument. */
const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** Programs whose path arguments are written to (or removed). */
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'tee', 'truncate', 'touch', 'ln', 'chmod', 'chown', 'shred', 'unlink', 'install', 'rsync', 'dd'])
/** In-place editors: written to only with -i. */
const IN_PLACE = new Set(['sed', 'perl', 'gsed'])
/** git subcommands that change files in the tree by path. */
const GIT_WRITERS = new Set(['rm', 'mv', 'checkout', 'restore', 'apply', 'reset', 'clean', 'stash'])

export type ProtectedHit = {
  /** the path as repo-relative, `/` separated */
  path: string
  /** the glob that protects it (CONTRACT_FILE for the contract itself) */
  glob: string
}

/** A path as the agent wrote it → repo-relative to `root`, or null when it's outside the repo. */
export function repoRelative(root: string, cwd: string, p: string): string | null {
  const raw = p.trim()
  if (!raw || raw.startsWith('~')) return null
  const abs = path.resolve(cwd, raw)
  const rel = path.relative(path.resolve(root), abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/** The protection a repo-relative path falls under: the contract file always, then the contract's globs. */
export function protectionOf(c: RepoContract, rel: string): string | null {
  const norm = rel.replace(/^(\.\/)+/, '')
  if (norm === CONTRACT_FILE || norm.startsWith('.junior/junior.md/')) return CONTRACT_FILE
  return protectedBy(c, norm)
}

/** Redirect targets in a raw command line: `> f`, `>> f`, `2> f`, `&> f`. Quotes are taken off. */
function redirectTargets(cmd: string): string[] {
  const out: string[] = []
  const re = /(?:^|[^<>&\d])(?:\d|&)?>>?\|?\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) out.push(m[1].replace(/^["']|["']$/g, ''))
  return out
}

/** The words of one shell command that name a path it writes to. */
function writtenPaths(words: string[]): string[] {
  let i = 0
  while (i < words.length && /^\w+=/.test(words[i])) i++ // FOO=bar cmd …
  const prog = (words[i] ?? '').split('/').pop() ?? ''
  const args = words.slice(i + 1)
  const paths = args.filter((a) => !a.startsWith('-'))
  if (WRITERS.has(prog)) return paths
  if (IN_PLACE.has(prog) && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return paths
  if (prog === 'git' && GIT_WRITERS.has(paths[0] ?? '')) return paths.slice(1)
  return []
}

/**
 * Does this tool call change a protected path? `root` is the repo the
 * contract came from, `cwd` where the session's relative paths start.
 * A shell command that can't be split is judged by its redirects and words
 * as best it can: any doubt here only means the user is asked.
 */
export function protectedEdit(c: RepoContract, root: string, cwd: string, toolName: string, input: unknown): ProtectedHit | null {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const hit = (p: string): ProtectedHit | null => {
    const rel = repoRelative(root, cwd, p)
    const glob = rel === null ? null : protectionOf(c, rel)
    return rel !== null && glob ? { path: rel, glob } : null
  }
  const key = FILE_TOOLS[toolName]
  if (key) {
    const p = args[key]
    return typeof p === 'string' ? hit(p) : null
  }
  if (toolName !== 'Bash') return null
  const cmd = typeof args.command === 'string' ? args.command : ''
  if (!cmd.trim()) return null
  for (const t of redirectTargets(cmd)) {
    const h = hit(t)
    if (h) return h
  }
  let parts: string[][]
  try {
    parts = splitCommand(cmd)
  } catch {
    parts = [cmd.split(/\s+/)]
  }
  for (const words of parts)
    for (const p of writtenPaths(words)) {
      const h = hit(p)
      if (h) return h
    }
  return null
}

/** What the agent is told when an edit to a protected path is held or refused. */
export function protectedReason(h: ProtectedHit, ask: boolean): string {
  const why =
    h.glob === CONTRACT_FILE
      ? `${h.path} is the repo's contract for Junior, and Junior doesn't edit the file that limits it`
      : `${h.path} is protected by the repo's .junior/junior.md (${h.glob})`
  return ask ? `${why}, so this edit needs the user's OK.` : `${why}. Leave it unchanged, and say in your hand-in what it would need.`
}

const list = (xs: readonly string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '))

/**
 * The lines a prompt carries about the repo's contract, starting
 * "From the repo's .junior/:". Empty when the contract says nothing.
 */
export function repoNotes(c: RepoContract): string[] {
  const lines: string[] = []
  if (c.protected.length) lines.push(`- Protected, don't edit: ${list(c.protected)}.`)
  if (c.checks.length) lines.push(`- Local checks: ${list(c.checks)}.`)
  if (c.reviewers.length) lines.push(`- Reviewers by path: ${c.reviewers.slice(0, 6).map((r) => `${r.path} → ${r.logins.join(', ')}`).join('; ')}.`)
  if (c.flaky.length) lines.push(`- Known flaky: ${c.flaky.slice(0, 6).map((f) => `${f.check} when the log matches /${f.log}/`).join('; ')}.`)
  if (c.merge) lines.push(`- This repo merges by ${c.merge}.`)
  return lines.length ? ["From the repo's .junior/:", ...lines] : []
}
