/**
 * The review watch's tick (core/review carries the rules): read every open PR
 * that asks for your review in one search, file or refresh their items, and
 * add a first-pass task per new request. No model runs here.
 *
 * Every 2 minutes while first-pass reviews are on. A PR that left the search
 * no longer asks you (you reviewed it, the request was withdrawn, it was
 * merged or closed): its queued pass and its unposted review stop.
 */
import type { Store } from '../../core/store/types.js'
import type { WorkItem } from '../../core/work/types.js'
import type { ItemTask } from '../../core/work/tasks.js'
import type { BabysitSettings } from '../../core/babysit/settings.js'
import { parseReview, reviewSearch } from '../../core/review/pr.js'
import { REVIEW_POLL_MS, reviewTask, stopsWhenGone, watchOf, type ReviewWatch } from '../../core/review/watch.js'

/** The watch's memory, one JSON blob in config: the next poll and each PR's watch, by item id. */
export const REVIEW_WATCH_KEY = 'review.watch'
export type ReviewWatchState = { nextPollAt: number; prs: Record<string, ReviewWatch> }

/** The reads, through `gh`. Injected so tests run without GitHub. */
export interface ReviewSource {
  login(): Promise<string>
  /** REVIEW_QUERY's raw answer */
  search(q: string, first: number): Promise<unknown>
}

export interface ReviewDeps {
  store: Store
  source: ReviewSource
  settings(): Promise<BabysitSettings>
  repos(): Promise<string[]>
  /** file or refresh the PR's item (projects assigned like any scan) */
  upsertItem(item: WorkItem): Promise<void>
  /** a task was added: wake the runner */
  added(task: ItemTask): void
  log(level: 'info' | 'error', message: string, fields?: Record<string, unknown>): void
}

export type ReviewTickResult = { polled: number; added: number; stopped: number } | null

/** One pass. Null = not due, off, or no repos. */
export async function reviewTickOp(d: ReviewDeps, now: number, force = false): Promise<ReviewTickResult> {
  const settings = await d.settings()
  if (!settings.reviews) return null
  const state = (await d.store.config.get<ReviewWatchState>(REVIEW_WATCH_KEY)) ?? { nextPollAt: 0, prs: {} }
  if (!force && now < state.nextPollAt) return null
  const repos = await d.repos()
  if (repos.length === 0) return null

  const login = await d.source.login()
  const { q, clientFilter } = reviewSearch(login, repos)
  const found = parseReview(await d.source.search(q, clientFilter ? 50 : 30), repos, login)
  const out = { polled: found.length, added: 0, stopped: 0 }
  const prs: Record<string, ReviewWatch> = {}

  for (const { item, pr } of found) {
    await d.upsertItem(item)
    const stored = await d.store.items.get(item.id)
    if (stored && !stored.playbook) await d.store.items.setFields(item.id, { playbook: 'review' })
    prs[item.id] = watchOf(pr)
    const spec = reviewTask(pr)
    if (await d.store.tasks.byKey(item.id, spec.key)) continue
    const task = await d.store.tasks.add({ ...spec, itemId: item.id }, now)
    if (!task) continue
    out.added++
    d.added(task)
  }

  // Gone from the search: it no longer asks you. A running pass is the runner's to finish.
  for (const id of Object.keys(state.prs)) {
    if (prs[id]) continue
    for (const t of await d.store.tasks.list(id)) {
      if (!stopsWhenGone(t)) continue
      if (await d.store.tasks.move(t.id, 'stopped', { error: 'the PR no longer asks for your review' }, now)) out.stopped++
    }
  }

  await d.store.config.set(REVIEW_WATCH_KEY, { nextPollAt: now + REVIEW_POLL_MS, prs } satisfies ReviewWatchState)
  if (out.added || out.stopped) d.log('info', `review: ${out.polled} PRs ask you, ${out.added} passes added, ${out.stopped} stopped`)
  return out
}
