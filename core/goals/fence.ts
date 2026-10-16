/**
 * The role fence (goals-mapping.md, M0 findings): what a read-only session —
 * a reviewer, a tester, a brief — may not do, checked as a PreToolUse hook so
 * it runs before the user's own `~/.claude` allow rules and permission mode.
 * Those approve shell commands first otherwise, and a "read-only" reviewer
 * wrote to /tmp and ran `pkill` without a prompt (artifact fde089a4).
 *
 * A deny-list, not a sandbox: file tools are refused outright, and Bash is
 * refused when its text writes — a redirect to a file, a command that
 * changes files or processes, a git or package-manager verb that does. A
 * script an interpreter runs (`python -c`, `node -e`) isn't read. Outbound
 * effects are the Actions hold's to catch, after this. Pure and browser-safe.
 */
import { splitCommand, substitutions, unwrap, type CommandPart } from '../actions/bash.js'

export type FenceDecision = { allow: true } | { allow: false; reason: string }

export type RoleFence = {
  /** may change files (a builder); false = read-only */
  write: boolean
  /** who, for the refusal: "reviewer", "brief" */
  role: string
}

/** The built-in tools that change files. */
export const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Programs that change files or processes whatever their arguments. */
const WRITING_PROGRAMS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'dd', 'truncate', 'tee',
  'install', 'rsync', 'scp', 'unlink', 'shred', 'patch', 'mkfifo', 'mktemp', 'wget',
  'kill', 'pkill', 'killall',
])

/** git verbs that change the checkout, its refs or a remote. */
const GIT_WRITES = new Set([
  'add', 'commit', 'push', 'pull', 'checkout', 'switch', 'reset', 'restore', 'rm', 'mv', 'merge', 'rebase',
  'cherry-pick', 'revert', 'apply', 'am', 'clean', 'init', 'clone', 'gc', 'prune', 'notes', 'submodule',
  'worktree', 'update-ref', 'filter-branch', 'replace',
])
/** git global flags that take the next word as their value. */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** Package-manager verbs that change node_modules, the lockfile or the registry. */
const PM_WRITES = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'unlink',
  'publish', 'version', 'init', 'dedupe', 'prune',
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'brew', 'cargo', 'gem'])

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

/** Where a redirect may point without writing a file. */
const SAFE_TARGET = /^\/dev\/(null|stdout|stderr|tty|fd\/[0-9]+)$/

/**
 * Every file the command's text redirects output into. Quote-aware: a `>`
 * inside quotes is text (`grep "a>b"`); `2>&1` and `>&2` move a stream and
 * name no file. A process substitution `>(…)` counts as a target.
 */
export function redirectTargets(src: string): string[] {
  const out: string[] = []
  const s = src
  let i = 0
  let wordStart = true
  while (i < s.length) {
    const c = s[i]
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      i = end === -1 ? s.length : end + 1
      wordStart = false
    } else if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1
      i++
      wordStart = false
    } else if (c === '\\') {
      i += 2
      wordStart = false
    } else if (c === '#' && wordStart) {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      // `$(( 3 > 2 ))` is arithmetic: its `>` compares.
      let depth = 0
      i++
      do {
        if (s[i] === '(') depth++
        else if (s[i] === ')') depth--
        i++
      } while (i < s.length && depth > 0)
      wordStart = false
    } else if (c === '>') {
      i++
      if (s[i] === '>' || s[i] === '|') i++
      if (s[i] === '&') {
        // `>&2`, `>&-`: a stream moved. `>&file` (csh-style) writes the file.
        i++
        if (/[0-9-]/.test(s[i] ?? '')) {
          while (/[0-9-]/.test(s[i] ?? '')) i++
          continue
        }
      }
      while (s[i] === ' ' || s[i] === '\t') i++
      let target = ''
      if (s[i] === '(') target = '>(…)'
      else {
        while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
          const q = s[i]
          if (q === "'" || q === '"') {
            const end = s.indexOf(q, i + 1)
            target += s.slice(i + 1, end === -1 ? s.length : end)
            i = end === -1 ? s.length : end + 1
          } else {
            target += q
            i++
          }
        }
      }
      if (target && !SAFE_TARGET.test(target)) out.push(target)
      wordStart = true
    } else {
      wordStart = /[\s;&|()]/.test(c)
      i++
    }
  }
  // `$( )`, backticks and `<( )` run a script whose redirects may sit inside quotes.
  for (const body of substitutions(src)) out.push(...redirectTargets(body))
  // `bash -c "…"` and `eval "…"` run a script whose redirects are inside quotes.
  for (const part of splitCommand(src)) {
    const w = unwrap(part)
    if (SHELLS.has(w[0])) {
      const at = w.findIndex((x, k) => k > 0 && /^-[a-z]*c$/.test(x))
      if (at > 0 && w[at + 1] !== undefined) out.push(...redirectTargets(w[at + 1]))
    } else if (w[0] === 'eval' && w.length > 1) out.push(...redirectTargets(w.slice(1).join(' ')))
  }
  return [...new Set(out)]
}

