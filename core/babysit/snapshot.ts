/**
 * One PR as a snapshot: state, head, mergeability, review, checks on the
 * head commit and review threads, parsed from GitHub's GraphQL answer. The
 * babysit search (pr.ts) reads PRs through it.
 *
 * Pure: no I/O, no clock. Browser-safe.
 */
import { checkFrom, type PrCheck, type PrThread } from './ci.js'

/** A PR: `owner/repo` and its number. */
export type PrRef = { repo: string; number: number }

export type PrSnapshot = {
  repo: string
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headSha: string
  baseRef: string
  headRef: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** null = the repo requires no review */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: PrCheck[]
  threads: PrThread[]
  /** who closed it, when it is closed */
  closedBy: string | null
}

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** A `repository.pullRequest` answer → a snapshot. Throws when the PR isn't there. */
export function snapshotFrom(pr: PrRef, data: J): PrSnapshot {
  const p = data?.data?.repository?.pullRequest
  if (!p) throw new Error(`PR ${pr.repo}#${pr.number} not found`)
  const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup
  const checks = ((rollup?.contexts?.nodes ?? []) as J[]).map(checkFrom).filter((c): c is PrCheck => c !== null)
  const threads: PrThread[] = ((p.reviewThreads?.nodes ?? []) as J[]).map((t) => {
    const c = t.comments?.nodes?.[0] ?? {}
    const login = String(c.author?.login ?? 'ghost')
    return { id: String(t.id), author: login, isBot: c.author?.__typename === 'Bot' || login.endsWith('[bot]'), resolved: !!t.isResolved, path: t.path ?? null, body: String(c.body ?? ''), url: c.url ?? null, ...(typeof t.line === 'number' ? { line: t.line } : {}) }
  })
  const state = p.state === 'MERGED' || p.state === 'CLOSED' ? p.state : 'OPEN'
  const mergeable = p.mergeable === 'MERGEABLE' || p.mergeable === 'CONFLICTING' ? p.mergeable : 'UNKNOWN'
  const review = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(p.reviewDecision) ? p.reviewDecision : null
  return {
    repo: pr.repo,
    number: pr.number,
    url: String(p.url ?? ''),
    state,
    headSha: String(p.headRefOid ?? ''),
    baseRef: String(p.baseRefName ?? ''),
    headRef: String(p.headRefName ?? ''),
    mergeable,
    reviewDecision: review,
    checks,
    threads,
    closedBy: p.timelineItems?.nodes?.[0]?.actor?.login ?? null,
  }
}
