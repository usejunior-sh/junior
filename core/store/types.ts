/**
 * The persistence seam ("thin frontends, fat core").
 *
 * One interface per aggregate, expressed in domain types. No SQL, no driver
 * types, no dialect. Everything is async even though the SQLite adapter is
 * synchronous underneath: `pg`/`mysql2` never will be, and retrofitting
 * Promises onto every call site later is the expensive rewrite this seam
 * exists to avoid.
 *
 * Portability rules the adapters must follow:
 * - IDs are generated in app code (UUIDs), never by the database.
 * - Times are integer epoch milliseconds.
 * - Booleans are 0/1 in storage, real booleans out here.
 * - JSON is (de)serialized inside the adapter; domain types carry objects.
 */
import type {
  Artifact,
  BriefJob,
  BriefStatus,
  Checkout,
  CheckoutState,
  EffortLevel,
  FileRef,
  InboxSnapshot,
  ItemImage,
  Link,
  LinkKind,
  LinkRole,
  PermissionMode,
  Project,
  ProviderId,
  SearchHit,
  SearchKind,
  SessionEvent,
  SessionKind,
} from '../../shared/protocol.js'

export type { SessionKind }
import type { Provenance, WorkItem } from '../work/types.js'
import type { ItemActor, ItemEvent, ItemNoteKind, ItemStatus, StatusChange } from '../work/state.js'
import type { FlowOverride } from '../work/flow.js'
import type { ActionHistoryEntry, ActionKind, ActionRecord, ActionStatus } from '../actions/types.js'
import type { Gate, Goal, GoalEvent, GoalLogEntry, GoalState, GoalStepState } from '../goals/types.js'
import type { NewJob, NewJobSlotRun, Job, JobRunResult, JobRunStart, JobRunStatus, JobRunTrigger, JobSlotFinish, JobSlotRun } from '../job/types.js'
import type { TodayDay, TodayEntry } from '../junior/today.js'
import type { AdvanceApproval } from '../approvals/approvals.js'
import type { ColorScheme, Viewport } from '../browser/wire.js'
import type { Decision, Handoff, ItemLabel, Playbook, Reason } from '../work/fields.js'
import type { ItemTask, NewTask, TaskState } from '../work/tasks.js'
import type { TeamRun } from '../teams/engine-types.js'
import type { TeamRunSummary } from '../teams/summary.js'
import type { PageBoundary } from './event-page.js'

export type StoredSession = {
  id: string
  title: string
  cwd: string
  /** The project the session runs in: stored, never derived from `cwd` (a worktree's folder isn't the project's). */
  projectId: string | null
  /** The checkout the session runs in: stored at creation, never derived from `cwd`. null only before backfill. */
  checkoutId: string | null
  /** Claude Code's own session id: the key for `resume` and the link to its transcript. */
  sdkSessionId: string | null
  /** The model the user picked; null = whatever Claude Code defaults to. */
  model: string | null
  /** The effort the user picked; null = the model's own default. */
  effort: EffortLevel | null
  /** Fast mode, as the user set it. Persisted so a revived session keeps it. */
  fastMode: boolean
  /** Plan mode: the session reads and plans, edits nothing, until you approve its plan. */
  planning: boolean
  /** Ultracode: Claude Code runs with settings.ultracode, so big jobs fan out as Workflow runs. */
  ultracode: boolean
  /** The session's handle, unique in the workspace: what `/rename` sets, and how another session addresses it. */
  name: string | null
  /** The session that started this one with start_session; null when you did. */
  startedBy: string | null
  /** How much the session asks before acting; null = 'default' (ask). */
  permissionMode: PermissionMode | null
  /** The agent the session runs on, fixed at creation; rows from before providers are 'claude'. */
  provider: ProviderId
  /** Pinned sessions sort above the rest, whatever their last activity. */
  pinned: boolean
  /** chat (default) or job-run. */
  kind: SessionKind
  /** the job this run belongs to, for job-run sessions. */
  jobId: string | null
  /** job-run outcome, recorded when the run finishes (else undefined). */
  runStatus?: JobRunStatus
  /** why this job run happened, set when it starts */
  runTrigger?: JobRunTrigger
  runMatches?: number
  /** of the matches, how many were new to the inbox */
  runNew?: number
  runTokens?: number
  /** dollars, from the SDK's total_cost_usd */
  runCostUsd?: number
  runError?: string
  createdAt: number
  updatedAt: number
}

/** The outcome a finished job-run session records on its own row. */
export type JobRunRecord = {
  status: JobRunStatus
  matches: number
  newCount?: number
  tokens: number
  costUsd?: number
  error?: string
}

