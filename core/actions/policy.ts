/**
 * One policy for chats and runs (Triage for engineers, M2): free unless it
 * reaches a person. Local work runs; a command that destroys work asks; a
 * send waits on a card for your OK, now or in advance.
 *
 * What is free from the shell, though it leaves this machine, because it
 * stays yours:
 *
 *   a push to a branch that isn't the default one (--force-with-lease
 *   included: rebasing your own branch is yours to do)
 *   opening a draft PR (nobody is asked to look at it yet)
 *
 * Plain --force, deleting or mirroring, and anything to the default branch
 * are held like any send.
 *
 * Pure and browser-safe.
 */
import type { PermissionMode, ProviderId } from '../../shared/protocol.js'
import { pushTarget, splitCommand, unwrap, type CommandPart } from './bash.js'
import type { SortedAction } from './sort.js'

/**
 * The mode every chat runs at. Claude: local work runs, sends are held by the
 * veto. Another agent has no hooks to hold a send with, so it asks before
 * every change instead.
 */
export const chatPermissionMode = (provider: ProviderId | null | undefined): PermissionMode => ((provider ?? 'claude') === 'claude' ? 'auto' : 'gated')

/** Where a session's shell stands: what a free push is judged against. */
export type BranchScope = {
  /** the checked-out branch, null when detached or unknown */
  current: string | null
  /** the repo's default branch, null when unknown (then main and master count as default) */
  defaultBranch: string | null
}

/** Why a send from the shell is free, or null when it is held. */
export type FreeWhy = 'your branch' | 'draft PR'

const FORCE_RE = /^-[a-zA-Z]*f[a-zA-Z]*$/
const WIDE_PUSH = ['--delete', '-d', '--mirror', '--all', '--tags', '--prune']

function isDefault(branch: string, s: BranchScope): boolean {
  return s.defaultBranch ? branch === s.defaultBranch : branch === 'main' || branch === 'master'
}

function freePush(part: CommandPart, s: BranchScope): boolean {
  const w = unwrap(part)
  const at = w.indexOf('push')
  if (at === -1) return false
  const rest = w.slice(at + 1)
  if (rest.some((t) => t === '--force' || (FORCE_RE.test(t) && !t.startsWith('--')))) return false
  if (rest.some((t) => WIDE_PUSH.includes(t) || t.startsWith('+') || t.startsWith(':'))) return false
  // Named (`origin feat`, `HEAD:feat`) or implicit: the checked-out branch, only
  // when git runs in the session's own folder.
  const elsewhere = w.slice(0, at).some((t) => t === '-C' || t.startsWith('--git-dir') || t.startsWith('--work-tree'))
  const target = pushTarget(part) ?? (elsewhere ? null : s.current)
  return !!target && !isDefault(target, s)
}

const freeDraft = (part: CommandPart): boolean => unwrap(part).some((t) => t === '--draft' || t === '-d')

/**
 * Why one simple command that sorted as an action is free anyway, or null.
 * `kind` is how the actions file sorted it.
 */
export function freeSend(part: CommandPart, kind: SortedAction['kind'], s: BranchScope): FreeWhy | null {
  if (kind === 'push') return freePush(part, s) ? 'your branch' : null
  if (kind === 'pr') {
    const w = unwrap(part)
    return w[0] === 'gh' && w[1] === 'pr' && w[2] === 'create' && freeDraft(part) ? 'draft PR' : null
  }
  return null
}

/**
 * One Bash command from a chat. Every part that sorts as an action must be
 * free for the command to run; otherwise the whole command is held. Returns
 * why it is free when it sends something free, `null` when nothing in it
 * sends, and 'hold' when it waits on you.
 */
export function chatBashVerdict(command: string, s: BranchScope, sortPart: (part: string) => SortedAction | null): { verdict: 'allow'; free: FreeWhy | null } | { verdict: 'hold' } {
  let free: FreeWhy | null = null
  const parts = splitCommand(command)
  // A `cd` first: the checked-out branch we know is the wrong folder's.
  if (parts.some((p) => unwrap(p)[0] === 'cd' || unwrap(p)[0] === 'pushd')) s = { ...s, current: null }
  for (const part of parts) {
    const sorted = sortPart(part.join(' '))
    if (!sorted) continue
    const why = freeSend(part, sorted.kind, s)
    if (!why) return { verdict: 'hold' }
    free ??= why
  }
  return { verdict: 'allow', free }
}

/**
 * A command that reaches triage's own approval endpoints: approving a held
 * send, adding an advance approval, approving a task, marking a tool "not an
 * action". Only the user does those, from the app. A speed bump for an agent,
 * not a wall: anything running as you can reach the daemon.
 */
export const selfApproval = (command: string): boolean => /\/api\/(approvals\b|actions\/(approve|override|retry)\b|tasks\/approve\b)/.test(command)

/** A push or a PR open: the only sends the shell may make free. Anything else needs no branch lookup. */
export const mayBeFree = (command: string): boolean => /\bgit\b[\s\S]*\bpush\b|\bgh\s+pr\s+create\b/.test(command)
