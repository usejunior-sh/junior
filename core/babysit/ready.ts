/**
 * "Ready because…": the gate a PR passes before Junior hands it back as
 * ready. Four facts off the babysit watch's read of the PR, each with the
 * evidence behind it, so you don't open the PR to check:
 *
 *   ci         every check reported and passed on this head
 *   threads    no review thread left open, from a bot or a person
 *   mergeable  GitHub says it merges cleanly (unknown is not yet)
 *   behind     not behind its base, where the repo requires up to date
 *
 * Ready only when all four pass. Anything else stays with Junior, and the
 * line says what's left: "Not ready: lint red · 1 thread open".
 *
 * Pure, browser-safe: no I/O, no clock, no model output.
 */

export type ReadyCheckId = 'ci' | 'threads' | 'mergeable' | 'behind'

/** Every check, in the order the line reads them. */
export const READY_CHECK_IDS: readonly ReadyCheckId[] = ['ci', 'threads', 'mergeable', 'behind']

export type ReadyCheck = {
  id: ReadyCheckId
  ok: boolean
  /** the chip's words: "CI green", "lint red", "0 threads", "behind main" */
  label: string
  /** one sentence that backs the label: "3 checks passed on abc1234." */
  evidence: string
  /** where to see it for yourself; null when GitHub gave no link */
  url: string | null
}

export type Readiness = {
  ready: boolean
  /** the head these facts are about: a newer push makes them stale */
  sha: string
  checks: ReadyCheck[]
}

/**
 * What the gate reads off a PR: a structural slice of the babysit watch's
 * BabysitPr (core/babysit/pr.ts), spelled out here so the web bundle can use
 * this file without pulling in the GitHub scanner.
 */
export type ReadyPr = {
  url: string
  headSha: string
  baseRef: string
  checks: readonly { name: string; status: 'pending' | 'success' | 'failure' | 'neutral'; url: string | null }[]
  threads: readonly { author: string; resolved: boolean; path: string | null; url: string | null }[]
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  behind: boolean
}

/** The labels for a fact still settling, not yet a thing left to fix: CI running, no CI yet, merge unknown. */
export const CI_RUNNING = 'CI running'
export const NO_CI_YET = 'no CI yet'
export const MERGE_UNKNOWN = 'merge unknown'

const short = (sha: string) => sha.slice(0, 7)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (xs: readonly string[], max = 3) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '))
/** "https://github.com/acme/api/pull/12" + "/checks"; null when the PR has no url */
const at = (url: string, tail = '') => (url ? `${url}${tail}` : null)

function ciCheck(pr: ReadyPr): ReadyCheck {
  const sha = short(pr.headSha)
  const checksUrl = at(pr.url, '/checks')
  const red = pr.checks.filter((c) => c.status === 'failure')
  const pending = pr.checks.filter((c) => c.status === 'pending')
  if (pr.checks.length === 0) return { id: 'ci', ok: false, label: NO_CI_YET, evidence: `No check has reported on ${sha} yet.`, url: checksUrl }
  if (red.length > 0)
    return {
      id: 'ci',
      ok: false,
      label: red.length === 1 ? `${red[0]!.name} red` : `${red.length} checks red`,
      evidence: `Failed on ${sha}: ${names(red.map((c) => c.name))}.`,
      url: red[0]!.url ?? checksUrl,
    }
  if (pending.length > 0)
    return {
      id: 'ci',
      ok: false,
      label: CI_RUNNING,
      evidence: `${pending.length} of ${plural(pr.checks.length, 'check')} still running on ${sha}: ${names(pending.map((c) => c.name))}.`,
      url: pending[0]!.url ?? checksUrl,
    }
  return { id: 'ci', ok: true, label: 'CI green', evidence: `${plural(pr.checks.length, 'check')} passed on ${sha}.`, url: checksUrl }
}

function threadsCheck(pr: ReadyPr): ReadyCheck {
  const open = pr.threads.filter((t) => !t.resolved)
  if (open.length === 0)
    return { id: 'threads', ok: true, label: '0 threads', evidence: pr.threads.length ? `All ${plural(pr.threads.length, 'review thread')} resolved.` : 'No review threads.', url: at(pr.url) }
  const who = open.map((t) => `${t.author.replace(/\[bot\]$/, '')}${t.path ? ` on ${t.path.split('/').pop()}` : ''}`)
  return { id: 'threads', ok: false, label: `${plural(open.length, 'thread')} open`, evidence: `Open: ${names(who)}.`, url: open[0]!.url ?? at(pr.url) }
}

