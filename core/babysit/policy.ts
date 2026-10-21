/**
 * What a babysit task's session may send on its own (plan artifact f39a3a5e,
 * "Push policy"). Your own PR branch is yours to change, so:
 *
 *   free     git push to the PR's head branch, --force-with-lease included;
 *            replying to and resolving the bot thread the task is about
 *   refused  plain --force, deleting or mirroring, pushing anything else,
 *            an implicit push (the worktree's local branch isn't the PR's)
 *   held     every other send (a comment, a reviewer request, a merge):
 *            it waits for your OK like any action
 *
 * A first-pass review (core/review) is read-only: every send is refused,
 * since posting the review is a task on you, not something it does.
 *
 * Pure: the command is sorted part by part by the caller's rules.
 */
import { pushTarget, splitCommand, unwrap, type CommandPart } from '../actions/bash.js'
import type { SortedAction } from '../actions/sort.js'

export type TaskRunScope = {
  /** the PR's head branch on origin */
  headRef: string
  /** the repo's default branch: never pushed to */
  defaultBranch: string
  /** the bot review thread this task is about, when it is one */
  threadId?: string | null
  /** a first-pass review: nothing may be sent at all, not even a push */
  readOnly?: boolean
}

export type RunVerdict = { verdict: 'allow' } | { verdict: 'hold' } | { verdict: 'refuse'; reason: string }

const THREAD_MUTATIONS = /\b(resolveReviewThread|addPullRequestReviewThreadReply)\b/
const OTHER_MUTATION = /\bmutation\b[\s\S]*\{\s*(\w+)\s*\(/

function pushVerdict(part: CommandPart, s: TaskRunScope): RunVerdict {
  const w = unwrap(part)
  const push = `git push origin HEAD:${s.headRef}`
  if (w.some((t) => t === '--force' || t === '-f' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) && !t.startsWith('--')))
    return { verdict: 'refuse', reason: `Plain --force can overwrite someone else's push. Use \`git push --force-with-lease origin HEAD:${s.headRef}\`.` }
  if (w.some((t) => ['--delete', '-d', '--mirror', '--all', '--tags', '--prune'].includes(t)))
    return { verdict: 'refuse', reason: `Only pushes of this PR's branch run on their own. Use \`${push}\`.` }
  if (w.some((t, i) => i > w.indexOf('push') && t.startsWith('+')))
    return { verdict: 'refuse', reason: `A +refspec is a plain force push. Use \`git push --force-with-lease origin HEAD:${s.headRef}\`.` }
  const target = pushTarget(part)
  if (!target) return { verdict: 'refuse', reason: `Name the PR's branch: \`${push}\`. This worktree's local branch isn't the PR's.` }
  if (target === s.defaultBranch || s.headRef === s.defaultBranch) return { verdict: 'refuse', reason: `${target} is the default branch: never pushed to from a task.` }
  if (target !== s.headRef) return { verdict: 'refuse', reason: `This task may push only to the PR's branch, ${s.headRef}: \`${push}\`.` }
  return { verdict: 'allow' }
}

function threadVerdict(part: CommandPart, s: TaskRunScope): RunVerdict {
  const text = part.join(' ')
  if (!s.threadId || !THREAD_MUTATIONS.test(text) || !text.includes(s.threadId)) return { verdict: 'hold' }
  // one mutation per call, and only the two thread ones
  const m = OTHER_MUTATION.exec(text)
  if (m && !THREAD_MUTATIONS.test(m[1]!)) return { verdict: 'hold' }
  return { verdict: 'allow' }
}

/**
 * One Bash command from a task's session. Each part that sorts as an action
 * must be free for the whole command to run; a refused part refuses it, any
 * other action holds it.
 */
export function taskRunVerdict(command: string, s: TaskRunScope, sortPart: (part: string) => SortedAction | null): RunVerdict {
  let held = false
  for (const part of splitCommand(command)) {
    const sorted = sortPart(part.join(' '))
    if (!sorted) continue
    if (s.readOnly) return { verdict: 'refuse', reason: 'A first-pass review is read-only: nothing is pushed or sent from here. Hand in with submit_review; posting is the user’s call.' }
    const v = sorted.kind === 'push' ? pushVerdict(part, s) : sorted.kind === 'other' || sorted.kind === 'comment' || sorted.kind === 'update' ? threadVerdict(part, s) : { verdict: 'hold' as const }
    if (v.verdict === 'refuse') return v
    if (v.verdict === 'hold') held = true
  }
  return held ? { verdict: 'hold' } : { verdict: 'allow' }
}
