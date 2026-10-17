/**
 * SQLite adapter for the Store interface, on node:sqlite (stdlib — keeps the
 * global install dependency-free; vision principle 5).
 *
 * Single-writer by design: SQLite has one writer and this process is it.
 * Nothing here may leak into the interface — a Postgres adapter for the hosted
 * version implements core/store/types.ts, not this file.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Artifact, BriefJob, BriefStatus, Checkout, CheckoutState, FileRef, InboxSnapshot, ItemImage, Link, LinkKind, LinkRole, Project, SessionEvent } from '../../shared/protocol.js'
import { isArtifactAuthor, isLinkKind, isLinkRole } from '../../shared/protocol.js'
import type { Provenance, WorkItem } from '../work/types.js'
import type { ItemEvent, ItemEventKind, ItemStatus, StatusChange } from '../work/state.js'
import { isStage, isTurn, type FlowOverride } from '../work/flow.js'
import { eventForStatus, shouldReopen } from '../work/state.js'
import type { EffortLevel, PermissionMode, ProviderId } from '../../shared/protocol.js'
import { isProviderId } from '../../shared/protocol.js'
import type { NewJob, Job, JobBrief, JobCadence, JobConnector, JobNotify, JobRunResult, JobRunStart, JobRunStatus, JobRunTrigger, JobSlotFinish, JobSlotRun, JobSlotStatus, NewJobSlotRun } from '../job/types.js'
import { JOB_NOTIFY, JOB_RUN_STATUSES } from '../job/types.js'
import { cronFromCadence } from '../job/cron.js'
import { SqliteGoals } from './sqlite-goals.js'
import { grantsFrom, grantsFromLegacy, type JobToolGrant } from '../job/tools.js'
import type { ActionActor, ActionHistoryEntry, ActionRecord, ActionStatus } from '../actions/types.js'
import { isActionAllowedBy, isActionKind, isActionStatus, isActionWhy } from '../actions/types.js'
import type {
  ActionQuery,
  ActionStore,
  ArtifactStore,
  BriefJobStore,
  CheckoutPatch,
  CheckoutStore,
  ConfigStore,
  LinkStore,
  NewBriefJob,
  NewLink,
  ProjectStore,
  EventStore,
  InboxStore,
  NewManualItem,
  NewSession,
  SessionKind,
  SessionStore,
  Store,
  StoredEvent,
  StoredFlow,
  StoredSession,
  StoredTurn,
  JobStatePatch,
  TurnStore,
  UpsertResult,
  JobRunRecord,
  JobRunLedger,
  JobStore,
  TodayStore,
  WorkItemStore,
} from './types.js'
import { isOwner, type AddedBy, type TodayDay, type TodayEntry } from '../junior/today.js'

/**
 * Today's plan (core/junior/today.ts): a record per local day and its rows.
 * IF NOT EXISTS throughout: migration 31 and ensureDurableSchema both run it,
 * so the tables exist however the version counter got here (another branch
 * may claim 31 for its own tables first).
 */
const TODAY_SCHEMA = `CREATE TABLE IF NOT EXISTS today_days (
     date       TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     drafted_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS today_entries (
     date         TEXT NOT NULL,
     item_id      TEXT NOT NULL,
     owner        TEXT NOT NULL,
     added_by     TEXT NOT NULL,
     added_at     INTEGER NOT NULL,
     ord          REAL NOT NULL,
     carried_from TEXT,
     PRIMARY KEY (date, item_id)
   );`

/**
 * Goals (core/goals/types.ts). `plan` and `budget` are JSON; `plan.md` in the
 * ledger folder is the plan's source and this caches it parsed. `key` is
 * goal_create's caller-stable id, unique when given. Transitions update `state`
 * with `WHERE id = ? AND state = ?` and append a `goal_events` row in one
 * transaction. IF NOT EXISTS throughout: migration 31 and ensureDurableSchema
 * both run it.
 */
const GOALS_SCHEMA = `CREATE TABLE IF NOT EXISTS goals (
     id             TEXT PRIMARY KEY,
     title          TEXT NOT NULL,
     done_when      TEXT NOT NULL,
     horizon        TEXT NOT NULL,
     state          TEXT NOT NULL,
     reason         TEXT,
     source_item_id TEXT,
     key            TEXT,
     project_id     TEXT,
     checkout_id    TEXT,
     plan           TEXT,
     plan_version   INTEGER NOT NULL DEFAULT 0,
     current_step   TEXT,
     budget         TEXT NOT NULL,
     spent_usd      REAL NOT NULL DEFAULT 0,
     priority       INTEGER NOT NULL DEFAULT 0,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state);
   CREATE INDEX IF NOT EXISTS idx_goals_item ON goals(source_item_id);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_key ON goals(key) WHERE key IS NOT NULL;
   CREATE TABLE IF NOT EXISTS goal_events (
     goal_id    TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     at         INTEGER NOT NULL,
     actor      TEXT NOT NULL,
     session_id TEXT,
     kind       TEXT NOT NULL,
     from_state TEXT,
     to_state   TEXT,
     detail     TEXT,
     handled_at INTEGER,
     PRIMARY KEY (goal_id, seq)
   );
   CREATE INDEX IF NOT EXISTS idx_goal_events_unhandled ON goal_events(handled_at) WHERE handled_at IS NULL;
   CREATE TABLE IF NOT EXISTS goal_steps (
     goal_id    TEXT NOT NULL,
     step_id    TEXT NOT NULL,
     status     TEXT NOT NULL,
     attempts   INTEGER NOT NULL DEFAULT 0,
     session_id TEXT,
     started_at INTEGER,
     ended_at   INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (goal_id, step_id)
   );
   CREATE TABLE IF NOT EXISTS goal_gates (
     id                   TEXT PRIMARY KEY,
     goal_id              TEXT NOT NULL,
     step_id              TEXT NOT NULL,
     evaluator            TEXT NOT NULL,
     condition            TEXT NOT NULL,
     connectors           TEXT NOT NULL,
     status               TEXT NOT NULL,
     refs                 TEXT NOT NULL,
     armed_at             INTEGER NOT NULL,
     next_check_at        INTEGER,
     checks               INTEGER NOT NULL DEFAULT 0,
     check_every_ms       INTEGER,
     deadline_at          INTEGER NOT NULL,
     confirmations_needed INTEGER NOT NULL DEFAULT 1,
     confirmations_seen   INTEGER NOT NULL DEFAULT 0,
     last_verdict         TEXT,
     item_id              TEXT,
     settled_at           INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_goal_gates_goal ON goal_gates(goal_id);
   CREATE INDEX IF NOT EXISTS idx_goal_gates_due ON goal_gates(next_check_at) WHERE status = 'open';
   CREATE TABLE IF NOT EXISTS goal_sessions (
     goal_id      TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     role         TEXT NOT NULL,
     step_id      TEXT,
     plan_version INTEGER NOT NULL,
     started_at   INTEGER NOT NULL,
     ended_at     INTEGER,
     commits      TEXT NOT NULL,
     files        TEXT NOT NULL,
     commands     TEXT NOT NULL,
     actions      TEXT NOT NULL,
     outcome      TEXT,
     cost_usd     REAL,
     PRIMARY KEY (goal_id, session_id)
   );`