export type NewSession = {
  id: string
  title: string
  cwd: string
  /** null only for rows that predate projects; every new session names one */
  projectId: string | null
  checkoutId?: string | null
  model?: string | null
  effort?: EffortLevel | null
  fastMode?: boolean
  planning?: boolean
  ultracode?: boolean
  name?: string | null
  startedBy?: string | null
  permissionMode?: PermissionMode | null
  /** omitted = 'claude' */
  provider?: ProviderId
  kind?: SessionKind
  jobId?: string | null
  runTrigger?: JobRunTrigger
}

export type StoredEvent = {
  seq: number
  event: SessionEvent
  createdAt: number
}

/**
 * One page of a session's log, oldest first. Chain pages by passing the first
 * event's seq as the next `beforeSeq`. `boundary` says how the page was cut
 * (core/store/event-page.ts); only a `hard` cut splits a tool call from its
 * result, though older pages inside that same call may not say `hard`.
 */
export type EventPage = {
  events: StoredEvent[]
  hasEarlier: boolean
  boundary: PageBoundary
}

/** A Claude spawn's `system`/`init` as the event log kept it: which login it started on. */
export type SdkInit = { sessionId: string; at: number; apiKeySource: string }

export interface SessionStore {
  create(s: NewSession): Promise<StoredSession>
  get(id: string): Promise<StoredSession | null>
  /** All sessions: pinned first, then most recently active. */
  list(): Promise<StoredSession[]>
  /** Give every session without a project the one `assign` picks for its cwd; returns how many were set. */
  backfillProjects(assign: (cwd: string) => string | null): Promise<number>
  /** Give every session without a checkout the one `assign` picks for its project; returns how many were set. */
  backfillCheckouts(assign: (projectId: string | null) => string | null): Promise<number>
  setSdkSessionId(id: string, sdkSessionId: string): Promise<void>
  /** Persist a model/effort switch, so a revived session keeps the choice. */
  setModel(id: string, model: string | null, effort: EffortLevel | null): Promise<void>
  /** Persist a fast-mode switch, so a revived session keeps the choice. */
  setFastMode(id: string, fastMode: boolean): Promise<void>
  /** Persist plan mode on or off, so a revived session is still planning. */
  setPlanning(id: string, planning: boolean): Promise<void>
  /** Persist Ultracode on or off, so a revived session keeps it. */
  setUltracode(id: string, on: boolean): Promise<void>
  /** Persist a permission-mode switch, so a revived session keeps the choice. */
  setPermissionMode(id: string, mode: PermissionMode | null): Promise<void>
  /** Give a session a new title. */
  rename(id: string, title: string): Promise<void>
  /** Set or clear a session's handle. Throws when another session holds it (unique index). */
  setName(id: string, name: string | null): Promise<void>
  /** Pin or unpin a session. */
  setPinned(id: string, pinned: boolean): Promise<void>
  /** Delete a session and its whole event log. Irreversible. */
  remove(id: string): Promise<void>
  /** Bump updatedAt (a session saw activity). */
  touch(id: string): Promise<void>
  /** Record a job-run session's outcome on its row (for the Activity view). */
  recordJobRun(id: string, run: JobRunRecord): Promise<void>
}

/**
 * One turn of a session, with the git tree either side of it.
 *
 * Sessions in the same folder share a working tree, so "what did *this*
 * session change" cannot be read off `git status`. It is reconstructed from
 * these: the agent only edits while its own turn runs, so everything between
 * `preTree` and `postTree` happened in this session's window, and is this
 * session's work unless another session's turn overlapped it.
 */
export type StoredTurn = {
  sessionId: string
  seq: number
  /** the repo root this turn ran against */
  root: string
  /** tree sha of the working tree captured just before the turn started */
  preTree: string
  /** tree sha captured after the turn's `result`; null while it is running */
  postTree: string | null
  startedAt: number
  endedAt: number | null
  /** absolute paths this turn's file-editing tools named */
  touched: string[]
}

export interface TurnStore {
  /** Open a turn. Only the pre-turn tree is known at this point. */
  begin(t: { sessionId: string; seq: number; root: string; preTree: string; startedAt: number }): Promise<void>
  /** Close it with the post-turn tree and the paths its tools named. */
  end(
    sessionId: string,
    seq: number,
    post: { postTree: string | null; endedAt: number; touched: string[] },
  ): Promise<void>
  /** This session's turns, oldest first. */
  list(sessionId: string): Promise<StoredTurn[]>
  /** Every *other* session's turns against the same root, for collision checks. */
  othersInRoot(root: string, exceptSessionId: string): Promise<StoredTurn[]>
  /** The highest turn seq recorded for a session, or 0. */
  lastSeq(sessionId: string): Promise<number>
  /** Drop a session's turns (it was deleted). */
  removeFor(sessionId: string): Promise<void>
}

