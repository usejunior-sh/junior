/**
 * Review first pass reads every open PR that asks *you* for a review, in the
 * workspace's repos, in one GraphQL search: the fields the inbox files the
 * item with (core/sources/github.ts toItem) plus what the review task needs,
 * which is the head, the branches, and the latest request naming you. A
 * re-request is a new ReviewRequestedEvent, so it reads as a new request.
 *
 * `user-review-requested:` matches requests to you personally, not to a team
 * you are in (M3 plan artifact 44f4c284, decision 1).
 *
 * Pure: the query text and the parse. The server runs `gh`.
 */
import { toItem, type RawNode } from '../sources/github.js'
import type { WorkItem } from '../work/types.js'

/** The latest request for your review: GitHub's event, who asked, when. */
export type ReviewRequest = { id: string; by: string | null; at: string }

/** A PR as the review watch sees it. */
export type ReviewPr = {
  repo: string
  number: number
  author: string
  headSha: string
  headRef: string
  baseRef: string
  isDraft: boolean
  /** null when the timeline didn't show one (an old request past the last 20 events) */
  request: ReviewRequest | null
}

export const REVIEW_QUERY = (first: number) => `query($q: String!) {
  prs: search(query: $q, type: ISSUE, first: ${first}) { nodes { ... on PullRequest {
    __typename number title url isDraft createdAt updatedAt state
    repository { nameWithOwner }
    author { login }
    headRefOid headRefName baseRefName reviewDecision mergeable
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent {
      id createdAt actor { login } requestedReviewer { __typename ... on User { login } }
    } } }
  } } }
}`

/** GitHub's search query: open PRs asking you, in these repos when the qualifier fits (256 chars). */
export function reviewSearch(login: string, repos: readonly string[]): { q: string; clientFilter: boolean } {
  const base = `is:open is:pr user-review-requested:${login} archived:false`
  const qualifier = repos.map((r) => `repo:${r}`).join(' ')
  const fits = repos.length > 0 && base.length + 1 + qualifier.length <= 256
  return { q: fits ? `${base} ${qualifier}` : base, clientFilter: repos.length > 0 && !fits }
}

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** The newest request naming `login`, or null. */
export function latestRequest(timeline: unknown, login: string): ReviewRequest | null {
  const nodes = (((timeline as J)?.nodes ?? []) as J[]).filter((e) => e?.requestedReviewer?.login?.toLowerCase() === login.toLowerCase() && typeof e.id === 'string')
  const last = nodes[nodes.length - 1]
  return last ? { id: String(last.id), by: typeof last.actor?.login === 'string' ? last.actor.login : null, at: String(last.createdAt ?? '') } : null
}

/** The search's answer → the item to file and the PR to review, per open PR in `repos`. */
export function parseReview(data: unknown, repos: readonly string[], login: string): { item: WorkItem; pr: ReviewPr }[] {
  const nodes = ((data as J)?.data?.prs?.nodes ?? []) as J[]
  const out: { item: WorkItem; pr: ReviewPr }[] = []
  for (const n of nodes) {
    if (n?.__typename !== 'PullRequest' || !n.repository?.nameWithOwner || n.state !== 'OPEN') continue
    const repo = String(n.repository.nameWithOwner)
    if (repos.length > 0 && !repos.includes(repo)) continue
    if (typeof n.headRefOid !== 'string' || typeof n.headRefName !== 'string' || typeof n.baseRefName !== 'string') continue
    out.push({
      item: toItem(n as unknown as RawNode, 'review-requested', 1),
      pr: {
        repo,
        number: Number(n.number),
        author: n.author?.login ?? 'ghost',
        headSha: n.headRefOid,
        headRef: n.headRefName,
        baseRef: n.baseRefName,
        isDraft: !!n.isDraft,
        request: latestRequest(n.timelineItems, login),
      },
    })
  }
  return out
}
