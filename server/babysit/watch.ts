/**
 * The babysit watch's tick (core/babysit/watch.ts carries the rules): read all
 * your open PRs in one search, file or refresh their items, note what each
 * shows, and on the PRs you handed off turn what's new into tasks
 * (core/work/handoff.ts). No model runs here. A rerun is the one write, and
 * it's yours to do anyway: a check GitHub already ran, run again. A PR you
 * didn't hand off is read, never touched.
 *
 * Every minute while something moves (a check running, a task queued or
 * running), every 5 minutes otherwise. A PR that left the search was merged
 * or closed: its open tasks stop and its watch is dropped.
 */
import type { Store } from '../../core/store/types.js'
import type { WorkItem } from '../../core/work/types.js'
import type { ItemTask } from '../../core/work/tasks.js'
import type { PrCheck } from '../../core/babysit/ci.js'
import { babysitSearch, BABYSIT_QUERY, parseBabysit, type BabysitPr } from '../../core/babysit/pr.js'
import { afterDecision, BABYSIT_FAST_MS, BABYSIT_SLOW_MS, babysitEvents, decide, newBabysitWatch, pollSoon, seenOf, type BabysitWatch } from '../../core/babysit/watch.js'
import { classify, type MainRun } from '../../core/babysit/ci-sort.js'
import type { MainRedCheck } from '../../core/work/handoff.js'

/** The watch's memory, one JSON blob in config: the next poll and each PR's watch, by item id. */
export const BABYSIT_WATCH_KEY = 'babysit.watch'
export type BabysitWatchState = { nextPollAt: number; prs: Record<string, BabysitWatch> }

/**
 * Junior handed in a babysit task (it pushed): read the PR on the next minute
 * tick, not up to 5 minutes later, so the hand-back gate (core/babysit/ready.ts)
 * is about the new head soon. A tick writing at the same moment wins; the
 * next one is at most 5 minutes off, as before.
 */
export async function pollBabysitSoon(store: Store): Promise<void> {
  const state = await store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY)
  if (state && state.nextPollAt > 0) await store.config.set(BABYSIT_WATCH_KEY, { ...state, nextPollAt: 0 } satisfies BabysitWatchState)
}

/** The reads and the one write, through `gh`. Injected so tests run without GitHub. */
export interface BabysitSource {
  login(): Promise<string>
  /** BABYSIT_QUERY's raw answer */
  search(q: string, first: number): Promise<unknown>
  failedLog(repo: string, check: PrCheck): Promise<string>
  /** the check runs on the head of `branch` (the repo's default branch), for "red on main too" */
  mainRuns(repo: string, branch: string): Promise<MainRun[]>
  rerun(repo: string, check: PrCheck): Promise<void>
}

export interface BabysitDeps {
  store: Store
  source: BabysitSource
  repos(): Promise<string[]>
  /** file or refresh the PR's item (projects assigned like any scan) */
  upsertItem(item: WorkItem): Promise<void>
  /** the reviewer Junior suggests for a repo; null until it has learned one */
  reviewerFor(repo: string): Promise<string | null>
  /** a task was added: wake the runner; `stuck` = a cap was hit, tell the user */
  added(task: ItemTask, stuck: boolean): void
  log(level: 'info' | 'error', message: string, fields?: Record<string, unknown>): void
}

export type BabysitTickResult = { polled: number; added: number; reruns: number; stopped: number } | null

/** One pass. Null = not due, or no repos. */
export async function babysitTickOp(d: BabysitDeps, now: number, force = false): Promise<BabysitTickResult> {
  const state = (await d.store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY)) ?? { nextPollAt: 0, prs: {} }
  if (!force && now < state.nextPollAt) return null
  const repos = await d.repos()
  if (repos.length === 0) return null

  const { q, clientFilter } = babysitSearch(await d.source.login(), repos)
  const found = parseBabysit(await d.source.search(q, clientFilter ? 50 : 30), repos, now)
  const out = { polled: found.length, added: 0, reruns: 0, stopped: 0 }
  const prs: Record<string, BabysitWatch> = {}
  const main = mainRunsCache(d)

  for (const { item, pr } of found) {
    await d.upsertItem(item)
    const stored = await d.store.items.get(item.id)
    if (stored && !stored.playbook) await d.store.items.setFields(item.id, { playbook: 'babysit' })
    let w: BabysitWatch = { ...(state.prs[item.id] ?? newBabysitWatch()), headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef, seen: seenOf(pr) }
    // Read, not worked: only a PR you handed off gets tasks.
    if (stored?.handoff === 'on') w = await actOn(d, item.id, pr, w, out, now, main, state.prs[item.id]?.seen?.mainRed)
    prs[item.id] = w
  }

  // Gone from the search: merged or closed. Nothing left to babysit.
  for (const id of Object.keys(state.prs)) {
    if (prs[id]) continue
    for (const t of await d.store.tasks.list(id)) {
      // a running task is the runner's to stop: it reads the PR before it pushes
      if (t.state !== 'queued' && t.state !== 'waiting') continue
      if (await d.store.tasks.move(t.id, 'stopped', { error: 'the PR was merged or closed' }, now)) out.stopped++
    }
  }

  const busy = (await d.store.tasks.inState(['queued', 'running'])).length > 0
  const moved = found.some(({ item, pr }) => {
    const was = state.prs[item.id]?.headSha
    return !!was && was !== pr.headSha
  })
  await d.store.config.set(BABYSIT_WATCH_KEY, { nextPollAt: now + (pollSoon(found.map((f) => f.pr), busy, moved) ? BABYSIT_FAST_MS : BABYSIT_SLOW_MS), prs } satisfies BabysitWatchState)
  if (out.added || out.reruns || out.stopped) d.log('info', `babysit: ${out.polled} PRs, ${out.added} tasks added, ${out.reruns} reruns, ${out.stopped} stopped`)
  return out
}

