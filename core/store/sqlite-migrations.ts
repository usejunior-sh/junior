

/**
 * Today's plan (core/junior/today.ts): a record per local day and its rows.
 * IF NOT EXISTS throughout: migration 31 and ensureDurableSchema both run it,
 * so the tables exist however the version counter got here (another branch
 * may claim 31 for its own tables first).
 */
export const TODAY_SCHEMA = `CREATE TABLE IF NOT EXISTS today_days (
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
 * Tasks on items (core/work/tasks.ts). `key` dedupes: one task per item per
 * event ("checks_failed@<sha>"); NULL keys never collide. `input` and
 * `output` are JSON. IF NOT EXISTS throughout: migration 33 and
 * ensureDurableSchema both run it.
 */
export const TASKS_SCHEMA = `CREATE TABLE IF NOT EXISTS item_tasks (
     id          TEXT PRIMARY KEY,
     item_id     TEXT NOT NULL,
     title       TEXT NOT NULL,
     owner       TEXT NOT NULL,
     state       TEXT NOT NULL,
     why         TEXT NOT NULL,
     why_detail  TEXT,
     step        TEXT,
     input       TEXT,
     key         TEXT,
     output      TEXT,
     error       TEXT,
     session_id  TEXT,
     model       TEXT,
     cost_usd    REAL,
     attempts    INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     ended_at    INTEGER,
     UNIQUE (item_id, key)
   );
   CREATE INDEX IF NOT EXISTS idx_item_tasks_item ON item_tasks(item_id, created_at);
   CREATE INDEX IF NOT EXISTS idx_item_tasks_state ON item_tasks(state);`

/**
 * Goals (core/goals/types.ts). `plan` and `budget` are JSON; `plan.md` in the
 * ledger folder is the plan's source and this caches it parsed. `key` is
 * goal_create's caller-stable id, unique when given. Transitions update `state`
 * with `WHERE id = ? AND state = ?` and append a `goal_events` row in one
 * transaction. IF NOT EXISTS throughout: migration 31 and ensureDurableSchema
 * both run it.
 */
export const GOALS_SCHEMA = `CREATE TABLE IF NOT EXISTS goals (
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

// Numbered, append-only. A new migration is a new entry, never edit an old one.
export const MIGRATIONS: string[] = [
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
  // 2: the inbox snapshot: one row holding the latest ranked result, so the
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
  // 4: projects: a named local folder, optionally tied to a GitHub repo.
  `CREATE TABLE projects (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     repo       TEXT NOT NULL DEFAULT '',
     path       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // 5: the jobs engine (.docs/jobs.md): user-defined jobs, the
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
  // is not the same as any named model. An org can move it under us.
  `ALTER TABLE sessions ADD COLUMN model TEXT;
   ALTER TABLE sessions ADD COLUMN effort TEXT;`,
  // 7: how much a session asks before acting. NULL = 'default' (ask every
  // time), which is what every session predating this column was doing.
  `ALTER TABLE sessions ADD COLUMN permission_mode TEXT;`,
  // 8: pinned sessions: they sort above the rest, regardless of activity.
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  // 9: user priority overrides (any item, survives re-sync) + manual items:
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
  // config (all left in place, unused, a fresh start, no fold-forward). Job
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
  // a true history of runs: each run is a session, and these are its receipt.
  `ALTER TABLE sessions ADD COLUMN run_status TEXT;
   ALTER TABLE sessions ADD COLUMN run_matches INTEGER;
   ALTER TABLE sessions ADD COLUMN run_tokens INTEGER;
   ALTER TABLE sessions ADD COLUMN run_error TEXT;`,
  // 12: cron schedule per job: the precise fire schedule, superseding the
  // coarse hourly/daily/weekly cadence (old rows derive it from cadence).
  `ALTER TABLE jobs ADD COLUMN schedule TEXT;`,
  // 13: fast mode per session: premium speed at premium price, so it is opt-in
  // per session and defaults off, including for every session that predates it.
  `ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;`,
  // 14: artifacts + links. `artifacts` is an
  // index over markdown files (the file is the truth); `links` is the one
  // polymorphic relation table for artifact↔item, artifact↔session and
  // session↔item. IF NOT EXISTS because ensureDurableSchema also
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
  // 15: brief jobs, the FIFO queue and the
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
  // the event log: the result message is already persisted there.
  `ALTER TABLE sessions ADD COLUMN run_cost_usd REAL;
   UPDATE sessions SET run_cost_usd = (
     SELECT json_extract(e.payload, '$.message.total_cost_usd') FROM session_events e
     WHERE e.session_id = sessions.id AND e.kind = 'sdk' AND json_extract(e.payload, '$.message.type') = 'result'
     ORDER BY e.seq DESC LIMIT 1)
   WHERE kind = 'job-run' AND run_cost_usd IS NULL;`,
  // 18: a job may pin the model its runs use; NULL = Claude Code's default.
  `ALTER TABLE jobs ADD COLUMN model TEXT;`,
  // 19: what a run produces: many items (default) or one rolling digest.
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
  // 21: job tool grants, required project, scheduler hardening (start-time
  // clock, catch-up, limits, streaks), and run receipts that say why a run
  // happened and how many finds were new.
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
  // 22: the slot ledger: one row per (job, slot), however it ended. Additive; existing runs are not backfilled.
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
  // 24: jobs as files: the row is state, keyed by the file's id; this names the file.
  `ALTER TABLE jobs ADD COLUMN file TEXT;`,
  // 25: due dates (core/work/due.ts). due_source is 'explicit' (the source
  // stated it) or 'you' (set in the inbox; survives rescans); NULL = the
  // label's default, resolved at read time. 'you' with no due_at = Later.
  `ALTER TABLE work_items ADD COLUMN due_at INTEGER;
   ALTER TABLE work_items ADD COLUMN due_source TEXT;`,
  // 26: workspace → default project → checkout. Exactly one
  // project is the default (the partial unique index holds it to one), and a
  // session records its project instead of having it derived from `cwd`, since
  // worktree folders break path matching. Backfilled at boot, not here: it
  // needs the default, which needs the session counts.
  `ALTER TABLE projects ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_default ON projects(is_default) WHERE is_default = 1;
   ALTER TABLE sessions ADD COLUMN project_id TEXT;`,
  // 27: the agent a session runs on, fixed for its life. Every session before
  // this ran on Claude, so the default backfills them.
  `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';`,
  // 28: checkouts: a project's folders, its main one and its git worktrees
  // (see server/worktrees.ts). Sessions record theirs in `sessions.checkout_id`,
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
  // 29: outbound actions (core/actions): every effect a session had that left
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
  // 30: queued actions (core/actions/queue.ts): every step of a held call's
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
  // 31: goals (core/goals): the goal record, its event log (transitions and
  // the bus, replayed when unhandled), plan steps at run time, armed gates,
  // and one row per session. Also converged by ensureDurableSchema.
  GOALS_SCHEMA,
  // 32: today's plan (core/junior/today.ts): one row per item per local day,
  // and each day's own record. Also converged by ensureDurableSchema.
  TODAY_SCHEMA,
  // 33: tasks on items (core/work/tasks.ts). Also converged by ensureDurableSchema.
  TASKS_SCHEMA,
  // 34: one policy (core/actions/policy.ts): the Autonomy levels are gone. Every
  // Claude chat holds its sends; another agent asks before every change.
  `UPDATE sessions SET permission_mode = CASE WHEN provider = 'claude' THEN 'auto' ELSE 'gated' END WHERE kind IS NULL OR kind NOT IN ('job-run', 'brief', 'goal')`,
]
