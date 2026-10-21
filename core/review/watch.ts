/**
 * The review playbook's watch (M3 plan artifact 44f4c284): a request for your
 * review becomes one "Review first pass" task on the PR's item. Junior reads
 * the PR and hands in a verdict, a summary and suggested comments; posting
 * them is a task on you ("Post review"), held for your OK.
 *
 * One pass per request: the task's key is the request's GitHub event, so a
 * poll that reads the same request again adds nothing, and a re-request (a
 * new event) adds a fresh pass. New commits alone don't.
 *
 * Pure: no I/O, no clock.
 */
import type { TaskSpec } from '../babysit/watch.js'
import type { ReviewPr } from './pr.js'

/** The steps this playbook adds: Junior's pass, and your post. */
export const REVIEW_STEP = 'review'
export const POST_REVIEW_STEP = 'post-review'
export const REVIEW_STEPS: ReadonlySet<string> = new Set([REVIEW_STEP, POST_REVIEW_STEP])

/** What the watch remembers about one PR between polls: what the runner checks out. */
export type ReviewWatch = {
  headSha: string
  headRef: string
  baseRef: string
  /** the request the last task was added for */
  requestId: string | null
}

export const watchOf = (pr: ReviewPr): ReviewWatch => ({ headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef, requestId: pr.request?.id ?? null })

/**
 * The first-pass task for the PR's current request. Without a request event
 * (one older than the timeline the query reads) the key falls back to the
 * head: still once, never once per poll.
 */
export function reviewTask(pr: ReviewPr): TaskSpec {
  const by = pr.request?.by
  return {
    title: 'Review first pass',
    owner: 'junior',
    why: 'playbook',
    whyDetail: by ? `${by} requested your review` : 'review requested',
    step: REVIEW_STEP,
    key: pr.request ? `review:${pr.request.id}` : `review:${pr.headSha}`,
    input: { sha: pr.headSha, requestId: pr.request?.id ?? null, requestedBy: by ?? null, author: pr.author },
  }
}

/** Polls: every 2 minutes, so a request has its pass within the 10 the milestone allows. */
export const REVIEW_POLL_MS = 2 * 60_000

/** A task the watch stops when the request is gone (you reviewed, it was withdrawn, merged or closed). */
export const stopsWhenGone = (t: { step?: string; state: string }) => !!t.step && REVIEW_STEPS.has(t.step) && (t.state === 'queued' || t.state === 'waiting')