/** The first non-flag word from `from`, skipping flags (and the values of `valueFlags`). */
function verbAt(w: string[], from: number, valueFlags: Set<string> = new Set()): number {
  let i = from
  while (i < w.length && w[i].startsWith('-')) i += valueFlags.has(w[i]) ? 2 : 1
  return i
}

/** Why this one simple command writes, or null when it doesn't. */
function partWrites(part: CommandPart): string | null {
  const w = unwrap(part).filter((x) => !/^[0-9]*>|^&>/.test(x))
  const cmd = w[0]
  if (!cmd) return null
  if (WRITING_PROGRAMS.has(cmd)) return `\`${cmd}\` changes files or processes`
  if ((cmd === 'sed' || cmd === 'perl') && w.slice(1).some((a) => a === '--in-place' || a.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(a))) {
    return `\`${cmd} -i\` edits files in place`
  }
  if (cmd === 'curl' && w.slice(1).some((a) => a === '-o' || a === '-O' || a === '--output' || a === '--remote-name' || /^-[a-zA-Z]*[oO]$/.test(a))) {
    return '`curl -o` writes a file'
  }
  if (cmd === 'git') {
    const at = verbAt(w, 1, GIT_VALUE_FLAGS)
    const verb = w[at]
    const rest = w.slice(at + 1)
    if (!verb) return null
    if (GIT_WRITES.has(verb)) return `\`git ${verb}\` changes the repository`
    if (verb === 'stash' && !['list', 'show'].includes(rest[0] ?? '')) return '`git stash` changes the checkout'
    if (verb === 'branch' && rest.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream)/.test(a) || !a.startsWith('-'))) {
      return '`git branch` changes a branch'
    }
    if (verb === 'tag' && rest.some((a) => /^-(d|a|s|f)$|^--(delete|annotate|sign|force)$/.test(a) || !a.startsWith('-'))) return '`git tag` changes a tag'
    if (verb === 'config' && !rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a) || ['get', 'list'].includes(a))) {
      return '`git config` changes settings'
    }
    return null
  }
  if (PACKAGE_MANAGERS.has(cmd)) {
    const verb = w[verbAt(w, 1)]
    if (verb && PM_WRITES.has(verb)) return `\`${cmd} ${verb}\` changes installed packages`
    if (cmd === 'npm' && verb === 'pkg' && w.includes('set')) return '`npm pkg set` changes package.json'
    return null
  }
  if (cmd === 'find') {
    if (w.includes('-delete')) return '`find -delete` removes files'
    for (let k = 0; k < w.length; k++) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(w[k]) && w[k + 1]) {
        const why = partWrites(w.slice(k + 1, w.indexOf(';', k) === -1 ? undefined : w.indexOf(';', k)))
        if (why) return why
      }
    }
    return null
  }
  if (cmd === 'xargs') {
    const at = verbAt(w, 1, new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-J', '-R']))
    return at < w.length ? partWrites(w.slice(at)) : null
  }
  return null
}

/** Why a shell command writes, or null when nothing in it does. */
export function bashWrites(command: string): string | null {
  const targets = redirectTargets(command)
  if (targets.length) return `it writes to ${targets.slice(0, 2).join(', ')}`
  for (const part of splitCommand(command)) {
    const why = partWrites(part)
    if (why) return why
  }
  return null
}

/**
 * One call against the fence. A writer passes everything (the hold comes
 * next); a read-only role is refused file tools and any Bash that writes.
 */
export function roleFenceDecision(f: RoleFence, toolName: string, input: unknown): FenceDecision {
  if (f.write) return { allow: true }
  if (FILE_WRITE_TOOLS.has(toolName)) return { allow: false, reason: `a read-only ${f.role} may not change files (${toolName})` }
  if (toolName === 'Bash') {
    const cmd = input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : ''
    const why = bashWrites(cmd)
    if (why) return { allow: false, reason: `a read-only ${f.role} may not change files or processes: ${why}. Report what should change instead.` }
  }
  return { allow: true }
}
