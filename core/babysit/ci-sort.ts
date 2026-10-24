/**
 * Sort a failed check before Junior spends a fix on it (plan item
 * `ci-sort-core`, pillar P3). Three answers:
 *
 *   main-red  the same check failed on the default branch's latest completed
 *             run: the PR didn't break it, so it's "not yours" and costs nothing
 *   flaky     the log (or GitHub's conclusion) reads like a timeout, a dropped
 *             connection or a runner that went away: a rerun may clear it
 *   fix       everything else: the PR's own failure, worth a fix attempt
 *
 * Each answer carries its evidence: the main run's link, the log line that
 * matched the flake test, the changed files the log names.
 *
 * Rules, in order:
 *   1. Missing main data never counts as main-red. No runs, no run of this
 *      check, no completed run, or a latest run that passed: not main-red.
 *   2. A flaky line that names a file the PR changed is the PR's own failure
 *      (a test it touched timed out), so it's a fix, not a rerun.
 *
 * Pure: no I/O, no clock. The server fetches the default branch's check runs
 * (`ci-sort-glue`). The flake test is ci.ts's, so there is one regex.
 */
import { looksFlaky, type PrCheck } from './ci.js'

/** One check run on the default branch's head, as the GitHub API reports it (any case). */
export type MainRun = {
  name: string
  /** `completed`, `in_progress`, `queued`, … — anything but completed is skipped */
  status: string | null
  /** `failure`, `success`, `timed_out`, … ; null while it runs */
  conclusion: string | null
  url: string | null
  /** the commit it ran on, for the evidence line */
  sha?: string | null
  /** ISO time it finished: picks the latest when a check ran more than once */
  completedAt?: string | null
}

export type CiSortVerdict = 'main-red' | 'flaky' | 'fix'

export type CiSort =
  | { verdict: 'main-red'; why: string; evidence: { url: string | null; sha: string | null; conclusion: string; completedAt: string | null } }
  | { verdict: 'flaky'; why: string; evidence: { match: string; source: 'log' | 'conclusion' } }
  | { verdict: 'fix'; why: string; evidence: { touched: string[] } }

/** How a main run ends that means main is red. Cancelled isn't: a newer push usually cancels it. */
const MAIN_RED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR'])

/** GitHub's conclusions on the PR's own check that a rerun may clear (the shepherd's list). */
const FLAKY_CONCLUSION = new Set(['TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'])

const up = (s: string | null | undefined) => (s ?? '').trim().toUpperCase()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const MAX_TOUCHED = 5

/**
 * The latest completed run of this check on the default branch, or null when
 * there isn't one. Ties and missing times keep the first in the list.
 */
export function latestMainRun(name: string, runs: readonly MainRun[] | null | undefined): MainRun | null {
  let best: MainRun | null = null
  let bestAt = -Infinity
  for (const r of runs ?? []) {
    if (!r || r.name.trim() !== name.trim() || up(r.status) !== 'COMPLETED' || !r.conclusion) continue
    const at = r.completedAt ? Date.parse(r.completedAt) : NaN
    const t = Number.isNaN(at) ? -Infinity : at
    if (best === null || t > bestAt) {
      best = r
      bestAt = t
    }
  }
  return best
}

/** The first log line the flake test matches, clipped, or null. */
export function flakyLine(log: string): string | null {
  if (!log || !looksFlaky(log)) return null
  for (const line of log.split(/\r?\n/)) if (looksFlaky(line)) return clip(line.trim(), 200)
  // the match spans lines (rare): say so without a line
  return clip(log.trim().split(/\r?\n/)[0] ?? '', 200)
}

/** The changed files the text names by path, in PR order, at most a few. */
export function touchedFiles(text: string, prFiles: readonly string[]): string[] {
  if (!text) return []
  const out: string[] = []
  for (const f of prFiles) {
    const path = f.trim().replace(/^\.\//, '')
    if (path && text.includes(path) && !out.includes(path)) out.push(path)
    if (out.length >= MAX_TOUCHED) break
  }
  return out
}

/**
 * Sort one failed check. `defaultBranchRuns` is the default branch's check
 * runs (null when they couldn't be read), `log` the failing check's output
 * (empty when unread), `prFiles` the paths the PR changed.
 */
export function classify(check: Pick<PrCheck, 'name' | 'conclusion'>, defaultBranchRuns: readonly MainRun[] | null | undefined, log: string, prFiles: readonly string[]): CiSort {
  const main = latestMainRun(check.name, defaultBranchRuns)
  if (main && MAIN_RED.has(up(main.conclusion)))
    return {
      verdict: 'main-red',
      why: 'Main is red too · not yours',
      evidence: { url: main.url, sha: main.sha ?? null, conclusion: up(main.conclusion), completedAt: main.completedAt ?? null },
    }

  const line = flakyLine(log)
  if (line && touchedFiles(line, prFiles).length === 0) return { verdict: 'flaky', why: `Looks flaky: ${clip(line, 80)}`, evidence: { match: line, source: 'log' } }
  const conclusion = up(check.conclusion)
  if (!line && FLAKY_CONCLUSION.has(conclusion))
    return { verdict: 'flaky', why: `Looks flaky: ${conclusion.toLowerCase().replace(/_/g, ' ')}`, evidence: { match: conclusion, source: 'conclusion' } }

  const touched = touchedFiles(log, prFiles)
  const why = touched.length > 0 ? `Fails in ${touched[0]}, changed in this PR` : up(main?.conclusion) === 'SUCCESS' ? 'Passes on main, fails here' : 'Fails on this PR'
  return { verdict: 'fix', why, evidence: { touched } }
}

/**
 * `gh api repos/<repo>/commits/<branch>/check-runs` → the runs `classify`
 * reads. Anything that isn't a named run is dropped; a shape it doesn't know
 * gives no runs, which is "no main data", never main-red.
 */
export function mainRunsFrom(data: unknown): MainRun[] {
  const runs = (data as { check_runs?: unknown } | null)?.check_runs
  if (!Array.isArray(runs)) return []
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const out: MainRun[] = []
  for (const r of runs as Record<string, unknown>[]) {
    const name = str(r?.name)
    if (!name) continue
    out.push({ name, status: str(r.status), conclusion: str(r.conclusion), url: str(r.html_url), sha: str(r.head_sha), completedAt: str(r.completed_at) })
  }
  return out
}
