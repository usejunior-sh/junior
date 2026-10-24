/**
 * Dependency PRs that can go together: Renovate and Dependabot PRs that are
 * green, a minor or patch bump, and old enough to have settled. The Junior
 * page shows them as one suggested row ("6 dependency updates are green ·
 * merge?"); nothing is queued until the user acts on it.
 *
 * The rules, on purpose conservative:
 *   - a dependency PR is one opened by Renovate or Dependabot, or labelled
 *     as one (`dependencies`, `renovate`, …)
 *   - the bump is read from the title (Dependabot's "from 1.2.3 to 1.2.4"),
 *     then the body (Renovate's "`1.2.3` -> `1.2.4`" table), then an update
 *     type label; a PR moving several packages counts as its biggest move
 *   - anything that can't be read is `unknown`, and unknown never counts as
 *     patch or minor: it isn't batchable
 *   - under 1.0, a minor move is breaking (semver), so it counts as major
 *   - batchable needs every check green (none pending, at least one ran),
 *     no conflicts, not a draft, still open, and the minimum age
 *
 * Pure: no I/O, the clock is an argument. Browser-safe.
 */
import type { PrCheck } from './ci.js'

export type Bump = 'major' | 'minor' | 'patch' | 'unknown'

/** What the rules read off a PR. Any source (the babysit search, a repo-wide search) can fill it. */
export type DepPr = {
  /** the author's login: `renovate[bot]`, `app/dependabot`, … */
  author: string | null
  title: string
  labels?: readonly string[]
  body?: string | null
  /** when it was opened: ISO text or epoch ms */
  createdAt: string | number
  checks: readonly Pick<PrCheck, 'name' | 'status'>[]
  isDraft?: boolean
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
}

/** Wait 3 days after a release before batching it: a bad release is usually pulled by then. */
export const MIN_AGE_DAYS = 3

const DAY = 86_400_000

/** Bot logins, after `app/` and `[bot]` are taken off. */
const DEP_BOTS = new Set(['renovate', 'renovate-bot', 'mend-renovate', 'dependabot', 'dependabot-preview'])
/** Labels the two bots (and people) put on dependency PRs. */
const DEP_LABELS = new Set(['dependencies', 'dependency', 'deps', 'renovate', 'dependabot'])

const normLogin = (login: string) =>
  login.trim().toLowerCase().replace(/^@/, '').replace(/^app\//, '').replace(/\[bot\]$/, '')

/** Opened by Renovate or Dependabot, or labelled as a dependency update. */
export function isDependencyPr(pr: Pick<DepPr, 'author' | 'labels'>): boolean {
  if (pr.author && DEP_BOTS.has(normLogin(pr.author))) return true
  return (pr.labels ?? []).some((l) => DEP_LABELS.has(l.trim().toLowerCase()))
}

type Version = { major: number; minor: number; patch: number }

/** "v1.2.3", "^1.2", "1.2.3-beta.1", "~> 2.0" → its numbers; null for a digest, a range like ">=1 <2", or text. */
export function parseVersion(text: string): Version | null {
  const m = /^[\^~=v\s>]*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+.][0-9A-Za-z.+-]*)?$/.exec(text.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) }
}

/** How far `from` → `to` moves. Under 1.0 a minor move is breaking, and under 0.1 any move is. A downgrade is unknown. */
export function bumpBetween(from: string, to: string): Bump {
  const a = parseVersion(from)
  const b = parseVersion(to)
  if (!a || !b) return 'unknown'
  const cmp = b.major - a.major || b.minor - a.minor || b.patch - a.patch
  if (cmp <= 0) return 'unknown'
  if (b.major !== a.major) return 'major'
  if (a.major === 0) {
    if (b.minor !== a.minor) return 'major'
    if (a.minor === 0) return 'major'
  }
  return b.minor !== a.minor ? 'minor' : 'patch'
}

const RANK: Record<Exclude<Bump, 'unknown'>, number> = { patch: 0, minor: 1, major: 2 }

/** The biggest of several moves; one unknown move makes the lot unknown. */
function biggest(bumps: readonly Bump[]): Bump {
  if (bumps.length === 0 || bumps.includes('unknown')) return 'unknown'
  return (bumps as Exclude<Bump, 'unknown'>[]).reduce((x, y) => (RANK[y] > RANK[x] ? y : x))
}