// Numbered, append-only. A new migration is a new entry — never edit an old one.
const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id             TEXT PRIMARY KEY,
     title          TEXT NOT NULL,
     cwd            TEXT NOT NULL,
     sdk_session_id TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   );
   CREATE TABLE session_events (
     session_id TEXT NOT NULL REFERENCES sessions(id),
     seq        INTEGER NOT NULL,
     kind       TEXT NOT NULL,
     payload    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   );
   CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);`,
  // 2: the inbox snapshot — one row holding the latest ranked result, so the
  // page renders instantly on load and across server restarts.
  `CREATE TABLE inbox_snapshot (
     id        INTEGER PRIMARY KEY CHECK (id = 1),
     synced_at INTEGER NOT NULL,
     payload   TEXT NOT NULL
   );`,
  // 3: settings + source caches, as a small JSON KV.
  `CREATE TABLE config (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // 4: projects — a named local folder, optionally tied to a GitHub repo.
  `CREATE TABLE projects (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     repo       TEXT NOT NULL DEFAULT '',
     path       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // 5: the jobs engine (.docs/jobs.md) — user-defined jobs, the
  // persistent ingested items they (and external scanners) produce, and the
  // user-state overlay that survives every snapshot rebuild.
  `CREATE TABLE jobs (
     id               TEXT PRIMARY KEY,
     source           TEXT NOT NULL,
     title            TEXT NOT NULL,
     scope            TEXT NOT NULL,
     instruction      TEXT NOT NULL,
     cadence          TEXT NOT NULL,
     window_start     TEXT,
     window_day       INTEGER,
     enabled          INTEGER NOT NULL DEFAULT 1,
     creates_items    INTEGER NOT NULL DEFAULT 1,
     cursor           TEXT,
     last_run_at      INTEGER,
     last_run_tokens  INTEGER,
     last_run_matches INTEGER,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   );
   CREATE TABLE ingested_items (
     id         TEXT PRIMARY KEY,
     updated_at INTEGER NOT NULL,
     payload    TEXT NOT NULL
   );
   CREATE TABLE item_state (
     item_id      TEXT PRIMARY KEY,
     status       TEXT NOT NULL,
     status_at    INTEGER NOT NULL,
     snooze_until INTEGER,
     pinned       INTEGER NOT NULL DEFAULT 0
   );`,
  // 6: the model a session runs on. NULL = Claude Code's own default, which
  // is not the same as any named model — an org can move it under us.
  `ALTER TABLE sessions ADD COLUMN model TEXT;
   ALTER TABLE sessions ADD COLUMN effort TEXT;`,
  // 7: how much a session asks before acting. NULL = 'default' (ask every
  // time), which is what every session predating this column was doing.
  `ALTER TABLE sessions ADD COLUMN permission_mode TEXT;`,
  // 8: pinned sessions — they sort above the rest, regardless of activity.
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  // 9: user priority overrides (any item, survives re-sync) + manual items —
  // to-dos the user adds by hand, in their own editable table.
  `ALTER TABLE item_state ADD COLUMN priority INTEGER;
   CREATE TABLE manual_items (
     id         TEXT PRIMARY KEY,
     title      TEXT NOT NULL,
     project_id TEXT,
     note       TEXT,
     url        TEXT,
     priority   INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // 10: the durable inbox (.docs/jobs-v2.md). One row per work item for
  // EVERY source (built-ins, job hits, GitHub, manual), never hard-deleted;
  // lifecycle lives on the row and in an append-only per-item event log. This
  // supersedes ingested_items + item_state + manual_items + the slack.cache
  // config (all left in place, unused — a fresh start, no fold-forward). Job
  // runs become real sessions (kind/job_id on sessions); jobs record each
  // run's status/session/error and a template origin.
  `CREATE TABLE work_items (
     id                TEXT PRIMARY KEY,
     source            TEXT NOT NULL,
     kind              TEXT NOT NULL,
     status            TEXT NOT NULL DEFAULT 'open',
     status_at         INTEGER NOT NULL,
     snooze_until      INTEGER,
     priority          INTEGER,
     pinned            INTEGER NOT NULL DEFAULT 0,
     returned          INTEGER NOT NULL DEFAULT 0,
     source_updated_at INTEGER NOT NULL,
     ingested_at       INTEGER NOT NULL,
     payload           TEXT NOT NULL,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   );
   CREATE INDEX idx_work_items_status ON work_items(status);
   CREATE INDEX idx_work_items_source ON work_items(source);
   CREATE TABLE item_events (
     item_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      INTEGER NOT NULL,
     actor   TEXT NOT NULL,
     event   TEXT NOT NULL,
     detail  TEXT,
     PRIMARY KEY (item_id, seq)
   );
   ALTER TABLE sessions ADD COLUMN kind TEXT;
   ALTER TABLE sessions ADD COLUMN job_id TEXT;
   ALTER TABLE jobs ADD COLUMN last_run_status TEXT;
   ALTER TABLE jobs ADD COLUMN last_run_session_id TEXT;
   ALTER TABLE jobs ADD COLUMN last_run_error TEXT;
   ALTER TABLE jobs ADD COLUMN template_id TEXT;`,
  // 11: per-run outcome on the (job-run) session row, so the Activity view is
  // a true history of runs — each run is a session, and these are its receipt.
  `ALTER TABLE sessions ADD COLUMN run_status TEXT;
   ALTER TABLE sessions ADD COLUMN run_matches INTEGER;
   ALTER TABLE sessions ADD COLUMN run_tokens INTEGER;
   ALTER TABLE sessions ADD COLUMN run_error TEXT;`,
  // 12: cron schedule per job — the precise fire schedule, superseding the
  // coarse hourly/daily/weekly cadence (old rows derive it from cadence).
  `ALTER TABLE jobs ADD COLUMN schedule TEXT;`,
  // 13: fast mode per session — premium speed at premium price, so it is opt-in
  // per session and defaults off, including for every session that predates it.
  `ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;`,
  // 14: artifacts + links (.docs/next-version.md, phase 1). `artifacts` is an
  // index over markdown files (the file is the truth); `links` is the one
  // polymorphic relation table for artifact↔item, artifact↔session and, from
  // phase 2, session↔item. IF NOT EXISTS because ensureDurableSchema also
  // converges these for DBs whose version counter got here another way.
  `CREATE TABLE IF NOT EXISTS artifacts (
     id         TEXT PRIMARY KEY,
     path       TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     author     TEXT NOT NULL,
     refs       TEXT NOT NULL,
     created    INTEGER NOT NULL,
     updated    INTEGER NOT NULL,
     mtime      INTEGER NOT NULL,
     size       INTEGER NOT NULL,
     indexed_at INTEGER NOT NULL,
     warning    TEXT
   );
   CREATE TABLE IF NOT EXISTS links (
     id         TEXT PRIMARY KEY,
     from_kind  TEXT NOT NULL,
     from_id    TEXT NOT NULL,
     to_kind    TEXT NOT NULL,
     to_id      TEXT NOT NULL,
     role       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (from_kind, from_id, to_kind, to_id, role)
   );
   CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_kind, to_id);
   CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);`,
  // 15: brief jobs (.docs/next-version.md, phase 2) — the FIFO queue and the
  // state machine for playbook runs, one row per run, newest = the item's brief.
  `CREATE TABLE IF NOT EXISTS brief_jobs (
     id          TEXT PRIMARY KEY,
     item_id     TEXT NOT NULL,
     status      TEXT NOT NULL,
     playbook    TEXT NOT NULL,
     model       TEXT,
     note        TEXT,
     session_id  TEXT,
     artifact_id TEXT,
     error       TEXT,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_item ON brief_jobs(item_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_status ON brief_jobs(status, created_at);`,
  // 16: jobs name the connectors they may use (their tool allowlist) and an
  // optional project, instead of one Slack place. Old rows were all Slack; a
  // channel scope folds into the instruction so the rule stays readable.
  `ALTER TABLE jobs ADD COLUMN connectors TEXT;
   ALTER TABLE jobs ADD COLUMN project_id TEXT;
   UPDATE jobs SET instruction = 'In ' || scope || ': ' || instruction WHERE connectors IS NULL AND scope LIKE '#%';
   UPDATE jobs SET connectors = '["slack"]' WHERE connectors IS NULL;`,
  // 17: what a job run cost in dollars (the SDK's total_cost_usd on the result
  // message), so the job page can show spend, not just tokens. Backfilled from
  // the event log — the result message is already persisted there.
  `ALTER TABLE sessions ADD COLUMN run_cost_usd REAL;
   UPDATE sessions SET run_cost_usd = (
     SELECT json_extract(e.payload, '$.message.total_cost_usd') FROM session_events e
     WHERE e.session_id = sessions.id AND e.kind = 'sdk' AND json_extract(e.payload, '$.message.type') = 'result'
     ORDER BY e.seq DESC LIMIT 1)
   WHERE kind = 'job-run' AND run_cost_usd IS NULL;`,
  // 18: a job may pin the model its runs use; NULL = Claude Code's default.
  `ALTER TABLE jobs ADD COLUMN model TEXT;`,
  // 19: what a run produces — many items (default) or one rolling digest.
  `ALTER TABLE jobs ADD COLUMN output TEXT;`,
  `CREATE TABLE IF NOT EXISTS session_turns (
     session_id TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     root       TEXT NOT NULL,
     pre_tree   TEXT NOT NULL,
     post_tree  TEXT,
     started_at INTEGER NOT NULL,
     ended_at   INTEGER,
     touched    TEXT NOT NULL DEFAULT '[]',
     PRIMARY KEY (session_id, seq)
   );
   CREATE INDEX IF NOT EXISTS session_turns_root ON session_turns(root);`,
  // 21: job-spec.md — tool grants, required project, scheduler hardening (start-time clock, catch-up, limits, streaks),
  // and run receipts that say why a run happened and how many finds were new.
  `ALTER TABLE jobs ADD COLUMN tools TEXT;
   ALTER TABLE jobs ADD COLUMN config_error TEXT;
   ALTER TABLE jobs ADD COLUMN catch_up_window TEXT;
   ALTER TABLE jobs ADD COLUMN timeout_ms INTEGER;
   ALTER TABLE jobs ADD COLUMN max_budget_usd REAL;
   ALTER TABLE jobs ADD COLUMN notify TEXT;
   ALTER TABLE jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jobs ADD COLUMN last_run_started_at INTEGER;
   ALTER TABLE jobs ADD COLUMN last_run_new INTEGER;
   ALTER TABLE jobs ADD COLUMN last_run_trigger TEXT;
   UPDATE jobs SET last_run_started_at = last_run_at WHERE last_run_started_at IS NULL;
   ALTER TABLE sessions ADD COLUMN run_trigger TEXT;
   ALTER TABLE sessions ADD COLUMN run_new INTEGER;`,
  // 22: the slot ledger — one row per (job, slot), however it ended. Additive; existing runs are not backfilled.
  `CREATE TABLE IF NOT EXISTS job_runs (
     id         TEXT PRIMARY KEY,
     job_id   TEXT NOT NULL,
     slot       INTEGER NOT NULL,
     trigger    TEXT NOT NULL,
     status     TEXT NOT NULL,
     reason     TEXT,
     session_id TEXT,
     started_at INTEGER NOT NULL,
     ended_at   INTEGER,
     cost_usd   REAL,
     UNIQUE (job_id, slot)
   );`,
  // 23: a per-job daily spend cap, summed from the ledger.
  `ALTER TABLE jobs ADD COLUMN daily_budget_usd REAL;`,
  // 24: jobs as files — the row is state, keyed by the file's id; this names the file.
  `ALTER TABLE jobs ADD COLUMN file TEXT;`,
  // 25: due dates (core/work/due.ts). due_source is 'explicit' (the source
  // stated it) or 'you' (set in the inbox; survives rescans); NULL = the
  // label's default, resolved at read time. 'you' with no due_at = Later.
  `ALTER TABLE work_items ADD COLUMN due_at INTEGER;
   ALTER TABLE work_items ADD COLUMN due_source TEXT;`,
  // 26: workspace → default project → checkout (decision 549a251e). Exactly one
  // project is the default (the partial unique index holds it to one), and a
  // session records its project instead of having it derived from `cwd` —
  // worktree folders break path matching. Backfilled at boot, not here: it
  // needs the default, which needs the session counts.
  `ALTER TABLE projects ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_default ON projects(is_default) WHERE is_default = 1;
   ALTER TABLE sessions ADD COLUMN project_id TEXT;`,
  // 27: the agent a session runs on, fixed for its life. Every session before
  // this ran on Claude, so the default backfills them.
  `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';`,
  // 28: checkouts — a project's folders, its main one and its git worktrees
  // (worktrees phase 1). Sessions record theirs in `sessions.checkout_id`,
  // which ensureDurableSchema adds: SQLite has no ADD COLUMN IF NOT EXISTS,
  // and this step must survive a version counter that got here another way.
  // A session's checkout is backfilled at boot (its project's main one), not
  // here: main rows are created from the projects, in app code.
  `CREATE TABLE IF NOT EXISTS checkouts (
     id         TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     kind       TEXT NOT NULL,
     path       TEXT NOT NULL,
     branch     TEXT,
     base       TEXT,
     item_id    TEXT,
     state      TEXT NOT NULL DEFAULT 'active',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_checkouts_project ON checkouts(project_id);`,
  // 29: outbound actions (core/actions) — every effect a session had that left
  // this machine, one row each; `action_calls` maps each tool_use folded into
  // a row back to it (a collapsed git push holds several). Also converged by
  // ensureDurableSchema, as 28 is.
  `CREATE TABLE IF NOT EXISTS actions (
     id             TEXT PRIMARY KEY,
     session_id     TEXT NOT NULL,
     session_kind   TEXT NOT NULL,
     tool           TEXT NOT NULL,
     kind           TEXT NOT NULL,
     summary        TEXT NOT NULL,
     args           TEXT NOT NULL,
     status         TEXT NOT NULL,
     link           TEXT,
     error          TEXT,
     why            TEXT NOT NULL,
     why_detail     TEXT,
     allowed_by     TEXT,
     allowed_detail TEXT,
     job_id       TEXT,
     team_run_id    TEXT,
     item_id        TEXT,
     group_key      TEXT,
     count          INTEGER NOT NULL DEFAULT 1,
     attempted_at   INTEGER NOT NULL,
     settled_at     INTEGER,
     updated_at     INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_actions_attempted ON actions(attempted_at DESC);
   CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);
   CREATE INDEX IF NOT EXISTS idx_actions_item ON actions(item_id);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_group ON actions(group_key) WHERE group_key IS NOT NULL;
   CREATE TABLE IF NOT EXISTS action_calls (
     session_id  TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     action_id   TEXT NOT NULL,
     PRIMARY KEY (session_id, tool_use_id)
   );
   CREATE INDEX IF NOT EXISTS idx_action_calls_action ON action_calls(action_id);`,
  // 30: queued actions (core/actions/queue.ts) — every step of a held call's
  // life, append-only. The queue's own columns on `actions` (full args,
  // expiry, send time, notes…) are added by ensureDurableSchema, which only
  // adds a column that is missing: an ALTER here would break a DB that
  // converged them first.
  `CREATE TABLE IF NOT EXISTS action_history (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     action_id  TEXT NOT NULL,
     at         INTEGER NOT NULL,
     actor      TEXT NOT NULL,
     event      TEXT NOT NULL,
     from_status TEXT,
     to_status  TEXT NOT NULL,
     note       TEXT,
     args       TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_action_history_action ON action_history(action_id, id);`,
  // 31: goals (core/goals) — the goal record, its event log (transitions and
  // the bus, replayed when unhandled), plan steps at run time, armed gates,
  // and one row per session. Also converged by ensureDurableSchema.
  GOALS_SCHEMA,
  // 32: today's plan (core/junior/today.ts) — one row per item per local day,
  // and each day's own record. Also converged by ensureDurableSchema.
  TODAY_SCHEMA,
]

export function openSqliteStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  renameLegacyTables(db)
  migrate(db)
  ensureDurableSchema(db)
  renameLegacyValues(db)

  return {
    sessions: new SqliteSessions(db),
    events: new SqliteEvents(db),
    turns: new SqliteTurns(db),
    inbox: new SqliteInbox(db),
    config: new SqliteConfig(db),
    projects: new SqliteProjects(db),
    checkouts: new SqliteCheckouts(db),
    jobs: new SqliteJobs(db),
    jobRuns: new SqliteJobRuns(db),
    items: new SqliteWorkItems(db),
    artifacts: new SqliteArtifacts(db),
    links: new SqliteLinks(db),
    briefs: new SqliteBriefJobs(db),
    actions: new SqliteActions(db),
    goals: new SqliteGoals(db),
    today: new SqliteToday(db),
    close: async () => db.close(),
  }
}

/**
 * Converge the durable-inbox schema regardless of migration-version state.
 *
 * Numbered migrations are positional, and this repo's DBs can arrive from
 * branches that already claimed the same version numbers for different tables
 * (e.g. an activity-log branch whose migration 10 created `scan_runs`). When
 * that happens the numbered runner skips *our* migration 10 as "already
 * applied" and `work_items` is never created. This runs after `migrate` and
 * makes the v2 schema present no matter how the version counter got there:
 * tables via IF NOT EXISTS, columns added only when missing. Idempotent, so on
 * a normally-migrated DB it is a no-op.
 */
function ensureDurableSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_items (
     id                TEXT PRIMARY KEY,
     source            TEXT NOT NULL,
     kind              TEXT NOT NULL,
     status            TEXT NOT NULL DEFAULT 'open',
     status_at         INTEGER NOT NULL,
     snooze_until      INTEGER,
     priority          INTEGER,
     pinned            INTEGER NOT NULL DEFAULT 0,
     returned          INTEGER NOT NULL DEFAULT 0,
     source_updated_at INTEGER NOT NULL,
     ingested_at       INTEGER NOT NULL,
     payload           TEXT NOT NULL,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
   CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source);
   CREATE TABLE IF NOT EXISTS item_events (
     item_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      INTEGER NOT NULL,
     actor   TEXT NOT NULL,
     event   TEXT NOT NULL,
     detail  TEXT,
     PRIMARY KEY (item_id, seq)
   );`)

  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
     id         TEXT PRIMARY KEY,
     path       TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     author     TEXT NOT NULL,
     refs       TEXT NOT NULL,
     created    INTEGER NOT NULL,
     updated    INTEGER NOT NULL,
     mtime      INTEGER NOT NULL,
     size       INTEGER NOT NULL,
     indexed_at INTEGER NOT NULL,
     warning    TEXT
   );
   CREATE TABLE IF NOT EXISTS links (
     id         TEXT PRIMARY KEY,
     from_kind  TEXT NOT NULL,
     from_id    TEXT NOT NULL,
     to_kind    TEXT NOT NULL,
     to_id      TEXT NOT NULL,
     role       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (from_kind, from_id, to_kind, to_id, role)
   );
   CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_kind, to_id);
   CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);
   CREATE TABLE IF NOT EXISTS brief_jobs (
     id          TEXT PRIMARY KEY,
     item_id     TEXT NOT NULL,
     status      TEXT NOT NULL,
     playbook    TEXT NOT NULL,
     model       TEXT,
     note        TEXT,
     session_id  TEXT,
     artifact_id TEXT,
     error       TEXT,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_item ON brief_jobs(item_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_brief_jobs_status ON brief_jobs(status, created_at);`)

  const cols = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
  const ensure = (table: string, col: string, decl: string, have: Set<string>) => {
    if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
  }

  const s = cols('sessions')
  ensure('sessions', 'kind', 'kind TEXT', s)
  ensure('sessions', 'job_id', 'job_id TEXT', s)
  ensure('sessions', 'run_status', 'run_status TEXT', s)
  ensure('sessions', 'run_matches', 'run_matches INTEGER', s)
  ensure('sessions', 'run_tokens', 'run_tokens INTEGER', s)
  ensure('sessions', 'run_error', 'run_error TEXT', s)
  ensure('sessions', 'run_cost_usd', 'run_cost_usd REAL', s)
  // Plan mode (Session mode: Normal / Plan / Goal): the session plans before it codes.
  ensure('sessions', 'planning', 'planning INTEGER NOT NULL DEFAULT 0', s)

  const w = cols('jobs')
  ensure('jobs', 'last_run_status', 'last_run_status TEXT', w)
  ensure('jobs', 'last_run_session_id', 'last_run_session_id TEXT', w)
  ensure('jobs', 'last_run_error', 'last_run_error TEXT', w)
  ensure('jobs', 'template_id', 'template_id TEXT', w)
  ensure('jobs', 'schedule', 'schedule TEXT', w)
  ensure('jobs', 'connectors', 'connectors TEXT', w)
  ensure('jobs', 'project_id', 'project_id TEXT', w)
  ensure('jobs', 'model', 'model TEXT', w)
  ensure('jobs', 'output', 'output TEXT', w)
  for (const [col, decl] of [
    ['tools', 'tools TEXT'], ['config_error', 'config_error TEXT'], ['catch_up_window', 'catch_up_window TEXT'],
    ['timeout_ms', 'timeout_ms INTEGER'], ['max_budget_usd', 'max_budget_usd REAL'], ['daily_budget_usd', 'daily_budget_usd REAL'], ['file', 'file TEXT'], ['notify', 'notify TEXT'],
    ['consecutive_failures', 'consecutive_failures INTEGER NOT NULL DEFAULT 0'],
    ['last_run_started_at', 'last_run_started_at INTEGER'], ['last_run_new', 'last_run_new INTEGER'], ['last_run_trigger', 'last_run_trigger TEXT'],
    ['brief', 'brief TEXT'], ['draft', 'draft INTEGER NOT NULL DEFAULT 0'],
    ['skills', 'skills TEXT'], ['agents', 'agents TEXT'],
  ]) ensure('jobs', col, decl, w)
  ensure('sessions', 'run_trigger', 'run_trigger TEXT', s)
  ensure('sessions', 'run_new', 'run_new INTEGER', s)

  ensure('sessions', 'project_id', 'project_id TEXT', s)
  ensure('sessions', 'provider', "provider TEXT NOT NULL DEFAULT 'claude'", s)
  ensure('sessions', 'checkout_id', 'checkout_id TEXT', s)
  db.exec(`CREATE TABLE IF NOT EXISTS checkouts (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
     branch TEXT, base TEXT, item_id TEXT, state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_checkouts_project ON checkouts(project_id);`)
  db.exec(`CREATE TABLE IF NOT EXISTS actions (
     id             TEXT PRIMARY KEY,
     session_id     TEXT NOT NULL,
     session_kind   TEXT NOT NULL,
     tool           TEXT NOT NULL,
     kind           TEXT NOT NULL,
     summary        TEXT NOT NULL,
     args           TEXT NOT NULL,
     status         TEXT NOT NULL,
     link           TEXT,
     error          TEXT,
     why            TEXT NOT NULL,
     why_detail     TEXT,
     allowed_by     TEXT,
     allowed_detail TEXT,
     job_id       TEXT,
     team_run_id    TEXT,
     item_id        TEXT,
     group_key      TEXT,
     count          INTEGER NOT NULL DEFAULT 1,
     attempted_at   INTEGER NOT NULL,
     settled_at     INTEGER,
     updated_at     INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_actions_attempted ON actions(attempted_at DESC);
   CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);
   CREATE INDEX IF NOT EXISTS idx_actions_item ON actions(item_id);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_group ON actions(group_key) WHERE group_key IS NOT NULL;
   CREATE TABLE IF NOT EXISTS action_calls (
     session_id  TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     action_id   TEXT NOT NULL,
     PRIMARY KEY (session_id, tool_use_id)
   );
   CREATE INDEX IF NOT EXISTS idx_action_calls_action ON action_calls(action_id);
   CREATE TABLE IF NOT EXISTS action_history (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     action_id  TEXT NOT NULL,
     at         INTEGER NOT NULL,
     actor      TEXT NOT NULL,
     event      TEXT NOT NULL,
     from_status TEXT,
     to_status  TEXT NOT NULL,
     note       TEXT,
     args       TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_action_history_action ON action_history(action_id, id);`)

  // Queued actions (core/actions/queue.ts): a held call's approval state.
  // NULL queue_args = recorded as it ran, no queue.
  const ac = cols('actions')
  ensure('actions', 'queue_args', 'queue_args TEXT', ac)
  ensure('actions', 'queued_at', 'queued_at INTEGER', ac)
  ensure('actions', 'expires_at', 'expires_at INTEGER', ac)
  ensure('actions', 'send_at', 'send_at INTEGER', ac)
  ensure('actions', 'queue_note', 'queue_note TEXT', ac)
  ensure('actions', 'edits', 'edits INTEGER NOT NULL DEFAULT 0', ac)
  ensure('actions', 'delivery', 'delivery TEXT', ac)
  ensure('actions', 'cost_usd', 'cost_usd REAL', ac)
  db.exec('CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status)')

  const wi = cols('work_items')
  ensure('work_items', 'due_at', 'due_at INTEGER', wi)
  ensure('work_items', 'due_source', 'due_source TEXT', wi)
  // Stage and turn (core/work/flow.ts): the last derived values, kept so a
  // change can be logged, and the user's override as JSON.
  ensure('work_items', 'stage', 'stage TEXT', wi)
  ensure('work_items', 'turn', 'turn TEXT', wi)
  ensure('work_items', 'flow_override', 'flow_override TEXT', wi)

  // The template text the user edited in the brief composer, when it differs from the file.
  ensure('brief_jobs', 'playbook_body', 'playbook_body TEXT', cols('brief_jobs'))

  db.exec(GOALS_SCHEMA)
  db.exec(TODAY_SCHEMA)
}

/*
 * Jobs were called watches before v1.1, and a DB from then says so: its
 * tables, its `watch_id` columns, and the values it stored (session and item
 * kinds, digest item ids, config keys). Both steps rename in place and find
 * nothing to do once they have, so they run on every open. The tables go
 * before `migrate`, whose later steps name the new ones; the values after
 * `ensureDurableSchema`, which may be what created the tables they touch.
 */
function renameLegacyTables(db: DatabaseSync) {
  const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name))
  if (tables.has('watches') && !tables.has('jobs')) db.exec('ALTER TABLE watches RENAME TO jobs')
  if (tables.has('watch_runs') && !tables.has('job_runs')) db.exec('ALTER TABLE watch_runs RENAME TO job_runs')
  for (const table of ['sessions', 'job_runs', 'actions']) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
    if (cols.has('watch_id') && !cols.has('job_id')) db.exec(`ALTER TABLE ${table} RENAME COLUMN watch_id TO job_id`)
  }
}

