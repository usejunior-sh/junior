/**
 * The run fence: one decision per tool call,
 * wired in as a PreToolUse hook on every job run. It is the real fence:
 * the allowlist keeps granted tools from prompting, this denies everything
 * else, including tools the user's own global allow rules would let through.
 * Server-only (node:path).
 */
import path from 'node:path'
import { hasBuiltin, runAllowedTools, type RunOutput, type JobToolGrant } from './tools.js'

export type Fence = {
  /** exact tool names allowed (non-Bash, non-pattern) */
  exact: Set<string>
  /** allowed Bash command prefixes, e.g. "gh pr list" */
  bash: string[]
  /** file tools read here; always the project folder */
  root: string
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
): Fence {
  const exact = new Set<string>(['TodoWrite'])
  const bash: string[] = []
  for (const t of runAllowedTools(grants, output)) {
    const m = /^Bash\((.+):\*\)$/.exec(t)
    if (m) bash.push(m[1])
    else exact.add(t)
  }
  return {
    exact,
    bash,
    root: path.resolve(root),
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
    return ok ? { allow: true } : { allow: false, reason: `this job may only run: ${f.bash.join(', ') || 'no shell commands'}` }
  }

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'Write' || toolName === 'Edit') {
    if ((toolName === 'Write' || toolName === 'Edit') && !f.write) {
      return { allow: false, reason: 'this job may not write files' }
    }
    if (!f.exact.has(toolName) && !(f.write && (toolName === 'Write' || toolName === 'Edit'))) {
      return { allow: false, reason: `${toolName} is not granted to this job` }
    }
    const target = toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' ? str('file_path') : str('path')
    if (target !== undefined && !inside(f.root, target)) {
      return { allow: false, reason: `outside this job's folder (${f.root})` }
    }
    if (toolName === 'Glob') {
      const pat = str('pattern') ?? ''
      if (path.isAbsolute(pat) && !inside(f.root, pat.replace(/[*?[{].*$/, ''))) {
        return { allow: false, reason: `outside this job's folder (${f.root})` }
      }
    }
    return { allow: true }
  }

  // Exact names only: allowing `triage:x` must not let a bare `x` through. That can be another skill.
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
