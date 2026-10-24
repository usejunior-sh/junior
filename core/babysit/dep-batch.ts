/**
 * The dependency batch, end to end (plan item `dependency-batch-ui`): read
 * Renovate and Dependabot PRs, show the batchable ones as one suggested row
 * ("6 dependency updates are green · merge?"), and, only when the user presses
 * Merge, merge them one by one. Each PR is read again right before its merge
 * and checked with `batchable()` (deps.ts); one that turned red, got
 * conflicts or closed is dropped with a note, and the others still go.
 *
 * Nothing here runs on its own: the view is a read, and `runDepMerge` is
 * called only from the user's Merge press. Its I/O (gh, the action log) comes
 * in as `DepMergeDeps`, so the op is tested without either.
 *
 * Pure apart from the injected deps; browser-safe.
 */
import { batchable, dependencyBatch, MIN_AGE_DAYS, type DepPr } from './deps.js'
import { checkFrom, type PrCheck } from './ci.js'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** How a repo merges: core/work/contract.ts MergeMethod, repeated here so the browser build needn't load the contract parser. */
export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** A dependency PR as read from GitHub: what the rules need, plus where it is and how its repo merges. */
export type DepPrRead = DepPr & {
  repo: string
  number: number
  url: string
  /** the head commit the checks ran on: the merge is pinned to it */
  headSha: string
  /** what the repo allows */
  allows: { squash: boolean; merge: boolean; rebase: boolean }
  checks: readonly Pick<PrCheck, 'name' | 'status'>[]
}

/** `owner/name#123` */
export const refOfPr = (p: { repo: string; number: number }): string => `${p.repo}#${p.number}`