function renameLegacyValues(db: DatabaseSync) {
  const id = (col: string) => `${col} = 'job:' || substr(${col}, 7) WHERE ${col} GLOB 'watch:*'`
  const steps = [
    `UPDATE sessions SET kind = 'job-run' WHERE kind = 'watch-run'`,
    `UPDATE actions SET session_kind = 'job-run' WHERE session_kind = 'watch-run'`,
    `UPDATE OR IGNORE config SET key = 'jobs.' || substr(key, 9) WHERE key GLOB 'watches.*'`,
    `UPDATE work_items SET kind = 'job-hit' WHERE kind = 'watch-hit'`,
    `UPDATE work_items SET source = 'job' WHERE source = 'watch'`,
    `UPDATE work_items SET payload = replace(replace(replace(replace(payload,
       '"watchId":', '"jobId":'), '"kind":"watch-hit"', '"kind":"job-hit"'), '"source":"watch"', '"source":"job"'), '"id":"watch:', '"id":"job:')
     WHERE payload GLOB '*"watchId":*' OR payload GLOB '*"kind":"watch-hit"*' OR payload GLOB '*"source":"watch"*' OR payload GLOB '*"id":"watch:*'`,
    `UPDATE OR IGNORE work_items SET ${id('id')}`,
    `UPDATE item_events SET ${id('item_id')}`,
    `UPDATE item_events SET ${id('actor')}`,
    `UPDATE OR IGNORE links SET ${id('from_id')} AND from_kind = 'item'`,
    `UPDATE OR IGNORE links SET ${id('to_id')} AND to_kind = 'item'`,
    `UPDATE brief_jobs SET ${id('item_id')}`,
    `UPDATE brief_jobs SET playbook = 'job-hit' WHERE playbook = 'watch-hit'`,
    `UPDATE checkouts SET ${id('item_id')}`,
    `UPDATE actions SET ${id('item_id')}`,
  ]
  db.exec('BEGIN')
  try {
    let changed = 0
    for (const sql of steps) changed += Number(db.prepare(sql).run().changes)
    // the saved inbox was ranked from the old values; the next sync rebuilds it
    if (changed) db.exec('DELETE FROM inbox_snapshot')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

type SessionRow = {
  id: string
  title: string
  cwd: string
  project_id: string | null
  checkout_id: string | null
  sdk_session_id: string | null
  model: string | null
  effort: string | null
  fast_mode: number
  planning?: number
  permission_mode: string | null
  provider: string | null
  pinned: number
  kind: string | null
  job_id: string | null
  run_status: string | null
  run_trigger: string | null
  run_matches: number | null
  run_new: number | null
  run_tokens: number | null
  run_cost_usd: number | null
  run_error: string | null
  created_at: number
  updated_at: number
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/** Storage is text; anything the app no longer recognizes reads back as null. */
const toEffort = (v: string | null): EffortLevel | null =>
  EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : null

/**
 * Same rule, and it matters more here: a mode we stop recognizing must fall
 * back to asking, never to a permissive mode inferred from a stale string.
 */
const toPermissionMode = (v: string | null): PermissionMode | null =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : null

/** An agent this build doesn't know reads back as Claude, the one every row started on. */
const toProvider = (v: string | null): ProviderId => (isProviderId(v) ? v : 'claude')

const toSession = (r: SessionRow): StoredSession => ({
  id: r.id,
  title: r.title,
  cwd: r.cwd,
  projectId: r.project_id,
  checkoutId: r.checkout_id ?? null,
  sdkSessionId: r.sdk_session_id,
  model: r.model,
  effort: toEffort(r.effort),
  fastMode: r.fast_mode === 1,
  planning: r.planning === 1,
  permissionMode: toPermissionMode(r.permission_mode),
  provider: toProvider(r.provider),
  pinned: r.pinned === 1,
  kind: r.kind === 'job-run' || r.kind === 'brief' || r.kind === 'goal' ? r.kind : 'chat',
  jobId: r.job_id,
  runStatus: toRunStatus(r.run_status),
  runTrigger: toTrigger(r.run_trigger),
  runMatches: r.run_matches ?? undefined,
  runNew: r.run_new ?? undefined,
  runTokens: r.run_tokens ?? undefined,
  runCostUsd: r.run_cost_usd ?? undefined,
  runError: r.run_error ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteSessions implements SessionStore {
  constructor(private db: DatabaseSync) {}

  async create(s: NewSession): Promise<StoredSession> {
    const now = Date.now()
    const model = s.model ?? null
    const effort = s.effort ?? null
    const fastMode = s.fastMode ?? false
    const permissionMode = s.permissionMode ?? null
    const provider: ProviderId = s.provider ?? 'claude'
    const kind: SessionKind = s.kind ?? 'chat'
    const jobId = s.jobId ?? null
    const checkoutId = s.checkoutId ?? null
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, project_id, checkout_id, sdk_session_id, model, effort, fast_mode, planning, permission_mode, provider, kind, job_id, run_trigger, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.cwd, s.projectId, checkoutId, model, effort, fastMode ? 1 : 0, s.planning ? 1 : 0, permissionMode, provider, kind, jobId, s.runTrigger ?? null, now, now)
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      projectId: s.projectId,
      checkoutId,
      model,
      effort,
      fastMode,
      planning: s.planning ?? false,
      permissionMode,
      provider,
      kind,
      jobId,
      ...(s.runTrigger ? { runTrigger: s.runTrigger } : {}),
      pinned: false,
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  async get(id: string): Promise<StoredSession | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r ? toSession(r) : null
  }

  async list(): Promise<StoredSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as SessionRow[]
    return rows.map(toSession)
  }

  async backfillProjects(assign: (cwd: string) => string | null): Promise<number> {
    const rows = this.db.prepare('SELECT id, cwd FROM sessions WHERE project_id IS NULL').all() as { id: string; cwd: string }[]
    const set = this.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const projectId = assign(r.cwd)
        if (!projectId) continue
        set.run(projectId, r.id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
  }

  async backfillCheckouts(assign: (projectId: string | null) => string | null): Promise<number> {
    const rows = this.db.prepare('SELECT id, project_id FROM sessions WHERE checkout_id IS NULL').all() as { id: string; project_id: string | null }[]
    const set = this.db.prepare('UPDATE sessions SET checkout_id = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const checkoutId = assign(r.project_id)
        if (!checkoutId) continue
        set.run(checkoutId, r.id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  async setModel(id: string, model: string | null, effort: EffortLevel | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET model = ?, effort = ? WHERE id = ?').run(model, effort, id)
  }

  async setPlanning(id: string, planning: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET planning = ? WHERE id = ?').run(planning ? 1 : 0, id)
  }

  async setFastMode(id: string, fastMode: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET fast_mode = ? WHERE id = ?').run(fastMode ? 1 : 0, id)
  }

  async setPermissionMode(id: string, mode: PermissionMode | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id)
  }

  async rename(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  /**
   * Delete a session and its log. The event rows reference the session, so
   * they go first — with foreign keys on, the other order fails.
   */
  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async touch(id: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  async recordJobRun(id: string, run: JobRunRecord): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET run_status = ?, run_matches = ?, run_new = ?, run_tokens = ?, run_cost_usd = ?, run_error = ?, updated_at = ? WHERE id = ?')
      .run(run.status, run.matches, run.newCount ?? null, run.tokens, run.costUsd ?? null, run.error ?? null, Date.now(), id)
  }
}

type TurnRow = {
  session_id: string
  seq: number
  root: string
  pre_tree: string
  post_tree: string | null
  started_at: number
  ended_at: number | null
  touched: string
}

const turnFrom = (r: TurnRow): StoredTurn => ({
  sessionId: r.session_id,
  seq: r.seq,
  root: r.root,
  preTree: r.pre_tree,
  postTree: r.post_tree,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  touched: parseJsonArray(r.touched),
})

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

class SqliteTurns implements TurnStore {
  constructor(private db: DatabaseSync) {}

  async begin(t: { sessionId: string; seq: number; root: string; preTree: string; startedAt: number }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_turns (session_id, seq, root, pre_tree, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET root = excluded.root, pre_tree = excluded.pre_tree,
           started_at = excluded.started_at, post_tree = NULL, ended_at = NULL`,
      )
      .run(t.sessionId, t.seq, t.root, t.preTree, t.startedAt)
  }

  async end(
    sessionId: string,
    seq: number,
    post: { postTree: string | null; endedAt: number; touched: string[] },
  ): Promise<void> {
    this.db
      .prepare('UPDATE session_turns SET post_tree = ?, ended_at = ?, touched = ? WHERE session_id = ? AND seq = ?')
      .run(post.postTree, post.endedAt, JSON.stringify(post.touched), sessionId, seq)
  }

  async list(sessionId: string): Promise<StoredTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as TurnRow[]
    return rows.map(turnFrom)
  }

  async othersInRoot(root: string, exceptSessionId: string): Promise<StoredTurn[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_turns WHERE root = ? AND session_id != ? ORDER BY started_at')
      .all(root, exceptSessionId) as TurnRow[]
    return rows.map(turnFrom)
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM session_turns WHERE session_id = ?')
      .get(sessionId) as { n: number }
    return r.n
  }

  async removeFor(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId)
  }
}

class SqliteEvents implements EventStore {
  constructor(private db: DatabaseSync) {}

  async append(sessionId: string, seq: number, event: SessionEvent): Promise<void> {
    this.db
      .prepare('INSERT INTO session_events (session_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, seq, event.kind, JSON.stringify(event), Date.now())
  }

  async read(sessionId: string, afterSeq = 0): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, payload, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, afterSeq) as { seq: number; payload: string; created_at: number }[]
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as SessionEvent, createdAt: r.created_at }))
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM session_events WHERE session_id = ?')
      .get(sessionId) as { s: number }
    return r.s
  }
}

class SqliteInbox implements InboxStore {
  constructor(private db: DatabaseSync) {}

  async save(snapshot: InboxSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO inbox_snapshot (id, synced_at, payload) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET synced_at = excluded.synced_at, payload = excluded.payload`,
      )
      .run(snapshot.syncedAt, JSON.stringify({ items: snapshot.items, notices: snapshot.notices }))
  }

  async load(): Promise<InboxSnapshot | null> {
    const r = this.db.prepare('SELECT synced_at, payload FROM inbox_snapshot WHERE id = 1').get() as
      | { synced_at: number; payload: string }
      | undefined
    if (!r) return null
    const body = JSON.parse(r.payload) as Pick<InboxSnapshot, 'items' | 'notices'>
    return { syncedAt: r.synced_at, items: body.items, notices: body.notices }
  }
}

class SqliteConfig implements ConfigStore {
  constructor(private db: DatabaseSync) {}

  async get<T>(key: string): Promise<T | null> {
    const r = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return r ? (JSON.parse(r.value) as T) : null
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value))
  }
}

type JobRow = {
  id: string
  source: string
  title: string
  scope: string
  instruction: string
  cadence: string
  window_start: string | null
  window_day: number | null
  schedule: string | null
  enabled: number
  creates_items: number
  cursor: string | null
  last_run_at: number | null
  last_run_tokens: number | null
  last_run_matches: number | null
  last_run_status: string | null
  last_run_session_id: string | null
  last_run_error: string | null
  template_id: string | null
  connectors: string | null
  project_id: string | null
  model: string | null
  output: string | null
  tools: string | null
  config_error: string | null
  catch_up_window: string | null
  timeout_ms: number | null
  max_budget_usd: number | null
  daily_budget_usd: number | null
  file: string | null
  notify: string | null
  consecutive_failures: number | null
  last_run_started_at: number | null
  last_run_new: number | null
  last_run_trigger: string | null
  brief?: string | null
  draft?: number | null
  skills?: string | null
  agents?: string | null
  created_at: number
  updated_at: number
}

const CONNECTORS = new Set<JobConnector>(['slack', 'linear', 'github', 'web'])
/** Parse the stored connector list; a legacy row (NULL) was a Slack job. */
function toConnectors(raw: string | null): JobConnector[] {
  if (!raw) return ['slack']
  try {
    const arr = JSON.parse(raw) as unknown
    const out = Array.isArray(arr) ? arr.filter((c): c is JobConnector => CONNECTORS.has(c as JobConnector)) : []
    return out.length ? out : ['slack']
  } catch {
    return ['slack']
  }
}

const toRunStatus = (v: string | null): JobRunStatus | undefined =>
  JOB_RUN_STATUSES.includes(v as JobRunStatus) ? (v as JobRunStatus) : undefined

const TRIGGERS: JobRunTrigger[] = ['scheduled', 'catch_up', 'manual', 'redraft']
const toTrigger = (v: string | null): JobRunTrigger | undefined =>
  TRIGGERS.includes(v as JobRunTrigger) ? (v as JobRunTrigger) : undefined

/** Stored grants; a row from before grants (NULL) migrates from its legacy connectors. */
function toGrants(raw: string | null, legacy: string | null): JobToolGrant[] {
  if (raw) {
    try {
      const parsed = grantsFrom(JSON.parse(raw))
      if ('grants' in parsed) return parsed.grants
    } catch {
      /* fall through to the legacy list */
    }
  }
  return grantsFromLegacy(toConnectors(legacy))
}

/** The stored brief option: JSON, or NULL = off. */
function toJobBrief(raw: string | null | undefined): JobBrief | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
      ...(typeof o.template === 'string' && o.template ? { template: o.template } : {}),
    }
  } catch {
    return null
  }
}

/** A stored name list (skills, agents): JSON strings; anything else reads as none. */
function toNames(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
  } catch {
    return []
  }
}
const fromNames = (names: string[] | null | undefined): string | null => (names?.length ? JSON.stringify(names) : null)

const toJob = (r: JobRow): Job => ({
  id: r.id,
  source: 'slack',
  title: r.title,
  scope: r.scope,
  instruction: r.instruction,
  tools: toGrants(r.tools, r.connectors),
  // Required since job-spec item 2; a legacy NULL is migrated to the scratch
  // project at boot, and reads as '' (no project) until then.
  projectId: r.project_id ?? '',
  ...(r.config_error ? { configError: r.config_error } : {}),
  ...(r.catch_up_window ? { catchUpWindow: r.catch_up_window } : {}),
  ...(r.timeout_ms != null ? { timeoutMs: r.timeout_ms } : {}),
  ...(r.max_budget_usd != null ? { maxBudgetUsd: r.max_budget_usd } : {}),
  ...(r.daily_budget_usd != null ? { dailyBudgetUsd: r.daily_budget_usd } : {}),
  ...(r.file ? { file: r.file } : {}),
  notify: JOB_NOTIFY.includes(r.notify as JobNotify) ? (r.notify as JobNotify) : 'on_failure',
  consecutiveFailures: r.consecutive_failures ?? 0,
  model: r.model ?? undefined,
  output: r.output === 'digest' ? 'digest' : 'items',
  cadence: r.cadence as JobCadence,
  windowStart: r.window_start ?? undefined,
  windowDay: r.window_day ?? undefined,
  // Precise schedule is the source of truth; legacy rows derive it from cadence.
  schedule: r.schedule ?? cronFromCadence(r.cadence as JobCadence, r.window_start ?? undefined, r.window_day ?? undefined),
  enabled: r.enabled === 1,
  createsItems: r.creates_items === 1,
  lastRunStartedAt: r.last_run_started_at ?? undefined,
  lastRunAt: r.last_run_at ?? undefined,
  lastRunNew: r.last_run_new ?? undefined,
  lastRunTrigger: toTrigger(r.last_run_trigger),
  lastRunTokens: r.last_run_tokens ?? undefined,
  lastRunMatches: r.last_run_matches ?? undefined,
  lastRunStatus: toRunStatus(r.last_run_status),
  lastRunSessionId: r.last_run_session_id ?? undefined,
  lastRunError: r.last_run_error ?? undefined,
  templateId: r.template_id ?? undefined,
  ...(toJobBrief(r.brief) ? { brief: toJobBrief(r.brief)! } : {}),
  ...(r.draft ? { draft: true } : {}),
  ...(toNames(r.skills).length ? { skills: toNames(r.skills) } : {}),
  ...(toNames(r.agents).length ? { agents: toNames(r.agents) } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteJobs implements JobStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Job[]> {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at').all() as JobRow[]
    return rows.map(toJob)
  }

  async get(id: string): Promise<Job | null> {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return r ? toJob(r) : null
  }

  async create(w: Job): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO jobs (id, source, title, scope, instruction, cadence, window_start, window_day,
           schedule, enabled, creates_items, cursor, last_run_at, last_run_tokens, last_run_matches, template_id,
           tools, project_id, model, output, catch_up_window, timeout_ms, max_budget_usd, daily_budget_usd, file, notify,
           config_error, last_run_started_at, consecutive_failures, brief, draft, skills, agents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id, w.source, w.title, w.scope, w.instruction, w.cadence,
        w.windowStart ?? null, w.windowDay ?? null,
        w.schedule,
        w.enabled ? 1 : 0, w.createsItems ? 1 : 0,
        w.templateId ?? null,
        JSON.stringify(w.tools), w.projectId || null, w.model ?? null, w.output,
        w.catchUpWindow ?? null, w.timeoutMs ?? null, w.maxBudgetUsd ?? null, w.dailyBudgetUsd ?? null, w.file ?? null, w.notify,
        w.configError ?? null, w.lastRunStartedAt ?? null,
        w.brief ? JSON.stringify(w.brief) : null, w.draft ? 1 : 0,
        fromNames(w.skills), fromNames(w.agents),
        w.createdAt, w.updatedAt,
      )
  }

  async update(id: string, patch: Partial<NewJob> & { enabled?: boolean }): Promise<void> {
    const current = await this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    // null in a patch clears an optional limit back to "use the default"
    const opt = <T,>(v: T | null | undefined): T | null => (v === undefined || v === null ? null : v)
    this.db
      .prepare(
        `UPDATE jobs SET title = ?, scope = ?, instruction = ?, cadence = ?, window_start = ?,
           window_day = ?, schedule = ?, enabled = ?, creates_items = ?, tools = ?, project_id = ?, model = ?, output = ?,
           catch_up_window = ?, timeout_ms = ?, max_budget_usd = ?, daily_budget_usd = ?, file = ?, notify = ?,
           brief = ?, draft = ?, skills = ?, agents = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title, next.scope ?? '', next.instruction, next.cadence,
        next.windowStart ?? null, next.windowDay ?? null,
        next.schedule,
        next.enabled ? 1 : 0, next.createsItems ? 1 : 0,
        JSON.stringify(next.tools), next.projectId || null, next.model ?? null, next.output ?? 'items',
        opt(next.catchUpWindow), opt(next.timeoutMs), opt(next.maxBudgetUsd), opt(next.dailyBudgetUsd), next.file ?? null, next.notify ?? 'on_failure',
        next.brief ? JSON.stringify(next.brief) : null, next.draft ? 1 : 0,
        fromNames(next.skills), fromNames(next.agents),
        Date.now(), id,
      )
  }

  async patchState(id: string, patch: JobStatePatch): Promise<void> {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0) }
    if (patch.configError !== undefined) { sets.push('config_error = ?'); vals.push(patch.configError) }
    if (patch.lastRunStartedAt !== undefined) { sets.push('last_run_started_at = ?'); vals.push(patch.lastRunStartedAt) }
    if (patch.projectId !== undefined) { sets.push('project_id = ?'); vals.push(patch.projectId) }
    if (!sets.length) return
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  async markRunStarted(id: string, start: JobRunStart): Promise<void> {
    this.db
      .prepare(
        `UPDATE jobs SET last_run_started_at = ?, last_run_trigger = COALESCE(?, last_run_trigger),
           last_run_session_id = COALESCE(?, last_run_session_id) WHERE id = ?`,
      )
      .run(start.startedAt, start.trigger ?? null, start.sessionId ?? null, id)
  }

  /**
   * Write back one run attempt. Status/session/error are always recorded so the
   * list can tell "looked, found nothing" from "the scan broke". The failure
   * streak counts failed/timeout runs in a row; an ok run resets it; skips and
   * interruptions leave it alone.
   */
  async recordRun(id: string, run: JobRunResult): Promise<void> {
    const streak =
      run.status === 'ok' ? '0' : run.status === 'failed' || run.status === 'timeout' ? 'consecutive_failures + 1' : 'consecutive_failures'
    this.db
      .prepare(
        `UPDATE jobs SET last_run_at = ?, last_run_tokens = ?, last_run_matches = ?, last_run_new = ?,
           last_run_status = ?, last_run_session_id = COALESCE(?, last_run_session_id), last_run_error = ?,
           last_run_trigger = COALESCE(?, last_run_trigger), consecutive_failures = ${streak} WHERE id = ?`,
      )
      .run(run.lastRunAt, run.lastRunTokens, run.lastRunMatches, run.lastRunNew ?? null,
        run.status, run.sessionId ?? null, run.error ?? null, run.trigger ?? null, id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }
}

type JobRunRow = {
  id: string
  job_id: string
  slot: number
  trigger: string
  status: string
  reason: string | null
  session_id: string | null
  started_at: number
  ended_at: number | null
  cost_usd: number | null
}

class SqliteJobRuns implements JobRunLedger {
  constructor(private db: DatabaseSync) {}

  async insert(run: NewJobSlotRun): Promise<boolean> {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO job_runs (id, job_id, slot, trigger, status, reason, session_id, started_at, ended_at, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id ?? randomUUID(), run.jobId, run.slot, run.trigger, run.status, run.reason ?? null, run.sessionId ?? null,
        run.startedAt, run.endedAt ?? null, run.costUsd ?? null)
    return Number(res.changes) > 0
  }

  async attachSession(jobId: string, slot: number, sessionId: string): Promise<void> {
    this.db.prepare('UPDATE job_runs SET session_id = ? WHERE job_id = ? AND slot = ?').run(sessionId, jobId, slot)
  }

  async finish(jobId: string, slot: number, end: JobSlotFinish): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE job_runs SET status = ?, reason = ?, session_id = COALESCE(?, session_id), ended_at = ?, cost_usd = ?
         WHERE job_id = ? AND slot = ? AND status = 'running'`,
      )
      .run(end.status, end.reason ?? null, end.sessionId ?? null, end.endedAt, end.costUsd ?? null, jobId, slot)
    return Number(res.changes) > 0
  }

  async insertMissed(jobId: string, slots: number[], runId: string, at: number): Promise<number> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO job_runs (id, job_id, slot, trigger, status, reason, started_at, ended_at)
       VALUES (?, ?, ?, 'catch_up', 'missed', ?, ?, ?)`,
    )
    let written = 0
    this.db.exec('BEGIN')
    try {
      for (const slot of slots) written += Number(stmt.run(randomUUID(), jobId, slot, `covered by ${runId}`, at, at).changes)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return written
  }

  async spentSince(jobId: string, since: number): Promise<number> {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM job_runs WHERE job_id = ? AND started_at >= ?')
      .get(jobId, since) as { spent: number }
    return row.spent
  }

  async lastOkAt(): Promise<Map<string, number>> {
    const rows = this.db
      .prepare(`SELECT job_id, MAX(COALESCE(ended_at, started_at)) AS at FROM job_runs WHERE status = 'ok' GROUP BY job_id`)
      .all() as { job_id: string; at: number }[]
    return new Map(rows.map((r) => [r.job_id, r.at]))
  }

  async list(jobId: string, limit = 100): Promise<JobSlotRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY slot DESC LIMIT ?')
      .all(jobId, limit) as JobRunRow[]
    return rows.map(toSlotRun)
  }

  async sweepInterrupted(endedAt: number, reason: string): Promise<number> {
    const res = this.db
      .prepare(`UPDATE job_runs SET status = 'interrupted', reason = ?, ended_at = ? WHERE status = 'running'`)
      .run(reason, endedAt)
    return Number(res.changes)
  }
}

function toSlotRun(r: JobRunRow): JobSlotRun {
  return {
    id: r.id,
    jobId: r.job_id,
    slot: r.slot,
    trigger: r.trigger as JobRunTrigger,
    status: r.status as JobSlotStatus,
    reason: r.reason ?? undefined,
    sessionId: r.session_id ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    costUsd: r.cost_usd ?? undefined,
  }
}

type WorkItemRow = {
  id: string
  source: string
  kind: string
  status: string
  status_at: number
  snooze_until: number | null
  priority: number | null
  pinned: number
  returned: number
  source_updated_at: number
  ingested_at: number
  payload: string
  created_at: number
  updated_at: number
  due_at: number | null
  due_source: string | null
  stage?: string | null
  turn?: string | null
  flow_override?: string | null
}

/** A stored override, dropping anything that no longer reads as one. */
function parseOverride(raw: string | null | undefined): FlowOverride | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.at !== 'number') return null
    const out: FlowOverride = { at: o.at }
    if (isStage(o.stage)) out.stage = o.stage
    if (isTurn(o.turn)) out.turn = o.turn
    if (typeof o.note === 'string' && o.note) out.note = o.note
    return out.stage || out.turn || out.note ? out : null
  } catch {
    return null
  }
}

const VALID_STATUSES: ItemStatus[] = ['open', 'snoozed', 'done', 'archived']
const toStatus = (v: string): ItemStatus =>
  VALID_STATUSES.includes(v as ItemStatus) ? (v as ItemStatus) : 'open'

/**
 * Project a row into the rendered WorkItem. The payload holds the source-shaped
 * fields; the columns are authoritative for lifecycle (status/returned/priority/
 * ingestedAt), so they overwrite whatever the payload happened to carry.
 */
function toWorkItem(r: WorkItemRow): WorkItem {
  const base = JSON.parse(r.payload) as WorkItem
  // `note` is the pre-0.7 name of `description` on manual items; read it as a fallback.
  const description = base.description ?? base.note
  return {
    ...base,
    ...(description ? { description } : {}),
    status: toStatus(r.status),
    returned: r.returned === 1,
    ...(r.priority != null ? { priority: r.priority } : {}),
    ...(r.due_at != null ? { dueAt: r.due_at } : {}),
    ...(r.due_source === 'explicit' || r.due_source === 'you' ? { dueSource: r.due_source } : {}),
    ingestedAt: r.ingested_at,
  }
}

/** Lifecycle fields live in columns, not the payload — strip before storing. */
function payloadOf(item: WorkItem): string {
  const { status, returned, priority, ingestedAt, dueAt, dueSource, ...rest } = item
  void status; void returned; void priority; void ingestedAt; void dueAt; void dueSource
  return JSON.stringify(rest)
}

/** Append `add` to a provenance list, replacing an entry from the same run. */
function mergeProvenance(existing: Provenance[] | undefined, add?: Provenance): Provenance[] {
  const list = existing ? [...existing] : []
  if (!add) return list
  const key = (p: Provenance) => `${p.jobId ?? ''}|${p.runId ?? ''}`
  const i = list.findIndex((p) => key(p) === key(add))
  if (i >= 0) list[i] = add
  else list.push(add)
  return list.slice(-10)
}

/** Who an ingestion transition is attributed to. */
function upsertActor(p: Provenance | undefined): string {
  if (p?.runId) return `job:${p.runId}`
  if (p?.jobId) return `job:${p.jobId}`
  return 'system'
}

const evDetail = (p?: Provenance): Record<string, unknown> =>
  p ? { ...(p.jobId ? { jobId: p.jobId } : {}), ...(p.runId ? { runId: p.runId } : {}), ...(p.why ? { why: p.why } : {}) } : {}

/**
 * The durable inbox: one row per work item, an append-only event log per item.
 * Never hard-deletes; the idempotent upsert and deterministic reopen rules live
 * here (.docs/jobs-v2.md).
 */
class SqliteWorkItems implements WorkItemStore {
  constructor(private db: DatabaseSync) {}

  private row(id: string): WorkItemRow | undefined {
    return this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined
  }

  private appendEvent(
    itemId: string,
    at: number,
    actor: string,
    event: ItemEventKind,
    detail: Record<string, unknown>,
  ): void {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM item_events WHERE item_id = ?')
      .get(itemId) as { s: number }
    this.db
      .prepare('INSERT INTO item_events (item_id, seq, at, actor, event, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, r.s + 1, at, actor, event, Object.keys(detail).length ? JSON.stringify(detail) : null)
  }

  async upsert(item: WorkItem, provenance?: Provenance): Promise<UpsertResult> {
    const incoming = Date.parse(item.updatedAt)
    if (!Number.isFinite(incoming)) return { outcome: 'unchanged', reopened: false }
    const now = Date.now()
    const actor = upsertActor(provenance)
    const existing = this.row(item.id)

    if (!existing) {
      const foundBy = mergeProvenance(item.foundBy, provenance)
      const stored: WorkItem = { ...item, why: provenance?.why ?? item.why, foundBy }
      this.db
        .prepare(
          `INSERT INTO work_items (id, source, kind, status, status_at, snooze_until, priority, pinned,
             returned, source_updated_at, ingested_at, payload, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`,
        )
        .run(item.id, item.source, item.kind, now, item.priority ?? null, incoming, now, payloadOf(stored), now, now)
      this.setExplicitDue(item)
      this.appendEvent(item.id, now, actor, 'created', evDetail(provenance))
      return { outcome: 'inserted', reopened: false }
    }

    const base = JSON.parse(existing.payload) as WorkItem
    const foundBy = mergeProvenance(base.foundBy, provenance)
    const newer = incoming > existing.source_updated_at
    const reopened = newer && shouldReopen(toStatus(existing.status), incoming, existing.status_at)

    if (!newer && !provenance) return { outcome: 'unchanged', reopened: false }

    const stored: WorkItem = newer
      ? {
          ...base,
          kind: item.kind,
          title: item.title,
          url: item.url,
          repo: item.repo,
          author: item.author,
          peopleWaiting: item.peopleWaiting,
          updatedAt: item.updatedAt,
          isDraft: item.isDraft,
          ciFailing: item.ciFailing,
          refs: item.refs ?? base.refs,
          why: provenance?.why ?? item.why ?? base.why,
          ask: item.ask ?? base.ask,
          foundBy,
        }
      : // a re-find re-judges: its why and ask replace the last find's
        { ...base, why: provenance?.why ?? base.why, ask: item.ask ?? base.ask, foundBy }

    if (reopened) {
      this.db
        .prepare(
          `UPDATE work_items SET kind = ?, source_updated_at = ?, payload = ?, status = 'open',
             status_at = ?, returned = 1, updated_at = ? WHERE id = ?`,
        )
        .run(item.kind, incoming, payloadOf(stored), now, now, item.id)
      this.appendEvent(item.id, now, actor, 'reopened', { sourceUpdatedAt: incoming, ...evDetail(provenance) })
    } else if (newer) {
      this.db
        .prepare('UPDATE work_items SET kind = ?, source_updated_at = ?, payload = ?, updated_at = ? WHERE id = ?')
        .run(item.kind, incoming, payloadOf(stored), now, item.id)
      this.appendEvent(item.id, now, actor, 'updated', evDetail(provenance))
    } else {
      // provenance-only re-find: refresh foundBy/why, no new source activity, no event
      this.db
        .prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?')
        .run(payloadOf(stored), now, item.id)
    }
    this.setExplicitDue(item)
    return { outcome: 'updated', reopened }
  }

  /** A deadline the source stated; never over one the user set. */
  private setExplicitDue(item: WorkItem): void {
    if (item.dueAt == null) return
    this.db
      .prepare(
        `UPDATE work_items SET due_at = ?, due_source = 'explicit'
         WHERE id = ? AND (due_source IS NULL OR due_source != 'you')`,
      )
      .run(item.dueAt, item.id)
  }

  async setDue(id: string, due: { at: number | null } | null): Promise<void> {
    this.db
      .prepare('UPDATE work_items SET due_at = ?, due_source = ?, updated_at = ? WHERE id = ?')
      .run(due?.at ?? null, due ? 'you' : null, Date.now(), id)
  }

  async backfillProjects(assign: (item: WorkItem) => string | null): Promise<number> {
    const rows = this.db
      .prepare("SELECT id, payload FROM work_items WHERE json_extract(payload, '$.projectId') IS NULL")
      .all() as { id: string; payload: string }[]
    const set = this.db.prepare('UPDATE work_items SET payload = ? WHERE id = ?')
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const item = JSON.parse(r.payload) as WorkItem
        const projectId = assign(item)
        if (!projectId) continue
        set.run(payloadOf({ ...item, projectId }), r.id)
        n++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return n
  }

  async createManual(item: NewManualItem): Promise<string> {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const wi: WorkItem = {
      id: item.id,
      source: 'manual',
      kind: 'manual',
      title: item.title,
      url: item.url ?? '',
      repo: '',
      author: '',
      peopleWaiting: 0,
      createdAt: iso,
      updatedAt: iso,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.description ? { description: item.description, why: item.description } : {}),
      ...(item.urls?.length ? { urls: item.urls } : {}),
    }
    this.db
      .prepare(
        `INSERT INTO work_items (id, source, kind, status, status_at, snooze_until, priority, pinned,
           returned, source_updated_at, ingested_at, payload, created_at, updated_at)
         VALUES (?, 'manual', 'manual', 'open', ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, now, item.priority || null, now, now, payloadOf(wi), now, now)
    this.appendEvent(item.id, now, 'user', 'created', {})
    return item.id
  }

  async updateManual(id: string, patch: Partial<Omit<NewManualItem, 'id'>>): Promise<void> {
    const r = this.row(id)
    if (!r) return
    const base = JSON.parse(r.payload) as WorkItem
    const next: WorkItem = { ...base }
    if (patch.title !== undefined) next.title = patch.title
    if (patch.url !== undefined) next.url = patch.url
    if (patch.urls !== undefined) next.urls = patch.urls.length > 0 ? patch.urls : undefined
    if (patch.description !== undefined) {
      next.description = patch.description || undefined
      // manual items show the description as their "why" on the card
      next.why = patch.description || undefined
      delete next.note
    }
    if (patch.projectId !== undefined) next.projectId = patch.projectId || undefined
    const priority = patch.priority !== undefined ? patch.priority || null : r.priority
    this.db
      .prepare('UPDATE work_items SET payload = ?, priority = ?, updated_at = ? WHERE id = ?')
      .run(payloadOf(next), priority, Date.now(), id)
  }

  async get(id: string): Promise<WorkItem | null> {
    const r = this.row(id)
    return r ? toWorkItem(r) : null
  }

  async list(status: ItemStatus = 'open'): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM work_items WHERE status = ? ORDER BY source_updated_at DESC')
      .all(status) as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  async listAll(): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM work_items ORDER BY source_updated_at DESC')
      .all() as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  async transition(id: string, change: StatusChange): Promise<void> {
    if (!this.row(id)) return
    const now = Date.now()
    const snooze = change.status === 'snoozed' ? change.snoozeUntil ?? null : null
    this.db
      .prepare(
        'UPDATE work_items SET status = ?, status_at = ?, snooze_until = ?, returned = 0, updated_at = ? WHERE id = ?',
      )
      .run(change.status, now, snooze, now, id)
    this.appendEvent(id, now, change.actor, eventForStatus(change.status), {
      ...(change.snoozeUntil ? { snoozeUntil: change.snoozeUntil } : {}),
      ...(change.detail ?? {}),
    })
  }

  async setPriority(id: string, priority: number | null): Promise<void> {
    this.db.prepare('UPDATE work_items SET priority = ?, updated_at = ? WHERE id = ?').run(priority, Date.now(), id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE work_items SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id)
  }

  async wakeSnoozed(now: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT id FROM work_items WHERE status = ? AND snooze_until IS NOT NULL AND snooze_until <= ?')
      .all('snoozed', now) as { id: string }[]
    const upd = this.db.prepare(
      "UPDATE work_items SET status = 'open', snooze_until = NULL, status_at = ?, updated_at = ? WHERE id = ?",
    )
    for (const { id } of rows) {
      upd.run(now, now, id)
      this.appendEvent(id, now, 'system', 'woken', {})
    }
    return rows.map((r) => r.id)
  }

  async flowState(): Promise<Map<string, StoredFlow>> {
    const rows = this.db.prepare('SELECT id, stage, turn, flow_override FROM work_items').all() as {
      id: string
      stage: string | null
      turn: string | null
      flow_override: string | null
    }[]
    const out = new Map<string, StoredFlow>()
    for (const r of rows) {
      if (r.stage == null && r.turn == null && r.flow_override == null) continue
      out.set(r.id, { stage: r.stage, turn: r.turn, override: parseOverride(r.flow_override) })
    }
    return out
  }

  async recordFlow(id: string, flow: { stage: string; turn: string }, detail: Record<string, unknown> = {}): Promise<void> {
    const r = this.row(id)
    if (!r || (r.stage === flow.stage && r.turn === flow.turn)) return
    this.db.prepare('UPDATE work_items SET stage = ?, turn = ? WHERE id = ?').run(flow.stage, flow.turn, id)
    // The first recording is a baseline, not a move.
    if (r.stage == null && r.turn == null) return
    this.appendEvent(id, Date.now(), 'system', 'moved', {
      from: { stage: r.stage, turn: r.turn },
      to: { stage: flow.stage, turn: flow.turn },
      ...detail,
    })
  }

  async setFlowOverride(id: string, override: FlowOverride | null, actor: string): Promise<void> {
    if (!this.row(id)) throw new Error('no such work item')
    this.db.prepare('UPDATE work_items SET flow_override = ? WHERE id = ?').run(override ? JSON.stringify(override) : null, id)
    this.appendEvent(id, override?.at ?? Date.now(), actor, 'flow-set', override ? { ...override } : { cleared: true })
  }

  async countDoneSince(since: number): Promise<number> {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE status = 'done' AND status_at >= ?").get(since) as { n: number }
    return r.n
  }

  async statusTimes(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const get = this.db.prepare('SELECT status_at FROM work_items WHERE id = ?')
    for (const id of new Set(ids)) {
      const r = get.get(id) as { status_at: number } | undefined
      if (r) out.set(id, r.status_at)
    }
    return out
  }

  async deletedIds(): Promise<Set<string>> {
    const rows = this.db
      .prepare(
        `SELECT w.id FROM work_items w WHERE w.status = 'archived' AND (
           SELECT e.detail FROM item_events e WHERE e.item_id = w.id AND e.event = 'archived' ORDER BY e.seq DESC LIMIT 1
         ) LIKE '%"reason":"deleted by user"%'`,
      )
      .all() as { id: string }[]
    return new Set(rows.map((r) => r.id))
  }

  async events(id: string): Promise<ItemEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, at, actor, event, detail FROM item_events WHERE item_id = ? ORDER BY seq')
      .all(id) as { seq: number; at: number; actor: string; event: string; detail: string | null }[]
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      actor: r.actor,
      event: r.event as ItemEventKind,
      ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
    }))
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const base = JSON.parse(r.payload) as WorkItem
    const next: WorkItem = { ...base }
    delete next.note
    if (description) next.description = description
    else delete next.description
    // A manual item's card quotes its description as the "why"; source items keep the scanner's.
    if (base.source === 'manual') next.why = description || undefined
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setImages(id: string, images: ItemImage[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (images.length > 0) next.images = images
    else delete next.images
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setFiles(id: string, files: FileRef[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (files.length > 0) next.files = files
    else delete next.files
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }

  async setUrls(id: string, urls: string[]): Promise<void> {
    const r = this.row(id)
    if (!r) throw new Error('no such work item')
    const next: WorkItem = { ...(JSON.parse(r.payload) as WorkItem) }
    if (urls.length > 0) next.urls = urls
    else delete next.urls
    this.db.prepare('UPDATE work_items SET payload = ?, updated_at = ? WHERE id = ?').run(payloadOf(next), Date.now(), id)
  }
}

type ProjectRow = { id: string; name: string; repo: string; path: string; is_default?: number }

class SqliteProjects implements ProjectStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Project[]> {
    const rows = this.db
      .prepare('SELECT id, name, repo, path, is_default FROM projects ORDER BY is_default DESC, name COLLATE NOCASE')
      .all() as ProjectRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path, ...(r.is_default ? { isDefault: true } : {}) }))
  }

  async create(p: Project): Promise<void> {
    this.db
      .prepare('INSERT INTO projects (id, name, repo, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, p.name, p.repo, p.path, Date.now())
  }

  async setDefault(id: string): Promise<void> {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE projects SET is_default = 0 WHERE is_default = 1').run()
      const r = this.db.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run(id)
      if (r.changes === 0) throw new Error('unknown project')
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async retireBuiltin(): Promise<Project[]> {
    // A short-lived dev build added a `builtin` column and a scratch project;
    // projects are always real folders now. Remove those rows, if any.
    const cols = new Set((this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((r) => r.name))
    if (!cols.has('builtin')) return []
    const rows = this.db.prepare('SELECT id, name, repo, path FROM projects WHERE builtin = 1').all() as ProjectRow[]
    this.db.prepare('DELETE FROM projects WHERE builtin = 1').run()
    return rows.map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path }))
  }

  async remove(id: string): Promise<void> {
    const r = this.db.prepare('SELECT is_default FROM projects WHERE id = ?').get(id) as { is_default: number } | undefined
    if (r?.is_default) throw new Error('the default project can only be replaced — make another project the default first')
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

type CheckoutRow = {
  id: string
  project_id: string
  kind: string
  path: string
  branch: string | null
  base: string | null
  item_id: string | null
  state: string
  created_at: number
}

const toCheckout = (r: CheckoutRow): Checkout => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind === 'worktree' ? 'worktree' : 'main',
  path: r.path,
  branch: r.branch,
  base: r.base,
  itemId: r.item_id,
  state: r.state === 'removed' ? 'removed' : 'active',
  createdAt: r.created_at,
})

