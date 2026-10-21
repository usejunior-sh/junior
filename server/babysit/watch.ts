/**
 * The babysit watch's tick (core/babysit/watch.ts carries the rules): read all
 * your open PRs in one search, file or refresh their items, and turn what's
 * new on each into tasks. No model runs here. A rerun is the one write, and
 * it's yours to do anyway: a check GitHub already ran, run again.
 *
 * Every minute while something moves (a check running, a task queued or
 * running), every 5 minutes otherwise. A PR that left the search was merged
 * or closed: its open tasks stop and its watch is dropped.
 */
import type { Store } from '../../core/store/types.js'
import type { WorkItem } from '../../core/work/types.js'
import type { ItemTask } from '../../core/work/tasks.js'
import type { PrCheck } from '../../core/goals/shepherd.js'
import { babysitSearch, BABYSIT_QUERY, parseBabysit, type BabysitPr } from '../../core/babysit/pr.js'
import { afterDecision, BABYSIT_FAST_MS, BABYSIT_SLOW_MS, babysitEvents, decide, newBabysitWatch, pollSoon, type BabysitWatch } from '../../core/babysit/watch.js'
import type { BabysitSettings } from '../../core/babysit/settings.js'

/** The watch's memory, one JSON blob in config: the next poll and each PR's watch, by item id. */
export const BABYSIT_WATCH_KEY = 'babysit.watch'
export type BabysitWatchState = { nextPollAt: number; prs: Record<string, BabysitWatch> }

/** The reads and the one write, through `gh`. Injected so tests run without GitHub. */
export interface BabysitSource {
  login(): Promise<string>
  /** BABYSIT_QUERY's raw answer */
  search(q: string, first: number): Promise<unknown>
  failedLog(repo: string, check: PrCheck): Promise<string>
  rerun(repo: string, check: PrCheck): Promise<void>
}

export interface BabysitDeps {
  store: Store
  source: BabysitSource
  settings(): Promise<BabysitSettings>
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

/** One pass. Null = not due, off, or no repos. */
export async function babysitTickOp(d: BabysitDeps, now: number, force = false): Promise<BabysitTickResult> {
  const settings = await d.settings()
  if (!settings.enabled) return null
  const state = (await d.store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY)) ?? { nextPollAt: 0, prs: {} }
  if (!force && now < state.nextPollAt) return null
  const repos = await d.repos()
  if (repos.length === 0) return null

  const { q, clientFilter } = babysitSearch(await d.source.login(), repos)
  const found = parseBabysit(await d.source.search(q, clientFilter ? 50 : 30), repos, now)
  const out = { polled: found.length, added: 0, reruns: 0, stopped: 0 }
  const prs: Record<string, BabysitWatch> = {}

  for (const { item, pr } of found) {
    await d.upsertItem(item)
    const stored = await d.store.items.get(item.id)
    if (stored && !stored.playbook) await d.store.items.setFields(item.id, { playbook: 'babysit' })
    let w: BabysitWatch = { ...(state.prs[item.id] ?? newBabysitWatch()), headSha: pr.headSha }
    w = await actOn(d, item.id, pr, w, out, now)
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
  await d.store.config.set(BABYSIT_WATCH_KEY, { nextPollAt: now + (pollSoon(found.map((f) => f.pr), busy) ? BABYSIT_FAST_MS : BABYSIT_SLOW_MS), prs } satisfies BabysitWatchState)
  if (out.added || out.reruns || out.stopped) d.log('info', `babysit: ${out.polled} PRs, ${out.added} tasks added, ${out.reruns} reruns, ${out.stopped} stopped`)
  return out
}

/** One PR's events → tasks (or a rerun). Returns the watch with the caps counted. */
async function actOn(d: BabysitDeps, itemId: string, pr: BabysitPr, w: BabysitWatch, out: NonNullable<BabysitTickResult>, now: number): Promise<BabysitWatch> {
  const ctx = { base: pr.baseRef, isDraft: pr.isDraft, reviewer: null as string | null }
  for (const ev of babysitEvents(pr)) {
    if (ev.kind === 'green') ctx.reviewer = await d.reviewerFor(pr.repo).catch(() => null)
    let dec = decide(ev, w, ctx)
    // Known already: no log fetched, nothing added.
    if (dec.do === 'task' && (await d.store.tasks.byKey(itemId, dec.task.key))) continue
    // A new failure may be a flake: read its log and decide again.
    if (ev.kind === 'checks_failed' && dec.do === 'task' && !dec.stuck && ev.check.runId !== null) {
      const log = await d.source.failedLog(pr.repo, ev.check).catch(() => '')
      dec = decide(ev, w, { ...ctx, log })
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
  return w
}
