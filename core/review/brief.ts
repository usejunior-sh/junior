/**
 * A first-pass review: what Junior hands in (verdict · summary · suggested
 * comments), how it reads on the item (the Review artifact, the task's line),
 * and the first message of the session that writes it. The session is
 * read-only: it reads the PR and the code around it, changes nothing, sends
 * nothing. Posting is a task on you.
 *
 * Pure. The runner fetches the PR's text and diff.
 */
import { memoryBlock, type ItemMemory } from '../work/fields.js'
import type { ItemTask } from '../work/tasks.js'

export type Verdict = 'approve' | 'comment' | 'request_changes'
export const VERDICTS: readonly Verdict[] = ['approve', 'comment', 'request_changes']
export const isVerdict = (v: unknown): v is Verdict => typeof v === 'string' && (VERDICTS as readonly string[]).includes(v)

/** One suggested inline comment: on the new side of the diff unless `side` says LEFT. */
export type ReviewComment = { path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string }

export type FirstPass = {
  verdict: Verdict
  /** 2–4 lines: what the PR does and what matters */
  summary: string
  comments: ReviewComment[]
  /** what it didn't read, on a big PR */
  skipped?: string
  /** the head it reviewed */
  sha: string
}

export const MAX_COMMENTS = 15

export const VERDICT_LABEL: Record<Verdict, string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const firstLine = (s: string) => s.trim().split('\n')[0]!.trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The task's output line: "Request changes · 3 comments · Caches the token per user". */
export function passLine(p: Pick<FirstPass, 'verdict' | 'summary' | 'comments'>): string {
  return clip([VERDICT_LABEL[p.verdict], ...(p.comments.length ? [plural(p.comments.length, 'comment')] : []), firstLine(p.summary)].join(' · '), 300)
}

export type ReviewPrRef = { repo: string; number: number; url: string; title: string; author: string }

/** The Review artifact on the item. */
export function passMarkdown(pr: ReviewPrRef, p: FirstPass): string {
  const out = [
    `# Review: ${pr.repo}#${pr.number}`,
    '',
    `**${pr.title}** by ${pr.author} · [open on GitHub](${pr.url}) · reviewed at \`${p.sha.slice(0, 7)}\``,
    '',
    `**Verdict:** ${VERDICT_LABEL[p.verdict]}`,
    '',
    '## Summary',
    '',
    p.summary.trim(),
  ]
  if (p.comments.length) {
    out.push('', '## Suggested comments')
    for (const c of p.comments) out.push('', `### \`${c.path}:${c.line}\`${c.side === 'LEFT' ? ' (old side)' : ''}`, '', c.body.trim())
  }
  if (p.skipped?.trim()) out.push('', '## Not read', '', p.skipped.trim())
  out.push('', '_A first pass by Junior. Nothing is posted until you OK it on the item._')
  return out.join('\n')
}

/** How much of the diff goes in: the rest is a `gh pr diff` away. */
export const REVIEW_DIFF_CHARS = 60_000
export const BODY_CHARS = 4_000

export type ReviewCtx = { title: string; body: string; author: string; diff: string; files?: string }

export function reviewPrompt(t: ItemTask, pr: { repo: string; number: number; url: string; headRef: string; baseRef: string }, memory: ItemMemory | undefined, ctx: ReviewCtx): string {
  const mem = memoryBlock(memory)
  const by = typeof t.input?.requestedBy === 'string' ? t.input.requestedBy : null
  const diff = ctx.diff.trim()
  const cut = diff.length > REVIEW_DIFF_CHARS
  return [
    `You are Junior, doing a first-pass review of ${pr.repo}#${pr.number} (${pr.url}) for the user${by ? `, who ${by} asked to review it` : ''}. The user reads your pass before they review: make it the review a careful senior engineer would want to start from.`,
    '',
    '## How you work here',
    `- This folder is a worktree at the PR's head (${pr.headRef} → ${pr.baseRef}). Read anything in it: the changed files, their callers, the tests.`,
    "- Read-only. Don't edit files, commit, push, or run anything that reaches GitHub or a person: those are refused. Don't run the test suite.",
    '- Posting the review is the user\'s call, after reading yours. You only hand it in.',
    ...(mem ? ['', mem] : []),
    '',
    '## The PR',
    `**${ctx.title}** by ${ctx.author}`,
    '',
    ctx.body.trim() ? clip(ctx.body.trim(), BODY_CHARS) : '(no description)',
    ...(ctx.files?.trim() ? ['', '### Files changed', ctx.files.trim()] : []),
    '',
    '### The diff',
    '```diff',
    (cut ? `${diff.slice(0, REVIEW_DIFF_CHARS)}\n…(rest cut: run \`gh pr diff ${pr.number} -R ${pr.repo}\`)` : diff) || `(no diff came back: run \`gh pr diff ${pr.number} -R ${pr.repo}\`)`,
    '```',
    '',
    '## What to look for',
    '- Bugs first: wrong logic, missed cases, races, error paths, data loss, security.',
    '- Then whether it does what the description says, and what it breaks elsewhere (read the callers).',
    "- Tests: is the change covered where it matters?",
    "- Skip style nits a linter would catch. Don't pad: three real comments beat ten weak ones.",
    cut ? '- The diff is large: read the riskiest files first and say in `skipped` what you did not read.' : '',
    '',
    '## When you finish',
    'Call `submit_review` once:',
    '- `verdict`: approve (ready to merge as is), comment (fine, with notes), or request_changes (something must change first).',
    '- `summary`: 2–4 plain lines: what the PR does, and what matters most in your read.',
    `- \`comments\`: up to ${MAX_COMMENTS}, each on a line the diff changed or shows (path relative to the repo root, line in the new file). Write each as you would post it: direct, specific, with the fix when you know it.`,
    '- `skipped`: what you did not read, if anything.',
    'Then end your turn.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}
