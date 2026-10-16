/**
 * The WebSocket contract between the triage server and its frontends.
 *
 * This is the only thing a frontend is allowed to know about the server —
 * "thin frontends, fat core" (see .docs/vision.md). Both `server/` and `web/`
 * import this file, so a change to the wire format is a compile error on the
 * side that did not keep up.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

import type { JobRunStatus, JobRunTrigger } from '../core/job/types.js'
import type { TeamRecipe } from '../core/teams/recipe.js'
import type { RunState, TeamRun } from '../core/teams/engine.js'
import type { ActionHistoryEntry, ActionRecord } from '../core/actions/types.js'
import type { KindCount } from '../core/actions/count.js'
import type { Gate, Goal, GoalEvent, GoalPlan, GoalStepState, GoalTurn, StepRole } from '../core/goals/types.js'
import type { PlanComment } from '../core/goals/review.js'

export type SessionStatus = 'starting' | 'idle' | 'running' | 'error'

// ---------------------------------------------------------------------------
// Workspaces (.docs/workspaces.md) — the top-level scope isolating work from
// personal. Each workspace has its own DB (projects, inbox, jobs, sessions)
// and its own Claude auth backend. Every HTTP request and WS connection is
// bound to exactly one workspace (?workspace= param, else the triage_ws
// cookie, else the default).
// ---------------------------------------------------------------------------

/**
 * How a workspace's Claude subprocesses authenticate:
 * - `inherit` — no overrides; the machine's own ~/.claude login (and its
 *   claude.ai connectors), exactly like before workspaces existed.
 * - `api-key` — spawned with ANTHROPIC_API_KEY from the workspace's .env.
 *   Billed to the key; NO claude.ai connectors (they ride the claude.ai
 *   login), so Slack jobs don't run here. `gh` is unaffected.
 * - `config-dir` — spawned with CLAUDE_CONFIG_DIR pointing into the workspace:
 *   a separate claude.ai login with its own subscription and connectors.
 *   Needs a one-time interactive login (see `loginCommand`).
 */
export type WorkspaceAuthBackend = 'inherit' | 'api-key' | 'config-dir'

export type Workspace = {
  id: string
  name: string
  /** hex color — the ambient "which world am I in" signal in the UI */
  color: string
  description?: string
  authBackend: WorkspaceAuthBackend
  isDefault: boolean
  /** api-key backend: masked tail of the stored key ("…abcd"); null = none yet */
  apiKeyHint?: string | null
  /** config-dir backend: where that login lives, and the one-time login command */
  configDir?: string
  loginCommand?: string
  /** Every agent triage knows, connected or not — the primary (Claude) first. */
  providers: WorkspaceProvider[]
  createdAt: number
}

/**
 * One agent as a workspace has it set up. The primary runs everything —
 * jobs, briefs, team workers — and is always connected; its auth is the
 * workspace's own `authBackend`. Any other is connected per workspace, with an
 * auth of its own, and only chats run on it.
 */
export type WorkspaceProvider = {
  id: ProviderId
  primary: boolean
  connected: boolean
  /** present when connected */
  authBackend?: WorkspaceAuthBackend
  /** api-key backend: masked tail of the stored key; null = none yet */
  apiKeyHint?: string | null
  /** config-dir backend: where that login lives, and the one-time login command */
  configDir?: string
  loginCommand?: string
}

/** One plan window — "5-hour", "Weekly", a spend cap — as a share used. */
export type ProviderLimit = {
  label: string
  /** 0–100 */
  usedPercent: number
  /** epoch ms */
  resetsAt?: number
}

/**
 * What an agent's own account says right now: who is signed in, on what plan,
 * how much of each window is gone, and what it has used lately. Read from the
 * agent itself (Claude's `accountInfo`, Codex's `account/*`), not estimated.
 */
export type ProviderStatus = {
  id: ProviderId
  /** false = the agent couldn't be reached or isn't signed in */
  ok: boolean
  error?: string
  account?: {
    /** "chatgpt", "apiKey", "claude.ai", … — how it is signed in */
    kind?: string
    email?: string
    plan?: string
    org?: string
  }
  limits: ProviderLimit[]
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string }
  /** the last 30 days on this machine (Claude) or this account (Codex) */
  recent?: { days: number; tokens?: number; costUsd?: number }
  checkedAt: number
}

/** GET /api/providers — the workspace's connected agents, live. */
export type ProvidersStatusResponse = { ok: true; providers: ProviderStatus[] } | { ok: false; error: string }

/** POST /api/providers/verify — one real round-trip with a provider's auth. */
export type ProviderVerifyResponse = { ok: true; authOk: boolean; authError?: string } | { ok: false; error: string }

export type WorkspacesResponse =
  | { ok: true; workspaces: Workspace[]; defaultId: string; onboarded: boolean }
  | { ok: false; error: string }

export type WorkspaceResponse = { ok: true; workspace: Workspace } | { ok: false; error: string }

/**
 * POST /api/workspaces/verify — a live probe with the workspace's own env.
 * `authOk` is a real auth check (a one-turn headless prompt) for api-key and
 * config-dir backends — the model catalog alone doesn't prove a key works.
 * For `inherit` it is always true (that login is the machine's own).
 */
export type WorkspaceVerifyResponse =
  | {
      ok: true
      models: ModelOption[]
      connectors: Connector[]
      slackConnected: boolean
      authOk: boolean
      authError?: string
    }
  | { ok: false; error: string }

/**
 * What kind of session a row is. `chat` = a normal user conversation (the
 * default). `job-run` = one job's scan, run as a real session so its
 * transcript is the run's observability (.docs/jobs-v2.md); the sidebar
 * filters these out of the chat list. `goal` = a goal's headless lead,
 * drafting or revising its plan (server/goals.ts).
 */
export type SessionKind = 'chat' | 'job-run' | 'brief' | 'goal'

/**
 * The coding agent a session runs on, fixed for its life. Chats can pick;
 * jobs, briefs and team workers are always `claude`.
 */
