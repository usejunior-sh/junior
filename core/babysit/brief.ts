/**
 * The first message of a babysit task's session: who it is, the PR, the
 * rules of the road, what the item already knows, the one task, and how to
 * hand in. Each task is a short fresh session, so this is all it knows.
 *
 * Pure. The runner fetches the log and the diff.
 */
import { memoryBlock, type ItemMemory } from '../work/fields.js'
import type { ItemTask } from '../work/tasks.js'
import type { CiStep, LocalChecks } from './ci-steps.js'
import { MAX_FIX_ATTEMPTS, triageThreadsOf } from './watch.js'

export type TaskPr = { repo: string; number: number; url: string; headRef: string; baseRef: string }

/** How much of a CI log or a diff goes in: the end of a log, the start of a diff. */
export const LOG_CHARS = 12_000
export const DIFF_CHARS = 12_000

const tail = (s: string, n: number) => (s.length > n ? `…(earlier output cut)\n${s.slice(-n)}` : s)
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(rest cut: run \`gh pr diff\`)` : s)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * What a task session reads before it starts: the failed log, the PR diff,
 * the CI job's steps sorted (fix-ci), and the repo's .junior/ rules
 * (core/work/contract-apply.ts repoNotes).
 */
export type TaskCtx = { log?: string; diff?: string; local?: LocalChecks; repoNotes?: readonly string[] }

/** The line a fix-ci hand-in starts with when the job's checks passed here. */
export const CHECKED_LOCALLY = "Checked locally with the CI job's steps"

const where = (s: CiStep) => (s.cwd ? ` (in ${s.cwd})` : '')
const MAX_SKIPPED = 12

/**
 * The fix-ci section on checking locally: the CI job's runnable steps to run
 * here before pushing, the rest listed as skipped, and the line to hand in.
 * Only steps ci-steps.ts sorted as plain checks are named: CI's other steps
 * are arbitrary shell (deploys, releases, secrets) and never run here.
 */
export function localChecksSection(local: LocalChecks): string[] {
  if (!local.job)
    return [
      '### Check locally before you push',
      `The CI job behind this check wasn't found: ${local.why}. Don't run CI's own steps by hand. If package.json has a test or lint script, run it here before you push.`,
      `In your done line, say "${CHECKED_LOCALLY}" only if you ran them; otherwise say "Not checked locally" and why.`,
    ]
  const { job } = local
  const run = job.steps.filter((s) => s.runnable)
  const skipped = job.steps.filter((s) => !s.runnable && !s.setup)
  const setup = job.steps.find((s) => s.setup)
  const matrix = job.matrix ? ` with ${Object.entries(job.matrix).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''
  const skippedLines = [
    ...skipped.slice(0, MAX_SKIPPED).map((s) => `- ${s.label}${s.command && s.command !== s.label ? `: \`${s.command}\`` : ''} (${s.why ?? 'not a check'})`),
    ...(skipped.length > MAX_SKIPPED ? [`- and ${skipped.length - MAX_SKIPPED} more`] : []),
  ]
  const head = [`### Check locally before you push`, `The check is the job \`${job.jobId}\` in ${job.file}${matrix}.`]
  if (!run.length)
    return [
      ...head,
      "None of its steps is a plain check you may run on this Mac, so don't run them. Push your fix and let CI check it.",
      ...(skippedLines.length ? ['', "Skipped, not a check:", ...skippedLines] : []),
      '',
      `In your done line, say "Not checked locally: the CI job has no plain check steps".`,
    ]
  return [
    ...head,
    `Run these steps here, in order, before you push. Push only once they pass. If this worktree has no dependencies yet, install them first${setup?.command ? ` the way CI does (\`${setup.command}\`${where(setup)})` : ''}.`,
    ...run.map((s, i) => `${i + 1}. \`${s.command}\`${where(s)}`),
    ...(skippedLines.length ? ['', "Skipped, not a check (don't run these: they may deploy, publish or need CI's secrets):", ...skippedLines] : []),
    '',
    `In your done line, say "${CHECKED_LOCALLY}" when they pass. If one can't run here (it needs a service or a tool CI has), push anyway and say "Not checked locally" and why.`,
  ]
}