export interface EventStore {
  /** Append one event; `seq` must be the caller's next per-session sequence number. */
  append(sessionId: string, seq: number, event: SessionEvent): Promise<void>
  /** Events after `afterSeq` (exclusive), in order. Omit for the full log. */
  read(sessionId: string, afterSeq?: number): Promise<StoredEvent[]>
  /**
   * The newest events before `beforeSeq` (omit for the log's end): at most
   * `limit`, cut so the page starts on a turn and never splits a tool call
   * from its result, unless one call spans the whole page.
   */
  readPage(sessionId: string, opts?: { beforeSeq?: number; limit?: number }): Promise<EventPage>
  /** The highest seq for a session, or 0 if none. */
  lastSeq(sessionId: string): Promise<number>
  /**
   * Claude spawn inits logged past the cursor `after`, across every session,
   * one page of the log at a time so a big log never holds the loop for long.
   * Ask again from `next` until `done`.
   */
  sdkInits(after: number, page?: number): Promise<{ next: number; done: boolean; inits: SdkInit[] }>
  /**
   * Assistant events in these sessions logged after `since` (exclusive) that
   * may name a file (core/work/supervision.ts touchesOf), oldest first. A
   * cheap text filter runs before any JSON parse, so a long log stays cheap.
   */
  fileEdits(sessionIds: readonly string[], since: number): Promise<(StoredEvent & { sessionId: string })[]>
}

export interface InboxStore {
  /** Persist the latest ranked snapshot (replaces the previous one). */
  save(snapshot: InboxSnapshot): Promise<void>
  load(): Promise<InboxSnapshot | null>
}

/** Small typed KV for settings and source caches (JSON values). */
export interface ConfigStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

export interface ProjectStore {
  list(): Promise<Project[]>
  create(p: Project): Promise<void>
  /** Make `id` the workspace's one default project. */
  setDefault(id: string): Promise<void>
  /** Throws for the default project: it can only be replaced. */
  remove(id: string): Promise<void>
  /** Delete the retired built-in scratch projects (a dev-build leftover); returns what was removed. */
  retireBuiltin(): Promise<Project[]>
}

export type CheckoutPatch = { branch?: string | null; state?: CheckoutState; base?: string | null; itemId?: string | null }

/** A project's folders: its main checkout and its worktrees. */
export interface CheckoutStore {
  /** Every checkout, removed ones included, main first within a project. */
  list(): Promise<Checkout[]>
  create(c: Checkout): Promise<void>
  /** What discovery moves (branch, state), plus what junior knows of a worktree it made itself (base, item). */
  update(id: string, patch: CheckoutPatch): Promise<void>
  /** Drop a project's checkouts with the project. */
  removeForProject(projectId: string): Promise<void>
}

/** Scheduler-owned state on a job, never part of the user's edit. */
export type JobStatePatch = {
  enabled?: boolean
  /** null clears it */
  configError?: string | null
  lastRunStartedAt?: number
  /** null clears it */
  projectId?: string | null
}

export interface JobStore {
  list(): Promise<Job[]>
  get(id: string): Promise<Job | null>
  create(w: Job): Promise<void>
  /** Edit the user-authored fields (and enabled). Bumps updatedAt. */
  update(id: string, patch: Partial<NewJob> & { enabled?: boolean }): Promise<void>
  /** Scheduler-owned fields: config error, the due rule's clock, a forced project. */
  patchState(id: string, patch: JobStatePatch): Promise<void>
  /** A run started (or a slot was skipped): moves the due rule's clock. */
  markRunStarted(id: string, start: JobRunStart): Promise<void>
  /** What a finished run writes back: status, cost, matches, failure streak. */
  recordRun(id: string, run: JobRunResult): Promise<void>
  remove(id: string): Promise<void>
}

/**
 * The slot ledger (`job_runs`): one durable row per (job, slot), scheduled,
 * catch-up, manual or skipped. Additive: the job row and session receipts
 * stay the source for what the UI reads today.
 */