export const PROVIDER_IDS = ['claude', 'codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]
export const isProviderId = (v: unknown): v is ProviderId => PROVIDER_IDS.includes(v as ProviderId)

// ---------------------------------------------------------------------------
// Teams v2 (server/teams.ts, core/teams/recipe.ts): a team is a recipe file —
// steps, fan-out, gates, budget — filled in by agents, which are Claude Code
// agent files. Both live in the workspace folder, seeded with defaults.
// ---------------------------------------------------------------------------

/** What an agent may do. Compiled to tool rules at spawn — never a prompt-only promise. */
export type AgentCan = 'read' | 'edit' | 'run' | 'web' | 'browser'
export const AGENT_CANS: AgentCan[] = ['read', 'edit', 'run', 'web', 'browser']

/** Claude Code's own agent colours. */
export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

/** One agent — the fields of a Claude Code agent file triage understands. */
export type AgentSpec = {
  /** slug: the file name, and how a recipe step names it */
  name: string
  label: string
  description: string
  /** a model id from the SDK's list; null = inherit Claude Code's default */
  model: string | null
  effort: EffortLevel | null
  color: AgentColor
  can: AgentCan[]
  prompt: string
}

/**
 * Where a library file stands against what triage ships: untouched, edited,
 * edited while a newer default shipped, or the user's own.
 */
export type LibraryStatus = 'default' | 'edited' | 'update' | 'yours'

/** An agent file, with the teams whose steps name it. */
export type AgentEntry = AgentSpec & { status: LibraryStatus; path: string; usedBy: string[] }

/** One team file: its recipe, or null with the errors that hold it (a typo never runs). */
export type RecipeEntry = {
  name: string
  recipe: TeamRecipe | null
  errors: string[]
  status: LibraryStatus
  path: string
  /** agents the steps name that have no file */
  missing: string[]
}

export type TeamLibraryResponse =
  | { ok: true; teams: RecipeEntry[]; agents: AgentEntry[]; dir: string }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Skills and agents (server/library.ts): every Claude Code skill and subagent a
// session can see — the workspace's own (a local plugin, `triage:<name>`), the
// user's (~/.claude), each project's (.claude/), and installed plugins' (read-only).
// ---------------------------------------------------------------------------

export type LibraryKind = 'skill' | 'agent'
export type LibrarySource = 'workspace' | 'personal' | 'project' | 'plugin'

export type LibraryEntry = {
  kind: LibraryKind
  /** what Claude calls it — `/name` or the subagent type; `triage:name` / `plugin:name` when namespaced */
  name: string
  /** the folder (skill) or file stem (agent) */
  slug: string
  description: string
  source: LibrarySource
  /** where it comes from, said plainly: Personal, a project's name, a plugin's name, the workspace */
  scope: string
  /** SKILL.md, or the agent's .md */
  path: string
  /** false for plugins — the plugin manager rewrites their files */
  editable: boolean
  /** agents: frontmatter extras */
  model?: string
  color?: string
  tools?: string
  /** skills: how many files sit beside SKILL.md */
  files?: number
}

/** A place a new skill or agent can be made: 'workspace', 'personal', or 'project:<folder>'. */
export type LibraryTarget = { id: string; label: string; dir: string }

export type LibraryListResponse =
  | { ok: true; entries: LibraryEntry[]; targets: LibraryTarget[] }
  | { ok: false; error: string }

/** One file of a skill or agent. `files` lists a skill folder's files relative to it. */
export type LibraryFileResponse =
  | { ok: true; path: string; text: string; editable: boolean; binary: boolean; files: string[]; dir: string }
  | { ok: false; error: string }

export type { CardStep, Finding, Handoff, PlanNote, PlanTask, RunState, Slice, TaskState, TeamCard, TeamRun, Worker } from '../core/teams/engine.js'

/** A session's place on a team run: the lead (the chat that proposed it) or one of its workers. */
export type SessionTeamRun = { id: string; role: 'lead' | 'worker'; label: string; state: RunState; rev: number }

/** A run as the client reads it (GET /api/teams/run): everything but the server's bookkeeping. */
export type TeamRunView = Omit<TeamRun, 'root' | 'checkCmds' | 'baseTree' | 'nudged'> & { spentUsd: number }
export type TeamRunResponse = { ok: true; run: TeamRunView } | { ok: false; error: string }

/** One team in the dispatch picker, with what its finished runs really cost (never an estimate). */
export type TeamPickerOption = {
  team: string
  label: string
  description: string
  /** step ids, a fan-out shown as "review ×4" */
  steps: string[]
  budgetUsd: number
  runs: number
  avgUsd?: number
}
export type TeamPickerResponse = { ok: true; suggested: string | null; options: TeamPickerOption[] } | { ok: false; error: string }
export type TeamPlanResponse = { ok: true; sessionId: string } | { ok: false; error: string }
export type SaveAsTeamResponse = { ok: true; team: string; library: TeamLibraryResponse & { ok: true } } | { ok: false; error: string }

/**
 * What the user did with one prompt. `allow_always` is `allow` plus the SDK's
 * own "don't ask again" suggestions, scoped to this session — the narrow way
 * to stop being asked, as against turning the whole session permissive.
 */
export type PermissionBehavior = 'allow' | 'allow_always' | 'deny'

/**
 * How much the session asks before acting. Mostly a subset of the SDK's own
 * `PermissionMode` — the ones that answer "how often am I interrupted" — plus
 * one triage-native mode:
 *
 * - `'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'` are the SDK's,
 *   passed straight through. ('plan' and 'dontAsk' are the SDK's other two —
 *   deliberately not offered, they change what the agent does, not how much it
 *   asks.)
 * - `'gated'` is ours: reads and lookups run without asking; anything that
 *   writes — a file, the shell, or an outward connector call — still prompts.
 *   The SDK has no equivalent, so the server runs at its `'default'` and
 *   enforces the gate itself in `canUseTool` (see `ToolEffect`), which a
 *   subprocess cannot opt out of.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'gated'

/**
 * A tool's blast radius, as the server classifies it before deciding whether
 * `'gated'` mode lets it run unattended:
 *
 * - `read` — reads/lookups only (file reads, greps, `list_work_items`, and
 *   connector calls whose name is clearly a read). Auto-allowed under `gated`.
 * - `local-write` — side effects confined to this machine (file edits, shell,
 *   the triage inbox's own writes).
 * - `external-write` — a call that reaches outside this machine (post to
 *   Slack, open a Jira/Linear/GitHub item, …).
 *
 * Under `gated`, only `read` runs unattended; the other two prompt. Surfaced
 * on the permission card so a prompt says *why* it is asking.
 */
export type ToolEffect = 'read' | 'local-write' | 'external-write'

/** How much thinking the model puts into a turn. The SDK's own scale. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export const isEffortLevel = (v: unknown): v is EffortLevel => EFFORT_LEVELS.includes(v as EffortLevel)

/**
 * Fast mode: the same model served at up to ~2.5x the output tokens/second,
 * at premium pricing. Off by default and chosen per session — speed you opt
 * into for a turn you are waiting on, not a setting to forget you left on.
 *
 * Two facts, deliberately kept apart: what the user asked for (`fastMode` on
 * the session) and what the subprocess reports it can actually do — the SDK
 * only serves fast mode on some models, some plans and some auth backends,
 * and says why when it cannot. Mirrors the SDK's own `FastModeState` /
 * `FastModeDisabledReason`, so a stale reason we no longer know renders as
 * plain unavailability rather than a lie.
 */
export type FastModeState = 'off' | 'cooldown' | 'on'

export type FastModeDisabledReason =
  | 'free'
  | 'preference'
  | 'extra_usage_disabled'
  | 'network_error'
  | 'unknown'
  | 'not_first_party'
  | 'disabled_by_env'
  | 'model_not_allowed'
  | 'sdk_opt_in_required'
  | 'pending'

export type SessionSummary = {
  id: string
  title: string
  cwd: string
  /** the project the session runs in; absent only on rows older than projects */
  projectId?: string
  status: SessionStatus
  /** The chosen model when the user picked one, else what the SDK reported. */
  model?: string
  /** The chosen effort, when the user picked one. */
  effort?: EffortLevel
  /** Fast mode as the user set it. Absent = off. */
  fastMode?: boolean
  /** What fast mode is actually doing, as the live subprocess last reported. */
  fastModeState?: FastModeState
  /** Why fast mode cannot serve right now. Absent = nothing is blocking it. */
  fastModeDisabledReason?: FastModeDisabledReason
  /** How much this session asks before acting. Absent = 'default'. */
  permissionMode?: PermissionMode
  /** The agent this session runs on. Absent = 'claude'. */
  provider?: ProviderId
  /** Pinned to the top of the sidebar. Absent = not pinned. */
  pinned?: boolean
  /** The checkout (folder of the project) the session runs in — stored, never derived from `cwd`. Look it up in `checkouts`. */
  checkoutId?: string
  /** chat (default, absent), job-run, or brief (a headless run that writes an item's brief). */
  kind?: SessionKind
  /** the job a job-run session belongs to. */
  jobId?: string
  /** the work item this session was dispatched for, or briefs (from the links table). */
  itemId?: string
  /** A permission prompt is waiting on the user. Absent = none. */
  waiting?: boolean
  /** The tool the oldest waiting prompt is about (`AskUserQuestion` = a question). Set only with `waiting`. */
  waitingOn?: string
  /** A Claude subprocess is running for it now. False = anything it had running (a subagent) has ended. */
  live?: boolean
  /** Last activity, epoch ms. The sidebar sorts and time-buckets on this. */
  updatedAt: number
  /** the team run this session leads or works on */
  teamRun?: SessionTeamRun
}

// ---------------------------------------------------------------------------
// Agent SDK payloads
//
// The server forwards Agent SDK messages verbatim. Rather than mirror the SDK's
// full type surface into the browser (it is a node-only package), these types
// describe exactly the subset the UI reads — everything else stays untyped and
// is ignored. Widen these as the UI starts reading more.
// ---------------------------------------------------------------------------

/** A content block as it arrives on the wire: `type` plus unknown extras. */
export type RawBlock = { type: string } & Record<string, unknown>

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | RawBlock[] | unknown
  is_error?: boolean
}

export const isTextBlock = (b: RawBlock): b is RawBlock & TextBlock =>
  b.type === 'text' && typeof b.text === 'string'

export const isThinkingBlock = (b: RawBlock): b is RawBlock & ThinkingBlock =>
  b.type === 'thinking' && typeof b.thinking === 'string'

export const isToolUseBlock = (b: RawBlock): b is RawBlock & ToolUseBlock =>
  b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'

export const isToolResultBlock = (b: RawBlock): b is RawBlock & ToolResultBlock =>
  b.type === 'tool_result' && typeof b.tool_use_id === 'string'

export type McpServerInfo = { name: string; status: string }

// ---------------------------------------------------------------------------
// Connectors (GET /api/connectors)
//
// The claude.ai connectors + local MCP servers a session will load, probed by
// spawning a throwaway SDK query with the same options real sessions use and
// reading its init message. HTTP rather than WS: it is request/response data.
// ---------------------------------------------------------------------------

export type ConnectorSource = 'claude.ai' | 'local'

/** Where Claude Code found the server (job-spec.md, item 1). */
export type ConnectorScope = 'claudeai' | 'user' | 'local' | 'project' | 'plugin' | 'managed' | 'unknown'

export type ConnectorTool = {
  /** bare tool name, e.g. "notion-search" */
  name: string
  /** the allowlist name, e.g. "mcp__claude_ai_Notion__notion-search" */
  fullName: string
  description?: string
  /** from the server's own annotations; absent = the server did not say */
  readOnly?: boolean
  destructive?: boolean
  /** false = the tool stays on this machine (a local browser, an editor) */
  openWorld?: boolean
}

export type Connector = {
  /** Display name — "claude.ai " prefix already stripped for claude.ai ones. */
  name: string
  /** the server name as Claude Code reports it ("claude.ai Slack") — what grants key on */
  server: string
  status: string
  source: ConnectorSource
  scope: ConnectorScope
  error?: string
  /** empty unless connected */
  tools: ConnectorTool[]
}

