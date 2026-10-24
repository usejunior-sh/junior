/**
 * The run fence: one decision per tool call,
 * wired in as a PreToolUse hook on every job run. It is the real fence:
 * the allowlist keeps granted tools from prompting, this denies everything
 * else, including tools the user's own global allow rules would let through.
 * Server-only (node:path).
 */
import path from 'node:path'
import { splitCommand } from '../actions/bash.js'
import { hasBuiltin, runAllowedTools, type RunOutput, type JobToolGrant } from './tools.js'

export type Fence = {
  /** exact tool names allowed (non-Bash, non-pattern) */
  exact: Set<string>
  /** allowed Bash command prefixes, e.g. "gh pr list" */
  bash: string[]
  /** file tools read here; always the project folder */
  root: string
  /** more folders Read/Grep/Glob may look in, never write: a browser run's downloads */
  readRoots: string[]
  /** Write/Edit allowed (inside root) */
  write: boolean
  /** the skills the job names: the only ones the Skill tool may load */
  skills: Set<string>
  /** the subagents the job names: the only ones the Agent tool may start */
  agents: Set<string>
}

export function fenceFor(
  grants: JobToolGrant[],
  output: RunOutput,
  root: string,
  library: { skills?: string[]; agents?: string[] } = {},
  /** browser: the job names a profile, so its runs get the browser tools; readRoots: extra read-only folders */
  extra: { browser?: boolean; readRoots?: string[] } = {},
): Fence {
  const exact = new Set<string>(['TodoWrite'])
  const bash: string[] = []
  for (const t of runAllowedTools(grants, output, extra.browser)) {
    const m = /^Bash\((.+):\*\)$/.exec(t)
    if (m) bash.push(m[1])
    else exact.add(t)
  }
  return {
    exact,
    bash,
    root: path.resolve(root),
    readRoots: (extra.readRoots ?? []).map((r) => path.resolve(r)),
    write: hasBuiltin(grants, 'files-write'),
    skills: new Set(library.skills ?? []),
    agents: new Set(library.agents ?? []),
  }
}

export type FenceDecision = { allow: true } | { allow: false; reason: string }

const SHELL_META = /[;&|`$<>\n\r(){}\\]/

const inside = (root: string, p: string): boolean => {
  const abs = path.resolve(root, p)
  return abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Where a git command would write a file, from its words: `--output=<path>`,
 * `--output <path>` (diff, log, show), and `-o`/`--output-directory`
 * (format-patch). A long option git might take abbreviated (`--outp=`) counts
 * too. Every word is checked, not just those before `--`: a pathspec that
 * looks like an output flag is not worth the doubt.
 */
export function gitOutputTargets(words: string[]): string[] {
  if (words[0] !== 'git') return []
  const out: string[] = []
  for (let k = 1; k < words.length; k++) {
    const w = words[k]
    const long = /^--([a-z-]+)(?:=(.*))?$/s.exec(w)
    if (long && long[1].length >= 2 && 'output-directory'.startsWith(long[1])) {
      out.push(long[2] ?? words[++k] ?? '')
    } else if (w === '-o') {
      out.push(words[++k] ?? '')
    } else if (w.startsWith('-o') && !w.startsWith('--')) {
      out.push(w.slice(2))
    }
  }
  return out
}

/**
 * An output path stays in the project when it resolves inside the root. A `~`
 * (the shell may expand it, even after `=`) or a glob (it expands to who knows
 * what) is refused rather than guessed at.
 */
const outputInside = (root: string, p: string): boolean => p !== '' && !/[~*?[]/.test(p) && inside(root, p)

/**
 * Decide one tool call. Deny anything outside the grants; fence file paths to
 * the project folder; allow Bash only for a granted command prefix with no
 * shell metacharacters (no chaining, redirects, or substitution).
 */
export function fenceDecision(f: Fence, toolName: string, input: unknown): FenceDecision {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined)

  if (toolName === 'Bash') {
    const cmd = (str('command') ?? '').trim()
    if (!cmd) return { allow: false, reason: 'empty command' }
    if (SHELL_META.test(cmd)) return { allow: false, reason: 'job runs may not chain, redirect, or substitute shell commands' }
    const ok = f.bash.some((p) => cmd === p || cmd.startsWith(p + ' '))
    if (!ok) return { allow: false, reason: `this job may only run: ${f.bash.join(', ') || 'no shell commands'}` }
    // `git diff --output=/tmp/x` has no metacharacter but still writes a file: keep it in the project.
    for (const words of splitCommand(cmd)) {
      if (gitOutputTargets(words).some((t) => !outputInside(f.root, t))) {
        return { allow: false, reason: `job runs may write git output only inside this job's folder (${f.root})` }
      }
    }
    return { allow: true }
  }

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'Write' || toolName === 'Edit') {
    if ((toolName === 'Write' || toolName === 'Edit') && !f.write) {
      return { allow: false, reason: 'this job may not write files' }
    }
    if (!f.exact.has(toolName) && !(f.write && (toolName === 'Write' || toolName === 'Edit'))) {
      return { allow: false, reason: `${toolName} is not granted to this job` }
    }
    // writes stay in the project; reads may also look in the run's read-only folders
    const roots = toolName === 'Write' || toolName === 'Edit' ? [f.root] : [f.root, ...f.readRoots]
    const within = (p: string) => roots.some((r) => (path.isAbsolute(p) || r === f.root) && inside(r, p))
    const target = toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' ? str('file_path') : str('path')
    if (target !== undefined && !within(target)) {
      return { allow: false, reason: `outside this job's folder (${f.root})` }
    }
    if (toolName === 'Glob') {
      const pat = str('pattern') ?? ''
      if (path.isAbsolute(pat) && !within(pat.replace(/[*?[{].*$/, ''))) {
        return { allow: false, reason: `outside this job's folder (${f.root})` }
      }
    }
    return { allow: true }
  }

  // Exact names only: allowing `junior:x` must not let a bare `x` through. That can be another skill.
  if (toolName === 'Skill') {
    const name = (str('skill') ?? str('command') ?? '').trim().replace(/^\//, '')
    if (f.skills.has(name)) return { allow: true }
    return { allow: false, reason: f.skills.size ? `this job may only use the skills: ${[...f.skills].join(', ')}` : 'this job names no skills' }
  }
  if (toolName === 'Agent' || toolName === 'Task') {
    const type = (str('subagent_type') ?? '').trim()
    if (f.agents.has(type)) return { allow: true }
    return { allow: false, reason: f.agents.size ? `this job may only hand work to: ${[...f.agents].join(', ')}` : 'this job names no agents' }
  }

  if (f.exact.has(toolName)) return { allow: true }
  return { allow: false, reason: `${toolName} is not granted to this job` }
}