function mergeableCheck(pr: ReadyPr): ReadyCheck {
  const url = at(pr.url)
  if (pr.mergeable === 'MERGEABLE') return { id: 'mergeable', ok: true, label: 'no conflicts', evidence: `Merges cleanly into ${pr.baseRef}.`, url }
  if (pr.mergeable === 'CONFLICTING') return { id: 'mergeable', ok: false, label: 'conflicts', evidence: `Conflicts with ${pr.baseRef}.`, url }
  return { id: 'mergeable', ok: false, label: MERGE_UNKNOWN, evidence: `GitHub hasn't worked out yet whether it merges into ${pr.baseRef}.`, url }
}

function behindCheck(pr: ReadyPr): ReadyCheck {
  const url = at(pr.url)
  if (pr.behind) return { id: 'behind', ok: false, label: `behind ${pr.baseRef}`, evidence: `${pr.baseRef} has commits this branch doesn't, and the repo wants it up to date.`, url }
  return { id: 'behind', ok: true, label: 'up to date', evidence: `Not behind ${pr.baseRef}.`, url }
}

/** The four checks on a PR's current head, and whether all pass. */
export function readiness(pr: ReadyPr): Readiness {
  const checks = [ciCheck(pr), threadsCheck(pr), mergeableCheck(pr), behindCheck(pr)]
  return { ready: checks.every((c) => c.ok), sha: pr.headSha, checks }
}

/**
 * The item's line: "Ready because: CI green · 0 threads · no conflicts · up
 * to date", or what's left: "Not ready: lint red · 1 thread open".
 */
export function readyLine(r: Pick<Readiness, 'ready' | 'checks'>): string {
  if (r.ready) return `Ready because: ${r.checks.map((c) => c.label).join(' · ')}`
  return `Not ready: ${r.checks.filter((c) => !c.ok).map((c) => c.label).join(' · ')}`
}

/** The facts are about this head: a push since makes them stale, and stale is never ready. */
export const readyAt = (r: Readiness | undefined, headSha: string | null | undefined): boolean => !!r && !!headSha && r.ready && r.sha === headSha

/**
 * The line a PR you handed off shows while Junior has nothing under way on
 * it (With Junior and the ledger): handed back as ready only when the gate
 * passes, else what Junior still waits on. Null when the watch hasn't read
 * the gate yet, or the item isn't a PR Junior babysits right now.
 */
export function handBackLine(i: { reason: string; junior?: { stage: string } | undefined; seen?: { ready?: Readiness } | undefined }): string | null {
  if (i.reason !== 'your-pr' || i.junior?.stage !== 'watching' || !i.seen?.ready) return null
  return readyLine(i.seen.ready)
}

/**
 * How a chip reads on screen (web/src/components/ReadyChips.tsx):
 *
 *   ok     passes
 *   wait   still settling (CI running, no CI yet, merge unknown): not yours, never orange
 *   left   something left to do, in ink
 *   needs  left, on an item that is on Needs you: the only orange
 */
export type ChipTone = 'ok' | 'wait' | 'left' | 'needs'

export function chipTone(c: Pick<ReadyCheck, 'ok' | 'label'>, needsYou: boolean): ChipTone {
  if (c.ok) return 'ok'
  if (c.label === CI_RUNNING || c.label === NO_CI_YET || c.label === MERGE_UNKNOWN) return 'wait'
  return needsYou ? 'needs' : 'left'
}

/**
 * The closed row's one pill: "Ready", or the first thing left in line order
 * plus how many more ("lint red" +1). Never orange: the closed row shows it
 * only while Junior is watching, which is never Needs you.
 */
export function readySummary(r: Pick<Readiness, 'ready' | 'checks'>): { label: string; tone: ChipTone; more: number } {
  const left = r.checks.filter((c) => !c.ok)
  if (r.ready || left.length === 0) return { label: 'Ready', tone: 'ok', more: 0 }
  return { label: left[0]!.label, tone: chipTone(left[0]!, false), more: left.length - 1 }
}

/** A chip's link, only when it is a plain https URL: anything else draws as text, never a link. */
export const chipHref = (c: Pick<ReadyCheck, 'url'>): string | null => (c.url && /^https:\/\/[^\s]+$/i.test(c.url) ? c.url : null)

/** The evidence a chip shows under the chips: one that isn't passing, or one with no link to open. */
export const showsEvidence = (c: Pick<ReadyCheck, 'ok' | 'url'>): boolean => !c.ok || !chipHref(c)

/** Junior's sentence under the chips, while it watches the PR: the chips already say which. */
export const handBackSays = (r: Pick<Readiness, 'ready'>): string => (r.ready ? 'Ready for review. All four checks pass.' : "Not ready yet. I'll hand it back when all four pass.")
