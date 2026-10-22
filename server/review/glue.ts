/**
 * First-pass reviews, wired to a workspace: the `gh` source, the repos the
 * workspace tracks, and the minute tick.
 * The rules are in core/review, the tick's logic in ./watch.ts.
 */
import { REVIEW_QUERY } from '../../core/review/pr.js'
import { ghLogin } from '../../core/sources/github.js'
import { gh, runTickHooks, taskAdded } from '../babysit/glue.js'
import { connectedRepos } from '../inbox/sync.js'
import { log } from '../log.js'
import { upsertItem, watchesOn } from '../settings-ops.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { invalidateInbox } from '../ws/send.js'
import { reviewTickOp, type ReviewDeps, type ReviewSource } from './watch.js'

export const ghReviewSource: ReviewSource = {
  login: ghLogin,
  search: async (q, first) => JSON.parse(await gh(['api', 'graphql', '-f', `query=${REVIEW_QUERY(first)}`, '-f', `q=${q}`])),
}

export function reviewDeps(rt: WorkspaceRuntime): ReviewDeps {
  return {
    store: rt.store,
    source: ghReviewSource,
    repos: () => connectedRepos(rt),
    upsertItem: async (item) => void (await upsertItem(rt, item)),
    added: (task) => taskAdded(rt, task, false),
    log: (level, message, fields) => log(level, 'review', message, { ...fields, workspace: rt.meta.id }),
  }
}

/** One pass per workspace at a time. */
const ticking = new WeakSet<WorkspaceRuntime>()
export async function reviewTick(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (ticking.has(rt)) return
  ticking.add(rt)
  try {
    if (!(await watchesOn(rt)).review) return
    const r = await reviewTickOp(reviewDeps(rt), Date.now(), force)
    if (r && (r.added || r.stopped)) invalidateInbox(rt)
  } finally {
    ticking.delete(rt)
    runTickHooks(rt)
  }
}
