/**
 * What babysitting reads off a PR's checks and review threads, and the two
 * tests it runs on them: does a failed log look flaky (a rerun may clear
 * it), and is this bot comment one Junior already fixed (its fingerprint).
 * Plus the cap on fix attempts per failing check.
 *
 * Shared by the babysit watch (watch.ts), the CI sort (ci-sort.ts) and the
 * goals engine's PR shepherd, so there is one flake regex and one cap. Lived
 * in core/goals/shepherd.ts and core/goals/types.ts (move-goal-helpers).
 *
 * Pure: no I/O, no clock. Browser-safe.
 */

/** 3 fix attempts per failing check, then the user; same cap as recipes' MAX_FIX_ROUNDS. */
export const MAX_FIX_ATTEMPTS = 3

/** One check on the head commit, folded from a check run or a status context. */
export type PrCheck = {
  name: string
  status: 'pending' | 'success' | 'failure' | 'neutral'
  /** changes when the check runs again (a check run's id), so a rerun's failure is new */
  id: string
  /** the Actions run behind it, for `gh run view --log-failed` and a rerun; null for a status context */
  runId: number | null
  url: string | null
  /** GitHub's own word for how it ended (TIMED_OUT, CANCELLED, …), for the flake test */
  conclusion: string | null
}

/** One review thread: who opened it, and whether it is resolved. */
export type PrThread = { id: string; author: string; isBot: boolean; resolved: boolean; path: string | null; body: string; url: string | null }

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE', 'ERROR'])

/** One node of a status check rollup (a CheckRun or a StatusContext) → a check; null for anything else. */
export function checkFrom(n: J): PrCheck | null {
  if (n?.__typename === 'CheckRun') {
    const done = n.status === 'COMPLETED'
    const c = String(n.conclusion ?? '')
    const status: PrCheck['status'] = !done ? 'pending' : c === 'SUCCESS' ? 'success' : c === 'NEUTRAL' || c === 'SKIPPED' ? 'neutral' : 'failure'
    return { name: String(n.name), status, id: String(n.databaseId), runId: n.checkSuite?.workflowRun?.databaseId ?? null, url: n.detailsUrl ?? null, conclusion: c || null }
  }
  if (n?.__typename === 'StatusContext') {
    const st = String(n.state)
    const status: PrCheck['status'] = st === 'SUCCESS' ? 'success' : FAILED.has(st) ? 'failure' : 'pending'
    return { name: String(n.context), status, id: `${n.id}:${n.createdAt}`, runId: null, url: n.targetUrl ?? null, conclusion: st }
  }
  return null
}

/** A bot comment, minus what changes between runs (numbers, hashes, spacing): the same finding prints the same. */
export function fingerprint(t: Pick<PrThread, 'author' | 'path' | 'body'>): string {
  const body = t.body
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  return `${t.author.toLowerCase()}|${t.path ?? ''}|${body}`
}

/** A failure that a rerun may clear: a timeout, a dropped connection, a runner that went away. */
const FLAKY = /\b(timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|rate limit(ed)?|50[234]\b|service unavailable|runner (has received a shutdown|lost communication)|network (error|unreachable)|flak(y|e))\b/i

export const looksFlaky = (log: string): boolean => FLAKY.test(log)