class SqliteCheckouts implements CheckoutStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Checkout[]> {
    const rows = this.db
      .prepare("SELECT * FROM checkouts ORDER BY project_id, kind = 'worktree', branch COLLATE NOCASE, created_at")
      .all() as CheckoutRow[]
    return rows.map(toCheckout)
  }

  async create(c: Checkout): Promise<void> {
    this.db
      .prepare('INSERT INTO checkouts (id, project_id, kind, path, branch, base, item_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.projectId, c.kind, c.path, c.branch, c.base, c.itemId, c.state, c.createdAt)
  }

  async update(id: string, patch: CheckoutPatch): Promise<void> {
    if (patch.branch !== undefined) this.db.prepare('UPDATE checkouts SET branch = ? WHERE id = ?').run(patch.branch, id)
    if (patch.state !== undefined) this.db.prepare('UPDATE checkouts SET state = ? WHERE id = ?').run(patch.state, id)
    if (patch.base !== undefined) this.db.prepare('UPDATE checkouts SET base = ? WHERE id = ?').run(patch.base, id)
    if (patch.itemId !== undefined) this.db.prepare('UPDATE checkouts SET item_id = ? WHERE id = ?').run(patch.itemId, id)
  }

  async removeForProject(projectId: string): Promise<void> {
    this.db.prepare('DELETE FROM checkouts WHERE project_id = ?').run(projectId)
  }
}

