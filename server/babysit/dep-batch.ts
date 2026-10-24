/**
 * The dependency batch, wired to a workspace (core/babysit/dep-batch.ts has
 * the rules). Three ops, shared by the HTTP routes:
 *
 *   depBatchOp      the suggested row for the Junior page's day: a read, it
 *                   queues nothing. One `gh` search per bot every 5 minutes
 *                   at most, only while the babysit watch is on.
 *   depMergeOp      the user pressed "Merge 5": that press is the approval.
 *                   Each PR is read again, dropped with a note if it no
 *                   longer passes, else merged and recorded in Junior's log
 *                   as its own action, allowed by the user.
 *   depNotNowOp     "Not now": hide this batch for a day, or until a new PR joins.
 */
import { randomUUID } from 'node:crypto'
import {
  DEP_NOT_NOW_KEY,
  DEP_PR_QUERY,
  DEP_SEARCH_QUERY,
  depBatchView,
  depSearches,
  mergeSummary,
  NOT_NOW_MS,
  notNowFrom,
  parseDepPr,
  parseDepSearch,
  parseRef,
  refOfPr,
  runDepMerge,
  startRows,
  type DepBatchView,
  type DepMergeRun,
  type DepPrRead,
} from '../../core/babysit/dep-batch.js'
import { recordFor } from '../../core/actions/track.js'
import type { ActionRecord } from '../../core/actions/types.js'
import { log } from '../log.js'
import { errText } from '../errors.js'
import { connectedRepos } from '../inbox/sync.js'
import { watchesOn } from '../settings-ops.js'
import { onActionChain } from '../session/actions-hold.js'
import { actionsChanged } from '../session/actions-record.js'
import { invalidateInbox } from '../ws/send.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { contractForRepo, gh } from './glue.js'

/** The search is re-run at most this often for the Junior page. */
const READ_TTL_MS = 5 * 60_000
/** A first read waits this long at most; the row comes with a later day reload. */
const FIRST_READ_WAIT_MS = 4_000
/** One press merges at most this many. */
const MAX_REFS = 30
/** A finished run's states stay readable this long. */
const RUN_KEEP_MS = 10 * 60_000

type Read = { at: number; repos: string; prs: DepPrRead[] }
const reads = new WeakMap<WorkspaceRuntime, Read>()
const reading = new WeakMap<WorkspaceRuntime, Promise<DepPrRead[]>>()
const runs = new WeakMap<WorkspaceRuntime, Map<string, DepMergeRun>>()

async function searchDeps(repos: string[]): Promise<DepPrRead[]> {
  const seen = new Map<string, DepPrRead>()
  for (const q of depSearches(repos)) {
    const data = JSON.parse(await gh(['api', 'graphql', '-f', `query=${DEP_SEARCH_QUERY(50)}`, '-f', `q=${q}`]))
    for (const pr of parseDepSearch(data, repos)) seen.set(refOfPr(pr), pr)
  }
  return [...seen.values()]
}

/** The tracked repos' open dependency PRs: the warm read, refreshed in the background once stale. */
async function depPrs(rt: WorkspaceRuntime, repos: string[], now: number): Promise<DepPrRead[]> {
  const key = repos.join(' ')
  const have = reads.get(rt)
  const fresh = have && have.repos === key && now - have.at < READ_TTL_MS
  if (fresh) return have.prs
  let p = reading.get(rt)
  if (!p) {
    p = searchDeps(repos)
      .then((prs) => {
        reads.set(rt, { at: Date.now(), repos: key, prs })
        return prs
      })
      .finally(() => reading.delete(rt))
    reading.set(rt, p)
  }
  // a stale read answers now; only the very first waits, and not for long
  if (have && have.repos === key) {
    p.catch((err) => log('warn', 'babysit', `dependency PRs: ${errText(err)}`, { workspace: rt.meta.id }))
    return have.prs
  }
  return Promise.race([p, new Promise<DepPrRead[]>((resolve) => setTimeout(() => resolve([]), FIRST_READ_WAIT_MS).unref())])
}

/** The suggested row for the day, or null. Reading it queues nothing. */
export async function depBatchOp(rt: WorkspaceRuntime, now = Date.now()): Promise<DepBatchView | null> {
  if (!(await watchesOn(rt)).babysit) return null
  const repos = await connectedRepos(rt)
  if (repos.length === 0) return null
  const prs = await depPrs(rt, repos, now)
  return depBatchView(prs, now, notNowFrom(await rt.store.config.get(DEP_NOT_NOW_KEY)))
}

/** "Not now": this batch's PRs, hidden for a day; a new PR joining brings the row back. */
export async function depNotNowOp(rt: WorkspaceRuntime, raw: unknown): Promise<{ until: number }> {
  const refs = refsFrom(raw)
  const until = Date.now() + NOT_NOW_MS
  await rt.store.config.set(DEP_NOT_NOW_KEY, { refs, until })
  log('info', 'babysit', `dependency batch: not now (${refs.length} PRs)`, { workspace: rt.meta.id })
  return { until }
}

