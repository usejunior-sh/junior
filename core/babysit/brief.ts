/**
 * The first message of a babysit task's session: who it is, the PR, the
 * rules of the road, what the item already knows, the one task, and how to
 * hand in. Each task is a short fresh session, so this is all it knows.
 *
 * Pure. The runner fetches the log and the diff.
 */
import { memoryBlock, type ItemMemory } from '../work/fields.js'
import type { ItemTask } from '../work/tasks.js'
import { MAX_FIX_ATTEMPTS } from './watch.js'

export type TaskPr = { repo: string; number: number; url: string; headRef: string; baseRef: string }

/** How much of a CI log or a diff goes in: the end of a log, the start of a diff. */
export const LOG_CHARS = 12_000
export const DIFF_CHARS = 12_000

const tail = (s: string, n: number) => (s.length > n ? `…(earlier output cut)\n${s.slice(-n)}` : s)
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(rest cut: run \`gh pr diff\`)` : s)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The task's own section. */
function taskSection(t: ItemTask, pr: TaskPr, ctx: { log?: string; diff?: string }): string[] {
  const input = t.input ?? {}
  switch (t.step) {
    case 'fix-ci':
      return [
        `CI check "${str(input.check)}" fails on the PR's head (${str(input.sha).slice(0, 7)}). Fix it. This is fix ${Number(input.attempt) || 1} of ${MAX_FIX_ATTEMPTS}; after that the user is asked.`,
        input.url ? `Check: ${str(input.url)}` : '',
        '',
        "Find the cause in the log, fix it here, run the check locally if you can, commit, and push. Fix the cause, not the test: don't skip, weaken or delete a test to make it pass. If the failure isn't caused by this PR, don't change anything: hand in blocked and say why.",
        '',
        '### Failing log',
        '```',
        tail((ctx.log ?? '').trim(), LOG_CHARS) || '(no log came back: open the check link, or run `gh run view --log-failed`)',
        '```',
        '',
        '### The PR diff',
        '```diff',
        head((ctx.diff ?? '').trim(), DIFF_CHARS) || `(no diff came back: run \`gh pr diff ${pr.number} -R ${pr.repo}\`)`,
        '```',
      ]
    case 'fix-thread': {
      const id = str(input.threadId)
      const reply = `gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}' -f id=${id} -f body='<reply>'`
      const resolve = `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=${id}`
      return [
        `A review bot (${str(input.author)}) left this${input.path ? ` on ${str(input.path)}` : ''}:`,
        str(input.url),
        '',
        ...str(input.body).trim().split('\n').map((l) => `> ${l}`),
        '',
        'Decide whether the finding is right.',
        `- Right: fix it, commit, push, then reply on the thread with "Fixed in <short sha>" and one line on what changed, and resolve it:`,
        `  \`${reply}\``,
        `  \`${resolve}\``,
        "- Wrong (a false positive): change nothing, don't reply, don't resolve. Hand in blocked with your reasoning: the user decides.",
      ]
    }
    case 'rebase':
      return [
        `The PR ${input.why === 'conflict' ? 'conflicts with' : 'is behind'} ${pr.baseRef}. Rebase it:`,
        `\`git fetch origin ${pr.baseRef} && git rebase origin/${pr.baseRef}\`. Resolve each conflict keeping both sides' intent, run the tests, then`,
        `\`git push --force-with-lease origin HEAD:${pr.headRef}\`.`,
        'If a conflict needs a product decision, `git rebase --abort` and hand in blocked with the question.',
      ]
    default:
      return [t.title]
  }
}

export function taskPrompt(t: ItemTask, pr: TaskPr, memory: ItemMemory | undefined, ctx: { log?: string; diff?: string } = {}): string {
  const mem = memoryBlock(memory)
  return [
    `You are Junior, babysitting the user's PR ${pr.repo}#${pr.number} (${pr.url}) until it's ready for review. One task this session: **${t.title}**.`,
    '',
    '## How you work here',
    `- This folder is your own worktree, on a local branch made from origin/${pr.headRef}. The user's checkout is never touched.`,
    `- Push with \`git push origin HEAD:${pr.headRef}\` (after a rebase: \`git push --force-with-lease origin HEAD:${pr.headRef}\`). Those run without asking. Plain --force, other branches and implicit pushes are refused.`,
    "- Anything else that reaches a person (a PR comment, a reviewer request, marking ready, a merge) is held for the user's OK. Don't try those here.",
    '- Keep the change to what the task needs. One commit with a plain message is best.',
    ...(mem ? ['', mem] : []),
    '',
    '## The task',
    ...taskSection(t, pr, ctx),
    '',
    '## When you finish',
    'Call `submit_task` once:',
    '- `done`, with one line on what you changed ("removed the unused import in api.ts") and the commit you pushed, or',
    '- `blocked`, with the question the user has to answer.',
    'Add `decisions` for anything the next task on this PR should know.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}