/** `owner/name#123` → its parts; null for anything else. */
export function parseRef(ref: unknown): { repo: string; number: number } | null {
  if (typeof ref !== 'string') return null
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(ref.trim())
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

// ── reading GitHub ────────────────────────────────────────────────────────

const PR_FIELDS = `__typename number title url isDraft createdAt state body mergeable headRefOid
    author { login }
    labels(first: 20) { nodes { name } }
    repository { nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
      ... on StatusContext { id context state targetUrl createdAt }
    } } } } } }`

/** Open dependency PRs, by search. */
export const DEP_SEARCH_QUERY = (first: number) => `query($q: String!) {
  prs: search(query: $q, type: ISSUE, first: ${first}) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
}`

/** One PR, read again right before its merge. */
export const DEP_PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } }
}`

/** The two bots' search authors. People's PRs labelled `dependencies` aren't searched: the batch is for the bots' chores. */
export const DEP_AUTHORS = ['app/dependabot', 'app/renovate'] as const

/**
 * The searches to run: per bot, the tracked repos in groups that fit
 * GitHub's 256-character query. No repos, no searches: the batch never
 * reads all of GitHub.
 */
export function depSearches(repos: readonly string[]): string[] {
  const out: string[] = []
  for (const author of DEP_AUTHORS) {
    const base = `is:open is:pr archived:false author:${author}`
    let group: string[] = []
    const flush = () => {
      if (group.length) out.push(`${base} ${group.join(' ')}`)
      group = []
    }
    for (const r of repos) {
      const q = `repo:${r}`
      if (base.length + 1 + [...group, q].join(' ').length > 256) flush()
      group.push(q)
    }
    flush()
  }
  return out
}

/** One PullRequest node → a read PR; null for anything else. */
export function depPrFrom(n: J): DepPrRead | null {
  if (n?.__typename !== 'PullRequest' || !n.repository?.nameWithOwner) return null
  const contexts = (n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) as J[]
  const checks = contexts.map(checkFrom).filter((c): c is PrCheck => c !== null).map((c) => ({ name: c.name, status: c.status }))
  const state = n.state === 'MERGED' || n.state === 'CLOSED' ? n.state : 'OPEN'
  const mergeable = n.mergeable === 'MERGEABLE' || n.mergeable === 'CONFLICTING' ? n.mergeable : 'UNKNOWN'
  const r = n.repository
  return {
    repo: String(r.nameWithOwner),
    number: Number(n.number),
    url: String(n.url ?? ''),
    headSha: String(n.headRefOid ?? ''),
    allows: { squash: r.squashMergeAllowed !== false, merge: r.mergeCommitAllowed !== false, rebase: r.rebaseMergeAllowed !== false },
    author: typeof n.author?.login === 'string' ? n.author.login : null,
    title: String(n.title ?? ''),
    labels: ((n.labels?.nodes ?? []) as J[]).map((l) => String(l?.name ?? '')).filter(Boolean),
    body: typeof n.body === 'string' ? n.body : null,
    createdAt: String(n.createdAt ?? ''),
    checks,
    isDraft: !!n.isDraft,
    state,
    mergeable,
  }
}

/** A search's answer → its PRs in `repos` (a repo that slipped the qualifier is left out). */
export function parseDepSearch(data: unknown, repos: readonly string[]): DepPrRead[] {
  const nodes = ((data as J)?.data?.prs?.nodes ?? []) as J[]
  const out: DepPrRead[] = []
  for (const n of nodes) {
    const pr = depPrFrom(n)
    if (pr && (repos.length === 0 || repos.includes(pr.repo))) out.push(pr)
  }
  return out
}

/** One PR's answer; null when GitHub has no such PR. */
export const parseDepPr = (data: unknown): DepPrRead | null => depPrFrom((data as J)?.data?.repository?.pullRequest)

// ── what a PR updates ─────────────────────────────────────────────────────

export type DepUpdate = { package: string; more: number; from: string | null; to: string | null }

const clean = (v: string) => v.replace(/^`|`$/g, '').replace(/[.,;:)]+$/, '')

/** Dependabot's group body: "Updates `eslint` from 9.12.0 to 9.13.0". */
const DEPENDABOT_ROW = /Updates?\s+`([^`]+)`\s+from\s+`?([^\s`]+)`?\s+to\s+`?([^\s`]+)`?/gi
/** Renovate's table: "| [eslint](…) | devDependencies | patch | [`9.12.0` -> `9.13.0`](…) |". */
const RENOVATE_ROW = /^\|\s*\[?`?([^\]|`(]+?)`?\]?(?:\([^)]*\))?\s*\|[^\n]*?`([^`\s]+)`\s*(?:->|→|⇒)\s*`([^`\s]+)`/gm

function bodyRows(body: string): { name: string; from: string; to: string }[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<details[\s\S]*?<\/details>/gi, '')
  const rows: { name: string; from: string; to: string }[] = []
  for (const m of text.matchAll(DEPENDABOT_ROW)) rows.push({ name: m[1]!.trim(), from: clean(m[2]!), to: clean(m[3]!) })
  for (const m of text.matchAll(RENOVATE_ROW)) {
    const name = m[1]!.trim()
    if (/^-+$/.test(name) || /^package$/i.test(name)) continue
    rows.push({ name, from: clean(m[2]!), to: clean(m[3]!) })
  }
  return rows
}

/**
 * What the PR updates, for its sub-row: the package, how many more ride
 * along, and from → to. Read from the title (Dependabot's "bump X from A to
 * B", Renovate's "update dependency X to vB"), filled from the body. When
 * nothing reads, the title stands in for the package.
 */
export function updateOf(pr: Pick<DepPr, 'title' | 'body'>): DepUpdate {
  const rows = bodyRows(pr.body ?? '')
  const bump = /\bbump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i.exec(pr.title)
  if (bump) return { package: bump[1]!, more: Math.max(0, rows.length - 1), from: clean(bump[2]!), to: clean(bump[3]!) }
  const upd = /\bupdate\s+(?:dependency\s+|module\s+|plugin\s+)?(\S+)(?:\s+(?:monorepo|action|digest|packages?|docker tag|image))?\s+to\s+(v?\S+)/i.exec(pr.title)
  if (upd) {
    const name = upd[1]!
    const row = rows.find((r) => r.name === name || r.name.endsWith(`/${name}`)) ?? (rows.length === 1 ? rows[0] : undefined)
    return { package: name, more: Math.max(0, rows.length - 1), from: row?.from ?? null, to: row?.to ?? clean(upd[2]!).replace(/^v(?=\d)/, '') }
  }
  if (rows.length) return { package: rows[0]!.name, more: rows.length - 1, from: rows[0]!.from, to: rows[0]!.to }
  return { package: pr.title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').slice(0, 60), more: 0, from: null, to: null }
}

// ── the suggested row ─────────────────────────────────────────────────────

/** One PR in the batch, as its sub-row shows it. */
export type DepBatchRow = DepUpdate & {
  ref: string
  repo: string
  url: string
  bump: 'minor' | 'patch'
  /** checks that passed (success or neutral) */
  green: number
  /** when it was opened, epoch ms */
  openedAt: number
}

/** The suggested row: 2 or more batchable PRs, and the dependency PRs held back with why. */
export type DepBatchView = {
  /** the batch's PR set, sorted: "Not now" is stored against it */
  key: string
  prs: DepBatchRow[]
  held: { ref: string; package: string; why: string }[]
  minAgeDays: number
}

/** "Not now": the batch's PRs at the time, hidden until `until` unless a new one joins. */
export type DepNotNow = { refs: string[]; until: number }

/** Where "Not now" is kept, in the workspace config. */
export const DEP_NOT_NOW_KEY = 'deps.notNow'
/** "Not now" hides the row this long. */
export const NOT_NOW_MS = 86_400_000
/** A batch needs this many PRs; one alone stays a normal row. */
export const MIN_BATCH = 2

export const batchKey = (refs: readonly string[]): string => [...refs].sort().join(' ')

/** Was "Not now" said to this batch? Only while it lasts, and only if no new PR joined since. */
export function notNowHides(refs: readonly string[], notNow: DepNotNow | null | undefined, now: number): boolean {
  if (!notNow || !Array.isArray(notNow.refs) || !(now < notNow.until)) return false
  const said = new Set(notNow.refs)
  return refs.every((r) => said.has(r))
}

/** Parse a stored "Not now"; anything odd reads as none. */
export function notNowFrom(v: unknown): DepNotNow | null {
  const o = v as Partial<DepNotNow> | null
  if (!o || !Array.isArray(o.refs) || typeof o.until !== 'number') return null
  return { refs: o.refs.filter((r): r is string => typeof r === 'string'), until: o.until }
}

const green = (checks: DepPrRead['checks']) => checks.filter((c) => c.status === 'success' || c.status === 'neutral').length
const openedAt = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t))

/**
 * The suggested row, or null: under 2 batchable PRs, or hidden by "Not now".
 * Oldest first. Reading it queues nothing.
 */
export function depBatchView(prs: readonly DepPrRead[], now: number, notNow: DepNotNow | null = null, minAgeDays: number = MIN_AGE_DAYS): DepBatchView | null {
  const { ready, held } = dependencyBatch(prs, now, minAgeDays)
  if (ready.length < MIN_BATCH) return null
  const rows: DepBatchRow[] = ready
    .map(({ pr, bump }) => ({ ...updateOf(pr), ref: refOfPr(pr), repo: pr.repo, url: pr.url, bump, green: green(pr.checks), openedAt: openedAt(pr.createdAt) }))
    .sort((a, b) => a.openedAt - b.openedAt || a.ref.localeCompare(b.ref))
  const refs = rows.map((r) => r.ref)
  if (notNowHides(refs, notNow, now)) return null
  return {
    key: batchKey(refs),
    prs: rows,
    held: held.map(({ pr, why }) => ({ ref: refOfPr(pr), package: updateOf(pr).package, why })),
    minAgeDays,
  }
}

// ── merging, after the user said so ───────────────────────────────────────

export type DepMergeState = 'waiting' | 'checking' | 'merging' | 'merged' | 'dropped' | 'failed'

export type DepMergeRow = { ref: string; package: string; from: string | null; to: string | null; state: DepMergeState; note: string | null }

/** One Merge press: its rows, each with its own state, and the line when it's done. */
export type DepMergeRun = {
  id: string
  startedAt: number
  rows: DepMergeRow[]
  done: boolean
  /** "Merged 5 of 6. I left out acme/web#3310: CI turned red." */
  summary: string | null
}

/** The I/O a merge run needs: read a PR again, how its repo merges, the merge, and the log record. */
export type DepMergeDeps = {
  read: (ref: { repo: string; number: number }) => Promise<DepPrRead | null>
  /** the repo's own word on how it merges (.junior/junior.md), if any */
  contractMethod: (repo: string) => Promise<MergeMethod | null>
  merge: (args: string[]) => Promise<unknown>
  /** one Log record per PR that was sent, merged or not */
  record: (r: { pr: DepPrRead; row: DepMergeRow; args: string[]; error: string | null; at: number }) => Promise<void>
  /** a row moved: the page polls the run */
  changed?: (run: DepMergeRun) => void
  now: () => number
}

/** batchable()'s why → the dropped note on the sub-row. */
export function dropNote(why: string): string {
  if (why === 'CI red') return 'CI turned red'
  if (why === 'CI running') return 'CI is running again'
  if (why === 'no CI yet') return 'no CI'
  return why
}

/**
 * How to merge: the repo's .junior/junior.md first, when the repo allows it;
 * else squash where allowed, else a merge commit, else rebase.
 */
export function mergeMethodFor(allows: DepPrRead['allows'], contract: MergeMethod | null): MergeMethod {
  if (contract && allows[contract]) return contract
  if (allows.squash) return 'squash'
  if (allows.merge) return 'merge'
  return 'rebase'
}

/** `gh pr merge`, pinned to the head that was checked. Never `--admin`, never `--auto`. */
export function mergeArgs(pr: Pick<DepPrRead, 'repo' | 'number' | 'headSha'>, method: MergeMethod): string[] {
  return ['pr', 'merge', String(pr.number), '-R', pr.repo, `--${method}`, ...(pr.headSha ? ['--match-head-commit', pr.headSha] : [])]
}

/** The Log line per PR: "Merged acme/web#3301 (eslint 9.12.0 → 9.13.0)". */
export function mergeSummary(row: Pick<DepMergeRow, 'ref' | 'package' | 'from' | 'to'>): string {
  const move = row.from && row.to ? ` ${row.from} → ${row.to}` : row.to ? ` → ${row.to}` : ''
  return `Merged ${row.ref} (${row.package}${move})`
}

/** The done line: "Merged all 6." or "Merged 5 of 6. I left out acme/web#3310: CI turned red." */
export function doneLine(rows: readonly DepMergeRow[]): string {
  const merged = rows.filter((r) => r.state === 'merged').length
  if (merged === rows.length) return `Merged all ${rows.length}.`
  const left = rows.filter((r) => r.state !== 'merged').map((r) => `${r.ref}: ${r.note ?? (r.state === 'failed' ? "didn't merge" : 'left out')}`)
  return `Merged ${merged} of ${rows.length}. I left out ${left.join('; ')}.`
}

/** The rows a Merge press starts with, from the batch the user saw and ticked. */
export function startRows(view: Pick<DepBatchView, 'prs'> | null, refs: readonly string[]): DepMergeRow[] {
  const byRef = new Map((view?.prs ?? []).map((p) => [p.ref, p]))
  return refs.map((ref) => {
    const p = byRef.get(ref)
    return { ref, package: p?.package ?? ref, from: p?.from ?? null, to: p?.to ?? null, state: 'waiting' as const, note: null }
  })
}

/**
 * Merge each PR of `run`, one at a time: read it again, drop it with a note
 * when it no longer passes batchable(), else merge it pinned to the head that
 * was checked, and record it. One PR failing never stops the others.
 */
export async function runDepMerge(run: DepMergeRun, deps: DepMergeDeps): Promise<DepMergeRun> {
  const set = (row: DepMergeRow, state: DepMergeState, note: string | null = null) => {
    row.state = state
    row.note = note
    deps.changed?.(run)
  }
  for (const row of run.rows) {
    const ref = parseRef(row.ref)
    if (!ref) {
      set(row, 'dropped', 'not a PR')
      continue
    }
    set(row, 'checking')
    let pr: DepPrRead | null
    try {
      pr = await deps.read(ref)
    } catch (err) {
      set(row, 'failed', err instanceof Error ? err.message : String(err))
      continue
    }
    if (!pr) {
      set(row, 'dropped', 'closed')
      continue
    }
    const fresh = updateOf(pr)
    row.package = fresh.package
    row.from = fresh.from ?? row.from
    row.to = fresh.to ?? row.to
    const ok = batchable(pr, deps.now())
    if (!ok.ok) {
      set(row, 'dropped', dropNote(ok.why))
      continue
    }
    set(row, 'merging')
    const args = mergeArgs(pr, mergeMethodFor(pr.allows, await deps.contractMethod(pr.repo).catch(() => null)))
    const at = deps.now()
    let error: string | null = null
    try {
      await deps.merge(args)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    set(row, error ? 'failed' : 'merged', error)
    await deps.record({ pr, row, args, error, at }).catch(() => undefined)
  }
  run.done = true
  run.summary = doneLine(run.rows)
  deps.changed?.(run)
  return run
}
