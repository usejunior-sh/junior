/**
 * Two checks on a shell command, for the Autonomy levels (.docs/junior-goals-teams/modes-autonomy-goals.md):
 *
 *   readOnlyCommand     runs alone at "Asks before commands", a short list of
 *                       read verbs, no shell metacharacters at all, so nothing
 *                       can be chained, redirected or substituted onto it
 *   destructiveCommand  still asks at "Asks before sending", work you can't
 *                       get back; every simple command in the line is checked
 *
 * Pure and browser-safe.
 */
import { splitCommand, unwrap, type CommandPart } from './bash.js'

/** `gh`/`git` read verbs: the only shell a brief may run. */
export const GIT_READ_RE =
  /^\s*(gh\s+(pr|issue|api|search|run|repo)\s+(view|diff|checks|list|status|comments)\b|git\s+(log|show|diff|blame|status|branch|ls-files)\b)/
/** Plain lookups on top of those. `find` is read-only only without its acting flags. */
const LOOKUP_RE = /^\s*(ls|cat|head|tail|wc|grep|rg|pwd|which|find)(\s|$)/
const FIND_ACTS_RE = /\s-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/
/** Anything that chains, redirects, substitutes or escapes. */
export const SHELL_META_RE = /[;&|<>`$\\\n]|\$\(/

/** A `gh`/`git` read with nothing attached. */
export const gitReadCommand = (cmd: string): boolean => GIT_READ_RE.test(cmd) && !SHELL_META_RE.test(cmd)

/** A command that only reads: git/gh reads plus plain lookups, nothing attached. */
export function readOnlyCommand(cmd: string): boolean {
  if (SHELL_META_RE.test(cmd)) return false
  if (GIT_READ_RE.test(cmd)) return true
  if (!LOOKUP_RE.test(cmd)) return false
  return !(/^\s*find\b/.test(cmd) && FIND_ACTS_RE.test(cmd))
}

const has = (part: CommandPart, ...flags: string[]) => part.some((w) => flags.includes(w))
/** `-rf`, `-fr`, `-R`, `--recursive`… */
const recursive = (part: CommandPart) => part.some((w) => w === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(w))

/** Why one simple command destroys work, or null. */
function destroys(raw: CommandPart): string | null {
  const part = unwrap(raw)
  const [cmd, sub] = part
  if (!cmd) return null
  if (cmd === 'rm' && recursive(part)) return 'deletes a folder'
  if (cmd === 'dropdb') return 'drops a database'
  if (cmd === 'git') {
    if (sub === 'reset' && has(part, '--hard')) return 'throws away uncommitted work'
    if (sub === 'clean' && part.some((w) => /^-[a-zA-Z]*f/.test(w) || w === '--force')) return 'deletes untracked files'
    if ((sub === 'checkout' || sub === 'restore') && (has(part, '.', '--', ':/') || has(part, '--worktree'))) return 'throws away uncommitted work'
    if (sub === 'branch' && has(part, '-D')) return 'deletes a branch that may not be merged'
    if (sub === 'stash' && (part[2] === 'drop' || part[2] === 'clear')) return 'deletes stashed work'
  }
  if (part.some((w) => /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?\w)/i.test(w))) return 'drops or empties a table'
  return null
}

/** Why the command destroys work you can't get back, or null. */
export function destructiveCommand(cmd: string): string | null {
  for (const part of splitCommand(cmd)) {
    const why = destroys(part)
    if (why) return why
  }
  return null
}