/** The task's own section. */
function taskSection(t: ItemTask, pr: TaskPr, ctx: TaskCtx): string[] {
  const input = t.input ?? {}
  switch (t.step) {
    case 'fix-ci':
      return [
        `CI check "${str(input.check)}" fails on the PR's head (${str(input.sha).slice(0, 7)}). Fix it. This is fix ${Number(input.attempt) || 1} of ${MAX_FIX_ATTEMPTS}; after that the user is asked.`,
        input.url ? `Check: ${str(input.url)}` : '',
        '',
        ctx.local
          ? "Find the cause in the log, fix it here, check it locally (below), commit, and push. Fix the cause, not the test: don't skip, weaken or delete a test to make it pass. If the failure isn't caused by this PR, don't change anything: hand in blocked and say why."
          : "Find the cause in the log, fix it here, run the check locally if you can, commit, and push. Fix the cause, not the test: don't skip, weaken or delete a test to make it pass. If the failure isn't caused by this PR, don't change anything: hand in blocked and say why.",
        '',
        ...(ctx.local ? [...localChecksSection(ctx.local), ''] : []),
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
        ...(str(input.triage) ? [`Your triage of this comment said fix: ${str(input.triage)}`, ''] : []),
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

export function taskPrompt(t: ItemTask, pr: TaskPr, memory: ItemMemory | undefined, ctx: TaskCtx = {}): string {
  const mem = memoryBlock(memory)
  return [
    `You are Junior, babysitting the user's PR ${pr.repo}#${pr.number} (${pr.url}) until it's ready for review. One task this session: **${t.title}**.`,
    '',
    '## How you work here',
    `- This folder is your own worktree, on a local branch made from origin/${pr.headRef}. The user's checkout is never touched.`,
    `- Push with \`git push origin HEAD:${pr.headRef}\` (after a rebase: \`git push --force-with-lease origin HEAD:${pr.headRef}\`). Those run without asking. Plain --force, other branches and implicit pushes are refused.`,
    "- Anything else that reaches a person (a PR comment, a reviewer request, marking ready, a merge) is held for the user's OK. Don't try those here.",
    '- Keep the change to what the task needs. One commit with a plain message is best.',
    ...(ctx.repoNotes?.length ? ['', ...ctx.repoNotes] : []),
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

/**
 * The first message of a bot triage session (core/babysit/watch.ts,
 * TRIAGE_BOT_STEP): the PR, the new bot comments, a verdict per thread, and
 * the typed hand-in. It reads only: no push, no reply, no resolve. Fix
 * verdicts become fix tasks; the drafted replies wait for the user.
 */
export function triagePrompt(t: ItemTask, pr: TaskPr, memory: ItemMemory | undefined, ctx: Pick<TaskCtx, 'diff'> = {}): string {
  const mem = memoryBlock(memory)
  const threads = triageThreadsOf(t.input)
  return [
    `You are Junior, babysitting the user's PR ${pr.repo}#${pr.number} (${pr.url}). One task this session: **${t.title}**.`,
    '',
    '## How you work here',
    `- This folder is your own worktree at the PR's head (origin/${pr.headRef}). Read anything here. Change nothing.`,
    '- Nothing is pushed, posted, replied to or resolved from this session. The replies you draft wait for the user.',
    ...(mem ? ['', mem] : []),
    '',
    '## The comments',
    ...threads.flatMap((th, i) => [
      `### ${i + 1}. ${th.bot ?? th.author}${th.path ? ` on ${th.path}` : ''}${th.rule && th.rule !== 'general' ? ` (${th.rule})` : ''}`,
      `threadId: \`${th.id}\``,
      ...(th.url ? [th.url] : []),
      '',
      ...th.body.trim().split('\n').map((l) => `> ${l}`),
      '',
    ]),
    '## Pick one verdict per comment',
    'Check each claim against the code before you decide.',
    '- `fix`: the finding is right and worth changing in this PR. A separate task fixes it.',
    "- `wont-fix`: it may be right, but it isn't worth changing here. Draft a short reply to the bot that says why.",
    '- `incorrect`: the finding is wrong. Draft a short reply that says why, pointing at the code.',
    'Unsure? Pick `fix`. A wrong fix costs one task; a wrong "won\'t fix" can drop a real bug.',
    'A reply is plain and polite, a sentence or two, as the user would write it. The user reads it before it goes out.',
    '',
    '### The PR diff',
    '```diff',
    head((ctx.diff ?? '').trim(), DIFF_CHARS) || `(no diff came back: run \`gh pr diff ${pr.number} -R ${pr.repo}\`)`,
    '```',
    '',
    '## When you finish',
    'Call `submit_triage` once, with one entry per threadId above: `verdict`, a `reply` for wont-fix and incorrect, and `why` in one line.',
    'A comment you leave out, or a wont-fix or incorrect without a reply, is fixed.',
    'Add `decisions` for anything the next task on this PR should know. Then end your turn.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}