// ---------------------------------------------------------------------------
// Artifacts index + links (.docs/next-version.md, phase 1)
// ---------------------------------------------------------------------------

type ArtifactRow = {
  id: string
  path: string
  title: string
  author: string
  refs: string
  created: number
  updated: number
  mtime: number
  size: number
  indexed_at: number
  warning: string | null
}

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id,
  path: r.path,
  title: r.title,
  author: isArtifactAuthor(r.author) ? r.author : 'human',
  refs: (() => {
    try {
      const v: unknown = JSON.parse(r.refs)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })(),
  created: r.created,
  updated: r.updated,
  mtime: r.mtime,
  size: r.size,
  ...(r.warning ? { warning: r.warning } : {}),
})

class SqliteArtifacts implements ArtifactStore {
  constructor(private db: DatabaseSync) {}

  async upsert(a: Artifact): Promise<void> {
    // A different file now lives at this path (replaced, or re-created without
    // its id): the old row is stale and would violate the UNIQUE(path).
    this.db.prepare('DELETE FROM artifacts WHERE path = ? AND id != ?').run(a.path, a.id)
    this.db
      .prepare(
        `INSERT INTO artifacts (id, path, title, author, refs, created, updated, mtime, size, indexed_at, warning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, title = excluded.title, author = excluded.author, refs = excluded.refs,
           created = excluded.created, updated = excluded.updated, mtime = excluded.mtime,
           size = excluded.size, indexed_at = excluded.indexed_at, warning = excluded.warning`,
      )
      .run(a.id, a.path, a.title, a.author, JSON.stringify(a.refs), a.created, a.updated, a.mtime, a.size, Date.now(), a.warning ?? null)
  }

