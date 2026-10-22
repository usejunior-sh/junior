import type { JobRunStatus, JobRunTrigger } from '../../core/job/types.js'
import type { ArtifactAuthor, LinkRole } from './artifacts.js'
import type { ItemImageEdit } from './attachments.js'
import type { SessionKind } from './workspace.js'

// Inbox (GET /api/inbox)
//
// Ranked work items. The domain types live in core/work/types.ts (fat core);
// re-exported here so frontends keep importing one contract file.

export type { Group, ItemKind, Provenance, ScoredItem, WorkItem, WorkSource } from '../../core/work/types.js'

export type InboxSnapshot = {
  syncedAt: number
  items: import('../../core/work/types.js').ScoredItem[]
  notices: string[]
  /** Today's footer: items that went done since local midnight and are still done */
  landedToday?: number
  /** broken things that are not items, a failed job, a paused team run, for Needs you now */
  alerts?: InboxAlert[]
  /** rows in the status tabs, so the sidebar can count them before they're opened */
  counts?: { snoozed: number; archived: number }
}

/** Something broke that isn't a work item; links to where it can be fixed. */
export type InboxAlert = {
  id: string
  kind: 'job' | 'team'
  title: string
  detail?: string
  /** the job to open */
  jobId?: string
  /** the session to open (a team run's lead) */
  sessionId?: string
  at: number
}

export type {
  FlowOverride,
  ItemFlow,
  Stage,
  Turn,
} from '../../core/work/flow.js'

/** POST /api/items/flow: set the user's stage/turn override, or clear it. */
export type FlowOverrideRequest =
  | { id: string; stage?: string; turn?: string; note?: string }
  | { id: string; clear: true }

export type InboxResponse = ({ ok: true } & InboxSnapshot) | { ok: false; error: string }

// A status tab other than the open inbox (done / snoozed / archived). Ranked
// like the inbox but read straight from the durable store, no scan, no cache.
export type ItemListResponse =
  | { ok: true; items: import('../../core/work/types.js').ScoredItem[] }
  | { ok: false; error: string }

/**
 * Everything about one work item, at any status (GET /api/items/detail?id=…).
 *
 * The list endpoints answer "what should I do next" and only ever show open,
 * repo-scoped items; this answers "tell me about this one" and never filters.
 * Its shape is what a model needs to keep walking. Every neighbour carries an
 * id and a title, so each one is a next call rather than a dead end.
 */
export type ItemDetail = {
  item: import('../../core/work/types.js').WorkItem
  /** ranking, when the item is in the open inbox right now; null otherwise */
  rank: { score: number; group: import('../../core/work/types.js').Group; reason: string } | null
  /** items sharing a canonical ref, at any status */
  linked: { id: string; title: string; source: string; url: string; repo: string; status: string }[]
  /** artifacts linked to this item: its brief and any context notes */
  artifacts: { id: string; title: string; role: LinkRole; author: ArtifactAuthor; path: string }[]
  /** sessions that were dispatched for it or briefed it */
  sessions: { id: string; title: string; role: LinkRole; kind: SessionKind; updatedAt: number }[]
  /** stage and turn, where it is and whose move it is */
  flow: import('../../core/work/flow.js').ItemFlow
  /** why it is here, resolved (core/work/fields.ts) */
  reason: import('../../core/work/fields.js').Reason
  /** its task list, oldest first (core/work/tasks.ts) */
  tasks: import('../../core/work/tasks.js').ItemTask[]
}

export type ItemDetailResponse = { ok: true; detail: ItemDetail } | { ok: false; error: string }

/**
 * What a junior session can learn about itself (GET /api/sessions/context?id=…).
 * A session is spawned before it is linked to a work item, so this is the only
 * honest way for one to know what it was opened for. A lookup, not a prompt.
 */
export type SessionContext = {
  workspace: { id: string; name: string; artifactsRoot: string }
  session: { id: string; title: string; kind: SessionKind; cwd: string }
  /** the work item this session was dispatched for or briefs, with its detail */
  item: ItemDetail | null
  /** artifacts attached directly to this session */
  artifacts: { id: string; title: string; role: LinkRole; author: ArtifactAuthor; path: string }[]
}

export type SessionContextResponse = { ok: true; context: SessionContext } | { ok: false; error: string }

/**
 * The end of a background shell's output file
 * (GET /api/sessions/<id>/shells/<tool_use id>/output). `bytes` is the file's
 * whole size; `truncated` says the text starts partway in.
 */
export type ShellOutputResponse = { ok: true; text: string; bytes: number; truncated: boolean } | { ok: false; error: string }

// The append-only transition log for one item (GET /api/items/events?id=…).
export type { ItemEvent, ItemEventKind } from '../../core/work/state.js'

export type ItemEventsResponse =
  | { ok: true; events: import('../../core/work/state.js').ItemEvent[] }
  | { ok: false; error: string }

// Activity (GET /api/activity): job runs, each a real session, as a browsable
// history. Each run links to the transcript (its sessionId) and its produced
// items (.docs/jobs-v2.md).
export type ActivityRun = {
  sessionId: string
  jobId?: string
  jobTitle: string
  status?: JobRunStatus
  /** why the run happened */
  trigger?: JobRunTrigger
  matches?: number
  /** of the matches, how many were new to the inbox */
  newCount?: number
  tokens?: number
  /** dollars, when the run recorded one */
  costUsd?: number
  startedAt: number
  finishedAt: number
  error?: string
}

export type ActivityResponse =
  | { ok: true; runs: ActivityRun[] }
  | { ok: false; error: string }

// Item state (POST /api/items/state), the user-state overlay: done, snoozed,
// dismissed. Ingestion never writes it; the re-arm rule reopens items in code.

export type { ItemStatus } from '../../core/work/state.js'

export type ItemStateResponse = { ok: true } | { ok: false; error: string }
/** POST /api/items/urls: the links as saved (trimmed, deduplicated) */
export type ItemUrlsResponse = { ok: true; urls: string[] } | { ok: false; error: string }

// Manual items (POST/PUT/DELETE /api/items/manual), to-dos the user adds by
// hand in the inbox. Their own table; source/kind 'manual'. Also POST
// /api/items/priority: a user priority override for any item (source or manual).

export type ManualItemInput = {
  title: string
  projectId?: string
  /** the human's short intent, in their words (`note` is the pre-0.7 name, still accepted) */
  description?: string
  note?: string
  url?: string
  /** extra links: the Slack thread, the PR, a doc; the complete list, [] clears */
  urls?: string[]
  priority?: number
  /** the complete desired image set: new base64 uploads and the refs to keep */
  images?: ItemImageEdit[]
  /** the complete desired file set, as ids: files the item holds are kept, upload ids are claimed */
  files?: string[]
}

/** `id` is the new item's on a create (POST). */
export type ManualItemResponse = { ok: true; id?: string } | { ok: false; error: string }

// Ingestion (POST /api/items/upsert, POST /api/items/resolve), the contract
// that makes external scanners first-class; also served over MCP (server/mcp.ts).
// Idempotent: id-keyed, update-only-if-newer, user-state-preserving. Validates
// and rejects rather than repairs.

export type UpsertResponse =
  | { ok: true; outcome: 'inserted' | 'updated' | 'unchanged' }
  | { ok: false; error: string }
