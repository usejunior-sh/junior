/**
 * Babysitting reads every open PR you authored in the workspace's repos in
 * one GraphQL search: the fields the inbox files the item with (core/sources/
 * github.ts toItem) plus what the watch needs, which is the head, checks on
 * it, review threads, mergeability, and whether a review was asked for. One
 * query a minute for all PRs, not one per PR. The repo's default branch
 * rides along, so a red check can be compared with main's (ci-sort).
 *
 * Pure: the query text and the parse. The server runs `gh`.
 */
import { snapshotFrom, type PrSnapshot } from './snapshot.js'
import { classifyOwnPr, toItem, type RawNode } from '../sources/github.js'
import type { WorkItem } from '../work/types.js'

/** A PR as the babysitter sees it: the PR snapshot (snapshot.ts) and a few more facts. */
export type BabysitPr = PrSnapshot & {
  isDraft: boolean
  /** GitHub's merge state says the branch is behind its base (repos that require up to date) */
  behind: boolean
  /** a review was asked for or given already: logins and team slugs */
  reviewers: string[]
  reviewed: boolean
  /** the repo's default branch ("main"): CI red there too isn't this PR's (ci-sort); null when GitHub didn't say */
  defaultBranch: string | null
}

export const BABYSIT_QUERY = (first: number) => `query($q: String!) {
  prs: search(query: $q, type: ISSUE, first: ${first}) { nodes { ... on PullRequest {
    __typename number title url isDraft createdAt updatedAt state
    repository { nameWithOwner defaultBranchRef { name } }
    author { login }
    headRefOid headRefName baseRefName mergeable mergeStateStatus reviewDecision
    reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
    reviews(first: 1) { totalCount }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
      ... on StatusContext { id context state targetUrl createdAt }
    } } } } } }
    reviewThreads(first: 100) { nodes { id isResolved path comments(first: 1) { nodes { url body author { __typename login } } } } }
  } } }
}`

/** GitHub's search query: your open PRs, in these repos when the qualifier fits (256 chars). */
export function babysitSearch(login: string, repos: readonly string[]): { q: string; clientFilter: boolean } {
  const base = `is:open is:pr author:${login} archived:false`
  const qualifier = repos.map((r) => `repo:${r}`).join(' ')
  const fits = repos.length > 0 && base.length + 1 + qualifier.length <= 256
  return { q: fits ? `${base} ${qualifier}` : base, clientFilter: repos.length > 0 && !fits }
}

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** The search's answer → the item to file and the PR to watch, per PR in `repos`. */
export function parseBabysit(data: unknown, repos: readonly string[], now: number): { item: WorkItem; pr: BabysitPr }[] {
  const nodes = ((data as J)?.data?.prs?.nodes ?? []) as J[]
  const out: { item: WorkItem; pr: BabysitPr }[] = []
  for (const n of nodes) {
    if (n?.__typename !== 'PullRequest' || !n.repository?.nameWithOwner) continue
    const repo = String(n.repository.nameWithOwner)
    if (repos.length > 0 && !repos.includes(repo)) continue
    const raw = n as unknown as RawNode
    const item = toItem(raw, classifyOwnPr(raw, now), raw.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0)
    const snap = snapshotFrom({ repo, number: Number(n.number) }, { data: { repository: { pullRequest: n } } })
    const reviewers = ((n.reviewRequests?.nodes ?? []) as J[])
      .map((r) => r?.requestedReviewer?.login ?? r?.requestedReviewer?.slug)
      .filter((x): x is string => typeof x === 'string')
    const main = n.repository.defaultBranchRef?.name
    out.push({
      item,
      pr: {
        ...snap,
        isDraft: !!n.isDraft,
        behind: n.mergeStateStatus === 'BEHIND',
        reviewers,
        reviewed: (n.reviews?.totalCount ?? 0) > 0,
        defaultBranch: typeof main === 'string' && main ? main : null,
      },
    })
  }
  return out
}