  async get(id: string): Promise<Artifact | null> {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    return r ? toArtifact(r) : null
  }

  async getByPath(p: string): Promise<Artifact | null> {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE path = ?').get(p) as ArtifactRow | undefined
    return r ? toArtifact(r) : null
  }

  async list(): Promise<Artifact[]> {
    const rows = this.db.prepare('SELECT * FROM artifacts ORDER BY updated DESC, title COLLATE NOCASE').all() as ArtifactRow[]
    return rows.map(toArtifact)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id)
  }
}

type LinkRow = {
  id: string
  from_kind: string
  from_id: string
  to_kind: string
  to_id: string
  role: string
  created_at: number
}

const toLink = (r: LinkRow): Link => ({
  id: r.id,
  fromKind: isLinkKind(r.from_kind) ? r.from_kind : 'artifact',
  fromId: r.from_id,
  toKind: isLinkKind(r.to_kind) ? r.to_kind : 'item',
  toId: r.to_id,
  role: isLinkRole(r.role) ? r.role : 'context',
  createdAt: r.created_at,
})

class SqliteLinks implements LinkStore {
  constructor(private db: DatabaseSync) {}

  async add(l: NewLink): Promise<Link> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (id, from_kind, from_id, to_kind, to_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), l.fromKind, l.fromId, l.toKind, l.toId, l.role, Date.now())
    const r = this.db
      .prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ? AND role = ?')
      .get(l.fromKind, l.fromId, l.toKind, l.toId, l.role) as LinkRow
    return toLink(r)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id)
  }

  async removeFor(kind: LinkKind, id: string): Promise<void> {
    this.db
      .prepare('DELETE FROM links WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?)')
      .run(kind, id, kind, id)
  }

  async forTarget(kind: LinkKind, id: string): Promise<Link[]> {
    const rows = this.db.prepare('SELECT * FROM links WHERE to_kind = ? AND to_id = ? ORDER BY created_at').all(kind, id) as LinkRow[]
    return rows.map(toLink)
  }

  async forSource(kind: LinkKind, id: string): Promise<Link[]> {
    const rows = this.db.prepare('SELECT * FROM links WHERE from_kind = ? AND from_id = ? ORDER BY created_at').all(kind, id) as LinkRow[]
    return rows.map(toLink)
  }

  async list(): Promise<Link[]> {
    return (this.db.prepare('SELECT * FROM links ORDER BY created_at').all() as LinkRow[]).map(toLink)
  }
}

// ---------------------------------------------------------------------------
// Brief jobs (.docs/next-version.md, phase 2)
// ---------------------------------------------------------------------------