/** Main's check runs for a repo, read once per tick: null when they couldn't be read. */
type MainRuns = (repo: string, branch: string | null) => Promise<MainRun[] | null>

/**
 * One read of a repo's default branch per tick, however many of its PRs are
 * red. A failed read is kept as null, so it's tried once, logged once, and
 * every check in that repo sorts as if main were unknown (never main-red).
 */
function mainRunsCache(d: BabysitDeps): MainRuns {
  const cache = new Map<string, Promise<MainRun[] | null>>()
  return (repo, branch) => {
    if (!branch) return Promise.resolve(null)
    const key = `${repo}@${branch}`
    let p = cache.get(key)
    if (!p) {
      p = d.source.mainRuns(repo, branch).catch((err: unknown) => {
        d.log('error', `babysit: couldn't read main's checks on ${repo}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      cache.set(key, p)
    }
    return p
  }
}

/**
 * One PR's events → tasks (or a rerun). Returns the watch with the caps
 * counted, and `seen.mainRed` set to the checks red on main too.
 */
async function actOn(
  d: BabysitDeps,
  itemId: string,
  pr: BabysitPr,
  w: BabysitWatch,
  out: NonNullable<BabysitTickResult>,
  now: number,
  mainRuns: MainRuns,
  wasMainRed: readonly MainRedCheck[] = [],
): Promise<BabysitWatch> {
  const ctx = { base: pr.baseRef, isDraft: pr.isDraft, reviewer: null as string | null }
  const mainRed: MainRedCheck[] = []
  for (const ev of babysitEvents(pr)) {
    if (ev.kind === 'green') ctx.reviewer = await d.reviewerFor(pr.repo).catch(() => null)
    let dec = decide(ev, w, ctx)
    // Known already: no main read, no log fetched, nothing added.
    if (dec.do === 'task' && (await d.store.tasks.byKey(itemId, dec.task.key))) continue
    // A new failure: sort it before spending anything on it. Red on main too is
    // settled without its log; else the log says whether it's a flake.
    if (ev.kind === 'checks_failed' && dec.do !== 'none') {
      const runs = await mainRuns(pr.repo, pr.defaultBranch)
      let sort = classify(ev.check, runs, '', [])
      let log = ''
      // the log only where it can change the answer, as before: a fresh fix, on an Actions run
      if (sort.verdict !== 'main-red' && dec.do === 'task' && !dec.stuck && ev.check.runId !== null) {
        log = await d.source.failedLog(pr.repo, ev.check).catch(() => '')
        // the PR's changed files aren't in the search yet: a flaky line that names one still reads as flaky
        sort = classify(ev.check, runs, log, [])
      }
      dec = decide(ev, w, { ...ctx, log, sort })
      if (sort.verdict === 'main-red') {
        const e = sort.evidence
        mainRed.push({ check: ev.check.name, url: e.url, sha: e.sha, at: e.completedAt })
        if (!wasMainRed.some((m) => m.check === ev.check.name)) d.log('info', `babysit: ${ev.check.name} on ${pr.repo}#${pr.number} is red on main too, no task`)
      }
    }
    if (dec.do === 'rerun') {
      try {
        await d.source.rerun(pr.repo, dec.check)
        out.reruns++
        w = afterDecision(w, ev, dec)
      } catch (err) {
        d.log('error', `babysit: rerun of ${dec.check.name} on ${pr.repo}#${pr.number} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      continue
    }
    if (dec.do !== 'task') continue
    const task = await d.store.tasks.add({ ...dec.task, itemId }, now)
    if (!task) continue
    out.added++
    w = afterDecision(w, ev, dec)
    d.added(task, !!dec.stuck)
  }
  return mainRed.length && w.seen ? { ...w, seen: { ...w.seen, mainRed } } : w
}
