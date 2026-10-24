/**
 * Who Junior suggests as the reviewer: whoever reviewed most of your last
 * merged PRs in that repo, the most recent breaking a tie. A reviewer you
 * pick yourself wins from then on. Between the two sit the repo's own
 * reviewers (`reviewers:` in `.junior/junior.md`, by the paths the PR
 * changed): what a teammate wrote down beats what Junior guessed, never
 * what you picked. Pure: the query text, the pick, the commands the
 * request runs.
 */

export const REVIEWERS_QUERY = `query($q: String!) {
  prs: search(query: $q, type: ISSUE, first: 20) { nodes { ... on PullRequest {
    mergedAt
    reviews(first: 20) { nodes { author { __typename login } } }
  } } }
}`

export const reviewersSearch = (login: string, repo: string) => `is:pr is:merged author:${login} repo:${repo} sort:updated-desc`

/** Learned reviewers, per repo, in config. */
export const REVIEWERS_KEY = 'babysit.reviewers'
export type LearnedReviewer = { login: string; at: number; by: 'junior' | 'you' }
/** A learned pick is read again after a day; yours never expires. */
export const REVIEWER_TTL_MS = 24 * 60 * 60_000

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export function pickReviewer(data: unknown, me: string): string | null {
  const nodes = ((data as J)?.data?.prs?.nodes ?? []) as J[]
  const count = new Map<string, { n: number; last: number }>()
  for (const pr of nodes) {
    const at = Date.parse(String(pr?.mergedAt ?? '')) || 0
    const seen = new Set<string>()
    for (const r of (pr?.reviews?.nodes ?? []) as J[]) {
      const login = r?.author?.login
      if (typeof login !== 'string' || r.author.__typename === 'Bot' || login.endsWith('[bot]') || login === me || seen.has(login)) continue
      seen.add(login)
      const c = count.get(login) ?? { n: 0, last: 0 }
      count.set(login, { n: c.n + 1, last: Math.max(c.last, at) })
    }
  }
  let best: [string, { n: number; last: number }] | null = null
  for (const e of count) if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].last > best[1].last)) best = e
  return best?.[0] ?? null
}

/** The stored pick, if it still holds. */
export function learnedFresh(l: LearnedReviewer | undefined, now: number): string | null {
  if (!l) return null
  return l.by === 'you' || now - l.at < REVIEWER_TTL_MS ? l.login : null
}

/**
 * The reviewer to suggest before learning one: yours when you picked one,
 * else the first of the repo's reviewers for this PR's paths that isn't you
 * (core/work/contract.ts reviewersFor). null = fall back to learning.
 */
export function chosenReviewer(stored: LearnedReviewer | undefined, fromRepo: readonly string[], me: string): string | null {
  if (stored?.by === 'you') return stored.login
  const self = me.trim().toLowerCase()
  return fromRepo.find((l) => l.toLowerCase() !== self && isReviewerLogin(l)) ?? null
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$|^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/

export const isReviewerLogin = (s: string) => LOGIN_RE.test(s)

/** The `gh` commands a request runs, in order. A draft is marked ready first. */
export function requestCommands(pr: { repo: string; number: number }, reviewer: string, draft: boolean): string[][] {
  if (!isReviewerLogin(reviewer)) throw new Error(`"${reviewer}" isn't a GitHub login or team`)
  return [
    ...(draft ? [['pr', 'ready', String(pr.number), '-R', pr.repo]] : []),
    ['pr', 'edit', String(pr.number), '-R', pr.repo, '--add-reviewer', reviewer],
  ]
}