export type ConnectorsResponse =
  | {
      ok: true
      probedAt: number
      connectors: Connector[]
      cwd?: string
      /** local-scope servers configured for OTHER folders — usable once the job runs there */
      elsewhere?: Array<{ name: string; folder: string }>
    }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Models (GET /api/models)
//
// What this machine's Claude Code will actually run, asked of the SDK itself
// (supportedModels()) rather than hardcoded — the catalog changes under us,
// and an org policy can shrink it. Same shape of probe as the connectors one.
// ---------------------------------------------------------------------------

export type ModelOption = {
  /** What to pass as `model` — an alias ('sonnet') or a wire id. */
  id: string
  /** The wire id `id` resolves to; lets a reported model match its alias row. */
  resolvedModel?: string
  /** "Opus (1M context)" */
  name: string
  /** One line under the name in the picker. */
  description: string
  /** Effort levels this model accepts; empty when it has no effort control. */
  efforts: EffortLevel[]
  /** Whether this model can be run in fast mode at all. */
  supportsFastMode?: boolean
}

export type ModelsResponse =
  | { ok: true; probedAt: number; models: ModelOption[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Slash commands (GET /api/commands?cwd=…)
//
// What `/` offers in a composer: Claude Code's own commands plus whatever the
// user, the project and its plugins define. Asked of the SDK
// (supportedCommands()) for the same reason the model catalog is — it moves
// under us — but keyed by *folder* rather than by workspace, because a
// project's .claude/commands and .claude/skills only exist under that project.
// ---------------------------------------------------------------------------

export type SlashCommandInfo = {
  /** the name without the leading slash — `review`, or `novus:ux-review` */
  name: string
  /** the one line under the name in the picker */
  description: string
  /** what it takes after the name, e.g. `<file>`; empty when it takes nothing */
  argumentHint: string
  /** other names that resolve here (`/cost` and `/stats` both mean `/usage`) */
  aliases?: string[]
}

export type CommandsResponse =
  /** `cwd` is the folder the server resolved the query to — `~` expanded, path
   *  made absolute. It is what `commands_changed` frames are keyed by, so a
   *  client holds on to it rather than to the folder it asked about. */
  | { ok: true; cwd: string; probedAt: number; commands: SlashCommandInfo[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Inbox (GET /api/inbox)
//
// Ranked work items. The domain types live in core/work/types.ts (fat core);
// re-exported here so frontends keep importing one contract file.
// ---------------------------------------------------------------------------

export type { Group, ItemKind, Provenance, ScoredItem, WorkItem, WorkSource } from '../core/work/types.js'

export type InboxSnapshot = {
  syncedAt: number
  items: import('../core/work/types.js').ScoredItem[]
  notices: string[]
  /** Today's footer: items that went done since local midnight and are still done */
  landedToday?: number
  /** broken things that are not items — a failed job, a paused team run — for Needs you now */
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
} from '../core/work/flow.js'

/** POST /api/items/flow — set the user's stage/turn override, or clear it. */
export type FlowOverrideRequest =
  | { id: string; stage?: string; turn?: string; note?: string }
  | { id: string; clear: true }

export type InboxResponse = ({ ok: true } & InboxSnapshot) | { ok: false; error: string }

// A status tab other than the open inbox (done / snoozed / archived). Ranked
// like the inbox but read straight from the durable store — no scan, no cache.
export type ItemListResponse =
  | { ok: true; items: import('../core/work/types.js').ScoredItem[] }
  | { ok: false; error: string }

/**
 * Everything about one work item, at any status (GET /api/items/detail?id=…).
 *
 * The list endpoints answer "what should I do next" and only ever show open,
 * repo-scoped items; this answers "tell me about this one" and never filters.
 * Its shape is what a model needs to keep walking — every neighbour carries an
 * id and a title, so each one is a next call rather than a dead end.
 */
export type ItemDetail = {
  item: import('../core/work/types.js').WorkItem
  /** ranking, when the item is in the open inbox right now; null otherwise */
  rank: { score: number; group: import('../core/work/types.js').Group; reason: string } | null
  /** items sharing a canonical ref, at any status */
  linked: { id: string; title: string; source: string; url: string; repo: string; status: string }[]
  /** artifacts linked to this item — its brief and any context notes */
  artifacts: { id: string; title: string; role: LinkRole; author: ArtifactAuthor; path: string }[]
  /** sessions that were dispatched for it or briefed it */
  sessions: { id: string; title: string; role: LinkRole; kind: SessionKind; updatedAt: number }[]
  /** stage and turn — where it is and whose move it is */
  flow: import('../core/work/flow.js').ItemFlow
}

export type ItemDetailResponse = { ok: true; detail: ItemDetail } | { ok: false; error: string }

/**
 * What a triage session can learn about itself (GET /api/sessions/context?id=…).
 * A session is spawned before it is linked to a work item, so this is the only
 * honest way for one to know what it was opened for — a lookup, not a prompt.
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
export type { ItemEvent, ItemEventKind } from '../core/work/state.js'

export type ItemEventsResponse =
  | { ok: true; events: import('../core/work/state.js').ItemEvent[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Activity (GET /api/activity) — job runs, each a real session, as a browsable
// history. Each run links to the transcript (its sessionId) and its produced
// items (.docs/jobs-v2.md).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// System / daemon status + logs (GET /api/system, GET /api/logs) — the gateway
// status surface: is the daemon up, is the scheduler ticking, are connectors
// live, and its recent activity log.
// ---------------------------------------------------------------------------
/**
 * Which copy of triage answered — computed from where the running code lives
 * and how its version is labelled (server/state.ts `buildInfo`). Several copies
 * coexist on one machine, so this is what lets the UI, the CLI and
 * `curl /api/health` all name the same one.
 *
 * `channel` is the question actually worth asking — how far is this from what
 * other people have?
 *
 *   dev     — a source checkout, uncommitted work included (`npm run dev`)
 *   preview — a real install, but built from commits nobody has yet: the
 *             version carries a prerelease label (1.0.4-dev.g23d0004)
 *   release — a clean released version, the same bytes `curl | sh` hands out
 *
 * `surface` is where it is installed, which is a different axis: a preview and
 * a release both normally live in Triage.app.
 */
export type Build = {
  version: string
  channel: 'dev' | 'preview' | 'release'
  surface: 'app' | 'global' | 'checkout'
  /** short commit a preview was built from, parsed off the version label */
  commit: string | null
  /** the preview was built with uncommitted changes in the tree */
  dirty: boolean
  /** the package root on disk — the unambiguous answer to "which copy?" */
  root: string
  /** the state root this daemon reads: ~/.triage, or ~/.triage-dev in dev */
  home: string
  /** `home` is prod's ~/.triage — false means this daemon is on dev's data */
  prodData: boolean
}

export type SystemStatus = {
  version: string
  build: Build
  startedAt: number
  uptimeMs: number
  port: number
  /** the workspace this status describes (statuses are per-workspace) */
  workspace: string
  db: string
  liveSessions: number
  /** true/false, or null when the connector probe hasn't landed yet */
  slackConnected: boolean | null
  connectorsProbedAt: number | null
  connectorCount: number | null
  schedulerLastTickAt: number | null
  runningJobs: number
  inboxSyncedAt: number | null
  githubReconcileAt: number | null
  githubNotice: string | null
  jobs: { total: number; enabled: number; overdue: number; failing: number; configErrors: number }
  /** the macOS LaunchAgent that keeps triage running after reboot/crash: installed? (null off macOS) */
  launchAgent: boolean | null
  /** the workspace's global jobs switch — off = the scheduler never runs a job */
  jobsEnabled: boolean
  /** where JSONL log files are written, or null if file logging is off */
  logDir: string | null
}

export type SystemResponse = { ok: true; status: SystemStatus } | { ok: false; error: string }

export type LogLevel = 'info' | 'warn' | 'error'
export type LogEntry = {
  seq: number
  ts: number
  level: LogLevel
  subsystem: string
  message: string
  /** optional machine-readable context (ids, counts, durations) */
  fields?: Record<string, unknown>
}
export type LogsResponse =
  | { ok: true; entries: LogEntry[]; subsystems: string[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Usage (GET /api/usage?days=N)
//
// What Claude Code has spent on this machine, read from its own transcripts
// (`~/.claude/projects/**/*.jsonl`) rather than from anything we write — so it
// covers sessions started here, in a terminal, or anywhere else. Cost is
// derived from list prices: on a Pro/Max subscription it is what the same
// tokens would have cost on the API, not a bill.
// ---------------------------------------------------------------------------

export type UsageTotals = {
  input: number
  output: number
  /** Both TTLs of cache write, summed. */
  cacheWrite: number
  cacheRead: number
  /** Every token of every kind. */
  tokens: number
  /** Dollars, priced models only. */
  cost: number
  messages: number
  sessions: number
  /** Messages on a model we have no price for — counted, not costed. */
  unpricedMessages: number
}

/** One calendar day, with the per-model split the stacked chart draws. */
export type UsageDay = {
  date: string
  cost: number
  tokens: number
  byModel: Record<string, { cost: number; tokens: number }>
}

export type UsageByModel = {
  model: string
  messages: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  tokens: number
  cost: number
  /** False when the model has no price row — its cost reads as 0. */
  priced: boolean
}

export type UsageByProject = {
  path: string
  sessions: number
  messages: number
  tokens: number
  cost: number
}

export type UsageSummary = {
  /** `YYYY-MM-DD`, inclusive. */
  from: string
  to: string
  days: number
  totals: UsageTotals
  /** Every day in the window, zeros included. */
  daily: UsageDay[]
  models: UsageByModel[]
  projects: UsageByProject[]
  /** Models seen with no price row — surfaced so the total is honest. */
  unpricedModels: string[]
  scan: { files: number; reread: number; ms: number }
}

export type UsageResponse = { ok: true; usage: UsageSummary } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Per-session spend (GET /api/usage/sessions?ids=…&days=…)
//
// What a work item cost: the same ledger the Usage tab reads, folded by
// session instead of by day/model/project. The client asks about the sessions
// it already knows are linked to the item, so the item→session join stays in
// one place (ItemPage's `linkedSessions`) instead of being re-derived here.
// ---------------------------------------------------------------------------

export type SessionSpend = {
  cost: number
  tokens: number
  messages: number
  /** `tokens`, split the way the API bills it. Cache writes are both TTLs. */
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** False when some of the spend came from a model with no price row. */
  priced: boolean
  /** The part of it the session's subagents spent (their own transcripts). Absent = none. */
  subagents?: { cost: number; messages: number }
}

/** One model's share of a spend total, for the split meter under it. */
export type UsageModelSlice = {
  model: string
  cost: number
  tokens: number
  priced: boolean
}

export type SessionsUsage = {
  /** The window the ledger was scanned over. */
  days: number
  /** Keyed by *triage* session id — ids with no transcript in the window are absent. */
  bySession: Record<string, SessionSpend>
  /** The same spend split by model, largest first. */
  models: UsageModelSlice[]
  totals: SessionSpend & { sessions: number }
}

export type SessionsUsageResponse =
  | { ok: true; usage: SessionsUsage }
  | { ok: false; error: string }

/** The windows the Usage tab offers. */
export const USAGE_WINDOWS = [7, 30, 90] as const

// ---------------------------------------------------------------------------
// Connected repos (GET /api/repos, PUT /api/repos)
//
// The repos the GitHub source is scoped to, per workspace. Empty = NO GitHub
// items (.docs/workspaces.md): scope is opt-in per workspace so the same PRs
// don't mirror into every inbox. Pick the repos each workspace should track.
// ---------------------------------------------------------------------------

export type ReposResponse =
  | { ok: true; connected: string[]; available: string[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Projects (GET/POST/DELETE /api/projects)
//
// A project names a local working folder, optionally tied to a GitHub repo.
// Selecting one runs sessions in that folder; dispatch matches a work item's
// repo to a project to land in the right folder automatically.
// ---------------------------------------------------------------------------

export type Project = {
  id: string
  name: string
  /** owner/name; empty when the project isn't tied to a repo */
  repo: string
  /** absolute local folder sessions run in */
  path: string
  /** the workspace's default project — exactly one once the workspace has any */
  isDefault?: boolean
}

// ---------------------------------------------------------------------------
// Checkouts (decision 549a251e): a folder of a project. `main` is the folder
// the user added — its branch is whatever is checked out right now; a
// `worktree` is a `git worktree` of the same repo, found with `git worktree
// list`. Sessions and terminals belong to one; the inbox stays workspace-wide.
// ---------------------------------------------------------------------------

export type CheckoutKind = 'main' | 'worktree'
/** `removed` = the folder is gone; the row stays so its sessions keep their history. */
export type CheckoutState = 'active' | 'removed'

export type Checkout = {
  id: string
  projectId: string
  kind: CheckoutKind
  /** absolute folder */
  path: string
  /** the checked-out branch as last read from git; null = detached HEAD or not a repo */
  branch: string | null
  /** the branch a worktree was cut from; null for main, and for worktrees made outside triage */
  base: string | null
  /** the work item a worktree was made for, when triage made it for one */
  itemId: string | null
  state: CheckoutState
  createdAt: number
}

/** An editor triage found on this machine, for "Open in…" (GET /api/editors). */
export type Editor = { id: string; name: string }

export type EditorsResponse = { ok: true; editors: Editor[] } | { ok: false; error: string }

/**
 * POST /api/checkouts/:id/open with `{ editor }` — an editor id from
 * /api/editors, or 'finder' to reveal the folder.
 */
export type OpenCheckoutResponse = { ok: true } | { ok: false; error: string }
// POST /api/checkouts/:id/recreate — a removed worktree back at its same folder
// (so its sessions resume), node_modules and .env copied in again. Answers as OpenCheckoutResponse.

/**
 * GET /api/checkouts/:id/removal — what removing a worktree would lose, read
 * before asking. `safe` = nothing: merged, clean, nothing running in it.
 */
export type RemovalCheck = {
  branch: string | null
  /** the branch its commits are compared with (the repo's default branch) */
  base: string | null
  /** commits on the worktree's branch that `base` doesn't have; null when it can't be told */
  unmerged: number | null
  /** uncommitted files in the folder */
  uncommitted: number
  /** sessions working there right now — removing stops them */
  running: number
  safe: boolean
}

/** Where a session being made in a new worktree has got to: the git worktree, its node_modules and .env, the session itself. */
export type CreateStep = 'worktree' | 'files' | 'session'

export type RemovalCheckResponse = { ok: true; check: RemovalCheck } | { ok: false; error: string }

/**
 * POST /api/checkouts/:id/remove with `{ force?, deleteBranch? }` —
 * `git worktree remove`, then the local branch. Without `force` an unsafe
 * worktree is refused and the check comes back to say why.
 */
export type RemoveCheckoutResponse = { ok: true } | { ok: false; error: string; check?: RemovalCheck }

export type ProjectsResponse =
  | { ok: true; projects: Project[] }
  | { ok: false; error: string }

// GET /api/git/branch?cwd=… — the checked-out branch of a folder, for the
// draft composer's header (a session derives its own once it exists).
export type BranchResponse = { ok: true; branch: string | null } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Session changes — what a session's own turns did to the repo it runs in
// ---------------------------------------------------------------------------

/** git's own letters, plus untracked-at-snapshot files, which read as added. */
export type ChangeStatus = 'modified' | 'added' | 'deleted'

/**
 * How sure we are that *this* session made a change. Sessions share a working
 * tree, so this is inferred, not definitional (worktree-per-session would make
 * it definitional — roadmap v0.3):
 *  - `exact`     — it moved inside one of this session's turn windows and no
 *                  other session's turn was running in the same repo then.
 *  - `shared`    — another session's turns changed this file too.
 *  - `ambiguous` — it moved during a turn that overlapped another session's,
 *                  and none of our own tools named it.
 */
export type ChangeConfidence = 'exact' | 'shared' | 'ambiguous'

export type ChangedFile = {
  /** repo-relative, `/`-joined */
  path: string
  status: ChangeStatus
  insertions: number
  deletions: number
  isBinary: boolean
  /** an Edit/Write/MultiEdit/NotebookEdit of this session named the path */
  touched: boolean
  confidence: ChangeConfidence
  /** titles of other sessions whose own turns also changed this file */
  alsoChangedBy: string[]
  /** which of this session's turns (1-based) changed it */
  turns: number[]
}

/** One turn of this session, as the changes view counts it. */
export type SessionTurnSummary = {
  seq: number
  files: number
  insertions: number
  deletions: number
  startedAt: number
  /** null while the turn is still running */
  endedAt: number | null
  /** titles of other sessions whose turns overlapped this one in this repo */
  overlapped: string[]
}

export type SessionChanges = {
  /** the repo root; null when the session's folder is not in a git repo */
  root: string | null
  /** set when there is nothing to show and the reason is worth saying */
  unavailable?: string
  files: ChangedFile[]
  turns: SessionTurnSummary[]
  insertions: number
  deletions: number
}

export type SessionChangesResponse =
  | { ok: true; changes: SessionChanges }
  | { ok: false; error: string }

/** GET /api/sessions/:id/diff?path=… — one file, as unified-diff text. */
export type SessionDiffResponse =
  | { ok: true; path: string; patch: string; isBinary: boolean; truncated: boolean }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Working changes — the Changes rail: every project's uncommitted files
// against HEAD, whoever made them. Paths are relative to the project folder.
// ---------------------------------------------------------------------------

export type WorkingFile = {
  path: string
  status: ChangeStatus
  insertions: number
  deletions: number
  isBinary: boolean
}

/** One checkout's uncommitted work against its own HEAD. */
export type CheckoutChanges = {
  checkout: Checkout
  files: WorkingFile[]
  insertions: number
  deletions: number
  /** worktrees only: commits on its branch that the main checkout's branch doesn't have */
  ahead?: number
  /** git failed for this checkout; the others still load */
  error?: string
}

export type ProjectChanges = {
  project: Project
  /** false when the project folder is not inside a git repo */
  isRepo: boolean
  /** main first, then worktrees by branch; removed ones are left out */
  checkouts: CheckoutChanges[]
}

/** GET /api/changes */
export type WorkingChangesResponse =
  | { ok: true; projects: ProjectChanges[] }
  | { ok: false; error: string }

/**
 * GET /api/changes/diff?checkoutId=…&path=… — the same shape as a session's
 * file diff. A project id in `checkoutId` (or the older `projectId=`) means
 * that project's main checkout, so links made before checkouts still open.
 */
export type WorkingDiffResponse = SessionDiffResponse

/**
 * GET /api/changes/file?checkoutId=…&path=… — a changed file, for editing.
 * `version` is a hash of the bytes read; a save sends it back so an edit made
 * on disk in the meantime (an agent, your editor) is refused, not clobbered.
 */
export type ProjectFileResponse =
  | { ok: true; path: string; kind: 'text'; content: string; version: string }
  | { ok: true; path: string; kind: 'binary' | 'large' | 'missing'; bytes: number }
  | { ok: false; error: string }

/** PUT /api/changes/file?checkoutId=…&path=… with body `{ content, version }`. */
export type SaveProjectFileResponse =
  | { ok: true; version: string }
  | { ok: false; error: string; conflict?: boolean }

// POST /api/pick-folder — opens the OS's native folder chooser on the machine
// running the server (which is the user's own machine) and returns the picked
// absolute path. `cancelled` is the user dismissing the dialog, not an error.
export type PickFolderResponse =
  | { ok: true; path: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Jobs (GET/POST/PUT/DELETE /api/jobs, POST /api/jobs/draft,
// POST /api/jobs/preview) — the ingestion engine (.docs/jobs.md).
// Domain types live in core/job/types.ts; type-only re-exports, so nothing
// server-side leaks into the browser bundle.
// ---------------------------------------------------------------------------

export type { NewJob, Job, JobCadence, JobConnector, JobDraft, JobNotify, JobOutput, JobPreviewResult, JobPreviewRow, JobRunStatus, JobRunTrigger, JobSlotRun, JobSlotStatus, JobToolGrant } from '../core/job/types.js'

export type JobsResponse =
  | { ok: true; jobs: import('../core/job/types.js').Job[] }
  | { ok: false; error: string }

/** The job file editor's side list: what a file may name on this machine. */
export type JobFileReference = {
  projects: { id: string; name: string }[]
  builtins: string[]
  /** each connected MCP server and its tool lines, as a file spells them (`<server>/<tool>`) */
  servers: { server: string; tools: string[] }[]
  /** skills and agents a job may name (`skills:`, `agents:`) — not a project's, which runs don't load */
  skills: string[]
  agents: string[]
}

/**
 * GET /api/jobs/file[?id=] — a job's file text (or a starter) and the
 * reference list. POST /api/jobs/file[?id=] { text } — saved only when it
 * validates; otherwise `errors` lists every problem and nothing is written.
 */
export type JobFileResponse =
  | { ok: true; text: string; file?: string; reference: JobFileReference }
  | { ok: true; id: string }
  | { ok: false; error: string; errors?: string[] }

/** GET /api/jobs/runs?id= — the slot ledger for one job, newest slot first. */
export type JobRunsResponse =
  | { ok: true; runs: import('../core/job/types.js').JobSlotRun[] }
  | { ok: false; error: string }

export type JobDraftResponse =
  | { ok: true; draft: import('../core/job/types.js').JobDraft }
  | { ok: false; error: string }

// A preview is a dry run streamed like a session: POST starts it and returns
// an ephemeral session id to subscribe to; GET polls its outcome. Nothing is
// stored — the events live in memory for a few minutes and then go.
export type JobPreviewStartResponse = { ok: true; previewId: string } | { ok: false; error: string }
export type JobPreviewStatusResponse =
  | { ok: true; status: 'running' | 'ready' | 'failed'; result?: import('../core/job/types.js').JobPreviewResult; error?: string }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Item state (POST /api/items/state) — the user-state overlay: done, snoozed,
// dismissed. Ingestion never writes it; the re-arm rule reopens items in code.
// ---------------------------------------------------------------------------

export type { ItemStatus } from '../core/work/state.js'

export type ItemStateResponse = { ok: true } | { ok: false; error: string }
/** POST /api/items/urls — the links as saved (trimmed, deduplicated) */
export type ItemUrlsResponse = { ok: true; urls: string[] } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Manual items (POST/PUT/DELETE /api/items/manual) — to-dos the user adds by
// hand in the inbox. Their own table; source/kind 'manual'. Also POST
// /api/items/priority — a user priority override for any item (source or manual).
// ---------------------------------------------------------------------------

export type ManualItemInput = {
  title: string
  projectId?: string
  /** the human's short intent, in their words (`note` is the pre-0.7 name, still accepted) */
  description?: string
  note?: string
  url?: string
  /** extra links — the Slack thread, the PR, a doc; the complete list, [] clears */
  urls?: string[]
  priority?: number
  /** the complete desired image set — new base64 uploads and the refs to keep */
  images?: ItemImageEdit[]
}

export type ManualItemResponse = { ok: true } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Ingestion (POST /api/items/upsert, POST /api/items/resolve) — the contract
// that makes external scanners first-class; also served over MCP (server/mcp.ts).
// Idempotent: id-keyed, update-only-if-newer, user-state-preserving. Validates
// and rejects rather than repairs.
// ---------------------------------------------------------------------------

export type UpsertResponse =
  | { ok: true; outcome: 'inserted' | 'updated' | 'unchanged' }
  | { ok: false; error: string }

/** A `stream_event`'s inner Anthropic streaming event (deltas only, for now). */
export type StreamEvent = {
  type: string
  delta?: { type: string; text?: string }
}

/** The subset of an SDK message the UI reads. */
export type SdkMessage = {
  type: string
  subtype?: string
  /** Claude Code's own session id — present on every SDK message. */
  session_id?: string
  model?: string
  tools?: string[]
  mcp_servers?: McpServerInfo[]
  message?: { role?: string; content?: RawBlock[] }
  event?: StreamEvent
  total_cost_usd?: number
  duration_ms?: number
  num_turns?: number
  /** Carried on init and result messages; the session's fast-mode reality. */
  fast_mode_state?: FastModeState
  fast_mode_disabled_reason?: FastModeDisabledReason
  /** init only: the `/` commands whose UX needs a real terminal — we hide them. */
  terminal_slash_commands?: string[]
  /** `commands_changed` only: the replacement list, to be swapped in whole. */
  commands?: SlashCommandInfo[]
  /** `local_command_output` only: what a command like /usage printed. */
  content?: string
  /**
   * Set on assistant/user messages produced inside a subagent: the id of the
   * Agent/Task tool_use that started it. Null (or absent) = the main agent.
   */
  parent_tool_use_id?: string | null
  /** `task_*` system messages (a subagent, a background shell, …) */
  task_id?: string
  tool_use_id?: string
  /** `task_started`: 'local_agent' is a subagent; 'local_bash' a shell command */
  task_type?: string
  description?: string
  subagent_type?: string
  prompt?: string
  is_backgrounded?: boolean
  spawn_depth?: number
  /** `task_progress` / `task_notification`: what the task has used so far */
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  last_tool_name?: string
  /** `task_progress`: a one-line status; `task_notification`: how it ended */
  summary?: string
  /** `task_notification` */
  status?: string
  /** `task_notification` for a shell: where its output went ('' for a foreground one) */
  output_file?: string
  /** `task_notification`: the report a subagent handed back with SubagentHandback */
  handback_report?: { text?: string }
  /** `task_updated`: the fields that changed */
  patch?: { status?: string; is_backgrounded?: boolean; error?: string }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * An image pasted, dropped, or picked into a composer, carried inline as
 * base64 — the server holds no upload store, and the model wants the bytes
 * anyway. Kept small on purpose (see `MAX_IMAGE_BYTES`): these ride the
 * WebSocket and land in the event log so a reload still shows them.
 */
export type ImageAttachment = {
  /** The original filename, when there was one — pasted screenshots have none. */
  name?: string
  /** An `image/*` media type the API accepts. */
  mediaType: ImageMediaType
  /** Base64 of the raw bytes — no `data:` prefix. */
  data: string
}

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

export const isImageMediaType = (v: unknown): v is ImageMediaType =>
  typeof v === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v)

/** Per-image ceiling on the decoded bytes, and how many ride one message. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 8

/**
 * An image attached to a *work item* — a screenshot pasted into the composer
 * or into the item's description. Unlike `ImageAttachment`, the bytes are NOT
 * carried inline: an item's payload is rebroadcast to every client on every
 * inbox sync, so the bytes live on disk in the workspace
 * (`attachments/<item>/<id>.png`) and only this ref rides the wire. Fetch the
 * bytes from `itemImageUrl()`.
 */
export type ItemImage = {
  /** uuid; also the on-disk filename stem */
  id: string
  /** the original filename, when there was one */
  name?: string
  mediaType: ImageMediaType
  /** decoded size on disk — what the UI shows and what the cap is measured against */
  bytes: number
}

/**
 * One entry of the `images` list a client sends when it saves an item: either
 * "keep the image you already hold" (`{ id }`) or "here is a new one"
 * (base64, like a chat attachment). The list is the complete desired set —
 * anything the server holds and the list omits is deleted. Absent = untouched.
 */
export type ItemImageEdit = { id: string } | ImageAttachment

export const MAX_IMAGES_PER_ITEM = 8

/** Where an item image's raw bytes are served (the `triage_ws` cookie scopes it). */
export const itemImageUrl = (itemId: string, imageId: string): string =>
  `/api/items/image?item=${encodeURIComponent(itemId)}&image=${encodeURIComponent(imageId)}`

/** POST /api/items/images — replace the image set on any item (manual or scanned). */
export type ItemImagesInput = { id: string; images: ItemImageEdit[] }
export type ItemImagesResponse = { ok: true; images: ItemImage[] } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Artifacts (GET/POST/PUT/DELETE /api/artifacts, GET/POST/DELETE /api/links) —
// markdown files with frontmatter under the workspace's artifacts folder
// (.docs/next-version.md, phase 1). The file is the truth; this is its index
// row. There is ONE kind of artifact: what a document *is to* an item or a
// session ("the brief for", "context for") is a link role, not a type.
// ---------------------------------------------------------------------------

export type ArtifactAuthor = 'human' | 'model'
export const isArtifactAuthor = (v: unknown): v is ArtifactAuthor => v === 'human' || v === 'model'

export type Artifact = {
  id: string
  /** `/`-joined path relative to the workspace's artifacts folder */
  path: string
  title: string
  /** who wrote it: the model rewrites its own files in place; yours it may only propose to */
  author: ArtifactAuthor
  /** canonical refs (github:owner/repo#1, linear:KEY-1) the frontmatter declares */
  refs: string[]
  created: number
  updated: number
  /** file mtime and size at index time — the cheap "has it changed" check */
  mtime: number
  size: number
  /** set when the frontmatter did not parse and defaults were used */
  warning?: string
}

export type LinkKind = 'artifact' | 'item' | 'session'
export const LINK_KINDS: readonly LinkKind[] = ['artifact', 'item', 'session']
export const isLinkKind = (v: unknown): v is LinkKind => LINK_KINDS.includes(v as LinkKind)

/**
 * artifact→item: `brief` (the document about it — inherits the item's
 * lifecycle) or `context` (human notes it should be read with);
 * artifact→session: `context`; session→item: `dispatch` (the session works
 * the item) or `brief` (the session wrote its brief).
 */
export type LinkRole = 'brief' | 'report' | 'context' | 'dispatch' | 'plan'
export const LINK_ROLES: readonly LinkRole[] = ['brief', 'report', 'context', 'dispatch', 'plan']
export const isLinkRole = (v: unknown): v is LinkRole => LINK_ROLES.includes(v as LinkRole)

export type Link = {
  id: string
  fromKind: LinkKind
  fromId: string
  toKind: LinkKind
  toId: string
  role: LinkRole
  createdAt: number
}

/** POST /api/artifacts body (create) and PUT /api/artifacts?id= body (patch). */
export type ArtifactInput = {
  title?: string
  body?: string
  refs?: string[]
  /** create only; defaults to human. The stdio shim and sessions write as model. */
  author?: ArtifactAuthor
  /** create only: links to add right away */
  links?: { kind: LinkKind; id: string; role: LinkRole }[]
}

/** An index row with its outgoing links, and whether the list hides it by default. */
export type ArtifactWithLinks = Artifact & {
  links: Link[]
  /** linked as the brief of an item that is done or archived */
  hidden: boolean
}

export type ArtifactsResponse =
  | { ok: true; root: string; artifacts: ArtifactWithLinks[] }
  | { ok: false; error: string }

export type ArtifactContentResponse =
  | { ok: true; artifact: Artifact; body: string; links: Link[]; abs: string }
  | { ok: false; error: string }

export type ArtifactResponse = { ok: true; artifact: Artifact } | { ok: false; error: string }

export type LinksResponse = { ok: true; links: Link[] } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Briefs (.docs/next-version.md, phase 2) — a playbook run against one work
// item that writes a markdown brief (an artifact linked with role `brief`).
// The job row IS the queue: FIFO per workspace, one at a time, daily cap.
// `stale` is not stored — it is derived when the source moved after the brief.
// ---------------------------------------------------------------------------

export type BriefStatus = 'queued' | 'running' | 'ready' | 'failed'
export const BRIEF_STATUSES: readonly BriefStatus[] = ['queued', 'running', 'ready', 'failed']

export type BriefJob = {
  id: string
  itemId: string
  status: BriefStatus
  /** the playbook used — an ItemKind name, resolved to a file under the workspace's playbooks/ */
  playbook: string
  /** the template text as edited in the brief composer for this brief only; null = the file as it was */
  playbookBody: string | null
  model: string | null
  /** the user's context note from the brief composer */
  note: string | null
  /** the brief session (kind 'brief'); null while queued */
  sessionId: string | null
  /** the artifact the run wrote; null until the first successful write */
  artifactId: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** GET /api/briefs?itemId= — the item's latest job with what it produced. */
export type BriefView = {
  job: BriefJob | null
  /** the source moved after the brief was written — offer a re-brief */
  stale: boolean
  artifact: Artifact | null
  body: string | null
  /** 0-based place in the queue while queued, else null */
  queuePosition: number | null
}

export type BriefResponse = { ok: true; brief: BriefView } | { ok: false; error: string }
export type BriefJobsResponse = { ok: true; jobs: BriefJob[] } | { ok: false; error: string }

/** POST /api/briefs body. */
export type BriefRequest = {
  itemIds: string[]
  note?: string
  model?: string
  /** override the playbook (an ItemKind name or a brief type); default = the item's kind */
  playbook?: string
  /** the playbook's text as edited for this brief; sent only when it differs from the file */
  playbookBody?: string
}

// Playbooks (GET/PUT /api/playbooks?kind=) — one markdown file per ItemKind,
// seeded with defaults, edited like a skill.
export type PlaybookInfo = { kind: string; custom: boolean; path: string }
export type PlaybooksResponse = { ok: true; playbooks: PlaybookInfo[] } | { ok: false; error: string }
export type PlaybookResponse = { ok: true; kind: string; body: string; custom: boolean; path: string } | { ok: false; error: string }

// Workspace settings (GET/PUT /api/settings) — the few server-side knobs.
export type WorkspaceSettings = {
  /** the global jobs switch; off = the scheduler never runs a job */
  jobsEnabled: boolean
  /** default per-run limits for jobs that don't set their own */
  jobTimeoutMs: number
  /** null = no cap */
  jobBudgetUsd: number | null
  /** how many brief runs may start per local day */
  briefsDailyCap: number
  /** the model briefs run on when the modal doesn't pick one; null = Claude Code's default */
  briefsDefaultModel: string | null
  /** model ids the pickers hide; the catalog stays whole, so a new model shows up on its own */
  hiddenModels: string[]
  /** model ids typed by hand — for a model the probed catalog does not list (yet) */
  customModels: string[]
}
export type SettingsResponse = { ok: true; settings: WorkspaceSettings } | { ok: false; error: string }

// Dispatch preview (GET /api/dispatch/preview?itemId=) — what a dispatched
// session starts with, composed server-side so the brief rides as a mention.
export type DispatchPreview = {
  title: string
  cwd: string | null
  text: string
  mentions: Mention[]
  /** a branch for a new worktree, named from the item; null when the project isn't a git repo */
  branch: string | null
  /** a live worktree already made for this item — dispatch continues there */
  checkoutId: string | null
}
export type DispatchPreviewResponse = { ok: true; preview: DispatchPreview } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Actions (GET /api/actions, POST /api/actions/override) — every outbound
// action a session took: a PR, a comment, a ticket, a push. Phase 1 records
// them; approval is unchanged. Domain types live in core/actions/types.ts.
// ---------------------------------------------------------------------------

export type {
  ActionActor,
  ActionAllowedBy,
  ActionHistoryEntry,
  ActionKind,
  ActionQueue,
  ActionRecord,
  ActionStatus,
  ActionWhy,
} from '../core/actions/types.js'
export type { KindCount } from '../core/actions/count.js'

/** A record as the page shows it: names for the ids it carries. */
export type ActionView = ActionRecord & {
  /** what happened, in words: "Opened PR #2 · stage + turn", "Pushed feat/x" (core/actions/describe.ts) */
  title: string
  /** why it counted, in words: "matches `git push`", "“send” in the tool name" */
  counted: string
  /** "a1b2c3" — the id the agent was told ("queued as action #a1b2c3") */
  short: string
  /** a queued action's steps, oldest first; absent on one recorded as it ran */
  history?: ActionHistoryEntry[]
  sessionTitle?: string
  jobTitle?: string
  /** the team run's label, for a lead's or a worker's action */
  teamLabel?: string
  itemTitle?: string
  /** the actions file now says this tool is not an action — listed only under "Not actions" */
  hidden?: boolean
}

export type ActionsResponse =
  | {
      ok: true
      actions: ActionView[]
      /** the daily count line, and the counts behind it (server's local day) */
      today: { line: string; counts: KindCount[] }
      /** the actions file, and what's wrong with it (the defaults stand in meanwhile) */
      file: { path: string; errors: string[] }
      /** queued actions waiting on you, workspace-wide */
      needsYou: number
    }
  | { ok: false; error: string }

/** The rail badge: how many queued actions wait on you. */
export type ActionsPendingResponse = { ok: true; needsYou: number } | { ok: false; error: string }

/**
 * A queued action's verbs (POST /api/actions/<verb>, phase 2):
 *   approve    `args` = edit, then approve — the edited JSON object is what goes out
 *   undo       back to waiting, inside the 15s window
 *   send-back  `notes` go to the session that drafted it
 *   reject     with an optional `reason`
 *   retry      a failed or unknown dispatch, scheduled again
 */
export type ActionVerb = 'approve' | 'undo' | 'send-back' | 'reject' | 'retry'
export type ActionMoveRequest = { id: string; args?: Record<string, unknown>; notes?: string; reason?: string }
export type ActionMoveResponse = { ok: true; action: ActionView } | { ok: false; error: string }

/**
 * One-click override from a row: `verdict: 'not_action'` adds the record's
 * tool (a connector's name, or `Bash(<pattern>)` for each pattern it counted
 * by) to `not_action`; `'action'` takes those back out, and adds a connector
 * to `action` when sorting alone wouldn't count it. `entries` = what was set.
 */
export type ActionOverrideRequest = { actionId: string; verdict: 'action' | 'not_action' }
export type ActionOverrideResponse = { ok: true; entries: string[] } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Mentions — `@` references typed into a composer. Claude Code's own `@file`
// is a feature of its terminal UI, not of the agent: the SDK passes text
// through verbatim. So the composer picks, the server resolves at send time,
// and the model gets the content as extra blocks on the same message. One
// shape for every kind so the picker, the chips and the wire grow together —
// adding a kind (an artifact, say) is a new `MentionKind` plus a resolver.
// ---------------------------------------------------------------------------

export const MENTION_KINDS = ['file', 'item', 'session', 'artifact'] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

export const isMentionKind = (v: unknown): v is MentionKind =>
  typeof v === 'string' && (MENTION_KINDS as readonly string[]).includes(v)

export type Mention = {
  kind: MentionKind
  /**
   * file: a path relative to the session's folder (a trailing `/` means a
   * directory); item: a work item id; session: a session id; artifact: an
   * artifact id (the markdown body rides the message, like a small file).
   */
  ref: string
  /** what the chip shows — the basename, the item title, the session title */
  label: string
}

/** A mention after the server resolved it — what the model actually received. */
export type ResolvedMention = Mention & {
  /** file: size on disk */
  bytes?: number
  /** the body (file text, directory listing, item/session summary) rode the message */
  inlined?: boolean
  /** why only the reference itself was passed on */
  error?: string
}

/** The token the picker writes into the text for a mention, and how it reads back. */
export function mentionToken(m: Mention): string {
  if (m.kind === 'file') return /\s/.test(m.ref) ? `@"${m.ref}"` : `@${m.ref}`
  return `@${m.kind}:${m.ref}`
}

export const MAX_MENTIONS_PER_MESSAGE = 16
/** A text file above this rides as a path only; the model reads what it needs. */
export const MAX_INLINE_FILE_BYTES = 64 * 1024
/** Ceiling for everything inlined on one message, files and listings together. */
export const MAX_INLINE_TOTAL_BYTES = 200 * 1024

/** `GET /api/files/search?root=&q=&limit=` — fuzzy matches under one folder. */
export type FileHit = { path: string; dir: boolean }
export type FileSearchResponse =
  | { ok: true; root: string; hits: FileHit[]; total: number; truncated: boolean }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Session events (the replay log, and the live stream)
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { kind: 'sdk'; message: SdkMessage }
  | {
      kind: 'local_user'
      text: string
      images?: ImageAttachment[]
      mentions?: ResolvedMention[]
      /** who sent it when it wasn't the user — a teammate agent's label, or 'triage'; absent = the user */
      from?: string
      /** A message the user wrote to a subagent, relayed to it through the main agent. */
      relay?: AgentRelay
    }
  | { kind: 'error'; message: string }
  /** a line triage writes into the transcript itself — a team paused, a stage began */
  | { kind: 'notice'; text: string }
  /**
   * A new Claude subprocess took over a session that already had history (a
   * revival after the last one ended). Whatever the old one had running —
   * subagents, background shells — ended with it. Written by triage, because
   * the SDK's own `init` arrives at the start of every turn, not once per process.
   */
  | { kind: 'subprocess' }
  | {
      kind: 'permission_request'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      description?: string
      /**
       * The SDK offered "don't ask again" rules for this call, so the card can
       * show that button. Not every prompt has them (a one-off path, say).
       */
      canAlwaysAllow?: boolean
      /** The tool's blast radius, so the card can say why it is asking. */
      effect?: ToolEffect
      /** Set when a subagent made the call: its agent id (a `task_*` message's task_id). */
      agentId?: string
      /** The tool_use this prompt is about — how an action record learns who allowed it. Absent on older logs. */
      toolUseId?: string
    }
  // 'expired' = the request outlived its subprocess (interrupt, crash, server
  // restart) and can no longer be answered.
  | {
      kind: 'permission_resolved'
      id: string
      behavior: PermissionBehavior | 'expired'
      /** What the user picked, when the prompt was an AskUserQuestion. */
      answers?: QuestionAnswers
    }

/** Who a relayed message is for: the subagent's Agent tool_use id, its agent id, and its label. */
export type AgentRelay = { toolUseId: string; agentId: string; label: string }

/**
 * The answers to an `AskUserQuestion` call: question text → the chosen option
 * label (multi-select joins its labels with ", "). Handed back to the tool as
 * `input.answers`, which is where Claude Code reads a picked answer from.
 */
export type QuestionAnswers = Record<string, string>

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Terminals — PTY-backed shells the daemon runs for the browser. Ephemeral:
// they live in the daemon's memory and die with it, so nothing here is stored.
// ---------------------------------------------------------------------------

/**
 * GET / POST /api/remote — phone access (server/remote.ts). Only this machine
 * sees the token; a paired device gets `{ local: false }`.
 */
export type RemoteStatus =
  | { local: false }
  | {
      local: true
      enabled: boolean
      /** the pairing token — the QR code carries it; never shown as text */
      token: string
      /** the 6-digit code a phone can type instead: single use, short-lived (null while access is off) */
      code: { digits: string; expiresAt: number } | null
      port: number
      /** IPv4 addresses on this machine's networks, Wi-Fi first */
      addresses: { name: string; address: string }[]
      /** `Your-Mac.local`, when the OS has one */
      hostname: string | null
      /** "Anywhere" is chosen: also reachable from the internet through ngrok */
      tunnel: boolean
      tunnelStatus: TunnelStatus
    }

/** server/tunnel.ts — the ngrok tunnel behind "Anywhere". */
export type TunnelStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'up'; url: string }
  | { state: 'error'; error: string }

export type TerminalStatus = 'running' | 'exited'

export type TerminalSummary = {
  id: string
  title: string
  cwd: string
  /** the project the shell was opened in */
  projectId?: string
  /** the checkout the shell was opened in */
  checkoutId?: string
  /** the shell binary's basename, e.g. "zsh" */
  shell: string
  pid: number
  status: TerminalStatus
  exitCode?: number
  createdAt: number
}

export type ClientMessage =
  | {
      type: 'create_session'
      title: string
      cwd: string
      /** The project to run in. Omitted = the project at `cwd`, added as one if it isn't yet. */
      projectId?: string
      /** The checkout to run in; its folder becomes the session's `cwd`. Omitted = the project's main checkout. */
      checkoutId?: string
      /**
       * Make a new worktree of the project and run there: `git worktree add -b
       * <branch>` from the repo's default branch (an existing branch is checked
       * out instead), node_modules cloned and `.env*` copied from the main folder.
       */
      worktree?: { branch: string }
      firstMessage?: string
      /** Images attached to that first message. */
      images?: ImageAttachment[]
      /** `@` mentions in that first message, resolved against `cwd`. */
      mentions?: Mention[]
      model?: string
      effort?: EffortLevel
      permissionMode?: PermissionMode
      fastMode?: boolean
      /** The agent to run on, for the session's whole life. Omitted = 'claude'. */
      provider?: ProviderId
      /** The work item this session is dispatched for — recorded as a `dispatch` link. */
      itemId?: string
    }
  /** Switch a session's model/effort — mid-session, and for every turn after. */
  | { type: 'set_model'; sessionId: string; model?: string; effort?: EffortLevel }
  /** Turn fast mode on or off — mid-session, and for every turn after. */
  | { type: 'set_fast_mode'; sessionId: string; fastMode: boolean }
  /** Switch how much a session asks — mid-session, and for every turn after. */
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionMode }
  /** Give a session a new title. */
  | { type: 'rename_session'; sessionId: string; title: string }
  /** Pin a session to the top of the list, or unpin it. */
  | { type: 'set_pinned'; sessionId: string; pinned: boolean }
  /** Delete a session and its transcript. Irreversible — the UI confirms. */
  | { type: 'delete_session'; sessionId: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'user_message'; sessionId: string; text: string; images?: ImageAttachment[]; mentions?: Mention[] }
  | {
      type: 'permission_response'
      sessionId: string
      requestId: string
      behavior: PermissionBehavior
      /** Set only for AskUserQuestion prompts — folded into the tool's input. */
      answers?: QuestionAnswers
    }
  | { type: 'interrupt'; sessionId: string }
  /** Stop one running task — a subagent, or a shell by its task id (`stopTask`). */
  | { type: 'agent_stop'; sessionId: string; agentId: string }
  /** Let the main agent carry on while a foreground subagent keeps running. */
  | { type: 'agent_background'; sessionId: string; toolUseId: string }
  /** A message for a subagent — relayed by the main agent with SendMessage, since the SDK can't address one directly. */
  | { type: 'agent_message'; sessionId: string; relay: AgentRelay; text: string }
  /** Open a shell in `cwd` (default: the project's folder); `command` is typed in first, if given. */
  | { type: 'terminal_create'; cwd?: string; projectId?: string; checkoutId?: string; title?: string; command?: string }
  /** Keystrokes / pasted text — raw, exactly as the terminal emulator produced them. */
  | { type: 'terminal_input'; terminalId: string; data: string }
  | { type: 'terminal_resize'; terminalId: string; cols: number; rows: number }
  /** Replay the scrollback buffer to this socket, then stream. */
  | { type: 'terminal_subscribe'; terminalId: string }
  | { type: 'terminal_rename'; terminalId: string; title: string }
  /** Kill the process (if still running) and forget the terminal. */
  | { type: 'terminal_close'; terminalId: string }

export type ServerMessage =
  // hello also carries the workspace picture: which one this socket is bound
  // to, every workspace's card for the switcher, and whether first-run
  // onboarding has been completed.
  | {
      type: 'hello'
      sessions: SessionSummary[]
      workspaceId: string
      workspaces: Workspace[]
      onboarded: boolean
      terminals: TerminalSummary[]
      checkouts: Checkout[]
      /** which copy of triage this socket is talking to — the UI badges it */
      build: Build
    }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session_created'; session: SessionSummary }
  | { type: 'session_deleted'; sessionId: string }
  /**
   * `times[i]` is when `events[i]` was stored (ms epoch), so the transcript can
   * say how long a run of tool calls took. Absent for an in-memory dry run.
   */
  | { type: 'history'; sessionId: string; events: SessionEvent[]; times?: number[] }
  /** `at` is when the server saw the event (ms epoch). */
  | { type: 'session_event'; sessionId: string; event: SessionEvent; at?: number }
  | { type: 'terminals'; terminals: TerminalSummary[] }
  /** A create_session from this socket that makes a worktree, step by step — the draft shows where it's got to. */
  | { type: 'create_progress'; step: CreateStep }
  /** A create_session from this socket failed (e.g. the worktree couldn't be made) — the draft stays open to say so. */
  | { type: 'create_failed'; message: string }
  /** The workspace's checkouts changed — a worktree appeared or went, a branch moved. The whole list. */
  | { type: 'checkouts'; checkouts: Checkout[] }
  | { type: 'terminal_created'; terminal: TerminalSummary }
  /** The scrollback so far — sent once per subscribe, before live output resumes. */
  | { type: 'terminal_history'; terminalId: string; data: string }
  | { type: 'terminal_output'; terminalId: string; data: string }
  | { type: 'terminal_exit'; terminalId: string; exitCode: number }
  | { type: 'terminal_closed'; terminalId: string }
  /** The artifacts index changed (a write, a delete, or a re-index found edits) — refetch. */
  | { type: 'artifacts_changed' }
  /** A skill or agent file changed (the settings editor, or a session wrote one) — refetch. */
  | { type: 'library_changed' }
  /** A work item was created, edited or moved (by a chat, a job, another tab) — refetch the inbox. */
  | { type: 'inbox_changed' }
  /**
   * A folder's `/` command list changed — a session's subprocess discovered
   * skills mid-run, or a probe just finished. Carries the whole list because
   * the SDK's own contract is replace-don't-merge, and it is small.
   */
  | { type: 'commands_changed'; cwd: string; commands: SlashCommandInfo[] }
  /** A session's turn ended (or its repo moved) — the changes view should refetch. */
  | { type: 'session_changed'; sessionId: string }
  /** A brief job moved (queued → running → ready | failed); the item page and inbox row follow. */
  | { type: 'brief_status'; job: BriefJob }
  /** An action was recorded or settled (or the actions file changed) — refetch the Actions page, the item, the transcript's lines. */
  | { type: 'actions_changed'; sessionId?: string }
  /** A goal was created, moved, or its ledger was written — refetch the Goals list, the goal page, the Inbox count. */
  | { type: 'goals_changed'; goalId?: string }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Goals (GET /api/goals, GET /api/goals/<id>) — outcomes Junior drives across
// many sessions (.docs/goals/goals-engine.md). Domain types live in
// core/goals/types.ts; the state machine in core/goals/machine.ts.
// ---------------------------------------------------------------------------

export type {
  Gate,
  GateEvaluator,
  GateSpec,
  GateStatus,
  GateVerdict,
  Goal,
  GoalActor,
  GoalBudget,
  GoalEvent,
  GoalEventKind,
  GoalHorizon,
  GoalLogEntry,
  GoalPlan,
  GoalState,
  GoalStepState,
  GoalTurn,
  PlanStep,
  StepRole,
  StepStatus,
  StepType,
  TeamSeat,
} from '../core/goals/types.js'

/** One row of the Goals list. */
export type GoalSummary = Pick<Goal, 'id' | 'title' | 'state' | 'horizon' | 'reason' | 'sourceItemId' | 'currentStep' | 'spentUsd' | 'budget' | 'updatedAt'> & {
  turn: GoalTurn
  /** gates still open, AI and user */
  openGates: number
}

export type GoalsResponse =
  | {
      ok: true
      goals: GoalSummary[]
      /** goals whose turn is the user's — the Inbox's and the rail's count */
      waitingOnYou: number
    }
  | { ok: false; error: string }

/** A question or plan change from a goal's lead, open until the user answers it. */
export type GoalAsk =
  | { kind: 'ask'; question: string; recommended: string; evidence: string | null; options: string[] }
  | { kind: 'plan_change'; why: string; plan: GoalPlan }
  | { kind: 'other'; reason: string }

/** The goal page: the record, its run-time state, and the ledger's files as text. */
export type GoalResponse =
  | {
      ok: true
      goal: Goal
      turn: GoalTurn
      steps: GoalStepState[]
      gates: Gate[]
      /** newest last */
      events: GoalEvent[]
      plan: string
      handoff: string
      /** the latest entries of log.md, oldest first */
      log: string
      /** set after repeated ledger commit failures (decision 7) */
      ledgerWarning: string | null
      /** comments on the plan under review, since it was proposed — what send-back hands the lead */
      comments: PlanComment[]
      /** the lead session drafting the plan right now, if one is */
      leadSessionId: string | null
      /** M3: the session working the goal right now (a run lead or a worker), if one is */
      liveSession: { sessionId: string; role: StepRole; stepId: string | null } | null
      /** M3: what the goal waits on the user for — a question with Junior's recommended answer, or a plan change */
      ask: GoalAsk | null
    }
  | { ok: false; error: string }

/**
 * What a goal write did. created / existing = goal_create (existing: the key
 * was taken, nothing written); proposed / unchanged = goal_propose_plan;
 * appended / revised / unchanged = goal_log_append; written / unchanged =
 * goal_handoff_write; approved / commented / sent_back = the user's plan
 * review. `unchanged` is a repeat call that wrote nothing.
 */
export type GoalWriteOutcome =
  | 'created'
  | 'existing'
  | 'proposed'
  | 'appended'
  | 'revised'
  | 'written'
  | 'approved'
  | 'commented'
  | 'sent_back'
  | 'unchanged'
  // M3: the run loop's steering — answers, messages, edits, take over and hand back, the result
  | 'answered'
  | 'messaged'
  | 'edited'
  | 'taken_over'
  | 'handed_back'
  | 'accepted'

export type GoalWriteResponse = { ok: true; goal: Goal; outcome: GoalWriteOutcome } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// The browser pane (.docs/browser.md). The page lives in Triage.app; these are
// the daemon's routes for what sessions saw there and for the element picker.
// ---------------------------------------------------------------------------

export type BrowserShotKind = 'screenshot' | 'checkpoint' | 'compare' | 'pick'

/** One saved image: GET /api/browser/shots/<sessionId>/<n> serves its bytes. */
export type BrowserShot = {
  n: number
  file: string
  mime: string
  kind: BrowserShotKind
  url: string
  title: string
  viewport: string
  at: number
  label?: string
  note?: string
}

export type BrowserShotsResponse = { ok: true; shots: BrowserShot[] } | { ok: false; error: string }

/** POST /api/browser/pick { sessionId, uid } — an element picked in the pane, described for the composer. */
export type BrowserPickResponse =
  | { ok: true; text: string; image: string | null; shot: number | null }
  | { ok: false; error: string }

/** Matches the marker a browser tool result carries for a saved shot. */
export const BROWSER_SHOT_RE = /\[shot #(\d+)\]/g
