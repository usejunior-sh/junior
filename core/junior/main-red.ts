/**
 * "Main is red too · not yours" (plan item `ci-sort-glue`): a handed-off PR
 * whose red checks failed on the default branch too. The babysit watch adds
 * no task for those (core/babysit/ci-sort.ts) and keeps what it found on the
 * PR's `seen.mainRed`. Here: the words the Ledger card and the inbox row show.
 *
 *   Context   lint failed on main too, at a1b2c3d, 40m ago.  Open main's run ↗
 *   Junior    Main is red too, so this isn't yours. When main is green, I'll try a fix if it still fails.
 *
 * Pure and browser-safe; time is an argument.
 */
import type { PrSeen } from '../work/handoff.js'
import { TURN_REASONS, turnOf, type TurnItem } from '../work/turn.js'

/** Junior's line on the open card when every red check is red on main too. */
export const MAIN_RED_SAYS = "Main is red too, so this isn't yours. When main is green, I'll try a fix if it still fails."

/** The row's reason text: the one source is the turn reason's. */
export const MAIN_RED_LINE = TURN_REASONS['main-red'].text

/** The item reads "main is red too" right now: its turn says so (handed off, watch on, every red check red on main). */
export const isMainRed = (item: TurnItem): boolean => turnOf(item).reason === 'main-red'

/** The inbox row's reason column: the main-red line, else null (the row keeps its own `why`). */
export const mainRedWhy = (item: TurnItem): string | null => (isMainRed(item) ? MAIN_RED_LINE : null)

const CHECK_MAX = 40
const clip = (s: string) => (s.length > CHECK_MAX ? `${s.slice(0, CHECK_MAX - 1)}…` : s)

/** "lint" · "lint and test" · "lint, test and 2 more". */
export function checksPhrase(names: readonly string[]): string {
  const n = names.map(clip)
  if (n.length <= 1) return n[0] ?? ''
  if (n.length === 2) return `${n[0]} and ${n[1]}`
  return `${n[0]}, ${n[1]} and ${n.length - 2} more`
}

/** "40m", "3h", "2d" since an ISO time; null when it can't say. */
export function agoOf(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t) || t > now) return null
  const m = Math.max(1, Math.floor((now - t) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** The evidence line's parts, so the sha and age can be set in mono. */
export type MainRedEvidence = {
  /** "lint and test" */
  checks: string
  /** the first check's main commit, 7 characters */
  sha: string | null
  /** how long ago that run finished: "40m" */
  ago: string | null
  /** main's run of the first check; null = no link */
  url: string | null
  /** the link's accessible name, naming the check */
  linkLabel: string
  /** the whole line as text: "lint failed on main too, at a1b2c3d, 40m ago." */
  text: string
}

/**
 * What the open card says about checks red on main too. Shown whenever the
 * last poll found some, also beside a real failure Junior is fixing.
 */
export function mainRedEvidence(seen: Pick<PrSeen, 'mainRed'> | undefined, now: number): MainRedEvidence | null {
  const red = seen?.mainRed ?? []
  const first = red[0]
  if (!first) return null
  const checks = checksPhrase(red.map((r) => r.check))
  const sha = first.sha ? first.sha.slice(0, 7) : null
  const ago = agoOf(first.at, now)
  const tail = [sha ? `at ${sha}` : null, ago ? `${ago} ago` : null].filter(Boolean).join(', ')
  return {
    checks,
    sha,
    ago,
    // a link only to a web page: the watch reads it off GitHub, but the card never opens anything else
    url: first.url && /^https:\/\//.test(first.url) ? first.url : null,
    linkLabel: `Open main's run for ${first.check} on GitHub`,
    text: `${checks} failed on main too${tail ? `, ${tail}` : ''}.`,
  }
}