function refsFrom(raw: unknown): string[] {
  const list = (raw as { refs?: unknown } | null)?.refs
  if (!Array.isArray(list) || list.length === 0) throw new Error('name the PRs to merge')
  if (list.length > MAX_REFS) throw new Error(`at most ${MAX_REFS} PRs at once`)
  const refs = [...new Set(list.map((r) => (parseRef(r) ? refOfPr(parseRef(r)!) : null)))]
  if (refs.some((r) => r === null)) throw new Error('a PR is named as owner/repo#123')
  return refs as string[]
}

/** The merge command, as the Log shows it. */
const commandOf = (args: string[]) => ['gh', ...args].join(' ')

/** One merge as its own action record: allowed by you, with the Merge press as the detail. */
async function recordMerge(rt: WorkspaceRuntime, run: DepMergeRun, approved: string, r: { pr: DepPrRead; row: DepMergeRun['rows'][number]; args: string[]; error: string | null; at: number }): Promise<void> {
  const itemId = (rt.inboxCache?.items ?? []).find((i) => i.url === r.pr.url)?.id ?? null
  const now = Date.now()
  const rec: ActionRecord = {
    ...recordFor(
      // `task-` sessions have no chat to link to: the Log shows the line alone
      { sessionId: `task-deps-${run.id}`, sessionKind: 'task', permissionMode: null, jobId: null, teamRunId: null, itemId },
      `merge-${r.row.ref}`,
      'Bash',
      { command: commandOf(r.args) },
      { kind: 'merge', why: 'bash pattern', whyDetail: 'gh pr merge', summary: mergeSummary(r.row) },
      r.at,
    ),
    status: r.error ? 'failed' : 'succeeded',
    link: r.pr.url || `https://github.com/${r.pr.repo}/pull/${r.pr.number}`,
    error: r.error,
    allowedBy: 'prompt',
    allowedDetail: approved,
    settledAt: now,
    updatedAt: now,
  }
  await onActionChain(rt, () => rt.store.actions.put(rec))
    .then(() => actionsChanged(rt, new Set([rec.sessionId])))
    .catch((err) => log('warn', 'babysit', `could not record a dependency merge: ${errText(err)}`, { workspace: rt.meta.id }))
}

/**
 * The user pressed Merge on the batch: start one merge per named PR, in the
 * background, and answer at once with the run the page polls. Only PRs in
 * tracked repos; each must pass batchable() again right before it goes.
 */
export async function depMergeOp(rt: WorkspaceRuntime, raw: unknown): Promise<DepMergeRun> {
  const refs = refsFrom(raw)
  const repos = new Set(await connectedRepos(rt))
  const outside = refs.find((r) => !repos.has(parseRef(r)!.repo))
  if (outside) throw new Error(`${outside} isn't in a repo this workspace tracks`)
  const mine = runs.get(rt) ?? new Map<string, DepMergeRun>()
  runs.set(rt, mine)
  if ([...mine.values()].some((r) => !r.done)) throw new Error('a dependency batch is already merging')
  const now = Date.now()
  for (const [id, r] of mine) if (r.done && now - r.startedAt > RUN_KEEP_MS) mine.delete(id)
  const have = reads.get(rt)
  const run: DepMergeRun = { id: randomUUID().slice(0, 8), startedAt: now, rows: startRows(have ? depBatchView(have.prs, now) : null, refs), done: false, summary: null }
  mine.set(run.id, run)
  const approved = `Merge ${refs.length} on the Junior page`
  log('info', 'babysit', `dependency batch: you approved ${refs.length} merges`, { refs, run: run.id, workspace: rt.meta.id })
  void runDepMerge(run, {
    read: async (ref) => parseDepPr(JSON.parse(await gh(['api', 'graphql', '-f', `query=${DEP_PR_QUERY}`, '-f', `owner=${ref.repo.split('/')[0]}`, '-f', `name=${ref.repo.split('/')[1]}`, '-F', `number=${ref.number}`]))),
    contractMethod: async (repo) => (await contractForRepo(rt, repo))?.merge ?? null,
    merge: (args) => gh(args),
    record: (r) => recordMerge(rt, run, approved, r),
    now: () => Date.now(),
  })
    .then((done) => log('info', 'babysit', `dependency batch: ${done.summary}`, { run: run.id, workspace: rt.meta.id }))
    .catch((err) => {
      run.done = true
      run.summary = `Stopped: ${errText(err)}`
      log('warn', 'babysit', `dependency batch stopped: ${errText(err)}`, { run: run.id, workspace: rt.meta.id })
    })
    .finally(() => {
      reads.delete(rt)
      invalidateInbox(rt)
    })
  return run
}

/** A run's states, for the page's poll. */
export function depMergeRunOp(rt: WorkspaceRuntime, id: string): DepMergeRun {
  const run = runs.get(rt)?.get(id)
  if (!run) throw new Error('no such merge run')
  return run
}