type BriefJobRow = {
  id: string
  item_id: string
  status: string
  playbook: string
  playbook_body: string | null
  model: string | null
  note: string | null
  session_id: string | null
  artifact_id: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

const BRIEF_STATUS_SET = new Set<string>(['queued', 'running', 'ready', 'failed'])

const toBriefJob = (r: BriefJobRow): BriefJob => ({
  id: r.id,
  itemId: r.item_id,
  status: BRIEF_STATUS_SET.has(r.status) ? (r.status as BriefStatus) : 'failed',
  playbook: r.playbook,
  playbookBody: r.playbook_body ?? null,
  model: r.model,
  note: r.note,
  sessionId: r.session_id,
  artifactId: r.artifact_id,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

class SqliteBriefJobs implements BriefJobStore {
  constructor(private db: DatabaseSync) {}

  private row(id: string): BriefJobRow | undefined {
    return this.db.prepare('SELECT * FROM brief_jobs WHERE id = ?').get(id) as BriefJobRow | undefined
  }

  async create(j: NewBriefJob): Promise<BriefJob> {
    this.db
      .prepare(
        `INSERT INTO brief_jobs (id, item_id, status, playbook, playbook_body, model, note, session_id, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        j.id, j.itemId, j.running ? 'running' : 'queued', j.playbook, j.playbookBody ?? null, j.model ?? null, j.note ?? null,
        j.running?.sessionId ?? null, j.running?.startedAt ?? null, Date.now(),
      )
    return toBriefJob(this.row(j.id)!)
  }

  async get(id: string): Promise<BriefJob | null> {
    const r = this.row(id)
    return r ? toBriefJob(r) : null
  }

  async latestForItem(itemId: string): Promise<BriefJob | null> {
    const r = this.db
      .prepare('SELECT * FROM brief_jobs WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(itemId) as BriefJobRow | undefined
    return r ? toBriefJob(r) : null
  }

  async forSession(sessionId: string): Promise<BriefJob | null> {
    const r = this.db
      .prepare('SELECT * FROM brief_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as BriefJobRow | undefined
    return r ? toBriefJob(r) : null
  }

  async latestPerItem(): Promise<BriefJob[]> {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM brief_jobs b
         JOIN (SELECT item_id, MAX(created_at) AS c FROM brief_jobs GROUP BY item_id) m
           ON m.item_id = b.item_id AND m.c = b.created_at
         ORDER BY b.created_at DESC`,
      )
      .all() as BriefJobRow[]
    return rows.map(toBriefJob)
  }

  async list(status?: BriefStatus): Promise<BriefJob[]> {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM brief_jobs WHERE status = ? ORDER BY created_at').all(status)
        : this.db.prepare('SELECT * FROM brief_jobs ORDER BY created_at').all()
    ) as BriefJobRow[]
    return rows.map(toBriefJob)
  }

  async countStartedSince(sinceMs: number): Promise<number> {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM brief_jobs WHERE started_at IS NOT NULL AND started_at >= ?')
      .get(sinceMs) as { n: number }
    return r.n
  }

  async update(id: string, patch: Partial<Omit<BriefJob, 'id' | 'itemId' | 'playbook' | 'playbookBody'>>): Promise<void> {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    const col: Record<string, string> = {
      status: 'status',
      model: 'model',
      note: 'note',
      sessionId: 'session_id',
      artifactId: 'artifact_id',
      error: 'error',
      createdAt: 'created_at',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in col) || v === undefined) continue
      sets.push(`${col[k]} = ?`)
      vals.push(v as string | number | null)
    }
    if (!sets.length) return
    vals.push(id)
    this.db.prepare(`UPDATE brief_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  async failAllRunning(error: string): Promise<string[]> {
    const rows = this.db.prepare("SELECT id FROM brief_jobs WHERE status = 'running'").all() as { id: string }[]
    const now = Date.now()
    const upd = this.db.prepare("UPDATE brief_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
    for (const { id } of rows) upd.run(error, now, id)
    return rows.map((r) => r.id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM brief_jobs WHERE id = ?').run(id)
  }
}

// ---------------------------------------------------------------------------
// Outbound actions (core/actions)
// ---------------------------------------------------------------------------

type ActionRow = {
  id: string
  session_id: string
  session_kind: string
  tool: string
  kind: string
  summary: string
  args: string
  status: string
  link: string | null
  error: string | null
  why: string
  why_detail: string | null
  allowed_by: string | null
  allowed_detail: string | null
  job_id: string | null
  team_run_id: string | null
  item_id: string | null
  group_key: string | null
  count: number
  attempted_at: number
  settled_at: number | null
  updated_at: number
  queue_args: string | null
  queued_at: number | null
  expires_at: number | null
  send_at: number | null
  queue_note: string | null
  edits: number | null
  delivery: string | null
  cost_usd: number | null
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Storage is text; a value this build doesn't know reads back as the safest neighbour. */
function toAction(r: ActionRow, calls: string[]): ActionRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    sessionKind: r.session_kind,
    tool: r.tool,
    kind: isActionKind(r.kind) ? r.kind : 'other',
    summary: r.summary,
    args: parseArgs(r.args),
    status: isActionStatus(r.status) ? r.status : 'attempted',
    link: r.link,
    error: r.error,
    why: isActionWhy(r.why) ? r.why : 'unknown',
    whyDetail: r.why_detail,
    allowedBy: isActionAllowedBy(r.allowed_by) ? r.allowed_by : null,
    allowedDetail: r.allowed_detail,
    jobId: r.job_id,
    teamRunId: r.team_run_id,
    itemId: r.item_id,
    groupKey: r.group_key,
    count: r.count,
    calls,
    attemptedAt: r.attempted_at,
    settledAt: r.settled_at,
    updatedAt: r.updated_at,
    queue:
      r.queue_args !== null && r.queue_args !== undefined
        ? {
            args: parseArgs(r.queue_args),
            queuedAt: r.queued_at ?? r.attempted_at,
            expiresAt: r.expires_at ?? r.attempted_at,
            sendAt: r.send_at,
            note: r.queue_note,
            edits: r.edits ?? 0,
            delivery: r.delivery,
            costUsd: r.cost_usd,
          }
        : null,
  }
}

type ActionHistoryRow = {
  action_id: string
  at: number
  actor: string
  event: string
  from_status: string | null
  to_status: string
  note: string | null
  args: string | null
}

const isActor = (v: string): v is ActionActor => v === 'agent' || v === 'you' || v === 'triage'

class SqliteActions implements ActionStore {
  constructor(private db: DatabaseSync) {}

  /** Rows → records, each with its calls in the order they were folded in — one calls query per 500 rows. */
  private hydrate(rows: ActionRow[]): ActionRecord[] {
    if (!rows.length) return []
    const calls = new Map<string, string[]>()
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.id)
      const found = this.db
        .prepare(`SELECT action_id, tool_use_id FROM action_calls WHERE action_id IN (${ids.map(() => '?').join(', ')}) ORDER BY rowid`)
        .all(...ids) as { action_id: string; tool_use_id: string }[]
      for (const c of found) {
        const list = calls.get(c.action_id)
        if (list) list.push(c.tool_use_id)
        else calls.set(c.action_id, [c.tool_use_id])
      }
    }
    return rows.map((r) => toAction(r, calls.get(r.id) ?? []))
  }

  private one(sql: string, ...params: string[]): ActionRecord | null {
    const r = this.db.prepare(sql).get(...params) as ActionRow | undefined
    return r ? this.hydrate([r])[0] : null
  }

  async get(id: string): Promise<ActionRecord | null> {
    return this.one('SELECT * FROM actions WHERE id = ?', id)
  }

  async byCall(sessionId: string, toolUseId: string): Promise<ActionRecord | null> {
    return this.one(
      'SELECT a.* FROM action_calls c JOIN actions a ON a.id = c.action_id WHERE c.session_id = ? AND c.tool_use_id = ?',
      sessionId,
      toolUseId,
    )
  }

  async byGroup(groupKey: string): Promise<ActionRecord | null> {
    return this.one('SELECT * FROM actions WHERE group_key = ?', groupKey)
  }

  async put(a: ActionRecord): Promise<void> {
    const q = a.queue ?? null
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT INTO actions (id, session_id, session_kind, tool, kind, summary, args, status, link, error, why, why_detail,
             allowed_by, allowed_detail, job_id, team_run_id, item_id, group_key, count, attempted_at, settled_at, updated_at,
             queue_args, queued_at, expires_at, send_at, queue_note, edits, delivery, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             session_kind = excluded.session_kind, tool = excluded.tool, kind = excluded.kind, summary = excluded.summary,
             args = excluded.args, status = excluded.status, link = excluded.link, error = excluded.error, why = excluded.why,
             why_detail = excluded.why_detail, allowed_by = excluded.allowed_by, allowed_detail = excluded.allowed_detail,
             job_id = excluded.job_id, team_run_id = excluded.team_run_id, item_id = excluded.item_id,
             group_key = excluded.group_key, count = excluded.count, attempted_at = excluded.attempted_at,
             settled_at = excluded.settled_at, updated_at = excluded.updated_at,
             queue_args = excluded.queue_args, queued_at = excluded.queued_at, expires_at = excluded.expires_at,
             send_at = excluded.send_at, queue_note = excluded.queue_note, edits = excluded.edits,
             delivery = excluded.delivery, cost_usd = excluded.cost_usd`,
        )
        .run(
          a.id, a.sessionId, a.sessionKind, a.tool, a.kind, a.summary, JSON.stringify(a.args), a.status, a.link, a.error, a.why,
          a.whyDetail, a.allowedBy, a.allowedDetail, a.jobId, a.teamRunId, a.itemId, a.groupKey, a.count, a.attemptedAt,
          a.settledAt, a.updatedAt,
          q ? JSON.stringify(q.args) : null, q?.queuedAt ?? null, q?.expiresAt ?? null, q?.sendAt ?? null, q?.note ?? null,
          q?.edits ?? 0, q?.delivery ?? null, q?.costUsd ?? null,
        )
      const call = this.db.prepare(
        `INSERT INTO action_calls (session_id, tool_use_id, action_id) VALUES (?, ?, ?)
         ON CONFLICT (session_id, tool_use_id) DO UPDATE SET action_id = excluded.action_id`,
      )
      for (const c of a.calls) call.run(a.sessionId, c, a.id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM action_calls WHERE action_id = ?').run(id)
    this.db.prepare('DELETE FROM actions WHERE id = ?').run(id)
  }

  async list(q: ActionQuery = {}): Promise<ActionRecord[]> {
    const where: string[] = []
    const params: Array<string | number> = []
    if (q.kind) {
      where.push('kind = ?')
      params.push(q.kind)
    }
    if (q.sessionId) {
      where.push('session_id = ?')
      params.push(q.sessionId)
    }
    if (q.since !== undefined) {
      where.push('attempted_at >= ?')
      params.push(q.since)
    }
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => '?').join(', ')})`)
      params.push(...q.status)
    }
    if (q.itemId !== undefined || q.sessionIds?.length) {
      const any: string[] = []
      if (q.itemId !== undefined) {
        any.push('item_id = ?')
        params.push(q.itemId)
      }
      if (q.sessionIds?.length) {
        any.push(`session_id IN (${q.sessionIds.map(() => '?').join(', ')})`)
        params.push(...q.sessionIds)
      }
      where.push(`(${any.join(' OR ')})`)
    }
    const limit = Math.max(1, Math.min(q.limit ?? 500, 5000))
    const rows = this.db
      .prepare(`SELECT * FROM actions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY attempted_at DESC, id LIMIT ${limit}`)
      .all(...params) as ActionRow[]
    return this.hydrate(rows)
  }

  async claim(id: string, from: ActionStatus, to: ActionStatus, at: number, opts: { dueBy?: number } = {}): Promise<boolean> {
    // One statement: whoever runs it first moves the row; anyone after sees 0 changes.
    const r = this.db
      .prepare(
        `UPDATE actions SET status = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND status = ?${opts.dueBy !== undefined ? ' AND send_at IS NOT NULL AND send_at <= ?' : ''}`,
      )
      .run(...[to, at, id, from, ...(opts.dueBy !== undefined ? [opts.dueBy] : [])])
    return Number(r.changes) === 1
  }

  async addHistory(e: ActionHistoryEntry): Promise<void> {
    this.db
      .prepare('INSERT INTO action_history (action_id, at, actor, event, from_status, to_status, note, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.actionId, e.at, e.actor, e.event, e.from, e.to, e.note, e.args ? JSON.stringify(e.args) : null)
  }

  async history(ids: string[]): Promise<Map<string, ActionHistoryEntry[]>> {
    const out = new Map<string, ActionHistoryEntry[]>()
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500)
      if (!batch.length) continue
      const rows = this.db
        .prepare(`SELECT action_id, at, actor, event, from_status, to_status, note, args FROM action_history WHERE action_id IN (${batch.map(() => '?').join(', ')}) ORDER BY id`)
        .all(...batch) as ActionHistoryRow[]
      for (const r of rows) {
        const e: ActionHistoryEntry = {
          actionId: r.action_id,
          at: r.at,
          actor: isActor(r.actor) ? r.actor : 'triage',
          event: r.event,
          from: r.from_status && isActionStatus(r.from_status) ? r.from_status : null,
          to: isActionStatus(r.to_status) ? r.to_status : 'attempted',
          note: r.note,
          args: r.args ? parseArgs(r.args) : null,
        }
        const list = out.get(r.action_id)
        if (list) list.push(e)
        else out.set(r.action_id, [e])
      }
    }
    return out
  }
}

type TodayRow = {
  date: string
  item_id: string
  owner: string
  added_by: string
  added_at: number
  ord: number
  carried_from: string | null
}

const toAddedBy = (v: string): AddedBy => (v === 'junior' || v === 'draft' ? v : 'you')

function toTodayEntry(r: TodayRow): TodayEntry {
  return {
    date: r.date,
    itemId: r.item_id,
    owner: isOwner(r.owner) ? r.owner : 'you',
    addedBy: toAddedBy(r.added_by),
    addedAt: r.added_at,
    order: r.ord,
    carriedFrom: r.carried_from,
  }
}

class SqliteToday implements TodayStore {
  constructor(private db: DatabaseSync) {}

  async day(date: string): Promise<TodayDay | null> {
    const r = this.db.prepare('SELECT date, created_at, drafted_at FROM today_days WHERE date = ?').get(date) as
      | { date: string; created_at: number; drafted_at: number | null }
      | undefined
    return r ? { date: r.date, createdAt: r.created_at, draftedAt: r.drafted_at } : null
  }

  async openDay(day: TodayDay, rows: readonly TodayEntry[]): Promise<boolean> {
    this.db.exec('BEGIN')
    try {
      const made = this.db
        .prepare('INSERT OR IGNORE INTO today_days (date, created_at, drafted_at) VALUES (?, ?, ?)')
        .run(day.date, day.createdAt, day.draftedAt).changes
      if (made) for (const e of rows) this.insert(e)
      this.db.exec('COMMIT')
      return made > 0
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async setDrafted(date: string, at: number): Promise<void> {
    this.db.prepare('UPDATE today_days SET drafted_at = ? WHERE date = ?').run(at, date)
  }

  async entries(date: string): Promise<TodayEntry[]> {
    const rows = this.db.prepare('SELECT * FROM today_entries WHERE date = ? ORDER BY ord, added_at').all(date) as TodayRow[]
    return rows.map(toTodayEntry)
  }

  async lastBefore(date: string): Promise<{ date: string; entries: TodayEntry[] } | null> {
    const r = this.db.prepare('SELECT MAX(date) AS d FROM today_entries WHERE date < ?').get(date) as { d: string | null }
    if (!r.d) return null
    return { date: r.d, entries: await this.entries(r.d) }
  }

  private insert(e: TodayEntry) {
    this.db
      .prepare(
        `INSERT INTO today_entries (date, item_id, owner, added_by, added_at, ord, carried_from) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date, item_id) DO UPDATE SET owner = excluded.owner`,
      )
      .run(e.date, e.itemId, e.owner, e.addedBy, e.addedAt, e.order, e.carriedFrom)
  }

  async put(e: TodayEntry): Promise<void> {
    this.insert(e)
  }

  async remove(date: string, itemId: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM today_entries WHERE date = ? AND item_id = ?').run(date, itemId).changes > 0
  }

  async everPlanned(): Promise<boolean> {
    const r = this.db
      .prepare('SELECT (EXISTS (SELECT 1 FROM today_entries) OR EXISTS (SELECT 1 FROM today_days WHERE drafted_at IS NOT NULL)) AS yes')
      .get() as { yes: number }
    return r.yes === 1
  }
}