export interface JobRunLedger {
  /** INSERT OR IGNORE on (jobId, slot): the first write wins. True when a row was written. */
  insert(run: NewJobSlotRun): Promise<boolean>
  /** Point a row at the session holding its transcript, as soon as there is one. */
  attachSession(jobId: string, slot: number, sessionId: string): Promise<void>
  /** Close a still-`running` row for (jobId, slot). True when a row was updated. */
  finish(jobId: string, slot: number, end: JobSlotFinish): Promise<boolean>
  /**
   * The slots a catch-up run collapsed: one `missed` row each, reason
   * `covered by <runId>`. INSERT OR IGNORE: an existing row keeps its own
   * story. Returns how many were written.
   */
  insertMissed(jobId: string, slots: number[], runId: string, at: number): Promise<number>
  /** One job's rows, newest slot first. */
  list(jobId: string, limit?: number): Promise<JobSlotRun[]>
  /** Dollars one job's runs recorded since `since` (epoch ms), the daily budget's meter. */
  spentSince(jobId: string, since: number): Promise<number>
  /** When each job's latest `ok` row ended, the overdue rule's clock. */
  lastOkAt(): Promise<Map<string, number>>
  /** Boot: every `running` row died with the previous process. Returns how many. */
  sweepInterrupted(endedAt: number, reason: string): Promise<number>
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged'

export type UpsertResult = {
  outcome: UpsertOutcome
  /** the reopen rule fired: a done item returned to open on newer source activity */
  reopened: boolean
}

export type NewManualItem = {
  id: string
  title: string
  projectId?: string
  description?: string
  url?: string
  /** extra links (see WorkItem.urls); on update, [] clears them */
  urls?: string[]
  priority?: number
}

/**
 * The durable inbox (.docs/jobs-v2.md): one row per work item, keyed by its
 * canonical id, for every source, built-ins, job hits, GitHub, and manual
 * to-dos. Never hard-deleted, never auto-expired; an item leaves the open inbox
 * only by a recorded transition (done/snoozed/archived) or a wake. The
 * idempotent upsert rule and the deterministic reopen rule live in the adapter
 * Correctness lives in the contract, not the prompt. Every transition is appended
 * to the item's own event log.
 */
/** What the store keeps about an item's flow: the last derived stage/turn and any override. */
export interface StoredFlow {
  stage: string | null
  turn: string | null
  override: FlowOverride | null
}

/** One item that reached Needs you, and what put it there. */
export type SurfacedEntry = { id: string; detail?: Record<string, unknown> }

/** An item event read by window: the event and whose it is. */
export type ItemWindowEvent = ItemEvent & { itemId: string }

export interface WorkItemStore {
  /**
   * Insert or refresh one scanned/source item. Id exists → update payload only
   * if the incoming source time is newer (re-ranking is correct); state columns
   * are never touched by ingestion, except the reopen rule (a done item with
   * newer source activity returns to open). `provenance` is appended to the
   * item's foundBy list. New id → insert with a 'created' event.
   */
  upsert(item: WorkItem, provenance?: Provenance): Promise<UpsertResult>
  /** A user-authored to-do (source/kind 'manual'); returns the created id. */
  createManual(item: NewManualItem): Promise<string>
  updateManual(id: string, patch: Partial<Omit<NewManualItem, 'id'>>): Promise<void>
  get(id: string): Promise<WorkItem | null>
  /** Items in one status (default 'open'), newest source activity first. */
  list(status?: ItemStatus): Promise<WorkItem[]>
  /** Every item regardless of status, for reconciliation and counts. */
  listAll(): Promise<WorkItem[]>
  /** Record a status transition: append the matching event and set the column. */
  transition(id: string, change: StatusChange): Promise<void>
  /** Set (or clear, with null) the user priority override. */
  setPriority(id: string, priority: number | null): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  /**
   * The user's due day (local midnight ms; `at: null` = Later), or null to go
   * back to the label's default. A user-set due outlives rescans.
   */
  setDue(id: string, due: { at: number | null } | null): Promise<void>
  /** Snoozes whose wake time has elapsed → open (+ a 'woken' event). Returns woken ids. */
  wakeSnoozed(now: number): Promise<string[]>
  /**
   * Stage/turn as last recorded, and the user's override, per item
   * (core/work/flow.ts). Items never recorded are absent.
   */
  flowState(): Promise<Map<string, StoredFlow>>
  /** The derived flow moved: set the columns and append a 'moved' event. */
  recordFlow(id: string, flow: { stage: string; turn: string }, detail?: Record<string, unknown>): Promise<void>
  /** Set (or clear, with null) the user's stage/turn override; appends a 'flow-set' event. */
  setFlowOverride(id: string, override: FlowOverride | null, actor: string): Promise<void>
  /** Items that went done at or after `since` and are still done ("Landed today"). */
  countDoneSince(since: number): Promise<number>
  /** When each of these items last changed status (epoch ms). A plan row's "done 06:10". Unknown ids are absent. */
  statusTimes(ids: readonly string[]): Promise<Map<string, number>>
  /** Archived items whose latest archive was a Delete (`reason: 'deleted by user'`): Archived's Deleted filter. */
  deletedIds(): Promise<Set<string>>
  /** The append-only transition log for one item, in order. */
  events(id: string): Promise<ItemEvent[]>
  /**
   * Record that these items reached Needs you: one `surfaced` event per open
   * cycle (core/work/state.ts itemCycles). An item that isn't open, or whose
   * current cycle already has one, is skipped, so calling this on every sync
   * is safe. Returns the ids it marked.
   */
  markSurfaced(entries: readonly SurfacedEntry[], at: number): Promise<string[]>
  /** Append a note (surfaced, not-useful) to an item's log; its status doesn't move. False = no such item. */
  note(id: string, event: ItemNoteKind, actor: ItemActor, at: number, detail?: Record<string, unknown>): Promise<boolean>
  /**
   * Take back the newest `event` by `actor` on the item, if it was written at
   * or after `since`: the one exception to the append-only log, for an undo
   * within seconds. False = nothing that new to take back.
   */
  unnote(id: string, event: ItemNoteKind, actor: ItemActor, since: number): Promise<boolean>
  /** Every note of this kind on any item, oldest first, each with its item's id ("not a promise" → suppressed threads). */
  notesOf(event: ItemNoteKind): Promise<ItemWindowEvent[]>
  /** Every item event with `at` in [since, until), oldest first, each with its item's id. */
  eventsBetween(since: number, until: number): Promise<ItemWindowEvent[]>
  /** Set (or clear, with null) the human's description on any item. Never touched by ingestion. */
  setDescription(id: string, description: string | null): Promise<void>
  /**
   * Replace the image refs on any item. The bytes are the caller's business
   * (they live on disk); this only records what the item now holds.
   */
  setImages(id: string, images: ItemImage[]): Promise<void>
  /** Replace the file refs on any item ([] clears). Like images, the bytes are the caller's business. */
  setFiles(id: string, files: FileRef[]): Promise<void>
  /** Replace the human's links on any item ([] clears). Never touched by ingestion. */
  setUrls(id: string, urls: string[]): Promise<void>
  /** Give every item without a project the one `assign` picks; returns how many were set. */
  backfillProjects(assign: (item: WorkItem) => string | null): Promise<number>
  /**
   * Set or clear (null) reason · label · parent · playbook · handoff · notNow · notNowReason · notUseful · changesSeenAt · keptOpen (core/work/fields.ts).
   * Absent keys are left alone. Never touched by ingestion.
   */
  setFields(id: string, patch: ItemFieldsPatch): Promise<void>
  /** Replace the item's plan (null clears). Decisions are kept. */
  setPlan(id: string, plan: string | null): Promise<void>
  /** Append one decision to the item's memory. */
  addDecision(id: string, decision: Decision): Promise<void>
}

export type ItemFieldsPatch = {
  reason?: Reason | null
  label?: ItemLabel | null
  parent?: string | null
  playbook?: Playbook | null
  handoff?: Handoff | null
  notNow?: string | null
  notNowReason?: import('../junior/suggest.js').NotNowMark | null
  notUseful?: string | null
  changesSeenAt?: number | null
  keptOpen?: number | null
}

/**
 * Tasks on items (core/work/tasks.ts). Moves are checked against `canMove`:
 * a move a task can't make returns null and changes nothing, so a late
 * result never revives a task you stopped.
 */
export interface ItemTaskStore {
  /** Add a task; null when the item already has one with this `key`. */
  add(task: NewTask, now: number): Promise<ItemTask | null>
  get(id: string): Promise<ItemTask | null>
  /** One item's tasks, oldest first. */
  list(itemId: string): Promise<ItemTask[]>
  /** Several items' tasks, oldest first, grouped by item. */
  forItems(itemIds: readonly string[]): Promise<Map<string, ItemTask[]>>
  /** Every task in these states, oldest first, across items: the runner's queue. */
  inState(states: readonly TaskState[]): Promise<ItemTask[]>
  /** The task with this key on this item, if any. */
  byKey(itemId: string, key: string): Promise<ItemTask | null>
  /**
   * Move a task and set what came with the move. Starting sets `startedAt` and
   * bumps `attempts`; finishing sets `endedAt`. Null = no such task, or a move
   * it can't make.
   */
  move(id: string, to: TaskState, patch: TaskMovePatch, now: number): Promise<ItemTask | null>
  /** Add to a task's spend (its sessions' cost). */
  addCost(id: string, usd: number): Promise<void>
  /** Running tasks left over from a daemon that stopped: back to queued. Returns their ids. */
  requeueRunning(): Promise<string[]>
  /** What tasks started at or after `since` have spent, in USD: the daily budget's meter. */
  spentSince(since: number): Promise<number>
}

export type TaskMovePatch = Partial<Pick<ItemTask, 'output' | 'error' | 'sessionId' | 'model'>>

export type NewBriefJob = {
  id: string
  itemId: string
  playbook: string
  /** the template text edited for this brief only; null = read the playbook file */
  playbookBody?: string | null
  model?: string | null
  note?: string | null
  /** born running in this session (never queued). A reply to a brief session that already knows the item */
  running?: { sessionId: string; startedAt: number }
}

/**
 * Brief jobs: the queue and the state machine
 * in one table, so it survives a restart and stays FIFO. The current brief of
 * an item is its newest job.
 */
export interface BriefJobStore {
  create(j: NewBriefJob): Promise<BriefJob>
  get(id: string): Promise<BriefJob | null>
  /** The newest job for an item, whatever its status. */
  latestForItem(itemId: string): Promise<BriefJob | null>
  /** The newest job that ran (or runs) in a session, how a revived brief session finds its tool. */
  forSession(sessionId: string): Promise<BriefJob | null>
  /** The newest job per item: the inbox's status pills in one query. */
  latestPerItem(): Promise<BriefJob[]>
  /** Jobs in one status, oldest first (the queue order for 'queued'). */
  list(status?: BriefStatus): Promise<BriefJob[]>
  /** How many jobs started at or after `sinceMs`, the daily cap's counter. */
  countStartedSince(sinceMs: number): Promise<number>
  update(id: string, patch: Partial<Omit<BriefJob, 'id' | 'itemId' | 'playbook' | 'playbookBody'>>): Promise<void>
  /** Boot: every 'running' job's subprocess died with the old daemon. Returns the ids. */
  failAllRunning(error: string): Promise<string[]>
  /** Drop a job (cancelling a queued one). */
  remove(id: string): Promise<void>
}

/**
 * The artifacts index: one row per markdown
 * file under the workspace's artifacts folder. The file is the truth: rows are
 * rebuilt from disk by the server's indexer, never edited on their own.
 */
export interface ArtifactStore {
  /** Insert or replace the row for this id; a stale row at the same path (a replaced file) is dropped. */
  upsert(a: Artifact): Promise<void>
  get(id: string): Promise<Artifact | null>
  getByPath(path: string): Promise<Artifact | null>
  /** Every indexed artifact, most recently updated first. */
  list(): Promise<Artifact[]>
  remove(id: string): Promise<void>
}

export type SearchOptions = {
  /** only these kinds; empty or absent = every kind */
  kinds?: SearchKind[]
  /** at most this many hits (default 20, capped at 100) */
  limit?: number
}

/**
 * Local full-text search over items, sessions and artifacts. Items and
 * sessions follow their own rows; an artifact's body is read off disk by the
 * artifact indexer and handed in here.
 */
export interface SearchStore {
  /** Best hits first, each with a snippet; every word is a prefix and all must match. */
  search(q: string, opts?: SearchOptions): Promise<SearchHit[]>
  /** Set the searchable text of an indexed artifact (no-op for an unknown id). */
  setArtifactBody(id: string, body: string): Promise<void>
  /** Indexed artifacts whose body has not been read yet. */
  artifactsWithoutBody(): Promise<string[]>
  /** Refill the index from the rows (artifact bodies are read again later). */
  rebuild(): Promise<void>
}

export type NewLink = { fromKind: LinkKind; fromId: string; toKind: LinkKind; toId: string; role: LinkRole }

/**
 * Relations between artifacts, work items and sessions, polymorphic on purpose
 * so "which sessions worked this item" and "which document is its brief" are
 * one table and one query shape.
 */
export interface LinkStore {
  /** Idempotent on (from, to, role): an existing identical link is returned, not duplicated. */
  add(l: NewLink): Promise<Link>
  remove(id: string): Promise<void>
  /** Drop every link touching an entity, either side, when the entity goes away. */
  removeFor(kind: LinkKind, id: string): Promise<void>
  forTarget(kind: LinkKind, id: string): Promise<Link[]>
  forSource(kind: LinkKind, id: string): Promise<Link[]>
  list(): Promise<Link[]>
}

/** Which actions to list: all of them, or narrowed. Newest first. */
export type ActionQuery = {
  kind?: ActionKind
  sessionId?: string
  /** records filed against the item, or made by any of `sessionIds` */
  itemId?: string
  sessionIds?: string[]
  /** started at or after this (ms epoch) */
  since?: number
  /** only records in one of these statuses */
  status?: ActionStatus[]
  limit?: number
}

/**
 * Held actions, for the track record (core/approvals/track.ts): the ones
 * that waited on you, of a kind, started in [since, until]. Newest first.
 */
export type HeldActionQuery = {
  kind?: ActionKind
  since: number
  until?: number
  limit?: number
}

/**
 * Outbound actions (core/actions): one row per action, and one call row per
 * tool_use folded into it. The map from a transcript's tool call to its
 * record, and what makes recording a call twice a no-op.
 */
export interface ActionStore {
  get(id: string): Promise<ActionRecord | null>
  /** The record a tool call was folded into. */
  byCall(sessionId: string, toolUseId: string): Promise<ActionRecord | null>
  /** The record a collapsing call joins (one per git push branch per session). */
  byGroup(groupKey: string): Promise<ActionRecord | null>
  /** Insert or replace a record, and point each of its calls at it. */
  put(rec: ActionRecord): Promise<void>
  /** Drop a record (merged into another); its calls go with it unless re-put. */
  remove(id: string): Promise<void>
  list(q?: ActionQuery): Promise<ActionRecord[]>
  /** Held actions only (a `queue`), by kind and window: what the track record reads. */
  held(q: HeldActionQuery): Promise<ActionRecord[]>
  /**
   * Move a record `from` → `to` in one atomic update, only if it is still in
   * `from` (and, with `dueBy`, its send time has come). True = this caller
   * moved it; false = someone else did first, or it wasn't there. What makes
   * the dispatcher send an approved action at most once.
   */
  claim(id: string, from: ActionStatus, to: ActionStatus, at: number, opts?: { dueBy?: number }): Promise<boolean>
  /** Append one step of a queued action's life. */
  addHistory(e: ActionHistoryEntry): Promise<void>
  /** The history of each record, oldest step first. */
  history(ids: string[]): Promise<Map<string, ActionHistoryEntry[]>>
}

/** Which goals to list. Newest update first. */
export type GoalQuery = {
  states?: GoalState[]
  sourceItemId?: string
  limit?: number
}

/** What goal_create writes: the record without its run-time fields, which start empty. */
export type NewGoal = Pick<Goal, 'id' | 'title' | 'doneWhen' | 'horizon' | 'sourceItemId' | 'key' | 'projectId' | 'budget' | 'priority'>

/** `goal_sessions`: a log entry's structured half; its words live in log.md. */
export type GoalSessionRecord = Omit<GoalLogEntry, 'text'>

/**
 * Goals (core/goals): the record, its event log, its steps, gates and
 * sessions (adapter: core/store/sqlite-goals.ts). Only the engine moves `state`, and only through
 * `move`, which is atomic and logs the transition.
 */
export interface GoalStore {
  get(id: string): Promise<Goal | null>
  byKey(key: string): Promise<Goal | null>
  list(q?: GoalQuery): Promise<Goal[]>
  /**
   * Insert in `draft_plan` with its `created` event. A taken `key` returns that goal, `created: false`;
   * with no key, so does a live (not done/cancelled) key-less goal with the same title and done-when.
   * The lookup and the insert are one transaction, so two concurrent identical calls make one goal.
   */
  create(goal: NewGoal, at: number): Promise<{ goal: Goal; created: boolean }>
  /** Change anything but `state` (plan, current step, spend, worktree…). Null when there is no such goal. */
  update(id: string, patch: Partial<Omit<Goal, 'id' | 'state' | 'createdAt' | 'updatedAt'>>, at: number): Promise<Goal | null>
  /**
   * Move `from` → `to` only if the goal is still in `from`, and append the
   * `transition` event, in one transaction. True = this caller moved it.
   */
  move(id: string, from: GoalState, to: GoalState, ev: Pick<GoalEvent, 'actor' | 'sessionId' | 'detail'> & { reason?: string | null }, at: number): Promise<boolean>
  /** Append an event at the goal's next seq. */
  addEvent(e: Omit<GoalEvent, 'seq' | 'handledAt'>): Promise<GoalEvent>
  /** One goal's events, oldest first; `after` = only seqs past it. */
  events(goalId: string, opts?: { after?: number; limit?: number }): Promise<GoalEvent[]>
  /** Every event not yet acted on, across goals, oldest first. The replay after a restart. */
  unhandled(): Promise<GoalEvent[]>
  markHandled(goalId: string, seq: number, at: number): Promise<void>
  steps(goalId: string): Promise<GoalStepState[]>
  putStep(s: GoalStepState): Promise<void>
  gate(id: string): Promise<Gate | null>
  gates(goalId: string): Promise<Gate[]>
  putGate(g: Gate): Promise<void>
  /** Open AI gates whose next check is at or before `now`, the sweep's work list. */
  dueGates(now: number): Promise<Gate[]>
  /** Open gates of either kind whose deadline is at or before `now`. They go to the user. */
  overdueGates(now: number): Promise<Gate[]>
  /** Upsert on (goalId, sessionId): a session's row is written at start and closed at its end. */
  putSession(r: GoalSessionRecord): Promise<void>
  sessions(goalId: string): Promise<GoalSessionRecord[]>
}

/**
 * Today's plan (core/junior/today.ts): rows per local day, plus each day's own
 * record, so an emptied day stays opened and a removed row is not drafted back.
 * Done is never stored here: it is the item's own status.
 */
export interface TodayStore {
  /** The day's record, or null when it was never opened. */
  day(date: string): Promise<TodayDay | null>
  /**
   * Open a day: its record and its first rows (the carry-overs), in one
   * transaction. The record is INSERT OR IGNORE: false = someone opened it
   * first, and the rows were not written.
   */
  openDay(day: TodayDay, rows: readonly TodayEntry[]): Promise<boolean>
  /** The morning draft ran (whether or not it added anything). */
  setDrafted(date: string, at: number): Promise<void>
  /** One day's rows, in order. */
  entries(date: string): Promise<TodayEntry[]>
  /** The latest day before `date` with rows, and its rows, where carry-overs come from. */
  lastBefore(date: string): Promise<{ date: string; entries: TodayEntry[] } | null>
  /** Insert a row, or update its owner in place (a row keeps its position). */
  put(e: TodayEntry): Promise<void>
  /** Take a row off a day; false = it wasn't there. */
  remove(date: string, itemId: string): Promise<boolean>
  /** Has a plan ever existed in this workspace (any row, any drafted day)? */
  everPlanned(): Promise<boolean>
}

/** Advance approvals (core/approvals/approvals.ts). Revoking keeps the row. */
export interface ApprovalStore {
  /** Every approval, revoked ones included, newest first. */
  list(): Promise<AdvanceApproval[]>
  get(id: string): Promise<AdvanceApproval | null>
  /** The approval a proposal card was added as, if it was. */
  byProposal(proposalId: string): Promise<AdvanceApproval | null>
  put(a: AdvanceApproval): Promise<void>
  /** false = no such approval, or revoked already */
  revoke(id: string, at: number): Promise<boolean>
  /** It let a send through. */
  used(id: string, at: number): Promise<void>
}

/**
 * The browser pane's memory of one session's tab (.docs/browser.md →
 * Profiles). Written as the tab moves, read when it has to come back.
 */
export type BrowserTabRow = {
  sessionId: string
  /** the profile picked for this session; null = follow the default */
  profile: string | null
  url: string
  title: string
  /** null = fit the pane */
  viewport: Viewport | null
  colorScheme: ColorScheme
  updatedAt: number
}

export interface BrowserTabStore {
  get(sessionId: string): Promise<BrowserTabRow | null>
  /** Upsert: fields left out keep their value (a new row starts empty, following the default). */
  put(sessionId: string, patch: Partial<Omit<BrowserTabRow, 'sessionId' | 'updatedAt'>>, at: number): Promise<void>
  remove(sessionId: string): Promise<void>
  /** The sessions put in this profile (a deleted profile's go back to the default). */
  withProfile(profile: string): Promise<string[]>
}

/** One line of a team run's append-only log. `data` is whatever the caller wrote, as JSON. */
export type TeamRunEvent<T = unknown> = {
  runId: string
  /** 1, 2, 3… per run, in the order appended */
  seq: number
  at: number
  data: T
}

/**
 * Team runs (core/teams/engine.ts), goals included: one row per run instead of
 * one config value rewritten on every save. A run is open until it is `done`
 * or `stopped` (TEAM_RUN_CLOSED_STATES in core/store/sqlite-team-runs.ts).
 */
export interface TeamRunStore {
  /** Insert or replace the whole run. `at` is its updated_at. */
  upsert(run: TeamRun, at: number): Promise<void>
  get(id: string): Promise<TeamRun | null>
  /** Every run not done or stopped, oldest first: what boot needs in memory. */
  listOpen(): Promise<TeamRun[]>
  /** The latest-touched runs, newest first. `goal` keeps only goals (true) or only plain team runs (false). */
  listRecent(limit: number, opts?: { goal?: boolean }): Promise<TeamRun[]>
  /**
   * Every done or stopped run as a summary (core/teams/summary.ts), oldest
   * first, read out of the stored JSON without loading the runs: what boot
   * needs for the session list and the inbox flow.
   */
  closedSummaries(): Promise<TeamRunSummary[]>
  /** Delete the run and its log (a discarded card, a lead session deleted). */
  remove(id: string): Promise<void>
  /** Append to the run's log; returns the line with its seq. */
  appendEvent<T>(runId: string, data: T, at: number): Promise<TeamRunEvent<T>>
  /** The run's log, oldest first. */
  events(runId: string): Promise<TeamRunEvent[]>
}

export interface Store {
  sessions: SessionStore
  events: EventStore
  turns: TurnStore
  inbox: InboxStore
  config: ConfigStore
  projects: ProjectStore
  checkouts: CheckoutStore
  jobs: JobStore
  jobRuns: JobRunLedger
  items: WorkItemStore
  artifacts: ArtifactStore
  search: SearchStore
  links: LinkStore
  briefs: BriefJobStore
  actions: ActionStore
  goals: GoalStore
  today: TodayStore
  tasks: ItemTaskStore
  approvals: ApprovalStore
  browserTabs: BrowserTabStore
  teamRuns: TeamRunStore
  close(): Promise<void>
}