const VER = String.raw`v?[0-9][0-9A-Za-z.+-]*`
/** Dependabot: "from 1.2.3 to 1.2.4". */
const FROM_TO = new RegExp(String.raw`\bfrom\s+\`?(${VER})\`?\s+to\s+\`?(${VER})\`?`, 'gi')
/** Renovate's table: "`1.2.3` -> `1.2.4`" (also → and ⇒). Any text between the backticks, so a digest row reads as unknown, not as nothing. */
const ARROW = /`([^`\s]+)`\s*(?:->|→|⇒)\s*`([^`\s]+)`/g

const trimDot = (v: string) => v.replace(/[.,;:)]+$/, '')

function pairs(text: string, re: RegExp): Bump[] {
  const out: Bump[] = []
  for (const m of text.matchAll(re)) out.push(bumpBetween(trimDot(m[1]!), trimDot(m[2]!)))
  return out
}

/** Renovate's major PRs say "to v19" (the major alone) or end in "(major)". */
function renovateTitle(title: string): Bump | null {
  if (/\(major\)\s*$/i.test(title) || /\bmajor\b/i.test(title.replace(/non-major/gi, ''))) return 'major'
  if (/\bto\s+v?\d+\s*(?:\[security\])?\s*$/i.test(title) && !/\bto\s+v?\d+\.\d/i.test(title)) return 'major'
  return null
}

/**
 * The bump a dependency PR makes, from its title alone. Dependabot titles
 * carry both versions; a Renovate title carries only the new one, so it is
 * `major` when it names the major alone and `unknown` otherwise (`bumpOf`
 * reads the body for those).
 */
export function bump(title: string): Bump {
  const found = pairs(title, FROM_TO)
  if (found.length > 0) return biggest(found)
  return renovateTitle(title) ?? 'unknown'
}

/** The update type label Renovate can add (`major`, `type: minor`, `update:patch`, …). */
function labelBump(labels: readonly string[]): Bump | null {
  const seen: Bump[] = []
  for (const l of labels) {
    const m = /^(?:(?:type|update|semver|update-type)\s*[:/]\s*)?(major|minor|patch)$/i.exec(l.trim())
    if (m) seen.push(m[1]!.toLowerCase() as Bump)
  }
  return seen.length ? biggest(seen) : null
}

/** The body minus release notes and changelogs (`<details>` blocks, quotes, comments), whose "from 5 to 10" isn't the bump. */
function mainText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<details[\s\S]*?<\/details>/gi, '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
}

/** The bump, from everything the PR says: the title first, then the body's versions, then a label. */
export function bumpOf(pr: Pick<DepPr, 'title' | 'body' | 'labels'>): Bump {
  const fromTitle = bump(pr.title)
  if (fromTitle !== 'unknown') return fromTitle
  const body = mainText(pr.body ?? '')
  const found = [...pairs(body, ARROW), ...pairs(body, FROM_TO)]
  if (found.length > 0) return biggest(found)
  return labelBump(pr.labels ?? []) ?? 'unknown'
}

export type Batchable = { ok: true; bump: 'minor' | 'patch' } | { ok: false; why: string }

const when = (t: string | number): number => (typeof t === 'number' ? t : Date.parse(t))

/** Can this PR go in the batch? When not, `why` says so in a few words, for the expanded row. */
export function batchable(pr: DepPr, now: number, minAgeDays: number = MIN_AGE_DAYS): Batchable {
  if (!isDependencyPr(pr)) return { ok: false, why: 'not a dependency update' }
  if (pr.state && pr.state !== 'OPEN') return { ok: false, why: pr.state === 'MERGED' ? 'already merged' : 'closed' }
  if (pr.isDraft) return { ok: false, why: 'draft' }
  const b = bumpOf(pr)
  if (b === 'major') return { ok: false, why: 'major update' }
  if (b === 'unknown') return { ok: false, why: "can't tell how big the update is" }
  if (pr.checks.length === 0) return { ok: false, why: 'no CI yet' }
  if (pr.checks.some((c) => c.status === 'failure')) return { ok: false, why: 'CI red' }
  if (pr.checks.some((c) => c.status === 'pending')) return { ok: false, why: 'CI running' }
  if (pr.mergeable === 'CONFLICTING') return { ok: false, why: 'conflicts' }
  const opened = when(pr.createdAt)
  if (!Number.isFinite(opened)) return { ok: false, why: "can't tell when it was opened" }
  const age = now - opened
  if (age < minAgeDays * DAY) {
    const left = Math.ceil((minAgeDays * DAY - age) / DAY)
    return { ok: false, why: `too new, ready in ${left} ${left === 1 ? 'day' : 'days'}` }
  }
  return { ok: true, bump: b }
}

/** The dependency PRs among `prs`, split into the batch and the ones held back (with why). Others are left out. */
export function dependencyBatch<P extends DepPr>(prs: readonly P[], now: number, minAgeDays: number = MIN_AGE_DAYS): {
  ready: { pr: P; bump: 'minor' | 'patch' }[]
  held: { pr: P; why: string }[]
} {
  const ready: { pr: P; bump: 'minor' | 'patch' }[] = []
  const held: { pr: P; why: string }[] = []
  for (const pr of prs) {
    if (!isDependencyPr(pr)) continue
    const v = batchable(pr, now, minAgeDays)
    if (v.ok) ready.push({ pr, bump: v.bump })
    else held.push({ pr, why: v.why })
  }
  return { ready, held }
}
