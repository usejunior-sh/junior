import type { SessionTeamRun } from './team-runs.js'
import type { ProviderId, SessionKind, SessionStatus } from './workspace.js'

/**
 * What the user did with one prompt. `allow_always` is `allow` plus the SDK's
 * own "don't ask again" suggestions, scoped to this session. The narrow way
 * to stop being asked, as against turning the whole session permissive.
 */
export type PermissionBehavior = 'allow' | 'allow_always' | 'deny'

/**
 * How much the session asks before acting. Mostly a subset of the SDK's own
 * `PermissionMode`, the ones that answer "how often am I interrupted", plus
 * one junior-native mode:
 *
 * - `'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'` are the SDK's,
 *   passed straight through. ('plan' and 'dontAsk' are the SDK's other two,
 *   deliberately not offered, they change what the agent does, not how much it
 *   asks.)
 * - `'gated'` is ours: reads and lookups run without asking; anything that
 *   writes, a file, the shell, or an outward connector call, still prompts.
 *   The SDK has no equivalent, so the server runs at its `'default'` and
 *   enforces the gate itself in `canUseTool` (see `ToolEffect`), which a
 *   subprocess cannot opt out of.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'gated'

/**
 * What Junior does before it starts (.docs/junior-goals-teams/modes-autonomy-goals.md),
 * separate from PermissionMode, which is how much it asks while it works:
 * - `normal`: starts right away
 * - `plan`: reads and writes a plan, edits nothing, until you approve the plan (the SDK's `plan`
 *   mode); then it codes in the same session at its permission mode. Stored on the session.
 * - `goal`: the message is a goal, Junior proposes a team run with a done-when. One message at a time.
 * - `ultracode`: Claude Code's ultracode for the whole session (`settings.ultracode`): big jobs are
 *   orchestrated as Workflow runs that fan out to many agents (.docs/ultracode.md). Stored on the session.
 */
export type SessionMode = 'normal' | 'plan' | 'goal' | 'ultracode'
export const SESSION_MODES: readonly SessionMode[] = ['normal', 'plan', 'goal', 'ultracode']
export const isSessionMode = (v: unknown): v is SessionMode => SESSION_MODES.includes(v as SessionMode)

/**
 * A tool's blast radius, as the server classifies it before deciding whether
 * `'gated'` mode lets it run unattended:
 *
 * - `read`, reads/lookups only (file reads, greps, `list_work_items`, and
 *   connector calls whose name is clearly a read). Auto-allowed under `gated`.
 * - `local-write`, side effects confined to this machine (file edits, shell,
 *   the junior inbox's own writes).
 * - `external-write`, a call that reaches outside this machine (post to
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
 * at premium pricing. Off by default and chosen per session, speed you opt
 * into for a turn you are waiting on, not a setting to forget you left on.
 *
 * Two facts, deliberately kept apart: what the user asked for (`fastMode` on
 * the session) and what the subprocess reports it can actually do. The SDK
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
  /** the session's handle (`/rename`), when it has one */
  name?: string
  /** the session that started this one, when one did */
  startedBy?: string
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
  /** Plan mode: reading and planning until you approve the plan. Absent = not planning. */
  planning?: boolean
  /** Ultracode: big jobs run as multi-agent Workflow runs. Absent = off. */
  ultracode?: boolean
  /** Workflow runs still going in the background, after the turn that launched them ended. Absent = none. */
  workflows?: number
  /** The agent this session runs on. Absent = 'claude'. */
  provider?: ProviderId
  /** Pinned to the top of the sidebar. Absent = not pinned. */
  pinned?: boolean
  /** The checkout (folder of the project) the session runs in, stored, never derived from `cwd`. Look it up in `checkouts`. */
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

/**
 * File checkpoints (rewind_files): a Claude chat keeps a copy of each file
 * before its turn edits it, keyed by the user message that started the turn
 * (`messageId` on a `local_user` event). Rewinding puts the files back to how
 * they were before that message. The conversation is not rewound, only files.
 */

/** A message id the agent keys checkpoints on: a UUID, the SDK's own user message id. */
export const REWIND_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a rewind_files request came back with. `ok` false = nothing changed on
 * disk, and `error` says why in words the user can read. On a dry run, `ok`
 * means the rewind would work, and the counts say what it would do; on a real
 * one, it means it ran.
 */
export type RewindResult = {
  sessionId: string
  messageId: string
  dryRun: boolean
  ok: boolean
  error?: string
  /** files the rewind changes (dry run) or changed (real), absolute paths */
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  /** real rewinds only: linked or unreadable files left alone, for safety */
  skippedLinks?: number
}
