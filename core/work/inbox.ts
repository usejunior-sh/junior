/**
 * Inbox assembly (.docs/jobs-v2.md). Under the durable model every source,
 * GitHub, Slack job hits, manual to-dos, is already a row in the work-item
 * store; nothing is fetched here and there is no user-state overlay (status
 * lives on the row). This is a pure fold: take the items for a status, score
 * them deterministically, and link cross-source refs into one card. No LLM, no
 * I/O, the server does ingestion and reconciliation before calling this.
 */
import { linkByRefs } from './link.js'
import { rank } from './score.js'
import type { ScoredItem, WorkItem } from './types.js'
import type { ScoreWeight } from './weights.js'

export interface InboxOptions {
  /** items already read from the durable store (one row per id) */
  items: WorkItem[]
  /** degraded/skipped sources, for a gray line in the frontends */
  notices?: string[]
  now?: number
  /** the corrections you set (weights.ts); expired ones are ignored at `now` */
  weights?: readonly ScoreWeight[]
}

export interface InboxResult {
  items: ScoredItem[]
  notices: string[]
}

/** Score and link a set of work items into the ranked view the inbox renders. */
export function buildInbox(opts: InboxOptions): InboxResult {
  const now = opts.now ?? Date.now()
  return { items: linkByRefs(rank(opts.items, now, opts.weights)), notices: opts.notices ?? [] }
}
