#!/usr/bin/env node
/**
 * triage-dev POC server
 *
 * Serves the web UI on :5178 and drives the locally installed Claude Code
 * via @anthropic-ai/claude-agent-sdk.
 *
 * Sessions are persisted to SQLite (core/store): the row + an append-only
 * event log (the same events the UI renders; stream deltas excluded). The
 * Claude subprocess itself is ephemeral — a session with no live subprocess
 * is revived on the next user message via the SDK's `resume`, keyed by the
 * sdk_session_id captured from the init message. The agent's own memory of
 * the conversation lives in ~/.claude's transcript, not here; our event log
 * is for rendering, never for re-feeding the model.
 *
 * Workspaces (.docs/workspaces.md): one daemon, N isolated workspaces. Each
 * workspace has its own SQLite file, its own Claude auth backend (spawn env),
 * and its own runtime state — every map and cache that used to be a module
 * singleton lives on a WorkspaceRuntime. Every HTTP request and WS connection
 * is bound to exactly one workspace (?workspace= param, else the triage_ws
 * cookie, else the default), and broadcasts stay inside that boundary.
 *
 * The wire format lives in shared/protocol.ts and is shared with the frontend.
 */
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readFileSync, statSync } from 'node:fs'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { claude } from './providers/claude.js'
import { shellOutput } from './shell-output.js'
import { DEFAULT_PROVIDER, providerFor } from './providers/registry.js'
import { requireVeto, vetoRefusal } from './providers/capabilities.js'
import type {
  AgentSession,
  FastModeVerdict,
  McpServers,
  McpStatus,
  PermissionResult,
  PermissionUpdate,
  Provider,
  ProviderId,
  RunSpec as AgentRunSpec,
  ToolCall,
  ToolVeto,
  UserTurn,
} from './providers/types.js'
import { z } from 'zod'
import { detectEditors, openFolderIn } from './editors.js'
import { checkRemoval, createWorktree, defaultBranch, prepareWorktree, recreateWorktree, removeWorktree, syncProjectCheckouts } from './worktrees.js'
import { branchFromTitle } from '../shared/branch.js'
import { aheadOf, filePatch, repoRoot, snapshotTree, treeDiff, treePatch, treeStat, worktreeChanges, worktreePatch, type TreeChange } from './git.js'
import type {
  ActionMoveRequest,
  ActionMoveResponse,
  ActionOverrideRequest,
  ActionOverrideResponse,
  ActionsPendingResponse,
  ActionsResponse,
  ActionVerb,
  ActionView,
  AgentRelay,
  JuniorDay,
  JuniorDayResponse,
  JuniorSeen,
  PersonaResponse,
  ScoredItem,
  TodayMatchResponse,
  TodayResponse,
  ClientMessage,
  RemoteStatus,
  Connector,
  ConnectorScope,
  ConnectorsResponse,
  EffortLevel,
  FastModeDisabledReason,
  FastModeState,
  ModelOption,
  ModelsResponse,
  SlashCommandInfo,
  CommandsResponse,
  PermissionBehavior,
  PermissionMode,
  QuestionAnswers,
  SdkMessage,
  ServerMessage,
  SessionEvent,
  SessionStatus,
  SessionSummary,
  ImageAttachment,
  ToolEffect,
  Workspace,
  Artifact,
  ArtifactAuthor,
  ArtifactContentResponse,
  ArtifactInput,
  ArtifactResponse,
  ArtifactWithLinks,
  ArtifactsResponse,
  Link,
  LinkKind,
  LinkRole,
  LinksResponse,
  BriefJob,
  BriefJobsResponse,
  BriefResponse,
  BriefView,
  DispatchPreview,
  DispatchPreviewResponse,
  ItemImage,
  ItemImageEdit,
  ItemImagesResponse,
  PlaybookResponse,
  PlaybooksResponse,
  SessionKind,
  SettingsResponse,
  WorkspaceSettings,
  ChangedFile,
  SessionChanges,
  SessionChangesResponse,
  SessionDiffResponse,
  SessionTurnSummary,
  Checkout,
  CheckoutChanges,
  CreateStep,
  EditorsResponse,
  OpenCheckoutResponse,
  RemovalCheckResponse,
  RemoveCheckoutResponse,
  ProjectChanges,
  ProjectFileResponse,
  SaveProjectFileResponse,
  WorkingChangesResponse,
  WorkingDiffResponse,
  BrowserPickResponse,
  BrowserShotsResponse,
  RawBlock,
  ShellOutputResponse,
} from '../shared/protocol.js'
import {
  MAX_IMAGES_PER_ITEM,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  MAX_MENTIONS_PER_MESSAGE,
  PROVIDER_IDS,
  USAGE_WINDOWS,
  isArtifactAuthor,
  isEffortLevel,
  isImageMediaType,
  isProviderId,
  isLinkKind,
  isLinkRole,
  isMentionKind,
  mentionToken,
} from '../shared/protocol.js'
import type {
  ActivityResponse,
  FileSearchResponse,
  Mention,
  ResolvedMention,
  InboxAlert,
  InboxResponse,
  InboxSnapshot,
  ItemDetail,
  ItemDetailResponse,
  ItemEventsResponse,
  ItemListResponse,
  ItemStateResponse,
  ItemUrlsResponse,
  LogLevel,
  LogsResponse,
  UsageResponse,
  SessionsUsageResponse,
  SessionSpend,
  UsageModelSlice,
  ManualItemInput,
  SystemResponse,
  SystemStatus,
  ManualItemResponse,
  PickFolderResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  SessionContext,
  SessionContextResponse,
  UpsertResponse,
  JobDraftResponse,
  JobPreviewStartResponse,
  JobPreviewStatusResponse,
  JobsResponse,
  JobRunsResponse,
  JobFileReference,
  JobFileResponse,
  WorkItem,
  WorkspaceResponse,
  WorkspacesResponse,
  WorkspaceVerifyResponse,
  WorkspaceProvider,
  ProviderStatus,
  ProvidersStatusResponse,
  ProviderVerifyResponse,
  SessionTeamRun,
  TeamLibraryResponse,
  LibraryFileResponse,
  LibraryEntry,
  LibraryListResponse,
  LibrarySource,
  TeamPickerResponse,
  TeamRunFile,
  TeamRunFileResponse,
  TeamRunFilesResponse,
  TeamRunFolderFile,
  TeamGoalSummary,
  TeamGoalsResponse,
  TeamRunFolderResponse,
  TeamRunResponse,
  TeamRunView,
  AgentCan,
} from '../shared/protocol.js'
import { frameAgentRelay } from '../core/agents/relay.js'
import { TeamLibrary, agentFrom, detectChecks, frameTeamMessage, isCheckCommand, isLibraryName } from './teams.js'
import { LEAD, parseRecipe, recipeAgents, serializeRecipe, taskLoop, type RecipeStep, type TeamRecipe } from '../core/teams/recipe.js'
import { runFiles } from '../core/teams/files.js'
import {
  MAX_RUN_BUDGET_USD,
  acceptGoal,
  answerQuestion,
  approve,
  askYou,
  goalFrom,
  goalOverdue,
  goalVerdict,
  pause as pauseRun,
  reopenGoal,
  unstick,
  wake,
  wakeDue,
  cardFrom,
  checksDone,
  continueGate,
  editTasks,
  normalizeRun,
  planMessage,
  proposeRevision,
  recipeFromRun,
  resume,
  runSpent,
  settleRevision,
  split,
  backfillRuns,
  runStatus,
  STEP_MESSAGE,
  stampRun,
  submit,
  turnEnded,
  workerAppend,
  workerById,
  type Action as TeamAction,
  type CheckResult,
  type DiffScope,
  type Submission,
  type TeamRun,
  type Worker,
  type WorkerRun,
} from '../core/teams/engine.js'
import type { StoredTurn } from '../core/store/types.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import { ActionTracker, applyActionOps, joinHeldCall, recordFor, type ActionOp, type TrackContext } from '../core/actions/track.js'
import { READ_VERBS, WRITE_VERBS, overrideEntries, overriddenOff, serverOf, sortCall, withRowOverride, wordsOf, type ToolHints } from '../core/actions/sort.js'
import { countLine, countSince } from '../core/actions/count.js'
import { destructiveCommand, gitReadCommand, readOnlyCommand } from '../core/actions/commands.js'
import { isActionKind, type ActionRecord } from '../core/actions/types.js'
import {
  DispatchFence,
  TOOL_SEARCH,
  canonJson,
  connectorState,
  dispatchDisallowed,
  dispatchOutcome,
  dispatchPrompt,
  dryRunDecision,
  dueToExpire,
  dueToSend,
  heldEntry,
  heldRecord,
  holdable,
  isArgsObject,
  move,
  queuedMessage,
  sendBackMessage,
  sendDelay,
  type ActionMove,
  type DispatchTrace,
} from '../core/actions/queue.js'
import { actionTitle, countedText } from '../core/actions/describe.js'
import { resultText } from '../core/actions/link.js'
import { shortActionId } from '../core/actions/view.js'
import { ActionsFile } from './actions-file.js'
import type { Store, StoredSession, UpsertOutcome, UpsertResult } from '../core/store/types.js'
import { buildInbox } from '../core/work/inbox.js'
import { BASE, rank } from '../core/work/score.js'
import { LABEL_ORDER, isLabel, type Label } from '../core/work/labels.js'
import { dueInput, parseDue, startOfDay } from '../core/work/due.js'
import { flowOf, isStage, isTurn, type FlowOverride, type FlowSignals, type ItemFlow, type SessionSignal } from '../core/work/flow.js'
import { ARCHIVE_AFTER_DAYS, shouldArchive } from '../core/work/fade.js'
import { canonicalizeRef, canonicalizeRefs, linkByRefs } from '../core/work/link.js'
import type { ItemStatus } from '../core/work/state.js'
import type { Provenance, WorkItem as CoreWorkItem, WorkSource } from '../core/work/types.js'
import { fetchGitHub, fetchGitHubClosed, ghLogin, listAffiliatedRepos } from '../core/sources/github.js'
import {
  draftJob,
  permalinkId,
  safeWhen,
} from '../core/sources/slack.js'
import { scanUsage } from '../core/usage/ledger.js'
import { summarize as summarizeUsage, summarizeBySession, summarizeModels } from '../core/usage/summary.js'
import { budgetFor, decide, describeLateness, humanSpan, isCatchUpSpec, isOverdue, localMidnight, lookbackMs, missedSlots, parseCatchUp, scheduleOf, type SkipReason } from '../core/job/schedule.js'
import { cronFromCadence, isValidCron } from '../core/job/cron.js'
import {
  DEFAULT_JOB_TIMEOUT_MS,
  MAX_JOB_TIMEOUT_MS,
  JOB_NOTIFY,
  JOB_OUTPUTS,
  type NewJob,
  type Job,
  type JobBrief,
  type JobCadence,
  type JobConnector,
  type JobNotify,
  type JobOutput,
  type JobPreviewResult,
  type JobPreviewRow,
  type JobRunStatus,
  type JobRunTrigger,
} from '../core/job/types.js'
import { composeRunPrompt, MAX_ROWS_PER_RUN } from '../core/job/connectors.js'
import { JobFiles, checkGrants, checkLibrary, renameLegacyFolders, type JobLibrary, grantsFromLines, parseJobFile, serializeJobFile, starterJobFile, withKey, type JobFileSpec } from './job-files.js'
import {
  grantLabel,
  grantsFrom,
  grantsFromLegacy,
  mcpGrants,
  mcpToolName,
  presetGrant,
  RESERVED_SERVER,
  runAllowedTools,
  runBaseTools,
  serverLabel,
  type LegacyConnector,
  type JobToolGrant,
} from '../core/job/tools.js'
import { fenceDecision, fenceFor } from '../core/job/fence.js'
import { roleFenceDecision, type RoleFence } from '../core/goals/fence.js'
import { blockFromRecipe } from '../core/goals/blocks.js'
import { HardStop, settleRunStatus, untilStopped } from '../core/goals/run-guard.js'
import { power, sleepWatch, startSleepWatch } from './power.js'
import { buildInfo, clearState, pkgVersion, TRIAGE_DIR, writeState } from './state.js'
import { initLogFile, log, logFilePath, logSubsystems, recentLogs } from './log.js'
import {
  apiKeyHint,
  dbFileFor,
  ensureWorkspaceDirs,
  envOverridesFor,
  authOf,
  isConnected,
  loadRegistry,
  loginCommandFor,
  providerAuthBackend,
  saveRegistry,
  slugify,
  spawnEnvFor,
  toAuthBackend,
  workspaceAuthDir,
  workspaceDir,
  writeApiKey,
  type WorkspaceMeta,
} from './workspaces.js'
import { TerminalManager } from './terminals.js'
import { NgrokTunnel } from './tunnel.js'
import {
  accessOf,
  bonjourName,
  codesAllowed,
  lanAddresses,
  loadRemote,
  newToken,
  pairCookie,
  pairPageHtml,
  isLoopbackAddress,
  livePairCode,
  tryPairCode,
  type PairCode,
  sameOrigin,
  saveRemote,
  tokenMatches,
  type Access,
} from './remote.js'
import { launchAgentInstalled } from './launchd.js'
import { applyImageEdits, itemImageAttachments, readItemImage } from './itemImages.js'
import { BrowserHub, describePicked, makeBrowserMcp, renderVerification, ShotStore } from './browser.js'
import { browserCallAllowed } from '../core/browser/policy.js'
import { BROWSER_HOST_PATH } from '../core/browser/wire.js'
import { FileIndexes, readProjectFile, resolveFileMention, writeProjectFile } from './files.js'
import { ArtifactIndex, slug } from './artifacts.js'
import { GoalLedger } from '../core/goals/ledger.js'
import {
  bootGoalRun,
  goalActionHeldOp,
  GoalHeldIndex,
  goalLeadStartedOp,
  goalLeadSettledOp,
  goalMessageOp,
  goalOfSession,
  goalGateSweepOp,
  goalWatchPrsOp,
  ghPrSource,
  goalsRoute,
  goalSessionEndedOp,
  goalSessionMcpTools,
  goalMaxTeam,
  GOALS_MAX_TEAM_KEY,
  goalWorkerMessageOp,
  loadGoalHeld,
  onGoalEvent,
  pumpGoals,
  replayGoalEvents,
  type GoalDeps,
  type GateChecker,
  type GoalEngine,
  type GoalSessionTag,
  type StartSpec,
} from './goals.js'
import { GOAL_SESSION_TIMEOUT_MS, LEAD_RUN_APPEND, ROLE_AGENT, roleWrites, workerAppend as goalWorkerAppend } from '../core/goals/run.js'
import { leadDraftPrompt, LEAD_DRAFT_APPEND, type LeadWake } from '../core/goals/review.js'
import { DEFAULT_GOAL_MODELS, GATE_SWEEP_INTERVAL_MS, MAX_GOAL_TEAM, goalDir, type GateVerdict, type Goal, type GoalEvent } from '../core/goals/types.js'
import { WATCH_TICK_MS } from '../core/goals/shepherd.js'
import { GATE_SERVER, GATE_TOOL_SEARCH, GATE_VERDICT_FULL, GATE_VERDICT_TOOL, gateCheckPrompt, gateFenceDecision, gateReadTools, gateServers, verdictFrom } from '../core/goals/gates.js'
import { WORKSPACE_PLUGIN, createLibraryEntry, ensureWorkspacePlugin, libraryRoots, locate as locateLibrary, libraryTargets, listLibrary, readLibraryFile, removeLibraryItem, writeLibraryFile, type LibraryRoot } from './library.js'
import { TRIAGE_MCP_INSTRUCTIONS, triageSessionAppend } from '../shared/triageContext.js'
import { DEFAULT_PERSONA, personaAppend, personaFrom, type Persona } from '../core/junior/persona.js'
import { needsRows, type SendsSource, type TeamSource } from '../core/junior/needs.js'
import { pickNow, todoProgress, type NowCandidate, type TodoProgress } from '../core/junior/now.js'
import { briefFacts, type FactRun } from '../core/junior/facts.js'
import { morningBrief } from '../core/junior/morning.js'
import { canDoFill, firstOffers, type OfferItem } from '../core/junior/offers.js'
import { carryOver, dayKey, draftPlan, isOwner, matchItem, planRows, shortRef, type AddedBy, type Owner, type PlanItem, type PlanRow, type PlanSession, type PlanView } from '../core/junior/today.js'
import { AGENTS_ARG, SKILLS_ARG, callTool as callMcpTool, PROTOCOL_VERSION as MCP_PROTOCOL_VERSION, TOOLS as MCP_TOOLS } from '../core/mcp/tools.js'
import {
  BRIEF_SYSTEM_APPEND,
  briefRelPath,
  composeBriefPrompt,
  isPlaybookName,
  listPlaybooks,
  readDispatchTemplate,
  readPlaybook,
  renderTemplate,
  seedDispatchTemplates,
  seedPlaybooks,
  writeDispatchTemplate,
  writePlaybook,
} from './briefs.js'

const PORT = Number(process.env.PORT || 5178)
/** Phone access (server/remote.ts): off until switched on in Settings → Phone. */
let remote = loadRemote()
/** The 6-digit code Settings → Phone shows; memory only — a restart just mints another. */
let pairCode: PairCode | null = null
/** Phone access from anywhere — the user's ngrok, run while access and "Anywhere" are both on. */
const tunnel = new NgrokTunnel((): void => {
  const s = tunnel.status
  if (s.state === 'up') log('info', 'remote', `tunnel up at ${s.url}`)
  else if (s.state === 'error') log('warn', 'remote', `tunnel failed: ${s.error}`)
})
function syncTunnel() {
  if (remote.enabled && remote.tunnel) tunnel.start(PORT)
  else tunnel.stop()
}
const VERSION = pkgVersion()
// Which copy of triage this is (checkout / unreleased build / release) — fixed
// for the life of the process, reported everywhere so every surface agrees.
const BUILD = buildInfo()
const SERVER_STARTED = Date.now()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/**
 * Vite build output — see vite.config.ts. Absent until `npm run build`.
 * Two layouts: from source this file is <repo>/server/index.ts and the build
 * is <repo>/dist/web; in the published package it is <pkg>/dist/server/index.js
 * sitting next to <pkg>/dist/web.
 */
const WEB_DIR =
  path.basename(path.dirname(__dirname)) === 'dist'
    ? path.join(__dirname, '..', 'web')
    : path.join(__dirname, '..', 'dist', 'web')

const pExecFile = promisify(execFile)
const pExec = promisify(exec)

// ---------------------------------------------------------------------------
// Async queue: lets us push user messages into a live session's input.
// ---------------------------------------------------------------------------
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => this.waiters.push(res))
      },
    }
  }
}

/**
 * A permission rule the SDK suggested, pinned to this session. Every variant
 * of PermissionUpdate carries a `destination`, so this is a blanket rewrite —
 * nothing an "Always allow" click produces may reach a settings file.
 */
const sessionScoped = (u: PermissionUpdate): PermissionUpdate => ({ ...u, destination: 'session' })

// ---------------------------------------------------------------------------
// Effect classifier — the heart of 'gated' mode.
//
// Before a tool runs, we place it on a blast-radius scale (read / local-write /
// external-write) so 'gated' can wave through reads and still stop on anything
// that writes. Two rules keep it safe:
//   1. Unknown ⇒ write. Only a call we can *prove* is a read runs unattended;
//      everything else prompts, so a newly connected tool is gated by default.
//   2. Any write verb wins over any read verb. A connector call is a read only
//      when its name signals a read and signals no write — so a mutating tool
//      can never sneak through on a "get"/"list" substring.
// Classification is by tool *name*, per tool, never per MCP server: Slack read
// and Slack send share one connector but must land on opposite sides.
// ---------------------------------------------------------------------------

/** Built-in tools whose only effect is reading. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])
/** Our own MCP tools that only read (the inbox, the artifacts index) — never prompt for these. */
/** triage's own team tools: they record and route, and the team card is the approval — never a prompt. */
const TEAM_TOOLS = new Set([
  'mcp__triage__list_teams',
  'mcp__triage__propose_team',
  'mcp__triage__split_step',
  'mcp__triage__revise_plan',
  'mcp__triage__submit_step',
  'mcp__triage__goal_verdict',
  'mcp__triage__goal_unstick',
  'mcp__triage__ask_you',
  'mcp__team__submit_step',
])
const TRIAGE_READ_TOOLS = new Set([
  'mcp__triage__list_work_items',
  'mcp__triage__get_work_item',
  'mcp__triage__get_session_context',
  'mcp__triage__get_workspace',
  'mcp__triage__list_artifacts',
  'mcp__triage__read_artifact',
  'mcp__triage__goal_get',
  'mcp__triage__goal_list',
  'mcp__triage__get_today',
])

// Verb tokens that mark a connector call's intent: READ_VERBS / WRITE_VERBS
// and wordsOf live in core/actions/sort.ts, which sorts outbound actions by
// the same words, so the prompt's effect and the Actions page never disagree.

function classifyEffect(toolName: string): ToolEffect {
  // Our own inbox: reading it is harmless; every other triage tool writes local
  // SQLite (create/edit/upsert/resolve).
  if (TRIAGE_READ_TOOLS.has(toolName)) return 'read'
  if (toolName.startsWith('mcp__triage__')) return 'local-write'

  if (READ_TOOLS.has(toolName)) return 'read'
  // TodoWrite is the session's own scratch list — no effect past this session.
  if (toolName === 'TodoWrite') return 'read'

  // Connector (MCP) tools reach outside this machine unless they are plainly a
  // read. `mcp__<server>__<leaf>` — classify by the leaf's verbs (rule 2).
  if (toolName.startsWith('mcp__')) {
    const words = wordsOf(toolName.slice(toolName.lastIndexOf('__') + 2))
    const isRead = words.some((w) => READ_VERBS.has(w)) && !words.some((w) => WRITE_VERBS.has(w))
    return isRead ? 'read' : 'external-write'
  }

  // Everything else built in — Write/Edit/MultiEdit/NotebookEdit and Bash —
  // touches this machine. Bash can be read-only, but its command cannot be
  // classified safely from here, so it is a write and asks.
  return 'local-write'
}

// ---------------------------------------------------------------------------
// Workspace runtimes — everything that used to be a module singleton, one per
// workspace. Physical isolation: each runtime owns its own store (its own
// SQLite file), its own live sessions and WS clients, and its own caches, so
// nothing can bleed across the boundary by construction.
// ---------------------------------------------------------------------------
type ConnectorProbe = { probedAt: number; connectors: Connector[] }
type ModelProbe = { probedAt: number; models: ModelOption[] }
type CommandProbe = { probedAt: number; commands: SlashCommandInfo[] }

const registry = loadRegistry()

class WorkspaceRuntime {
  readonly store: Store
  /** full spawn env for this workspace's auth backend; undefined = inherit */
  env: Record<string, string> | undefined

  // session registry: every session lives in the store; a subset is live
  readonly rows = new Map<string, StoredSession>()
  readonly live = new Map<string, LiveSession>()
  /** a project's folders, main and worktrees, by id — the rows, kept in step by syncCheckouts */
  readonly checkouts = new Map<string, Checkout>()
  /** checkout discovery runs one at a time; a call while one runs queues exactly one more */
  checkoutSyncRunning: Promise<void> | null = null
  checkoutSyncQueued: Promise<void> | null = null
  /** WS clients bound to THIS workspace — broadcasts never cross the boundary */
  readonly clients = new Set<WebSocket>()

  // inbox
  inboxCache: InboxSnapshot | null = null
  /** dispatched sessions' status, last seen (noteDispatchedSessions); null until the first look */
  dispatchFingerprint: string | null = null
  inboxInFlight: Promise<InboxSnapshot> | null = null
  /** last GitHub source error, surfaced as an inbox notice until the next clean sync */
  githubNotice: string | null = null
  githubReconcileAt = 0
  githubReconcileInFlight: Promise<void> | null = null

  // job runs
  readonly runQueue: QueuedRun[] = []
  readonly runningJobs = new Set<string>()
  /** in-flight and recently finished dry runs, by ephemeral session id (never persisted) */
  readonly previews = new Map<string, JobPreview>()
  activeRuns = 0

  // probes
  connectorCache: ConnectorProbe | null = null
  connectorInFlight: Promise<ConnectorProbe> | null = null
  /** connector probes per project folder (its project + local MCP servers), for the job picker */
  readonly folderProbes = new Map<string, ConnectorProbe>()
  readonly folderProbeInFlight = new Map<string, Promise<ConnectorProbe>>()
  /** model catalogs per agent: the workspace's own at boot, another's (Codex) on first ask */
  readonly modelCache = new Map<ProviderId, ModelProbe>()
  readonly modelInFlight = new Map<ProviderId, Promise<ModelProbe>>()
  /** `/` command lists, keyed by folder — a project's own commands live under it */
  readonly commandCache = new Map<string, CommandProbe>()
  readonly commandInFlight = new Map<string, Promise<CommandProbe>>()
  /** commands this CLI binds to a real terminal; learned from a session's init */
  terminalCommands: string[] | null = null
  affiliatedCache: { at: number; repos: string[] } | null = null

  /**
   * The in-process triage MCP server a chat session gets. One instance per
   * session, never shared: the SDK connects each instance to exactly one
   * transport, so a second concurrent session handed the same object loses
   * its connect and lands `status: "failed"` in system/init — a chat with no
   * mcp__triage__* tools whenever another session in the workspace is live.
   */
  readonly triageMcp: () => ReturnType<typeof createSdkMcpServer>
  /** Junior's persona here (core/junior/persona.ts): loaded at boot, replaced on every save */
  persona: Persona = DEFAULT_PERSONA
  /** the coding agent this workspace's sessions, runs and probes go through (its meta names it) */
  get provider(): Provider {
    return providerFor(this.meta.provider)
  }
  /** PTY shells opened from the web UI — run with this workspace's spawn env */
  readonly terminals: TerminalManager
  /** per-folder file listings behind the composer's `@` picker */
  readonly files = new FileIndexes()
  /** the workspace's markdown artifacts, indexed from its artifacts folder (.docs/next-version.md) */
  readonly artifacts: ArtifactIndex
  /** goals (server/goals.ts): their ledger folders in the artifacts repo, and what every goal op needs */
  readonly goalLedger: GoalLedger
  readonly goalDeps: GoalDeps
  /** what sessions saw in the browser pane: screenshots, checkpoints, diffs (.docs/browser.md) */
  readonly shots: ShotStore
  /** playbooks and dispatch templates — the two prose-customisable stages, as files */
  readonly playbookDir: string
  readonly dispatchDir: string
  /** screenshots attached to work items — bytes on disk, refs on the item */
  readonly attachmentsDir: string

  // brief runs (.docs/next-version.md, phase 2): one at a time per workspace
  briefActive: string | null = null
  briefPumping = false
  readonly briefTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly briefExtras = new Map<string, SessionExtras>()
  /** goal id → its drafting lead while one runs (startGoalLead) */
  readonly goalLeads = new Map<string, GoalLead>()
  /** M3: the sessions the goal run loop started (run leads and workers), by session id */
  readonly goalRuns = new Map<string, GoalRun>()
  /** M3: actions a goal's workers queued, across sessions and restarts (server/goals.ts GoalHeldIndex) */
  readonly goalHeld = new GoalHeldIndex()
  /** jobs whose run has called write_brief at least once */
  readonly briefWrote = new Set<string>()
  /** session id → the work item it was dispatched for or briefs (mirrors `links`) */
  readonly sessionItem = new Map<string, string>()

  // Teams (server/teams.ts): agents and recipes are files; runs persist under `team_runs`.
  readonly teamLibrary: TeamLibrary
  /** the workspace's own skills and agents — a local plugin every chat session loads (server/library.ts) */
  readonly libraryDir: string
  // Jobs are files (server/job-files.ts); rows hold their state.
  readonly jobFiles: JobFiles
  /** what the last file sync saw — files, projects, probes; unchanged = nothing to do */
  jobSyncSig = ''
  /** syncs run one at a time: the tick and an API call can't interleave */
  jobSync: Promise<void> = Promise.resolve()
  readonly teamRuns = new Map<string, TeamRun>()
  /** session id → the run it leads or works on, mirrored from `teamRuns` */
  readonly sessionTeam = new Map<string, string>()
  /** run id → the tail of its action chain (withTeamRun) */
  readonly teamLocks = new Map<string, Promise<unknown>>()
  /** a goal lead's verdict or unstick, checked when it called the tool and carried out when its turn ends */
  readonly goalDecisions = new Map<string, (run: TeamRun) => TeamAction[]>()
  /** sessions whose next spawn starts a fresh Claude session (a checker's clean context) */
  readonly freshNext = new Set<string>()

  // Outbound actions (core/actions): the file that says what counts, and one
  // tracker per session folding its events into records as they persist.
  readonly actionsFile: ActionsFile
  readonly actionTrackers = new Map<string, ActionTracker>()
  /** action writes run one at a time, in event order — a settle never beats its attempt */
  actionChain: Promise<void> = Promise.resolve()
  /** a broadcast of `actions_changed` is pending (coalesced per tick) */
  actionsDirty: Set<string> | null = null
  /** approved actions' send timers, by action id (the minute tick catches any a restart lost) */
  readonly actionTimers = new Map<string, NodeJS.Timeout>()
  /** held calls still waiting, by session + tool + args — an agent retrying the same call hears the same id */
  readonly heldCalls = new Map<string, string>()
  /** actions whose dispatch run is out now */
  readonly dispatching = new Set<string>()

  // Session changes (.docs/session-diff-variations.md): sessions in one folder
  // share a working tree, so "what did *this* session change" is reconstructed
  // from the git trees either side of each of its turns.
  /** session id → its repo root, or null when its folder is not a repo (cached) */
  readonly repoRoots = new Map<string, string | null>()
  /** session id → the turn currently running, for the pre-tree and tool paths */
  readonly openTurns = new Map<string, OpenTurn>()
  /** `<sessionId>:<seq>` → that turn's file delta. Finished turns are immutable. */
  readonly turnDeltas = new Map<string, TreeChange[]>()

  constructor(public meta: WorkspaceMeta) {
    try {
      renameLegacyFolders(workspaceDir(meta.id))
    } catch (err) {
      log('error', 'job', `could not move a workspace folder to its new name: ${errText(err)}`, { workspace: meta.id })
    }
    this.store = openSqliteStore(dbFileFor(meta.id, registry.defaultId))
    this.env = spawnEnvFor(meta)
    this.artifacts = new ArtifactIndex(path.join(workspaceDir(meta.id), 'artifacts'), this.store, () =>
      broadcast(this, { type: 'artifacts_changed' }),
    )
    void this.artifacts.ensure()
    this.goalLedger = new GoalLedger(this.artifacts.root)
    this.goalDeps = {
      store: this.store,
      ledger: this.goalLedger,
      now: Date.now,
      defaultProjectId: async () => (await defaultProject(this))?.id ?? null,
      changed: (goalId) => {
        broadcast(this, { type: 'goals_changed', goalId })
        // A goal's state is its item's flow (flowSignals): the Inbox reads it again.
        invalidateInbox(this)
      },
      // Plan review reacts the moment its event is written (server/goals.ts onGoalEvent) — no polling.
      emit: (ev) =>
        void onGoalEvent(this.goalDeps, goalEngineFor(this), ev).catch((err) =>
          log('error', 'goals', `event ${ev.kind} on ${ev.goalId}: ${errText(err)}`, { workspace: meta.id }),
        ),
      // A goal made in chat lives under a new manual item, like a team proposed from one.
      itemFor: (goal) =>
        createManualOp(this, { title: goal.title.slice(0, 120), description: `Goal — done when: ${goal.doneWhen}`, ...(goal.projectId ? { projectId: goal.projectId } : {}) }),
      // M6: the workspace's team recipes are the workflow blocks a plan may name.
      blocks: async () => (await this.teamLibrary.list()).teams.flatMap((t) => (t.recipe ? [blockFromRecipe(t.name, t.recipe)] : [])),
    }
    this.playbookDir = path.join(workspaceDir(meta.id), 'playbooks')
    this.shots = new ShotStore(path.join(workspaceDir(meta.id), 'browser'))
    this.dispatchDir = path.join(workspaceDir(meta.id), 'dispatch')
    this.attachmentsDir = path.join(workspaceDir(meta.id), 'attachments')
    this.teamLibrary = new TeamLibrary(workspaceDir(meta.id))
    this.libraryDir = path.join(workspaceDir(meta.id), 'library')
    void ensureWorkspacePlugin(this.libraryDir).catch((err) => log('warn', 'library', `could not set up ${this.libraryDir}: ${errText(err)}`))
    this.jobFiles = new JobFiles(workspaceDir(meta.id))
    this.actionsFile = new ActionsFile(workspaceDir(meta.id))
    this.triageMcp = () => makeTriageMcp(this)
    this.terminals = new TerminalManager(
      (msg) => broadcast(this, msg),
      (level, msg) => log(level, 'terminal', msg, { workspace: meta.id }),
    )
  }

  /** Re-resolve the spawn env after an auth-backend or key change. */
  refreshEnv() {
    this.env = spawnEnvFor(this.meta)
  }

  /**
   * The spawn env for a session on `provider`: the primary's is `env`; any
   * other agent resolves its own connection's auth each spawn, so a change
   * to it needs no cache to go stale.
   */
  envFor(provider: ProviderId): Record<string, string> | undefined {
    return provider === this.meta.provider ? this.env : spawnEnvFor(this.meta, provider)
  }

  /** each connected agent's account, read live and kept a short while (GET /api/providers) */
  providerStatus: { at: number; providers: ProviderStatus[] } | null = null
  providerStatusInFlight: Promise<ProviderStatus[]> | null = null
}

const runtimes = new Map<string, WorkspaceRuntime>()

/**
 * The browser pane's host link (.docs/browser.md): Triage.app's main process,
 * when it is open. Daemon-wide — the app is one per machine — while each
 * session's tools and evidence stay in its own workspace.
 */
const browserHub = new BrowserHub()
const browserMcpFor = (rt: WorkspaceRuntime, row: StoredSession) =>
  makeBrowserMcp({ hub: browserHub, shots: rt.shots, sessionId: row.id, projectRoot: row.cwd })

const defaultRuntime = (): WorkspaceRuntime => runtimes.get(registry.defaultId)!

// Daemon-wide logs (one process, one log stream); workspace ids ride in fields.
initLogFile(path.join(TRIAGE_DIR, 'logs'))

/**
 * Spawn-time extras for special-purpose sessions (briefs): text appended to
 * Claude Code's own system prompt (it survives `resume`), and MCP servers
 * beyond the workspace's triage server.
 */
type SessionExtras = {
  systemAppend?: string
  mcp?: Record<string, ReturnType<typeof createSdkMcpServer>>
  /** tools the subprocess never gets (a team worker's policy) */
  disallowedTools?: string[]
  /** extra inline (flag-layer) settings, e.g. a team worker's compaction window */
  settings?: Record<string, unknown>
  /** hard stop for this subprocess: the SDK ends the query past it (a team's remaining budget) */
  maxBudgetUsd?: number
  /** the only built-in tools the subprocess gets (a team worker's lean toolset) */
  tools?: string[]
  /** load only the MCP servers passed here — none of the user's other connectors or plugins */
  strictMcpConfig?: boolean
  /** plain MCP server configs passed through (e.g. the user's chrome-devtools for a browser-allowed agent) */
  externalMcp?: Record<string, Record<string, unknown>>
}

/**
 * Tools a headless brief session never gets, whatever it asks (belt to the
 * gate's braces). triage's own writes are hidden too, not just denied: a brief
 * that can see update_artifact reaches for it to revise itself, and the brief's
 * one write is write_brief.
 */
const BRIEF_DISALLOWED_TOOLS = [
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion',
  ...['create_work_item', 'edit_work_item', 'upsert_work_item', 'resolve_work_item', 'draft_job', 'try_job',
    'write_artifact', 'update_artifact', 'link_artifact',
    'propose_team', 'split_step', 'revise_plan', 'submit_step', 'goal_verdict', 'goal_unstick', 'ask_you',
    'add_to_today', 'remove_from_today', 'set_reply_style'].map((t) => `mcp__triage__${t}`),
]
/** The only shell a brief may run: `gh`/`git` read verbs, no chaining or redirection. */
const briefBashAllowed = (input: Record<string, unknown>): boolean => gitReadCommand(typeof input.command === 'string' ? input.command : '')

// ---------------------------------------------------------------------------
// Live session: one running Claude subprocess bound to a stored session row.
// ---------------------------------------------------------------------------
class LiveSession {
  status: SessionStatus = 'starting'
  model?: string
  /** What fast mode is actually doing here, straight from the subprocess. */
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  private seq: number
  /** the last event written to this transcript (its persist may still be in flight) */
  get lastSeq(): number {
    return this.seq
  }
  private readonly input = new AsyncQueue<UserTurn>()
  private readonly pendingPermissions = new Map<
    string,
    {
      input: Record<string, unknown>
      /** the tool asking — the inbox says "Permission: Bash" or "Question" */
      toolName: string
      /** The SDK's own "don't ask again" rules, replayed on `allow_always`. */
      suggestions: PermissionUpdate[]
      resolve: (r: PermissionResult) => void
    }
  >()
  private readonly q: AgentSession
  /** The subprocess's cumulative cost at its last result — turn cost is the difference. */
  private costSeen = 0
  /** This turn wrote a skill or agent file — reload them everywhere when it ends. */
  private libraryTouched = false
  /** Whether this subprocess was spawned able to bypass permission checks. */
  private readonly bypassArmed: boolean
  /** The agent this session runs on — its own, not the workspace's. */
  readonly provider: Provider

  constructor(
    readonly rt: WorkspaceRuntime,
    readonly row: StoredSession,
    lastSeq: number,
    resumeSdkSessionId: string | null,
    readonly extras: SessionExtras = {},
  ) {
    this.seq = lastSeq
    this.bypassArmed = row.permissionMode === 'bypassPermissions'
    this.provider = providerFor(row.provider)
    this.q = this.provider.openSession(this.input, {
      cwd: row.cwd,
      // Brief sessions: the headless contract rides in the system prompt so
      // it survives `resume` (.docs/next-version.md).
      ...(extras.systemAppend ? { systemAppend: extras.systemAppend } : {}),
      // The triage inbox as in-process tools, so a chat can list/create/edit
      // work items directly — same tool surface as the stdio shim external
      // Claude Code sessions get (server/mcp.ts). Scoped to this workspace.
      // Brief sessions add their own `write_brief` server on top. An agent
      // that can't host in-process servers (Codex) gets none of them: it
      // reaches triage through its own configured `triage` MCP instead.
      mcpServers: {
        ...(this.provider.capabilities.inProcessMcp ? { triage: rt.triageMcp(), ...(extras.mcp ?? {}) } : {}),
        ...((extras.externalMcp ?? {}) as McpServers),
      },
      ...(extras.tools ? { tools: extras.tools } : {}),
      ...(extras.strictMcpConfig ? { strictMcp: true } : {}),
      disallowedTools: [...(row.kind === 'brief' ? BRIEF_DISALLOWED_TOOLS : row.kind === 'goal' && !rt.goalRuns.has(row.id) ? GOAL_LEAD_DISALLOWED_TOOLS : []), ...(extras.disallowedTools ?? [])],
      // The session's agent's auth in this workspace: api-key / config-dir
      // spawn with overrides; inherit passes nothing.
      ...(rt.envFor(row.provider) ? { env: rt.envFor(row.provider) } : {}),
      // Omitted when the user never picked: Claude Code's own default is a
      // real choice (an org can move it), not a model we should pin here.
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      // Fast mode: the same model at up to ~2.5x output speed, priced higher.
      // Set at spawn and cleared, not set false, when turned off (see setFastMode).
      ...(row.fastMode ? { fastMode: true } : {}),
      ...(extras.settings ? { settings: extras.settings } : {}),
      // A team member's backstop: the agent stops mid-turn past it, where our
      // own accounting (per result) would only notice afterwards.
      ...(extras.maxBudgetUsd ? { maxBudgetUsd: extras.maxBudgetUsd } : {}),
      // How much this session asks. 'gated' is ours, enforced in requestPermission;
      // the adapter leaves the agent at its baseline so every call reaches it.
      permissionMode: row.permissionMode,
      // Revival: replay the agent's own transcript into the new subprocess.
      ...(resumeSdkSessionId ? { resume: resumeSdkSessionId } : {}),
      // The workspace's own skills and agents, for a chat. Not for briefs, job
      // runs or team workers — each runs a lean, fixed toolset on purpose.
      ...(row.kind === 'chat' && !extras.tools ? { plugins: [rt.libraryDir] } : {}),
      // A read-only worker or brief is fenced, and a job run or a team worker
      // holds its outbound calls for you (core/actions/queue.ts) — a hook, so
      // no mode or ~/.claude allow rule skips either. Chats keep asking now,
      // through `approve` below.
      ...(this.provider.capabilities.hooks ? sessionVeto(rt, row) : {}),
      // Still set under every mode: the permissive modes short-circuit the
      // calls they cover before this runs, and whatever still reaches here
      // is a call that mode decided a human should see.
      approve: (toolName, toolInput, opts) => this.requestPermission(toolName, toolInput, opts),
    })
    // A session with history getting a fresh subprocess: mark the boundary, since
    // nothing in the SDK's stream says "new process" (init comes every turn).
    if (lastSeq > 0) this.emit({ kind: 'subprocess' }, true)
    void this.pump()
  }

  /**
   * Photograph the repo before this turn starts, so everything the turn does
   * lands between two trees we own. Best-effort: a folder that is not a repo,
   * or a git that fails, simply records nothing and the changes view says so.
   */
  private async beginTurn() {
    if (this.row.kind !== 'chat') return
    const root = await sessionRepoRoot(this.rt, this.row)
    if (!root) return
    // A turn already open means the user sent again mid-turn; the SDK folds
    // that into the running turn, so keep the original pre-tree.
    if (this.rt.openTurns.has(this.row.id)) return
    const preTree = await snapshotTree(root)
    if (!preTree) return
    const seq = (await this.rt.store.turns.lastSeq(this.row.id)) + 1
    const startedAt = Date.now()
    this.rt.openTurns.set(this.row.id, { seq, root, startedAt, touched: new Set() })
    await this.rt.store.turns.begin({ sessionId: this.row.id, seq, root, preTree, startedAt })
  }

  /** Close the open turn with the post-turn tree. Never throws into the pump. */
  private async endTurn() {
    const open = this.rt.openTurns.get(this.row.id)
    if (!open) return
    this.rt.openTurns.delete(this.row.id)
    try {
      const postTree = await snapshotTree(open.root)
      await this.rt.store.turns.end(this.row.id, open.seq, {
        postTree,
        endedAt: Date.now(),
        touched: [...open.touched],
      })
      broadcast(this.rt, { type: 'session_changed', sessionId: this.row.id })
    } catch (err) {
      log('warn', 'git', `snapshot after turn failed: ${errText(err)}`, { session: this.row.id })
    }
  }

  /** Re-read skills and agents from disk, and tell the composer what `/` offers now. */
  async reloadLibrary(): Promise<void> {
    if (!this.q.reloadLibrary || this.status === 'starting' || this.status === 'error') return
    const commands = await this.q.reloadLibrary()
    noteCommands(this.rt, this.row.cwd, commands.map(toCommandInfo))
  }

  /** Remember which paths this turn's file-editing tools named. */
  private noteToolPaths(calls: ToolCall[]) {
    const open = this.rt.openTurns.get(this.row.id)
    if (!open) return
    for (const c of calls) {
      if (!EDIT_TOOLS.has(c.name)) continue
      const fp = (c.input as { file_path?: unknown })?.file_path
      if (typeof fp === 'string' && fp) open.touched.add(path.resolve(open.root, fp))
    }
  }

  private async pump() {
    try {
      for await (const ev of this.q) {
        // init and result messages carry what fast mode is really doing —
        // including why it is not serving, which is the only way the user
        // learns their toggle was overruled (wrong model, wrong plan, …).
        if (ev.fastMode) this.noteFastMode(ev.fastMode)
        if (ev.kind === 'started') {
          this.model = ev.model
          // The key for `resume` — without it a stored session can't continue.
          if (ev.sessionId && ev.sessionId !== this.row.sdkSessionId) {
            this.row.sdkSessionId = ev.sessionId
            void this.rt.store.sessions.setSdkSessionId(this.row.id, ev.sessionId)
          }
          // What this CLI won't drive from a browser. Cwd-independent, so it
          // is kept on the workspace: the first session to start teaches the
          // draft tabs too. Set before the list is asked for, which reads it.
          if (ev.terminalCommands) this.rt.terminalCommands = ev.terminalCommands
          // The subprocess already knows what `/` offers in this folder —
          // take it rather than make the composer pay for its own probe.
          void this.refreshCommands()
          this.setStatus('idle')
        }
        // Skills can be discovered mid-run (the agent walks into a subdirectory
        // with its own). The contract is replace-don't-merge.
        if (ev.kind === 'commands') noteCommands(this.rt, this.row.cwd, ev.commands.map(toCommandInfo))
        if (ev.kind === 'message') {
          this.setStatus('running')
          if (ev.role === 'assistant') {
            this.noteToolPaths(ev.toolCalls)
            if (ev.toolCalls.some(writesLibrary)) this.libraryTouched = true
          }
        }
        // stream deltas are broadcast live but not persisted (recoverable
        // from the committed assistant message, and the only high-volume thing)
        this.emit({ kind: 'sdk', message: slimToolImages(ev.record) }, ev.kind !== 'stream')
        if (ev.kind === 'result') {
          this.setStatus('idle')
          const turnStart = this.rt.openTurns.get(this.row.id)?.startedAt
          if (turnStart != null) void noteBrowserTurn(this.rt, this.row, turnStart, ev.record)
          void this.endTurn()
          void this.rt.store.sessions.touch(this.row.id)
          void syncCheckouts(this.rt)
          // The turn may have created files — the next `@` search relists.
          this.rt.files.invalidate(this.row.cwd)
          // A brief run is one turn: its result is the run's end.
          if (this.row.kind === 'brief') void onBriefTurnDone(this.rt, this.row.id)
          // So is a goal lead's: it proposed the plan, or it never will.
          if (this.row.kind === 'goal') void settleGoalLead(this.rt, this.row.id)
          // A skill or agent this turn wrote is usable now — here and in every other session.
          if (this.libraryTouched) {
            this.libraryTouched = false
            reloadLibraryEverywhere(this.rt)
          }
          // Team spend: total_cost_usd is cumulative for this subprocess, so
          // the turn's cost is the difference from the last result it sent —
          // tracked for every session, so a chat that becomes a lead mid-way
          // books only what it spends from then on.
          const cost = ev.costUsd ?? null
          const delta = cost === null ? 0 : Math.max(0, cost - this.costSeen)
          if (cost !== null) this.costSeen = cost
          if (this.rt.sessionTeam.has(this.row.id)) void noteTeamSpend(this.rt, this.row.id, delta, ev.overBudget)
          // A goal session is one turn too: the run loop books its spend and moves the goal on.
          if (this.rt.goalRuns.has(this.row.id)) void endGoalSession(this.rt, this.row.id, null, delta)
        }
      }
      this.setStatus('idle')
    } catch (err) {
      this.emit({ kind: 'error', message: String(err) }, true)
      this.setStatus('error')
    } finally {
      // The subprocess is gone; any unanswered prompt can never be answered.
      this.expirePendingPermissions()
      // A fresh-context replacement may already hold the slot; only clear our own.
      if (this.rt.live.get(this.row.id) === this) this.rt.live.delete(this.row.id)
      broadcastSessionList(this.rt)
      if (this.row.kind === 'brief') void onBriefSessionEnded(this.rt, this.row.id)
      if (this.row.kind === 'goal') void settleGoalLead(this.rt, this.row.id, 'the lead session ended before it proposed a plan')
      if (this.rt.goalRuns.has(this.row.id)) void endGoalSession(this.rt, this.row.id, 'the session ended before its turn finished')
    }
  }

  /**
   * Switch model/effort for every turn from here on. `setModel` and the flag
   * settings layer both apply live, so an in-flight session doesn't restart.
   */
  async setModel(model: string | null, effort: EffortLevel | null) {
    await this.q.setModel(model ?? undefined)
    await this.q.setEffort(effort)
  }

  /**
   * Turn fast mode on or off for every turn from here on. Off clears the key
   * from the flag layer rather than writing `false`: the SDK reads absence as
   * "not opted in", which is exactly what off means, and lets any lower-
   * precedence setting speak for itself again.
   */
  async setFastMode(on: boolean) {
    // The last verdict described the old setting; drop it rather than let the
    // UI read a stale "not serving" against a switch just flipped. The next
    // init or result message replaces it.
    this.fastModeState = undefined
    this.fastModeDisabledReason = undefined
    await this.q.setFastMode(on)
  }

  /** Ask this session's subprocess what `/` offers in its folder. */
  private async refreshCommands() {
    // The folder's command cache is the workspace agent's; another agent's
    // list (Codex has none) would overwrite it for every draft in the folder.
    if (this.provider.id !== this.rt.provider.id) return
    try {
      noteCommands(this.rt, this.row.cwd, (await this.q.commands()).map(toCommandInfo))
    } catch (err) {
      log('warn', 'commands', `supportedCommands failed: ${errText(err)}`, { session: this.row.id })
    }
  }

  /** Record the subprocess's own fast-mode verdict, broadcasting on a change. */
  private noteFastMode(v: FastModeVerdict) {
    const changed = v.state !== this.fastModeState || v.reason !== this.fastModeDisabledReason
    this.fastModeState = v.state
    this.fastModeDisabledReason = v.reason
    if (changed) broadcastSessionList(this.rt)
  }

  /** A pending permission prompt is waiting on the user. */
  get waiting(): boolean {
    return this.pendingPermissions.size > 0
  }

  /** The tool the oldest pending prompt is about. Absent = nothing is waiting. */
  get waitingOn(): string | undefined {
    return this.pendingPermissions.values().next().value?.toolName
  }

  async sendUserMessage(text: string, images?: ImageAttachment[], mentions?: Mention[], opts: { from?: string } = {}) {
    // Mentions are resolved now, against this session's folder, so the event
    // log records what the model was actually given (and why a file wasn't).
    const attached = mentions?.length ? await resolveMentions(this.rt, this.row.cwd, mentions) : null
    // Before the agent can touch anything: the tree this turn starts from.
    await this.beginTurn()
    this.emit({ kind: 'local_user', text, images, mentions: attached?.resolved, ...(opts.from ? { from: opts.from } : {}) }, true)
    // A message from triage or a teammate is framed for the model; the transcript keeps the raw text and a badge.
    const modelText = opts.from && text ? frameTeamMessage(opts.from, text) : text
    this.setStatus('running')
    void this.rt.store.sessions.touch(this.row.id)
    // Images lead: the model reads them as context for the text that follows.
    // Attachments trail it, each in its own block, so the ask stays readable.
    const content = [
      ...(images ?? []).map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      })),
      ...(modelText ? [{ type: 'text' as const, text: modelText }] : []),
      ...(attached?.blocks ?? []).map((t) => ({ type: 'text' as const, text: t })),
    ]
    this.input.push({ content })
  }

  private requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[]; agentID?: string; toolUseID?: string },
  ): Promise<PermissionResult> {
    const effect = classifyEffect(toolName)
    // Reading our own inbox is harmless in any mode — never prompt for it. Every
    // triage write (create/edit/upsert/resolve) still goes through the prompt.
    if (TRIAGE_READ_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    // Team runs: triage's own team tools only record and route — the card is
    // the approval. A worker that can't edit runs read-only git/gh unattended,
    // and any worker runs the project's own checks without a click.
    if (TEAM_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    // The browser pane: reading and using the page never asks. Leaving this
    // machine and browser_eval fall through to the session's mode below.
    if (browserCallAllowed(toolName, toolInput, this.row.cwd)) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    const run = teamRunOf(this.rt, this.row.id)
    if (run && run.leadSessionId !== this.row.id && toolName === 'Bash') {
      const ws = run.workers.filter((w) => w.sessionId === this.row.id)
      const writes = ws.some((w) => run.recipe.steps.find((s) => s.id === w.stepId)?.output === 'change')
      if (!writes && briefBashAllowed(toolInput)) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      if (run.checkCmds?.length && isCheckCommand(String(toolInput.command ?? ''), run.checkCmds)) {
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      }
    }
    // The level you picked on the team card. Outbound calls have already met the veto
    // (held, or refused from the shell), so under `local` what reaches here stays on this
    // machine — except a connector write nothing recognised as an action, which still asks.
    if (run && run.leadSessionId !== this.row.id) {
      const level = run.card.permissions ?? 'ask'
      if (level === 'everything' || (level === 'local' && (toolName === 'Bash' || effect !== 'external-write'))) {
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      }
    }
    // Brief sessions are headless (.docs/next-version.md): nobody is there to
    // answer a prompt, so the policy is fixed — reads and the brief's own write
    // tool run, narrow read-only gh/git commands run, everything else is denied.
    // A goal's drafting lead is headless too: reads, read-only gh/git, and its plan.
    // A goal run's sessions are headless as well. The role fence and the hold
    // have vetoed already, so a worker may edit inside its worktree and run the
    // shell (outbound calls were queued for approval before they got here).
    const goalRun = this.rt.goalRuns.get(this.row.id)
    if (goalRun) {
      const own = toolName.startsWith('mcp__goal__')
      const inTree = (p: unknown) => typeof p === 'string' && !path.relative(this.row.cwd, path.resolve(this.row.cwd, p)).startsWith('..')
      const allowed =
        own ||
        effect === 'read' ||
        (goalRun.role === 'lead'
          ? toolName === 'Bash' && briefBashAllowed(toolInput)
          : toolName === 'Bash' || (EDIT_TOOLS.has(toolName) && inTree(toolInput.file_path ?? toolInput.notebook_path)))
      return Promise.resolve(
        allowed
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: `This is a goal's headless ${goalRun.role}: that tool isn't open to it. Note what you needed in goal_log_append.` },
      )
    }
    if (this.row.kind === 'goal') {
      const allowed = GOAL_LEAD_TOOLS.has(toolName) || effect === 'read' || (toolName === 'Bash' && briefBashAllowed(toolInput))
      return Promise.resolve(
        allowed
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: "This is a goal's drafting lead: only reads, read-only gh/git commands, and goal_propose_plan are allowed." },
      )
    }
    if (this.row.kind === 'brief') {
      const allowed =
        toolName === 'mcp__brief__write_brief' || effect === 'read' || (toolName === 'Bash' && briefBashAllowed(toolInput))
      return Promise.resolve(
        allowed
          ? { behavior: 'allow', updatedInput: toolInput }
          : {
              behavior: 'deny',
              message:
                'This is a brief session: only reads, read-only gh/git commands, and write_brief are allowed. To change the brief, call write_brief with the whole revised brief.',
            },
      )
    }
    // Autonomy (.docs/junior-goals-teams/modes-autonomy-goals.md). Reads and
    // lookups never ask: 'gated' is "Asks before any change", and the old
    // 'default' (or no mode) reads the same. The subprocess runs at the SDK
    // default there, so this is the one gate it can't skip. "Asks before
    // commands" ('acceptEdits') adds read-only shell; the SDK lets edits through.
    if (effect === 'read') return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    const mode = this.row.permissionMode ?? 'default'
    if ((mode === 'acceptEdits' || mode === 'auto') && toolName === 'Bash' && readOnlyCommand(String(toolInput.command ?? ''))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    return this.askUser(toolName, toolInput, opts, effect)
  }

  /** Put the call in front of the user as a prompt in the transcript; resolved by resolvePermission. */
  private askUser(
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[]; agentID?: string; toolUseID?: string },
    effect: ReturnType<typeof classifyEffect>,
  ): Promise<PermissionResult> {
    const id = randomUUID()
    const suggestions = opts.suggestions ?? []
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(id, { input: toolInput, toolName, suggestions, resolve })
      if (this.pendingPermissions.size === 1) broadcastSessionList(this.rt)
      this.emit(
        {
          kind: 'permission_request',
          id,
          toolName,
          input: toolInput,
          title: opts.title,
          description: opts.description,
          canAlwaysAllow: suggestions.length > 0,
          effect,
          // A subagent's call says whose it is, so the card (and its agent's dock row) can.
          ...(opts.agentID ? { agentId: opts.agentID } : {}),
          // Which call this is — the action record's "who allowed it" keys on it.
          ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
        },
        true,
      )
    })
  }

  resolvePermission(id: string, behavior: PermissionBehavior, answers?: QuestionAnswers) {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    this.pendingPermissions.delete(id)
    if (this.pendingPermissions.size === 0) broadcastSessionList(this.rt)
    if (behavior === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'Denied by the user in the triage web UI.' })
    } else if (answers) {
      // AskUserQuestion: the picked labels ride back in on the tool's input,
      // which is where the tool reads the user's answer from.
      pending.resolve({
        behavior: 'allow',
        updatedInput: { ...pending.input, answers },
      })
    } else {
      // 'allow_always' is 'allow' plus the SDK's suggested rules — re-homed to
      // 'session' first. The SDK suggests 'localSettings', which would write
      // the rule into the project's .claude on disk and outlive the session; a
      // button in a transcript is consent for this session, not a settings
      // edit. Widening the scope beyond that stays a deliberate act in
      // ~/.claude, where the user can see the whole list at once.
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(behavior === 'allow_always' && pending.suggestions.length > 0
          ? { updatedPermissions: pending.suggestions.map(sessionScoped) }
          : {}),
      })
    }
    this.emit({ kind: 'permission_resolved', id, behavior, ...(answers ? { answers } : {}) }, true)
  }

  /**
   * Switch how much this session asks, for every turn from here on.
   *
   * Returns false when the running subprocess cannot take the switch — the
   * caller has already persisted it, so the fix is to end this subprocess and
   * let the next turn revive one built for the new mode. That is the case for
   * 'bypassPermissions': its opt-in is a spawn-time CLI flag, so a subprocess
   * started without it can never be talked into bypassing.
   */
  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (mode === 'bypassPermissions' && !this.bypassArmed) return false
    try {
      // 'gated' (and 'default') run the subprocess at the SDK's baseline; the
      // gate lives in requestPermission, which reads the live row's mode. The
      // row is already updated by the caller, so this switch takes effect at
      // once without a restart.
      await this.q.setPermissionMode(mode)
      return true
    } catch {
      return false
    }
  }

  /**
   * End the subprocess without killing the session: closing the prompt stream
   * ends the SDK's iteration, and `pump`'s `finally` does the bookkeeping.
   * The next message revives it from the row, picking up whatever changed.
   */
  stop() {
    this.input.close()
  }

  private expirePendingPermissions() {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'The session ended before this request was answered.' })
      this.emit({ kind: 'permission_resolved', id, behavior: 'expired' }, true)
    }
    this.pendingPermissions.clear()
  }

  async interrupt() {
    try {
      await this.q.interrupt()
    } catch (err) {
      this.emit({ kind: 'error', message: `interrupt failed: ${String(err)}` }, true)
    }
  }

  /** Stop one subagent; its task_notification ('stopped') settles it everywhere. */
  async stopAgent(agentId: string) {
    try {
      await this.q.stopTask(agentId)
    } catch (err) {
      this.emit({ kind: 'error', message: `stopping the agent failed: ${String(err)}` }, true)
    }
  }

  /** Hand a foreground subagent to the background: the main agent stops waiting on it. */
  async backgroundAgent(toolUseId: string) {
    try {
      await this.q.backgroundTask(toolUseId)
    } catch (err) {
      this.emit({ kind: 'error', message: `backgrounding the agent failed: ${String(err)}` }, true)
    }
  }

  /**
   * A message for one of this session's subagents. The SDK has no way to put it
   * straight into a subagent, so the main agent gets a short framed turn asking
   * it to pass the text on with SendMessage — which also resumes an agent that
   * has finished. The transcript keeps the raw text and who it was for.
   */
  async sendAgentMessage(relay: AgentRelay, text: string) {
    await this.beginTurn()
    this.emit({ kind: 'local_user', text, relay }, true)
    this.setStatus('running')
    void this.rt.store.sessions.touch(this.row.id)
    this.input.push({ content: [{ type: 'text', text: frameAgentRelay(relay, text) }] })
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return
    this.status = status
    broadcastSessionList(this.rt)
  }

  /** Write a line of triage's own into this transcript (a team paused, a stage began). */
  notice(text: string) {
    this.emit({ kind: 'notice', text }, true)
  }

  private emit(event: SessionEvent, persist: boolean) {
    if (persist) {
      this.seq += 1
      this.rt.store.events.append(this.row.id, this.seq, event).catch((err) => {
        log('error', 'session', `failed to persist event for ${this.row.id}: ${err}`)
      })
      // What the log keeps, the actions record reads: one fold, live or backfilled.
      noteActionEvent(this.rt, this.row, event)
    }
    broadcast(this.rt, { type: 'session_event', sessionId: this.row.id, event, at: Date.now() })
  }
}

// ---------------------------------------------------------------------------
// Session registry helpers — all per-workspace.
// ---------------------------------------------------------------------------
function summarize(rt: WorkspaceRuntime, row: StoredSession): SessionSummary {
  const l = rt.live.get(row.id)
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    status: l?.status ?? 'idle',
    updatedAt: row.updatedAt,
    // The user's pick wins: it is what the next turn runs on, and it is set
    // before the subprocess has reported anything.
    model: row.model ?? l?.model,
    effort: row.effort ?? undefined,
    fastMode: row.fastMode || undefined,
    fastModeState: l?.fastModeState,
    fastModeDisabledReason: l?.fastModeDisabledReason,
    permissionMode: row.permissionMode ?? undefined,
    ...(row.provider !== DEFAULT_PROVIDER ? { provider: row.provider } : {}),
    pinned: row.pinned || undefined,
    ...(row.checkoutId ? { checkoutId: row.checkoutId } : {}),
    ...(row.kind !== 'chat' ? { kind: row.kind } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(rt.sessionItem.has(row.id) ? { itemId: rt.sessionItem.get(row.id) } : {}),
    ...(teamRunLink(rt, row.id) ? { teamRun: teamRunLink(rt, row.id) } : {}),
    ...(l?.waiting ? { waiting: true, waitingOn: l.waitingOn } : {}),
    live: !!l,
  }
}

/**
 * The chat session list: pinned first, then most recently active. Job-run
 * sessions are real sessions but not chats — they are excluded here and reached
 * through the job that owns them (.docs/jobs-v2.md).
 */
function summaries(rt: WorkspaceRuntime): SessionSummary[] {
  return [...rt.rows.values()]
    .filter((r) => r.kind !== 'job-run')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .map((r) => summarize(rt, r))
}

/**
 * Delete a session for good: its subprocess, its in-memory state, and its
 * whole log. The subprocess is stopped first so nothing is still writing to a
 * row that is about to go.
 */
/**
 * Image blocks inside tool results (a browser screenshot, a Read of a PNG) are
 * for the model, which already has them. The log and every open page get the
 * block without its bytes — the transcript shows saved shots from disk.
 */
function slimToolImages<T>(record: T): T {
  const m = record as { type?: string; message?: { content?: unknown } }
  if (m?.type !== 'user' || !Array.isArray(m.message?.content)) return record
  let changed = false
  const content = (m.message.content as RawBlock[]).map((b) => {
    if (b?.type !== 'tool_result' || !Array.isArray(b.content)) return b
    const inner = b.content as RawBlock[]
    if (!inner.some((c) => c?.type === 'image')) return b
    changed = true
    return { ...b, content: inner.map((c) => (c?.type === 'image' ? { type: 'image', omitted: true } : c)) }
  })
  return changed ? ({ ...m, message: { ...m.message, content } } as T) : record
}

/**
 * A turn ended: if it used the browser, add it to the session's Verification
 * note (server/browser.ts renderVerification), linked to the session and its
 * item — the evidence "done" points at.
 */
async function noteBrowserTurn(rt: WorkspaceRuntime, row: StoredSession, startedAt: number, record: unknown): Promise<void> {
  try {
    const taken = rt.shots.list(row.id).filter((s) => s.at >= startedAt && s.kind !== 'pick')
    if (!taken.length) return
    const r = record as { result?: unknown }
    const turns = await rt.shots.addTurn(row.id, {
      startedAt,
      endedAt: Date.now(),
      summary: typeof r?.result === 'string' ? r.result : '',
      shots: taken.map((s) => s.n),
    })
    const title = `Verification · ${row.title || 'session'}`.slice(0, 120)
    const body = renderVerification({ title, workspaceId: rt.meta.id, sessionId: row.id, turns, shots: rt.shots.list(row.id) })
    const artifact = await rt.artifacts.writeAt(`verification/${row.id}.md`, { title, body, author: 'model' })
    await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'session', toId: row.id, role: 'context' })
    const itemId = rt.sessionItem.get(row.id)
    if (itemId) await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: itemId, role: 'context' })
  } catch (err) {
    log('warn', 'browser', `could not write the verification note: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
  }
}

// ---------------------------------------------------------------------------
// Outbound actions (core/actions; spec 7ce2f076, phase 1 — record only).
// Every persisted event of a Claude session — chat, brief, team worker, job
// run — passes through its tracker; what leaves this machine becomes a record
// with a card. Permissions are untouched: this only jobs.
// ---------------------------------------------------------------------------

/** What a connector's server said about one of its tools, from the latest probes. */
function toolHints(rt: WorkspaceRuntime, toolName: string): ToolHints | undefined {
  for (const probe of [rt.connectorCache, ...rt.folderProbes.values()]) {
    for (const c of probe?.connectors ?? []) {
      const t = c.tools.find((x) => x.fullName === toolName)
      if (t) return { readOnly: t.readOnly, destructive: t.destructive, openWorld: t.openWorld }
    }
  }
  return undefined
}

/** Sort one call against the workspace's actions file and the connector's hints. */
const sortForWorkspace = (rt: WorkspaceRuntime) => (toolName: string, input: Record<string, unknown>) =>
  sortCall(toolName, input, { rules: rt.actionsFile.current().rules, hints: toolHints(rt, toolName) })

function actionContext(rt: WorkspaceRuntime, row: StoredSession): TrackContext {
  return {
    sessionId: row.id,
    sessionKind: row.kind,
    permissionMode: row.permissionMode,
    jobId: row.jobId,
    teamRunId: teamRunOf(rt, row.id)?.id ?? null,
    itemId: rt.sessionItem.get(row.id) ?? null,
  }
}

/**
 * Fold one persisted event of a session into its action records. Claude
 * sessions only (Codex approves differently — later). Never throws into the
 * caller: a recording failure must not break a session.
 */
function noteActionEvent(rt: WorkspaceRuntime, row: StoredSession, ev: SessionEvent, at = Date.now()): void {
  if (row.provider !== 'claude') return
  let t = rt.actionTrackers.get(row.id)
  if (!t) {
    t = new ActionTracker(actionContext(rt, row), sortForWorkspace(rt))
    rt.actionTrackers.set(row.id, t)
  } else {
    // A session's mode, item and team can change mid-life; a record reads them as they are now.
    Object.assign(t.ctx, actionContext(rt, row))
  }
  let ops: ActionOp[]
  try {
    ops = t.feed(ev, at)
  } catch (err) {
    log('warn', 'actions', `could not sort an event: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
    return
  }
  if (ops.length) void queueActionOps(rt, ops)
}

/** Apply ops on the workspace's action chain, in order; resolves when they're stored. */
function queueActionOps(rt: WorkspaceRuntime, ops: ActionOp[]): Promise<void> {
  rt.actionChain = rt.actionChain
    .then(() => applyActionOps(rt.store.actions, ops))
    .then((touched) => actionsChanged(rt, touched))
    .catch((err) => log('warn', 'actions', `could not record an action: ${errText(err)}`, { workspace: rt.meta.id }))
  return rt.actionChain
}

/** Tell open pages, coalesced: a burst of calls is one refetch per session. */
function actionsChanged(rt: WorkspaceRuntime, sessions: Set<string>): void {
  if (!sessions.size) return
  if (!rt.actionsDirty) {
    rt.actionsDirty = new Set()
    setTimeout(() => {
      const dirty = rt.actionsDirty ?? new Set<string>()
      rt.actionsDirty = null
      for (const sessionId of dirty) broadcast(rt, { type: 'actions_changed', sessionId })
    }, 250).unref()
  }
  for (const id of sessions) rt.actionsDirty.add(id)
}

const ACTIONS_BACKFILL_KEY = 'actions_backfill'

/**
 * Weeks of history on day one: replay every Claude session's stored log
 * through the same fold the live path uses. Runs once per workspace (the
 * config key); running it again changes nothing — a call already recorded is
 * skipped, and its outcome re-applies as the same outcome.
 */
async function backfillActions(rt: WorkspaceRuntime, opts: { force?: boolean } = {}): Promise<{ sessions: number }> {
  if (!opts.force && (await rt.store.config.get<{ at: number }>(ACTIONS_BACKFILL_KEY))) return { sessions: 0 }
  let sessions = 0
  for (const row of [...rt.rows.values()]) {
    if (row.provider !== 'claude') continue
    const events = await rt.store.events.read(row.id)
    if (!events.length) continue
    const t = new ActionTracker(actionContext(rt, row), sortForWorkspace(rt))
    const ops = events.flatMap((e) => t.feed(e.event, e.createdAt))
    if (ops.length) await queueActionOps(rt, ops)
    sessions++
    // The store is synchronous: yield between sessions so boot isn't one long stall.
    await new Promise((res) => setImmediate(res))
  }
  await rt.store.config.set(ACTIONS_BACKFILL_KEY, { at: Date.now() })
  log('info', 'actions', `backfilled actions from ${sessions} session(s)`, { workspace: rt.meta.id })
  return { sessions }
}

/**
 * Records with names for their ids, as the Actions page and the item page show
 * them — their titles and "why it counted" in words, and a queued one's
 * history. Batched: one job list, one history query, one item read per
 * distinct item, however many rows.
 */
async function actionViews(rt: WorkspaceRuntime, records: ActionRecord[]): Promise<ActionView[]> {
  if (!records.length) return []
  const jobTitles = new Map((await rt.store.jobs.list()).map((w) => [w.id, w.title]))
  const queued = records.filter((a) => a.queue).map((a) => a.id)
  const history = queued.length ? await rt.store.actions.history(queued) : new Map()
  const itemOf = (a: ActionRecord) => a.itemId ?? rt.sessionItem.get(a.sessionId) ?? null
  const itemIds = [...new Set(records.map(itemOf).filter((x): x is string => !!x))]
  const itemTitles = new Map<string, string>()
  for (const id of itemIds) {
    const item = rt.inboxCache?.items.find((i) => i.id === id) ?? (await rt.store.items.get(id).catch(() => null))
    if (item) itemTitles.set(id, item.title)
  }
  const rules = rt.actionsFile.current().rules
  return records.map((a) => {
    const run = a.teamRunId ? rt.teamRuns.get(a.teamRunId) : undefined
    const itemId = itemOf(a)
    const row = rt.rows.get(a.sessionId)
    return {
      ...a,
      itemId,
      title: actionTitle(a),
      counted: countedText(a),
      short: shortActionId(a.id),
      ...(history.has(a.id) ? { history: history.get(a.id) } : {}),
      ...(row ? { sessionTitle: row.title } : {}),
      ...(a.jobId && jobTitles.has(a.jobId) ? { jobTitle: jobTitles.get(a.jobId) } : {}),
      ...(run ? { teamLabel: run.recipe.label } : {}),
      ...(itemId && itemTitles.has(itemId) ? { itemTitle: itemTitles.get(itemId) } : {}),
      ...(overriddenOff(a, rules) ? { hidden: true } : {}),
    }
  })
}

/** Queued actions waiting on you, workspace-wide — the rail's badge. */
async function needsYouCount(rt: WorkspaceRuntime): Promise<number> {
  return (await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })).length
}

/** A row's "Not an action" / "This is an action", written to the actions file as one edit (core/actions/sort.ts withRowOverride). */
async function setActionOverride(rt: WorkspaceRuntime, a: ActionRecord, verdict: 'action' | 'not_action'): Promise<string[]> {
  const entries = overrideEntries(a)
  if (!entries.length) throw new Error('this action has no tool or pattern to override')
  const hints = toolHints(rt, a.tool)
  await rt.actionsFile.edit((text) => withRowOverride(text, a, verdict, hints))
  return entries
}

// ---------------------------------------------------------------------------
// Queued actions (core/actions/queue.ts; spec 7ce2f076, phase 2). In a job
// run or a team worker, a connector call that sorts as an action is held, not
// run: the agent is told "queued as #a1b2c3", and the call waits on the
// Actions page for approve / edit / send back / reject. An approved one goes
// out 15s later through a headless one-tool run fenced to the approved args —
// the daemon never calls an MCP server itself. Chats keep asking now.
// ---------------------------------------------------------------------------

/** The model that sends approved actions: cheap, and it only copies JSON into one call. */
const DISPATCH_MODEL = 'haiku'
/** A dispatch run that hasn't finished by now is stopped (and, if the call was let through, marked unknown). */
const DISPATCH_TIMEOUT_MS = 3 * 60_000

const isTeamWorker = (rt: WorkspaceRuntime, sessionId: string): boolean => {
  const run = teamRunOf(rt, sessionId)
  return !!run && run.leadSessionId !== sessionId
}

/**
 * A chat at "Asks before sending" ('auto'): local work runs, sends are held.
 * Read off the live row each call, so switching the level mid-session holds the very next send.
 */
const chatHoldsSends = (rt: WorkspaceRuntime, row: StoredSession): boolean =>
  row.provider === 'claude' && row.kind === 'chat' && !teamRunOf(rt, row.id) && (rt.rows.get(row.id) ?? row).permissionMode === 'auto'

/** Does this session hold its outbound calls for approval? Job runs, team workers, and chats at "Asks before sending" do. */
const holdsActions = (rt: WorkspaceRuntime, row: StoredSession): boolean =>
  row.provider === 'claude' &&
  (row.kind === 'job-run' ||
    (isTeamWorker(rt, row.id) && teamRunOf(rt, row.id)?.card.permissions !== 'everything') ||
    (rt.goalRuns.get(row.id)?.role ?? 'lead') !== 'lead' ||
    chatHoldsSends(rt, row))

/**
 * The role fence a session runs under (core/goals/fence.ts), or null: a team
 * worker on a step that isn't the change step is read-only, and so is a brief.
 */
function roleFenceOf(rt: WorkspaceRuntime, row: StoredSession): RoleFence | null {
  if (row.kind === 'brief') return { write: false, role: 'brief' }
  const goalRun = rt.goalRuns.get(row.id)
  if (goalRun)
    return {
      write: roleWrites(goalRun.role),
      role: goalRun.role,
      // Reviewer independence (M6): not the builders' handoff, log or transcripts.
      ...(goalRun.role === 'reviewer' ? { hidden: [path.join(rt.goalLedger.root, goalDir(goalRun.goalId)), `${path.sep}.claude${path.sep}projects${path.sep}`] } : {}),
    }
  if (row.kind === 'goal') return { write: false, role: 'lead' }
  const run = teamRunOf(rt, row.id)
  const worker = run && run.leadSessionId !== row.id ? [...run.workers].reverse().find((w) => w.sessionId === row.id) : undefined
  if (!run || !worker) return null
  const { writes } = workerSpec(run, worker)
  return { write: writes, role: (worker.agent || 'worker').toLowerCase() }
}

/**
 * A session's PreToolUse veto: its role fence first, then the hold. None for a
 * session with neither — except a chat, which always gets one: its Autonomy
 * level can change mid-session and the hook is only installed at spawn.
 */
function sessionVeto(rt: WorkspaceRuntime, row: StoredSession): { veto?: ToolVeto } {
  const fence = roleFenceOf(rt, row)
  const chat = row.kind === 'chat' && row.provider === 'claude'
  if (!fence && !chat && !holdsActions(rt, row)) return {}
  return {
    veto: (toolName, input, ctx) => {
      const d = fence ? roleFenceDecision(fence, toolName, input) : { allow: true as const }
      if (!d.allow) {
        log('info', 'fence', `refused ${toolName} in a read-only session: ${d.reason}`, { session: row.id, workspace: rt.meta.id })
        return d
      }
      // "Asks before sending" lets Claude's auto mode run local work; a command
      // that destroys work still comes to you.
      if (toolName === 'Bash' && chatHoldsSends(rt, row) && isArgsObject(input)) {
        const why = destructiveCommand(String(input.command ?? ''))
        if (why) return { allow: false, ask: true, reason: `This command ${why}, so it needs your OK.` }
      }
      return holdIfAction(rt, row, toolName, input, ctx)
    },
  }
}

/**
 * The veto a holding session gets: an MCP call or a Bash command that sorts
 * as an action is refused with "queued as #…" and filed for approval;
 * except a team worker's outbound shell command, which is refused outright (a
 * team hands work in and you send it); everything else passes. A held command
 * is sent from the session's folder.
 */
function holdIfAction(
  rt: WorkspaceRuntime,
  row: StoredSession,
  toolName: string,
  input: unknown,
  ctx?: { toolUseId?: string },
): { allow: true } | { allow: false; reason: string } {
  if (!holdable(toolName) || !holdsActions(rt, row)) return { allow: true }
  const args = isArgsObject(input) ? input : {}
  // A team worker's push, PR or comment from the shell: refused, not filed — a team hands
  // work in and you send it. (A job's Bash isn't held in this phase: sending needs its folder.)
  // A chat's is held like any send, and sent from the chat's folder.
  if (toolName === 'Bash' && !chatHoldsSends(rt, row)) {
    if (!isTeamWorker(rt, row.id)) return { allow: true }
    let out
    try {
      out = sortForWorkspace(rt)(toolName, args)
    } catch {
      return { allow: true }
    }
    return out
      ? { allow: false, reason: `\`${out.summary}\` leaves this machine, and a team never sends anything. Finish your step without it and say in your handoff what should be sent — the user sends it.` }
      : { allow: true }
  }
  if (!toolName.startsWith('mcp__') && toolName !== 'Bash') return { allow: true }
  let sorted
  try {
    sorted = sortForWorkspace(rt)(toolName, args)
  } catch (err) {
    log('warn', 'actions', `could not sort a call to hold it: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
    return { allow: true }
  }
  if (!sorted) return { allow: true }
  // A goal's worker: the same call any of the goal's sessions already filed —
  // before a crash, or by the worker this one replaced — is that action.
  const goalRun = rt.goalRuns.get(row.id)
  const filed = goalRun ? rt.goalHeld.find(goalRun.goalId, toolName, args) : null
  if (filed) return { allow: false, reason: queuedMessage(filed) }
  // The same call with the same args, still waiting: name the action already filed.
  const key = `${row.id}\u0000${toolName}\u0000${canonJson(args)}`
  const dup = rt.heldCalls.get(key)
  if (dup) {
    // The repeat is the same action: its call joins the record already waiting, so no second row appears.
    const again = ctx?.toolUseId
    if (again) {
      void onActionChain(rt, () => joinHeldCall(rt.store.actions, row.id, again, dup))
        .then(() => actionsChanged(rt, new Set([row.id])))
        .catch((err) => log('warn', 'actions', `could not join a repeated held call: ${errText(err)}`, { session: row.id, workspace: rt.meta.id }))
    }
    return { allow: false, reason: queuedMessage(dup) }
  }
  const toolUseId = ctx?.toolUseId || `held-${randomUUID()}`
  const id = `${row.id}:${toolUseId}`
  rt.heldCalls.set(key, id)
  if (goalRun)
    void goalActionHeldOp(rt.goalDeps, rt.goalHeld, { goalId: goalRun.goalId, sessionId: row.id, actionId: id, tool: toolName, args }).catch((err) =>
      log('warn', 'goals', `could not note a held action on its goal: ${errText(err)}`, { session: row.id, workspace: rt.meta.id }),
    )
  const now = Date.now()
  const base = recordFor(actionContext(rt, row), toolUseId, toolName, args, sorted, now)
  void onActionChain(rt, async () => {
    // The call's message may have been recorded as an attempt already: hold that record.
    const existing = await rt.store.actions.byCall(row.id, toolUseId)
    const rec = heldRecord(existing ?? base, args, now)
    await rt.store.actions.put(rec)
    await rt.store.actions.addHistory(heldEntry(rec, args, now))
    log('info', 'actions', `held for approval: ${rec.summary} (#${shortActionId(rec.id)})`, { session: row.id, action: rec.id, tool: toolName, workspace: rt.meta.id })
  })
    .then(() => {
      actionsChanged(rt, new Set([row.id]))
      invalidateInbox(rt)
    })
    .catch((err) => log('warn', 'actions', `could not hold an action: ${errText(err)}`, { session: row.id, workspace: rt.meta.id }))
  return { allow: false, reason: queuedMessage(id) }
}

/** Run `fn` on the workspace's action chain — after every write queued before it, before any after. */
function onActionChain<T>(rt: WorkspaceRuntime, fn: () => Promise<T>): Promise<T> {
  const run = rt.actionChain.then(fn)
  rt.actionChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** A held call that left the queue: an agent repeating it is a new action from now on. */
function forgetHeld(rt: WorkspaceRuntime, actionId: string): void {
  for (const [k, id] of rt.heldCalls) if (id === actionId) rt.heldCalls.delete(k)
}

/**
 * One move on a queued action (core/actions/queue.ts `move`), stored with its
 * history line. The effects that follow a move — a send timer, notes to the
 * drafting session, the inbox's "my turn" — are the caller's.
 */
async function moveAction(rt: WorkspaceRuntime, id: string, m: ActionMove, now = Date.now()): Promise<ActionRecord> {
  const next = await onActionChain(rt, async () => {
    const rec = await rt.store.actions.get(id)
    if (!rec) throw new Error('no such action')
    const r = move(rec, m, now)
    if (!r.ok) throw new Error(r.error)
    await rt.store.actions.put(r.next)
    await rt.store.actions.addHistory(r.entry)
    return r.next
  })
  if (next.status !== 'needs_you') forgetHeld(rt, id)
  // Sent back or lapsed: a goal's worker may file the same call again.
  if (next.status === 'sent_back' || next.status === 'expired') rt.goalHeld.drop(id)
  actionsChanged(rt, new Set([next.sessionId]))
  return next
}

/** Arm (or re-arm) the timer that sends an approved action at its time. */
function armDispatch(rt: WorkspaceRuntime, rec: ActionRecord): void {
  disarmDispatch(rt, rec.id)
  if (rec.status !== 'scheduled') return
  const t = setTimeout(() => {
    rt.actionTimers.delete(rec.id)
    void dispatchAction(rt, rec.id)
  }, sendDelay(rec, Date.now()) + 50)
  t.unref()
  rt.actionTimers.set(rec.id, t)
}

function disarmDispatch(rt: WorkspaceRuntime, id: string): void {
  const t = rt.actionTimers.get(id)
  if (t) clearTimeout(t)
  rt.actionTimers.delete(id)
}

/** A user's verb on a queued action, with what follows it. */
async function actionVerbOp(rt: WorkspaceRuntime, verb: ActionVerb, raw: unknown): Promise<ActionRecord> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id || id.length > 400) throw new Error('need the action id')
  let m: ActionMove
  switch (verb) {
    case 'approve': {
      if (r.args !== undefined && !isArgsObject(r.args)) throw new Error('args must be a JSON object')
      // Kept exactly as sent: the edited args are what goes out, word for word.
      m = r.args !== undefined ? { type: 'approve', args: r.args as Record<string, unknown> } : { type: 'approve' }
      break
    }
    case 'undo':
      m = { type: 'undo' }
      break
    case 'send-back': {
      if (typeof r.notes !== 'string' || !r.notes.trim()) throw new Error('send back needs notes: say what to change')
      m = { type: 'send_back', notes: r.notes }
      break
    }
    case 'reject': {
      if (r.reason !== undefined && typeof r.reason !== 'string') throw new Error('reason must be text')
      m = { type: 'reject', reason: typeof r.reason === 'string' ? r.reason : '' }
      break
    }
    case 'retry':
      m = { type: 'retry' }
      break
  }
  const next = await moveAction(rt, id, m)
  if (next.status === 'scheduled') armDispatch(rt, next)
  else disarmDispatch(rt, id)
  if (verb === 'send-back') void deliverSendBack(rt, next)
  if (verb !== 'retry') invalidateInbox(rt)
  log('info', 'actions', `${verb}: ${next.summary} (#${shortActionId(next.id)}) → ${next.status}`, { action: id, workspace: rt.meta.id })
  return next
}

/**
 * Send-back notes to the session that drafted the action — under exactly the
 * constraints it drafted under, never more:
 * - a job run: a headless continuation of its own Claude session (resume),
 *   built by jobQuery like the run itself — the same grants, the same
 *   fence, the hold wrap — so the redraft is held for approval again and can
 *   do nothing the job couldn't. One still running gets them when it ends.
 * - a team worker: revived as a worker (its tools, its permission mode, the
 *   hold veto), only while its run is still known; otherwise not at all.
 * Whatever happens is kept on the record, so the card can say whether they arrived.
 */
async function deliverSendBack(rt: WorkspaceRuntime, rec: ActionRecord): Promise<void> {
  const row = rt.rows.get(rec.sessionId)
  const text = sendBackMessage(rec.id, rec.tool, rec.queue?.note ?? '')
  let delivery: string | null
  if (!row) delivery = 'not delivered: the session that drafted it was deleted'
  else if (row.provider !== 'claude') delivery = 'not delivered: that session runs on another agent'
  else if (row.kind === 'job-run') {
    if (!row.runStatus) delivery = null // still running: on its way at the end
    else if (!row.sdkSessionId) delivery = 'not delivered: the run never started an agent to resume'
    else {
      try {
        await continueJobRun(rt, row, text, () => void recordDelivery(rt, rec, 'delivered'))
        return
      } catch (err) {
        delivery = `not delivered: ${errText(err)}`
      }
    }
  } else if (rec.teamRunId && !isTeamWorker(rt, row.id)) {
    delivery = 'not delivered: its team run is over, so its worker can no longer be resumed under the run’s constraints'
  } else if (!row.sdkSessionId && !rt.live.has(row.id)) delivery = 'not delivered: the session never started, so there is nothing to resume'
  else {
    try {
      const live = await getOrRevive(rt, row.id)
      if (!live) delivery = 'not delivered: the session could not be resumed (its folder is gone)'
      else {
        await live.sendUserMessage(text, undefined, undefined, { from: 'triage' })
        delivery = 'delivered'
      }
    } catch (err) {
      delivery = `not delivered: ${errText(err)}`
    }
  }
  if (delivery !== null) await recordDelivery(rt, rec, delivery)
}

/** Keep on a sent-back record whether its notes reached the session (once — a later word doesn't overwrite "delivered"). */
async function recordDelivery(rt: WorkspaceRuntime, rec: ActionRecord, delivery: string): Promise<void> {
  await onActionChain(rt, async () => {
    const cur = await rt.store.actions.get(rec.id)
    if (!cur?.queue || cur.status !== 'sent_back' || cur.queue.delivery === 'delivered') return
    await rt.store.actions.put({ ...cur, queue: { ...cur.queue, delivery }, updatedAt: Math.max(cur.updatedAt, Date.now()) })
    await rt.store.actions.addHistory({
      actionId: cur.id,
      at: Date.now(),
      actor: 'triage',
      event: delivery === 'delivered' ? 'notes delivered' : 'notes not delivered',
      from: 'sent_back',
      to: 'sent_back',
      note: delivery === 'delivered' ? null : delivery,
      args: null,
    })
  }).catch((err) => log('warn', 'actions', `could not record a send-back delivery: ${errText(err)}`, { action: rec.id, workspace: rt.meta.id }))
  actionsChanged(rt, new Set([rec.sessionId]))
  log(delivery === 'delivered' ? 'info' : 'warn', 'actions', `send back #${shortActionId(rec.id)}: ${delivery}`, { action: rec.id, session: rec.sessionId, workspace: rt.meta.id })
}

/** Job-run continuations in flight, by session: a second send-back waits for the first. */
const jobContinuations = new Map<string, Promise<void>>()

/**
 * Continue a finished job run's own Claude session with one message from
 * triage, headless, under the job's own run spec (jobQuery: grants,
 * allowlist, unattended, the fence) plus the hold — the same box the run had.
 * The transcript continues on its session row. `onStarted` fires once the
 * agent is up with the message.
 */
function continueJobRun(rt: WorkspaceRuntime, row: StoredSession, text: string, onStarted: () => void): Promise<void> {
  const key = `${rt.meta.id}:${row.id}`
  const prev = jobContinuations.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    const job = row.jobId ? await rt.store.jobs.get(row.jobId) : null
    if (!job) throw new Error('the job that drafted it was deleted')
    const project = await jobProject(rt, job.projectId)
    const limits = await jobLimits(rt, job)
    // A redraft is a job run like any other: it counts against the job's
    // daily budget and gets its own row in the run ledger (trigger `redraft`).
    const startedAt = Date.now()
    const slot = startedAt
    const spent = job.dailyBudgetUsd != null ? await rt.store.jobRuns.spentSince(job.id, localMidnight(startedAt)) : 0
    const budget = budgetFor(limits.maxBudgetUsd, job.dailyBudgetUsd, spent)
    if (budget.skip) {
      await ledger(rt, rt.store.jobRuns.insert({ jobId: job.id, slot, trigger: 'redraft', status: 'skipped_budget', reason: budget.reason, sessionId: row.id, startedAt, endedAt: startedAt }))
      throw new Error(`the job is over its daily budget (${budget.reason}) — the notes stay here`)
    }
    await ledger(rt, rt.store.jobRuns.insert({ jobId: job.id, slot, trigger: 'redraft', status: 'running', sessionId: row.id, startedAt }))
    let status: JobRunStatus = 'failed'
    let reason: string | undefined
    let costUsd: number | undefined
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), limits.timeoutMs)
    const scanMcp = makeScanMcp(rt, job, row.id, () => {})
    try {
      const spec = await jobQuery(
        rt,
        { instruction: job.instruction, tools: job.tools, project, model: job.model, output: job.output, schedule: scheduleOf(job), scope: job.scope, skills: job.skills, agents: job.agents },
        scanMcp,
        abort,
        budget.maxBudgetUsd != null ? { maxBudgetUsd: budget.maxBudgetUsd } : {},
      )
      const fence = spec.veto
      if (!fence) throw new Error('no fence for this job run')
      spec.veto = (toolName, input, ctx) => {
        const d = fence(toolName, input, ctx)
        return d.allow ? holdIfAction(rt, row, toolName, input, ctx) : d
      }
      spec.prompt = frameTeamMessage('triage', text)
      spec.resume = row.sdkSessionId ?? undefined
      let seq = await rt.store.events.lastSeq(row.id)
      const emit = (event: SessionEvent, persist = true) => {
        if (persist) {
          seq += 1
          rt.store.events.append(row.id, seq, event).catch(() => {})
          noteActionEvent(rt, row, event)
        }
        broadcast(rt, { type: 'session_event', sessionId: row.id, event, at: Date.now() })
      }
      emit({ kind: 'local_user', text, from: 'triage' })
      let started = false
      try {
        for await (const ev of rt.provider.run(spec)) {
          if (ev.kind === 'started') {
            if (!started) onStarted()
            started = true
            if (ev.sessionId && ev.sessionId !== row.sdkSessionId) {
              row.sdkSessionId = ev.sessionId
              rt.store.sessions.setSdkSessionId(row.id, ev.sessionId).catch(() => {})
            }
          }
          emit({ kind: 'sdk', message: ev.record }, ev.kind !== 'stream')
          if (ev.kind === 'result' && ev.costUsd != null) costUsd = ev.costUsd
        }
        if (!started) throw new Error('the run ended before it started')
        status = 'ok'
      } catch (err) {
        status = abort.signal.aborted ? 'timeout' : 'failed'
        reason = abort.signal.aborted ? `the redraft timed out after ${humanSpan(limits.timeoutMs)}` : errText(err)
        emit({ kind: 'error', message: reason })
        throw err
      }
      row.updatedAt = Date.now()
      void rt.store.sessions.touch(row.id)
      broadcastSessionList(rt)
    } finally {
      clearTimeout(timer)
      rt.actionTrackers.delete(row.id)
      await ledger(rt, rt.store.jobRuns.finish(job.id, slot, { status, ...(reason ? { reason } : {}), sessionId: row.id, endedAt: Date.now(), ...(costUsd != null ? { costUsd } : {}) }))
      log(status === 'ok' ? 'info' : 'warn', 'job', `redraft ${status}: ${job.title}${costUsd != null ? ` — $${costUsd.toFixed(2)}` : ''}${reason ? ` — ${reason}` : ''}`, {
        jobId: job.id,
        runId: row.id,
        trigger: 'redraft',
        workspace: rt.meta.id,
      })
    }
  })
  jobContinuations.set(key, run)
  void run.finally(() => {
    if (jobContinuations.get(key) === run) jobContinuations.delete(key)
  }).catch(() => {})
  return run
}

/** A job run just ended: notes sent back while it ran go to it now. */
async function deliverPendingSendBacks(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const waiting = (await rt.store.actions.list({ sessionId, status: ['sent_back'], limit: 100 })).filter((a) => a.queue && a.queue.delivery === null)
  for (const a of waiting) await deliverSendBack(rt, a)
}

/**
 * Where a dispatch run gets its connector: the drafting session's folder, its
 * folder's own MCP server of that name (as a job run loads them — passed
 * explicitly, the project's settings and hooks never loaded), a team worker's
 * agent-declared server, and the user's own config (user-scope servers and
 * claude.ai connectors).
 */
async function dispatchOrigin(rt: WorkspaceRuntime, rec: ActionRecord): Promise<{ cwd: string; mcpServers: McpServers }> {
  const server = serverOf(rec.tool)
  const row = rt.rows.get(rec.sessionId)
  let cwd = row?.cwd ?? null
  if (rec.jobId) {
    const w = await rt.store.jobs.get(rec.jobId).catch(() => null)
    const project = w ? (await rt.store.projects.list()).find((p) => p.id === w.projectId) : undefined
    if (project) cwd = project.path
  }
  const isDir = !!cwd && (await stat(cwd).then((st) => st.isDirectory(), () => false))
  // A command runs where it was drafted, or not at all: `git push` from a temp folder pushes nothing it meant to.
  if (rec.tool === 'Bash') {
    if (!cwd || !isDir) throw new Error(`the folder it was drafted in is gone${cwd ? ` (${cwd})` : ''}`)
    return { cwd, mcpServers: {} }
  }
  if (!cwd || !isDir) cwd = await mkdtemp(path.join(os.tmpdir(), 'triage-dispatch-'))
  const servers: McpServers = {}
  const folder = await folderMcpServers(rt, cwd).catch(() => null)
  if (folder?.servers[server]) servers[server] = folder.servers[server]
  // A team worker's agent file may declare the server itself (extrasFor loads it the same way).
  const run = row ? teamRunOf(rt, row.id) : undefined
  const worker = run && row && run.leadSessionId !== row.id ? [...run.workers].reverse().find((w) => w.sessionId === row.id) : undefined
  if (run && worker) {
    const ext = rt.provider.agentTools(workerSpec(run, worker).can as AgentCan[]).mcpServers as McpServers | undefined
    if (ext?.[server]) servers[server] = ext[server]
  }
  return { cwd, mcpServers: servers }
}

/**
 * The one-tool run that sends an approved action. Headless, in the
 * workspace's auth; no built-in tools, the one connector tool allowed and
 * nothing else; the fence lets that call through only with the approved args,
 * once. Never throws: whatever happened is in the trace.
 */
async function runDispatch(rt: WorkspaceRuntime, rec: ActionRecord): Promise<{ trace: DispatchTrace; costUsd: number | null }> {
  const q = rec.queue!
  const fence = new DispatchFence(rec.tool, q.args)
  const trace: DispatchTrace = { allowed: false, connector: null }
  let costUsd: number | null = null
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), DISPATCH_TIMEOUT_MS)
  try {
    const origin = await dispatchOrigin(rt, rec)
    // Every other connector the user has: out of the run's context entirely (the fence would deny them anyway).
    const known = [...(rt.folderProbes.get(origin.cwd)?.connectors ?? []), ...(rt.connectorCache?.connectors ?? [])].map((c) => c.server)
    const disallowedTools = dispatchDisallowed([...known, ...Object.keys(origin.mcpServers)], rec.tool)
    const bash = rec.tool === 'Bash'
    const run = rt.provider.run({
      prompt: dispatchPrompt(rec.tool, q.args),
      cwd: origin.cwd,
      // The user's own MCP servers and claude.ai connectors; never the project's settings, skills or hooks.
      userConfig: true,
      // ToolSearch only: connector tools are deferred (claude.ai ones start pending), so the run loads the one it needs.
      // A held command needs only the shell.
      tools: bash ? ['Bash'] : [TOOL_SEARCH],
      allowedTools: bash ? ['Bash'] : [TOOL_SEARCH, rec.tool],
      ...(disallowedTools.length ? { disallowedTools } : {}),
      unattended: true,
      veto: (toolName, input, ctx) => fence.decide(toolName, input, ctx?.toolUseId),
      model: DISPATCH_MODEL,
      // ToolSearch, the call, the one-word reply.
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      mcpServers: origin.mcpServers,
      abort,
      ...(rt.env ? { env: rt.env } : {}),
    })
    for await (const ev of run) {
      if (ev.kind === 'started') trace.connector = connectorState(ev.record, rec.tool)
      if (ev.kind === 'message' && ev.role === 'user' && fence.allowed && !trace.result) {
        const blocks = Array.isArray(ev.record.message?.content) ? ev.record.message.content : []
        for (const b of blocks) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
          if (fence.allowedCall && b.tool_use_id !== fence.allowedCall) continue
          trace.result = { isError: b.is_error === true, text: resultText(b.content) }
          break
        }
      }
      if (ev.kind === 'result') {
        if (ev.costUsd != null) costUsd = ev.costUsd
        // The run's own word that it had no such tool, even after ToolSearch (the prompt asks it to say so).
        if (!fence.allowed && /\bno-tool\b/.test(ev.text)) trace.noTool = true
      }
    }
  } catch (err) {
    trace.runError = abort.signal.aborted ? `timed out after ${humanSpan(DISPATCH_TIMEOUT_MS)}` : errText(err)
  } finally {
    clearTimeout(timer)
  }
  trace.allowed = fence.allowed
  trace.denials = fence.denials
  return { trace, costUsd }
}

/**
 * Send one approved action whose time has come. Claimed first — one atomic
 * scheduled → sending update — so a timer and the minute tick racing for it
 * send it once; whoever loses does nothing.
 */
async function dispatchAction(rt: WorkspaceRuntime, id: string): Promise<void> {
  disarmDispatch(rt, id)
  if (rt.dispatching.has(id)) return
  const now = Date.now()
  const claimed = await onActionChain(rt, async () => {
    const rec = await rt.store.actions.get(id)
    if (!rec || !dueToSend(rec, now)) return null
    const r = move(rec, { type: 'claim' }, now)
    if (!r.ok) return null
    if (!(await rt.store.actions.claim(id, 'scheduled', 'sending', now, { dueBy: now }))) return null
    await rt.store.actions.addHistory(r.entry)
    return r.next
  }).catch((err) => {
    log('warn', 'actions', `could not claim an action to send: ${errText(err)}`, { action: id, workspace: rt.meta.id })
    return null
  })
  if (!claimed) return
  rt.dispatching.add(id)
  actionsChanged(rt, new Set([claimed.sessionId]))
  log('info', 'actions', `sending: ${claimed.summary} (#${shortActionId(id)})`, { action: id, tool: claimed.tool, workspace: rt.meta.id })
  try {
    const { trace, costUsd } = await runDispatch(rt, claimed)
    const bash = claimed.tool === 'Bash'
    const out = dispatchOutcome(trace, bash ? 'Bash' : serverOf(claimed.tool), { bash, push: bash && claimed.kind === 'push' })
    const done = await moveAction(rt, id, { type: 'settle', status: out.status, link: out.link, error: out.error, costUsd })
    log(out.status === 'succeeded' ? 'info' : 'warn', 'actions', `${out.status}: ${done.summary} (#${shortActionId(id)})${out.error ? ` — ${out.error}` : ''}`, {
      action: id,
      tool: claimed.tool,
      ...(costUsd != null ? { costUsd } : {}),
      workspace: rt.meta.id,
    })
  } catch (err) {
    // The run's own failures are in its trace; this is the record failing to settle. It may have gone out.
    log('error', 'actions', `dispatch of #${shortActionId(id)} ended badly: ${errText(err)}`, { action: id, workspace: rt.meta.id })
    await moveAction(rt, id, { type: 'settle', status: 'unknown', error: `triage lost track of the send: ${errText(err)} — check before retrying` }).catch(() => {})
  } finally {
    rt.dispatching.delete(id)
  }
}

/**
 * The minute tick's share: expire what waited too long, send what is due
 * (a timer lost to a restart), and re-arm timers for what is still ahead.
 */
async function tickActions(rt: WorkspaceRuntime, now = Date.now()): Promise<void> {
  const open = await rt.store.actions.list({ status: ['needs_you', 'scheduled'], limit: 5000 })
  let expired = 0
  for (const a of open) {
    if (dueToExpire(a, now)) {
      await moveAction(rt, a.id, { type: 'expire' }, now).then(
        () => (expired += 1),
        () => {},
      )
    } else if (dueToSend(a, now)) void dispatchAction(rt, a.id)
    else if (a.status === 'scheduled' && !rt.actionTimers.has(a.id)) armDispatch(rt, a)
  }
  if (expired) {
    invalidateInbox(rt)
    log('info', 'actions', `expired ${expired} action(s) nobody answered`, { workspace: rt.meta.id })
  }
}

/**
 * Boot: an action left `sending` died with the previous process mid-send — it
 * may have gone out, so it is unknown, never retried by itself. Scheduled
 * ones get their timers back (or go now, if their time passed).
 */
async function recoverActions(rt: WorkspaceRuntime): Promise<void> {
  const now = Date.now()
  for (const a of await rt.store.actions.list({ status: ['sending'], limit: 5000 })) {
    await onActionChain(rt, async () => {
      if (!(await rt.store.actions.claim(a.id, 'sending', 'unknown', now))) return
      const cur = await rt.store.actions.get(a.id)
      if (!cur) return
      const error = 'triage stopped while this was being sent — it may have gone out; check before retrying'
      await rt.store.actions.put({ ...cur, error, settledAt: now })
      await rt.store.actions.addHistory({ actionId: a.id, at: now, actor: 'triage', event: 'unknown', from: 'sending', to: 'unknown', note: error, args: null })
    }).catch((err) => log('warn', 'actions', `could not recover ${a.id}: ${errText(err)}`, { workspace: rt.meta.id }))
  }
  // Notes sent back to a job run that died before it ended never reached it: try now.
  for (const a of await rt.store.actions.list({ status: ['sent_back'], limit: 500 })) {
    if (a.queue && a.queue.delivery === null) void deliverSendBack(rt, a)
  }
  // The held-call map is memory: rebuild it, so an agent revived after a restart still hears the same id.
  for (const a of await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })) {
    if (a.queue) rt.heldCalls.set(`${a.sessionId}\u0000${a.tool}\u0000${canonJson(a.queue.args)}`, a.id)
  }
  await tickActions(rt, now)
}

async function deleteSession(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  rt.live.get(sessionId)?.stop()
  // Its actions stay on record — they happened; only the tracker goes.
  rt.actionTrackers.delete(sessionId)
  // Its tab closes; its evidence stays on disk — the Verification note points at it.
  browserHub.forget(sessionId)
  rt.live.delete(sessionId)
  rt.rows.delete(sessionId)
  const run = teamRunOf(rt, sessionId)
  if (run) {
    rt.sessionTeam.delete(sessionId)
    // The lead gone, the run goes with it; a worker gone respawns on its next step.
    if (run.leadSessionId === sessionId) {
      for (const w of run.workers) if (w.sessionId && w.sessionId !== sessionId) rt.sessionTeam.delete(w.sessionId)
      rt.teamRuns.delete(run.id)
    } else for (const w of run.workers) if (w.sessionId === sessionId) w.sessionId = null
    await saveTeamRuns(rt)
  }
  await rt.store.sessions.remove(sessionId)
  broadcast(rt, { type: 'session_deleted', sessionId })
  broadcastSessionList(rt)
}

// ---------------------------------------------------------------------------
// Checkouts (server/worktrees.ts): a project's main folder and its worktrees
// ---------------------------------------------------------------------------

const checkoutList = (rt: WorkspaceRuntime): Checkout[] => [...rt.checkouts.values()]

/**
 * Re-read every project's checkouts from git and tell the clients when
 * anything moved (a worktree appeared or went, a branch switched). Runs on
 * the Changes poll, at the end of every turn and when projects change.
 */
function syncCheckouts(rt: WorkspaceRuntime): Promise<void> {
  if (rt.checkoutSyncQueued) return rt.checkoutSyncQueued
  const run = async () => {
    rt.checkoutSyncQueued = null
    rt.checkoutSyncRunning = next
    try {
      const { checkouts, changed } = await syncProjectCheckouts(rt.store.checkouts, await rt.store.projects.list())
      if (!changed && rt.checkouts.size === checkouts.length) return
      rt.checkouts.clear()
      for (const c of checkouts) rt.checkouts.set(c.id, c)
      broadcast(rt, { type: 'checkouts', checkouts })
    } catch (err) {
      log('warn', 'checkouts', `could not read worktrees: ${errText(err)}`, { workspace: rt.meta.id })
    } finally {
      if (rt.checkoutSyncRunning === next) rt.checkoutSyncRunning = null
    }
  }
  const next: Promise<void> = (rt.checkoutSyncRunning ?? Promise.resolve()).then(run)
  rt.checkoutSyncQueued = next
  return next
}

/** A project's main checkout — the folder the user added. */
const mainCheckout = (rt: WorkspaceRuntime, projectId: string | null | undefined): Checkout | undefined =>
  projectId ? checkoutList(rt).find((c) => c.projectId === projectId && c.kind === 'main') : undefined

/**
 * A checkout by id; a project id means its main checkout, so a link made
 * before checkouts (`/change/<projectId>/…`) still resolves.
 */
const checkoutById = (rt: WorkspaceRuntime, id: string | null | undefined): Checkout | undefined =>
  id ? (rt.checkouts.get(id) ?? mainCheckout(rt, id)) : undefined

/**
 * Boot: rows for every project's folders, then every session saved before
 * checkouts gets its project's main one. Stored once, never re-derived from
 * `cwd` — a worktree's folder isn't the project's.
 */
async function loadCheckouts(rt: WorkspaceRuntime): Promise<void> {
  for (const c of await rt.store.checkouts.list()) rt.checkouts.set(c.id, c)
  await syncCheckouts(rt)
  const n = await rt.store.sessions.backfillCheckouts((projectId) => mainCheckout(rt, projectId)?.id ?? null)
  if (n) log('info', 'checkouts', `stored a checkout on ${n} sessions`, { workspace: rt.meta.id })
}

/** New worktrees live in the workspace folder (`~/.triage-dev` in dev), never inside the repo. */
const worktreesRoot = (rt: WorkspaceRuntime) => path.join(workspaceDir(rt.meta.id), 'worktrees')

/**
 * Make a worktree of `project` on `branch` and get it ready: `git worktree
 * add`, then node_modules and `.env*` from the main folder. Discovery records
 * the row (one writer, so no duplicate), and then what only triage knows —
 * the base it was cut from and the item it was made for — goes on it.
 */
async function makeWorktree(
  rt: WorkspaceRuntime,
  project: Project,
  branch: string,
  itemId?: string,
  onStep?: (step: CreateStep) => void,
  from?: string,
): Promise<Checkout> {
  onStep?.('worktree')
  const made = await createWorktree(project, branch, worktreesRoot(rt), from)
  onStep?.('files')
  const notes = await prepareWorktree(project.path, made.path)
  await syncCheckouts(rt)
  const row = checkoutList(rt).find((c) => c.projectId === project.id && path.resolve(c.path) === path.resolve(made.path))
  if (!row) throw new Error(`made ${made.path} but git doesn't list it as a worktree`)
  const patch = { base: made.base, itemId: itemId ?? null }
  await rt.store.checkouts.update(row.id, patch)
  const checkout = { ...row, ...patch }
  rt.checkouts.set(row.id, checkout)
  broadcast(rt, { type: 'checkouts', checkouts: checkoutList(rt) })
  log('info', 'checkouts', `made worktree ${made.branch} of ${project.name}${made.base ? ` from ${made.base}` : ''}`, {
    workspace: rt.meta.id,
    path: made.path,
    ...(notes.length ? { notes: notes.join('; ') } : {}),
  })
  return checkout
}

/** Sessions in a checkout that are mid-turn right now. */
const runningIn = (rt: WorkspaceRuntime, checkoutId: string): number =>
  [...rt.rows.values()].filter((r) => {
    const st = rt.live.get(r.id)?.status
    return r.checkoutId === checkoutId && (st === 'running' || st === 'starting')
  }).length

// ---------------------------------------------------------------------------
// Session changes — reconstructing what one session did to a shared worktree
// ---------------------------------------------------------------------------

type OpenTurn = { seq: number; root: string; startedAt: number; touched: Set<string> }

/** Tools whose `file_path` counts as this session naming a file itself. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// ---------------------------------------------------------------------------
// Skills and agents (server/library.ts): the settings tabs read and write the
// files; anything that changes them reloads every live session, so a new skill
// is in `/` and a new agent is spawnable without starting over.
// ---------------------------------------------------------------------------

/** Every skill and agent on this machine a job could name, keyed by the name Claude calls it. */
async function jobLibrary(rt: WorkspaceRuntime): Promise<JobLibrary> {
  const roots = await libraryRootsFor(rt)
  const [skills, agents] = await Promise.all([listLibrary('skill', roots), listLibrary('agent', roots)])
  // first one wins, as the tabs list them: the workspace library, then personal, projects, plugins
  const byName = (entries: LibraryEntry[]) => {
    const m = new Map<string, LibrarySource>()
    for (const e of entries) if (!m.has(e.name)) m.set(e.name, e.source)
    return m
  }
  return { skills: byName(skills), agents: byName(agents) }
}

/** The roots this workspace's sessions see: its library, ~/.claude, its projects' .claude, plugins. */
async function libraryRootsFor(rt: WorkspaceRuntime): Promise<LibraryRoot[]> {
  return libraryRoots({
    workspaceLibrary: rt.libraryDir,
    env: rt.envFor('claude'),
    projects: (await rt.store.projects.list()).map((p) => ({ name: p.name, path: p.path })),
  })
}

/**
 * A tool call that may have written a skill or agent. Generous on purpose — a
 * false hit costs one reload; a miss means the new skill waits for a new session.
 */
const LIBRARY_PATH_RE = /(^|[\/])(skills|agents)[\/]/
function writesLibrary(call: ToolCall): boolean {
  const input = (call.input ?? {}) as { file_path?: unknown; command?: unknown }
  if (EDIT_TOOLS.has(call.name)) return typeof input.file_path === 'string' && LIBRARY_PATH_RE.test(input.file_path)
  if (call.name === 'Bash') return typeof input.command === 'string' && /\.claude[\/](skills|agents)|library[\/](skills|agents)/.test(input.command)
  return false
}

/** Reload skills and agents in every live session, and tell the settings tabs to refetch. */
function reloadLibraryEverywhere(rt: WorkspaceRuntime): void {
  for (const live of rt.live.values()) {
    void live.reloadLibrary().catch((err) => log('warn', 'library', `reload failed: ${errText(err)}`, { session: live.row.id }))
  }
  // Draft tabs probed their folder's `/` list before the change; the next `/` asks again.
  for (const key of [...rt.commandCache.keys()]) {
    if (![...rt.live.values()].some((l) => expandHome(l.row.cwd) === key)) rt.commandCache.delete(key)
  }
  broadcast(rt, { type: 'library_changed' })
}

/** A session's repo root, resolved once per session and cached. */
async function sessionRepoRoot(rt: WorkspaceRuntime, row: StoredSession): Promise<string | null> {
  const hit = rt.repoRoots.get(row.id)
  if (hit !== undefined) return hit
  const root = await repoRoot(row.cwd)
  rt.repoRoots.set(row.id, root)
  return root
}

/** Working-tree snapshots are ~100 ms; a burst of requests shares one. */
const nowTrees = new Map<string, { at: number; tree: Promise<string | null> }>()
function currentTree(root: string): Promise<string | null> {
  const hit = nowTrees.get(root)
  if (hit && Date.now() - hit.at < 1500) return hit.tree
  const tree = snapshotTree(root)
  nowTrees.set(root, { at: Date.now(), tree })
  return tree
}

/** A turn's delta, memoised — the trees either side of a finished turn never move. */
async function turnDelta(
  rt: WorkspaceRuntime,
  root: string,
  t: StoredTurn,
  to: string | null,
  live: boolean,
): Promise<TreeChange[]> {
  if (!to) return []
  const key = `${t.sessionId}:${t.seq}`
  if (!live) {
    const hit = rt.turnDeltas.get(key)
    if (hit) return hit
  }
  const delta = await treeDiff(root, t.preTree, to)
  if (!live) rt.turnDeltas.set(key, delta)
  return delta
}

/** Do two turn windows overlap in time? An unfinished turn runs until now. */
const overlaps = (a: StoredTurn, b: StoredTurn): boolean =>
  a.startedAt <= (b.endedAt ?? Date.now()) && b.startedAt <= (a.endedAt ?? Date.now())

/**
 * What this session changed, and how sure we are about each file.
 *
 * Sessions share a working tree, so `git status` cannot answer this. Each of a
 * session's turns is bracketed by two trees, and the agent only edits while
 * its own turn runs — so the union of the per-turn deltas is this session's
 * file set, and anything another session moved outside those windows is simply
 * not in it. Within a window we can still be fooled by a *concurrent* session,
 * which is what `confidence` reports rather than hides.
 */
/**
 * One project's uncommitted work for the Changes rail, per checkout: the main
 * folder and every live worktree, each against its own HEAD. Never throws: a
 * broken repo is a row, not a 500.
 */
async function projectChanges(rt: WorkspaceRuntime, project: Project): Promise<ProjectChanges> {
  const checkouts = checkoutList(rt).filter((c) => c.projectId === project.id && c.state === 'active')
  const main = checkouts.find((c) => c.kind === 'main')
  const isRepo = !!(await repoRoot(project.path))
  const one = async (checkout: Checkout): Promise<CheckoutChanges> => {
    const empty: CheckoutChanges = { checkout, files: [], insertions: 0, deletions: 0 }
    if (!isRepo) return empty
    try {
      const [files, ahead] = await Promise.all([
        worktreeChanges(checkout.path),
        checkout.kind === 'worktree' && main?.branch ? aheadOf(checkout.path, main.branch) : null,
      ])
      return {
        ...empty,
        files,
        insertions: files.reduce((n, f) => n + f.insertions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        ...(ahead !== null ? { ahead } : {}),
      }
    } catch (err) {
      return { ...empty, error: errText(err) }
    }
  }
  return { project, isRepo, checkouts: await Promise.all(checkouts.map(one)) }
}

async function computeSessionChanges(rt: WorkspaceRuntime, row: StoredSession): Promise<SessionChanges> {
  const empty = { files: [], turns: [], insertions: 0, deletions: 0 }
  const root = await sessionRepoRoot(rt, row)
  if (!root) return { root: null, unavailable: 'This session is not running inside a git repository.', ...empty }

  const turns = await rt.store.turns.list(row.id)
  if (!turns.length) return { root, unavailable: 'No turns have run in this session yet.', ...empty }

  const now = await currentTree(root)
  if (!now) return { root, unavailable: 'Could not read the working tree.', ...empty }

  // Everything another session did to this repo since our baseline. Turns that
  // finished before we started cannot have polluted our own window.
  const since = turns[0].startedAt
  const foreign = (await rt.store.turns.othersInRoot(root, row.id)).filter((t) => (t.endedAt ?? Date.now()) >= since)

  // --- our own per-turn deltas: the file set, and which turn moved what -----
  const mine = new Map<string, { turns: number[]; ambiguous: boolean }>()
  const turnSummaries: SessionTurnSummary[] = []
  for (const [i, t] of turns.entries()) {
    const last = i === turns.length - 1
    const to = t.postTree ?? (last ? now : (turns[i + 1]?.preTree ?? null))
    const delta = await turnDelta(rt, root, t, to, t.postTree === null)
    const clashing = foreign.filter((f) => overlaps(t, f))
    for (const c of delta) {
      const e = mine.get(c.path) ?? { turns: [], ambiguous: false }
      e.turns.push(t.seq)
      // Only uncertain when someone else was running *and* no tool of ours
      // named the file during this turn.
      if (clashing.length && !t.touched.includes(path.join(root, c.path))) e.ambiguous = true
      mine.set(c.path, e)
    }
    turnSummaries.push({
      seq: t.seq,
      files: delta.length,
      insertions: delta.reduce((n, c) => n + c.insertions, 0),
      deletions: delta.reduce((n, c) => n + c.deletions, 0),
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      overlapped: [...new Set(clashing.map((c) => c.sessionId))].map((id) => sessionTitle(rt, id)),
    })
  }

  // --- which of those files another session also moved ----------------------
  const alsoBy = new Map<string, Set<string>>()
  for (const f of foreign) {
    const to = f.postTree ?? now
    const delta = await turnDelta(rt, root, f, to, f.postTree === null)
    for (const c of delta) {
      if (!mine.has(c.path)) continue
      const set = alsoBy.get(c.path) ?? new Set<string>()
      set.add(f.sessionId)
      alsoBy.set(c.path, set)
    }
  }

  // --- the numbers: net baseline → now, so a file edited twice counts once --
  const net = await treeDiff(root, turns[0].preTree, now)
  const touchedAbs = new Set(turns.flatMap((t) => t.touched))
  const files: ChangedFile[] = []
  for (const c of net) {
    const ours = mine.get(c.path)
    if (!ours) continue // moved in this folder, but never inside one of our turns
    const also = [...(alsoBy.get(c.path) ?? [])]
    files.push({
      path: c.path,
      status: c.status,
      insertions: c.insertions,
      deletions: c.deletions,
      isBinary: c.isBinary,
      touched: touchedAbs.has(path.join(root, c.path)),
      confidence: also.length ? 'shared' : ours.ambiguous ? 'ambiguous' : 'exact',
      alsoChangedBy: also.map((id) => sessionTitle(rt, id)),
      turns: ours.turns,
    })
  }

  return {
    root,
    files,
    turns: turnSummaries,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}

const sessionTitle = (rt: WorkspaceRuntime, id: string): string => rt.rows.get(id)?.title ?? 'another session'

/** One file's patch, from this session's baseline to the working tree. */
async function sessionFilePatch(
  rt: WorkspaceRuntime,
  row: StoredSession,
  file: string,
): Promise<{ patch: string; truncated: boolean } | null> {
  const root = await sessionRepoRoot(rt, row)
  if (!root) return null
  const turns = await rt.store.turns.list(row.id)
  if (!turns.length) return null
  const now = await currentTree(root)
  if (!now) return null
  return filePatch(root, turns[0].preTree, now, file)
}

/**
 * The workspace's default project (decision 549a251e): where a session,
 * terminal or item lands when nothing names a project. null only while the
 * workspace has no projects at all — onboarding asks for one.
 */
async function defaultProject(rt: WorkspaceRuntime): Promise<Project | null> {
  return (await rt.store.projects.list()).find((p) => p.isDefault) ?? null
}

/**
 * Add a folder as a project; the workspace's first project becomes its
 * default. Picking a folder that isn't a project adds it — there is no
 * "unsaved folder" state.
 */
async function addProject(rt: WorkspaceRuntime, folder: string, name?: string, repo = ''): Promise<Project> {
  const resolved = path.resolve(expandHome(folder))
  const st = await stat(resolved).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`folder not found: ${resolved}`)
  const projects = await rt.store.projects.list()
  if (projects.some((p) => path.resolve(p.path) === resolved)) throw new Error(`${resolved} is already a project`)
  const project: Project = { id: randomUUID(), name: name || path.basename(resolved) || resolved, repo, path: resolved }
  await rt.store.projects.create(project)
  if (!projects.some((p) => p.isDefault)) {
    await rt.store.projects.setDefault(project.id)
    project.isDefault = true
  }
  await syncCheckouts(rt)
  return project
}

/** The project a new session runs in: the one named, else the one at `cwd` — added if it isn't one yet. */
async function projectForSession(rt: WorkspaceRuntime, cwd: string, projectId?: string): Promise<Project> {
  const projects = await rt.store.projects.list()
  if (projectId) {
    const named = projects.find((p) => p.id === projectId)
    if (!named) throw new Error('unknown project')
    return named
  }
  const resolved = path.resolve(cwd)
  return projects.find((p) => path.resolve(p.path) === resolved) ?? (await addProject(rt, resolved))
}

async function createSession(
  rt: WorkspaceRuntime,
  title: string,
  cwd: string,
  model: string | null,
  effort: EffortLevel | null,
  fastMode: boolean,
  permissionMode: PermissionMode | null,
  opts: { kind?: SessionKind; spawn?: boolean; projectId?: string | null; checkoutId?: string | null; provider?: ProviderId } = {},
): Promise<StoredSession> {
  const projectId = opts.projectId ?? (await defaultProject(rt))?.id ?? null
  // Every session names its checkout at birth: the one asked for, else its project's main folder.
  if (projectId && !mainCheckout(rt, projectId)) await syncCheckouts(rt)
  const checkoutId = opts.checkoutId ?? mainCheckout(rt, projectId)?.id ?? null
  const row = await rt.store.sessions.create({
    id: randomUUID(),
    title,
    cwd,
    projectId,
    checkoutId,
    model,
    effort,
    fastMode,
    permissionMode,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  })
  rt.rows.set(row.id, row)
  // spawn: false = a row only; the first message starts it (getOrRevive).
  if (opts.spawn !== false) rt.live.set(row.id, new LiveSession(rt, row, 0, null, await extrasFor(rt, row)))
  return row
}

/** The live subprocess for a session, starting one (with `resume`) if needed. */
// ---------------------------------------------------------------------------
// `@` mentions — resolved at send time into blocks the model reads
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… [truncated — ${s.length - n} more characters]` : s)

/** What a session last said, for a `@session:` stub — its final reply, else the last assistant text. */
async function lastReplyText(rt: WorkspaceRuntime, sessionId: string): Promise<string | null> {
  const last = await rt.store.events.lastSeq(sessionId)
  const events = await rt.store.events.read(sessionId, Math.max(0, last - 200))
  let assistant: string | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.kind !== 'sdk') continue
    const m = ev.message as SdkMessage & { result?: unknown }
    if (m.type === 'result' && typeof m.result === 'string' && m.result) return m.result
    if (!assistant && m.type === 'assistant') {
      const text = (m.message?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
      if (text) assistant = text
    }
  }
  return assistant
}

const attachmentTag = (kind: string, attrs: Record<string, string | number | undefined>, body?: string) => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join('')
  return body === undefined ? `<attachment kind="${kind}"${a} />` : `<attachment kind="${kind}"${a}>\n${body}\n</attachment>`
}

/**
 * Turn the composer's mentions into what rides the message. Files are read
 * inside `cwd` (small text inlined, everything else passed as a path with a
 * note); items and sessions become short summaries. The returned `resolved`
 * list is what the event log keeps, so the transcript can show what landed.
 */
async function resolveMentions(
  rt: WorkspaceRuntime,
  cwd: string,
  mentions: Mention[],
): Promise<{ resolved: ResolvedMention[]; blocks: string[] }> {
  const resolved: ResolvedMention[] = []
  const blocks: string[] = []
  let budget = MAX_INLINE_TOTAL_BYTES
  const seen = new Set<string>()
  for (const m of mentions) {
    const key = `${m.kind}:${m.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    if (m.kind === 'file') {
      const f = await resolveFileMention(cwd, m.ref)
      switch (f.kind) {
        case 'text': {
          if (f.bytes > budget) {
            const error = 'over the per-message inline budget'
            resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error })
            blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: `not inlined: ${error} — read it from disk` }))
            break
          }
          budget -= f.bytes
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: true })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes }, f.text))
          break
        }
        case 'large': {
          const error = `too large to inline (${Math.round(f.bytes / 1024)} KB)`
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: `not inlined: ${error} — read the parts you need from disk` }))
          break
        }
        case 'binary': {
          resolved.push({ ...m, ref: f.rel, bytes: f.bytes, inlined: false, error: 'binary file' })
          blocks.push(attachmentTag('file', { path: f.rel, bytes: f.bytes, note: 'binary file — not inlined' }))
          break
        }
        case 'dir': {
          const listing = f.entries.join('\n')
          budget -= listing.length
          resolved.push({ ...m, ref: f.rel, inlined: true })
          blocks.push(attachmentTag('directory', { path: f.rel, entries: f.entries.length }, listing))
          break
        }
        case 'error':
          resolved.push({ ...m, inlined: false, error: f.error })
          blocks.push(attachmentTag('file', { path: m.ref, note: `could not be attached: ${f.error}` }))
          break
      }
    } else if (m.kind === 'item') {
      const scored = rt.inboxCache?.items.find((i) => i.id === m.ref)
      const item = scored ?? (await rt.store.items.get(m.ref).catch(() => null))
      if (!item) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('work_item', { id: m.ref, note: 'could not be attached: not found in this workspace' }))
        continue
      }
      const lines = [
        `title: ${item.title}`,
        `kind: ${item.kind} (${item.source})`,
        item.url && `url: ${item.url}`,
        item.repo && `where: ${item.repo}`,
        item.author && `author: ${item.author}`,
        item.status && `status: ${item.status}`,
        scored && `rank: ${scored.score} — ${scored.reason}`,
        item.why && `why: ${item.why}`,
        item.description && `description: ${item.description}`,
        item.urls?.length ? `links: ${item.urls.join(', ')}` : undefined,
        item.refs?.length ? `refs: ${item.refs.join(', ')}` : undefined,
      ].filter((l): l is string => typeof l === 'string' && l.length > 0)
      resolved.push({ ...m, label: item.title, inlined: true })
      blocks.push(attachmentTag('work_item', { id: item.id }, lines.join('\n')))
    } else if (m.kind === 'session') {
      const row = rt.rows.get(m.ref)
      if (!row) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('session', { id: m.ref, note: 'could not be attached: no such session in this workspace' }))
        continue
      }
      const sum = summarize(rt, row)
      const last = await lastReplyText(rt, row.id).catch(() => null)
      const lines = [
        `title: ${row.title}`,
        `folder: ${row.cwd}`,
        `status: ${sum.status}`,
        checkoutById(rt, row.checkoutId)?.branch && `branch: ${checkoutById(rt, row.checkoutId)?.branch}`,
        checkoutById(rt, row.checkoutId)?.kind === 'worktree' && 'checkout: a git worktree of its project',
        `last activity: ${new Date(row.updatedAt).toISOString()}`,
        row.sdkSessionId &&
          `claude session id: ${row.sdkSessionId} — its full transcript is under ~/.claude/projects, or \`claude --resume ${row.sdkSessionId}\` from that folder`,
      ].filter((l): l is string => typeof l === 'string' && l.length > 0)
      const body = lines.join('\n') + (last ? `\n\nlast reply:\n${clip(last, 4000)}` : '')
      resolved.push({ ...m, label: row.title, inlined: true })
      blocks.push(attachmentTag('session', { id: row.id }, body))
    } else if (m.kind === 'artifact') {
      const a = await rt.artifacts.read(m.ref).catch(() => null)
      if (!a) {
        resolved.push({ ...m, inlined: false, error: 'not found' })
        blocks.push(attachmentTag('artifact', { id: m.ref, note: 'could not be attached: no such artifact in this workspace' }))
        continue
      }
      const bytes = Buffer.byteLength(a.body, 'utf8')
      const attrs = { id: a.artifact.id, title: a.artifact.title, author: a.artifact.author, path: a.abs }
      if (bytes > MAX_INLINE_FILE_BYTES || bytes > budget) {
        const error = bytes > MAX_INLINE_FILE_BYTES ? `too large to inline (${Math.round(bytes / 1024)} KB)` : 'over the per-message inline budget'
        resolved.push({ ...m, label: a.artifact.title, bytes, inlined: false, error })
        blocks.push(attachmentTag('artifact', { ...attrs, bytes, note: `not inlined: ${error} — read it from disk` }))
        continue
      }
      budget -= bytes
      resolved.push({ ...m, label: a.artifact.title, bytes, inlined: true })
      blocks.push(attachmentTag('artifact', { ...attrs, bytes }, a.body))
    }
  }
  if (blocks.length > 0) {
    blocks.unshift('The user attached the following with @-mentions; the message above refers to them by these names.')
  }
  return { resolved, blocks }
}

/** A folder the `@` picker may list: a session's folder, a project, or anywhere under home. */
async function isSearchableRoot(rt: WorkspaceRuntime, root: string): Promise<boolean> {
  try {
    if (!(await stat(root)).isDirectory()) return false
  } catch {
    return false
  }
  const under = (base: string) => root === base || root.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  if ([...rt.rows.values()].some((r) => r.cwd === root)) return true
  if ((await rt.store.projects.list()).some((p) => under(p.path))) return true
  return under(os.homedir())
}

async function getOrRevive(rt: WorkspaceRuntime, sessionId: string): Promise<LiveSession | null> {
  // A fresh start: end the old subprocess and begin a new Claude session instead
  // of resuming — the transcript page continues, the model's history doesn't.
  const fresh = rt.freshNext.delete(sessionId)
  const existing = rt.live.get(sessionId)
  if (existing && !fresh) return existing
  const row = rt.rows.get(sessionId)
  if (!row) return null
  // A worktree removed under a session leaves it no folder to start in. Say so in its
  // transcript rather than let the agent fail to launch with an error about something else.
  if (!existing && !(await stat(row.cwd).then((st) => st.isDirectory(), () => false))) {
    const co = checkoutById(rt, row.checkoutId)
    const message =
      co?.kind === 'worktree'
        ? `This session's worktree (${co.branch ?? row.cwd}) was removed, so it has no folder to run in. Recreate the worktree to continue here, or continue in the main folder.`
        : `This session's folder is gone: ${row.cwd}. Start a new session somewhere that exists.`
    const seq = (await rt.store.events.lastSeq(row.id)) + 1
    await rt.store.events.append(row.id, seq, { kind: 'error', message })
    broadcast(rt, { type: 'session_event', sessionId: row.id, event: { kind: 'error', message }, at: Date.now() })
    void syncCheckouts(rt)
    return null
  }
  if (existing) existing.stop()
  const lastSeq = await rt.store.events.lastSeq(row.id)
  const extras = await extrasFor(rt, row)
  // Two messages racing to revive the same session: the first one's subprocess wins.
  const raced = !fresh ? rt.live.get(row.id) : undefined
  if (raced) return raced
  const revived = new LiveSession(rt, row, lastSeq, fresh ? null : row.sdkSessionId, extras)
  rt.live.set(row.id, revived)
  if (fresh && row.sdkSessionId) revived.notice('fresh context — this member starts from the brief, not its earlier history')
  broadcastSessionList(rt)
  return revived
}

/**
 * Boot: load stored sessions, and expire permission prompts orphaned by the
 * previous process (their subprocess died with it — Allow can never apply).
 */
async function loadSessions(rt: WorkspaceRuntime) {
  for (const row of await rt.store.sessions.list()) {
    rt.rows.set(row.id, row)

    const events = await rt.store.events.read(row.id)
    const unresolved = new Map<string, true>()
    for (const e of events) {
      if (e.event.kind === 'permission_request') unresolved.set(e.event.id, true)
      if (e.event.kind === 'permission_resolved') unresolved.delete(e.event.id)
    }
    let seq = events.length ? events[events.length - 1].seq : 0
    for (const id of unresolved.keys()) {
      seq += 1
      await rt.store.events.append(row.id, seq, { kind: 'permission_resolved', id, behavior: 'expired' })
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox: ranked work items from deterministic sources (core/work). No cron —
// the server IS the long-running process. Sync happens when the page is
// viewed and the cache is stale (stale-while-revalidate, the cache living in
// SQLite so a fresh server start still renders instantly), on explicit
// Refresh, and on a keep-warm interval while the server runs. A laptop that
// slept through the interval simply syncs on the next view.
// ---------------------------------------------------------------------------
const INBOX_TTL_MS = 5 * 60_000
const INBOX_KEEP_WARM_MS = 15 * 60_000
const SCHEDULER_TICK_MS = 60_000
const GITHUB_TTL_MS = 5 * 60_000
const GITHUB_LOOKBACK_MS = 14 * 86_400_000
/** how many job runs may execute at once (avoid the top-of-hour stampede) */
const JOB_CONCURRENCY = 2
/** how long past its timeout a run may hang (the SDK ignored the abort) before the watchdog frees its slot */
const WATCHDOG_GRACE_MS = 60_000
/** after a run's timeout aborts it, how long its stream may take to close before the run stops waiting on it */
const RUN_KILL_GRACE_MS = 15_000
const JOB_TIMEOUT_KEY = 'jobs.defaultTimeoutMs'
const JOB_BUDGET_KEY = 'jobs.defaultBudgetUsd'
const FOLDER_PROBE_TTL_MS = 10 * 60_000

const REPOS_KEY = 'github.repos'

/** when the scheduler last ticked — daemon-wide, surfaced in the System status. */
let lastSchedulerTickAt: number | null = null

async function connectedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  return (await rt.store.config.get<string[]>(REPOS_KEY)) ?? []
}

/** Is the claude.ai Slack connector connected, per the last connector probe? */
function slackConnected(rt: WorkspaceRuntime): boolean | null {
  if (!rt.connectorCache) return null // no probe yet
  return rt.connectorCache.connectors.some(
    (c) => c.source === 'claude.ai' && c.name === 'Slack' && c.status === 'connected',
  )
}

/**
 * GitHub reconciliation (.docs/jobs-v2.md). GitHub is a deterministic source,
 * not an LLM scan, so it stays plain code — but it now writes into the SAME
 * durable store as everything else instead of being refetched-and-discarded
 * every view. Open PRs/issues are upserted (idempotent, newer-wins); a tracked
 * open item whose PR has since merged or closed is auto-done with actor:system
 * and evidence — recorded and reversible, never a silent vanish. Throttled; a
 * failure degrades to a notice and keeps whatever is already stored.
 */
async function reconcileGitHub(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (rt.githubReconcileInFlight) return rt.githubReconcileInFlight
  if (!force && Date.now() - rt.githubReconcileAt < GITHUB_TTL_MS) return
  rt.githubReconcileInFlight = (async () => {
    try {
      const repos = await connectedRepos(rt)
      // Workspace isolation (.docs/workspaces.md): repo scope is per-workspace,
      // and an empty scope means NO GitHub items — not the whole account. An
      // account-wide search would mirror the same PRs into every workspace's
      // inbox, which is exactly the cross-workspace bleed workspaces exist to
      // prevent. You opt each workspace into the repos it should track.
      if (repos.length === 0) {
        rt.githubNotice = null
        rt.githubReconcileAt = Date.now()
        return
      }
      const now = Date.now()
      const open = await fetchGitHub(repos, now)
      for (const item of open) await upsertItem(rt, item)

      // Source-side completion: any tracked open/snoozed github item whose PR is
      // now merged/closed → done(system) with evidence.
      const closed = await fetchGitHubClosed(repos, new Date(now - GITHUB_LOOKBACK_MS).toISOString())
      if (closed.length > 0) {
        const byId = new Map(closed.map((c) => [c.id, c]))
        for (const it of await rt.store.items.listAll()) {
          if (it.source !== 'github') continue
          if (it.status !== 'open' && it.status !== 'snoozed') continue
          const c = byId.get(it.id)
          if (c) {
            const reason = c.state === 'merged' ? 'PR merged' : 'PR closed'
            await rt.store.items.transition(it.id, {
              status: 'done',
              actor: 'system',
              detail: { reason, evidence: c.url },
            })
            log('info', 'github', `auto-done: ${it.id} (${reason})`, { id: it.id, state: c.state, workspace: rt.meta.id })
          }
        }
      }
      rt.githubNotice = null
      rt.githubReconcileAt = Date.now()
      log('info', 'github', `reconciled: ${open.length} open, ${closed.length} closed/merged`, { workspace: rt.meta.id })
    } catch (err) {
      rt.githubNotice = `github: ${err instanceof Error ? err.message : String(err)}`
      log('error', 'github', err instanceof Error ? err.message : String(err), { workspace: rt.meta.id })
    } finally {
      rt.githubReconcileInFlight = null
    }
  })()
  return rt.githubReconcileInFlight
}

/**
 * Rebuild the open-inbox snapshot from the durable store: wake elapsed snoozes,
 * reconcile GitHub (throttled), then rank + link the open items. There is no
 * user-state overlay any more — status lives on each row, so this is a pure
 * fold over what the store already holds.
 */
function syncInbox(rt: WorkspaceRuntime): Promise<InboxSnapshot> {
  if (rt.inboxInFlight) return rt.inboxInFlight
  rt.inboxInFlight = (async () => {
    try {
      const now = Date.now()
      await rt.store.items.wakeSnoozed(now)
      await fadeOldFyi(rt, now)
      await reconcileGitHub(rt)
      const scoped = new Set(await connectedRepos(rt))
      const items = scopeGitHub(await rt.store.items.list('open'), scoped)
      const notices: string[] = []
      if (rt.githubNotice) notices.push(rt.githubNotice)
      // Honest empty state: a workspace with no repos scoped pulls no GitHub —
      // say so, so "nothing here" is never mistaken for "the source is broken".
      if (scoped.size === 0) {
        notices.push('github: no repos scoped to this workspace — pick repos in the inbox’s repo filter to pull PRs and issues here')
      }
      if (slackConnected(rt) === false) {
        notices.push('slack: the claude.ai Slack connector is disconnected — reconnect it for Slack items to appear')
      } else if (slackConnected(rt) === true && (await jobsEnabled(rt))) {
        // Honest empty state: surface any job that failed or has gone overdue,
        // so "nothing here" is never confused with "the scan never looked".
        const enabled = (await rt.store.jobs.list()).filter((w) => w.enabled)
        const overdue = await overdueJobs(rt, enabled, now)
        for (const w of enabled) {
          if (w.lastRunStatus === 'failed') {
            notices.push(`job “${w.title}” last run failed${w.lastRunError ? `: ${w.lastRunError}` : ''}`)
          } else if (overdue.has(w.id)) {
            notices.push(`job “${w.title}” hasn’t completed a run recently — items from it may be missing`)
          }
        }
      }
      const { items: ranked } = buildInbox({ items, notices, now })
      await withFlows(rt, ranked, true)
      const [landedToday, alerts, counts] = await Promise.all([
        rt.store.items.countDoneSince(startOfDay(now)),
        inboxAlerts(rt),
        statusCounts(rt, now),
      ])
      rt.inboxCache = { syncedAt: now, items: ranked, notices, landedToday, alerts, counts }
      void rt.store.inbox.save(rt.inboxCache)
      return rt.inboxCache
    } finally {
      rt.inboxInFlight = null
    }
  })()
  return rt.inboxInFlight
}

/**
 * Archive old FYI nobody touched (core/work/fade.ts). A recorded system
 * transition, so it shows in the item's history and can be reopened.
 */
async function fadeOldFyi(rt: WorkspaceRuntime, now: number): Promise<void> {
  const links = await rt.store.links.list()
  const touched = new Set(links.flatMap((l) => [l.fromKind === 'item' ? l.fromId : '', l.toKind === 'item' ? l.toId : '']))
  const faded = (await rt.store.items.list('open')).filter((i) => shouldArchive(i, now, touched))
  for (const i of faded) {
    await rt.store.items.transition(i.id, {
      status: 'archived',
      actor: 'system',
      detail: { reason: `FYI untouched for ${ARCHIVE_AFTER_DAYS} days` },
    })
  }
  if (faded.length) log('info', 'inbox', `archived ${faded.length} old FYI item(s)`, { ids: faded.map((i) => i.id), workspace: rt.meta.id })
}

/**
 * Drop GitHub items outside this workspace's repo scope (.docs/workspaces.md).
 * Repo scope is per-workspace and empty = none, so a workspace only ever shows
 * PRs/issues from the repos it opted into — even for rows ingested earlier under
 * a wider (or account-wide) scope. Non-destructive: nothing is mutated, so
 * re-scoping a repo makes its items reappear at once. Other sources pass through.
 */
function scopeGitHub<T extends { source: string; repo: string }>(items: T[], scoped: Set<string>): T[] {
  return items.filter((i) => i.source !== 'github' || scoped.has(i.repo))
}

/** Ranked items for a status tab other than the open inbox (read-only, no scan). */
async function listItemsByStatus(rt: WorkspaceRuntime, status: ItemStatus, now = Date.now()): Promise<InboxSnapshot['items']> {
  const scoped = new Set(await connectedRepos(rt))
  const items = scopeGitHub(await rt.store.items.list(status), scoped)
  if (status === 'archived') {
    const deleted = await rt.store.items.deletedIds()
    for (const i of items) if (deleted.has(i.id)) i.deleted = true
  }
  return withFlows(rt, linkByRefs(rank(items, now)), false)
}

/** How many rows each status tab holds — the same scoping and folding its list gets. */
async function statusCounts(rt: WorkspaceRuntime, now: number): Promise<NonNullable<InboxSnapshot['counts']>> {
  const scoped = new Set(await connectedRepos(rt))
  const rows = async (s: ItemStatus) => linkByRefs(rank(scopeGitHub(await rt.store.items.list(s), scoped), now)).length
  const [snoozed, archived] = await Promise.all([rows('snoozed'), rows('archived')])
  return { snoozed, archived }
}

// ---------------------------------------------------------------------------
// Stage and turn (core/work/flow.ts): read the signals around every item — its
// newest brief, its newest dispatched session, its team run, the user's
// override — and derive where it is and whose move it is.
// ---------------------------------------------------------------------------

async function flowSignals(rt: WorkspaceRuntime): Promise<Map<string, FlowSignals>> {
  const [jobs, links, stored] = await Promise.all([rt.store.briefs.list(), rt.store.links.list(), rt.store.items.flowState()])
  const out = new Map<string, FlowSignals>()
  const of = (id: string): FlowSignals => {
    let s = out.get(id)
    if (!s) out.set(id, (s = {}))
    return s
  }
  // newest job per item (list is oldest first, so the last one wins)
  for (const j of [...jobs].sort((a, b) => a.createdAt - b.createdAt)) {
    of(j.itemId).brief = { status: j.status, at: j.finishedAt ?? j.startedAt ?? j.createdAt }
  }
  for (const l of links) {
    if (l.fromKind !== 'session' || l.toKind !== 'item' || l.role !== 'dispatch') continue
    const row = rt.rows.get(l.fromId)
    if (!row || row.kind !== 'chat') continue
    const live = rt.live.get(row.id)
    const sig: SessionSignal = {
      running: live?.status === 'running' || live?.status === 'starting',
      waiting: !!live?.waiting,
      error: live?.status === 'error',
      at: row.updatedAt,
    }
    const s = of(l.toId)
    if (!s.session || sig.at > s.session.at) s.session = sig
  }
  for (const run of rt.teamRuns.values()) {
    const lead = rt.rows.get(run.leadSessionId)
    const at = Math.max(run.createdAt, lead?.updatedAt ?? 0)
    const s = of(run.itemId)
    const asks = run.goal?.questions.filter((q) => q.answer === null).length ?? 0
    if (!s.team || at > s.team.at) s.team = { state: run.state, at, ...(asks ? { asks } : {}), ...(run.goal && run.state === 'done' && !run.goal.acceptedAt ? { toAccept: true } : {}) }
  }
  // Goals with an item: the newest live one per item (done and cancelled hand the item back to the rules).
  for (const g of await rt.store.goals.list({ states: ['draft_plan', 'plan_ready', 'queued', 'running', 'waiting_world', 'waiting_you', 'result_ready', 'paused'] })) {
    if (!g.sourceItemId || g.state === 'done' || g.state === 'cancelled') continue
    const s = of(g.sourceItemId)
    if (!s.goal || g.updatedAt > s.goal.at) s.goal = { state: g.state, at: g.updatedAt }
  }
  for (const [id, f] of stored) if (f.override) of(id).override = f.override
  // Queued actions waiting on you: the item is on your turn until they're answered.
  for (const a of await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })) {
    const itemId = a.itemId ?? rt.sessionItem.get(a.sessionId)
    if (!itemId) continue
    const s = of(itemId)
    const at = a.queue?.queuedAt ?? a.updatedAt
    s.actions = { pending: (s.actions?.pending ?? 0) + 1, at: Math.max(s.actions?.at ?? 0, at) }
  }
  return out
}

/**
 * Put each item's flow on it. For the open inbox (`persist`), a flow that
 * moved since it was last recorded is written back and logged on the item,
 * so its history reads "briefing → ready → working".
 */
async function withFlows<T extends CoreWorkItem & { flow?: ItemFlow }>(rt: WorkspaceRuntime, items: T[], persist: boolean): Promise<T[]> {
  const signals = await flowSignals(rt)
  const stored = persist ? await rt.store.items.flowState() : null
  for (const item of items) {
    item.flow = flowOf(item, signals.get(item.id))
    if (!stored) continue
    const was = stored.get(item.id)
    if (was?.stage === item.flow.stage && was?.turn === item.flow.turn) continue
    await rt.store.items
      .recordFlow(item.id, { stage: item.flow.stage, turn: item.flow.turn }, item.flow.ask ? { ask: item.flow.ask } : {})
      .catch((err) => log('error', 'inbox', `could not record the flow of ${item.id}: ${err}`, { workspace: rt.meta.id }))
  }
  return items
}

/** The flow of one item, at any status — what the item page shows. */
async function flowFor(rt: WorkspaceRuntime, item: CoreWorkItem): Promise<ItemFlow> {
  return flowOf(item, (await flowSignals(rt)).get(item.id))
}

/** Set or clear the stage/turn override on an item. Every change lands in its event log. */
async function setFlowOverrideOp(rt: WorkspaceRuntime, raw: unknown, actor: string): Promise<void> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  if (!(await rt.store.items.get(id))) throw new Error('no such work item')
  if (r.clear === true) {
    await rt.store.items.setFlowOverride(id, null, actor)
  } else {
    if (r.stage !== undefined && !isStage(r.stage)) throw new Error('stage must be one of new, briefing, ready, working, review, done')
    if (r.turn !== undefined && !isTurn(r.turn)) throw new Error('turn must be one of me, ai, others, none')
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 200) : ''
    if (r.stage === undefined && r.turn === undefined && !note) throw new Error('set a stage, a turn or a note — or clear')
    const o: FlowOverride = { at: Date.now() }
    if (isStage(r.stage)) o.stage = r.stage
    if (isTurn(r.turn)) o.turn = r.turn
    if (note) o.note = note
    await rt.store.items.setFlowOverride(id, o, actor)
  }
  invalidateInbox(rt)
}

/** Broken things that aren't items: a job whose last run failed, a team run that paused. */
async function inboxAlerts(rt: WorkspaceRuntime): Promise<InboxAlert[]> {
  const alerts: InboxAlert[] = []
  if (await jobsEnabled(rt)) {
    for (const w of await rt.store.jobs.list()) {
      if (!w.enabled || (w.lastRunStatus !== 'failed' && w.lastRunStatus !== 'timeout')) continue
      alerts.push({
        id: `job:${w.id}`,
        kind: 'job',
        title: `Job “${w.title}” ${w.lastRunStatus === 'timeout' ? 'timed out' : 'failed'}`,
        ...(w.lastRunError ? { detail: w.lastRunError } : {}),
        jobId: w.id,
        at: w.lastRunAt ?? 0,
      })
    }
  }
  for (const run of rt.teamRuns.values()) {
    if (run.state !== 'paused') continue
    alerts.push({
      id: `team:${run.id}`,
      kind: 'team',
      title: `${run.goal ? 'Goal' : 'Team run'} paused: ${run.title}`,
      ...(run.reason ? { detail: run.reason } : {}),
      sessionId: run.leadSessionId,
      at: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
    })
  }
  return alerts.sort((a, b) => b.at - a.at)
}

/**
 * A session dispatched for an item started, stopped or began waiting on you,
 * or a team run changed state: its item's turn moved, so the inbox is stale. Fingerprinted, so the many
 * session-list broadcasts that change nothing here cost nothing.
 */
function noteDispatchedSessions(rt: WorkspaceRuntime): void {
  const fp = [...rt.sessionItem.keys()]
    .filter((sid) => rt.rows.get(sid)?.kind === 'chat')
    .map((sid) => {
      const l = rt.live.get(sid)
      return `${sid}:${l?.status ?? '-'}:${l?.waiting ? 1 : 0}`
    })
    .concat([...rt.teamRuns.values()].map((r) => `team:${r.id}:${r.state}`))
    .join('|')
  if (fp === rt.dispatchFingerprint) return
  const first = rt.dispatchFingerprint === null
  rt.dispatchFingerprint = fp
  if (!first) invalidateInbox(rt)
}

// ---------------------------------------------------------------------------
// Job runs (.docs/jobs-v2.md): one run per job, each a real session so
// its transcript is the run's receipt. A small queue caps concurrency and
// jitters starts so the top of the hour doesn't stampede; a per-job in-flight
// guard turns "already running" into a recorded 'skipped', never a silent no-op.
// The output contract is TOOL CALLS: the run gets a permalink-shaped
// upsert_work_item that stamps identity, kind, and provenance, so a work item
// exists because a tool call created it — no JSON parsing, no cursor-advance-on-
// garbled-output bug. Cursors advance only on a successful run.
// ---------------------------------------------------------------------------
/** Which jobs are overdue — no `ok` ledger row within grace (isOverdue). */
async function overdueJobs(rt: WorkspaceRuntime, jobs: Job[], now: number): Promise<Set<string>> {
  const lastOk = await rt.store.jobRuns.lastOkAt().catch(() => new Map<string, number>())
  return new Set(jobs.filter((w) => isOverdue(scheduleOf(w), w, lastOk.get(w.id), now)).map((w) => w.id))
}

/** The daemon's live status for one workspace, for the System modal. */
/**
 * Where Claude Code keeps its transcripts. The user's own `~/.claude` (or
 * whatever `CLAUDE_CONFIG_DIR` points at), plus the private config dir of
 * every Claude workspace on the `config-dir` auth backend — those sessions are
 * the user's spend too, and they log somewhere else. Claude's only: the usage
 * ledger reads Claude Code's transcript format.
 */
function claudeProjectRoots(): string[] {
  const roots = new Set<string>()
  roots.add(claude.discovery.transcriptDir(undefined))
  for (const ws of loadRegistry().workspaces) {
    if (ws.provider === 'claude' && ws.authBackend === 'config-dir') roots.add(claude.discovery.transcriptDir(envOverridesFor(ws)))
  }
  return [...roots]
}

async function systemStatus(rt: WorkspaceRuntime): Promise<SystemStatus> {
  const now = Date.now()
  const jobs = await rt.store.jobs.list()
  const enabled = jobs.filter((w) => w.enabled)
  return {
    version: VERSION,
    build: BUILD,
    startedAt: SERVER_STARTED,
    uptimeMs: now - SERVER_STARTED,
    port: PORT,
    workspace: rt.meta.name,
    db: dbFileFor(rt.meta.id, registry.defaultId),
    liveSessions: rt.live.size,
    slackConnected: slackConnected(rt),
    connectorsProbedAt: rt.connectorCache?.probedAt ?? null,
    connectorCount: rt.connectorCache?.connectors.length ?? null,
    schedulerLastTickAt: lastSchedulerTickAt,
    runningJobs: rt.runningJobs.size,
    jobsEnabled: await jobsEnabled(rt),
    inboxSyncedAt: rt.inboxCache?.syncedAt ?? null,
    githubReconcileAt: rt.githubReconcileAt || null,
    githubNotice: rt.githubNotice,
    jobs: {
      total: jobs.length,
      enabled: enabled.length,
      overdue: (await overdueJobs(rt, enabled, now)).size,
      failing: enabled.filter((w) => w.lastRunStatus === 'failed' || w.lastRunStatus === 'timeout').length,
      configErrors: jobs.filter((w) => w.configError).length,
    },
    launchAgent: launchAgentInstalled(),
    logDir: logFilePath(),
  }
}

/** One run waiting for a slot in the queue. Waiting keeps its slot: the due
 * rule's clock only moves when the run actually starts. */
type QueuedRun = { id: string; trigger: JobRunTrigger; slot: number }

/**
 * Is every MCP server this job uses up, per the latest probes? Only a server
 * the probe positively reports broken (needs auth, failed, disabled) blocks a
 * run — a server missing from a stale probe gets the benefit of the doubt, and
 * a run that truly can't reach it fails loudly with no-connector-tools.
 */
function jobReady(rt: WorkspaceRuntime, w: Job, project: Project | null): true | string {
  const probes = [rt.connectorCache, project ? rt.folderProbes.get(project.path) : undefined].filter(
    (p): p is ConnectorProbe => p != null,
  )
  if (!probes.length) return true
  for (const g of mcpGrants(w.tools)) {
    const found = probes.flatMap((p) => p.connectors).find((c) => c.server === g.source.server)
    if (found && (found.status === 'needs-auth' || found.status === 'failed' || found.status === 'disabled')) {
      return `${serverLabel(g.source.server)} ${found.status}`
    }
  }
  return true
}

const SKIP_TEXT: Record<SkipReason, string> = {
  overlap: 'previous run still in progress',
  window: 'missed slot older than the catch-up window',
  connector: 'a connector is not available',
}

/**
 * The slot ledger is additive — a failed write must never break a run or a
 * tick, so it is logged and swallowed.
 */
function ledger(rt: WorkspaceRuntime, write: Promise<unknown>): Promise<void> {
  return write.then(
    () => {},
    (err) => log('warn', 'job', `slot ledger write failed: ${err}`, { workspace: rt.meta.id }),
  )
}

/** Record a skipped slot as a run receipt and move the due rule's clock. */
async function recordSkip(rt: WorkspaceRuntime, w: Job, reason: SkipReason, slot: number, detail?: string): Promise<void> {
  const now = Date.now()
  await rt.store.jobs.markRunStarted(w.id, { startedAt: now })
  const error = `skipped (${reason}): ${detail ?? SKIP_TEXT[reason]}`
  await ledger(rt, rt.store.jobRuns.insert({ jobId: w.id, slot, trigger: 'scheduled', status: 'skipped', reason: `${reason}: ${detail ?? SKIP_TEXT[reason]}`, startedAt: now, endedAt: now }))
  await rt.store.jobs.recordRun(w.id, { lastRunAt: now, lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', error })
  log('warn', 'scheduler', `${w.title}: ${error}`, { jobId: w.id, reason, workspace: rt.meta.id })
}

/**
 * The scheduler tick for one workspace (job-spec.md, item 3): decide per
 * job, record skips, queue due runs oldest slot first.
 */
async function runDueJobs(rt: WorkspaceRuntime, now = Date.now()): Promise<void> {
  // The global switch (Settings → Sources) — off means the scheduler never runs a job.
  if (!(await jobsEnabled(rt))) return
  await syncJobFiles(rt).catch(() => {}) // logged by the sync; a bad file never stops the tick
  const projects = await rt.store.projects.list()
  for (const w of await rt.store.jobs.list()) {
    if (!w.enabled || w.configError) continue
    if (rt.runQueue.some((q) => q.id === w.id)) continue // waiting already; keeps its slot
    const project = projects.find((p) => p.id === w.projectId) ?? null
    const d = decide({
      schedule: scheduleOf(w),
      lastRunStartedAt: w.lastRunStartedAt,
      now,
      tickMs: SCHEDULER_TICK_MS,
      running: rt.runningJobs.has(w.id),
      ready: jobReady(rt, w, project),
      catchUp: parseCatchUp(w.catchUpWindow, w.output),
    })
    if (d.action === 'idle') continue
    if (d.action === 'skip') {
      await recordSkip(rt, w, d.reason, d.slot, d.detail)
      continue
    }
    rt.runQueue.push({ id: w.id, trigger: d.trigger, slot: d.slot })
  }
  pumpRunQueue(rt)
}

/**
 * Queue a single job to run now (the per-job "Run" button — a manual run,
 * independent of the schedule). Respects the in-flight guard so a double-click
 * can't start two runs of the same job.
 */
function enqueueJob(rt: WorkspaceRuntime, id: string): 'queued' | 'running' {
  if (rt.runningJobs.has(id)) return 'running'
  if (!rt.runQueue.some((q) => q.id === id)) rt.runQueue.push({ id, trigger: 'manual', slot: Date.now() })
  pumpRunQueue(rt)
  return 'queued'
}

function pumpRunQueue(rt: WorkspaceRuntime): void {
  // oldest slot first, as wakecron does; the rest keep their slot for later
  rt.runQueue.sort((a, b) => a.slot - b.slot)
  while (rt.activeRuns < JOB_CONCURRENCY && rt.runQueue.length > 0) {
    const run = rt.runQueue.shift()!
    if (rt.runningJobs.has(run.id)) continue
    rt.runningJobs.add(run.id)
    rt.activeRuns += 1
    // The due rule's clock moves when the run starts — now, not after the
    // jitter — so a tick in between can't see a stale slot and skip it.
    const startedAt = Date.now()
    const runId = randomUUID()
    void rt.store.jobs.markRunStarted(run.id, { startedAt, trigger: run.trigger })
    void ledger(rt, rt.store.jobRuns.insert({ id: runId, jobId: run.id, slot: run.slot, trigger: run.trigger, status: 'running', startedAt }))
    const jitter = run.trigger === 'manual' ? 0 : Math.floor(Math.random() * 3_000)
    // Keep the Mac awake while the run is out: one that starts on a DarkWake
    // otherwise freezes when the Mac sleeps again seconds later.
    const letGo = power.hold(`job ${run.id}`)
    // The run's slot is freed exactly once: when it settles, or by the
    // watchdog if it hangs past its timeout — else every later slot of this
    // job would skip as overlap until a restart.
    let released = false
    let dog: NodeJS.Timeout | undefined
    let stopRun: (() => void) | undefined
    const release = () => {
      if (released) return
      released = true
      clearTimeout(dog)
      letGo()
      rt.activeRuns -= 1
      rt.runningJobs.delete(run.id)
      pumpRunQueue(rt)
    }
    const arm = (timeoutMs: number) => {
      clearTimeout(dog)
      dog = setTimeout(() => {
        if (released) return
        const reason = `watchdog: still running ${humanSpan(Date.now() - startedAt)} after start, past its ${humanSpan(timeoutMs)} timeout`
        log('error', 'job', `${reason} — stopping it and freeing its slot`, { jobId: run.id, workspace: rt.meta.id })
        // Abort the run (the SDK closes its subprocess) and stop waiting on its stream.
        stopRun?.()
        const end = settleRunStatus('interrupted', sleepWatch.sleptBetween(startedAt, Date.now()), reason)
        void ledger(rt, rt.store.jobRuns.finish(run.id, run.slot, { status: end.status, reason: end.error, endedAt: Date.now() }))
        release()
      }, Math.max(0, startedAt + timeoutMs + WATCHDOG_GRACE_MS - Date.now()))
    }
    // until runJob knows the job's own timeout, the longest one allowed
    arm(MAX_JOB_TIMEOUT_MS)
    setTimeout(() => {
      runJob(rt, run, startedAt, runId, arm, (stop) => (stopRun = stop))
        .catch(async (err) => {
          log('error', 'job', `run crashed: ${err}`, { workspace: rt.meta.id })
          // a no-op when runJob already closed the row
          await ledger(rt, rt.store.jobRuns.finish(run.id, run.slot, { status: 'failed', reason: `run crashed: ${err}`, endedAt: Date.now() }))
        })
        .finally(release)
    }, jitter)
  }
}

/**
 * Identity for a filed item, derived from the link the scanner saw — never from
 * the job. A Slack permalink → slack:<tail>; a GitHub PR/issue URL →
 * github:owner/repo#n; a Linear URL or key → linear:KEY-n. Anything else is
 * rejected: an id we cannot canonicalize cannot dedupe.
 */
function identityFromUrl(raw: string): { id: string; source: WorkSource; url: string; home: string } | null {
  const url = raw.trim()
  if (/\/archives\//.test(url)) return { id: permalinkId(url), source: 'slack', url, home: '' }
  const ref = canonicalizeRef(url)
  if (!ref) return null
  if (ref.startsWith('github:')) {
    const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref)
    if (!m) return null
    const href = url.startsWith('http') ? url : `https://github.com/${m[1]}/issues/${m[2]}`
    return { id: ref, source: 'github', url: href, home: m[1] }
  }
  if (ref.startsWith('linear:')) {
    const key = ref.slice('linear:'.length)
    const href = url.startsWith('http') ? url : `https://linear.app/issue/${key}`
    return { id: ref, source: 'linear', url: href, home: key.slice(0, key.indexOf('-')) }
  }
  if (ref.startsWith('web:')) return { id: ref, source: 'web', url, home: webHost(url) }
  return null
}

function webHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The upsert tool's arguments — shared by the real run and the dry run so the prompt fits both. */
const UPSERT_SHAPE = {
  url: z.string().describe('the canonical link: Slack permalink, Linear issue URL or key, GitHub PR/issue URL, or the web page URL'),
  title: z.string().describe('a one-line summary'),
  place: z.string().optional().describe('where it lives: "#channel", "@dm", a Linear team key, "owner/repo", or the site name'),
  from: z.string().optional().describe('the author or asker'),
  lastActivity: z.string().describe('ISO 8601 timestamp of the newest activity'),
  why: z.string().describe('one line: exactly what matched the instructions'),
  ask: z.enum(LABEL_ORDER as [Label, ...Label[]]).describe('what it asks of the user: review, reply, decide, do, follow-up or read'),
  due: z.string().optional().describe('only when the content states a deadline for the user: the day, ISO 8601 (e.g. 2026-10-12)'),
  refs: z.array(z.string()).optional().describe('other GitHub PR/issue URLs or Linear keys in the content'),
}
const DIGEST_SHAPE = {
  title: z.string().describe('a short name for this edition, e.g. "AI news · 12 Sep"'),
  body: z.string().describe('the whole digest as markdown'),
  refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys cited in the digest'),
}

/**
 * The per-run ingestion tool. Upsert-only, link-shaped: the scanner passes
 * what it can see (a link, title, why, timestamp, refs); the server derives
 * identity from the link and stamps kind and provenance (this job + run). So
 * the model only ADDS candidates and annotates why — lifecycle stays in code.
 */
function makeScanMcp(rt: WorkspaceRuntime, job: Job, runId: string, onUpsert: (outcome: UpsertOutcome) => void) {
  let count = 0
  if (job.output === 'digest') return makeDigestMcp(rt, job, runId, onUpsert)
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools: [
      tool(
        'upsert_work_item',
        'Record ONE match as a work item. Call once per match; the server derives the id from the link and stamps provenance.',
        UPSERT_SHAPE,
        async (args) => {
          try {
            // Cost guard, enforced here not just in the prompt.
            if (count >= MAX_ROWS_PER_RUN) {
              return errResult(`row cap reached (${MAX_ROWS_PER_RUN}) — stop calling this tool`)
            }
            const ident = identityFromUrl(args.url)
            if (!ident) return errResult('url must be a Slack permalink, a Linear issue URL or key, or a GitHub PR/issue URL')
            count += 1
            const now = Date.now()
            const when = safeWhen(args.lastActivity, now)
            const refs = canonicalizeRefs(args.refs)
            const item: CoreWorkItem = {
              id: ident.id,
              source: ident.source,
              kind: job.createsItems ? 'job-hit' : 'fyi',
              title: args.title,
              url: ident.url,
              repo: args.place?.trim() || ident.home,
              author: args.from ?? '',
              peopleWaiting: 0,
              createdAt: when,
              updatedAt: when,
              ask: args.ask,
              ...(parseDue(args.due) != null ? { dueAt: parseDue(args.due)! } : {}),
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { jobId: job.id, runId, at: now, why: args.why }
            const { outcome, reopened } = await upsertItem(rt, item, prov)
            onUpsert(outcome)
            invalidateInbox(rt)
            // The job briefs what it files: the item arrives ready, your turn.
            if (job.brief && (outcome === 'inserted' || reopened)) briefFiledItem(rt, job, item.id, runId)
            log('info', 'job', `filed (${outcome}): ${item.title}`, {
              id: item.id,
              jobId: job.id,
              runId,
              place: item.repo,
              outcome,
              workspace: rt.meta.id,
            })
            // Stateless runs need to hear about repeats (job-spec.md, item 4).
            if (outcome === 'inserted') return okResult(`new: filed ${item.id}`)
            if (reopened) return okResult(`already filed; it was done and has returned to the inbox: ${item.id}`)
            const status = (await rt.store.items.get(item.id))?.status ?? 'open'
            return okResult(
              status === 'open'
                ? `already filed and open: ${item.id}. Do not count it as new; move on to the next candidate.`
                : `already filed, ${status}: ${item.id}`,
            )
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

/** The one file a digest job rewrites: stable per job, so writeAt updates in place. */
const digestRelPath = (job: Job): string => `reports/${slug(job.title) || 'digest'}-${job.id.slice(0, 8)}.md`

/**
 * The digest job's write tool. One call per run: the server rewrites the
 * job's report artifact in place, upserts the job's single rolling item
 * (id `job:<id>`) with a fresh timestamp — so a done item returns with the
 * "returned" marker — and links report → item. The model writes prose; code
 * owns identity, lifecycle and the link, as everywhere else.
 */
function makeDigestMcp(rt: WorkspaceRuntime, job: Job, runId: string, onWrite: (outcome: UpsertOutcome) => void) {
  let written = false
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools: [
      tool(
        'write_digest',
        'Save this run’s digest: ONE markdown report. Call exactly once with the whole document.',
        DIGEST_SHAPE,
        async (args) => {
          try {
            if (written) return errResult('the digest was already written this run — stop calling this tool')
            const title = args.title.trim() || `${job.title} · ${new Date().toLocaleDateString()}`
            const refs = canonicalizeRefs(args.refs)
            const artifact = await rt.artifacts.writeAt(digestRelPath(job), {
              title,
              body: args.body,
              author: 'model',
              ...(refs ? { refs } : {}),
            })
            const nowIso = new Date().toISOString()
            const item: CoreWorkItem = {
              id: `job:${job.id}`,
              source: 'job',
              kind: 'digest',
              title,
              url: `#/artifact/${artifact.id}`,
              repo: job.title,
              author: '',
              peopleWaiting: 0,
              createdAt: nowIso,
              updatedAt: nowIso,
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { jobId: job.id, runId, at: Date.now(), why: 'digest rewritten' }
            const { outcome, reopened } = await upsertItem(rt, item, prov)
            await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: item.id, role: 'report' })
            written = true
            onWrite(outcome)
            invalidateInbox(rt)
            log('info', 'job', `digest written (${outcome}${reopened ? ', returned' : ''}): ${title}`, { id: item.id, jobId: job.id, runId, artifact: artifact.path, workspace: rt.meta.id })
            return okResult(`ok: digest saved as ${artifact.path}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

type JobPreview = {
  id: string
  status: 'running' | 'ready' | 'failed'
  /** the transcript, minus stream deltas — replayed to late subscribers like a session's log */
  events: SessionEvent[]
  result?: JobPreviewResult
  error?: string
  startedAt: number
}
const PREVIEW_TTL_MS = 15 * 60_000

/** What a run (real or dry) is made of: the job as saved, or the form as it stands. */
type RunSpec = {
  instruction: string
  tools: JobToolGrant[]
  project: Project
  model?: string
  output: JobOutput
  schedule: string
  scope?: string
  lateness?: string
  /** the skills and agents the job names, as Claude calls them */
  skills?: string[]
  agents?: string[]
}

type PreviewSpec = Omit<RunSpec, 'project'> & { projectId: string }

// ---------------------------------------------------------------------------
// Folder MCP servers (job-spec.md, item 1): the `project` servers in a
// folder's .mcp.json and the user's private `local` servers for that folder
// (in Claude's own config). Read by triage and passed explicitly — never by
// loading the project's settings, which would also load its hooks, and hooks
// are shell commands that would run unattended.
// ---------------------------------------------------------------------------

type FolderMcp = { servers: McpServers; scopes: Map<string, 'project' | 'local'> }

/** `${VAR}` / `${VAR:-default}` in .mcp.json strings, from the run's environment. */
function expandEnv(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === 'string') return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k: string, d?: string) => env[k] ?? d ?? '')
  if (Array.isArray(v)) return v.map((x) => expandEnv(x, env))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x, env)]))
  return v
}

async function folderMcpServers(rt: WorkspaceRuntime, cwd: string): Promise<FolderMcp> {
  const env = { ...process.env, ...(rt.env ?? {}) }
  const out: FolderMcp = { servers: {}, scopes: new Map() }
  const add = (raw: unknown, scope: 'project' | 'local') => {
    if (!raw || typeof raw !== 'object') return
    for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue
      out.servers[name] = expandEnv(cfg, env) as McpServers[string]
      out.scopes.set(name, scope)
    }
  }
  const configured = await rt.provider.discovery.configuredMcp({ cwd, env: rt.env })
  add(configured.project, 'project')
  add(configured.local[cwd], 'local') // private per-folder servers win over the shared file, as in Claude Code
  delete out.servers.triage // our own in-process server owns that name
  return out
}

/**
 * Local-scope MCP servers the user configured for other folders (names only,
 * never their config). A job runs in one folder, so these aren't usable
 * here — but listing them tells the user which project to pick instead.
 */
async function localServersElsewhere(rt: WorkspaceRuntime, cwd: string, here: Connector[]): Promise<Array<{ name: string; folder: string }>> {
  const { local } = await rt.provider.discovery.configuredMcp({ cwd, env: rt.env })
  const have = new Set(here.map((c) => c.server))
  const out: Array<{ name: string; folder: string }> = []
  for (const [folder, servers] of Object.entries(local)) {
    if (folder === cwd) continue
    for (const name of Object.keys(servers)) if (!have.has(name)) out.push({ name, folder })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder))
}

/** The workspace's default run limits, under a job's own. */
async function jobLimits(rt: WorkspaceRuntime, w: { timeoutMs?: number; maxBudgetUsd?: number }): Promise<{ timeoutMs: number; maxBudgetUsd?: number }> {
  const s = await readSettings(rt)
  const budget = w.maxBudgetUsd ?? s.jobBudgetUsd ?? undefined
  return { timeoutMs: w.timeoutMs ?? s.jobTimeoutMs, ...(budget != null ? { maxBudgetUsd: budget } : {}) }
}

/**
 * The run spec every job run shares, real or dry. Same prompt, same fence:
 * built-in tools limited to what the grants need, the allowlist so granted
 * tools never prompt, unattended so nothing else ever does, and the fence as a
 * veto so nothing else ever runs — whatever the user's own global allow rules
 * say. Runs work in the project folder and nowhere else.
 */
async function jobQuery(
  rt: WorkspaceRuntime,
  spec: RunSpec,
  triage: McpServers[string],
  abort: AbortController,
  extra: { maxBudgetUsd?: number; includePartialMessages?: boolean } = {},
): Promise<AgentRunSpec> {
  // The fence below is the whole safety story: no veto, no run.
  requireVeto(rt.provider, 'job')
  const folder = await folderMcpServers(rt, spec.project.path)
  const granted = new Set(mcpGrants(spec.tools).map((g) => g.source.server))
  const folderServers = Object.fromEntries(Object.entries(folder.servers).filter(([name]) => granted.has(name)))
  // Servers the user has connected but this job wasn't granted still load
  // from their settings; take their tools out of the run's context entirely
  // (the fence would deny them anyway). Known from the latest probes.
  // A run right after boot can beat the first probe; wait for it (a few seconds, no API turn).
  const home = rt.connectorCache ?? (await probeConnectors(rt).catch(() => null))
  const known = [...(rt.folderProbes.get(spec.project.path)?.connectors ?? []), ...(home?.connectors ?? [])]
  const ungranted = [...new Set(known.map((c) => c.server))].filter((srv) => !granted.has(srv) && srv !== RESERVED_SERVER)
  const disallowedTools = ungranted.map((srv) => mcpToolName(srv, '').replace(/__$/, ''))
  const now = Date.now()
  const prompt = composeRunPrompt({
    instruction: spec.instruction,
    tools: spec.tools,
    project: { name: spec.project.name, path: spec.project.path },
    output: spec.output,
    lookbackMs: lookbackMs(spec.schedule, now),
    nowIso: new Date(now).toISOString(),
    ...(spec.scope ? { scope: spec.scope } : {}),
    ...(spec.lateness ? { lateness: spec.lateness } : {}),
    ...(spec.skills?.length ? { skills: spec.skills } : {}),
    ...(spec.agents?.length ? { agents: spec.agents } : {}),
  })
  // A job's skills and agents: only the ones it names load, checked again
  // here — the library may have changed since the file was. The workspace
  // library comes in as its plugin only when the job names something in it.
  const skills = spec.skills ?? []
  const agents = spec.agents ?? []
  if (skills.length || agents.length) {
    const missing = checkLibrary({ skills, agents }, await jobLibrary(rt))
    if (missing.length) throw new Error(missing.join('; '))
  }
  const extraTools = [...(skills.length ? ['Skill'] : []), ...(agents.length ? ['Agent'] : [])]
  const fromLibrary = [...skills, ...agents].some((n) => n.startsWith(`${WORKSPACE_PLUGIN}:`))
  const fence = fenceFor(spec.tools, spec.output, spec.project.path, { skills, agents })
  return {
    prompt,
    // A job run is Junior's too: its name and voice, and the one rule an unattended run can keep.
    systemAppend: personaAppend(rt.persona, 'job'),
    cwd: spec.project.path,
    userConfig: true,
    tools: [...runBaseTools(spec.tools), ...extraTools],
    allowedTools: [...runAllowedTools(spec.tools, spec.output), ...extraTools],
    ...(skills.length ? { skills } : {}),
    ...(fromLibrary ? { plugins: [rt.libraryDir] } : {}),
    ...(disallowedTools.length ? { disallowedTools } : {}),
    unattended: true,
    veto: (toolName, input) => fenceDecision(fence, toolName, input),
    ...(spec.model ? { model: spec.model } : {}),
    ...(extra.maxBudgetUsd != null ? { maxBudgetUsd: extra.maxBudgetUsd } : {}),
    ...(extra.includePartialMessages ? { streamDeltas: true } : {}),
    mcpServers: { ...folderServers, triage },
    abort,
    ...(rt.env ? { env: rt.env } : {}),
  }
}

/** The project a job runs in, checked: a removed project or a missing folder is an error, never a fallback. */
async function jobProject(rt: WorkspaceRuntime, projectId: string): Promise<Project> {
  const project = (await rt.store.projects.list()).find((p) => p.id === projectId)
  if (!project) throw new Error('project removed — pick another project for this job')
  const st = await stat(project.path).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`folder not found: ${project.path}`)
  return project
}

const noConnectorError = (tools: JobToolGrant[]) =>
  `no connector tools — connect ${tools.map(grantLabel).join(', ')} for Claude (claude.ai/settings/connectors, or the project's MCP config)`

/**
 * Start a dry run of a job as the form currently describes it. Same prompt,
 * tools and fences as a real run; the write tool only collects. The run is
 * streamed over the WebSocket under an ephemeral session id so the form can
 * show the transcript live, but nothing is persisted — no session row, no
 * events, no items, no artifact. The caller polls for the outcome.
 */
function startJobPreview(rt: WorkspaceRuntime, spec: PreviewSpec): string {
  const pv: JobPreview = { id: randomUUID(), status: 'running', events: [], startedAt: Date.now() }
  rt.previews.set(pv.id, pv)
  void runJobPreview(rt, pv, spec)
  return pv.id
}

async function runJobPreview(rt: WorkspaceRuntime, pv: JobPreview, spec: PreviewSpec): Promise<void> {
  const emit = (event: SessionEvent, keep = true) => {
    if (keep) pv.events.push(event)
    broadcast(rt, { type: 'session_event', sessionId: pv.id, event, at: Date.now() })
  }
  const rows: JobPreviewRow[] = []
  const wouldQueue: Array<{ tool: string; summary: string }> = []
  let digest: { title: string; body: string } | undefined
  const collector = createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools:
      spec.output === 'digest'
        ? [
            tool('write_digest', 'Save this run’s digest: ONE markdown report. Call exactly once with the whole document.', DIGEST_SHAPE, async (args) => {
              if (digest) return errResult('the digest was already written this run — stop calling this tool')
              digest = { title: args.title.trim() || 'Digest', body: args.body }
              return okResult('ok: digest recorded')
            }),
          ]
        : [
            tool('upsert_work_item', 'Record ONE match as a work item. Call once per match; the server derives the id from the link.', UPSERT_SHAPE, async (args) => {
              if (rows.length >= MAX_ROWS_PER_RUN) return errResult(`row cap reached (${MAX_ROWS_PER_RUN}) — stop calling this tool`)
              const ident = identityFromUrl(args.url)
              if (!ident) return errResult('url must be a Slack permalink, a Linear issue URL or key, a GitHub PR/issue URL, or a web page URL')
              if (rows.some((r) => r.id === ident.id)) return okResult(`already filed and open: ${ident.id}. Do not count it as new; move on to the next candidate.`)
              const existing = await rt.store.items.get(ident.id).catch(() => null)
              rows.push({
                id: ident.id,
                title: args.title,
                url: ident.url,
                place: args.place?.trim() || ident.home,
                from: args.from ?? '',
                lastActivity: safeWhen(args.lastActivity, Date.now()),
                why: args.why,
                ask: args.ask,
              })
              return okResult(existing ? `already filed, ${existing.status}: ${ident.id}` : `new: filed ${ident.id}`)
            }),
          ],
  })
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let tokens = 0
  let costUsd: number | undefined
  let resultText = ''
  let sawResult = false
  try {
    const project = await jobProject(rt, spec.projectId)
    const limits = await jobLimits(rt, {})
    timer = setTimeout(() => abort.abort(), limits.timeoutMs)
    const previewSpec = await jobQuery(rt, { ...spec, project }, collector, abort, { ...limits, includePartialMessages: true })
    // A dry run never sends: past the fence, anything that counts as an action
    // (a connector write, an outbound command) is refused and listed instead.
    const fence = previewSpec.veto
    if (fence) {
      previewSpec.veto = (toolName, input, ctx) => {
        const d = fence(toolName, input, ctx)
        if (!d.allow) return d
        const args = isArgsObject(input) ? input : {}
        let sorted = null
        try {
          sorted = sortForWorkspace(rt)(toolName, args)
        } catch {
          // can't tell: refuse, a dry run loses nothing by it
          sorted = { summary: toolName }
        }
        const out = dryRunDecision(sorted)
        if (!out.allow && sorted && wouldQueue.length < 50) wouldQueue.push({ tool: toolName, summary: sorted.summary })
        return out
      }
    }
    const q = rt.provider.run(previewSpec)
    for await (const ev of q) {
      emit({ kind: 'sdk', message: ev.record }, ev.kind !== 'stream')
      if (ev.kind === 'result') {
        sawResult = true
        resultText = ev.text
        tokens = ev.tokens
        if (ev.costUsd != null) costUsd = ev.costUsd
      }
    }
    if (resultText.includes('no-connector-tools')) throw new Error(noConnectorError(spec.tools))
    if (!sawResult) throw new Error(abort.signal.aborted ? 'the preview timed out' : 'the preview ended without a result')
    pv.result = { output: spec.output, rows, ...(digest ? { digest } : {}), ...(wouldQueue.length ? { wouldQueue } : {}), tokens, ...(costUsd != null ? { costUsd } : {}), durationMs: Date.now() - pv.startedAt }
    pv.status = 'ready'
    log('info', 'job', `preview: ${rows.length} row(s)${digest ? ', digest' : ''}, ${Math.round(tokens / 1000)}k tok`, { previewId: pv.id, workspace: rt.meta.id })
  } catch (err) {
    pv.error = err instanceof Error ? err.message : String(err)
    pv.status = 'failed'
    emit({ kind: 'error', message: pv.error })
    log('warn', 'job', `preview failed: ${pv.error}`, { previewId: pv.id, workspace: rt.meta.id })
  } finally {
    if (timer) clearTimeout(timer)
    setTimeout(() => rt.previews.delete(pv.id), PREVIEW_TTL_MS).unref()
  }
}

/** A macOS notification about a finished run, per the job's notify setting. */
function notifyRun(rt: WorkspaceRuntime, w: Job, status: JobRunStatus, detail?: string): void {
  if (process.platform !== 'darwin' || w.notify === 'never') return
  const failed = status === 'failed' || status === 'timeout'
  if (w.notify === 'on_failure' && !failed) return
  if (!failed && status !== 'ok') return
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const text = failed ? `${w.title} ${status === 'timeout' ? 'timed out' : 'failed'}${detail ? `: ${detail.slice(0, 120)}` : ''}` : `${w.title}: ${detail ?? 'ok'}`
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q('triage')}`], (err) => {
    if (err) log('warn', 'job', `notification failed: ${err.message}`, { jobId: w.id, workspace: rt.meta.id })
  })
}

/**
 * Run one job to completion as a headless session. Persists the transcript to
 * the event log (so it is observable like any session) and records the run's
 * receipt on the job row and its own session row. Stateless (job-spec.md,
 * item 4): nothing from this run feeds the next one's prompt.
 */
async function runJob(
  rt: WorkspaceRuntime,
  run: QueuedRun,
  startedMs: number,
  runId: string,
  armWatchdog: (timeoutMs: number) => void = () => {},
  onStop: (stop: () => void) => void = () => {},
): Promise<void> {
  const job = await rt.store.jobs.get(run.id)
  if (!job) {
    await ledger(rt, rt.store.jobRuns.finish(run.id, run.slot, { status: 'skipped', reason: 'the job was removed', endedAt: Date.now() }))
    return
  }
  // A catch-up run stands in for every slot it slept through: each gets a
  // `missed` row pointing at this run, so the gap shows in the ledger.
  // It is also told how late it is, so it covers the gap and skips what's stale.
  let lateness: string | undefined
  if (run.trigger === 'catch_up') {
    const missed = missedSlots(scheduleOf(job), run.slot, startedMs)
    if (missed.length) await ledger(rt, rt.store.jobRuns.insertMissed(job.id, missed, runId, startedMs))
    lateness = describeLateness(run.slot, missed, startedMs) ?? undefined
  }
  // The daily budget: over it, the slot is a `skipped_budget` row and no run;
  // under it, this run may spend at most what is left of the day.
  const limits = await jobLimits(rt, job)
  const spent = job.dailyBudgetUsd != null ? await rt.store.jobRuns.spentSince(job.id, localMidnight(startedMs)) : 0
  const budget = budgetFor(limits.maxBudgetUsd, job.dailyBudgetUsd, spent)
  if (budget.skip) {
    const now = Date.now()
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status: 'skipped_budget', reason: budget.reason, endedAt: now }))
    await rt.store.jobs.recordRun(job.id, { lastRunAt: now, lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', trigger: run.trigger, error: `skipped (budget): ${budget.reason}` })
    log('warn', 'job', `${job.title}: skipped, ${budget.reason}`, { jobId: job.id, workspace: rt.meta.id })
    return
  }
  const runLimits = { timeoutMs: limits.timeoutMs, ...(budget.maxBudgetUsd != null ? { maxBudgetUsd: budget.maxBudgetUsd } : {}) }
  armWatchdog(runLimits.timeoutMs)
  const projectRow = (await rt.store.projects.list()).find((p) => p.id === job.projectId) ?? null
  if (!projectRow) {
    // The project went away: pause with a config error, never fall back to another folder.
    await rt.store.jobs.patchState(job.id, { enabled: false, configError: 'project removed — pick another project for this job' })
    await rt.store.jobs.recordRun(job.id, { lastRunAt: Date.now(), lastRunTokens: 0, lastRunMatches: 0, status: 'skipped', trigger: run.trigger, error: 'skipped: the job has no project' })
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status: 'skipped', reason: 'the job has no project', endedAt: Date.now() }))
    log('warn', 'job', `paused ${job.title}: its project was removed`, { jobId: job.id, workspace: rt.meta.id })
    return
  }
  const session = await rt.store.sessions.create({
    id: randomUUID(),
    title: `Job · ${job.title}`,
    cwd: projectRow.path,
    projectId: projectRow.id,
    kind: 'job-run',
    jobId: job.id,
    runTrigger: run.trigger,
  })
  rt.rows.set(session.id, session)
  await rt.store.jobs.markRunStarted(job.id, { startedAt: startedMs, trigger: run.trigger, sessionId: session.id })
  await ledger(rt, rt.store.jobRuns.attachSession(job.id, run.slot, session.id))
  broadcastSessionList(rt)
  log('info', 'job', `run started: ${job.title} (${run.trigger})`, { jobId: job.id, runId: session.id, tools: job.tools.map(grantLabel), project: projectRow.name, model: job.model, workspace: rt.meta.id })

  let seq = 0
  const emit = (event: SessionEvent, persist = true) => {
    if (persist) {
      seq += 1
      rt.store.events.append(session.id, seq, event).catch(() => {})
      noteActionEvent(rt, session, event)
    }
    broadcast(rt, { type: 'session_event', sessionId: session.id, event })
  }

  let matches = 0
  let newCount = 0
  let tokens = 0
  let costUsd: number | undefined
  let status: JobRunStatus = 'failed'
  let error: string | undefined
  let timedOut = false
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  // The hard stop: the loop below stops waiting on the run's stream, so a run
  // past its timeout is always recorded, even when the stream never closes.
  let hardStop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => (hardStop = resolve))
  onStop(() => {
    abort.abort()
    hardStop()
  })
  const scanMcp = makeScanMcp(rt, job, session.id, (outcome) => {
    matches += 1
    if (outcome === 'inserted') newCount += 1
  })

  try {
    const project = await jobProject(rt, job.projectId)
    timer = setTimeout(() => {
      timedOut = true
      // The SDK closes the subprocess on abort (stdin EOF, then a kill); a
      // stream still open past the grace is let go.
      abort.abort()
      killTimer = setTimeout(hardStop, RUN_KILL_GRACE_MS)
    }, runLimits.timeoutMs)
    const runSpec = await jobQuery(
      rt,
      { instruction: job.instruction, tools: job.tools, project, model: job.model, output: job.output, schedule: scheduleOf(job), scope: job.scope, lateness, skills: job.skills, agents: job.agents },
      scanMcp,
      abort,
      runLimits,
    )
    // Past the fence, an outbound connector call is held for you, not run
    // (core/actions/queue.ts). Dry runs (previews) never hold: they record nothing.
    const fence = runSpec.veto
    if (fence) {
      runSpec.veto = (toolName, input, ctx) => {
        const d = fence(toolName, input, ctx)
        return d.allow ? holdIfAction(rt, session, toolName, input, ctx) : d
      }
    }
    const q = rt.provider.run(runSpec)
    let sawResult = false
    let resultText = ''
    let overBudget = false
    for await (const ev of untilStopped(q, stopped)) {
      if (ev.kind === 'started' && ev.sessionId) {
        session.sdkSessionId = ev.sessionId
        rt.store.sessions.setSdkSessionId(session.id, ev.sessionId).catch(() => {})
      }
      emit({ kind: 'sdk', message: ev.record }, ev.kind !== 'stream')
      if (ev.kind === 'result') {
        sawResult = true
        resultText = ev.text
        overBudget = ev.overBudget
        tokens = ev.tokens
        if (ev.costUsd != null) costUsd = ev.costUsd
      }
    }
    if (overBudget) throw new Error(`budget cap reached ($${runLimits.maxBudgetUsd?.toFixed(2)})`)
    if (resultText.includes('no-connector-tools') || resultText.includes('no-slack-tools')) throw new Error(noConnectorError(job.tools))
    if (!sawResult) throw new Error('scan ended without a result')
    status = 'ok'
  } catch (err) {
    if (timedOut) {
      status = 'timeout'
      error = `timed out after ${humanSpan((await jobLimits(rt, job)).timeoutMs)}${err instanceof HardStop ? ', and stopped' : ''}`
    } else if (err instanceof HardStop) {
      status = 'interrupted'
      error = 'stopped by the watchdog'
    } else {
      error = err instanceof Error ? err.message : String(err)
    }
    // A run the Mac slept through is `slept`, not a failure of the job.
    ;({ status, error } = settleRunStatus(status, sleepWatch.sleptBetween(startedMs, Date.now()), error))
    emit({ kind: 'error', message: error ?? status })
  } finally {
    if (timer) clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    await rt.store.jobs.recordRun(job.id, {
      lastRunAt: Date.now(),
      lastRunTokens: tokens,
      lastRunMatches: matches,
      lastRunNew: newCount,
      status,
      trigger: run.trigger,
      sessionId: session.id,
      error,
    })
    await ledger(rt, rt.store.jobRuns.finish(job.id, run.slot, { status, reason: error, sessionId: session.id, endedAt: Date.now(), costUsd }))
    // the run's own receipt, on its session row — powers the Activity view
    session.runStatus = status
    session.runMatches = matches
    session.runNew = newCount
    session.runTokens = tokens
    session.runCostUsd = costUsd
    session.runError = error
    session.updatedAt = Date.now()
    await rt.store.sessions.recordJobRun(session.id, { status, matches, newCount, tokens, costUsd, error })
    log(
      status === 'ok' ? 'info' : 'error',
      'job',
      `run ${status}: ${job.title}${status === 'ok' ? ` — ${newCount} new, ${matches - newCount} already filed, ${Math.round(tokens / 1000)}k tok${costUsd != null ? `, $${costUsd.toFixed(2)}` : ''}` : ''}${error ? ` — ${error}` : ''}`,
      { jobId: job.id, runId: session.id, status, trigger: run.trigger, matches, newCount, tokens, durationMs: Date.now() - startedMs, workspace: rt.meta.id, ...(error ? { error } : {}) },
    )
    rt.actionTrackers.delete(session.id)
    // Notes on an action sent back while the run was still going reach it now.
    void deliverPendingSendBacks(rt, session.id)
    notifyRun(rt, job, status, status === 'ok' ? `${newCount} new` : error)
    if (status === 'ok') {
      invalidateInbox(rt)
      void syncInbox(rt)
    }
    broadcastSessionList(rt)
  }
}

/**
 * Boot: a job run still without a final status died with the previous
 * process. Mark it interrupted — on its session and, when it was the job's
 * latest run, on the job — instead of leaving it "running" forever. No
 * retry: the next run's look-back window overlaps the lost one.
 */
async function markInterruptedRuns(rt: WorkspaceRuntime): Promise<void> {
  const error = 'interrupted: triage stopped during the run'
  await ledger(rt, rt.store.jobRuns.sweepInterrupted(Date.now(), error))
  for (const row of rt.rows.values()) {
    if (row.kind !== 'job-run' || row.runStatus) continue
    const events = await rt.store.events.read(row.id)
    const seq = events.length ? events[events.length - 1].seq : 0
    await rt.store.events.append(row.id, seq + 1, { kind: 'error', message: error })
    await rt.store.sessions.recordJobRun(row.id, { status: 'interrupted', matches: row.runMatches ?? 0, tokens: row.runTokens ?? 0, error })
    row.runStatus = 'interrupted'
    row.runError = error
    const w = row.jobId ? await rt.store.jobs.get(row.jobId) : null
    if (w && w.lastRunSessionId === row.id) {
      await rt.store.jobs.recordRun(w.id, { lastRunAt: row.updatedAt, lastRunTokens: 0, lastRunMatches: 0, status: 'interrupted', sessionId: row.id, error })
    }
    log('warn', 'job', `marked interrupted: ${row.title}`, { runId: row.id, jobId: row.jobId, workspace: rt.meta.id })
  }
}

/**
 * Pre-installed job templates (.docs/jobs-v2.md): the old built-in Slack
 * rules, shipped as data and seeded as editable copies on first run. A user can
 * disable, edit, or duplicate them; a `templateId` marks the origin.
 */
const JOB_TEMPLATES: Array<
  Pick<Job, 'title' | 'instruction' | 'schedule' | 'cadence' | 'createsItems' | 'tools'> & { templateId: string }
> = [
  {
    templateId: 'unread-dms',
    title: 'Unread DMs',
    tools: [presetGrant('claude.ai Slack')!],
    instruction: 'Look through my unread Slack direct messages. File each unanswered one that asks something of me.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
  {
    templateId: 'mentions',
    title: 'Mentions',
    tools: [presetGrant('claude.ai Slack')!],
    instruction: 'Find Slack messages where I am mentioned or tagged and my reply is still awaited. File each one.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
]

const NEEDS_PROJECT = 'pick the project this job runs in'

/**
 * Every job runs in a project folder (job-spec.md, item 2) and there is no
 * fallback folder. A job without one — saved before the rule, its project
 * since removed, or left in the retired scratch project — pauses with a config
 * error until the user picks a project. It never runs somewhere else.
 */
async function migrateJobProjects(rt: WorkspaceRuntime): Promise<void> {
  // Retire the scratch projects a dev build created, and their folders if still empty.
  for (const p of await rt.store.projects.retireBuiltin()) {
    await rmdir(p.path).catch(() => {}) // only succeeds on an empty folder
    log('info', 'job', `removed the retired scratch project ${p.path}`, { workspace: rt.meta.id })
  }
  const projects = await rt.store.projects.list()
  for (const w of await rt.store.jobs.list()) {
    if (w.file) continue // a file job's project is checked on every sync
    if (w.projectId && projects.some((p) => p.id === w.projectId)) continue
    if (w.configError && !w.enabled) continue
    await rt.store.jobs.patchState(w.id, { projectId: null, enabled: false, configError: NEEDS_PROJECT })
    log('info', 'job', `paused "${w.title}": it has no project — pick one to run it`, { jobId: w.id, workspace: rt.meta.id })
  }
}

/** The built-in templates as job files: paused, asking for a project. */
const JOB_TEMPLATE_FILES: Record<string, JobFileSpec> = Object.fromEntries(
  JOB_TEMPLATES.map((t) => [
    t.templateId,
    { id: `template-${t.templateId}`, title: t.title, schedule: t.schedule, project: '', tools: t.tools, output: 'items', notify: 'on_failure', enabled: false, instruction: t.instruction },
  ]),
)

/**
 * Install the built-in templates as files in `jobs/`, tracked in its
 * `.seeded.json` (teams' pattern): an untouched one follows upgrades, an edited
 * one is the user's, a deleted one stays deleted.
 */
async function seedJobTemplates(rt: WorkspaceRuntime): Promise<void> {
  await rt.jobFiles.seed(JOB_TEMPLATE_FILES)
  await syncJobFiles(rt, { force: true })
}

/** A row saved before job files: shown, never run, until it is saved as a file. */
const LEGACY_JOB = 'saved before job files — open it and Save to move it into jobs/, or recreate it'

/** A job file's spec → the row's config columns. */
function jobConfigFrom(spec: JobFileSpec, file: string) {
  return {
    title: spec.title,
    instruction: spec.instruction,
    schedule: spec.schedule,
    tools: spec.tools,
    projectId: spec.project,
    model: spec.model,
    output: spec.output,
    catchUpWindow: spec.catchUp ?? null,
    timeoutMs: spec.timeoutMs ?? null,
    maxBudgetUsd: spec.budgetUsd ?? null,
    dailyBudgetUsd: spec.dailyBudgetUsd ?? null,
    notify: spec.notify,
    enabled: spec.enabled,
    brief: spec.brief ?? null,
    draft: !!spec.draft,
    skills: spec.skills ?? null,
    agents: spec.agents ?? null,
    file,
  }
}

/** A job (row or patched row) → the file that says the same. */
function jobSpecFrom(w: Job): JobFileSpec {
  return {
    id: w.id,
    title: w.title,
    schedule: scheduleOf(w),
    project: w.projectId ?? '',
    tools: w.tools,
    ...(w.model ? { model: w.model } : {}),
    output: w.output,
    ...(w.catchUpWindow ? { catchUp: w.catchUpWindow } : {}),
    ...(w.timeoutMs != null ? { timeoutMs: w.timeoutMs } : {}),
    ...(w.maxBudgetUsd != null ? { budgetUsd: w.maxBudgetUsd } : {}),
    ...(w.dailyBudgetUsd != null ? { dailyBudgetUsd: w.dailyBudgetUsd } : {}),
    notify: w.notify,
    enabled: w.enabled,
    ...(w.brief ? { brief: w.brief } : {}),
    // enabling a draft is its review
    ...(w.draft && !w.enabled ? { draft: true } : {}),
    ...(w.skills?.length ? { skills: w.skills } : {}),
    ...(w.agents?.length ? { agents: w.agents } : {}),
    instruction: w.instruction,
  }
}

type JobConfig = ReturnType<typeof jobConfigFrom>
const configKey = (w: Pick<Job, Exclude<keyof JobConfig, 'catchUpWindow' | 'timeoutMs' | 'maxBudgetUsd' | 'dailyBudgetUsd' | 'brief' | 'draft' | 'skills' | 'agents'>> & {
  catchUpWindow?: string | null
  timeoutMs?: number | null
  maxBudgetUsd?: number | null
  dailyBudgetUsd?: number | null
  brief?: JobBrief | null
  draft?: boolean
  skills?: string[] | null
  agents?: string[] | null
}) =>
  JSON.stringify([
    w.title, w.instruction, w.schedule, w.tools, w.projectId || '', w.model ?? null, w.output, w.catchUpWindow ?? null,
    w.timeoutMs ?? null, w.maxBudgetUsd ?? null, w.dailyBudgetUsd ?? null, w.notify, w.enabled, w.file ?? null,
    w.brief ? [w.brief.model ?? null, w.brief.template ?? null] : null, !!w.draft,
    w.skills?.length ? w.skills : null, w.agents?.length ? w.agents : null,
  ])

/**
 * Bring the rows in line with `jobs/*.md`. Cheap when nothing moved: it
 * re-reads only when a file, the project list or a connector probe changed
 * (or `force`). A file is never trusted blindly — anything that fails the
 * schema, names a missing project or a tool the probe doesn't know becomes a
 * config error on its row, which holds the job; it never throws. A file
 * without an id (hand-written) or with a copied one gets its own, written
 * back. A row whose file is gone is deleted like any job; a row from before
 * files is held as legacy.
 */
function syncJobFiles(rt: WorkspaceRuntime, opts: { force?: boolean; deferFirstRun?: string } = {}): Promise<void> {
  const run = rt.jobSync.then(() => syncJobFilesNow(rt, opts))
  rt.jobSync = run.catch((err) => log('error', 'job', `job file sync failed: ${err}`, { workspace: rt.meta.id }))
  return run
}

async function syncJobFilesNow(rt: WorkspaceRuntime, { force = false, deferFirstRun }: { force?: boolean; deferFirstRun?: string }): Promise<void> {
  const files = await rt.jobFiles.scan()
  const projects = await rt.store.projects.list()
  // only listed when a job names a skill or an agent — a skill removed later holds that job at the next tick
  const named = files.some((f) => /^(skills|agents)\s*:/m.test(f.text))
  const lib: JobLibrary = named ? await jobLibrary(rt) : { skills: new Map(), agents: new Map() }
  const sig = JSON.stringify([
    named ? [[...lib.skills], [...lib.agents]] : null,
    rt.provider.id,
    files.map((f) => [f.name, f.mtimeMs]),
    projects.map((p) => [p.id, p.path]),
    rt.connectorCache?.probedAt ?? 0,
    [...rt.folderProbes].map(([k, v]) => [k, v.probedAt]),
  ])
  if (!force && sig === rt.jobSyncSig) return
  const rows = await rt.store.jobs.list()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const seen = new Set<string>()
  const now = Date.now()
  for (const f of files) {
    const parsed = parseJobFile(f.name, f.text)
    let spec = parsed.spec
    const errors = [...parsed.errors]
    if (!parsed.hadId || seen.has(spec.id)) {
      // a copied file arrives with its original's id: the copy gets its own
      if (parsed.hadId) spec = { ...spec, id: randomUUID() }
      await rt.jobFiles.stampId(f.name, spec.id).catch((err) => errors.push(`could not write an id into the file: ${err}`))
    }
    seen.add(spec.id)
    const checked = checkJobSpec(rt, spec, projects, lib)
    errors.push(...checked.errors)
    const cfg = jobConfigFrom({ ...spec, tools: checked.tools }, f.name)
    const configError = errors.length ? errors.join('; ') : null
    const row = byId.get(spec.id)
    if (!row) {
      await rt.store.jobs.create({
        ...cfg,
        id: spec.id,
        source: 'slack',
        scope: '',
        model: cfg.model,
        catchUpWindow: cfg.catchUpWindow ?? undefined,
        timeoutMs: cfg.timeoutMs ?? undefined,
        maxBudgetUsd: cfg.maxBudgetUsd ?? undefined,
        dailyBudgetUsd: cfg.dailyBudgetUsd ?? undefined,
        cadence: 'daily',
        createsItems: true,
        consecutiveFailures: 0,
        brief: cfg.brief ?? undefined,
        skills: cfg.skills ?? undefined,
        agents: cfg.agents ?? undefined,
        ...(configError ? { configError } : {}),
        // never run → due at once ("run once now"), unless the creator said wait
        ...(deferFirstRun === spec.id ? { lastRunStartedAt: now } : {}),
        createdAt: now,
        updatedAt: now,
      })
      log('info', 'job', `loaded ${f.name}.md${configError ? ` — held: ${configError}` : ''}`, { jobId: spec.id, workspace: rt.meta.id })
      continue
    }
    if (configKey(row) !== configKey(cfg)) {
      await rt.store.jobs.update(row.id, cfg)
      // Turned on: wait for the next slot, no burst of catch-up runs.
      if (cfg.enabled && !row.enabled) await rt.store.jobs.patchState(row.id, { lastRunStartedAt: now })
      log('info', 'job', `reloaded ${f.name}.md`, { jobId: row.id, workspace: rt.meta.id })
    }
    if ((row.configError ?? null) !== configError) {
      await rt.store.jobs.patchState(row.id, { configError })
      if (configError) log('warn', 'job', `${f.name}.md is held: ${configError}`, { jobId: row.id, workspace: rt.meta.id })
    }
  }
  for (const r of rows) {
    if (seen.has(r.id)) continue
    if (r.file) await deleteJob(rt, r.id, 'its file was deleted')
    else if (r.configError !== LEGACY_JOB) await rt.store.jobs.patchState(r.id, { configError: LEGACY_JOB })
  }
  // only a sync that got this far counts; one that threw is retried next tick
  rt.jobSyncSig = sig
}

/**
 * What a parsed job file can't do on this machine: name no project or a
 * missing one, or grant a tool the connector probes don't know. Fills each
 * grant's scope from the probe. The sync and the editor's save share it.
 */
function checkJobSpec(rt: WorkspaceRuntime, spec: JobFileSpec, projects: Project[], lib: JobLibrary): { tools: JobToolGrant[]; errors: string[] } {
  const errors: string[] = []
  const project = projects.find((p) => p.id === spec.project) ?? null
  if (!spec.project) errors.push(NEEDS_PROJECT)
  else if (!project) errors.push(`unknown project "${spec.project}" — pick another project for this job`)
  const refusal = vetoRefusal(rt.provider, 'job')
  if (refusal) errors.push(refusal)
  const probes = [rt.connectorCache, project ? rt.folderProbes.get(project.path) : undefined].filter((p): p is ConnectorProbe => p != null)
  const checked = checkGrants(spec.tools, probes.length ? probes.flatMap((p) => p.connectors) : null)
  return { tools: checked.tools, errors: [...errors, ...checked.errors, ...checkLibrary(spec, lib)] }
}

/** The editor's side list: project ids, every tool line the probes know, the skills and agents a job may name. */
function jobFileReference(rt: WorkspaceRuntime, projects: Project[], lib: JobLibrary): JobFileReference {
  const servers = new Map<string, string[]>()
  const probes = [rt.connectorCache, ...rt.folderProbes.values()].filter((p): p is ConnectorProbe => p != null)
  for (const c of probes.flatMap((p) => p.connectors)) {
    if (c.server === RESERVED_SERVER || !c.tools.length) continue
    const lines = servers.get(c.server) ?? []
    for (const t of c.tools) if (!lines.includes(`${c.server}/${t.name}`)) lines.push(`${c.server}/${t.name}`)
    servers.set(c.server, lines)
  }
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    builtins: ['web', 'github', 'files-write'],
    servers: [...servers].map(([server, tools]) => ({ server, tools })).sort((a, b) => a.server.localeCompare(b.server)),
    skills: [...lib.skills].filter(([, src]) => src !== 'project').map(([name]) => name),
    agents: [...lib.agents].filter(([, src]) => src !== 'project').map(([name]) => name),
  }
}

/**
 * The editor's save: check the text exactly as the sync would (schema, project,
 * tools) and write it only when nothing is wrong. A new job gets a fresh id
 * (a pasted one that is taken is refused); an edit keeps its id, so its runs
 * and items stay attached.
 */
async function saveJobText(rt: WorkspaceRuntime, id: string | null, raw: string): Promise<{ id: string } | { errors: string[] }> {
  const existing = id ? await rt.store.jobs.get(id) : null
  if (id && !existing) return { errors: ['unknown job id'] }
  if (raw.length > 64_000) return { errors: ['the file is too large (64 KB at most)'] }
  const parsed = parseJobFile(existing?.file ?? 'job', raw)
  const errors = [...parsed.errors]
  let text = raw
  let jobId = parsed.spec.id
  if (existing) {
    if (parsed.hadId && parsed.spec.id !== existing.id) errors.push(`id must stay ${existing.id} — it ties the job to its runs and items`)
    jobId = existing.id
    if (!parsed.hadId) text = withKey(text, 'id', jobId, 'first')
  } else if (!parsed.hadId) {
    text = withKey(text, 'id', jobId, 'first')
  } else if (await rt.store.jobs.get(jobId)) {
    errors.push(`id ${jobId} belongs to another job — delete the id line and one is made for you`)
  }
  errors.push(...checkJobSpec(rt, parsed.spec, await rt.store.projects.list(), await jobLibrary(rt)).errors)
  if (errors.length) return { errors }
  const name = existing?.file ?? rt.jobFiles.freeName(parsed.spec.title)
  await rt.jobFiles.writeText(name, text)
  await syncJobFiles(rt, { force: true })
  log('info', 'job', `${existing ? 'updated' : 'created'}: ${parsed.spec.title} (jobs/${name}.md)`, { jobId, workspace: rt.meta.id })
  return { id: jobId }
}

/**
 * A chat drafts a job (MCP draft_job): the file is written exactly as a
 * form or a hand edit would write it, but saved off and marked a draft. Only
 * the user's click on the job page turns it on — a model never schedules
 * runs by itself. Checked like any job file; anything wrong is refused with
 * the reasons, so the chat can fix them and try again.
 */
async function draftJobOp(rt: WorkspaceRuntime, raw: unknown): Promise<{ id: string; title: string; file: string; warnings: string[] }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
  const title = text('title')
  const instruction = text('instruction')
  const schedule = text('schedule')
  if (!title) throw new Error('title is required')
  if (!instruction) throw new Error('instruction is required — where to look and what counts as a match')
  if (!schedule || !isValidCron(schedule)) throw new Error('schedule must be a 5-field cron line, local time — e.g. "0 * * * *" for hourly, "0 9 * * 1-5" for weekdays at 9')

  const projects = await rt.store.projects.list()
  const want = text('project')
  const project = want
    ? projects.find((p) => p.id === want) ?? projects.find((p) => p.name.toLowerCase() === want.toLowerCase())
    : await defaultProject(rt)
  if (!project) throw new Error(want ? `no project "${want}" — pass a project id or name: ${projects.map((p) => p.name).join(', ')}` : 'this workspace has no project yet')

  const errors: string[] = []
  const lines = Array.isArray(r.tools) ? r.tools.filter((t): t is string => typeof t === 'string') : []
  const tools = grantsFromLines(lines.length ? lines : ['web'], errors)
  const output = text('output') || 'items'
  if (!JOB_OUTPUTS.includes(output as JobOutput)) errors.push(`output must be one of: ${JOB_OUTPUTS.join(', ')}`)
  const names = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])
  const skills = names('skills')
  const agents = names('agents')
  const brief = r.brief === true ? { ...(text('brief_model') ? { model: text('brief_model') } : {}), ...(text('brief_template') ? { template: text('brief_template') } : {}) } : undefined
  const spec: JobFileSpec = {
    id: randomUUID(),
    title,
    schedule,
    project: project.id,
    tools,
    ...(text('model') ? { model: text('model') } : {}),
    output: output as JobOutput,
    notify: 'on_failure',
    enabled: false,
    ...(brief ? { brief } : {}),
    draft: true,
    ...(skills.length ? { skills } : {}),
    ...(agents.length ? { agents } : {}),
    instruction,
  }
  // The file's own schema is the check: what it would refuse, this refuses.
  errors.push(...parseJobFile('draft', serializeJobFile(spec)).errors)
  errors.push(...checkJobSpec(rt, spec, projects, await jobLibrary(rt)).errors)
  if (errors.length) throw new Error(errors.join('; '))
  const warnings: string[] = []
  if (brief?.template && !(await listPlaybooks(rt.playbookDir)).some((p) => p.kind === brief.template)) {
    warnings.push(`no playbook named "${brief.template}" yet — briefs will use the generic one until playbooks/${brief.template}.md exists`)
  }
  const name = rt.jobFiles.freeName(title)
  await rt.jobFiles.write(name, spec)
  await syncJobFiles(rt, { force: true })
  log('info', 'job', `drafted: ${title} (jobs/${name}.md) — off until reviewed`, { jobId: spec.id, workspace: rt.meta.id })
  return { id: spec.id, title, file: `jobs/${name}.md`, warnings }
}

/** What draft_job hands back: where the draft is and how to turn it on. */
function draftJobText(d: { id: string; title: string; file: string; warnings: string[] }, canTry = false): string {
  return [
    `ok: drafted the job “${d.title}” (${d.file}, id ${d.id}). It is saved OFF and will not run until the user reviews and enables it.`,
    `Review and enable: #/jobs/${d.id}`,
    ...d.warnings.map((w) => `note: ${w}`),
    canTry
      ? 'Tell the user it is drafted and off, and offer a trial run (try_job) so they see what it would file before turning it on — do not claim it is running.'
      : 'Tell the user it is drafted and waiting for their review — do not claim it is running.',
  ].join('\n')
}

/**
 * A chat's trial run of a job (MCP try_job): the dry run the job page offers,
 * on the job's file as it stands — the same prompt, tools and fences as a
 * real run, with nothing filed and nothing sent. It waits for the run, so the
 * chat can show the user what the job would have done before they turn it on.
 */
async function tryJobOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const job = id ? await rt.store.jobs.get(id) : null
  if (!job) throw new Error(`no job "${id}" — pass the id draft_job returned`)
  if (job.configError) throw new Error(`the job is held: ${job.configError} — fix its file first`)
  if (!job.projectId) throw new Error('the job has no project — pick one first')
  const pv: JobPreview = { id: randomUUID(), status: 'running', events: [], startedAt: Date.now() }
  rt.previews.set(pv.id, pv)
  await runJobPreview(rt, pv, {
    instruction: job.instruction,
    tools: job.tools,
    projectId: job.projectId,
    model: job.model,
    output: job.output,
    schedule: scheduleOf(job),
    skills: job.skills,
    agents: job.agents,
  })
  if (pv.status !== 'ready' || !pv.result) throw new Error(pv.error ?? 'the trial run ended without a result')
  const res = pv.result
  const cost = [`${Math.round(res.tokens / 1000)}k tokens`, ...(res.costUsd != null ? [`$${res.costUsd.toFixed(2)}`] : [])].join(', ')
  const found =
    res.output === 'digest'
      ? res.digest
        ? [`It would write the digest “${res.digest.title}”:`, '', res.digest.body.slice(0, 4000)]
        : ['It wrote no digest.']
      : res.rows.length
        ? [`It would file ${res.rows.length} item(s):`, ...res.rows.map((x) => `- ${x.title} — ${x.url} (${x.ask}) — ${x.why}`)]
        : ['It found nothing to file.']
  return [
    `ok: trial run of “${job.title}” finished (${cost}). Nothing was filed or sent.`,
    ...found,
    ...(res.wouldQueue?.length ? ['A real run would hold these for the user’s approval first:', ...res.wouldQueue.map((q) => `- ${q.tool}: ${q.summary}`)] : []),
    `The job is ${job.enabled ? 'on' : 'still OFF'}. Show the user what it found; if it looks right they turn it on at #/jobs/${job.id}, else change the job with them and draft it again.`,
  ].join('\n')
}

/**
 * Drop a job's row. Never hard-delete its items: this job's open and
 * snoozed ones are archived with a recorded reason (.docs/jobs-v2.md).
 */
async function deleteJob(rt: WorkspaceRuntime, id: string, why: string): Promise<void> {
  let archived = 0
  for (const it of await rt.store.items.listAll()) {
    const fromJob = it.jobId === id || (it.foundBy ?? []).some((p) => p.jobId === id)
    if (fromJob && (it.status === 'open' || it.status === 'snoozed')) {
      await rt.store.items.transition(it.id, { status: 'archived', actor: 'system', detail: { reason: 'job deleted' } })
      archived += 1
    }
  }
  await rt.store.jobs.remove(id)
  invalidateInbox(rt)
  log('info', 'job', `deleted job ${id} (${why}); archived ${archived} item(s)`, { jobId: id, archived, workspace: rt.meta.id })
}

// The sleep watch's heartbeat: a long silence between beats was sleep, so a
// run the Mac slept through is recorded `slept` (server/power.ts).
startSleepWatch()

// The minute tick (.docs/jobs.md): due jobs run, elapsed snoozes wake — in
// every workspace. No cron — the server is the long-running process; missed
// runs are simply due on the first tick after wake.
setInterval(() => {
  lastSchedulerTickAt = Date.now()
  for (const rt of runtimes.values()) {
    runDueJobs(rt).catch((err) => log('error', 'scheduler', `tick failed: ${err}`, { workspace: rt.meta.id }))
    // Queued actions: expire the stale, send what a lost timer left due.
    tickActions(rt).catch((err) => log('error', 'actions', `tick failed: ${errText(err)}`, { workspace: rt.meta.id }))
    // Goals asleep on the world: time's up, Junior looks again.
    wakeTeamGoals(rt).catch((err) => log('error', 'teams', `goal wake failed: ${errText(err)}`, { workspace: rt.meta.id }))
    rt.store.items
      .wakeSnoozed(Date.now())
      .then((woken) => {
        if (woken.length > 0) {
          invalidateInbox(rt)
          log('info', 'scheduler', `woke ${woken.length} snoozed item(s)`, { ids: woken, workspace: rt.meta.id })
        }
      })
      .catch((err) => log('error', 'scheduler', `snooze wake failed: ${err}`, { workspace: rt.meta.id }))
  }
}, SCHEDULER_TICK_MS).unref()

// The gate sweep (decision 6): every 5 minutes, in every workspace. Nothing
// due = no session started.
setInterval(() => {
  for (const rt of runtimes.values()) sweepGates(rt).catch((err) => log('error', 'goals', `gate sweep failed: ${errText(err)}`, { workspace: rt.meta.id }))
}, GATE_SWEEP_INTERVAL_MS).unref()

// The PR watcher (M5): a cheap tick; each watched PR is polled on its own back-off.
setInterval(() => {
  for (const rt of runtimes.values()) watchPrs(rt).catch((err) => log('error', 'goals', `PR watcher failed: ${errText(err)}`, { workspace: rt.meta.id }))
}, WATCH_TICK_MS).unref()

// The repo picker's "available" list; slow-ish (paginated), so cached.
async function affiliatedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  if (rt.affiliatedCache && Date.now() - rt.affiliatedCache.at < 10 * 60_000) return rt.affiliatedCache.repos
  const repos = await listAffiliatedRepos()
  rt.affiliatedCache = { at: Date.now(), repos }
  return repos
}

async function getInbox(rt: WorkspaceRuntime, force: boolean): Promise<InboxSnapshot> {
  if (!force && rt.inboxCache && Date.now() - rt.inboxCache.syncedAt < INBOX_TTL_MS) return rt.inboxCache
  return syncInbox(rt)
}

// Keep the caches warm while the server runs, so page loads are instant. A
// failed background sync keeps the previous snapshot; the next view retries.
setInterval(() => {
  for (const rt of runtimes.values()) {
    syncInbox(rt).catch((err) => log('error', 'inbox', `background sync failed: ${err}`, { workspace: rt.meta.id }))
  }
}, INBOX_KEEP_WARM_MS).unref()

// ---------------------------------------------------------------------------
// Connectors: what a session will actually load, learned the honest way — by
// spawning a throwaway query with the SAME options real sessions use and
// asking it via the mcpServerStatus() control request (no user message, no
// API turn). `claude mcp list` has no machine output, and the config files
// under ~/.claude are private formats; this is the SDK's own structured
// answer to "which servers connected". Per-workspace: two auth backends
// genuinely have different connectors, so each runtime probes with its own env.
// ---------------------------------------------------------------------------
const CLAUDE_AI_PREFIX = 'claude.ai '

const SCOPES: ConnectorScope[] = ['claudeai', 'user', 'local', 'project', 'plugin', 'managed']

/** One server as the SDK reports it → our Connector, tools and all (job-spec.md, item 1). */
function toConnector(srv: McpStatus, scopeOverride?: ConnectorScope): Connector {
  const claudeAi = srv.name.startsWith(CLAUDE_AI_PREFIX)
  const scope: ConnectorScope =
    scopeOverride ?? (claudeAi ? 'claudeai' : SCOPES.includes(srv.scope as ConnectorScope) ? (srv.scope as ConnectorScope) : 'unknown')
  return {
    name: claudeAi ? srv.name.slice(CLAUDE_AI_PREFIX.length) : srv.name,
    server: srv.name,
    status: srv.status,
    source: claudeAi ? 'claude.ai' : 'local',
    scope,
    ...(srv.error ? { error: srv.error } : {}),
    tools: (srv.tools ?? []).map((t) => {
      const full = t.name.startsWith('mcp__') ? t.name : mcpToolName(srv.name, t.name)
      return {
        name: full.slice(full.lastIndexOf('__') + 2),
        fullName: full,
        ...(t.description ? { description: t.description.slice(0, 400) } : {}),
        ...(t.annotations?.readOnly !== undefined ? { readOnly: t.annotations.readOnly } : {}),
        ...(t.annotations?.destructive !== undefined ? { destructive: t.annotations.destructive } : {}),
        ...(t.annotations?.openWorld !== undefined ? { openWorld: t.annotations.openWorld } : {}),
      }
    }),
  }
}

/**
 * Probe which MCP servers connect. With no folder: the user-level view
 * (Settings), from the home folder. With a folder: exactly what a job run in
 * that folder loads — the user's servers plus the folder's project and local
 * servers, passed explicitly (never by loading the project's settings/hooks).
 */
function probeConnectors(rt: WorkspaceRuntime, cwd?: string): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  const inFlight = cwd ? rt.folderProbeInFlight.get(cwd) : rt.connectorInFlight
  if (inFlight) return inFlight
  const run = (async () => {
    const folder = cwd ? await folderMcpServers(rt, cwd) : null
    try {
      const statuses = await rt.provider.mcpStatus(
        folder
          ? { cwd: cwd!, env: rt.env, servers: folder.servers }
          : { cwd: os.homedir(), env: rt.env }, // user-level view; no project .mcp.json in the way
      )
      const connectors = statuses
        .map((srv) => toConnector(srv, folder?.scopes.get(srv.name)))
        .sort((a, b) => a.name.localeCompare(b.name))
      const probe: ConnectorProbe = { probedAt: Date.now(), connectors }
      if (cwd) rt.folderProbes.set(cwd, probe)
      else rt.connectorCache = probe
      log('info', 'connectors', `probed${cwd ? ` ${cwd}` : ''}: ${connectors.length} server(s), ${connectors.filter((c) => c.status === 'connected').length} connected`, { workspace: rt.meta.id })
      return probe
    } finally {
      if (cwd) rt.folderProbeInFlight.delete(cwd)
      else rt.connectorInFlight = null
    }
  })()
  if (cwd) rt.folderProbeInFlight.set(cwd, run)
  else rt.connectorInFlight = run
  return run
}

// ---------------------------------------------------------------------------
// Models: which models this workspace's Claude Code will actually run. Asked of
// the SDK (supportedModels()) rather than hardcoded — the catalog moves, an
// org policy can shrink it, and an api-key workspace may see a different list
// than a subscription one. Same throwaway-subprocess shape as the connector
// probe, and the answer is stable enough to cache for the process. Cached per
// agent: a chat can run on another one (Codex), whose list is its own.
// ---------------------------------------------------------------------------
function probeModels(rt: WorkspaceRuntime, provider: ProviderId = rt.meta.provider): Promise<ModelProbe> {
  const inFlight = rt.modelInFlight.get(provider)
  if (inFlight) return inFlight
  const run = (async () => {
    try {
      const models = await providerFor(provider).models({ cwd: os.homedir(), env: rt.envFor(provider) })
      const probe = { probedAt: Date.now(), models }
      rt.modelCache.set(provider, probe)
      log('info', 'models', `probed ${provider}: ${models.length} model(s) available`, { workspace: rt.meta.id })
      return probe
    } finally {
      rt.modelInFlight.delete(provider)
    }
  })()
  rt.modelInFlight.set(provider, run)
  return run
}

/**
 * A session's model choice, checked against its agent's list where that list
 * is the whole truth. Claude also takes aliases and ids it doesn't list, so its
 * choice passes as sent. For Codex, an id it doesn't list is refused (null) —
 * `turn/start` would fail on it — and an effort the model doesn't take is
 * dropped to the model's default.
 */
async function checkModelChoice(
  rt: WorkspaceRuntime,
  provider: ProviderId,
  model: string | null,
  effort: EffortLevel | null,
): Promise<{ model: string | null; effort: EffortLevel | null } | null> {
  if (provider === 'claude' || model === null) return { model, effort }
  const probe = rt.modelCache.get(provider) ?? (await probeModels(rt, provider))
  const option = probe.models.find((m) => m.id === model)
  if (!option) return null
  return { model, effort: effort && option.efforts.includes(effort) ? effort : null }
}

// ---------------------------------------------------------------------------
// Slash commands: what `/` offers in the composer. Asked of the SDK
// (supportedCommands()) like the model catalog, but keyed by *folder* rather
// than by workspace — a project's .claude/commands, .claude/skills and its
// plugins' skills only exist under that project.
//
// Two fill paths, and the cheap one covers the common case: a live session's
// subprocess already knows the list, so it hands it over at init for free and
// pushes a fresh one when skills are discovered mid-run. Only a draft tab —
// which has no subprocess yet — pays for a throwaway probe, and only on the
// first `/` typed against that folder.
// ---------------------------------------------------------------------------

/**
 * Commands whose UX is bound to a real terminal. The SDK tags these per
 * session (`terminal_slash_commands` on the init message) and tells remote
 * hosts to hide them — but the tag rides the message stream, so a probe with
 * no turn never sees it. Until this workspace has run one session, this list
 * stands in; the first init replaces it wholesale rather than merging, so a
 * stale guess here can only ever be wrong until a session starts.
 */
const TERMINAL_ONLY_FALLBACK = [
  'exit',
  'quit',
  'statusline',
  'vim',
  'ide',
  'terminal-setup',
  'install-github-app',
  'upgrade',
  'login',
  'logout',
]

/** The SDK's command shape is our wire shape; drop the empty optional. */
const toCommandInfo = (c: {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}): SlashCommandInfo => ({
  name: c.name,
  description: c.description,
  argumentHint: c.argumentHint,
  ...(c.aliases?.length ? { aliases: c.aliases } : {}),
})

/** Hide what a browser can't drive, and give the picker a stable order. */
function usableCommands(rt: WorkspaceRuntime, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const hidden = new Set(rt.terminalCommands ?? TERMINAL_ONLY_FALLBACK)
  return commands.filter((c) => !hidden.has(c.name)).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Record what a subprocess reported for a folder and tell every composer
 * pointed at it. Replace, never merge: the SDK's `commands_changed` contract
 * is that the payload is the whole truth, and a command can be deleted.
 */
function noteCommands(rt: WorkspaceRuntime, cwd: string, commands: SlashCommandInfo[]): CommandProbe {
  // Keyed by the resolved folder, so a session's absolute cwd and a draft
  // tab's `~/Code/thing` are one entry rather than two.
  const key = expandHome(cwd)
  // The cache holds the subprocess's answer verbatim and `usableCommands`
  // runs on the way out, so the terminal set learned by a session starting
  // later still applies to a folder probed before it.
  const probe: CommandProbe = { probedAt: Date.now(), commands }
  rt.commandCache.set(key, probe)
  broadcast(rt, { type: 'commands_changed', cwd: key, commands: usableCommands(rt, commands) })
  return probe
}

/**
 * The list for a folder with no live session — one throwaway subprocess, the
 * same shape as the model probe, cached for the life of the process. Shared
 * per folder while in flight so a fast typist can't spawn two.
 */
function probeCommands(rt: WorkspaceRuntime, cwd: string): Promise<CommandProbe> {
  const running = rt.commandInFlight.get(cwd)  // callers pass the resolved folder
  if (running) return running
  const job = (async () => {
    try {
      const probe = noteCommands(rt, cwd, (await rt.provider.commands({ cwd, env: rt.env })).map(toCommandInfo))
      log('info', 'commands', `probed ${probe.commands.length} command(s)`, { workspace: rt.meta.id })
      return probe
    } finally {
      rt.commandInFlight.delete(cwd)
    }
  })()
  rt.commandInFlight.set(cwd, job)
  return job
}

/**
 * A REAL auth check: one trivial headless turn with the workspace's env. The
 * model catalog (supportedModels) is static and "succeeds" on a bogus key, so
 * the verify step must actually reach the API to prove a key or login works.
 * Costs one minimal turn; only run for api-key / config-dir on explicit verify.
 */
function probeAuth(rt: WorkspaceRuntime): Promise<{ ok: boolean; error?: string }> {
  return rt.provider.checkAuth(rt.env)
}

// ---------------------------------------------------------------------------
// Workspace management — registry CRUD + the live runtime bookkeeping. Auth is
// spawn-time: changing a workspace's backend stops its live subprocesses (the
// next message revives them with the new env) and re-probes.
// ---------------------------------------------------------------------------
function wireWorkspace(meta: WorkspaceMeta): Workspace {
  return {
    id: meta.id,
    name: meta.name,
    color: meta.color,
    ...(meta.description ? { description: meta.description } : {}),
    authBackend: meta.authBackend,
    isDefault: meta.id === registry.defaultId,
    createdAt: meta.createdAt,
    ...(meta.authBackend === 'api-key' ? { apiKeyHint: apiKeyHint(meta) } : {}),
    ...(meta.authBackend === 'config-dir'
      ? { configDir: workspaceAuthDir(meta), loginCommand: loginCommandFor(meta) }
      : {}),
    providers: wireProviders(meta),
  }
}

/** Every agent this build knows, as the workspace has it set up — the primary first. */
function wireProviders(meta: WorkspaceMeta): WorkspaceProvider[] {
  const ids = [meta.provider, ...PROVIDER_IDS.filter((id) => id !== meta.provider)]
  return ids.map((id) => {
    const authBackend = providerAuthBackend(meta, id)
    return {
      id,
      primary: id === meta.provider,
      connected: authBackend !== undefined,
      ...(authBackend ? { authBackend } : {}),
      ...(authBackend === 'api-key' ? { apiKeyHint: apiKeyHint(meta, id) } : {}),
      ...(authBackend === 'config-dir' ? { configDir: workspaceAuthDir(meta, id), loginCommand: loginCommandFor(meta, id) } : {}),
    }
  })
}

/** How long an account read stands before the next ask goes back to the agent. */
const PROVIDER_STATUS_TTL_MS = 2 * 60_000

/**
 * Each connected agent's account, plan windows and recent use, read from the
 * agent itself — a throwaway subprocess apiece, so cached for a couple of
 * minutes and shared by concurrent askers. Claude's recent spend is the Usage
 * tab's ledger (this machine's transcripts); Codex reports its own.
 */
function readProviderStatus(rt: WorkspaceRuntime, refresh = false): Promise<ProviderStatus[]> {
  if (!refresh && rt.providerStatus && Date.now() - rt.providerStatus.at < PROVIDER_STATUS_TTL_MS) {
    return Promise.resolve(rt.providerStatus.providers)
  }
  if (rt.providerStatusInFlight) return rt.providerStatusInFlight
  const run = (async () => {
    const connected = wireProviders(rt.meta).filter((p) => p.connected)
    const providers = await Promise.all(
      connected.map(async ({ id }): Promise<ProviderStatus> => {
        const [status, recent] = await Promise.all([
          providerFor(id).account(rt.envFor(id)),
          id === 'claude' ? claudeRecent(30).catch(() => undefined) : Promise.resolve(undefined),
        ])
        return { id, ...status, ...(recent ? { recent } : {}), checkedAt: Date.now() }
      }),
    )
    rt.providerStatus = { at: Date.now(), providers }
    return providers
  })().finally(() => (rt.providerStatusInFlight = null))
  rt.providerStatusInFlight = run
  return run
}

/** What Claude Code spent on this machine over the last `days` days. */
async function claudeRecent(days: number): Promise<ProviderStatus['recent']> {
  const now = Date.now()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const since = start.getTime() - (days - 1) * 86_400_000
  const { entries } = await scanUsage(claudeProjectRoots(), since)
  const { totals } = summarizeUsage(entries, since, now)
  return { days, tokens: totals.tokens, costUsd: totals.cost }
}

/**
 * Keep a provider's API key: in the workspace's .env always, and — for an
 * agent that reads it from a login file (Codex) — signed into its own home.
 * A key the agent refuses fails the save rather than being stored half-done.
 */
async function saveProviderKey(meta: WorkspaceMeta, provider: ProviderId, key: string): Promise<void> {
  const { storeKey } = providerFor(provider).auth
  if (storeKey) {
    const auth = authOf({ ...meta, ...(provider === meta.provider ? { authBackend: 'api-key' as const } : { connections: { ...meta.connections, [provider]: { authBackend: 'api-key' as const } } }) }, provider)
    if (auth.backend === 'api-key' && auth.dir) await storeKey(auth.dir, key)
  }
  writeApiKey(meta, key, provider)
}

/**
 * After a non-primary agent's connection changes: its live sessions stop (the
 * next message revives them on the new auth) and its model list is re-read.
 */
function applyProviderChange(rt: WorkspaceRuntime, provider: ProviderId): void {
  for (const s of rt.live.values()) if (s.provider.id === provider) s.stop()
  rt.modelCache.delete(provider)
  rt.providerStatus = null
  log('info', 'workspaces', `${provider} ${isConnected(rt.meta, provider) ? `connected (${providerAuthBackend(rt.meta, provider)})` : 'disconnected'}`, {
    workspace: rt.meta.id,
  })
}

const wireWorkspaces = (): Workspace[] => registry.workspaces.map(wireWorkspace)

/**
 * "Which workspace am I bound to?" — the current workspace a caller resolved to
 * (chat via cookie/param, external shim via TRIAGE_WORKSPACE) plus the roster of
 * all workspaces so the caller can see what else exists and how to switch. The
 * one answer both the in-process tool and the stdio shim's get_workspace return.
 */
function workspaceInfo(rt: WorkspaceRuntime) {
  return {
    current: wireWorkspace(rt.meta),
    workspaces: registry.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      isDefault: w.id === registry.defaultId,
    })),
  }
}

/** Bring a runtime up: sessions, seeds, cached snapshot, background probes. */
async function initRuntime(rt: WorkspaceRuntime): Promise<void> {
  rt.persona = await readPersona(rt)
  await migrateDefaultProject(rt)
  await loadCheckouts(rt)
  await loadSessions(rt)
  await markInterruptedRuns(rt)
  await migrateJobProjects(rt)
  // Jobs are off by default in 0.7 (.docs/next-version.md); seeding follows the switch.
  if (await jobsEnabled(rt)) await seedJobTemplates(rt)
  else await syncJobFiles(rt, { force: true }).catch(() => {})
  await bootBriefs(rt)
  // Plan review events the last daemon wrote but never finished: wake their lead, queue their steps.
  await replayGoalEvents(rt.goalDeps, goalEngineFor(rt)).catch((err) => log('error', 'goals', `replay failed: ${errText(err)}`, { workspace: rt.meta.id }))
  // M3: the goals that were mid-session when the daemon died pick up from their handoff, and nothing they queued is filed twice.
  await loadGoalHeld(rt.goalDeps, rt.goalHeld).catch((err) => log('error', 'goals', `could not load held actions: ${errText(err)}`, { workspace: rt.meta.id }))
  await bootGoalRun(rt.goalDeps, goalEngineFor(rt)).catch((err) => log('error', 'goals', `could not resume running goals: ${errText(err)}`, { workspace: rt.meta.id }))
  await rt.teamLibrary.seed().catch((err) => log('error', 'teams', `could not seed agents and teams: ${err}`, { workspace: rt.meta.id }))
  await loadTeamRuns(rt)
  // The last snapshot makes the first page load instant — but only while it
  // is still fresh, and only in today's shape: one saved before stage/turn
  // carries no flows, one before the inbox tabs no counts, and serving either
  // leaves the sidebar wrong until the next sync.
  const saved = await rt.store.inbox.load()
  rt.inboxCache = saved && saved.counts !== undefined && saved.items.every((i) => i.flow) ? saved : null
  probeConnectors(rt).catch((err) => log('error', 'connectors', `probe failed: ${err}`, { workspace: rt.meta.id }))
  probeModels(rt).catch((err) => log('error', 'models', `probe failed: ${err}`, { workspace: rt.meta.id }))
  await rt.actionsFile.seed().catch((err) => log('warn', 'actions', `could not seed the actions file: ${errText(err)}`, { workspace: rt.meta.id }))
  // Queued actions: a send the last process died in is unknown; scheduled ones get their timers back.
  await recoverActions(rt).catch((err) => log('warn', 'actions', `could not recover queued actions: ${errText(err)}`, { workspace: rt.meta.id }))
  // After the connector probe, so past connector calls sort by their servers' own annotations too.
  void (rt.connectorInFlight ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => backfillActions(rt))
    .catch((err) => log('warn', 'actions', `backfill failed: ${errText(err)}`, { workspace: rt.meta.id }))
}

/** After an auth change: new env, fresh probes, and no subprocess on the old auth. */
function applyAuthChange(rt: WorkspaceRuntime): void {
  rt.refreshEnv()
  for (const s of rt.live.values()) s.stop() // next message revives with the new env
  rt.connectorCache = null
  rt.modelCache.clear()
  rt.providerStatus = null
  probeConnectors(rt).catch(() => {})
  probeModels(rt).catch(() => {})
  log('info', 'workspaces', `auth backend now ${rt.meta.authBackend}`, { workspace: rt.meta.id })
}

type WorkspacePatch = {
  name?: string
  color?: string
  description?: string
  authBackend?: 'inherit' | 'api-key' | 'config-dir'
  apiKey?: string
}

function workspacePatchFrom(raw: unknown): { patch: WorkspacePatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WorkspacePatch = {}
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'name must be a non-empty string' }
    patch.name = r.name.trim()
  }
  if (r.color !== undefined) {
    if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) return { error: 'color must be a hex color like "#7aa2f7"' }
    patch.color = r.color
  }
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') return { error: 'description must be a string' }
    patch.description = r.description.trim()
  }
  if (r.authBackend !== undefined) {
    const backend = toAuthBackend(r.authBackend)
    if (!backend) return { error: 'authBackend must be inherit | api-key | config-dir' }
    patch.authBackend = backend
  }
  if (r.apiKey !== undefined) {
    if (typeof r.apiKey !== 'string' || !r.apiKey.trim()) return { error: 'apiKey must be a non-empty string' }
    patch.apiKey = r.apiKey.trim()
  }
  return { patch }
}

// ---------------------------------------------------------------------------
// HTTP: JSON API + the built SPA
// ---------------------------------------------------------------------------
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/**
 * A form's worth of JSON. Routes that carry base64 screenshots pass a bigger
 * `limit` — a single macOS screenshot blows past 1MB once base64'd, and a
 * body that dies mid-upload reads to the user as "the network broke".
 */
function readJsonBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Which workspace a request belongs to: the ?workspace= param wins (explicit —
 * the MCP shim and scripts use it), then the triage_ws cookie (how the SPA
 * rides: cookies travel on every fetch and on the WS upgrade with zero
 * call-site churn), then the default. A stale id falls back to the default
 * rather than erroring — a deleted workspace must not brick the UI.
 */
function cookieWorkspace(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'triage_ws') return decodeURIComponent(v.join('='))
  }
  return undefined
}

function resolveRuntime(req: http.IncomingMessage, url: URL): WorkspaceRuntime {
  const qid = url.searchParams.get('workspace')
  if (qid) {
    const rt = runtimes.get(qid)
    if (rt) return rt
  }
  const cid = cookieWorkspace(req)
  if (cid) {
    const rt = runtimes.get(cid)
    if (rt) return rt
  }
  return defaultRuntime()
}

// ---------------------------------------------------------------------------
// Input validation — the HTTP surface is untrusted (vision principle 6):
// bodies are validated into domain shapes, and rejected rather than repaired.
// ---------------------------------------------------------------------------

const CADENCES = new Set<JobCadence>(['hourly', 'daily', 'weekly'])
const ITEM_STATUSES = new Set<ItemStatus>(['open', 'done', 'snoozed', 'archived'])
const VALID_KINDS = new Set(Object.keys(BASE))
const VALID_SOURCES = new Set(['github', 'slack', 'linear', 'web'])
// upsert accepts only scanner sources; state/resolve accept manual items too.
const ITEM_ID_RE = /^(github|slack|linear|web):\S+$/
const ANY_ITEM_ID_RE = /^(github|slack|linear|web|manual):\S+$/
/** Item saves carry images inline: the per-image cap, base64-inflated, times the per-item cap. */
const MAX_ITEM_BODY_BYTES = Math.ceil(MAX_IMAGES_PER_ITEM * MAX_IMAGE_BYTES * 1.4) + 100_000
const MAX_URLS_PER_ITEM = 20

type JobPatch = Partial<NewJob> & { enabled?: boolean; runOnceNow?: boolean }

const LEGACY_CONNECTORS: LegacyConnector[] = ['web', 'slack', 'linear', 'github']

function jobPatchFrom(raw: unknown): { patch: JobPatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: JobPatch = {}
  if (r.title !== undefined) {
    if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
    patch.title = r.title.trim()
  }
  if (r.scope !== undefined) {
    // legacy place hint; empty clears it
    if (typeof r.scope !== 'string' || (r.scope.trim() && !/^[#@]\S+$/.test(r.scope.trim()))) return { error: 'scope must be "#channel", "@dm", or empty' }
    patch.scope = r.scope.trim()
  }
  if (r.tools !== undefined) {
    const parsed = grantsFrom(r.tools)
    if ('error' in parsed) return { error: parsed.error }
    patch.tools = parsed.grants
  } else if (r.connectors !== undefined) {
    // legacy clients: the four fixed integrations → grants
    if (!Array.isArray(r.connectors) || r.connectors.length === 0 || !r.connectors.every((c) => LEGACY_CONNECTORS.includes(c as LegacyConnector))) {
      return { error: `connectors must be a non-empty list of: ${LEGACY_CONNECTORS.join(', ')}` }
    }
    patch.tools = grantsFromLegacy([...new Set(r.connectors as LegacyConnector[])])
  }
  if (r.projectId !== undefined) {
    // required: every job runs in a project folder (job-spec.md, item 2)
    if (typeof r.projectId !== 'string' || !r.projectId) return { error: 'projectId is required — pick the project this job runs in' }
    patch.projectId = r.projectId
  }
  if (r.catchUpWindow !== undefined) {
    if (r.catchUpWindow !== null && !isCatchUpSpec(r.catchUpWindow)) return { error: 'catchUpWindow must be "never", "unlimited", or a duration like "6h", or null' }
    patch.catchUpWindow = r.catchUpWindow as string | null
  }
  if (r.timeoutMs !== undefined) {
    const t = r.timeoutMs
    if (t !== null && (typeof t !== 'number' || !Number.isInteger(t) || t < 30_000 || t > MAX_JOB_TIMEOUT_MS)) {
      return { error: `timeoutMs must be null or whole milliseconds from 30000 to ${MAX_JOB_TIMEOUT_MS}` }
    }
    patch.timeoutMs = t as number | null
  }
  if (r.maxBudgetUsd !== undefined) {
    const b = r.maxBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 100)) return { error: 'maxBudgetUsd must be null or dollars from 0.01 to 100' }
    patch.maxBudgetUsd = b as number | null
  }
  if (r.dailyBudgetUsd !== undefined) {
    const b = r.dailyBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 1000)) return { error: 'dailyBudgetUsd must be null or dollars from 0.01 to 1000' }
    patch.dailyBudgetUsd = b as number | null
  }
  if (r.notify !== undefined) {
    if (!JOB_NOTIFY.includes(r.notify as JobNotify)) return { error: `notify must be one of: ${JOB_NOTIFY.join(', ')}` }
    patch.notify = r.notify as JobNotify
  }
  if (r.runOnceNow !== undefined) {
    if (typeof r.runOnceNow !== 'boolean') return { error: 'runOnceNow must be a boolean' }
    patch.runOnceNow = r.runOnceNow
  }
  if (r.output !== undefined) {
    if (!JOB_OUTPUTS.includes(r.output as JobOutput)) return { error: `output must be one of: ${JOB_OUTPUTS.join(', ')}` }
    patch.output = r.output as JobOutput
  }
  if (r.model !== undefined) {
    // an alias or wire id as the model picker reports it; null/empty = default
    if (r.model !== null && (typeof r.model !== 'string' || r.model.length > 120)) return { error: 'model must be a string or null' }
    patch.model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined
  }
  if (r.instruction !== undefined) {
    if (typeof r.instruction !== 'string' || !r.instruction.trim()) return { error: 'instruction must be a non-empty string' }
    patch.instruction = r.instruction.trim()
  }
  if (r.cadence !== undefined) {
    if (!CADENCES.has(r.cadence as JobCadence)) return { error: 'cadence must be hourly | daily | weekly' }
    patch.cadence = r.cadence as JobCadence
  }
  if (r.schedule !== undefined) {
    if (typeof r.schedule !== 'string' || !isValidCron(r.schedule)) {
      return { error: 'schedule must be a valid 5-field cron expression, e.g. "0 9 * * *"' }
    }
    patch.schedule = r.schedule.trim()
  }
  if (r.windowStart !== undefined && r.windowStart !== null) {
    if (typeof r.windowStart !== 'string' || !/^\d{1,2}:\d{2}$/.test(r.windowStart)) return { error: 'windowStart must be "HH:MM"' }
    patch.windowStart = r.windowStart
  }
  if (r.windowDay !== undefined && r.windowDay !== null) {
    if (typeof r.windowDay !== 'number' || !Number.isInteger(r.windowDay) || r.windowDay < 0 || r.windowDay > 6) return { error: 'windowDay must be 0-6' }
    patch.windowDay = r.windowDay
  }
  if (r.createsItems !== undefined) {
    if (typeof r.createsItems !== 'boolean') return { error: 'createsItems must be a boolean' }
    patch.createsItems = r.createsItems
  }
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { error: 'enabled must be a boolean' }
    patch.enabled = r.enabled
  }
  if (r.brief !== undefined) {
    const b = jobBriefFrom(r.brief)
    if (typeof b === 'string') return { error: b }
    patch.brief = b
  }
  return { patch }
}

/** The brief option off the wire: null = off, {} = on with the defaults. A string is the error. */
function jobBriefFrom(raw: unknown): JobBrief | null | string {
  if (raw === null || raw === false) return null
  if (raw === true) return {}
  if (typeof raw !== 'object') return 'brief must be null, true, or { model?, template? }'
  const o = raw as Record<string, unknown>
  if (o.model !== undefined && o.model !== null && (typeof o.model !== 'string' || o.model.length > 120)) return 'brief.model must be a string'
  if (o.template !== undefined && o.template !== null && !isPlaybookName(o.template)) return 'brief.template must be a playbook name'
  return {
    ...(typeof o.model === 'string' && o.model.trim() ? { model: o.model.trim() } : {}),
    ...(typeof o.template === 'string' && o.template ? { template: o.template } : {}),
  }
}

/** A full ingested WorkItem, validated field by field. Rejects, never repairs. */
function workItemFrom(raw: unknown): { item: WorkItem } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ITEM_ID_RE.test(r.id)) return { error: 'id must look like "slack:...", "github:owner/repo#123", or "linear:KEY-123"' }
  const source = r.id.slice(0, r.id.indexOf(':'))
  if (r.source !== undefined && r.source !== source) return { error: `source must match the id prefix ("${source}")` }
  if (!VALID_SOURCES.has(source)) return { error: 'unknown source' }
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` }
  if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
  if (typeof r.url !== 'string' || !r.url.startsWith('http')) return { error: 'url must be an http(s) URL' }
  if (typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) return { error: 'updatedAt must be an ISO 8601 timestamp' }
  const createdAt = typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : r.updatedAt
  return {
    item: {
      id: r.id,
      source: source as WorkItem['source'],
      kind: r.kind as WorkItem['kind'],
      title: r.title.trim(),
      url: r.url,
      repo: typeof r.repo === 'string' ? r.repo : '',
      author: typeof r.author === 'string' ? r.author : '',
      peopleWaiting: typeof r.peopleWaiting === 'number' && r.peopleWaiting >= 0 ? Math.floor(r.peopleWaiting) : 0,
      createdAt,
      updatedAt: r.updatedAt,
      ...(typeof r.jobId === 'string' ? { jobId: r.jobId } : {}),
      ...(typeof r.why === 'string' && r.why ? { why: r.why } : {}),
      ...(isLabel(r.ask) ? { ask: r.ask } : {}),
      ...(parseDue(r.due) != null ? { dueAt: parseDue(r.due)! } : {}),
      ...(canonicalizeRefs(r.refs) ? { refs: canonicalizeRefs(r.refs) } : {}),
    },
  }
}

/**
 * A manual to-do's fields, validated. Project (if given) must exist; url (if
 * given) must be http(s); priority (if given) is 1–4. Title is required on
 * create; with `{ partial: true }` (an edit) only the fields present are
 * validated and returned, so a caller can patch one field without resending
 * the rest.
 */
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown): Promise<ManualItemInput>
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial: true }): Promise<Partial<ManualItemInput>>
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial?: boolean } = {}): Promise<Partial<ManualItemInput>> {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title && !opts.partial) throw new Error('a work item needs a title')
  const input: Partial<ManualItemInput> = {}
  if (title) input.title = title
  if (typeof r.projectId === 'string' && r.projectId) {
    const projects = await rt.store.projects.list()
    if (!projects.some((p) => p.id === r.projectId)) throw new Error('unknown project')
    input.projectId = r.projectId
  }
  // `description` is the 0.7 name; `note` is accepted as the old one for one release.
  const desc = typeof r.description === 'string' ? r.description : typeof r.note === 'string' ? r.note : undefined
  if (desc !== undefined && desc.trim()) input.description = desc.trim()
  if (typeof r.url === 'string' && r.url.trim()) {
    if (!/^https?:\/\//.test(r.url.trim())) throw new Error('link must be an http(s) URL')
    input.url = r.url.trim()
  }
  // When the key is present, 0/null means "none" (0) so an edit can clear it;
  // when absent, priority is left untouched on update.
  if ('priority' in r) {
    const p = r.priority
    if (p === null || p === 0) input.priority = 0
    else if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 4) input.priority = p
    else throw new Error('priority must be 1–4')
  }
  const urls = itemUrls(r.urls)
  if (urls) input.urls = urls
  const images = itemImageEdits(r)
  if (images) input.images = images
  return input
}

/**
 * The `urls` field of an item save: the complete desired list of the human's
 * links, trimmed and deduplicated. Absent leaves them alone, `[]` clears them.
 * Refused, not repaired, like images — a link that silently vanishes is worse.
 */
function itemUrls(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('urls must be a list of http(s) links')
  const out: string[] = []
  for (const entry of v) {
    const u = typeof entry === 'string' ? entry.trim() : ''
    if (!/^https?:\/\/\S+$/.test(u) || u.length > 2000) throw new Error('each link must be an http(s) URL')
    if (!out.includes(u)) out.push(u)
  }
  if (out.length > MAX_URLS_PER_ITEM) throw new Error(`up to ${MAX_URLS_PER_ITEM} links per item`)
  return out
}

/**
 * The `images` field of an item save: `{ id }` keeps an image the item already
 * holds, anything else is a new base64 upload, judged by the same rules as a
 * chat attachment. The list is the complete desired set — absent leaves the
 * item's images alone, `[]` drops them all. Unlike the socket's
 * `imageAttachments`, a bad entry is *refused*, not dropped: this is a form,
 * and a screenshot that silently vanishes on save is worse than an error.
 */
function itemImageEdits(raw: Record<string, unknown>): ItemImageEdit[] | undefined {
  const v = raw.images
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error('images must be a list')
  if (v.length > MAX_IMAGES_PER_ITEM) throw new Error(`up to ${MAX_IMAGES_PER_ITEM} images per item`)
  const out: ItemImageEdit[] = []
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null) throw new Error('each image must be an object')
    const e = entry as Record<string, unknown>
    if (typeof e.id === 'string' && e.id) {
      out.push({ id: e.id })
      continue
    }
    if (!isImageMediaType(e.mediaType)) throw new Error('images must be PNG, JPEG, GIF or WebP')
    if (typeof e.data !== 'string' || !e.data || !BASE64.test(e.data)) throw new Error('image data must be base64')
    if (base64Bytes(e.data) > MAX_IMAGE_BYTES)
      throw new Error(`each image must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`)
    out.push({
      mediaType: e.mediaType,
      data: e.data,
      ...(typeof e.name === 'string' && e.name ? { name: e.name.slice(0, 200) } : {}),
    })
  }
  return out
}

/**
 * Write the item's new image set to disk and record the refs. Works for any
 * item, not just manual ones — a screenshot pasted onto a GitHub item's
 * description is the same thing.
 */
async function setItemImagesOp(rt: WorkspaceRuntime, id: string, edits: ItemImageEdit[]): Promise<ItemImage[]> {
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')
  const images = await applyImageEdits(rt.attachmentsDir, id, item.images ?? [], edits)
  await rt.store.items.setImages(id, images)
  invalidateInbox(rt)
  return images
}

// ---------------------------------------------------------------------------
// Work-item operations — one core, three callers: the HTTP routes below, the
// in-process MCP server that web chats get (rt.triageMcp(), one per session), and the
// stdio shim (server/mcp.ts) which reaches them over HTTP. Every transport
// funnels through these functions, so list/create/edit/upsert/resolve behave
// identically no matter who calls them. Validation stays in workItemFrom/
// manualItemFrom — the single source of truth, never duplicated per transport.
// ---------------------------------------------------------------------------
async function listItemsOp(
  rt: WorkspaceRuntime,
  filter: { source?: string; kind?: string; status?: string } = {},
): Promise<InboxSnapshot['items']> {
  // 'open' is the live inbox (scanned + ranked + cached); any other status is
  // read straight from the durable store, same as the status tabs.
  const status = filter.status && filter.status !== 'open' ? filter.status : null
  if (status && !ITEM_STATUSES.has(status as ItemStatus)) throw new Error(`unknown status: ${status}`)
  let items = status ? await listItemsByStatus(rt, status as ItemStatus) : (await getInbox(rt, false)).items
  if (filter.source) items = items.filter((i) => i.source === filter.source)
  if (filter.kind) items = items.filter((i) => i.kind === filter.kind)
  return items
}

/**
 * One work item, whole. The counterpart to listItemsOp: that one answers "what
 * should I do next" and is therefore open-only and repo-scoped, this one
 * answers "tell me about this one" and filters nothing. Every neighbour it
 * returns carries an id and a title, so a reader handed an id — by a `linked`
 * sibling, by an old link, by the user — can always follow it one more hop.
 */
async function itemDetailOp(rt: WorkspaceRuntime, rawId: unknown): Promise<ItemDetail> {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  const item = await rt.store.items.get(id)
  if (!item) throw new Error('no such work item')

  const [all, links] = await Promise.all([rt.store.items.listAll(), rt.store.links.forTarget('item', id)])

  // Ref-siblings, transitively — the same component the inbox folds into one
  // card (core/work/link.ts), so detail and card never disagree about who is
  // related to whom. Unlike the card, this reaches items of any status.
  const byId = new Map(all.map((i) => [i.id, i]))
  const refsOf = (i: WorkItem) => [i.id, ...(i.refs ?? [])]
  const owners = new Map<string, string[]>()
  for (const i of all) {
    for (const ref of refsOf(i)) {
      const list = owners.get(ref)
      if (list) list.push(i.id)
      else owners.set(ref, [i.id])
    }
  }
  const seen = new Set([id])
  const queue = [id]
  while (queue.length) {
    const cur = byId.get(queue.shift()!)
    if (!cur) continue
    for (const ref of refsOf(cur)) {
      for (const other of owners.get(ref) ?? []) {
        if (seen.has(other)) continue
        seen.add(other)
        queue.push(other)
      }
    }
  }
  const linked = [...seen]
    .filter((sid) => sid !== id)
    .map((sid) => byId.get(sid)!)
    .map((i) => ({ id: i.id, title: i.title, source: i.source as string, url: i.url, repo: i.repo, status: i.status ?? 'open' }))

  const [artifacts, sessions] = await Promise.all([linkedArtifacts(rt, links), linkedSessions(rt, links)])

  // Ranked only when it happens to be in the cached open inbox: ranking means
  // a scan, and reading one item must never pay for one.
  const scored = rt.inboxCache?.items.find((i) => i.id === id)
  return {
    item,
    rank: scored ? { score: scored.score, group: scored.group, reason: scored.reason } : null,
    linked,
    artifacts,
    sessions,
    flow: await flowFor(rt, item),
  }
}

/** The artifacts among a set of incoming links, resolved to id/title/author/path. */
async function linkedArtifacts(rt: WorkspaceRuntime, links: Link[]): Promise<ItemDetail['artifacts']> {
  const rows = await Promise.all(
    links
      .filter((l) => l.fromKind === 'artifact')
      .map(async (l) => {
        const a = await rt.store.artifacts.get(l.fromId)
        return a ? { id: a.id, title: a.title, role: l.role, author: a.author, path: a.path } : null
      }),
  )
  return rows.filter((a): a is NonNullable<typeof a> => a !== null)
}

/** The sessions among a set of incoming links, resolved to id/title/kind. */
async function linkedSessions(rt: WorkspaceRuntime, links: Link[]): Promise<ItemDetail['sessions']> {
  const rows = await Promise.all(
    links
      .filter((l) => l.fromKind === 'session')
      .map(async (l) => {
        const row = rt.rows.get(l.fromId) ?? (await rt.store.sessions.get(l.fromId))
        return row ? { id: row.id, title: row.title, role: l.role, kind: row.kind, updatedAt: row.updatedAt } : null
      }),
  )
  return rows.filter((s): s is NonNullable<typeof s> => s !== null)
}

/**
 * What a session is allowed to know about itself. A session is spawned before
 * `create_session` links it to a work item, so its system prompt cannot name
 * the item — it can only point here (shared/triageContext.ts).
 */
async function sessionContextOp(rt: WorkspaceRuntime, rawId: unknown): Promise<SessionContext> {
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!id) throw new Error('need a session id')
  const row = rt.rows.get(id) ?? (await rt.store.sessions.get(id))
  if (!row) throw new Error('no such session')
  const [out, incoming] = await Promise.all([rt.store.links.forSource('session', id), rt.store.links.forTarget('session', id)])
  const itemLink = out.find((l) => l.toKind === 'item')
  const [item, artifacts] = await Promise.all([
    itemLink ? itemDetailOp(rt, itemLink.toId).catch(() => null) : Promise.resolve(null),
    linkedArtifacts(rt, incoming),
  ])
  return {
    workspace: { id: rt.meta.id, name: rt.meta.name, artifactsRoot: rt.artifacts.root },
    session: { id: row.id, title: row.title, kind: row.kind, cwd: row.cwd },
    item,
    artifacts,
  }
}

async function upsertItemOp(rt: WorkspaceRuntime, raw: unknown): Promise<UpsertOutcome> {
  const parsed = workItemFrom(raw)
  if ('error' in parsed) throw new Error(parsed.error)
  const { outcome } = await upsertItem(rt, parsed.item)
  if (outcome !== 'unchanged') invalidateInbox(rt)
  return outcome
}

async function resolveItemOp(rt: WorkspaceRuntime, rawId: unknown): Promise<void> {
  const id = typeof rawId === 'string' ? rawId : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  await rt.store.items.transition(id, { status: 'done', actor: 'agent' })
  invalidateInbox(rt)
  log('info', 'inbox', `done: ${id} (by agent)`, { id, actor: 'agent', workspace: rt.meta.id })
}

async function createManualOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const { images, ...input } = await manualItemFrom(rt, raw)
  const due = dueInput((raw as Record<string, unknown>).due, Date.now())
  const id = `manual:${randomUUID()}`
  await rt.store.items.createManual({ id, ...input, projectId: input.projectId ?? (await defaultProject(rt))?.id })
  if (due) await rt.store.items.setDue(id, due)
  // The item has to exist before its images can hang off it — the folder is
  // named after the id the line above minted.
  if (images?.length) await setItemImagesOp(rt, id, images)
  invalidateInbox(rt)
  log('info', 'inbox', `manual item created: ${input.title ?? id}`, { id, workspace: rt.meta.id })
  return id
}

// Edits target manual (user-authored) items only. Scanned items are
// upsert-newer-wins, so a free-form edit would be clobbered by the next scan —
// reject those with a clear message rather than silently no-op'ing.
async function editManualOp(rt: WorkspaceRuntime, id: string, raw: unknown): Promise<void> {
  if (!id || !id.startsWith('manual:'))
    throw new Error('edit_work_item only edits manual items (id must start with "manual:")')
  const { images, ...patch } = await manualItemFrom(rt, raw, { partial: true })
  const due = dueInput((raw as Record<string, unknown>).due, Date.now())
  await rt.store.items.updateManual(id, patch)
  if (due !== undefined) await rt.store.items.setDue(id, due)
  if (images) await setItemImagesOp(rt, id, images)
  invalidateInbox(rt)
}

// The same tool surface every session gets in-process, matching the stdio
// shim's names/schemas one-for-one (server/mcp.ts) so a web chat and a local
// Claude Code session drive the inbox identically. Handlers call the ops above
// directly — no HTTP round-trip — against THIS workspace's store. Reads are
// auto-allowed in requestPermission; writes surface a permission prompt.
// --- artifacts + links (.docs/next-version.md, phase 1) ----------------------
//
// Same shape as the item ops: validation once, three callers (HTTP, the
// in-process MCP server, the stdio shim over HTTP). The index does the file
// work; these decide what may be written and by whom.

const HIDDEN_ITEM_STATUSES = new Set<ItemStatus>(['done', 'archived'])
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
type OkBody = { ok: true } | { ok: false; error: string }

/** Every artifact with its outgoing links; `hidden` marks the brief of a finished item. */
async function listArtifactsOp(rt: WorkspaceRuntime, all: boolean): Promise<ArtifactWithLinks[]> {
  await rt.artifacts.refresh()
  const [rows, links] = await Promise.all([rt.store.artifacts.list(), rt.store.links.list()])
  const bySource = new Map<string, Link[]>()
  for (const l of links) {
    if (l.fromKind !== 'artifact') continue
    const list = bySource.get(l.fromId) ?? []
    list.push(l)
    bySource.set(l.fromId, list)
  }
  const out: ArtifactWithLinks[] = []
  for (const a of rows) {
    const mine = bySource.get(a.id) ?? []
    let hidden = false
    for (const l of mine) {
      if (l.role !== 'brief' || l.toKind !== 'item') continue
      const item = await rt.store.items.get(l.toId).catch(() => null)
      if (item?.status && HIDDEN_ITEM_STATUSES.has(item.status)) hidden = true
    }
    if (hidden && !all) continue
    out.push({ ...a, links: mine, hidden })
  }
  return out
}

function linkTargetFrom(raw: unknown): { kind: LinkKind; id: string; role: LinkRole } {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.kind) || l.kind === 'artifact') throw new Error('link kind must be item or session')
  if (typeof l.id !== 'string' || !l.id) throw new Error('a link needs an id')
  if (!isLinkRole(l.role)) throw new Error('link role must be brief, report, context, dispatch or plan')
  return { kind: l.kind, id: l.id, role: l.role }
}

/** Rejects, never repairs — like workItemFrom. */
function artifactInputFrom(raw: unknown, opts: { partial: boolean }): ArtifactInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : undefined
  const body = typeof r.body === 'string' ? r.body : undefined
  if (!opts.partial && !title) throw new Error('title is required')
  if (title !== undefined && !title) throw new Error('title cannot be empty')
  if (title && title.length > 200) throw new Error('title is too long (200 characters max)')
  if (body !== undefined && body.length > 2_000_000) throw new Error('body is too large (2 MB max)')
  if (r.refs !== undefined && !Array.isArray(r.refs)) throw new Error('refs must be an array of strings')
  const refs = Array.isArray(r.refs) ? r.refs.filter((x): x is string => typeof x === 'string') : undefined
  if (r.author !== undefined && !isArtifactAuthor(r.author)) throw new Error('author must be human or model')
  if (r.links !== undefined && !Array.isArray(r.links)) throw new Error('links must be an array')
  const links = Array.isArray(r.links) ? r.links.map(linkTargetFrom) : undefined
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(refs ? { refs } : {}),
    ...(isArtifactAuthor(r.author) ? { author: r.author } : {}),
    ...(links ? { links } : {}),
  }
}

/** A link's endpoints must exist in this workspace — a dangling link is a bug, not data. */
async function assertLinkable(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<void> {
  if (kind === 'item') {
    if (!(await rt.store.items.get(id))) throw new Error(`no work item ${id}`)
  } else if (kind === 'session') {
    if (!rt.rows.has(id)) throw new Error(`no session ${id}`)
  } else if (!(await rt.store.artifacts.get(id))) throw new Error(`no artifact ${id}`)
}

async function createArtifactOp(rt: WorkspaceRuntime, raw: unknown, defaultAuthor: ArtifactAuthor): Promise<Artifact> {
  const input = artifactInputFrom(raw, { partial: false })
  for (const l of input.links ?? []) await assertLinkable(rt, l.kind, l.id)
  const artifact = await rt.artifacts.create({
    title: input.title ?? 'Untitled',
    body: input.body ?? '',
    author: input.author ?? defaultAuthor,
    ...(input.refs ? { refs: input.refs } : {}),
  })
  for (const l of input.links ?? []) {
    await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: l.kind, toId: l.id, role: l.role })
  }
  log('info', 'artifacts', `created ${artifact.path}`, { id: artifact.id, author: artifact.author, workspace: rt.meta.id })
  return artifact
}

/**
 * Edit in place. `by` is who is asking: a human may edit anything; the model
 * may only rewrite what the model wrote — a human's note it can propose to,
 * never overwrite (.docs/next-version.md).
 */
async function updateArtifactOp(rt: WorkspaceRuntime, id: string, raw: unknown, by: ArtifactAuthor): Promise<Artifact> {
  const input = artifactInputFrom(raw, { partial: true })
  if (input.title === undefined && input.body === undefined && input.refs === undefined) throw new Error('nothing to change')
  const cur = await rt.store.artifacts.get(id)
  if (!cur) throw new Error('no such artifact')
  if (by === 'model' && cur.author !== 'model') {
    throw new Error('this artifact is human-authored — propose the change to the user instead of rewriting it')
  }
  const artifact = await rt.artifacts.update(id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
  })
  log('info', 'artifacts', `updated ${artifact.path}`, { id, by, workspace: rt.meta.id })
  return artifact
}

async function addLinkOp(rt: WorkspaceRuntime, raw: unknown): Promise<Link> {
  const l = (raw ?? {}) as Record<string, unknown>
  if (!isLinkKind(l.fromKind) || !isLinkKind(l.toKind)) throw new Error('fromKind and toKind must be artifact, item or session')
  if (typeof l.fromId !== 'string' || !l.fromId || typeof l.toId !== 'string' || !l.toId) throw new Error('need fromId and toId')
  if (!isLinkRole(l.role)) throw new Error('role must be brief, report, context, dispatch or plan')
  await assertLinkable(rt, l.fromKind, l.fromId)
  await assertLinkable(rt, l.toKind, l.toId)
  return rt.store.links.add({ fromKind: l.fromKind, fromId: l.fromId, toKind: l.toKind, toId: l.toId, role: l.role })
}

/** Both directions, de-duplicated: everything that points at or from one entity. */
async function linksFor(rt: WorkspaceRuntime, kind: LinkKind, id: string): Promise<Link[]> {
  const [to, from] = await Promise.all([rt.store.links.forTarget(kind, id), rt.store.links.forSource(kind, id)])
  const seen = new Set<string>()
  return [...to, ...from].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
}

/** Open a file in whatever the OS opens .md with — the server runs on the user's own machine. */
async function openInEditor(abs: string): Promise<void> {
  if (process.platform === 'darwin') await pExecFile('open', [abs])
  else if (process.platform === 'win32') await pExecFile('cmd', ['/c', 'start', '', abs])
  else await pExecFile('xdg-open', [abs])
}

// --- settings, briefs and dispatch (.docs/next-version.md, phase 2) ----------

const JOBS_ENABLED_KEY = 'jobs.enabled'
const BRIEFS_CAP_KEY = 'briefs.dailyCap'
const BRIEFS_MODEL_KEY = 'briefs.defaultModel'
const HIDDEN_MODELS_KEY = 'models.hidden'
const CUSTOM_MODELS_KEY = 'models.custom'
const DEFAULT_BRIEF_CAP = 20
const BRIEF_TIMEOUT_MS = 300_000

/** The global jobs switch. Off by default: 0.7 is pull-before-push. */
async function jobsEnabled(rt: WorkspaceRuntime): Promise<boolean> {
  return (await rt.store.config.get<boolean>(JOBS_ENABLED_KEY)) === true
}

async function readSettings(rt: WorkspaceRuntime): Promise<WorkspaceSettings> {
  const cap = await rt.store.config.get<number>(BRIEFS_CAP_KEY)
  const model = await rt.store.config.get<string>(BRIEFS_MODEL_KEY)
  const timeout = await rt.store.config.get<number>(JOB_TIMEOUT_KEY)
  const budget = await rt.store.config.get<number>(JOB_BUDGET_KEY)
  return {
    jobsEnabled: await jobsEnabled(rt),
    jobTimeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_JOB_TIMEOUT_MS,
    jobBudgetUsd: typeof budget === 'number' && budget > 0 ? budget : null,
    briefsDailyCap: typeof cap === 'number' && cap > 0 ? cap : DEFAULT_BRIEF_CAP,
    briefsDefaultModel: typeof model === 'string' && model ? model : null,
    hiddenModels: await readIdList(rt, HIDDEN_MODELS_KEY),
    customModels: await readIdList(rt, CUSTOM_MODELS_KEY),
    goalsMaxTeam: await goalMaxTeam(rt.goalDeps),
  }
}

async function readIdList(rt: WorkspaceRuntime, key: string): Promise<string[]> {
  const v = await rt.store.config.get<unknown>(key)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/** A list of model ids from the wire: trimmed, unique, bounded. Anything else is an error, not a repair. */
function modelIdList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || x.trim() === '' || x.length > 120)) {
    throw new Error(`${field} must be a list of model ids`)
  }
  return [...new Set((v as string[]).map((x) => x.trim()))]
}

async function writeSettings(rt: WorkspaceRuntime, raw: unknown): Promise<WorkspaceSettings> {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.jobsEnabled !== undefined) {
    if (typeof r.jobsEnabled !== 'boolean') throw new Error('jobsEnabled must be a boolean')
    await rt.store.config.set(JOBS_ENABLED_KEY, r.jobsEnabled)
    if (r.jobsEnabled) await seedJobTemplates(rt)
    log('info', 'job', `jobs ${r.jobsEnabled ? 'enabled' : 'disabled'}`, { workspace: rt.meta.id })
  }
  if (r.jobTimeoutMs !== undefined) {
    const t = r.jobTimeoutMs
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 30_000 || t > MAX_JOB_TIMEOUT_MS) throw new Error(`jobTimeoutMs must be whole milliseconds from 30000 to ${MAX_JOB_TIMEOUT_MS}`)
    await rt.store.config.set(JOB_TIMEOUT_KEY, t)
  }
  if (r.jobBudgetUsd !== undefined) {
    const b = r.jobBudgetUsd
    if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 100)) throw new Error('jobBudgetUsd must be null or dollars from 0.01 to 100')
    await rt.store.config.set(JOB_BUDGET_KEY, b)
  }
  if (r.briefsDailyCap !== undefined) {
    const n = r.briefsDailyCap
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500) throw new Error('briefsDailyCap must be a whole number from 1 to 500')
    await rt.store.config.set(BRIEFS_CAP_KEY, n)
  }
  if (r.briefsDefaultModel !== undefined) {
    if (r.briefsDefaultModel !== null && typeof r.briefsDefaultModel !== 'string') throw new Error('briefsDefaultModel must be a string or null')
    await rt.store.config.set(BRIEFS_MODEL_KEY, r.briefsDefaultModel || null)
  }
  if (r.hiddenModels !== undefined) await rt.store.config.set(HIDDEN_MODELS_KEY, modelIdList(r.hiddenModels, 'hiddenModels'))
  if (r.customModels !== undefined) await rt.store.config.set(CUSTOM_MODELS_KEY, modelIdList(r.customModels, 'customModels'))
  if (r.goalsMaxTeam !== undefined) {
    const n = r.goalsMaxTeam
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_GOAL_TEAM) throw new Error(`goalsMaxTeam must be a whole number from 1 to ${MAX_GOAL_TEAM}`)
    await rt.store.config.set(GOALS_MAX_TEAM_KEY, n)
  }
  invalidateInbox(rt)
  return readSettings(rt)
}

/** The folder an item's work lands in: its project, else the project whose repo it belongs to, else the default. */
async function projectFor(rt: WorkspaceRuntime, item: WorkItem): Promise<Project | null> {
  const projects = await rt.store.projects.list()
  return (
    (item.projectId ? projects.find((p) => p.id === item.projectId) : undefined) ??
    projects.find((p) => p.repo && p.repo === item.repo) ??
    projects.find((p) => p.isDefault) ??
    null
  )
}

/**
 * Every source item lands with its project stored: the one it names, else the
 * project whose repo it belongs to, else the default — so adding a project
 * later doesn't move it. Only an insert takes it; a refresh keeps the stored one.
 */
async function upsertItem(rt: WorkspaceRuntime, item: WorkItem, prov?: Provenance): Promise<UpsertResult> {
  const project = item.projectId ? null : await projectFor(rt, item)
  return rt.store.items.upsert(project ? { ...item, projectId: project.id } : item, prov)
}

/**
 * Boot: the workspace gets a default project if it has projects but none is
 * the default (the one most sessions ran in), and every session and item
 * saved before projects were stored gets one (decision 549a251e, migration).
 * A workspace with no projects is left alone — onboarding asks for a folder.
 */
async function migrateDefaultProject(rt: WorkspaceRuntime): Promise<void> {
  let projects = await rt.store.projects.list()
  if (projects.length === 0) return
  const resolved = projects.map((p) => ({ id: p.id, root: path.resolve(p.path) }))
  // Longest root first, so a project nested in another claims its own sessions.
  resolved.sort((a, b) => b.root.length - a.root.length)
  const owner = (cwd: string) => {
    const c = path.resolve(cwd)
    return resolved.find((p) => c === p.root || c.startsWith(p.root + path.sep))?.id ?? null
  }
  if (!projects.some((p) => p.isDefault)) {
    const counts = new Map<string, number>()
    for (const s of await rt.store.sessions.list()) {
      const id = s.projectId ?? owner(s.cwd)
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const pick = [...projects].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]
    await rt.store.projects.setDefault(pick.id)
    log('info', 'projects', `default project: ${pick.name} (${counts.get(pick.id) ?? 0} sessions)`, { workspace: rt.meta.id })
    projects = await rt.store.projects.list()
  }
  const fallback = projects.find((p) => p.isDefault)!.id
  const sessions = await rt.store.sessions.backfillProjects((cwd) => owner(cwd) ?? fallback)
  const items = await rt.store.items.backfillProjects((item) => {
    const byRepo = item.repo ? projects.find((p) => p.repo && p.repo === item.repo) : undefined
    return byRepo?.id ?? fallback
  })
  if (sessions || items) log('info', 'projects', `stored a project on ${sessions} sessions and ${items} items`, { workspace: rt.meta.id })
}

/** Record that a session works (dispatch) or documents (brief) an item; mirrored in memory for summaries. */
async function linkSessionToItem(rt: WorkspaceRuntime, sessionId: string, itemId: string, role: 'dispatch' | 'brief'): Promise<void> {
  if (!(await rt.store.items.get(itemId))) return
  await rt.store.links.add({ fromKind: 'session', fromId: sessionId, toKind: 'item', toId: itemId, role })
  rt.sessionItem.set(sessionId, itemId)
  broadcastSessionList(rt)
}

/** The artifact linked to an item as its brief, with the body on disk. */
async function currentBrief(rt: WorkspaceRuntime, itemId: string): Promise<{ artifact: Artifact; body: string } | null> {
  const links = await rt.store.links.forTarget('item', itemId)
  const l = links.find((x) => x.fromKind === 'artifact' && x.role === 'brief')
  if (!l) return null
  const a = await rt.artifacts.read(l.fromId)
  return a ? { artifact: a.artifact, body: a.body } : null
}

async function briefViewFor(rt: WorkspaceRuntime, itemId: string): Promise<BriefView> {
  const [job, item, cur, queued] = await Promise.all([
    rt.store.briefs.latestForItem(itemId),
    rt.store.items.get(itemId),
    currentBrief(rt, itemId),
    rt.store.briefs.list('queued'),
  ])
  const sourceMs = item ? Date.parse(item.updatedAt) : NaN
  // Stale is arithmetic, never a judgment: the source moved after the brief was written.
  const settled = !job || job.status === 'ready' || job.status === 'failed'
  const stale = !!cur && settled && Number.isFinite(sourceMs) && sourceMs > cur.artifact.updated
  const pos = job?.status === 'queued' ? queued.findIndex((q) => q.id === job.id) : -1
  return { job, stale, artifact: cur?.artifact ?? null, body: cur?.body ?? null, queuePosition: pos >= 0 ? pos : null }
}

const broadcastBrief = (rt: WorkspaceRuntime, job: BriefJob) => {
  broadcast(rt, { type: 'brief_status', job })
  // A brief moving moves the item's stage (briefing → ready).
  invalidateInbox(rt)
}

/**
 * Spawn-time extras by session kind. Every session gets the same thing first —
 * who it is inside triage (shared/triageContext.ts): the workspace, its own
 * triage session id, the artifacts folder. That is the layer that is knowable
 * at spawn and true for the session's whole life; what *exists* right now is a
 * tool call, never a prompt. Brief sessions get the headless contract and their
 * write tool on top.
 */
async function extrasFor(rt: WorkspaceRuntime, row: StoredSession): Promise<SessionExtras> {
  const identity = triageSessionAppend(row.kind, {
    sessionId: row.id,
    workspaceId: rt.meta.id,
    workspaceName: rt.meta.name,
    artifactsRoot: rt.artifacts.root,
    libraryRoot: rt.libraryDir,
    juniorName: rt.persona.name,
  })
  const run = teamRunOf(rt, row.id)
  const worker = run && run.leadSessionId !== row.id ? [...run.workers].reverse().find((w) => w.sessionId === row.id) : undefined
  if (run && worker) {
    // Rebuilt per spawn like the brief server: one instance, one transport.
    const { agent, writes, can } = workerSpec(run, worker)
    const tools = rt.provider.agentTools(can as AgentCan[])
    // An agent allowed the browser gets the pane's own tools while Triage.app
    // hosts them; without the app it falls back to the user's chrome-devtools.
    const pane = (can as AgentCan[]).includes('browser') && browserHub.status.compatible
    if (pane) delete tools.mcpServers?.['chrome-devtools']
    const external = tools.mcpServers && Object.keys(tools.mcpServers).length ? tools.mcpServers : undefined
    return {
      systemAppend: `${identity}\n${workerAppend(run, worker, agent, writes)}`,
      mcp: { team: makeTeamMcp(rt, row.id), ...(pane ? { browser: browserMcpFor(rt, row) } : {}) },
      disallowedTools: tools.disallowedTools,
      // A worker loads only what its step needs: a short built-in list and
      // triage's own servers (+ the browser if allowed) — not every connector
      // and plugin in ~/.claude, whose schemas ride every call.
      tools: tools.tools,
      strictMcpConfig: true,
      ...(external ? { externalMcp: external } : {}),
      // Compact long before a 1M window would (it defaults to ~967K there): a
      // worker re-reads its whole history on every call, so history is cost.
      settings: { autoCompactWindow: TEAM_COMPACT_WINDOW },
      // What is left of the run's budget, so one runaway turn can't blow it.
      maxBudgetUsd: Math.max(0.25, run.budgetUsd - runSpent(run)),
    }
  }
  // A chat gets the browser pane's tools: with Triage.app closed they answer
  // "open Triage.app" rather than vanish, so a session never has to respawn.
  // It is one of Junior's chats, so it also gets the persona and today's plan.
  if (row.kind === 'chat') return { systemAppend: `${identity}${await juniorAppend(rt)}`, mcp: { browser: browserMcpFor(rt, row) } }
  // A goal run's session: its goal-bound tools, and its contract last.
  const goalRun = rt.goalRuns.get(row.id)
  if (goalRun) {
    const mcp = { goal: createSdkMcpServer({ name: 'goal', version: VERSION, alwaysLoad: true, tools: goalSessionMcpTools(rt.goalDeps, goalRun) }) }
    const spec = goalRun.spec
    if (spec.role === 'lead') return { systemAppend: `${identity}\n${LEAD_RUN_APPEND}`, mcp, disallowedTools: GOAL_RUN_DISALLOWED_TOOLS }
    return {
      systemAppend: `${identity}\n${goalWorkerAppend(goalRun.role, spec.writes, goalRun.agentPrompt)}\n\n${spec.context}`,
      mcp,
      disallowedTools: GOAL_RUN_DISALLOWED_TOOLS.filter((t) => spec.writes || !EDIT_TOOLS.has(t)),
    }
  }
  // A goal's lead: the drafting contract last, like a brief's.
  if (row.kind === 'goal') return { systemAppend: `${identity}\n${LEAD_DRAFT_APPEND}` }
  if (row.kind !== 'brief') return { systemAppend: identity }
  let e = rt.briefExtras.get(row.id)
  if (!e) {
    // Identity first: the headless contract's "change nothing" must be the last
    // word a brief run reads, not something the identity block then softens.
    e = { systemAppend: `${identity}\n${BRIEF_SYSTEM_APPEND}` }
    rt.briefExtras.set(row.id, e)
  }
  // The server is rebuilt per spawn, never cached: one instance connects to one
  // transport, so a revived run handed the old object would lose write_brief.
  return { ...e, mcp: { brief: makeBriefMcp(rt, row.id) } }
}

/**
 * The brief session's one write: the server picks the file (one per item),
 * writes the frontmatter, commits, links it as the item's brief. Looks the
 * job up by session at call time, so the same server serves every run and
 * iteration in that session.
 */
function makeBriefMcp(rt: WorkspaceRuntime, sessionId: string) {
  return createSdkMcpServer({
    name: 'brief',
    version: VERSION,
    tools: [
      tool(
        'write_brief',
        'Save the brief for this work item. Call exactly once, with the WHOLE document (it replaces any previous brief). The server chooses the file and links it to the item.',
        {
          title: z.string().describe('a short title — the verdict or the one-line summary'),
          body: z.string().describe('the full markdown body'),
          refs: z.array(z.string()).optional().describe('PR/issue URLs or Linear keys the brief cites'),
        },
        async (args) => {
          try {
            // A run writes under its running job. After it, the user may open
            // this session and ask for changes — the rewrite lands on the
            // brief the last job made, so talking to the brief works too.
            const job = await rt.store.briefs.forSession(sessionId)
            if (!job) return errResult('no brief job belongs to this session')
            if (job.status === 'queued') return errResult('a re-brief of this item is queued — it will rewrite the brief; try again after it runs')
            const item = await rt.store.items.get(job.itemId)
            if (!item) return errResult('the work item no longer exists')
            const refs = [...(item.refs ?? []), ...(args.refs ?? [])]
            const artifact = await rt.artifacts.writeAt(briefRelPath(item.id), {
              title: args.title.trim() || item.title,
              body: args.body,
              author: 'model',
              ...(refs.length ? { refs } : {}),
            })
            await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: item.id, role: 'brief' })
            await rt.store.briefs.update(job.id, { artifactId: artifact.id })
            if (job.status === 'running') rt.briefWrote.add(job.id)
            else if (job.status === 'failed') {
              // a run that failed, rescued by the user in the session: the brief exists now
              const finishedAt = Date.now()
              await rt.store.briefs.update(job.id, { status: 'ready', error: null, finishedAt })
              broadcastBrief(rt, { ...job, status: 'ready', error: null, finishedAt, artifactId: artifact.id })
            }
            log('info', 'briefs', `brief written: ${item.title}`, { jobId: job.id, itemId: item.id, artifactId: artifact.id, workspace: rt.meta.id })
            return okResult(`ok: brief saved to ${artifact.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}

/** Queue briefs for items. An item already queued or running keeps its job; a ready one continues its session. */
async function enqueueBriefsOp(rt: WorkspaceRuntime, raw: unknown): Promise<BriefJob[]> {
  const r = (raw ?? {}) as Record<string, unknown>
  const ids = Array.isArray(r.itemIds) ? r.itemIds.filter((x): x is string => typeof x === 'string' && ANY_ITEM_ID_RE.test(x)) : []
  if (!ids.length) throw new Error('need itemIds')
  if (ids.length > 50) throw new Error('at most 50 items at once')
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null
  const model = typeof r.model === 'string' && r.model ? r.model : null
  if (r.playbook !== undefined && !isPlaybookName(r.playbook)) throw new Error('playbook must be a kind name')
  if (r.playbookBody !== undefined && typeof r.playbookBody !== 'string') throw new Error('playbookBody must be text')
  if (typeof r.playbookBody === 'string' && r.playbookBody.length > 20_000) throw new Error('the template is too long (20,000 characters at most)')
  const edited = typeof r.playbookBody === 'string' && r.playbookBody.trim() ? r.playbookBody : null
  const jobs: BriefJob[] = []
  for (const id of ids) {
    const item = await rt.store.items.get(id)
    if (!item) throw new Error(`no work item ${id}`)
    const latest = await rt.store.briefs.latestForItem(id)
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      jobs.push(latest)
      continue
    }
    const playbook = (r.playbook as string | undefined) ?? item.kind
    // Kept only when it differs from the file, so an untouched template keeps following the file.
    const playbookBody = edited && edited !== (await readPlaybook(rt.playbookDir, playbook)).body ? edited : null
    const job = await rt.store.briefs.create({ id: randomUUID(), itemId: id, playbook, playbookBody, model, note })
    // A re-brief of a finished brief continues the session that wrote it — it already knows the item.
    if (latest?.status === 'ready' && latest.sessionId && rt.rows.has(latest.sessionId)) {
      await rt.store.briefs.update(job.id, { sessionId: latest.sessionId })
      job.sessionId = latest.sessionId
    }
    jobs.push(job)
    broadcastBrief(rt, job)
    log('info', 'briefs', `queued: ${item.title}`, { jobId: job.id, itemId: id, workspace: rt.meta.id })
  }
  pumpBriefQueue(rt)
  return jobs
}

/**
 * Queue the brief a job asks for on an item it just filed. Never fails the
 * scan: a brief that can't be queued (the daily cap) shows on the item as a
 * failed brief, which Today raises under Something broke.
 */
function briefFiledItem(rt: WorkspaceRuntime, job: Job, itemId: string, runId: string): void {
  const b = job.brief ?? {}
  enqueueBriefsOp(rt, {
    itemIds: [itemId],
    ...(b.model ? { model: b.model } : {}),
    ...(b.template ? { playbook: b.template } : {}),
  })
    .then(() => log('info', 'job', `brief queued for ${itemId}`, { jobId: job.id, runId, itemId, workspace: rt.meta.id }))
    .catch((err) => log('error', 'job', `could not queue a brief for ${itemId}: ${errText(err)}`, { jobId: job.id, runId, itemId, workspace: rt.meta.id }))
}

/**
 * "You missed X": the item page's feedback goes straight into the session that
 * wrote the brief, as the user's own message — the same as typing it there —
 * and that session rewrites the brief with write_brief. Tracked as a job, so
 * the item shows briefing → ready. Not queued: it is a reply to a session that
 * already knows the item. With that session gone, it queues a fresh run
 * carrying the feedback as its note.
 */
async function iterateBriefOp(rt: WorkspaceRuntime, raw: unknown): Promise<BriefJob> {
  const r = (raw ?? {}) as Record<string, unknown>
  const itemId = typeof r.itemId === 'string' ? r.itemId : ''
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!ANY_ITEM_ID_RE.test(itemId)) throw new Error('need an itemId')
  if (!text) throw new Error('say what to change')
  const latest = await rt.store.briefs.latestForItem(itemId)
  if (!latest || (latest.status !== 'ready' && latest.status !== 'failed')) throw new Error('no finished brief to iterate on yet')
  const row = latest.sessionId ? rt.rows.get(latest.sessionId) : undefined
  const base = { id: randomUUID(), itemId, playbook: latest.playbook, model: latest.model, note: text }
  if (!row) {
    const job = await rt.store.briefs.create(base)
    broadcastBrief(rt, job)
    pumpBriefQueue(rt)
    return job
  }
  await assertBriefCap(rt)
  // Born running, so the queue never sees it and sends a second prompt.
  const job = await rt.store.briefs.create({ ...base, running: { sessionId: row.id, startedAt: Date.now() } })
  broadcastBrief(rt, job)
  try {
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not reopen the brief session')
    armBriefTimer(rt, job.id, live)
    await live.sendUserMessage(text)
  } catch (err) {
    await finishBrief(rt, job.id, 'failed', errText(err))
    throw err
  }
  log('info', 'briefs', `feedback sent to the brief session: ${itemId}`, { jobId: job.id, itemId, sessionId: row.id, workspace: rt.meta.id })
  return job
}

/** The daily cap on brief runs (Settings → Briefs). */
async function assertBriefCap(rt: WorkspaceRuntime): Promise<void> {
  const settings = await readSettings(rt)
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  if ((await rt.store.briefs.countStartedSince(dayStart.getTime())) >= settings.briefsDailyCap) {
    throw new Error(`the daily cap of ${settings.briefsDailyCap} brief runs is reached — raise it in Settings → Briefs, or try tomorrow`)
  }
}

/** A brief turn that runs past the limit fails, and its subprocess is stopped. */
function armBriefTimer(rt: WorkspaceRuntime, jobId: string, live: LiveSession): void {
  rt.briefTimers.set(
    jobId,
    setTimeout(() => {
      void finishBrief(rt, jobId, 'failed', 'timed out after 5 minutes').then(() => {
        void live.interrupt()
        live.stop()
      })
    }, BRIEF_TIMEOUT_MS),
  )
}

function pumpBriefQueue(rt: WorkspaceRuntime): void {
  if (rt.briefActive || rt.briefPumping) return
  rt.briefPumping = true
  void (async () => {
    const [next] = await rt.store.briefs.list('queued')
    if (!next) return
    rt.briefActive = next.id
    try {
      await startBriefRun(rt, next)
    } catch (err) {
      await finishBrief(rt, next.id, 'failed', errText(err))
    }
  })()
    .catch((err) => log('error', 'briefs', `pump failed: ${err}`, { workspace: rt.meta.id }))
    .finally(() => {
      rt.briefPumping = false
    })
}

async function startBriefRun(rt: WorkspaceRuntime, job: BriefJob): Promise<void> {
  await assertBriefCap(rt)
  const settings = await readSettings(rt)
  const item = await rt.store.items.get(job.itemId)
  if (!item) throw new Error('the work item no longer exists')
  const playbook = job.playbookBody ?? (await readPlaybook(rt.playbookDir, job.playbook)).body
  const existing = await currentBrief(rt, item.id)
  const reuse = job.sessionId ? rt.rows.get(job.sessionId) ?? null : null
  let row: StoredSession
  if (reuse) row = reuse
  else {
    const project = await projectFor(rt, item)
    row = await createSession(
      rt,
      `Brief · ${item.title.slice(0, 70)}`,
      project?.path ?? os.homedir(),
      job.model ?? settings.briefsDefaultModel,
      null,
      false,
      'gated',
      { kind: 'brief', projectId: project?.id ?? null },
    )
    await linkSessionToItem(rt, row.id, item.id, 'brief')
  }
  const startedAt = Date.now()
  await rt.store.briefs.update(job.id, { status: 'running', sessionId: row.id, startedAt, error: null })
  rt.briefWrote.delete(job.id)
  broadcastBrief(rt, { ...job, status: 'running', sessionId: row.id, startedAt, error: null })
  const live = await getOrRevive(rt, row.id)
  if (!live) throw new Error('could not start the brief session')
  armBriefTimer(rt, job.id, live)
  const scored = rt.inboxCache?.items.find((i) => i.id === item.id)
  const iteration = !!reuse && !!job.note && !!existing
  // Screenshots the human put on the item ride the first message as real
  // image blocks — a brief about a broken UI needs to see it.
  const images = await itemImageAttachments(rt.attachmentsDir, item.id, item.images)
  await live.sendUserMessage(
    composeBriefPrompt({
      item,
      reason: scored?.reason,
      playbookName: job.playbook,
      playbook,
      note: job.note,
      existing: existing?.body ?? null,
      iteration,
      imageCount: images?.length ?? 0,
    }),
    images,
  )
  log('info', 'briefs', `run started: ${item.title}${iteration ? ' (iteration)' : ''}`, {
    jobId: job.id,
    itemId: item.id,
    sessionId: row.id,
    playbook: job.playbook,
    workspace: rt.meta.id,
  })
}

async function finishBrief(rt: WorkspaceRuntime, jobId: string, status: 'ready' | 'failed', error?: string): Promise<void> {
  const job = await rt.store.briefs.get(jobId)
  const timer = rt.briefTimers.get(jobId)
  if (timer) clearTimeout(timer)
  rt.briefTimers.delete(jobId)
  rt.briefWrote.delete(jobId)
  if (job && (job.status === 'running' || job.status === 'queued')) {
    const finishedAt = Date.now()
    await rt.store.briefs.update(jobId, { status, error: error ?? null, finishedAt })
    broadcastBrief(rt, { ...job, status, error: error ?? null, finishedAt })
    // Nothing more to do in the subprocess; iteration revives it with `resume`.
    if (job.sessionId) rt.live.get(job.sessionId)?.stop()
    log(status === 'ready' ? 'info' : 'error', 'briefs', `run ${status}: ${job.itemId}${error ? ` — ${error}` : ''}`, {
      jobId,
      itemId: job.itemId,
      status,
      workspace: rt.meta.id,
      ...(error ? { error } : {}),
    })
  }
  if (rt.briefActive === jobId) rt.briefActive = null
  pumpBriefQueue(rt)
}

/** The run's turn ended: ready if write_brief landed, else the model finished without writing. */
async function onBriefTurnDone(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const job = await rt.store.briefs.forSession(sessionId)
  if (!job || job.status !== 'running') return
  const wrote = rt.briefWrote.has(job.id)
  await finishBrief(rt, job.id, wrote ? 'ready' : 'failed', wrote ? undefined : 'the run finished without calling write_brief')
}

/** The subprocess died mid-run (crash, interrupt, auth): the job cannot complete. */
async function onBriefSessionEnded(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  const job = await rt.store.briefs.forSession(sessionId)
  if (!job || job.status !== 'running') return
  await finishBrief(rt, job.id, 'failed', 'the brief session ended before it finished')
}

// ---------------------------------------------------------------------------
// Goals: the drafting lead (server/goals.ts reacts, this spawns). One headless,
// read-only session per wake whose one write is goal_propose_plan; its turn's
// end settles it, which marks the waking event handled.
// ---------------------------------------------------------------------------

const GOAL_LEAD_TIMEOUT_MS = 20 * 60_000
/** What a drafting lead may call beyond reads: the goal reads and its plan. */
const GOAL_LEAD_TOOLS = new Set(['mcp__triage__goal_get', 'mcp__triage__goal_list', 'mcp__triage__goal_propose_plan'])
/** A brief's hidden tools, plus the goal writes that aren't the lead's in M2. */
const GOAL_LEAD_DISALLOWED_TOOLS = [...BRIEF_DISALLOWED_TOOLS, ...['goal_create', 'goal_log_append', 'goal_handoff_write'].map((t) => `mcp__triage__${t}`)]

type GoalLead = { goalId: string; sessionId: string; seq: number; timer: ReturnType<typeof setTimeout>; release: () => void }

/**
 * What a goal run's session can't reach: the questions nobody answers, the
 * triage writes outside its goal, and the unbound goal tools (it has its own,
 * bound to its goal, on the `goal` server). Write tools stay listed for a
 * worker that may write only so the filter in extrasFor can lift them.
 */
const GOAL_RUN_DISALLOWED_TOOLS = [
  ...BRIEF_DISALLOWED_TOOLS,
  ...['goal_create', 'goal_propose_plan', 'goal_log_append', 'goal_handoff_write'].map((t) => `mcp__triage__${t}`),
]

/** One session the goal run loop started. */
type GoalRun = GoalSessionTag & { spec: StartSpec; agentPrompt: string | null; timer: ReturnType<typeof setTimeout>; release: () => void }

/** How long one gate check session may run before it is cut off. */
const GATE_CHECK_TIMEOUT_MS = 5 * 60_000

/**
 * The gate checker (decision 6): one short, headless, read-only session over
 * every due AI gate in a batch. It gets the condition and the ids, the read
 * tools of the connectors those gates name (ToolSearch loads them), and one
 * write — its verdicts, on its own `gate` server. The fence refuses anything
 * else before any allow rule runs: no shell, no file tool, no connector write.
 */
const runGateCheck = (rt: WorkspaceRuntime): GateChecker => async (gates, model) => {
  const verdicts = new Map<string, GateVerdict>()
  let costUsd = 0
  const home = rt.connectorCache ?? (await probeConnectors(rt).catch(() => null))
  const probes = home?.connectors ?? []
  const connectors = [...new Set(gates.flatMap((g) => g.connectors))]
  const readTools = new Set(gateReadTools(connectors, probes))
  const keep = new Set(gateServers(connectors, probes))
  // Every other connector the user has: out of the run entirely (the fence would refuse them anyway).
  const disallowedTools = [...new Set(probes.filter((c) => !keep.has(c.server)).map((c) => `mcp__${c.server.replace(/[^a-zA-Z0-9_-]/g, '_')}`))].sort()
  const ids = new Set(gates.map((g) => g.id))
  const server = createSdkMcpServer({
    name: GATE_SERVER,
    version: VERSION,
    alwaysLoad: true,
    tools: [
      tool(
        GATE_VERDICT_TOOL,
        'Hand in one verdict per gate id you were given, then stop.',
        {
          verdicts: z.array(
            z.object({
              gateId: z.string(),
              verdict: z.enum(['met', 'not_met', 'needs_user', 'error']),
              evidence: z.string().describe('one short line: what you saw'),
              checkAgainIn: z.string().optional().describe('like "2h", when you can tell it will be a while'),
            }),
          ),
        },
        async (a) => {
          const bad: string[] = []
          for (const raw of a.verdicts) {
            const v = verdictFrom(raw)
            if (v && ids.has(raw.gateId)) verdicts.set(raw.gateId, v)
            else bad.push(raw.gateId)
          }
          const missing = [...ids].filter((id) => !verdicts.has(id))
          const text = [bad.length ? `ignored: ${bad.join(', ')} (unknown id or off-format)` : null, missing.length ? `still missing: ${missing.join(', ')}` : 'all recorded; stop now'].filter(Boolean).join('; ')
          return { content: [{ type: 'text' as const, text }] }
        },
      ),
    ],
  })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), GATE_CHECK_TIMEOUT_MS)
  const release = power.hold(`gate sweep ${rt.meta.id}`)
  try {
    const run = rt.provider.run({
      prompt: gateCheckPrompt(gates),
      cwd: workspaceDir(rt.meta.id),
      // The user's own MCP servers and claude.ai connectors; no project settings, skills or hooks.
      userConfig: true,
      tools: [GATE_TOOL_SEARCH],
      allowedTools: [GATE_TOOL_SEARCH, GATE_VERDICT_FULL, ...readTools],
      ...(disallowedTools.length ? { disallowedTools } : {}),
      unattended: true,
      veto: (toolName) => {
        const dec = gateFenceDecision(readTools, toolName)
        if (!dec.allow) log('warn', 'goals', `gate checker refused ${toolName}`, { workspace: rt.meta.id, gates: [...ids] })
        return dec
      },
      model,
      // A few reads per gate, the verdict, the stop.
      maxTurns: 4 + 3 * gates.length,
      maxBudgetUsd: 0.5,
      mcpServers: { [GATE_SERVER]: server },
      abort,
      ...(rt.env ? { env: rt.env } : {}),
    })
    for await (const ev of run) if (ev.kind === 'result' && ev.costUsd != null) costUsd = ev.costUsd
  } catch (err) {
    log('error', 'goals', `gate check failed: ${abort.signal.aborted ? `timed out after ${humanSpan(GATE_CHECK_TIMEOUT_MS)}` : errText(err)}`, { workspace: rt.meta.id })
  } finally {
    clearTimeout(timer)
    release()
  }
  return { verdicts, costUsd }
}

/** One sweep per workspace at a time: a slow check never overlaps the next tick. */
const gateSweeping = new WeakSet<WorkspaceRuntime>()
async function sweepGates(rt: WorkspaceRuntime): Promise<void> {
  if (gateSweeping.has(rt)) return
  gateSweeping.add(rt)
  try {
    const r = await goalGateSweepOp(rt.goalDeps, goalEngineFor(rt), runGateCheck(rt))
    if (r.checked || r.toUser) log('info', 'goals', `gate sweep: ${r.checked} checked, ${r.resolved} met, ${r.toUser} to you`, { workspace: rt.meta.id })
  } finally {
    gateSweeping.delete(rt)
  }
}

/** One PR watcher pass per workspace at a time. */
const prWatching = new WeakSet<WorkspaceRuntime>()
async function watchPrs(rt: WorkspaceRuntime): Promise<void> {
  if (prWatching.has(rt)) return
  prWatching.add(rt)
  try {
    const src = ghPrSource((goal) => (goal.checkoutId ? (rt.checkouts.get(goal.checkoutId)?.path ?? null) : null))
    const r = await goalWatchPrsOp(rt.goalDeps, goalEngineFor(rt), src)
    if (r.acted || r.toUser) log('info', 'goals', `PR watcher: ${r.polled} polled, ${r.acted} acted on, ${r.toUser} to you`, { workspace: rt.meta.id })
  } finally {
    prWatching.delete(rt)
  }
}

function goalEngineFor(rt: WorkspaceRuntime): GoalEngine {
  const eng: GoalEngine = {
    wakeLead: (goal, wake, ev) => startGoalLead(rt, goal, wake, ev),
    stepsQueued: () => void pumpGoals(rt.goalDeps, eng).catch((err) => log('error', 'goals', `pump failed: ${errText(err)}`, { workspace: rt.meta.id })),
    startSession: (goal, spec, started) => startGoalSession(rt, goal, spec, started),
    stopSessions: async (goalId) => {
      for (const g of [...rt.goalRuns.values()]) if (g.goalId === goalId) await endGoalSession(rt, g.sessionId, 'stopped: you took over')
    },
    worktreeHead: async (goal) => {
      const c = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
      if (!c) return null
      const { stdout } = await pExecFile('git', ['-C', c.path, 'rev-parse', 'HEAD'])
      return stdout.trim() || null
    },
    openWorktree: async (goal) => {
      const c = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
      if (c) await openInEditor(c.path)
    },
    mergeBack: (goal, sessionId) => mergeGoalChild(rt, goal, sessionId),
    worktreeDiff: async (goal) => {
      const c = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
      if (!c) return ''
      const base = c.base ?? (await defaultBranch(c.path))
      if (!base) return ''
      const range = `${base}...HEAD`
      const opts = { maxBuffer: 32 * 1024 * 1024 }
      const [stat, patch] = await Promise.all([pExecFile('git', ['-C', c.path, 'diff', '--stat', range], opts), pExecFile('git', ['-C', c.path, 'diff', range], opts)])
      return [stat.stdout.trim(), patch.stdout.trim()].filter(Boolean).join('\n\n')
    },
  }
  return eng
}

/**
 * A builder that worked beside others did it in a child worktree (decision 2,
 * M6): commit what it left, merge its branch into the goal branch, then remove
 * the child. A conflict aborts the merge and is the step's failure; the child
 * stays for the lead's next move or the user's look.
 */
async function mergeGoalChild(rt: WorkspaceRuntime, goal: Goal, sessionId: string): Promise<string | null> {
  const childId = rt.rows.get(sessionId)?.checkoutId
  if (!childId || !goal.checkoutId || childId === goal.checkoutId) return null
  const child = rt.checkouts.get(childId)
  const into = rt.checkouts.get(goal.checkoutId)
  if (!child?.branch || !into) return child ? "the child worktree's branch is gone" : null
  const git = (cwd: string, args: string[]) => pExecFile('git', ['-C', cwd, ...args])
  try {
    await git(child.path, ['add', '-A'])
    const staged = await git(child.path, ['diff', '--cached', '--quiet']).then(
      () => false,
      () => true,
    )
    if (staged) await git(child.path, ['commit', '-m', `work left uncommitted on ${child.branch}`])
    await git(into.path, ['merge', '--no-ff', '--no-edit', child.branch])
  } catch (err) {
    await git(into.path, ['merge', '--abort']).catch(() => {})
    return errText(err).split('\n').find((l) => l.trim())?.slice(0, 300) ?? 'git merge failed'
  }
  try {
    await removeWorktree(child, { force: false, deleteBranch: true, merged: true })
    await syncCheckouts(rt)
  } catch (err) {
    log('warn', 'goals', `merged ${child.branch} but couldn't remove its worktree: ${errText(err)}`, { goalId: goal.id, workspace: rt.meta.id })
  }
  log('info', 'goals', `merged ${child.branch} into ${into.branch ?? 'the goal branch'}`, { goalId: goal.id, sessionId, workspace: rt.meta.id })
  return null
}

/** The goal's one worktree (decision 2): made on its first session, on a goal/<slug> branch. */
async function goalCheckout(rt: WorkspaceRuntime, goal: Goal, project: Project): Promise<Checkout> {
  const have = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
  if (have) return have
  const slug = goal.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'goal'
  const made = await makeWorktree(rt, project, `goal/${slug}-${goal.id.slice(0, 6)}`, goal.sourceItemId ?? undefined)
  await rt.goalDeps.store.goals.update(goal.id, { checkoutId: made.id }, Date.now())
  return made
}

/**
 * Start the session the scheduler picked (server/goals.ts startGoal): the run
 * lead for a wake, or a worker for one dispatched step, in the goal's
 * worktree. A worker's first message is `/goal <the step is done>`, so it
 * keeps going until the step's done-when holds. A throw before `started` is
 * the scheduler's to handle; after, the session ends here.
 */
async function startGoalSession(rt: WorkspaceRuntime, stale: Goal, spec: StartSpec, started: (sessionId: string) => Promise<void>): Promise<void> {
  // Read again: a worker started a moment ago in the same batch may have made the goal's worktree.
  const goal = (await rt.goalDeps.store.goals.get(stale.id)) ?? stale
  const project = goal.projectId ? (await rt.store.projects.list()).find((p) => p.id === goal.projectId) : undefined
  if (!project) throw new Error(goal.projectId ? `its project ${goal.projectId} is gone` : 'it has no project to work in')
  const main = await goalCheckout(rt, goal, project)
  // A builder beside others gets its own branch off the goal's, merged back when its step is done (mergeGoalChild).
  const checkout =
    spec.role !== 'lead' && spec.worktree === 'child' && main.branch
      ? await makeWorktree(rt, project, `${main.branch}--${spec.stepId.replace(/[^\w-]+/g, '-')}-${randomUUID().slice(0, 4)}`, goal.sourceItemId ?? undefined, undefined, main.branch)
      : main
  const agent = spec.role === 'lead' ? null : ROLE_AGENT[spec.role]
  const agentPrompt = agent ? ((await rt.teamLibrary.readAgent(agent))?.prompt ?? null) : null
  const title = spec.role === 'lead' ? `Goal lead · ${goal.title.slice(0, 70)}` : `${spec.role[0]!.toUpperCase()}${spec.role.slice(1)} · ${spec.stepId} · ${goal.title.slice(0, 60)}`
  const row = await createSession(rt, title, checkout.path, spec.model, null, false, 'gated', { kind: 'goal', projectId: project.id, checkoutId: checkout.id, spawn: false })
  rt.goalRuns.set(row.id, {
    goalId: goal.id,
    sessionId: row.id,
    role: spec.role,
    stepId: spec.role === 'lead' ? null : spec.stepId,
    spec,
    agentPrompt,
    // The Mac stays awake while a goal session runs: a sleeping Mac hangs a headless run (M0).
    release: power.hold(`goal ${goal.id}`),
    timer: setTimeout(() => void endGoalSession(rt, row.id, `timed out after ${GOAL_SESSION_TIMEOUT_MS / 60_000} minutes`), GOAL_SESSION_TIMEOUT_MS),
  })
  try {
    await started(row.id)
  } catch (err) {
    const g = rt.goalRuns.get(row.id)
    rt.goalRuns.delete(row.id)
    if (g) {
      clearTimeout(g.timer)
      g.release()
    }
    throw err
  }
  try {
    if (goal.sourceItemId && (await rt.store.items.get(goal.sourceItemId))) await linkSessionToItem(rt, row.id, goal.sourceItemId, 'dispatch')
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not start the session')
    await live.sendUserMessage(spec.role === 'lead' ? spec.prompt : spec.first)
    log('info', 'goals', `${spec.role}${spec.role === 'lead' ? '' : ` on ${spec.stepId}`} started: ${goal.title}`, { goalId: goal.id, sessionId: row.id, workspace: rt.meta.id })
  } catch (err) {
    await endGoalSession(rt, row.id, errText(err))
  }
}

/** A goal run's session ended, timed out or was stopped: stop it, then let the run loop move the goal. Once per session. */
async function endGoalSession(rt: WorkspaceRuntime, sessionId: string, error: string | null, costUsd = 0): Promise<void> {
  const g = rt.goalRuns.get(sessionId)
  if (!g) return
  rt.goalRuns.delete(sessionId)
  clearTimeout(g.timer)
  g.release()
  const live = rt.live.get(sessionId)
  if (live) {
    if (error) void live.interrupt()
    live.stop()
  }
  try {
    await goalSessionEndedOp(rt.goalDeps, goalEngineFor(rt), { goalId: g.goalId, sessionId, error, costUsd })
  } catch (err) {
    log('error', 'goals', `could not settle a session of ${g.goalId}: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

/** Start the lead for one wake. A throw before the session exists is settled by onGoalEvent; after, here. */
async function startGoalLead(rt: WorkspaceRuntime, goal: Goal, wake: LeadWake, ev: GoalEvent): Promise<void> {
  const prior = rt.goalLeads.get(goal.id)
  if (prior) await settleGoalLead(rt, prior.sessionId, 'a newer wake replaced it')
  const project = goal.projectId ? (await rt.store.projects.list()).find((p) => p.id === goal.projectId) : undefined
  if (!project) throw new Error(goal.projectId ? `its project ${goal.projectId} is gone` : 'it has no project to work in')
  const row = await createSession(
    rt,
    `Goal lead · ${goal.title.slice(0, 70)}`,
    project.path,
    goal.plan?.models?.lead ?? DEFAULT_GOAL_MODELS.lead,
    null,
    false,
    'gated',
    { kind: 'goal', projectId: project.id, spawn: false },
  )
  // The Mac stays awake while the lead drafts: a sleeping Mac hangs a headless run (M0).
  const lead: GoalLead = {
    goalId: goal.id,
    sessionId: row.id,
    seq: ev.seq,
    release: power.hold(`goal ${goal.id}`),
    timer: setTimeout(() => void settleGoalLead(rt, row.id, `timed out after ${GOAL_LEAD_TIMEOUT_MS / 60_000} minutes`), GOAL_LEAD_TIMEOUT_MS),
  }
  rt.goalLeads.set(goal.id, lead)
  try {
    await goalLeadStartedOp(rt.goalDeps, goal.id, row.id)
    if (goal.sourceItemId && (await rt.store.items.get(goal.sourceItemId))) await linkSessionToItem(rt, row.id, goal.sourceItemId, 'dispatch')
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not start the lead session')
    const plan = wake.kind === 'revise' ? (await rt.goalLedger.read(goal.id, 0)).plan : ''
    const blocks = (await rt.goalDeps.blocks?.()) ?? []
    const staffing = { blocks: blocks.map((b) => ({ name: b.name, label: b.label, description: b.description, steps: b.steps.length })), maxTeam: await goalMaxTeam(rt.goalDeps) }
    await live.sendUserMessage(leadDraftPrompt(goal, wake, plan.trim() ? plan : null, staffing))
    log('info', 'goals', `lead ${wake.kind === 'draft' ? 'drafting' : `revising v${wake.version}`}: ${goal.title}`, { goalId: goal.id, sessionId: row.id, workspace: rt.meta.id })
  } catch (err) {
    await settleGoalLead(rt, row.id, errText(err))
  }
}

/** The lead's turn ended, it timed out, or its session died: stop it and settle its wake. Once per lead. */
async function settleGoalLead(rt: WorkspaceRuntime, sessionId: string, error?: string): Promise<void> {
  const lead = [...rt.goalLeads.values()].find((l) => l.sessionId === sessionId)
  if (!lead) return
  rt.goalLeads.delete(lead.goalId)
  clearTimeout(lead.timer)
  lead.release()
  const live = rt.live.get(sessionId)
  if (live) {
    if (error) void live.interrupt()
    live.stop()
  }
  try {
    await goalLeadSettledOp(rt.goalDeps, { goalId: lead.goalId, seq: lead.seq, sessionId, error: error ?? null })
  } catch (err) {
    log('error', 'goals', `could not settle the lead of ${lead.goalId}: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

/** Boot: seed the prose files, mirror session→item links, fail runs the old daemon took down, pump. */
async function bootBriefs(rt: WorkspaceRuntime): Promise<void> {
  await seedPlaybooks(rt.playbookDir).catch((err) => log('error', 'briefs', `could not seed playbooks: ${err}`, { workspace: rt.meta.id }))
  await seedDispatchTemplates(rt.dispatchDir).catch((err) => log('error', 'briefs', `could not seed dispatch templates: ${err}`, { workspace: rt.meta.id }))
  for (const l of await rt.store.links.list()) {
    if (l.fromKind === 'session' && l.toKind === 'item') rt.sessionItem.set(l.fromId, l.toId)
  }
  const failed = await rt.store.briefs.failAllRunning('the daemon restarted while this brief was running — re-brief to try again')
  if (failed.length) log('warn', 'briefs', `failed ${failed.length} run(s) interrupted by the restart`, { jobIds: failed, workspace: rt.meta.id })
  pumpBriefQueue(rt)
}

// ---------------------------------------------------------------------------
// Teams v2 (server/teams.ts, core/teams/engine.ts): a recipe run by triage. The
// lead is the chat session that proposed it; workers are sessions triage spawns
// per step. The engine decides; this section carries its actions out.
// ---------------------------------------------------------------------------
const TEAM_RUNS_KEY = 'team_runs'

async function saveTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  await rt.store.config.set(TEAM_RUNS_KEY, [...rt.teamRuns.values()])
}

/** Boot: mirror stored runs into memory. Runs from before recipes (no `recipe`) are dropped. */
async function loadTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  let backfilled = false
  for (const run of (await rt.store.config.get<TeamRun[]>(TEAM_RUNS_KEY)) ?? []) {
    if (!run || !(run as Partial<TeamRun>).recipe || !rt.rows.has(run.leadSessionId)) continue
    for (const w of run.workers) if (w.sessionId && !rt.rows.has(w.sessionId)) w.sessionId = null
    const unrecorded = !(run as Partial<TeamRun>).workerRuns
    rt.teamRuns.set(run.id, normalizeRun(run))
    indexTeamRun(rt, run)
    if (unrecorded && run.outputs.length) {
      await backfillTeamRuns(rt, run).catch((err) => log('warn', 'teams', `could not backfill runs: ${err}`, { teamId: run.id, workspace: rt.meta.id }))
      backfilled = true
    }
  }
  if (backfilled) await saveTeamRuns(rt)
}

/** A run from before runs were recorded: find where each step arrived in its session's log. */
async function backfillTeamRuns(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  const starts: Record<string, { seq: number; at: number; fresh: boolean }[]> = {}
  for (const sid of new Set(run.workers.map((w) => w.sessionId).filter((x): x is string => !!x))) {
    const events = await rt.store.events.read(sid)
    starts[sid] = []
    events.forEach((e, i) => {
      const ev = e.event
      if (ev.kind !== 'local_user' || ev.from !== 'triage' || !STEP_MESSAGE.test(ev.text)) return
      // A fresh context announces itself just before the step that starts it.
      const prev = events[i - 1]?.event
      const fresh = prev?.kind === 'notice' && prev.text.startsWith('fresh context')
      starts[sid].push({ seq: fresh ? events[i - 1].seq : e.seq, at: e.createdAt, fresh })
    })
  }
  backfillRuns(run, starts)
}

/** session id → run id, for the lead and every worker session. */
function indexTeamRun(rt: WorkspaceRuntime, run: TeamRun): void {
  rt.sessionTeam.set(run.leadSessionId, run.id)
  for (const w of run.workers) if (w.sessionId) rt.sessionTeam.set(w.sessionId, run.id)
}

const teamRunOf = (rt: WorkspaceRuntime, sessionId: string): TeamRun | undefined => {
  const id = rt.sessionTeam.get(sessionId)
  return id ? rt.teamRuns.get(id) : undefined
}

/** A session's place on a run, as the wire carries it. */
function teamRunLink(rt: WorkspaceRuntime, sessionId: string): SessionTeamRun | undefined {
  const run = teamRunOf(rt, sessionId)
  if (!run) return undefined
  const lead = run.leadSessionId === sessionId
  const w = [...run.workers].reverse().find((x) => x.sessionId === sessionId && x.agent !== LEAD)
  return { id: run.id, role: lead ? 'lead' : 'worker', label: lead ? 'Lead' : w?.label ?? 'Worker', state: run.state, rev: run.rev, ...(run.goal ? { goal: true } : {}) }
}

/** The run as the client reads it: everything but the server's own bookkeeping. */
function teamRunView(run: TeamRun): TeamRunView {
  const { root: _root, checkCmds: _cmds, baseTree: _base, nudged: _nudged, ...view } = run
  return { ...view, spentUsd: runSpent(run) }
}

/** A worker's history is compacted past this many tokens (see extrasFor). */
const TEAM_COMPACT_WINDOW = 200_000

/** Write a notice into a session's transcript, live or not. */
async function sessionNotice(rt: WorkspaceRuntime, sessionId: string, text: string): Promise<void> {
  const live = rt.live.get(sessionId)
  if (live) return live.notice(text)
  const seq = (await rt.store.events.lastSeq(sessionId)) + 1
  const event: SessionEvent = { kind: 'notice', text }
  await rt.store.events.append(sessionId, seq, event)
  broadcast(rt, { type: 'session_event', sessionId, event, at: Date.now() })
}

const usd = (n: number) => `$${n.toFixed(2)}`

/** Work on one run at a time: a turn ending and an API call never interleave their actions. */
function withTeamRun<T>(rt: WorkspaceRuntime, run: TeamRun, fn: () => Promise<T>): Promise<T> {
  const prev = rt.teamLocks.get(run.id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  rt.teamLocks.set(run.id, next.catch(() => {}))
  return next
}

async function teamRunChanged(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  await saveTeamRuns(rt)
  broadcastSessionList(rt)
  schedulePlanSync(rt, run)
}

/**
 * The run folder — plan, ledger, verify, reviews, handoffs — rendered from the
 * run (core/teams/files.ts); triage's code is its only writer. Coalesced: a
 * burst of changes is one write, and an unchanged file is no write. Runs from
 * before the folder kept their Plan artifact; it is left as it was.
 */
const FOLDER_SYNC_MS = 1500
function schedulePlanSync(rt: WorkspaceRuntime, run: TeamRun, now = false): Promise<void> | void {
  const key = `${rt.meta.id}:${run.id}`
  clearTimeout(planTimers.get(key))
  planTimers.delete(key)
  if (now) return syncPlan(rt, run)
  planTimers.set(
    key,
    setTimeout(() => {
      planTimers.delete(key)
      void syncPlan(rt, run)
    }, FOLDER_SYNC_MS),
  )
}
const planTimers = new Map<string, ReturnType<typeof setTimeout>>()

async function syncPlan(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  if (rt.teamRuns.has(run.id)) await syncRunFolder(rt, run)
}

/**
 * Where a run's folder lives (.docs/team-handoffs.md): in the project's own
 * `.triage/` when it has one, so the run sits beside the code it changed; else
 * in the workspace folder under ~/.triage.
 */
function teamRunDir(rt: WorkspaceRuntime, runId: string, root: string | undefined): string {
  const local = root ? path.join(root, '.triage') : null
  if (local) {
    try {
      if (statSync(local).isDirectory()) return path.join(local, 'team-runs', runId)
    } catch {
      /* no project folder: the workspace's */
    }
  }
  return path.join(workspaceDir(rt.meta.id), 'team-runs', runId)
}

/** A run's folder; runs from before folders get one now. */
function runDirOf(rt: WorkspaceRuntime, run: TeamRun): string {
  run.dir ??= teamRunDir(rt, run.id, run.root)
  return run.dir
}

/** What each run-folder file last held, so an unchanged file is never rewritten. */
const runFolderSeen = new Map<string, string>()

/** Write the run folder (core/teams/files.ts): every file that changed since the last write. */
async function syncRunFolder(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  const dir = runDirOf(rt, run)
  try {
    // Inside the project, the runs folder ignores itself: the team's own notes must never show up
    // in the diff a reviewer reads, or in a handoff's changed files.
    if (run.root && dir.startsWith(path.join(run.root, '.triage') + path.sep)) {
      const ignore = path.join(path.dirname(dir), '.gitignore')
      if (!runFolderSeen.has(ignore)) {
        await mkdir(path.dirname(ignore), { recursive: true })
        await writeFile(ignore, '# triage team runs — local working notes, never committed\n*\n', { flag: 'wx' }).catch(() => {})
        runFolderSeen.set(ignore, '')
      }
    }
    for (const [rel, text] of Object.entries(runFiles(run))) {
      const key = `${dir}\u0000${rel}`
      if (runFolderSeen.get(key) === text) continue
      const file = path.join(dir, rel)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text, 'utf8')
      runFolderSeen.set(key, text)
    }
  } catch (err) {
    log('error', 'teams', `could not write the run folder: ${err}`, { teamId: run.id, workspace: rt.meta.id })
  }
}

/** The run folder's files, in reading order: plan, ledger, verify, reviews, then each handoff and patch. */
function runFolderList(rt: WorkspaceRuntime, run: TeamRun): TeamRunFolderFile[] {
  const dir = runDirOf(rt, run)
  const names = Object.keys(runFiles(run))
  const top = ['plan.md', 'ledger.md', 'verify.md', 'reviews.md'].filter((p) => names.includes(p))
  const out: TeamRunFolderFile[] = top.map((p) => ({ path: p, label: p.replace(/\.md$/, '').replace(/^\w/, (c) => c.toUpperCase()), group: 'run' }))
  for (const h of run.outputs) if (h.file) out.push({ path: h.file, label: `${h.label}${h.task ? ` · ${h.task}` : ''} · ${h.stepId}${h.round ? ` r${h.round}` : ''}`, group: 'handoffs', ...(h.verdict ? { badge: h.verdict } : {}) })
  for (const r of run.workerRuns) {
    if (!r.patch) continue
    const rel = path.relative(dir, r.patch)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) out.push({ path: rel, label: path.basename(rel), group: 'patches' })
  }
  return out
}

/** A path inside a run's folder, or null when it reaches outside it. */
function runFileOf(rt: WorkspaceRuntime, run: TeamRun, rel: string): string | null {
  const dir = runDirOf(rt, run)
  const file = path.resolve(dir, rel)
  return file.startsWith(dir + path.sep) ? file : null
}

/** The spawn-time settings a worker's session gets for the step it is on. */
function workerSpec(run: TeamRun, w: Worker) {
  const step = run.recipe.steps.find((s) => s.id === w.stepId)
  const agent = run.agents.find((a) => a.name === w.agent)
  const writes = step?.output === 'change'
  const can = (agent?.can ?? ['read']).filter((c) => writes || c !== 'edit') as AgentCan[]
  const model = run.card.steps.find((c) => c.id === w.stepId)?.model ?? step?.model ?? agent?.model ?? null
  return { step, agent, writes, can, model }
}

/** Carry out the engine's actions, in order. */
async function applyTeamActions(rt: WorkspaceRuntime, run: TeamRun, actions: TeamAction[]): Promise<void> {
  for (const a of actions) {
    if (a.kind === 'notice') await sessionNotice(rt, run.leadSessionId, a.text)
    else if (a.kind === 'tellLead') await tellSession(rt, run.leadSessionId, a.text)
    else if (a.kind === 'snapshot') {
      const tree = (run.root && (await snapshotTree(run.root))) || undefined
      if (a.scope === 'run') run.runBase = tree
      run.baseTree = tree
    }
    else if (a.kind === 'checks') {
      await teamRunChanged(rt, run)
      const results = await runProjectChecks(run)
      await applyTeamActions(rt, run, checksDone(run, results, Date.now()))
    } else if (a.kind === 'finish') await finishTeamRun(rt, run)
    else if (a.kind === 'tell') {
      const w = workerById(run, a.workerId)
      if (!w) continue
      if (!w.sessionId) {
        const lead = rt.rows.get(run.leadSessionId)
        const { writes, model, agent } = workerSpec(run, w)
        const effort = (agent?.effort ?? null) as EffortLevel | null
        const row = await createSession(rt, `${w.label} · ${run.title}`, lead?.cwd ?? run.root ?? os.homedir(), model, effort, run.card.fast, writes ? 'acceptEdits' : 'gated', { spawn: false, projectId: lead?.projectId ?? null })
        w.sessionId = row.id
        rt.sessionTeam.set(row.id, run.id)
        await linkSessionToItem(rt, row.id, run.itemId, 'dispatch').catch(() => {})
      }
      let text = a.text
      const diff = a.diff ? await handoffDiff(rt, run, a.diff) : null
      if (diff) text += `\n\n${diff.text}`
      if (a.fresh) rt.freshNext.add(w.sessionId)
      // The run starts at the next event: a fresh context's notice, else triage's message.
      const seen = rt.live.get(w.sessionId)?.lastSeq ?? (await rt.store.events.lastSeq(w.sessionId))
      stampRun(run, w.id, { startSeq: seen + 1, at: Date.now(), spendAtStart: run.spend[w.sessionId] ?? 0, ...(diff?.file ? { patch: diff.file } : {}) })
      await tellSession(rt, w.sessionId, text)
    }
  }
  await teamRunChanged(rt, run)
}

/** A message from triage itself — badged "from triage" in the transcript, framed as not-the-user for the model. */
async function tellSession(rt: WorkspaceRuntime, sessionId: string, text: string): Promise<void> {
  const live = await getOrRevive(rt, sessionId)
  await live?.sendUserMessage(text, undefined, undefined, { from: 'triage' })
}

/** Diffs at most this long go inline; past it the reader gets the map and the patch by reference. */
const INLINE_DIFF_CHARS = 8000

/**
 * The diff a checker reads instead of anyone's transcript — this task's, or the
 * whole run's. Always the stat first (the map: which files, how much). A small
 * patch rides inline; a big one is written to the run's folder and the reader
 * pulls what it needs, file by file — it only pays for what it reads.
 */
async function handoffDiff(rt: WorkspaceRuntime, run: TeamRun, scope: DiffScope): Promise<{ text: string; file?: string }> {
  const base = scope === 'task' ? run.baseTree : run.runBase ?? run.baseTree
  const what = scope === 'task' ? `this task's changes` : `the whole run's changes`
  if (!run.root || !base) return { text: '## Diff\n(no baseline — read the files the handoffs list)' }
  const now = await snapshotTree(run.root)
  if (!now) return { text: '## Diff\n(could not read the working tree)' }
  const [stat, { patch }] = await Promise.all([
    treeStat(run.root, base, now).catch(() => ''),
    treePatch(run.root, base, now, 20_000_000).catch(() => ({ patch: '', truncated: false })),
  ])
  if (!patch) return { text: `## Diff — ${what}\n(no file changes were detected)` }
  if (patch.length <= INLINE_DIFF_CHARS) return { text: `## Diff — ${what}\n\`\`\`\n${stat}\n\`\`\`\n\`\`\`diff\n${patch}\n\`\`\`` }
  const task = run.task !== null ? run.card.tasks[run.task]?.id : null
  const file = path.join(runDirOf(rt, run), 'patches', `${scope}${task && scope === 'task' ? `-${task}` : ''}-round${run.round}.patch`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, patch, 'utf8')
  const lines = patch.split('\n').length
  const text = [
    `## Diff — ${what}: ${lines} lines, too long to inline`,
    `\`\`\`\n${stat}\n\`\`\``,
    `The full patch is at ${file} — Read it in parts (offset/limit), or read one file's changes at a time:`,
    `\`git diff ${base} -- <file>\` (edits to files git already tracks; a brand-new file is only in the patch).`,
    'Start from the files that matter most for the criteria; you don\'t need to read every line.',
  ].join('\n')
  return { text, file }
}

/** A run label for a file row: "T2", "T2 r1", or the step. */
function runTag(run: TeamRun, r: WorkerRun): string {
  return r.task ? `${r.task}${r.round ? ` r${r.round}` : ''}` : r.stepId
}

const kb = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)

/**
 * The run's Files panel: what the team works from (the Plan, the item's brief and
 * notes), what the team is (the recipe and agent files), what it changed since it
 * started (with who changed it), and what it left as proof (patches, checks, findings).
 */
async function teamRunFilesOp(rt: WorkspaceRuntime, run: TeamRun): Promise<TeamRunFile[]> {
  const out: TeamRunFile[] = []
  const labelOf = (workerId: string | null) => (workerId ? workerById(run, workerId)?.label ?? workerId : 'triage')
  const everyone = [...new Set(run.workers.map((w) => w.label))]

  // Ledger: the Plan (triage writes it, every agent reads it), the run folder's own files, then the item's brief and notes.
  await syncRunFolder(rt, run)
  out.push({ group: 'ledger', name: 'plan.md', detail: 'goal, criteria, tasks, progress — and the outcome', writer: 'triage', readers: everyone, open: { kind: 'runfile', path: 'plan.md' }, runs: [], live: run.state !== 'done' && run.state !== 'stopped' })
  const notFixed = Object.values(run.findingState).filter((v) => v.status !== 'fixed').length
  out.push(
    { group: 'ledger', name: 'ledger.md', detail: 'decisions, where things are, surprises, what failed', writer: [...new Set(run.ledger.map((e) => e.by))].join(', ') || 'triage', readers: everyone, open: { kind: 'runfile', path: 'ledger.md' }, runs: [], badge: `${run.ledger.length}` },
    { group: 'ledger', name: 'verify.md', detail: 'how to check this project', writer: 'triage', readers: everyone, open: { kind: 'runfile', path: 'verify.md' }, runs: [], ...(run.baseline ? { badge: run.baseline.results.every((r) => r.ok) ? 'baseline ok' : 'baseline failing' } : {}) },
  )
  if (Object.keys(run.findingState).length) out.push({ group: 'ledger', name: 'reviews.md', detail: 'every finding by id', writer: 'triage', readers: [], open: { kind: 'runfile', path: 'reviews.md' }, runs: [], badge: notFixed ? `${notFixed} open` : 'all fixed' })
  const links = (await rt.store.links.list()).filter((l) => l.fromKind === 'artifact' && l.toKind === 'item' && l.toId === run.itemId && (l.role === 'brief' || l.role === 'context'))
  for (const l of links) {
    const a = await rt.store.artifacts.get(l.fromId)
    if (!a) continue
    out.push({ group: 'ledger', name: `${l.role === 'brief' ? 'Brief' : 'Notes'} · ${a.title}`, detail: a.path, writer: a.author === 'human' ? 'you' : 'Junior', readers: ['Lead'], open: { kind: 'artifact', id: a.id }, runs: [] })
  }

  // Team: the recipe it was copied from, and each agent file a step names.
  out.push({ group: 'team', name: run.team ? `teams/${run.team}.md` : 'Recipe drafted for this run', detail: `${run.recipe.label} · ${run.recipe.steps.length} steps · copied at approval`, writer: run.team ? 'you' : 'Lead', readers: [], open: run.team ? { kind: 'library', library: 'team', name: run.team } : null, runs: [] })
  for (const agent of run.agents) {
    if (!run.recipe.steps.some((s) => s.agent === agent.name)) continue
    out.push({ group: 'team', name: `agents/${agent.name}.md`, detail: agent.can.length ? agent.can.join(' · ') : 'reads only what it is sent', writer: 'you', readers: [agent.label], open: { kind: 'library', library: 'agent', name: agent.name }, runs: [] })
  }

  // Changed: the tree now against the tree the run started from. A file belongs to the
  // runs whose handoff lists it; one no handoff claims yet is the working run's.
  // A team that never edits (Research, Review) changed nothing; a finished run changed what it had when it ended.
  const edits = run.recipe.steps.some((s) => s.output === 'change')
  const ended = run.state === 'done' || run.state === 'stopped'
  if (edits && run.root && run.runBase && (!ended || run.endTree)) {
    const now = ended ? run.endTree! : await snapshotTree(run.root)
    const changes = now ? await treeDiff(run.root, run.runBase, now).catch(() => [] as TreeChange[]) : []
    const handed = run.workerRuns.filter((r) => r.handoffId)
    const working = run.workerRuns.findLast((r) => runStatus(run, r) === 'working' && run.recipe.steps.find((s) => s.id === r.stepId)?.output === 'change')
    for (const c of changes) {
      const claims = (files: string[] | undefined) => (files ?? []).some((f) => f === c.path || f.endsWith(`/${c.path}`) || c.path.endsWith(`/${f.replace(/^\.\//, '')}`))
      const by = handed.filter((r) => claims(run.outputs.find((o) => o.id === r.handoffId)?.files)).map((r) => r.id)
      const live = !by.length && !!working
      out.push({
        group: 'changed',
        name: c.path,
        detail: by.map((id) => runTag(run, run.workerRuns.find((r) => r.id === id)!)).join(', ') || (live ? `${runTag(run, working!)} · in progress` : ''),
        writer: by.length ? labelOf(run.workerRuns.find((r) => r.id === by[0])!.workerId) : live ? labelOf(working!.workerId) : '',
        readers: [],
        open: { kind: 'project', path: c.path },
        runs: by.length ? by : live ? [working!.id] : [],
        ...(live ? { live: true } : {}),
        added: c.insertions,
        removed: c.deletions,
        status: c.status,
      })
    }
  }

  // Evidence: every handoff as its file, and the patches readers were sent.
  const dir = runDirOf(rt, run)
  for (const h of run.outputs) {
    if (!h.file) continue
    const from = run.workerRuns.find((r) => r.handoffId === h.id)
    const ok = h.checks ? h.checks.filter((c) => c.ok).length : 0
    out.push({
      group: 'evidence',
      name: path.basename(h.file),
      detail: h.summary,
      writer: h.label,
      readers: [],
      open: { kind: 'runfile', path: h.file },
      runs: from ? [from.id] : [],
      ...(h.checks ? { badge: h.checks.length ? `${ok}/${h.checks.length}` : '—' } : h.verdict ? { badge: h.verdict } : h.findings?.length ? { badge: `${h.findings.length}` } : {}),
    })
  }
  for (const r of run.workerRuns) {
    if (!r.patch) continue
    const size = (await stat(r.patch).catch(() => null))?.size
    const rel = path.relative(dir, r.patch)
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel)
    out.push({ group: 'evidence', name: path.basename(r.patch), detail: inside ? rel : r.patch, writer: 'triage', readers: [labelOf(r.workerId)], open: inside ? { kind: 'runfile', path: rel } : { kind: 'file', path: r.patch }, runs: [r.id], ...(size != null ? { badge: kb(size) } : {}) })
  }
  return out
}

const CHECK_TIMEOUT_MS = 240_000

/** The project's own typecheck/lint/test — free, and before any checker is paid to find a type error. */
async function runProjectChecks(run: TeamRun): Promise<CheckResult[]> {
  const cmds = run.root ? await detectChecks(run.root) : []
  run.checkCmds = cmds
  const results: CheckResult[] = []
  for (const cmd of cmds) {
    try {
      await pExec(cmd, { cwd: run.root, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
      results.push({ cmd, ok: true, tail: '' })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'failed'
      results.push({ cmd, ok: false, tail: out.slice(-3000) })
    }
  }
  return results
}

/** The run is over: the plan gets its Outcome — it is the result on the item — and the lead says so. */
async function finishTeamRun(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  if (run.root) run.endTree = (await snapshotTree(run.root)) ?? undefined
  await schedulePlanSync(rt, run, true)
  await sessionNotice(rt, run.leadSessionId, run.goal ? `Goal done · ${usd(runSpent(run))}. Accept the result, or say what's missing.` : `Team done${run.unresolved ? ' — with something unresolved' : ''} · ${usd(runSpent(run))}. The outcome is in the run folder's plan.md.`)
  log('info', 'teams', `run done at ${usd(runSpent(run))}`, { teamId: run.id, workspace: rt.meta.id })
}

/**
 * A team session's turn ended: book its cost, pause the run past its budget (or
 * when the SDK already stopped the turn at its backstop), then let the engine act.
 */
async function noteTeamSpend(rt: WorkspaceRuntime, sessionId: string, delta: number, overBudget = false): Promise<void> {
  const run = teamRunOf(rt, sessionId)
  if (!run) return
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') return
    run.spend[sessionId] = (run.spend[sessionId] ?? 0) + delta
    run.rev += 1
    const spent = runSpent(run)
    // The lead's verdict or unstick waits for its turn to end, like a handoff: triage never messages a
    // session mid-turn. Paused meanwhile (by you, or the budget), it waits for your resume instead.
    const decided = sessionId === run.leadSessionId ? rt.goalDecisions.get(run.id) : undefined
    const over = run.state === 'running' && (spent >= run.budgetUsd || overBudget)
    // Past the budget a "met" still closes the goal — it spends nothing more.
    if (decided && run.state === 'running' && (!over || closes(run, decided))) {
      rt.goalDecisions.delete(run.id)
      try {
        return await applyTeamActions(rt, run, decided(run))
      } catch (err) {
        log('warn', 'teams', `goal decision no longer applies: ${errText(err)}`, { teamId: run.id, workspace: rt.meta.id })
      }
    }
    if (over) {
      await pauseTeamRunNow(rt, run, `budget reached — ${usd(spent)} of ${usd(run.budgetUsd)}`)
      return
    }
    await applyTeamActions(rt, run, turnEnded(run, sessionId))
  })
}

/** Would this goal decision close the goal? Tried on a copy. */
function closes(run: TeamRun, decide: (r: TeamRun) => TeamAction[]): boolean {
  const probe = structuredClone(run)
  try {
    decide(probe)
  } catch {
    return false
  }
  return probe.state === 'done'
}

/** Stop every worker mid-turn and hold the run until it's resumed. The lead's chat is left alone. */
async function pauseTeamRunNow(rt: WorkspaceRuntime, run: TeamRun, reason: string): Promise<void> {
  pauseRun(run, reason)
  for (const w of run.workers) {
    if (!w.sessionId || w.sessionId === run.leadSessionId) continue
    const live = rt.live.get(w.sessionId)
    if (!live) continue
    await live.interrupt()
    live.stop()
  }
  await teamRunChanged(rt, run)
  await sessionNotice(rt, run.leadSessionId, `${run.goal ? 'Goal' : 'Team'} paused: ${reason}.${reason.startsWith('budget') ? ' Only you can raise the budget and resume it.' : ''}`)
  log('info', 'teams', `run paused: ${reason}`, { teamId: run.id, workspace: rt.meta.id })
}

function teamRunFrom(rt: WorkspaceRuntime, raw: unknown): TeamRun {
  const id = (raw as { runId?: unknown })?.runId
  const run = typeof id === 'string' ? rt.teamRuns.get(id) : undefined
  if (!run) throw new Error('no such team run')
  return run
}

async function teamLibraryOp(rt: WorkspaceRuntime): Promise<TeamLibraryResponse & { ok: true }> {
  return { ok: true, ...(await rt.teamLibrary.list()), dir: rt.teamLibrary.root }
}

/** Create or update one agent file (Settings → Teams → Agents). */
async function saveAgentOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const spec = agentFrom(r.agent)
  const lib = rt.teamLibrary
  const existing = isLibraryName(r.name) && (await lib.readAgent(r.name)) ? r.name : null
  const name = existing ?? (await lib.freeName('agent', spec.label))
  await lib.writeAgent({ ...spec, name })
  return name
}

/** What the lead sees when it picks or drafts a team. */
async function listTeamsOp(rt: WorkspaceRuntime) {
  const { teams, agents } = await rt.teamLibrary.list()
  return {
    teams: teams
      .filter((t) => t.recipe && !t.missing.length)
      .map((t) => ({
        team: t.name,
        label: t.recipe!.label,
        description: t.recipe!.description,
        useFor: t.recipe!.useFor,
        budgetUsd: t.recipe!.budgetUsd,
        steps: t.recipe!.steps.map((s) => ({
          id: s.id,
          agent: s.agent,
          output: s.output,
          ...(s.fanOut ? { fanOut: s.fanOut } : {}),
          ...(s.onFail ? { onFail: s.onFail } : {}),
          ...(s.gate ? { gate: s.gate } : {}),
          ...(s.does ? { does: s.does } : {}),
        })),
        advice: t.recipe!.advice,
      })),
    agents: agents.map((a) => ({ agent: a.name, label: a.label, description: a.description, can: a.can, model: a.model })),
  }
}

/** A recipe the lead drafted for this run: checked by the same parser a team file goes through. */
function draftedRecipe(raw: unknown, known: Set<string>): TeamRecipe {
  const r = (raw ?? {}) as Record<string, unknown>
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>
    const fan = (s.fanOut ?? null) as { by?: unknown; max?: unknown } | null
    const fail = (s.onFail ?? null) as { backTo?: unknown; max?: unknown } | null
    return {
      id: String(s.id ?? ''),
      agent: String(s.agent ?? ''),
      output: (typeof s.output === 'string' ? s.output : null) as RecipeStep['output'],
      does: typeof s.does === 'string' ? s.does : '',
      fanOut: fan ? { by: String(fan.by ?? ''), max: Number(fan.max) } : null,
      onFail: fail ? { backTo: String(fail.backTo ?? ''), max: Number(fail.max) } : null,
      gate: s.gate === 'you' ? ('you' as const) : null,
      model: typeof s.model === 'string' && s.model ? s.model : null,
      forEach: s.forEach === 'task' ? ('task' as const) : null,
      context: s.context === 'fresh' || s.context === 'carry' ? (s.context as 'fresh' | 'carry') : null,
    }
  })
  const recipe: TeamRecipe = {
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : 'Custom',
    description: typeof r.description === 'string' ? r.description.trim().slice(0, 400) : '',
    useFor: [],
    budgetUsd: typeof r.budgetUsd === 'number' && r.budgetUsd > 0 ? r.budgetUsd : 5,
    // A drafted team never decides how much it may do unasked, or what speed you pay for: you pick on the card.
    permissions: null,
    fast: null,
    lead: { model: null, effort: null },
    done: typeof r.done === 'string' ? r.done.trim() : '',
    steps,
    advice: '',
  }
  const parsed = parseRecipe('draft', serializeRecipe(recipe, 'draft'))
  if (!parsed.recipe) throw new Error(`the drafted team doesn't hold together: ${parsed.errors.join('; ')}`)
  const missing = recipeAgents(parsed.recipe).filter((a) => !known.has(a))
  if (missing.length) throw new Error(`no agent file named ${missing.join(', ')} — use list_teams to see the agents there are`)
  return parsed.recipe
}

/**
 * The lead proposes a team: a saved team or one it drafted, plus the card. The
 * run waits, proposed, until you approve. A session with no work item gets one —
 * the result, "needs you" and the cost all land on an item.
 */
async function proposeTeamOp(rt: WorkspaceRuntime, sessionId: string, raw: unknown): Promise<TeamRun> {
  const r = (raw ?? {}) as Record<string, unknown>
  const lead = rt.rows.get(sessionId)
  if (!lead) throw new Error('no such session')
  requireVeto(rt.provider, 'team')
  const existing = teamRunOf(rt, sessionId)
  if (existing && existing.leadSessionId !== sessionId) throw new Error('this session is a worker on a team — only a lead proposes one')
  if (existing && existing.state !== 'proposed' && existing.state !== 'done' && existing.state !== 'stopped') {
    throw new Error(`this session already leads a ${existing.state} team run — stop it before proposing another`)
  }
  const lib = rt.teamLibrary
  const { teams, agents } = await lib.list()
  let recipe: TeamRecipe
  let team: string | null = null
  if (typeof r.team === 'string' && r.team) {
    const entry = teams.find((t) => t.name === r.team)
    if (!entry) throw new Error(`no team named "${r.team}" — call list_teams`)
    if (!entry.recipe) throw new Error(`teams/${entry.name}.md has errors: ${entry.errors.join('; ')}`)
    if (entry.missing.length) throw new Error(`teams/${entry.name}.md names agents with no file: ${entry.missing.join(', ')}`)
    recipe = entry.recipe
    team = entry.name
  } else if (r.recipe) recipe = draftedRecipe(r.recipe, new Set(agents.map((a) => a.name)))
  else throw new Error('give either team (a saved team\'s name) or recipe (a drafted one)')
  // How much the team may do unasked is yours to pick on the card, never the lead's.
  const card = cardFrom({ ...((r.card ?? {}) as object), permissions: undefined, fast: undefined }, recipe, existing?.state === 'proposed' ? existing.card : undefined)
  const kept = existing?.state === 'proposed' ? existing.goal ?? null : null
  // A goal: the lead's, or the one already on the card (proposing again keeps it).
  const goal = r.goal ? goalFrom(r.goal, Date.now(), kept) : kept

  let itemId = rt.sessionItem.get(sessionId) ?? null
  if (!itemId || !(await rt.store.items.get(itemId))) {
    const title = (typeof r.title === 'string' && r.title.trim() ? r.title.trim() : card.goal).slice(0, 120)
    itemId = await createManualOp(rt, { title, description: card.goal })
    await linkSessionToItem(rt, sessionId, itemId, 'dispatch')
  }
  const item = await rt.store.items.get(itemId)
  const root = (await repoRoot(lead.cwd)) ?? lead.cwd
  const used = new Set(recipeAgents(recipe))
  const id = existing?.state === 'proposed' ? existing.id : randomUUID()
  const run: TeamRun = {
    id,
    itemId,
    title: (item?.title ?? card.goal).slice(0, 80),
    createdAt: existing?.state === 'proposed' ? existing.createdAt : Date.now(),
    team,
    recipe,
    card,
    agents: agents.filter((a) => used.has(a.name)).map((a) => ({ name: a.name, label: a.label, color: a.color, model: a.model, effort: a.effort, prompt: a.prompt, can: a.can })),
    leadSessionId: sessionId,
    state: 'proposed',
    step: 0,
    splitting: false,
    round: 0,
    task: null,
    tasks: {},
    workers: [],
    workerRuns: [],
    ledger: [],
    findingState: {},
    awaiting: [],
    submitted: [],
    outputs: [],
    notes: [],
    revision: null,
    feedback: null,
    unresolved: null,
    spend: {},
    budgetUsd: card.budgetUsd,
    rev: (existing?.rev ?? 0) + 1,
    nudged: [],
    root,
    dir: teamRunDir(rt, id, root),
    goal,
    resumes: [],
    ...(existing?.state === 'proposed' && existing.planArtifactId ? { planArtifactId: existing.planArtifactId } : {}),
  }
  if (existing && existing.id !== run.id) rt.teamRuns.delete(existing.id)
  rt.teamRuns.set(run.id, run)
  indexTeamRun(rt, run)
  await teamRunChanged(rt, run)
  log('info', 'teams', `${goal ? 'goal' : 'team'} proposed: ${recipe.label} for ${run.title}`, { teamId: run.id, workspace: rt.meta.id })
  return run
}

/** A proposed card's goal, from your edit: an object sets it, null makes it a plain team run. */
function goalEdit(run: TeamRun, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || !('goal' in raw)) return
  const g = (raw as { goal?: unknown }).goal
  run.goal = g === null ? null : goalFrom(g, Date.now(), run.goal)
}

/** Your edit to a proposed card (before approving). */
async function editTeamCardOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  if (run.state !== 'proposed') throw new Error('only a proposed card can be edited')
  if ((raw as { card?: unknown }).card) run.card = cardFrom((raw as { card?: unknown }).card, run.recipe, run.card)
  goalEdit(run, raw)
  run.budgetUsd = run.card.budgetUsd
  run.rev += 1
  await teamRunChanged(rt, run)
}

/**
 * Your edit to a running plan, from the drawer: the tasks still to do, and the
 * decisions. Tasks land between tasks — the loop reads the list fresh each time.
 */
async function editPlanOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  const r = raw as { tasks?: unknown; decisions?: unknown }
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') throw new Error(`the run is ${run.state}`)
    if (r.tasks !== undefined) {
      if (run.state === 'proposed') run.card = cardFrom({ ...run.card, tasks: r.tasks }, run.recipe, run.card)
      else editTasks(run, r.tasks)
    }
    if (Array.isArray(r.decisions)) {
      run.card.decisions = r.decisions.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20)
    }
    run.rev += 1
    await teamRunChanged(rt, run)
  })
}

async function settleRevisionOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, () => applyTeamActions(rt, run, settleRevision(run, (raw as { accept?: unknown }).accept === true)))
}

/**
 * Fast mode for the whole team, any time: the card says it for workers still to
 * come, and every worker session already running switches now.
 */
async function setTeamFastOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  const fast = (raw as { fast?: unknown }).fast === true
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') throw new Error(`the run is ${run.state}`)
    run.card.fast = fast
    run.rev += 1
    for (const sid of new Set(run.workers.map((w) => w.sessionId))) {
      if (!sid || sid === run.leadSessionId) continue
      const row = rt.rows.get(sid)
      if (!row || row.fastMode === fast) continue
      row.fastMode = fast
      await rt.store.sessions.setFastMode(sid, fast)
      await rt.live.get(sid)?.setFastMode(fast)
    }
    await teamRunChanged(rt, run)
  })
}

async function approveTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, async () => {
    requireVeto(rt.provider, 'team')
    const card = (raw as { card?: unknown }).card ? cardFrom((raw as { card?: unknown }).card, run.recipe, run.card) : run.card
    if (run.state !== 'proposed') throw new Error(`the run is ${run.state}, not waiting for approval`)
    if (!card.permissions) throw new Error('pick what the team may do without asking before it runs')
    goalEdit(run, raw)
    log('info', 'teams', `${run.goal ? 'goal' : 'team'} approved: ${run.recipe.label}`, { teamId: run.id, workspace: rt.meta.id })
    // The checks as they stand before anyone touches the code: a failure already there is nobody's regression.
    if (run.root) {
      await sessionNotice(rt, run.leadSessionId, 'Running the project’s checks before the team starts…')
      run.baseline = { results: await runProjectChecks(run), at: Date.now() }
    }
    await applyTeamActions(rt, run, approve(run, card))
  })
}

async function discardTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  if (run.state !== 'proposed') throw new Error('only a proposed run can be discarded — stop a running one')
  rt.teamRuns.delete(run.id)
  rt.sessionTeam.delete(run.leadSessionId)
  if (run.planArtifactId) await rt.artifacts.remove(run.planArtifactId).catch(() => {})
  // A card never approved leaves nothing behind: its folder only ever held the proposed plan.
  await rm(runDirOf(rt, run), { recursive: true, force: true }).catch(() => {})
  await saveTeamRuns(rt)
  broadcastSessionList(rt)
  await sessionNotice(rt, run.leadSessionId, 'Team card discarded.')
}

async function resumeTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, async () => {
    requireVeto(rt.provider, 'team')
    if (run.state === 'gate') return applyTeamActions(rt, run, continueGate(run, Date.now()))
    const spent = runSpent(run)
    const addUsd = Number((raw as { addUsd?: unknown }).addUsd)
    // Resume always leaves room to work: at least the requested amount above what's spent.
    const add = Number.isFinite(addUsd) && addUsd > 0 ? Math.min(addUsd, MAX_RUN_BUDGET_USD) : Math.max(2, Math.round(run.budgetUsd * 0.5))
    const before = run.budgetUsd
    // You named an amount: it goes on top. Otherwise only a spent budget grows, by the default step.
    if (spent >= run.budgetUsd || (Number.isFinite(addUsd) && addUsd > 0)) run.budgetUsd = Math.round((Math.max(spent, run.budgetUsd) + add) * 100) / 100
    // Workers respawn on their next message, with the new remaining budget as their backstop.
    for (const w of run.workers) if (w.sessionId && w.sessionId !== run.leadSessionId) rt.live.get(w.sessionId)?.stop()
    const raised = run.budgetUsd > before
    await sessionNotice(rt, run.leadSessionId, `${run.goal ? 'Goal' : 'Team'} resumed by you — budget ${usd(run.budgetUsd)} (${usd(spent)} spent).`)
    const actions = resume(run, Date.now(), raised ? `raised the budget from ${usd(before)} to ${usd(run.budgetUsd)} and resumed` : 'resumed after a pause')
    // A verdict or unstick the lead gave just before the pause: carry it out now, instead of asking again.
    const decided = rt.goalDecisions.get(run.id)
    if (decided && run.state === 'running') {
      rt.goalDecisions.delete(run.id)
      try {
        return await applyTeamActions(rt, run, decided(run))
      } catch (err) {
        log('warn', 'teams', `goal decision no longer applies: ${errText(err)}`, { teamId: run.id, workspace: rt.meta.id })
      }
    }
    await applyTeamActions(rt, run, actions)
  })
}

async function stopTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') return
    for (const w of run.workers) {
      if (!w.sessionId || w.sessionId === run.leadSessionId) continue
      const live = rt.live.get(w.sessionId)
      if (!live) continue
      await live.interrupt()
      live.stop()
    }
    run.state = 'stopped'
    rt.goalDecisions.delete(run.id)
    if (run.root) run.endTree = (await snapshotTree(run.root)) ?? undefined
    run.awaiting = []
    run.rev += 1
    await teamRunChanged(rt, run)
    await sessionNotice(rt, run.leadSessionId, `Team stopped at ${usd(runSpent(run))}.`)
  })
}

/** Save as team: the run's recipe, with your card's models and widths, as a new team file. */
async function saveRunAsTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const run = teamRunFrom(rt, raw)
  const label = String((raw as { label?: unknown }).label ?? '').trim().slice(0, 60)
  if (!label) throw new Error('the team needs a name')
  const name = await rt.teamLibrary.freeName('team', label)
  await rt.teamLibrary.writeRecipe(name, recipeFromRun(run, label))
  log('info', 'teams', `team saved from a run: ${label}`, { team: name, teamId: run.id, workspace: rt.meta.id })
  return name
}

/**
 * The dispatch picker: open a lead session on the item, in its project, told to
 * plan with the chosen team (or to pick/draft one). Nothing runs until you
 * approve the card it proposes.
 */
async function planTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const item = await rt.store.items.get(typeof r.itemId === 'string' ? r.itemId : '')
  if (!item) throw new Error('no such work item')
  const project = await projectFor(rt, item)
  if (!project) throw new Error('this item has no project — set one on the item so the team knows which folder to work in')
  const entry = typeof r.team === 'string' && r.team ? (await rt.teamLibrary.list()).teams.find((t) => t.name === r.team) : null
  if (r.team && !entry?.recipe) throw new Error(entry ? `teams/${entry.name}.md has errors: ${entry.errors.join('; ')}` : `no team named "${r.team}"`)
  const recipe = entry?.recipe ?? null
  const row = await createSession(rt, `${recipe?.label ?? 'Team'} · ${item.title}`.slice(0, 80), project.path, recipe?.lead.model ?? null, recipe?.lead.effort ?? null, false, null, { spawn: false, projectId: project.id })
  await linkSessionToItem(rt, row.id, item.id, 'dispatch')
  const live = await getOrRevive(rt, row.id)
  if (!live) throw new Error('could not start the lead session')
  const brief = await currentBrief(rt, item.id)
  const mentions: Mention[] = [{ kind: 'item', ref: item.id, label: item.title }]
  if (brief) mentions.push({ kind: 'artifact', ref: brief.artifact.id, label: brief.artifact.title })
  const images = await itemImageAttachments(rt.attachmentsDir, item.id, item.images)
  const text = planMessage({ team: entry && recipe ? { name: entry.name, label: recipe.label, tasks: !!taskLoop(recipe) } : null, itemTitle: item.title })
  await live.sendUserMessage(`${text}\n\n${mentions.map(mentionToken).join(' ')}`, images, mentions)
  log('info', 'teams', `team planning: ${recipe?.label ?? 'pick or draft'} for ${item.title}`, { itemId: item.id, workspace: rt.meta.id })
  return row.id
}

/** Which team the picker suggests for an item kind, and what each team has really cost. */
async function teamPickerOp(rt: WorkspaceRuntime, kind: string): Promise<TeamPickerResponse & { ok: true }> {
  const { teams } = await rt.teamLibrary.list()
  const usable = teams.filter((t) => t.recipe && !t.missing.length)
  const costs = new Map<string, number[]>()
  for (const run of rt.teamRuns.values()) {
    if (run.state !== 'done' || !run.team) continue
    costs.set(run.team, [...(costs.get(run.team) ?? []), runSpent(run)])
  }
  const options = usable.map((t) => {
    const c = costs.get(t.name) ?? []
    return {
      team: t.name,
      label: t.recipe!.label,
      description: t.recipe!.description,
      steps: t.recipe!.steps.map((s) => (s.fanOut ? `${s.id} ×${s.fanOut.max}` : s.id)),
      budgetUsd: t.recipe!.budgetUsd,
      runs: c.length,
      ...(c.length ? { avgUsd: Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 100) / 100 } : {}),
    }
  })
  const suggested = usable.find((t) => t.recipe!.useFor.includes(kind))?.name ?? (usable.some((t) => t.name === 'solo') ? 'solo' : null)
  return { ok: true, suggested, options }
}

/**
 * The `team` MCP server a worker gets: its one job-critical tool, submit_step.
 * Rebuilt per spawn, like the brief server.
 */
function makeTeamMcp(rt: WorkspaceRuntime, sessionId: string) {
  return createSdkMcpServer({
    name: 'team',
    version: VERSION,
    // Loaded up front, never behind tool search.
    alwaysLoad: true,
    tools: [submitStepTool(rt, sessionId)],
  })
}

const FINDING_SHAPE = z.object({
  id: z.string().optional().describe('only to say an earlier finding is still not fixed: its id (e.g. "T2-F1"); triage numbers new ones'),
  severity: z.enum(['P0', 'P1', 'P2']).describe('P0 = a criterion unmet or something broken; P1 = a real defect likely to bite; P2 = worth fixing, not blocking'),
  where: z.string().describe('file:line, or the behaviour'),
  problem: z.string(),
  fix: z.string(),
})

const SUBMIT_SHAPE = {
  summary: z.string().describe('one line: what you did or found'),
  body: z.string().describe('change: what you changed and how you verified it; verdict: what you ran or looked at — markdown, short'),
  verdict: z.enum(['pass', 'fail']).optional().describe('verdict steps only'),
  criteria: z
    .array(z.object({ id: z.string().describe('the criterion id, e.g. "T2.1" or "C1"'), status: z.enum(['met', 'not met', 'partly']), evidence: z.string().describe('what you ran or saw') }))
    .max(20)
    .optional()
    .describe('change and verdict steps: every acceptance criterion the step lists, by id'),
  findings: z.array(FINDING_SHAPE).max(20).optional().describe('findings and verdict steps: real defects only'),
  resolutions: z
    .array(z.object({ id: z.string(), status: z.enum(['fixed', 'disputed', 'deferred']), note: z.string() }))
    .max(30)
    .optional()
    .describe('a fix round: every open finding id, answered'),
  unsure: z.string().optional().describe('change steps: what a reviewer should look at hardest'),
  decisions: z.array(z.object({ what: z.string(), why: z.string() })).max(10).optional().describe('choices you made that whoever comes next must keep, each with why'),
  where: z.array(z.string()).max(10).optional().describe('"path — what it is": the files and symbols that matter for this area, so the next worker needn\'t search'),
  surprises: z.array(z.string()).max(10).optional().describe('what was not as expected'),
  failed: z.array(z.string()).max(10).optional().describe('approaches you tried that did not work, and why'),
  verify: z.array(z.string()).max(10).optional().describe('how to check this project or this change: commands, URLs, what to look at'),
  files: z.array(z.string()).max(50).optional().describe('change steps: files you changed (triage replaces this with what git says)'),
  notes: z.array(z.string()).max(10).optional().describe('anything else for whoever comes next (prefer the typed fields above)'),
}
const SUBMIT_DESCRIPTION = 'Hand in your step of the team run. triage forwards it verbatim to whoever needs it next and moves the run on. Then END YOUR TURN.'

async function submitStepOp(rt: WorkspaceRuntime, sessionId: string, args: Submission) {
  const run = teamRunOf(rt, sessionId)
  if (!run) return errResult('this session is not on a team run')
  try {
    const said = submit(run, sessionId, args, Date.now())
    await filesFromGit(run)
    return okResult(said)
  } catch (err) {
    return errResult(errText(err))
  } finally {
    await teamRunChanged(rt, run)
  }
}

/**
 * A builder's handoff lists the files git says changed since its task (or the
 * run) began — not the ones it remembers changing, which is the part of a
 * handoff every summary gets wrong.
 */
async function filesFromGit(run: TeamRun): Promise<void> {
  const h = run.outputs.at(-1)
  const step = h && run.recipe.steps.find((x) => x.id === h.stepId)
  const base = step?.forEach ? run.baseTree : run.runBase ?? run.baseTree
  if (!h || step?.output !== 'change' || !run.root || !base) return
  const now = await snapshotTree(run.root)
  const changes = now ? await treeDiff(run.root, base, now).catch(() => null) : null
  if (changes) h.files = changes.map((c) => c.path)
}

/** A worker's submit_step: its session is known at spawn. */
function submitStepTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool('submit_step', SUBMIT_DESCRIPTION, SUBMIT_SHAPE, (args) => submitStepOp(rt, sessionId, args))
}

/** The lead's tools, in every chat's triage server: pick or draft a team, propose it, split a step, hand in its own steps. */
function teamLeadTools(rt: WorkspaceRuntime) {
  const sid = z.string().describe('your triage session id — it is in your system prompt')
  return [
    tool(
      'list_teams',
      'The saved teams (recipes: steps, fan-out, gates, budget) and the agents they are made of. Call before propose_team; prefer a saved team over drafting one.',
      {},
      async () => {
        try {
          return okResult(JSON.stringify(await listTeamsOp(rt), null, 2))
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'propose_team',
      'Propose a team run for the work this session is on — when the user asks for a team ("get a team to …"), or the session was opened to plan one. Shows the user an editable team card; nothing runs until they approve it. Give `team` (a saved team, from list_teams) or `recipe` (a drafted one, only when no saved team fits). If this session has no work item, one is created from `title`. Proposing again replaces the card. After calling it, END YOUR TURN.',
      {
        sessionId: sid,
        team: z.string().optional().describe('a saved team\'s name, e.g. "solo"'),
        recipe: z
          .object({
            label: z.string(),
            description: z.string().optional(),
            done: z.string().optional(),
            budgetUsd: z.number().optional(),
            steps: z
              .array(
                z.object({
                  id: z.string().describe('short lowercase name, e.g. "build"'),
                  agent: z.string().describe('"lead", "checks", or an agent name from list_teams'),
                  output: z.enum(['change', 'findings', 'verdict', 'notes', 'report']).optional().describe('omit only for agent "checks"'),
                  does: z.string().optional(),
                  fanOut: z.object({ by: z.string(), max: z.number() }).optional(),
                  onFail: z.object({ backTo: z.string(), max: z.number() }).optional(),
                  gate: z.enum(['you']).optional(),
                  model: z.string().optional(),
                  forEach: z.enum(['task']).optional().describe('"task": part of the per-task loop (contiguous steps, run once per task)'),
                  context: z.enum(['fresh', 'carry']).optional().describe('the change step in a task loop: fresh (default) or carry'),
                }),
              )
              .min(1)
              .max(8),
          })
          .optional()
          .describe('a drafted recipe — same rules as a team file: one change step, never fanned out; fan-out ≤ 6; only the lead reports'),
        title: z.string().optional().describe('the work item title, when this session has none yet'),
        card: z.object({
          goal: z.string().describe('ONE sentence: what the run achieves — the user reads it at a glance'),
          criteria: z.array(z.string()).min(1).max(8).describe('3–5 observable behaviours a checker can prove by running something, each ONE short line (~12 words) — no file paths or line numbers'),
          outOfScope: z.array(z.string()).max(8).optional().describe('a few words each'),
          tasks: z
            .array(z.object({ title: z.string().describe('one line'), criteria: z.array(z.string()).max(3).optional().describe('1–3 short checkable lines') }))
            .max(8)
            .optional()
            .describe('teams with a task loop (e.g. Build): 2–6 tasks, in order, each leaving the project working; omit for other teams'),
          decisions: z.array(z.string()).max(10).optional().describe('decisions already made with the user'),
          steps: z
            .array(
              z.object({
                id: z.string().describe('a step id of the recipe'),
                model: z.string().optional().describe('a model for this step if it should differ'),
                slices: z.array(z.object({ title: z.string(), brief: z.string() })).max(6).optional().describe('fan-out steps: the slices, if you can already tell them apart'),
              }),
            )
            .optional(),
          budgetUsd: z.number().optional().describe('the run\'s spend cap; defaults to the team\'s budget'),
          note: z.string().optional().describe('one or two lines to the user: why this team and size'),
        }),
        goal: z
          .object({
            doneWhen: z.string().describe('ONE sentence: the outcome you will judge when the team finishes a round, e.g. "the PR is merged with checks green" — not a task list'),
            horizon: z.enum(['today', 'by', 'until_done']).describe('finish today, by a date, or keep going until done'),
            by: z.string().optional().describe('horizon "by": the date, YYYY-MM-DD'),
          })
          .optional()
          .describe('only when the user wants a goal: the team keeps going, round after round, until the done-when holds'),
      },
      async (args) => {
        try {
          const run = await proposeTeamOp(rt, args.sessionId, args)
          return okResult(`${run.goal ? 'Goal' : 'Team'} card shown to the user (${run.recipe.label}, ${run.recipe.steps.length} steps, up to ${usd(run.card.budgetUsd)}). END YOUR TURN — they approve or edit it, then triage runs the steps and wakes you when you're needed.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'split_step',
      'Split the current fan-out step of your team run into slices — one worker each. Only when triage asks you to. Then END YOUR TURN.',
      { sessionId: sid, slices: z.array(z.object({ title: z.string().describe('a few words'), brief: z.string().describe('what this worker looks at, and what could go wrong there') })).min(1).max(6) },
      async (args) => {
        const run = teamRunOf(rt, args.sessionId)
        if (!run || run.leadSessionId !== args.sessionId) return errResult('you are not leading a team run')
        try {
          await withTeamRun(rt, run, () => applyTeamActions(rt, run, split(run, args.slices)))
          return okResult('Split. END YOUR TURN — the workers start now.')
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'revise_plan',
      'Propose a change to the tasks still to do on your running team plan — add, split, reorder or drop tasks that have not started. The user accepts or turns it down; the run carries on meanwhile, and an accepted change applies from the next task. Give the whole task list as it should be (keep the ids of tasks that stay).',
      {
        sessionId: sid,
        tasks: z.array(z.object({ id: z.string().optional().describe('keep the id of a task that stays'), title: z.string(), criteria: z.array(z.string()).max(3).optional() })).min(1).max(8),
        why: z.string().describe('one line the user reads: why the plan should change'),
      },
      async (args) => {
        const run = teamRunOf(rt, args.sessionId)
        if (!run || run.leadSessionId !== args.sessionId) return errResult('you are not leading a team run')
        try {
          await withTeamRun(rt, run, () => applyTeamActions(rt, run, proposeRevision(run, args.tasks, args.why)))
          return okResult('Proposed. The user decides; carry on — do not wait for it.')
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool('submit_step', `${SUBMIT_DESCRIPTION} Only when triage hands you a step.`, { sessionId: sid, ...SUBMIT_SHAPE }, ({ sessionId, ...args }) => submitStepOp(rt, sessionId, args)),
    tool(
      'goal_verdict',
      'Judge your goal\'s done-when — only when triage asks you to (the team finished a round, or a wait is over). Look for yourself first: run the checks, read the diff, query the connectors you can see. met: true closes the goal for the user to accept; met: false starts another round with the gap (and, for a team with a task loop, the next round\'s tasks); met: false with waitFor + waitMinutes sleeps until the world has moved (CI, a reviewer, a deploy) and wakes you then. Then END YOUR TURN.',
      {
        sessionId: sid,
        met: z.boolean(),
        evidence: z.string().describe('what you ran or looked at, and what it showed'),
        gap: z.string().optional().describe('not met: what is still missing, in a line or two — every worker in the next round reads it'),
        tasks: z.array(z.object({ title: z.string(), criteria: z.array(z.string()).max(3).optional() })).max(4).optional().describe('not met, a team with a task loop: the next round\'s tasks, in order'),
        waitFor: z.string().optional().describe('not met yet because the world has to move first: what for, e.g. "CI on PR #42"'),
        waitMinutes: z.number().optional().describe('with waitFor: when to look again, in minutes'),
      },
      async ({ sessionId, ...v }) => {
        const run = teamRunOf(rt, sessionId)
        if (!run || run.leadSessionId !== sessionId) return errResult('you are not leading a team run')
        try {
          const at = Date.now()
          const decide = (r: TeamRun) => goalVerdict(r, v, at)
          // Checked now on a copy, so a mistake comes back to you; carried out when your turn ends.
          const probe = structuredClone(run)
          decide(probe)
          rt.goalDecisions.set(run.id, decide)
          const said = probe.state === 'done' ? 'met — the user accepts the result' : probe.state === 'waiting' ? 'waiting — triage wakes you then' : 'not met — the next round starts when your turn ends'
          return okResult(`Recorded: ${said}. END YOUR TURN now.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'goal_unstick',
      'Get your goal\'s team moving again — only when triage tells you the team is stuck (its fix rounds ran out on a failing review or failing checks). "retry" goes back to the change step with your guidance for the builder and a fresh set of fix rounds; "skip" leaves it unresolved and moves on. Every resume is logged with your why. Then END YOUR TURN.',
      {
        sessionId: sid,
        action: z.enum(['retry', 'skip']),
        why: z.string().describe('one line for the ledger: why this is the way past it'),
        guidance: z.string().optional().describe('retry: what the builder should do differently this time'),
      },
      async ({ sessionId, ...u }) => {
        const run = teamRunOf(rt, sessionId)
        if (!run || run.leadSessionId !== sessionId) return errResult('you are not leading a team run')
        try {
          const at = Date.now()
          const decide = (r: TeamRun) => unstick(r, u, at)
          decide(structuredClone(run))
          rt.goalDecisions.set(run.id, decide)
          return okResult(`Recorded: ${u.action === 'retry' ? 'retry' : 'skip'} — the team moves when your turn ends, logged as resumed by Junior. END YOUR TURN now.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'ask_you',
      'Ask the user a question about your goal — something only they can decide, or help you need. Always give the answer you recommend; they can take it with one click. The run carries on meanwhile (a gate or a budget pause still waits for them). Their answer comes back to you as a message. Ask once, everything in one question.',
      {
        sessionId: sid,
        question: z.string(),
        recommended: z.string().describe('the answer you recommend, and why in a few words'),
      },
      async ({ sessionId, question, recommended }) => {
        const run = teamRunOf(rt, sessionId)
        if (!run || run.leadSessionId !== sessionId) return errResult('you are not leading a team run')
        try {
          const id = await withTeamRun(rt, run, async () => {
            const q = askYou(run, question, recommended, Date.now())
            await applyTeamActions(rt, run, q.actions)
            return q.id
          })
          invalidateInbox(rt)
          return okResult(`Asked (${id}). Their answer comes back to you as a message. If nothing else needs you now, END YOUR TURN.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
  ]
}

/** Your answers on a goal: a question, accepting the result, "not done yet", waking a wait early. */
async function goalActionOp(rt: WorkspaceRuntime, verb: 'answer' | 'accept' | 'reopen' | 'wake', raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  const r = (raw ?? {}) as Record<string, unknown>
  await withTeamRun(rt, run, async () => {
    const now = Date.now()
    if (verb === 'answer') await applyTeamActions(rt, run, answerQuestion(run, String(r.questionId ?? ''), String(r.answer ?? ''), now))
    else if (verb === 'accept') {
      await applyTeamActions(rt, run, acceptGoal(run, now))
      // Accepting the result is accepting the report: the item is done.
      if (await rt.store.items.get(run.itemId)) await rt.store.items.transition(run.itemId, { status: 'done', actor: 'user', detail: { reason: 'goal accepted' } })
    } else if (verb === 'reopen') await applyTeamActions(rt, run, reopenGoal(run, String(r.why ?? ''), now))
    else await applyTeamActions(rt, run, wake(run, now, true))
  })
  invalidateInbox(rt)
}

/** The Goals tab: every team run that is a goal, newest first. */
function teamGoalsOp(rt: WorkspaceRuntime): TeamGoalSummary[] {
  const now = Date.now()
  return [...rt.teamRuns.values()]
    .filter((run) => run.goal && run.state !== 'proposed')
    .map((run) => {
      const g = run.goal!
      const asks = g.questions.filter((q) => q.answer === null).length
      const lead = rt.rows.get(run.leadSessionId)
      const turn: TeamGoalSummary['turn'] =
        asks || run.state === 'gate' || run.state === 'paused' || (run.state === 'done' && !g.acceptedAt) ? 'you' : run.state === 'waiting' ? 'world' : run.state === 'running' ? 'junior' : 'none'
      return {
        runId: run.id,
        itemId: run.itemId,
        leadSessionId: run.leadSessionId,
        title: run.title,
        team: run.recipe.label,
        doneWhen: g.doneWhen,
        horizon: g.horizon,
        state: run.state,
        reason: run.reason ?? null,
        round: g.round,
        owes: g.owes,
        asks,
        wait: g.wait,
        acceptedAt: g.acceptedAt,
        lastVerdict: g.verdicts.at(-1) ?? null,
        resumes: run.resumes?.length ?? 0,
        overdue: goalOverdue(run, now),
        spentUsd: runSpent(run),
        budgetUsd: run.budgetUsd,
        turn,
        updatedAt: Math.max(run.createdAt, lead?.updatedAt ?? 0, run.resumes?.at(-1)?.at ?? 0),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The minute tick: goals asleep on the world whose time is up look again. */
async function wakeTeamGoals(rt: WorkspaceRuntime): Promise<void> {
  const now = Date.now()
  for (const run of rt.teamRuns.values()) {
    if (!wakeDue(run, now)) continue
    await withTeamRun(rt, run, async () => {
      if (wakeDue(run, Date.now())) await applyTeamActions(rt, run, wake(run, Date.now()))
    })
    log('info', 'teams', `goal woke: ${run.title}`, { teamId: run.id, workspace: rt.meta.id })
  }
}

/** What a dispatched session opens with: the kind's template, the item, and the brief as a mention. */
async function dispatchPreviewOp(rt: WorkspaceRuntime, itemId: string): Promise<DispatchPreview> {
  const scored = rt.inboxCache?.items.find((i) => i.id === itemId)
  const item = scored ?? (await rt.store.items.get(itemId))
  if (!item) throw new Error('no such work item')
  const [project, brief, latest, tpl] = await Promise.all([
    projectFor(rt, item),
    currentBrief(rt, item.id),
    rt.store.briefs.latestForItem(item.id),
    readDispatchTemplate(rt.dispatchDir, item.kind),
  ])
  const mentions: Mention[] = [{ kind: 'item', ref: item.id, label: item.title }]
  if (brief) mentions.push({ kind: 'artifact', ref: brief.artifact.id, label: brief.artifact.title })
  // No description here — the @item: mention below attaches the work item itself,
  // and the agent can read its description via get_work_item rather than duplicating it.
  const body = renderTemplate(tpl, {
    kind: item.kind,
    title: item.title,
    url: item.url || undefined,
    reason: scored?.reason,
    note: latest?.note ?? undefined,
    brief: !!brief,
    source: item.source !== 'manual',
  })
  // The item's screenshots are attached by the server when the draft is sent
  // (they never ride in localStorage), so the text says they are coming.
  const shots = item.images?.length ?? 0
  const note = shots ? `\n\n${shots} screenshot${shots === 1 ? '' : 's'} from this item ${shots === 1 ? 'is' : 'are'} attached to this message.` : ''
  // The mention tokens must appear in the text — the composer attaches only what the text names.
  const text = `${body}${note}\n\n${mentions.map(mentionToken).join(' ')}`
  // What the draft offers, never picks: a branch for a new worktree, and the item's own worktree if it has one.
  const main = mainCheckout(rt, project?.id)
  const existing = checkoutList(rt).find((c) => c.itemId === item.id && c.kind === 'worktree' && c.state === 'active')
  return {
    title: item.title.slice(0, 80),
    cwd: project?.path ?? null,
    text,
    mentions,
    branch: main?.branch ? branchFromTitle(item.title) || null : null,
    checkoutId: existing?.id ?? null,
  }
}

// ---------------------------------------------------------------------------
// Junior (.docs/junior-goals-teams): the persona, the Junior page's day, and
// today's plan. The rules are pure and tested in core/junior/; everything
// here only gathers their inputs from the runtime and the store.
// ---------------------------------------------------------------------------

const PERSONA_KEY = 'junior.persona'

async function readPersona(rt: WorkspaceRuntime): Promise<Persona> {
  return personaFrom(await rt.store.config.get<unknown>(PERSONA_KEY))
}

/** Save a patch onto the persona; every open page and the rail repaint from the broadcast. */
async function savePersonaOp(rt: WorkspaceRuntime, raw: unknown): Promise<Persona> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('need a JSON object')
  const next = personaFrom(raw, rt.persona)
  await rt.store.config.set(PERSONA_KEY, next)
  rt.persona = next
  broadcast(rt, { type: 'persona', persona: next })
  log('info', 'junior', `persona saved: ${next.name}, ${next.voice}`, { workspace: rt.meta.id })
  return next
}

/** What the greeting calls the user: the first word of the Mac's full name, else of the login. Cached. */
let youName: Promise<string | null> | null = null
function userFirstName(): Promise<string | null> {
  youName ??= (async () => {
    const full = process.platform === 'darwin' ? await pExecFile('id', ['-F']).then((r) => r.stdout.trim(), () => '') : ''
    const first = (full || os.userInfo().username).split(/[\s._-]+/).find(Boolean) ?? ''
    return first ? first[0].toUpperCase() + first.slice(1) : null
  })()
  return youName
}

/** "the Mentions job", "the Build team", or the session's title — where a send came from. */
function sendOrigin(v: ActionView): string {
  if (v.sessionKind === 'job-run') return v.jobTitle ? `the ${v.jobTitle} job` : 'a job'
  if (v.teamRunId) return v.teamLabel ? `the ${v.teamLabel} team` : 'a team'
  return v.sessionTitle ?? 'a session'
}

/** The open inbox as the Junior page reads it: the warm cache, else a sync. */
const juniorInbox = async (rt: WorkspaceRuntime): Promise<ScoredItem[]> => (rt.inboxCache ?? (await getInbox(rt, false))).items

/** No plan has ever existed and no chat was ever started: Junior introduces itself. */
async function isFirstOpen(rt: WorkspaceRuntime): Promise<boolean> {
  return !(await rt.store.today.everPlanned()) && ![...rt.rows.values()].some((r) => r.kind === 'chat')
}

/**
 * Today's plan, opened if it isn't yet: the day's record, and the rows that
 * carry over from the last planned day (every row whose item is still open).
 */
async function ensureToday(rt: WorkspaceRuntime, now = Date.now()): Promise<string> {
  const date = dayKey(now)
  if (await rt.store.today.day(date)) return date
  const prev = await rt.store.today.lastBefore(date)
  const open = new Set<string>()
  for (const e of prev?.entries ?? []) if ((await rt.store.items.get(e.itemId))?.status === 'open') open.add(e.itemId)
  const carried = prev ? carryOver(prev.entries, (id) => open.has(id), date, now) : []
  if (await rt.store.today.openDay({ date, createdAt: now, draftedAt: null }, carried)) {
    if (carried.length) {
      log('info', 'junior', `today: ${carried.length} carried over from ${prev?.date}`, { workspace: rt.meta.id })
      broadcast(rt, { type: 'today_changed' })
    }
  }
  return date
}

/**
 * The page opened: the first open of a day drafts the plan, once — unless
 * this is the first open ever, where Junior introduces itself instead.
 * `force` = the user asked for a draft ("draft one from my inbox").
 */
async function openTodayOp(rt: WorkspaceRuntime, opts: { force?: boolean } = {}): Promise<PlanView> {
  const now = Date.now()
  const date = await ensureToday(rt, now)
  const day = await rt.store.today.day(date)
  if (opts.force || (day && !day.draftedAt && !(await isFirstOpen(rt)))) {
    await rt.store.today.setDrafted(date, now)
    const existing = await rt.store.today.entries(date)
    const candidates = (await juniorInbox(rt)).map((i) => ({ id: i.id, score: i.score, turn: i.flow?.turn, group: i.group, kind: i.kind, status: i.status ?? 'open' }))
    const rows = draftPlan({ date, now, existing, candidates })
    for (const r of rows) await rt.store.today.put(r)
    log('info', 'junior', `today: drafted ${rows.length} from the inbox`, { workspace: rt.meta.id })
    broadcast(rt, { type: 'today_changed' })
  }
  return todayView(rt, date)
}

/** Read a running session's todo list for "step 2 of 3" — the last few hundred events are plenty. */
async function sessionProgress(rt: WorkspaceRuntime, sessionId: string): Promise<TodoProgress | null> {
  const last = await rt.store.events.lastSeq(sessionId)
  const events = await rt.store.events.read(sessionId, Math.max(0, last - 400))
  return todoProgress(events.map((e) => e.event))
}

const isRunning = (s: SessionStatus | undefined) => s === 'running' || s === 'starting'

/** The plan as the page shows it: each row's item, owner and status. */
async function todayView(rt: WorkspaceRuntime, date: string): Promise<PlanView> {
  const entries = await rt.store.today.entries(date)
  const ids = entries.map((e) => e.itemId)
  const ranked = new Map((rt.inboxCache?.items ?? []).map((i) => [i.id, i]))
  const times = await rt.store.items.statusTimes(ids)
  const items = new Map<string, PlanItem>()
  for (const id of ids) {
    // The store is the truth for status; the ranked snapshot adds the label and the flow.
    const it = await rt.store.items.get(id)
    if (!it) continue
    const r = ranked.get(id)
    items.set(id, { ...it, status: it.status ?? 'open', statusAt: times.get(id), ...(r ? { label: r.label, flow: r.flow } : {}) })
  }
  const sessions: PlanSession[] = []
  for (const [sessionId, itemId] of rt.sessionItem) {
    if (!items.has(itemId) || teamRunOf(rt, sessionId)) continue
    const row = rt.rows.get(sessionId)
    const l = rt.live.get(sessionId)
    if (!row || row.kind !== 'chat') continue
    const running = isRunning(l?.status)
    const todo = running ? await sessionProgress(rt, sessionId) : null
    sessions.push({ id: sessionId, itemId, running, waiting: !!l?.waiting, step: todo ? { n: todo.n, of: todo.of } : null, activity: todo?.activity ?? null, updatedAt: row.updatedAt })
  }
  for (const run of rt.teamRuns.values()) {
    if (!items.has(run.itemId) || run.state === 'done' || run.state === 'stopped') continue
    sessions.push({
      id: run.leadSessionId,
      itemId: run.itemId,
      running: run.state === 'running',
      waiting: run.state === 'proposed' || run.state === 'gate' || !!run.revision,
      step: { n: Math.min(run.step + 1, run.recipe.steps.length), of: run.recipe.steps.length },
      activity: null,
      updatedAt: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
    })
  }
  const projects = new Map((await rt.store.projects.list()).map((p) => [p.id, p.name]))
  return planRows({ date, entries, items, sessions, projectName: (id) => (id ? projects.get(id) : undefined) })
}

/** Put an item on today (an existing one, or a new to-do made from `title`), or change whose it is. */
async function addToTodayOp(rt: WorkspaceRuntime, raw: unknown, by: AddedBy): Promise<{ plan: PlanView; itemId: string; created: boolean }> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // "user" is how the MCP tools say it (a model reads "you" as itself).
  const owner: Owner = r.owner === 'user' ? 'you' : isOwner(r.owner) ? r.owner : 'you'
  let itemId = typeof r.itemId === 'string' ? r.itemId.trim() : ''
  let created = false
  if (!itemId) {
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (!title) throw new Error('need an itemId, or a title to create a to-do from')
    itemId = await createManualOp(rt, { title })
    created = true
  } else if (!(await rt.store.items.get(itemId))) throw new Error(`no work item ${itemId} — find it with list_work_items, or create it first`)
  const now = Date.now()
  const date = await ensureToday(rt, now)
  const existing = await rt.store.today.entries(date)
  const had = existing.find((e) => e.itemId === itemId)
  await rt.store.today.put({
    date,
    itemId,
    owner,
    addedBy: had?.addedBy ?? by,
    addedAt: had?.addedAt ?? now,
    order: had?.order ?? existing.reduce((m, e) => Math.max(m, e.order + 1), 0),
    carriedFrom: had?.carriedFrom ?? null,
  })
  log('info', 'junior', `today: ${had ? 'owner of' : 'added'} ${itemId} → ${owner} (by ${by})`, { workspace: rt.meta.id })
  broadcast(rt, { type: 'today_changed' })
  return { plan: await todayView(rt, date), itemId, created }
}

async function removeFromTodayOp(rt: WorkspaceRuntime, raw: unknown): Promise<{ plan: PlanView; removed: boolean }> {
  const itemId = typeof (raw as { itemId?: unknown } | null)?.itemId === 'string' ? (raw as { itemId: string }).itemId : ''
  if (!itemId) throw new Error('need an itemId')
  const date = await ensureToday(rt)
  const removed = await rt.store.today.remove(date, itemId)
  if (removed) broadcast(rt, { type: 'today_changed' })
  return { plan: await todayView(rt, date), removed }
}

/** "Also today…": the open item a few typed words mean, if any. */
async function matchTodayOp(rt: WorkspaceRuntime, q: string): Promise<{ id: string; title: string; ref: string; onToday: boolean } | null> {
  const items = await juniorInbox(rt)
  const hit = matchItem(q, items)
  if (!hit) return null
  const item = items.find((i) => i.id === hit.id)!
  const date = await ensureToday(rt)
  const onToday = (await rt.store.today.entries(date)).some((e) => e.itemId === hit.id)
  return { id: item.id, title: item.title, ref: shortRef(item), onToday }
}

/** The plan for a model: compact JSON, ids first so every row is a next call. */
function todayJson(plan: PlanView): string {
  const status = (s: PlanRow['status']) =>
    s.kind === 'done' ? 'done' : s.kind === 'needs' ? 'a session on it waits on the user' : s.kind === 'live' ? `in progress${s.step ? `, step ${s.step.n} of ${s.step.of}` : ''}` : s.kind === 'waiting' ? `${s.who ?? 'someone'} is waiting on the user` : s.kind === 'carried' ? `carried over from ${s.from}` : (s.note ?? 'to do')
  return JSON.stringify(
    { date: plan.date, done: plan.done, total: plan.total, rows: plan.rows.map((r) => ({ itemId: r.itemId, title: r.title, ref: r.ref, owner: r.owner === 'you' ? 'the user' : 'you (Junior)', status: status(r.status) })) },
    null,
    2,
  )
}

/**
 * Today's plan in a new Junior session's context, and what to do when the
 * user adds to it mid-chat. A snapshot, said to be one: get_today reads it
 * live. (shared/triageContext.ts keeps live state out of prompts; this is
 * the one deliberate exception, so "today we also want X" works in any chat.)
 */
function todayAppend(plan: PlanView, name: string, now: number): string {
  const when = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const rows = plan.rows.length
    ? plan.rows
        .map((r) => {
          const who = r.owner === 'you' ? 'the user' : name
          const st = r.status.kind === 'done' ? 'done' : r.status.kind === 'live' ? 'in progress' : r.status.kind === 'carried' ? 'carried over' : 'to do'
          return `- [${who}] ${r.title} (${r.itemId}) — ${st}`
        })
        .join('\n')
    : '(nothing on it yet)'
  return `

Today's plan, as of ${when} on ${plan.date}. It may have moved since; get_today reads it live:
${rows}

The plan is shared: you and the user both work from it, and every session today can see it. When the user says
something is also for today ("today we also want X"), find the work item first with list_work_items, matching the
title or a ref. If there is one, put it on with add_to_today, asking whose it is today (theirs or yours) only when
they didn't say. If there is none, offer to create it with create_work_item and put it on today, in one reply.
Take something off with remove_from_today.`
}

/** Spawn-time additions for one of Junior's chats: the persona, then today's plan. */
async function juniorAppend(rt: WorkspaceRuntime): Promise<string> {
  const now = Date.now()
  let plan: PlanView | null = null
  try {
    plan = await todayView(rt, await ensureToday(rt, now))
  } catch (err) {
    log('warn', 'junior', `could not read today's plan for a session: ${errText(err)}`, { workspace: rt.meta.id })
  }
  return `${personaAppend(rt.persona)}${plan ? todayAppend(plan, rt.persona.name, now) : ''}`
}

/** Everything the Junior page shows, in one read. `since` = the brief's window. */
async function juniorDayOp(rt: WorkspaceRuntime, q: { since: number; away: boolean }): Promise<JuniorDay> {
  const now = Date.now()
  const since = Number.isFinite(q.since) && q.since > 0 && q.since <= now ? q.since : startOfDay(now)
  const items = await juniorInbox(rt)
  const rows = [...rt.rows.values()]
  const jobs = await rt.store.jobs.list()
  const jobTitles = new Map(jobs.map((j) => [j.id, j.title]))
  const projects = await rt.store.projects.list()
  const plan = await todayView(rt, await ensureToday(rt, now))

  // Needs you: held sessions, team runs waiting on you, sends waiting for your OK.
  const blocked = rows
    .filter((r) => rt.live.get(r.id)?.waiting)
    .map((r) => ({ id: r.id, title: r.title, waitingOn: rt.live.get(r.id)?.waitingOn, at: r.updatedAt }))
  const teams: TeamSource[] = []
  for (const run of rt.teamRuns.values()) {
    const state = run.revision ? 'revision' : run.state === 'proposed' ? 'proposed' : run.state === 'gate' ? 'gate' : null
    if (!state) continue
    teams.push({
      runId: run.id,
      leadSessionId: run.leadSessionId,
      label: run.title,
      goal: run.card.goal,
      state,
      steps: run.recipe.steps.length,
      team: run.recipe.label || run.team,
      budgetUsd: run.card.budgetUsd || run.budgetUsd,
      ...(state === 'revision' ? { reason: run.revision?.why } : run.reason ? { reason: run.reason } : {}),
      at: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
    })
  }
  const sends = new Map<string, SendsSource>()
  for (const v of await actionViews(rt, await rt.store.actions.list({ status: ['needs_you'], limit: 500 }))) {
    if (v.hidden) continue
    const at = v.queue?.queuedAt ?? v.attemptedAt
    const s = sends.get(v.sessionId) ?? { sessionId: v.sessionId, origin: sendOrigin(v), titles: [], at }
    s.titles.push(v.title)
    s.at = Math.min(s.at, at)
    sends.set(v.sessionId, s)
  }
  const needs = needsRows({ blocked, teams, sends: [...sends.values()] }, now)

  // The brief's facts.
  const runs: FactRun[] = rows
    .filter((r) => r.kind === 'job-run' && r.jobId && r.runStatus)
    .map((r) => ({ jobId: r.jobId!, ok: r.runStatus === 'ok', endedAt: r.updatedAt, filed: r.runNew ?? r.runMatches ?? 0 }))
  const sent = (await rt.store.actions.list({ since, status: ['succeeded'], limit: 1000 })).length
  const facts = briefFacts({ since, away: q.away, items, runs, jobTitles, sent })

  // Right now: team runs count once (at their lead), job runs by their job, chats by their own todo list.
  const onPlan = new Set(plan.rows.map((r) => r.itemId))
  const running: NowCandidate[] = []
  for (const run of rt.teamRuns.values()) {
    if (run.state !== 'running') continue
    running.push({
      target: { kind: 'session', id: run.leadSessionId },
      title: run.card.goal || run.title,
      updatedAt: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
      onPlan: onPlan.has(run.itemId),
      todo: null,
      team: { n: Math.min(run.step + 1, run.recipe.steps.length), of: run.recipe.steps.length },
    })
  }
  for (const r of rows) {
    if (r.kind !== 'chat' || !isRunning(rt.live.get(r.id)?.status) || teamRunOf(rt, r.id)) continue
    const itemId = rt.sessionItem.get(r.id)
    running.push({ target: { kind: 'session', id: r.id }, title: r.title, updatedAt: r.updatedAt, onPlan: !!itemId && onPlan.has(itemId), todo: await sessionProgress(rt, r.id), team: null })
  }
  for (const jobId of rt.runningJobs) {
    running.push({ target: { kind: 'job', id: jobId }, title: `running the ${jobTitles.get(jobId) ?? 'scheduled'} job`, updatedAt: now, onPlan: false, todo: null, team: null })
  }

  const firstOpen = await isFirstOpen(rt)
  const slack = slackConnected(rt) === true
  const offerItems = items as OfferItem[]
  let seen: JuniorSeen | null = null
  {
    // Every MCP server Claude Code can see is a source, by its plain name; triage's own server isn't one.
    const conns = new Map<string, boolean>()
    for (const c of rt.connectorCache?.connectors ?? []) {
      if (c.server === RESERVED_SERVER || c.name === RESERVED_SERVER) continue
      const name = c.name.replace(/^plugin:(?:[^:]+:)?/, '')
      conns.set(name, (conns.get(name) ?? false) || c.status === 'connected')
    }
    seen = {
      github: await ghLogin().catch(() => null),
      sources: [...conns].map(([name, connected]) => ({ name, connected })).sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
      projects: projects.map((p) => p.name),
    }
  }

  let routines: JuniorDay['routines'] = []
  try {
    const roots = await libraryRootsFor(rt)
    routines = [...(await listLibrary('skill', roots)), ...(await listLibrary('agent', roots))]
      .filter((e) => e.source === 'workspace')
      .map((e) => ({ name: e.name, kind: e.kind, path: e.path }))
  } catch (err) {
    log('warn', 'junior', `could not list the workspace library: ${errText(err)}`, { workspace: rt.meta.id })
  }

  const you = await userFirstName()
  return {
    you: { name: you, initial: (you ?? 'You')[0].toUpperCase() },
    firstOpen,
    now: pickNow(running),
    needs,
    facts,
    plan,
    seen,
    offers: firstOpen ? firstOffers(offerItems, { slack, now }) : [],
    fill: canDoFill(offerItems, projects.map((p) => p.name), slack),
    stuck: (await inboxAlerts(rt)).length > 0 || rows.some((r) => rt.live.get(r.id)?.status === 'error'),
    routines,
    morning: morningBrief({ items, facts, now }),
    jobsOn: jobs.filter((j) => j.enabled).length,
  }
}

const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function makeTriageMcp(rt: WorkspaceRuntime) {
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    // Always load triage's tools, never defer them behind tool search — and,
    // as a documented side effect, block session startup until this server is
    // connected (capped at the SDK's 5s connect timeout). Without it, when the
    // user has many ~/.claude connectors, triage loses the init connection race
    // ("connector storm") and lands `status: "failed"` in system/init, leaving
    // a chat with no mcp__triage__* tools so it falls back to the HTTP API.
    // triage is in-process and connects in ~ms, so this guarantees its tools
    // are present on turn 1 without slowing startup or dropping any connector.
    alwaysLoad: true,
    // What triage is, in the one place the SDK will show a model before it
    // picks a tool. Static by construction (shared/triageContext.ts) so it
    // caches, and shared verbatim with the stdio shim — one contract, two
    // transports, one explanation of it.
    instructions: TRIAGE_MCP_INSTRUCTIONS,
    tools: [
      // Teams v2: any chat can become a lead (list_teams, propose_team, split_step, submit_step).
      ...teamLeadTools(rt),
      // Goals are team runs with a done-when now (propose_team's `goal`); the old goals engine's
      // goal_* tools stay in server/goals.ts but no chat is offered them.
      tool(
        'list_work_items',
        'Read the ranked triage queue: work items with their score, group, and reason. Open items by default — pass status to read the done, snoozed or archived lists instead. Optional filters narrow by source or kind.',
        {
          status: z.enum(['open', 'snoozed', 'done', 'archived']).optional().describe('which list to read (default "open")'),
          source: z.enum(['github', 'slack', 'linear', 'manual']).optional().describe('only items from this source'),
          kind: z.string().optional().describe('only items of this kind, e.g. "job-hit"'),
        },
        async (args) => {
          try {
            const items = await listItemsOp(rt, { source: args.source, kind: args.kind, status: args.status })
            return okResult(JSON.stringify(items, null, 2))
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      // Today's plan (core/junior/today.ts): get_today is a free read; the two writes prompt like any write.
      tool(
        'get_today',
        "Today's plan: the work items the user and you mean to get through today, each with an owner (the user, or you) and a status. Done comes from the item itself; unfinished rows carried over from earlier days say so. Read it before planning work, and when the user mentions today.",
        {},
        async () => {
          try {
            return okResult(todayJson(await todayView(rt, await ensureToday(rt))))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'add_to_today',
        "Put a work item on today's plan, or change whose it is today. Find the item first (list_work_items); if there is none, create it with create_work_item and pass its id. Ask whose it is when the user didn't say.",
        {
          itemId: z.string().describe('the work item, e.g. "github:owner/repo#12" or "manual:<uuid>"'),
          owner: z.enum(['user', 'junior']).describe('whose it is today: "user" = the user does it, "junior" = you do'),
        },
        async (args) => {
          try {
            const { plan } = await addToTodayOp(rt, args, 'junior')
            return okResult(`ok: ${args.itemId} is on today's plan, owned by ${args.owner === 'user' ? 'the user' : 'you'}\n${todayJson(plan)}`)
          } catch (err) {
            return errResult(`not added: ${errText(err)}`)
          }
        },
      ),
      tool(
        'remove_from_today',
        "Take a work item off today's plan. The item itself is untouched: it stays in the inbox, at its status.",
        { itemId: z.string().describe('the work item on the plan') },
        async (args) => {
          try {
            const { removed, plan } = await removeFromTodayOp(rt, args)
            return okResult(`${removed ? 'ok: removed' : 'it was not on today\'s plan'}\n${todayJson(plan)}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'set_reply_style',
        "Save how you reply to the user, in their words (About me → How I reply to you). Use it when they tell you how they want replies: tone, length, format. It shapes how you talk, never what you may do; the rules stay. Applies to new sessions.",
        { text: z.string().max(400).describe("the user's preference, in a sentence or two, in their words; empty clears it") },
        async (args) => {
          try {
            const p = await savePersonaOp(rt, { replyStyle: args.text })
            return okResult(p.replyStyle ? `ok: saved. New sessions read: "${p.replyStyle}"` : 'ok: cleared')
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_work_item',
        'Everything about one work item by id, at any status: the item, its rank if it is in the open inbox, the items sharing a ref with it, the artifacts linked to it (its brief and any context notes) and the sessions that worked it. Use this to follow an id from list_work_items, from a linked sibling, or from get_session_context.',
        { id: z.string().describe('a work-item id, e.g. "github:owner/repo#12" or "manual:<uuid>"') },
        async (args) => {
          try {
            return okResult(JSON.stringify(await itemDetailOp(rt, args.id), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_session_context',
        'What this session is: its workspace, the work item it was opened for (with that item\'s brief and notes), and the artifacts attached to it. Your own triage session id is in your system prompt. Call this before writing a note "here" — the ids it returns are what write_artifact\'s `links` needs.',
        { sessionId: z.string().describe('a triage session id — yours is named in your system prompt') },
        async (args) => {
          try {
            return okResult(JSON.stringify(await sessionContextOp(rt, args.sessionId), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_workspace',
        'Which triage workspace you are acting in: `current` (its id, name, whether it is the default, and its auth backend) plus `workspaces`, the full roster of ids to switch among. Everything you list/create/edit here lives in `current`. An external Claude Code session picks its workspace with the TRIAGE_WORKSPACE env var (an unknown id silently falls back to the default) — call this to confirm which one you actually landed in.',
        {},
        async () => {
          try {
            return okResult(JSON.stringify(workspaceInfo(rt), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'draft_job',
        'Draft a job — a scheduled headless run that files matches as work items (or writes a digest). It is saved OFF as a draft: only the user can enable it, from the job page this returns a link to. Use when the user asks to run something on a schedule, monitor it or keep an eye on it.',
        {
          title: z.string().describe('a short name, e.g. "Anirudha’s PRs"'),
          schedule: z.string().describe('a 5-field cron line in local time: "0 * * * *" hourly, "0 9 * * 1-5" weekdays at 9'),
          instruction: z.string().describe('where to look, what counts as a match, what to file — written for the run, which sees only this'),
          project: z.string().optional().describe('the project folder runs work in: an id or a name; default = the default project'),
          tools: z
            .array(z.string())
            .optional()
            .describe('what runs may use, one per entry: built-ins web, github, files-write, or "<server>/<tool>" for an MCP tool; default [web]'),
          output: z.enum(['items', 'digest']).optional().describe('items (one work item per match, default) or digest (one rolling report)'),
          model: z.string().optional().describe('model for the runs; default = Claude Code’s'),
          brief: z.boolean().optional().describe('brief every item it files (items output only)'),
          brief_model: z.string().optional().describe('model for the briefs; default = the workspace’s brief default'),
          brief_template: z.string().optional().describe('playbook to brief with, e.g. "review-requested"; default = the item’s kind'),
          skills: z.array(z.string()).optional().describe(SKILLS_ARG),
          agents: z.array(z.string()).optional().describe(AGENTS_ARG),
        },
        async (args) => {
          try {
            return okResult(draftJobText(await draftJobOp(rt, args), true))
          } catch (err) {
            return errResult(`not drafted: ${errText(err)}`)
          }
        },
      ),
      tool(
        'try_job',
        'Trial-run a job once, as a dry run: the same prompt, tools and fences as a real run, but nothing is filed or sent. Waits for the run (a few minutes at most) and returns what it would have filed. Use after draft_job, when the user agrees to a trial run.',
        { id: z.string().describe('the job id draft_job returned') },
        async (args) => {
          try {
            return okResult(await tryJobOp(rt, args))
          } catch (err) {
            return errResult(`trial run failed: ${errText(err)}`)
          }
        },
      ),
      tool(
        'create_work_item',
        'Add a manual to-do to the inbox (a user-authored item). Title is required; description, url, urls, priority (1–4), due (ISO day), and projectId are optional.',
        {
          title: z.string().describe('what the to-do is'),
          description: z.string().optional().describe("the user's intent in a few sentences"),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional().describe('an http(s) link'),
          urls: z.array(z.string()).optional().describe('more http(s) links — the Slack thread, the PR, a doc'),
          priority: z.number().int().min(1).max(4).optional(),
          projectId: z.string().optional().describe('an existing project id'),
          due: z.string().optional().describe('due day, ISO 8601 (e.g. 2026-10-21)'),
        },
        async (args) => {
          try {
            const id = await createManualOp(rt, args)
            return okResult(`ok: created ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'edit_work_item',
        'Edit a manual to-do by id (id must start with "manual:"). Only the fields you pass change; priority 0/null and due null clear them.',
        {
          id: z.string().describe('the manual item id, e.g. "manual:<uuid>"'),
          title: z.string().optional(),
          description: z.string().optional(),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional(),
          urls: z.array(z.string()).optional().describe('the complete list of extra links; [] clears them'),
          priority: z.number().int().min(0).max(4).nullable().optional(),
          projectId: z.string().optional(),
          due: z.string().nullable().optional().describe('due day, ISO 8601 (e.g. 2026-10-21), or null to clear'),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            await editManualOp(rt, id, patch)
            return okResult(`ok: edited ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'upsert_work_item',
        'Idempotently upsert one ingested work item (for scanners). Id-keyed, update-only-if-newer by updatedAt, user-state-preserving: repeated calls never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
        {
          id: z.string().describe('stable id: "slack:...", "github:owner/repo#123", or "linear:KEY-123"'),
          kind: z.string().describe('item kind, e.g. "job-hit", "mention", "fyi"'),
          title: z.string(),
          url: z.string(),
          updatedAt: z.string().describe('ISO 8601 — the upsert applies only if newer than what is stored'),
          repo: z.string().optional(),
          author: z.string().optional(),
          peopleWaiting: z.number().optional(),
          createdAt: z.string().optional(),
          jobId: z.string().optional(),
          why: z.string().optional(),
          ask: z.enum(LABEL_ORDER as [Label, ...Label[]]).optional().describe('what it asks of the user (job hits)'),
          due: z.string().optional().describe('a deadline the source states, ISO 8601 day'),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const outcome = await upsertItemOp(rt, args)
            return okResult(`ok: ${outcome}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'resolve_work_item',
        'Mark one work item done (by id). Subject to the re-arm rule: if the source updates afterwards, the item returns to the inbox.',
        { id: z.string() },
        async (args) => {
          try {
            await resolveItemOp(rt, args.id)
            return okResult('ok: done')
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      // Artifacts: the user's markdown notes and briefs beside the inbox
      // (.docs/next-version.md). Reads are auto-allowed; writes prompt like
      // every other triage write, and the model may only rewrite its own.
      tool(
        'list_artifacts',
        "List this workspace's artifacts — markdown notes and briefs kept beside the work items — with id, title, author (human|model), refs, path and links. Read one with read_artifact.",
        { all: z.boolean().optional().describe('include briefs of finished (done/archived) items, hidden by default') },
        async (args) => {
          try {
            const rows = await listArtifactsOp(rt, args.all === true)
            return okResult(JSON.stringify(rows.map(({ mtime, size, ...a }) => (void mtime, void size, a)), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'read_artifact',
        'Read one artifact by id: title, author, refs, its path on disk, and the full markdown body.',
        { id: z.string().describe('the artifact id from list_artifacts') },
        async (args) => {
          try {
            const a = await rt.artifacts.read(args.id)
            if (!a) return errResult('no such artifact')
            const head = [
              `title: ${a.artifact.title}`,
              `id: ${a.artifact.id}`,
              `author: ${a.artifact.author}`,
              `path: ${a.abs}`,
              a.artifact.refs.length ? `refs: ${a.artifact.refs.join(', ')}` : undefined,
            ].filter((l): l is string => typeof l === 'string')
            return okResult(`${head.join('\n')}\n\n${a.body}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'write_artifact',
        'Create a new artifact (a markdown note authored by you, the model) in the workspace, optionally linked to a work item or session as context. Returns its id. Use update_artifact to change it later.',
        {
          title: z.string().describe('a short title'),
          body: z.string().describe('the markdown body'),
          refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys this note is about'),
          links: z
            .array(
              z.object({
                kind: z.enum(['item', 'session']),
                id: z.string(),
                role: z.enum(['brief', 'context', 'dispatch']),
              }),
            )
            .optional()
            .describe('attach to a work item or session; role is usually "context"'),
        },
        async (args) => {
          try {
            const a = await createArtifactOp(rt, args, 'model')
            return okResult(`ok: created ${a.id} at ${a.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'update_artifact',
        'Rewrite an artifact you (the model) authored, in place: any of title, body, refs. Human-authored artifacts are refused — propose the change to the user instead.',
        {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            const a = await updateArtifactOp(rt, id, patch, 'model')
            return okResult(`ok: updated ${a.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'link_artifact',
        'Link an existing artifact to a work item or session with a role ("context" for notes to read alongside; "brief" only for the document about an item).',
        {
          artifactId: z.string(),
          kind: z.enum(['item', 'session']),
          id: z.string(),
          role: z.enum(['brief', 'context', 'dispatch']),
        },
        async (args) => {
          try {
            const l = await addLinkOp(rt, { fromKind: 'artifact', fromId: args.artifactId, toKind: args.kind, toId: args.id, role: args.role })
            return okResult(`ok: linked ${l.id}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}

const NO_BUILD_HTML = `<!doctype html><meta charset="utf-8">
<title>triage — no build</title>
<body style="font:14px/1.6 system-ui;max-width:34em;margin:12vh auto;color:#dce3f0;background:#0d1017">
<h2 style="color:#e8b04b">No web build found</h2>
<p>This server is serving the production bundle from <code>dist/web</code>, which does not exist yet.</p>
<p>For development, run <code>npm run dev</code> and open the Vite URL it prints — it proxies
<code>/ws</code> and <code>/api</code> back here.</p>
<p>For a production-style run: <code>npm run build &amp;&amp; npm start</code>.</p>
</body>`

/**
 * The bundled manifest, with the start URL swapped per device: a paired phone's
 * home-screen app opens through /api/pair, because iOS gives a standalone web
 * app its own cookie jar and the pairing cookie would not follow it there.
 */
function webManifest(access: Access): Record<string, unknown> {
  let base: Record<string, unknown> = { name: 'Triage', short_name: 'Triage', display: 'standalone' }
  try {
    base = JSON.parse(readFileSync(path.join(WEB_DIR, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>
  } catch {
    // no build yet: the minimal manifest is fine
  }
  return { ...base, start_url: access === 'paired' ? `/api/pair?token=${encodeURIComponent(remote.token)}` : '/', scope: '/' }
}

function remoteStatus(): RemoteStatus {
  if (remote.enabled) pairCode = livePairCode(pairCode, Date.now())
  return {
    local: true,
    enabled: remote.enabled,
    token: remote.token,
    code: remote.enabled && pairCode ? { digits: pairCode.code, expiresAt: pairCode.expiresAt } : null,
    port: PORT,
    addresses: lanAddresses(),
    hostname: bonjourName(),
    tunnel: remote.tunnel,
    tunnelStatus: tunnel.status,
  }
}

/** Sockets and WebSockets from other devices, so switching access off or resetting the token cuts them at once. */
const remoteSockets = new Set<import('node:net').Socket>()
const remoteWs = new Set<WebSocket>()

function dropRemoteClients() {
  for (const ws of remoteWs) ws.close(4401, 'unpaired')
  remoteWs.clear()
  for (const sock of remoteSockets) sock.destroy()
  remoteSockets.clear()
}

async function serveWeb(pathname: string, res: http.ServerResponse) {
  // Any path that is not a real asset falls back to index.html (SPA routing).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(WEB_DIR, rel)
  const candidate = resolved.startsWith(WEB_DIR + path.sep) ? resolved : path.join(WEB_DIR, 'index.html')

  for (const file of [candidate, path.join(WEB_DIR, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
      return
    } catch {
      // try the SPA fallback next
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(NO_BUILD_HTML)
}


/**
 * The MCP endpoint (streamable HTTP): the same contract the stdio shim serves
 * (core/mcp/tools.ts), reachable as a URL instead of a spawned process —
 * `http://localhost:5178/mcp` for a running daemon, `…:5188/mcp` in dev. No
 * per-session subprocess to spawn, resolve on PATH, or lose a connect race
 * with, which is most of what made MCP feel unreliable from outside triage.
 *
 * The workspace rides in the URL (`?workspace=<id>`), not an env var, and an
 * id that matches nothing is refused at `initialize` — the client shows the
 * server as failed instead of quietly filing work into the default inbox.
 */
const MCP_PATH = '/mcp'

/** Loopback into this daemon's own API, so one route table serves every door. */
function mcpApi(workspace: string | null): (path: string, body?: unknown, method?: string) => Promise<unknown> {
  return async (path, body, method) => {
    if (workspace) path += `${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}`
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (await res.json()) as unknown
  }
}

type McpRpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> }

/** One JSON-RPC message. Returns null for a notification (nothing to send back). */
async function mcpDispatch(msg: McpRpc, workspace: string | null, serverUrl: string): Promise<unknown | null> {
  const id = msg.id
  const ok = (result: unknown) => (id === undefined ? null : { jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'triage', version: VERSION },
        instructions: TRIAGE_MCP_INSTRUCTIONS,
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: MCP_TOOLS })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const { text, isError } = await callMcpTool(mcpApi(workspace), { serverUrl, requestedWorkspace: workspace }, name, args)
        return ok({ content: [{ type: 'text', text }], isError })
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `failed: ${errText(err)}` }], isError: true })
      }
    }
    default:
      return msg.method ? fail(-32601, `method not found: ${msg.method}`) : fail(-32600, 'invalid request')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const access = accessOf(req, remote)
  if (url.pathname === '/api/pair') {
    // The QR code's link: trade the token for the cookie, then go home. Also
    // the home-screen app's start URL, so a standalone web app with its own
    // cookie jar pairs itself on every launch.
    const given = url.searchParams.get('token')
    const typed = url.searchParams.get('code')
    let ok = access === 'local' || (remote.enabled && tokenMatches(given?.trim(), remote.token))
    if (!ok && remote.enabled && typed && codesAllowed(req)) {
      const spent = tryPairCode(pairCode, typed, Date.now())
      pairCode = spent.next
      ok = spent.ok
      log(ok ? 'info' : 'warn', 'remote', ok ? 'device paired with the code' : 'wrong pairing code')
    }
    if (ok) {
      res.writeHead(302, { location: '/', ...(access === 'local' ? {} : { 'set-cookie': pairCookie(remote.token) }) })
      res.end()
    } else {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        pairPageHtml(
          typed
            ? 'That code did not match, or it has expired. Check the code on your Mac — it changes after each use.'
            : given
              ? 'That link has stopped working — the code was reset on the Mac. Scan the new QR code.'
              : undefined,
          codesAllowed(req),
        ),
      )
    }
    return
  }
  if (access === 'denied') {
    if (url.pathname.startsWith('/api/') || url.pathname === MCP_PATH) {
      json(401, { error: 'this device is not paired with triage' })
    } else {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pairPageHtml(undefined, codesAllowed(req)))
    }
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, access)) {
    // Any page can make a browser POST to us; only our own page gets to write.
    json(403, { ok: false, error: 'cross-origin writes are not accepted' })
    return
  }
  if (url.pathname === '/manifest.webmanifest') {
    // Served, not bundled: a paired device's start URL carries the token (see /api/pair).
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(webManifest(access)))
    return
  }
  if (url.pathname === MCP_PATH) {
    if (!sameOrigin(req, access)) {
      json(403, { error: 'cross-origin requests are not accepted on /mcp' })
      return
    }
    // No SSE stream is offered: every response is a plain JSON body, which the
    // spec covers by answering 405 to the stream methods.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ error: 'POST a JSON-RPC message to /mcp' }))
      return
    }
    const wanted = url.searchParams.get('workspace')
    if (wanted && !runtimes.has(wanted)) {
      // Loud, at connect time: the alternative is filing work into the wrong
      // inbox for as long as it takes someone to notice.
      json(404, {
        error: `unknown workspace "${wanted}"`,
        known: [...runtimes.keys()],
        hint: 'the URL takes a workspace id, not its display name; drop the parameter to use the default',
      })
      return
    }
    let payload: unknown
    try {
      payload = await readJsonBody(req, 4_000_000)
    } catch (err) {
      json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${errText(err)}` } })
      return
    }
    const serverUrl = `http://localhost:${PORT}${MCP_PATH}`
    const batch = Array.isArray(payload) ? (payload as McpRpc[]) : [payload as McpRpc]
    const out = (await Promise.all(batch.map((m) => mcpDispatch(m, wanted, serverUrl)))).filter((r) => r !== null)
    if (out.length === 0) {
      res.writeHead(202)
      res.end()
      return
    }
    json(200, Array.isArray(payload) ? out : out[0])
    return
  }

  if (url.pathname === '/api/health') {
    // The CLI's "is triage running" probe — see server/state.ts. Daemon-wide.
    json(200, {
      app: 'triage',
      version: VERSION,
      build: BUILD,
      pid: process.pid,
      port: PORT,
      db: dbFileFor(registry.defaultId, registry.defaultId),
      liveSessions: [...runtimes.values()].reduce((n, rt) => n + rt.live.size, 0),
      workspaces: runtimes.size,
    })
    return
  }

  if (url.pathname === '/api/remote') {
    // Phone access is managed from the Mac only: a paired phone can use triage
    // but cannot read the token, rotate it, or switch access off and on.
    if (access !== 'local') {
      json(200, { local: false } satisfies RemoteStatus)
      return
    }
    if (req.method === 'POST') {
      let body: { enabled?: unknown; rotate?: unknown; newCode?: unknown; tunnel?: unknown } | null
      try {
        body = (await readJsonBody(req, 10_000)) as typeof body
      } catch (err) {
        json(400, { error: errText(err) })
        return
      }
      const next = { ...remote }
      if (typeof body?.enabled === 'boolean') next.enabled = body.enabled
      if (typeof body?.tunnel === 'boolean') next.tunnel = body.tunnel
      if (body?.rotate === true) next.token = newToken()
      if (body?.rotate === true || body?.newCode === true || !next.enabled) pairCode = null
      await saveRemote(next)
      const unpair = !next.enabled || next.token !== remote.token
      remote = next
      if (unpair) dropRemoteClients()
      syncTunnel()
      log('info', 'remote', `phone access ${remote.enabled ? (remote.tunnel ? 'on, anywhere' : 'on, same network') : 'off'}${body?.rotate === true ? ', token reset' : ''}`)
    }
    json(200, remoteStatus())
    return
  }

  if (url.pathname === '/api/git/branch') {
    // Which branch a folder has checked out — the draft composer shows it
    // beside the project before any session exists. Not a repo → null.
    const cwd = expandHome(url.searchParams.get('cwd') ?? '')
    try {
      const { stdout } = await pExecFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
      json(200, { ok: true, branch: stdout.trim() || null })
    } catch {
      json(200, { ok: true, branch: null })
    }
    return
  }

  // --- workspace management (daemon-wide, not workspace-scoped) --------------
  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const body: WorkspacesResponse = {
      ok: true,
      workspaces: wireWorkspaces(),
      defaultId: registry.defaultId,
      onboarded: registry.onboarded,
    }
    json(200, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'POST') {
    let body: WorkspaceResponse
    try {
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.name) throw new Error('a workspace needs a name')
      let id = slugify(p.name)
      for (let n = 2; runtimes.has(id); n++) id = `${slugify(p.name)}-${n}`
      const meta: WorkspaceMeta = {
        id,
        name: p.name,
        color: p.color ?? '#7aa2f7',
        ...(p.description ? { description: p.description } : {}),
        provider: DEFAULT_PROVIDER,
        authBackend: p.authBackend ?? 'inherit',
        createdAt: Date.now(),
      }
      ensureWorkspaceDirs(id)
      if (p.apiKey) writeApiKey(meta, p.apiKey)
      registry.workspaces.push(meta)
      saveRegistry(registry)
      const rt = new WorkspaceRuntime(meta)
      runtimes.set(id, rt)
      await initRuntime(rt)
      log('info', 'workspaces', `created: ${meta.name}`, { workspace: id, authBackend: meta.authBackend })
      body = { ok: true, workspace: wireWorkspace(meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'PUT') {
    let body: WorkspaceResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (p.name) rt.meta.name = p.name
      if (p.color) rt.meta.color = p.color
      if (p.description !== undefined) rt.meta.description = p.description || undefined
      const authChanged = (p.authBackend && p.authBackend !== rt.meta.authBackend) || p.apiKey !== undefined
      if (p.authBackend) rt.meta.authBackend = p.authBackend
      if (p.apiKey) writeApiKey(rt.meta, p.apiKey)
      saveRegistry(registry)
      if (authChanged) applyAuthChange(rt)
      body = { ok: true, workspace: wireWorkspace(rt.meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'DELETE') {
    let body: WorkspacesResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      if (id === registry.defaultId) throw new Error('the default workspace cannot be deleted — make another workspace the default first')
      // Remove from the registry and stop the runtime. The directory (DB,
      // .env, claude/) stays on disk — never delete data, only unregister.
      for (const s of rt.live.values()) s.stop()
      for (const ws of rt.clients) ws.close()
      runtimes.delete(id)
      registry.workspaces = registry.workspaces.filter((w) => w.id !== id)
      saveRegistry(registry)
      await rt.store.close()
      log('info', 'workspaces', `removed: ${rt.meta.name} (files kept on disk)`, { workspace: id })
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces/default' && req.method === 'POST') {
    let body: WorkspacesResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!runtimes.has(id)) throw new Error('unknown workspace id')
      registry.defaultId = id
      saveRegistry(registry)
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces/onboarded' && req.method === 'POST') {
    registry.onboarded = true
    saveRegistry(registry)
    json(200, { ok: true })
    return
  }
  // A live probe with the workspace's own env — the creation modal's verify
  // step, and the settings dialog's "Check again". Clears the caches first so
  // the answer reflects the auth as configured right now.
  if (url.pathname === '/api/workspaces/verify' && req.method === 'POST') {
    let body: WorkspaceVerifyResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      rt.refreshEnv()
      rt.connectorCache = null
      rt.modelCache.clear()
      const [models, connectors, auth] = await Promise.all([
        probeModels(rt),
        probeConnectors(rt),
        // inherit is the machine's own login — already proven by daily use.
        rt.meta.authBackend === 'inherit' ? Promise.resolve({ ok: true as const }) : probeAuth(rt),
      ])
      body = {
        ok: true,
        models: models.models,
        connectors: connectors.connectors,
        slackConnected: slackConnected(rt) === true,
        authOk: auth.ok,
        ...('error' in auth && auth.error ? { authError: auth.error } : {}),
      }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }

  // --- everything below is scoped to one workspace ---------------------------
  const rt = resolveRuntime(req, url)

  // The workspace this request resolved to, singular and scoped — unlike the
  // daemon-wide /api/workspaces list. Backs get_workspace so a chat or the stdio
  // shim can answer "which workspace am I in?" (and the shim can tell whether its
  // TRIAGE_WORKSPACE matched or silently fell back to the default).
  if (url.pathname === '/api/workspace' && req.method === 'GET') {
    json(200, { ok: true, ...workspaceInfo(rt) })
    return
  }

  // --- the browser pane (.docs/browser.md): host status, evidence, the picker ---
  if (url.pathname === '/api/browser/status' && req.method === 'GET') {
    json(200, { ok: true, ...browserHub.status })
    return
  }
  const shotRoute = /^\/api\/browser\/shots\/([\w-]+)(?:\/(\d+))?$/.exec(url.pathname)
  if (shotRoute && req.method === 'GET') {
    const [, sessionId, n] = shotRoute
    if (!n) {
      const body: BrowserShotsResponse = { ok: true, shots: rt.shots.list(sessionId) }
      json(200, body)
      return
    }
    const f = rt.shots.file(sessionId, Number(n))
    try {
      if (!f) throw new Error('no such shot')
      const bytes = await readFile(f.path)
      // Shots are numbered and never rewritten: cache hard.
      res.writeHead(200, { 'content-type': f.mime, 'content-length': String(bytes.length), 'cache-control': 'private, max-age=31536000, immutable' })
      res.end(bytes)
    } catch {
      json(404, { ok: false, error: 'no such shot' })
    }
    return
  }
  if (url.pathname === '/api/browser/pick' && req.method === 'POST') {
    let body: BrowserPickResponse
    try {
      const b = (await readJsonBody(req, 10_000)) as { sessionId?: unknown; uid?: unknown } | null
      const row = typeof b?.sessionId === 'string' ? rt.rows.get(b.sessionId) : undefined
      if (!row || typeof b?.uid !== 'number') throw new Error('need a session of this workspace and a uid')
      body = { ok: true, ...(await describePicked({ hub: browserHub, shots: rt.shots, sessionId: row.id, projectRoot: row.cwd }, b.uid)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }

  // --- providers: the agents this workspace is connected to ------------------
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    let body: ProvidersStatusResponse
    try {
      body = { ok: true, providers: await readProviderStatus(rt, url.searchParams.get('refresh') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // Connect, disconnect, or change how one agent signs in here. The primary
  // can't be disconnected, and its auth is the workspace's own.
  if (url.pathname === '/api/providers' && req.method === 'PUT') {
    let body: WorkspaceResponse
    try {
      const provider = url.searchParams.get('provider')
      if (!isProviderId(provider)) throw new Error(`unknown provider: ${provider}`)
      const raw = (await readJsonBody(req)) as { connected?: unknown; authBackend?: unknown; apiKey?: unknown } | null
      const authBackend = raw?.authBackend === undefined ? undefined : toAuthBackend(raw.authBackend)
      if (raw?.authBackend !== undefined && !authBackend) throw new Error('authBackend must be inherit, api-key or config-dir')
      const apiKey = typeof raw?.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined
      const meta = rt.meta
      // The key first: a key the agent refuses fails the save before anything changes.
      if (apiKey) await saveProviderKey(meta, provider, apiKey)
      if (provider === meta.provider) {
        if (raw?.connected === false) throw new Error(`${providerFor(provider).label} runs this workspace's jobs and briefs — it can't be disconnected`)
        const changed = (authBackend && authBackend !== meta.authBackend) || apiKey !== undefined
        if (authBackend) meta.authBackend = authBackend
        saveRegistry(registry)
        if (changed) applyAuthChange(rt)
      } else {
        const was = meta.connections?.[provider]?.authBackend
        if (raw?.connected === false) {
          const { [provider]: _gone, ...rest } = meta.connections ?? {}
          meta.connections = rest
        } else {
          const next = authBackend ?? was ?? 'inherit'
          meta.connections = { ...(meta.connections ?? {}), [provider]: { authBackend: next } }
        }
        saveRegistry(registry)
        if (was !== meta.connections?.[provider]?.authBackend || apiKey !== undefined) applyProviderChange(rt, provider)
      }
      body = { ok: true, workspace: wireWorkspace(meta) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // One real round-trip with a provider's auth here — the account read can't
  // tell a revoked key from a good one for every backend; a turn can.
  if (url.pathname === '/api/providers/verify' && req.method === 'POST') {
    let body: ProviderVerifyResponse
    try {
      const provider = url.searchParams.get('provider')
      if (!isProviderId(provider)) throw new Error(`unknown provider: ${provider}`)
      if (!isConnected(rt.meta, provider)) throw new Error(`${providerFor(provider).label} isn't connected in this workspace`)
      const auth = await providerFor(provider).checkAuth(rt.envFor(provider))
      rt.providerStatus = null
      body = { ok: true, authOk: auth.ok, ...(auth.error ? { authError: auth.error } : {}) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }

  if (url.pathname === '/api/sessions') {
    json(200, summaries(rt))
    return
  }

  // The tail of a background shell's output — polled by the chat while it runs.
  {
    const m = /^\/api\/sessions\/([^/]+)\/shells\/([^/]+)\/output$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      let body: ShellOutputResponse
      try {
        body = await shellOutput((id) => rt.store.events.read(id), decodeURIComponent(m[1]), decodeURIComponent(m[2]))
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 404, body)
      return
    }
  }

  // What this session changed, and one file's patch. Session-scoped on
  // purpose: the question is "what did this agent do", not "what is dirty".
  {
    const m = /^\/api\/sessions\/([^/]+)\/(changes|diff)$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const row = rt.rows.get(m[1]) ?? (await rt.store.sessions.get(m[1]))
      if (!row) {
        json(404, { ok: false, error: 'no such session' })
        return
      }
      if (m[2] === 'changes') {
        let body: SessionChangesResponse
        try {
          body = { ok: true, changes: await computeSessionChanges(rt, row) }
        } catch (err) {
          body = { ok: false, error: errText(err) }
        }
        json(body.ok ? 200 : 500, body)
        return
      }
      const file = url.searchParams.get('path') ?? ''
      let body: SessionDiffResponse
      try {
        if (!file) throw new Error('need a path')
        const got = await sessionFilePatch(rt, row, file)
        if (!got) throw new Error('no snapshots for this session')
        body = { ok: true, path: file, patch: got.patch, isBinary: got.patch.includes('Binary files'), truncated: got.truncated }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
  }

  // The Changes rail: every project's uncommitted files, one file's patch, and
  // reading/saving a changed file. Project-scoped, the complement of the
  // session view above: "what is dirty", whoever made it.
  if (url.pathname === '/api/changes' && req.method === 'GET') {
    let body: WorkingChangesResponse
    try {
      // The poll is also when worktrees made elsewhere, or deleted, are noticed.
      await syncCheckouts(rt)
      const projects = await rt.store.projects.list()
      body = { ok: true, projects: await Promise.all(projects.map((p) => projectChanges(rt, p))) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  if (url.pathname === '/api/changes/diff' || url.pathname === '/api/changes/file') {
    // `projectId=` is the pre-checkout form: that project's main folder.
    const checkout = checkoutById(rt, url.searchParams.get('checkoutId') ?? url.searchParams.get('projectId'))
    const project = checkout && (await rt.store.projects.list()).find((p) => p.id === checkout.projectId)
    const file = url.searchParams.get('path') ?? ''
    if (!checkout || !project || !file) {
      json(400, { ok: false, error: checkout && project ? 'need a path' : 'unknown checkout' })
      return
    }
    if (url.pathname === '/api/changes/diff' && req.method === 'GET') {
      let body: WorkingDiffResponse
      try {
        const got = await worktreePatch(checkout.path, file)
        body = { ok: true, path: file, patch: got.patch, isBinary: got.patch.includes('Binary files'), truncated: got.truncated }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
    if (url.pathname === '/api/changes/file' && req.method === 'GET') {
      let body: ProjectFileResponse
      try {
        body = await readProjectFile(checkout.path, file)
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
    if (url.pathname === '/api/changes/file' && req.method === 'PUT') {
      // A write to disk: any page in the browser can POST to localhost, so
      // only our own origin gets to do it.
      if (!sameOrigin(req, access)) {
        json(403, { ok: false, error: 'cross-origin writes are not accepted' })
        return
      }
      let body: SaveProjectFileResponse
      try {
        const parsed = (await readJsonBody(req, 4_000_000)) as { content?: unknown; version?: unknown } | null
        if (typeof parsed?.content !== 'string' || typeof parsed.version !== 'string') {
          throw new Error('need content and the version it was edited from')
        }
        body = await writeProjectFile(checkout.path, file, parsed.content, parsed.version)
        if (body.ok) log('info', 'changes', `saved ${file}`, { project: project.name, checkout: checkout.branch ?? checkout.path, workspace: rt.meta.id })
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : body.conflict ? 409 : 400, body)
      return
    }
  }

  // "Open in…": the editors on this Mac, and opening a checkout's folder in one.
  if (url.pathname === '/api/editors' && req.method === 'GET') {
    let body: EditorsResponse
    try {
      body = { ok: true, editors: access === 'local' ? await detectEditors() : [] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // Bringing a removed worktree back, at the same folder, so its sessions resume.
  const recreateMatch = /^\/api\/checkouts\/([^/]+)\/recreate$/.exec(url.pathname)
  if (recreateMatch && req.method === 'POST') {
    if (!sameOrigin(req, access)) {
      json(403, { ok: false, error: 'cross-origin requests are not accepted' })
      return
    }
    let body: OpenCheckoutResponse
    try {
      const checkout = checkoutById(rt, decodeURIComponent(recreateMatch[1]))
      if (!checkout || checkout.kind !== 'worktree') throw new Error('no such worktree')
      if (checkout.state !== 'removed') throw new Error('that worktree is still there')
      const project = (await rt.store.projects.list()).find((p) => p.id === checkout.projectId)
      if (!project) throw new Error('its project is gone')
      await recreateWorktree(checkout, project)
      const notes = await prepareWorktree(project.path, checkout.path)
      await syncCheckouts(rt)
      log('info', 'checkouts', `recreated worktree ${checkout.branch ?? checkout.path}`, {
        workspace: rt.meta.id,
        ...(notes.length ? { notes: notes.join('; ') } : {}),
      })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }

  // Removing a worktree: what it would lose (asked first), then the removal itself.
  const removalMatch = /^\/api\/checkouts\/([^/]+)\/(removal|remove)$/.exec(url.pathname)
  if (removalMatch) {
    const checkout = checkoutById(rt, decodeURIComponent(removalMatch[1]))
    const main = mainCheckout(rt, checkout?.projectId)
    if (!checkout || checkout.kind !== 'worktree' || checkout.state !== 'active' || !main) {
      json(404, { ok: false, error: checkout?.kind === 'main' ? "the main folder is yours — triage doesn't remove it" : 'no such worktree' })
      return
    }
    if (removalMatch[2] === 'removal' && req.method === 'GET') {
      let body: RemovalCheckResponse
      try {
        body = { ok: true, check: await checkRemoval(checkout, main.path, runningIn(rt, checkout.id)) }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 500, body)
      return
    }
    if (removalMatch[2] === 'remove' && req.method === 'POST') {
      if (!sameOrigin(req, access)) {
        json(403, { ok: false, error: 'cross-origin requests are not accepted' })
        return
      }
      let body: RemoveCheckoutResponse
      try {
        const parsed = (await readJsonBody(req)) as { force?: unknown; deleteBranch?: unknown } | null
        const force = parsed?.force === true
        const check = await checkRemoval(checkout, main.path, runningIn(rt, checkout.id))
        if (!check.safe && !force) {
          body = { ok: false, error: 'this worktree has work that would be lost', check }
        } else {
          // Its sessions keep their transcripts; their subprocesses can't outlive the folder.
          for (const r of rt.rows.values()) {
            if (r.checkoutId !== checkout.id || !rt.live.has(r.id)) continue
            rt.live.get(r.id)?.stop()
            rt.live.delete(r.id)
          }
          const notes = await removeWorktree(checkout, { force, deleteBranch: parsed?.deleteBranch !== false, merged: check.unmerged === 0 })
          await syncCheckouts(rt)
          broadcastSessionList(rt)
          log('info', 'checkouts', `removed worktree ${checkout.branch ?? checkout.path}${force ? ' (forced)' : ''}`, {
            workspace: rt.meta.id,
            ...(notes.length ? { notes: notes.join('; ') } : {}),
          })
          body = { ok: true }
        }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return
    }
  }

  const openMatch = /^\/api\/checkouts\/([^/]+)\/open$/.exec(url.pathname)
  if (openMatch && req.method === 'POST') {
    let body: OpenCheckoutResponse
    if (access !== 'local') {
      // The editor would open on the Mac's screen, not the phone asking for it.
      body = { ok: false, error: 'editors open on the Mac — use it there' }
    } else if (!sameOrigin(req, access)) {
      json(403, { ok: false, error: 'cross-origin requests are not accepted' })
      return
    } else {
      try {
        const checkout = checkoutById(rt, decodeURIComponent(openMatch[1]))
        if (!checkout || checkout.state !== 'active') throw new Error('that checkout is gone')
        const parsed = (await readJsonBody(req)) as { editor?: unknown } | null
        const editor = typeof parsed?.editor === 'string' ? parsed.editor : ''
        if (!editor) throw new Error('need an editor')
        await openFolderIn(checkout.path, editor)
        body = { ok: true }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return
  }

  // The composer's `@` picker: fuzzy file matches under one folder.
  if (url.pathname === '/api/files/search' && req.method === 'GET') {
    const root = expandHome(url.searchParams.get('root') ?? '')
    const q = url.searchParams.get('q') ?? ''
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 200)
    let body: FileSearchResponse
    if (!(await isSearchableRoot(rt, root))) {
      body = { ok: false, error: 'not a folder triage can list (a session folder, a project, or under your home)' }
    } else {
      try {
        body = { ok: true, root, ...(await rt.files.get(root).search(q, limit)) }
      } catch (err) {
        body = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/inbox') {
    let body: InboxResponse
    try {
      const snap = await getInbox(rt, url.searchParams.get('refresh') === '1')
      body = { ok: true, ...snap }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/repos') {
    let body: ReposResponse
    try {
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { repos?: unknown } | null
        const repos = Array.isArray(parsed?.repos)
          ? parsed.repos.filter((r): r is string => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))
          : []
        await rt.store.config.set(REPOS_KEY, repos)
        invalidateInbox(rt) // scope changed — force a resync on the next view
      }
      body = { ok: true, connected: await connectedRepos(rt), available: await affiliatedRepos(rt) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/projects') {
    let body: ProjectsResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = (await readJsonBody(req)) as Partial<Project> | null
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
        const repo = typeof parsed?.repo === 'string' ? parsed.repo.trim() : ''
        const rawPath = typeof parsed?.path === 'string' ? parsed.path.trim() : ''
        const makeDefault = (parsed as { makeDefault?: unknown } | null)?.makeDefault === true
        const id = typeof parsed?.id === 'string' ? parsed.id : ''
        const atFolder = rawPath
          ? (await rt.store.projects.list()).find((p) => path.resolve(p.path) === path.resolve(expandHome(rawPath)))
          : undefined
        if (makeDefault && (id || atFolder) && (!rawPath || atFolder)) {
          // Replace the default: the one way to move it, since it can't be deleted.
          // Onboarding names a folder; one that is already a project just becomes the default.
          await rt.store.projects.setDefault(atFolder?.id ?? id)
        } else {
          if (!name || !rawPath) throw new Error('a project needs a name and a folder')
          if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`)
          const project = await addProject(rt, rawPath, name, repo)
          if (makeDefault && !project.isDefault) await rt.store.projects.setDefault(project.id)
        }
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          await rt.store.projects.remove(id)
          await rt.store.checkouts.removeForProject(id)
          for (const c of checkoutList(rt)) if (c.projectId === id) rt.checkouts.delete(c.id)
          broadcast(rt, { type: 'checkouts', checkouts: checkoutList(rt) })
          // Its jobs pause with a visible reason — never run somewhere else (job-spec.md, item 2).
          for (const w of await rt.store.jobs.list()) {
            if (w.projectId !== id) continue
            await rt.store.jobs.patchState(w.id, { enabled: false, configError: 'project removed — pick another project for this job' })
            log('info', 'job', `paused "${w.title}": its project was removed`, { jobId: w.id, workspace: rt.meta.id })
          }
        }
      }
      body = { ok: true, projects: await rt.store.projects.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
    if (access !== 'local') {
      // The chooser would open on the Mac's screen, not the phone asking for it.
      json(200, { ok: false, error: 'the folder picker opens on the Mac — type the folder path instead' } satisfies PickFolderResponse)
      return
    }
    let body: PickFolderResponse
    try {
      const picked = await pickNativeFolder()
      body = picked ? { ok: true, path: picked } : { ok: true, cancelled: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  if (url.pathname === '/api/jobs') {
    let body: JobsResponse
    let status = 200
    try {
      // Jobs are files: create and edit write `jobs/<name>.md`, then sync
      // the row from it — the same path a hand edit takes.
      if (req.method === 'POST') {
        const parsed = jobPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        const p = parsed.patch
        if (!p.title || !p.instruction || !p.tools?.length) {
          throw new Error('a job needs a title, instructions, and at least one integration')
        }
        if (!p.projectId) throw new Error('pick the project this job runs in')
        if (!(await rt.store.projects.list()).some((pr) => pr.id === p.projectId)) throw new Error('unknown project')
        // Schedule is the source of truth; accept a legacy cadence as a fallback.
        const schedule = p.schedule ?? (p.cadence ? cronFromCadence(p.cadence, p.windowStart, p.windowDay) : '0 9 * * *')
        const spec: JobFileSpec = {
          id: randomUUID(),
          title: p.title,
          schedule,
          project: p.projectId,
          tools: p.tools,
          ...(p.model ? { model: p.model } : {}),
          output: p.output ?? 'items',
          ...(p.catchUpWindow ? { catchUp: p.catchUpWindow } : {}),
          ...(p.timeoutMs != null ? { timeoutMs: p.timeoutMs } : {}),
          ...(p.maxBudgetUsd != null ? { budgetUsd: p.maxBudgetUsd } : {}),
          ...(p.dailyBudgetUsd != null ? { dailyBudgetUsd: p.dailyBudgetUsd } : {}),
          notify: p.notify ?? 'on_failure',
          enabled: p.enabled ?? true,
          ...(p.brief ? { brief: p.brief } : {}),
          instruction: p.instruction,
        }
        const name = rt.jobFiles.freeName(p.title)
        await rt.jobFiles.write(name, spec)
        // "Run once now" off: the first run waits for the next slot.
        await syncJobFiles(rt, { force: true, ...(p.runOnceNow === false ? { deferFirstRun: spec.id } : {}) })
        log('info', 'job', `created: ${p.title} (jobs/${name}.md)`, { tools: p.tools.map(grantLabel), schedule, workspace: rt.meta.id })
        // active on the next scheduler tick (never run → due immediately, unless runOnceNow was off)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.jobs.get(id) : null
        if (!id || !existing) throw new Error('unknown job id')
        const parsed = jobPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        if (parsed.patch.projectId && !(await rt.store.projects.list()).some((pr) => pr.id === parsed.patch.projectId)) {
          throw new Error('unknown project')
        }
        const { runOnceNow: _ignored, ...patch } = parsed.patch
        // The on/off switch edits only the `enabled:` line, so a hand-kept file stays as written.
        const onlyToggle = Object.keys(patch).every((k) => k === 'enabled') && patch.enabled !== undefined
        // A legacy row gets its first file here — saving it is the way across.
        const name = existing.file ?? rt.jobFiles.freeName(patch.title ?? existing.title)
        const merged = { ...existing, ...patch } as Job
        if (patch.schedule) merged.schedule = patch.schedule
        if (onlyToggle && existing.file) await rt.jobFiles.setEnabled(existing.file, patch.enabled!)
        else await rt.jobFiles.write(name, jobSpecFrom(merged))
        await syncJobFiles(rt, { force: true })
        const after = await rt.store.jobs.get(id)
        if (patch.enabled === true && after?.configError) throw new Error(after.configError)
        log('info', 'job', `updated: ${merged.title} (jobs/${name}.md)`, { jobId: id, workspace: rt.meta.id })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.jobs.get(id) : null
        if (id && existing) {
          if (existing.file) await rt.jobFiles.remove(existing.file)
          await deleteJob(rt, id, 'deleted by the user')
        }
      } else {
        await syncJobFiles(rt)
      }
      body = { ok: true, jobs: await rt.store.jobs.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  // Dry run of the form's current state (.docs/jobs.md "Preview step"):
  // POST starts it and hands back an ephemeral session id to subscribe to for
  // the live transcript; GET polls its outcome. Nothing is written anywhere.
  if (url.pathname === '/api/jobs/preview' && req.method === 'POST') {
    let body: JobPreviewStartResponse
    try {
      const parsed = jobPatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.instruction || !p.tools?.length) throw new Error('a preview needs instructions and at least one integration')
      if (!p.projectId) throw new Error('pick the project this job runs in')
      const previewId = startJobPreview(rt, {
        instruction: p.instruction,
        tools: p.tools,
        projectId: p.projectId,
        model: p.model,
        output: p.output ?? 'items',
        schedule: p.schedule ?? '0 9 * * *',
      })
      body = { ok: true, previewId }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/jobs/preview' && req.method === 'GET') {
    const pv = rt.previews.get(url.searchParams.get('id') ?? '')
    const body: JobPreviewStatusResponse = pv
      ? { ok: true, status: pv.status, ...(pv.result ? { result: pv.result } : {}), ...(pv.error ? { error: pv.error } : {}) }
      : { ok: false, error: 'unknown or expired preview' }
    json(body.ok ? 200 : 404, body)
    return
  }
  // MCP draft_job over HTTP (the stdio shim and POST /mcp): saved off, a draft.
  if (url.pathname === '/api/jobs/drafted' && req.method === 'POST') {
    let body: { ok: true; text: string; id: string } | { ok: false; error: string }
    try {
      const d = await draftJobOp(rt, await readJsonBody(req))
      body = { ok: true, text: draftJobText(d), id: d.id }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/jobs/draft' && req.method === 'POST') {
    let body: JobDraftResponse
    try {
      const parsed = (await readJsonBody(req)) as { text?: unknown } | null
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (!text) throw new Error('describe the job in plain text first')
      const draft = await draftJob(rt.provider, text, undefined, rt.env)
      if (!draft) throw new Error('could not parse that into a job — fill the form manually')
      body = { ok: true, draft }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/items/state' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; status?: unknown; snoozeUntil?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const statusV = parsed?.status as ItemStatus
      if (!ANY_ITEM_ID_RE.test(id) || !ITEM_STATUSES.has(statusV)) {
        throw new Error('need an item id and a status (open|done|snoozed|archived)')
      }
      const snoozeUntil = typeof parsed?.snoozeUntil === 'number' ? parsed.snoozeUntil : undefined
      if (statusV === 'snoozed' && !snoozeUntil) throw new Error('snoozed needs snoozeUntil (epoch ms)')
      // A recorded transition on the durable item — never a delete (.docs/jobs-v2.md).
      await rt.store.items.transition(id, { status: statusV, actor: 'user', snoozeUntil })
      invalidateInbox(rt)
      log('info', 'inbox', `${statusV}: ${id} (by user)`, { id, status: statusV, actor: 'user', workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Ranked items in a status tab other than the open inbox (done/snoozed/archived).
  if (url.pathname === '/api/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const s = url.searchParams.get('status')
      const status: ItemStatus = ITEM_STATUSES.has(s as ItemStatus) ? (s as ItemStatus) : 'open'
      body = { ok: true, items: await listItemsByStatus(rt, status) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // One item, whole and unfiltered — what the MCP tool get_work_item reads,
  // and what the stdio shim reaches for over HTTP.
  if (url.pathname === '/api/items/detail' && req.method === 'GET') {
    let body: ItemDetailResponse
    try {
      body = { ok: true, detail: await itemDetailOp(rt, url.searchParams.get('id') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // What a session may know about itself: its workspace, its work item, its notes.
  if (url.pathname === '/api/sessions/context' && req.method === 'GET') {
    let body: SessionContextResponse
    try {
      body = { ok: true, context: await sessionContextOp(rt, url.searchParams.get('id') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // The append-only transition log for one item (its timeline).
  if (url.pathname === '/api/items/events' && req.method === 'GET') {
    let body: ItemEventsResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, events: await rt.store.items.events(id) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Activity: job runs (each a session) as a browsable history, newest first.
  if (url.pathname === '/api/activity' && req.method === 'GET') {
    let body: ActivityResponse
    try {
      const jobId = url.searchParams.get('jobId')
      const titles = new Map((await rt.store.jobs.list()).map((w) => [w.id, w.title]))
      const runs = [...rt.rows.values()]
        .filter((r) => r.kind === 'job-run' && (!jobId || r.jobId === jobId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((r) => ({
          sessionId: r.id,
          ...(r.jobId ? { jobId: r.jobId } : {}),
          jobTitle: (r.jobId && titles.get(r.jobId)) || r.title.replace(/^Job · /, ''),
          status: r.runStatus,
          ...(r.runTrigger ? { trigger: r.runTrigger } : {}),
          matches: r.runMatches,
          ...(r.runNew != null ? { newCount: r.runNew } : {}),
          tokens: r.runTokens,
          ...(r.runCostUsd != null ? { costUsd: r.runCostUsd } : {}),
          startedAt: r.createdAt,
          finishedAt: r.updatedAt,
          ...(r.runError ? { error: r.runError } : {}),
        }))
      body = { ok: true, runs }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // Every item a job has ever filed, any status — the job page's Items tab.
  if (url.pathname === '/api/jobs/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => it.jobId === id || (it.foundBy ?? []).some((p) => p.jobId === id))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The job file editor: GET the text (an existing job's file, a legacy
  // row rendered as one, or a starter) plus a reference list; POST saves it.
  if (url.pathname === '/api/jobs/file') {
    let body: JobFileResponse
    let status = 200
    try {
      const id = url.searchParams.get('id')
      const projects = await rt.store.projects.list()
      if (req.method === 'GET') {
        const w = id ? await rt.store.jobs.get(id) : null
        if (id && !w) {
          status = 404
          throw new Error('unknown job id')
        }
        let text = starterJobFile(projects)
        if (w?.file) text = await readFile(rt.jobFiles.pathOf(w.file), 'utf8').catch(() => serializeJobFile(jobSpecFrom(w)))
        else if (w) text = serializeJobFile(jobSpecFrom(w))
        body = { ok: true, text, ...(w?.file ? { file: `jobs/${w.file}.md` } : {}), reference: jobFileReference(rt, projects, await jobLibrary(rt)) }
      } else if (req.method === 'POST') {
        const raw = (await readJsonBody(req)) as { text?: unknown }
        if (typeof raw?.text !== 'string') throw new Error('text must be a string')
        const saved = await saveJobText(rt, id, raw.text)
        body = 'errors' in saved ? { ok: false, error: 'the file has problems', errors: saved.errors } : { ok: true, id: saved.id }
      } else {
        status = 405
        throw new Error('GET or POST')
      }
    } catch (err) {
      if (status === 200) status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(status, body)
    return
  }
  // The slot ledger for one job — the job page's Runs table.
  if (url.pathname === '/api/jobs/runs' && req.method === 'GET') {
    let body: JobRunsResponse
    let status = 200
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!(await rt.store.jobs.get(id))) {
        status = 404
        throw new Error('unknown job id')
      }
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      body = { ok: true, runs: await rt.store.jobRuns.list(id, limit) }
    } catch (err) {
      if (status === 200) status = 502
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(status, body)
    return
  }
  // The items one run produced (provenance runId === sessionId).
  if (url.pathname === '/api/activity/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const runId = url.searchParams.get('runId') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => (it.foundBy ?? []).some((p) => p.runId === runId))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // Force-run one job now (the per-job Run button). The run appears under
  // Activity; scheduled cadence runs continue on their own.
  if (url.pathname === '/api/jobs/run' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const w = await rt.store.jobs.get(id)
      if (!w) throw new Error('unknown job id')
      if (w.configError) throw new Error(w.configError)
      enqueueJob(rt, id)
      log('info', 'job', `run requested: ${w.title}`, { jobId: id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Daemon status for the System modal (is it up, ticking, connected?).
  if (url.pathname === '/api/system' && req.method === 'GET') {
    let body: SystemResponse
    try {
      body = { ok: true, status: await systemStatus(rt) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The daemon's recent activity log (filterable by level / subsystem / text).
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const level = url.searchParams.get('level')
    const body: LogsResponse = {
      ok: true,
      entries: recentLogs({
        level: (level as LogLevel) || undefined,
        subsystem: url.searchParams.get('subsystem') || undefined,
        q: url.searchParams.get('q') || undefined,
      }),
      subsystems: logSubsystems(),
    }
    json(200, body)
    return
  }
  // What Claude Code has spent on this machine, read from its own transcripts.
  // Machine-wide on purpose: a session started in a terminal costs the same
  // money as one started here, and the user asked what they are spending.
  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const asked = Number(url.searchParams.get('days'))
    const days = USAGE_WINDOWS.includes(asked as (typeof USAGE_WINDOWS)[number]) ? asked : 30
    const now = Date.now()
    // From the start of the day `days - 1` ago, so "7 days" is seven columns.
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime() - (days - 1) * 86_400_000
    const began = Date.now()
    let body: UsageResponse
    try {
      const { entries, files, reread } = await scanUsage(claudeProjectRoots(), since)
      const usage = summarizeUsage(entries, since, now)
      usage.scan = { files, reread, ms: Date.now() - began }
      body = { ok: true, usage }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // What a set of sessions cost — the item page's per-item spend readout. The
  // caller names the sessions (it owns the item→session join); we map each to
  // the Claude session id captured at init and fold the ledger by that.
  if (url.pathname === '/api/usage/sessions' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200)
    const asked = Number(url.searchParams.get('days'))
    const days = USAGE_WINDOWS.includes(asked as (typeof USAGE_WINDOWS)[number]) ? asked : 30
    const now = Date.now()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime() - (days - 1) * 86_400_000

    let body: SessionsUsageResponse
    try {
      const bySession: Record<string, SessionSpend> = {}
      let models: UsageModelSlice[] = []
      const totals: SessionSpend & { sessions: number } = {
        cost: 0,
        tokens: 0,
        messages: 0,
        priced: true,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        sessions: 0,
      }
      if (ids.length > 0) {
        // Only the newest sdk_session_id survives a resume today, so a resumed
        // session's earlier spend is not reachable from here. Whatever is on
        // the row is what can be joined.
        const stored = await rt.store.sessions.list()
        const sdkIds = new Map<string, string>()
        for (const sess of stored) {
          if (ids.includes(sess.id) && sess.sdkSessionId) sdkIds.set(sess.id, sess.sdkSessionId)
        }
        if (sdkIds.size > 0) {
          const { entries } = await scanUsage(claudeProjectRoots(), since)
          const folded = summarizeBySession(entries)
          // The model split is over these sessions only, not the machine.
          const wanted = new Set(sdkIds.values())
          models = summarizeModels(entries.filter((e) => wanted.has(e.sessionId)))
          for (const [id, sdkId] of sdkIds) {
            const row = folded.get(sdkId)
            if (!row) continue
            bySession[id] = row
            totals.cost += row.cost
            totals.tokens += row.tokens
            totals.messages += row.messages
            totals.input += row.input
            totals.output += row.output
            totals.cacheWrite += row.cacheWrite
            totals.cacheRead += row.cacheRead
            if (!row.priced) totals.priced = false
            if (row.subagents) {
              const sub = (totals.subagents ??= { cost: 0, messages: 0 })
              sub.cost += row.subagents.cost
              sub.messages += row.subagents.messages
            }
            totals.sessions++
          }
        }
      }
      body = { ok: true, usage: { days, bySession, models, totals } }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // Manual "scan now": force every due (and overdue) job to run and refresh GitHub.
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      void reconcileGitHub(rt, true).then(() => {
        invalidateInbox(rt)
        void syncInbox(rt)
      })
      void (async () => {
        // "Scan now": every enabled job, now, as a manual run.
        if (!(await jobsEnabled(rt))) return
        for (const w of await rt.store.jobs.list()) if (w.enabled && !w.configError) enqueueJob(rt, w.id)
      })()
      log('info', 'scheduler', 'manual scan requested (all jobs + GitHub)', { workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The ingestion contract (.docs/jobs.md): idempotent upsert + resolve,
  // shared by external scanners over HTTP and the MCP shim (server/mcp.ts).
  // User state is never written by upsert; resolve is a normal 'done'.
  if (url.pathname === '/api/items/upsert' && req.method === 'POST') {
    let body: UpsertResponse
    try {
      const outcome = await upsertItemOp(rt, await readJsonBody(req))
      body = { ok: true, outcome }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/items/resolve' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      await resolveItemOp(rt, parsed?.id)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Manual items — to-dos the user adds by hand. Create/edit/delete; they merge
  // into the inbox like any other source and share the done/snooze overlay.
  if (url.pathname === '/api/items/manual') {
    let body: ManualItemResponse
    let status = 200
    let id: string | undefined
    try {
      if (req.method === 'POST') {
        id = await createManualOp(rt, await readJsonBody(req, MAX_ITEM_BODY_BYTES))
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id) throw new Error('need a manual item id')
        await editManualOp(rt, id, await readJsonBody(req, MAX_ITEM_BODY_BYTES))
      } else if (req.method === 'DELETE') {
        // Never hard-delete (.docs/jobs-v2.md): "delete" archives the item,
        // recorded, so it survives in the Archived tab.
        const id = url.searchParams.get('id')
        if (id) {
          await rt.store.items.transition(id, { status: 'archived', actor: 'user', detail: { reason: 'deleted by user' } })
          invalidateInbox(rt)
        }
      } else {
        throw new Error('unsupported method')
      }
      body = id ? { ok: true, id } : { ok: true }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  // The user's stage/turn override (core/work/flow.ts), for what the rules can't see.
  if (url.pathname === '/api/items/flow' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      await setFlowOverrideOp(rt, await readJsonBody(req), 'user')
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // A user priority override for any item (source or manual). null clears it.
  if (url.pathname === '/api/items/priority' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; priority?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!id) throw new Error('need an item id')
      const raw = parsed?.priority
      let priority: number | null
      if (raw === null || raw === 0 || raw === undefined) priority = null
      else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 4) priority = raw
      else throw new Error('priority must be 1–4, or null/0 to clear')
      await rt.store.items.setPriority(id, priority)
      invalidateInbox(rt)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // A due set from the inbox (t / m / w / l or the date picker): a bucket or an
  // exact day, resolved to a day here. `due: null` goes back to the label's default.
  if (url.pathname === '/api/items/due' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; due?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!id) throw new Error('need an item id')
      const due = dueInput(parsed?.due, Date.now())
      if (due === undefined) throw new Error('need due: a YYYY-MM-DD day, a section name, or null')
      await rt.store.items.setDue(id, due)
      invalidateInbox(rt)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/models') {
    // ?provider= names the agent whose list to read; absent = the workspace's.
    const asked = url.searchParams.get('provider')
    if (asked !== null && !isProviderId(asked)) {
      json(400, { ok: false, error: `unknown provider: ${asked}` } satisfies ModelsResponse)
      return
    }
    const provider = asked ?? rt.meta.provider
    let body: ModelsResponse
    try {
      const cached = url.searchParams.get('refresh') === '1' ? undefined : rt.modelCache.get(provider)
      const probe = cached ?? (await probeModels(rt, provider))
      body = { ok: true, probedAt: probe.probedAt, models: probe.models }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/commands') {
    let body: CommandsResponse
    try {
      const cwd = expandHome(url.searchParams.get('cwd') ?? os.homedir())
      const cached = url.searchParams.get('refresh') === '1' ? null : rt.commandCache.get(cwd)
      const probe = cached ?? (await probeCommands(rt, cwd))
      body = { ok: true, cwd, probedAt: probe.probedAt, commands: usableCommands(rt, probe.commands) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/connectors') {
    let body: ConnectorsResponse
    try {
      const refresh = url.searchParams.get('refresh') === '1'
      const projectId = url.searchParams.get('projectId')
      if (projectId) {
        // The job picker: what a run in this project's folder can load.
        const project = (await rt.store.projects.list()).find((p) => p.id === projectId)
        if (!project) throw new Error('unknown project')
        const cached = rt.folderProbes.get(project.path)
        const probe = cached && !refresh && Date.now() - cached.probedAt < FOLDER_PROBE_TTL_MS ? cached : await probeConnectors(rt, project.path)
        // the run's own server shadows any user server named triage — never offer it
        const connectors = probe.connectors.filter((c) => c.server !== RESERVED_SERVER)
        body = { ok: true, probedAt: probe.probedAt, connectors, cwd: project.path, elsewhere: await localServersElsewhere(rt, project.path, connectors) }
      } else {
        const probe = rt.connectorCache && !refresh ? rt.connectorCache : await probeConnectors(rt)
        if (refresh) rt.folderProbes.clear()
        body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
      }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // --- settings, briefs, playbooks, dispatch (.docs/next-version.md, phase 2) ---
  // Junior (.docs/junior-goals-teams): the persona, the page's day, today's plan.
  if (url.pathname === '/api/persona') {
    let body: PersonaResponse
    try {
      if (req.method === 'GET') body = { ok: true, persona: rt.persona, you: await userFirstName() }
      else if (req.method === 'PUT') body = { ok: true, persona: await savePersonaOp(rt, await readJsonBody(req, 10_000)) }
      else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/junior' && req.method === 'GET') {
    let body: JuniorDayResponse
    try {
      body = { ok: true, day: await juniorDayOp(rt, { since: Number(url.searchParams.get('since')), away: url.searchParams.get('away') === '1' }) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/today/match' && req.method === 'GET') {
    let body: TodayMatchResponse
    try {
      body = { ok: true, match: await matchTodayOp(rt, (url.searchParams.get('q') ?? '').slice(0, 300)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/today' || url.pathname.startsWith('/api/today/')) {
    let body: TodayResponse
    try {
      if (url.pathname === '/api/today' && req.method === 'GET') body = { ok: true, plan: await todayView(rt, await ensureToday(rt)) }
      else if (req.method !== 'POST') throw new Error('method not allowed')
      else if (url.pathname === '/api/today/open') {
        const raw = (await readJsonBody(req, 1_000).catch(() => null)) as { force?: unknown } | null
        body = { ok: true, plan: await openTodayOp(rt, { force: raw?.force === true }) }
      } else if (url.pathname === '/api/today/add') {
        const raw = (await readJsonBody(req, 10_000)) as { by?: unknown } | null
        body = { ok: true, plan: (await addToTodayOp(rt, raw, raw?.by === 'junior' ? 'junior' : 'you')).plan }
      } else if (url.pathname === '/api/today/remove') body = { ok: true, plan: (await removeFromTodayOp(rt, await readJsonBody(req, 10_000))).plan }
      else throw new Error('unknown route')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/settings') {
    let body: SettingsResponse
    try {
      if (req.method === 'GET') body = { ok: true, settings: await readSettings(rt) }
      else if (req.method === 'PUT') body = { ok: true, settings: await writeSettings(rt, await readJsonBody(req)) }
      else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/playbooks') {
    const kind = url.searchParams.get('kind')
    try {
      if (req.method === 'GET' && !kind) {
        const body: PlaybooksResponse = { ok: true, playbooks: await listPlaybooks(rt.playbookDir) }
        json(200, body)
      } else if (req.method === 'GET' && kind) {
        const p = await readPlaybook(rt.playbookDir, kind)
        const body: PlaybookResponse = { ok: true, kind, body: p.body, custom: p.custom, path: p.path }
        json(200, body)
      } else if (req.method === 'PUT' && kind) {
        const parsed = (await readJsonBody(req)) as { body?: unknown } | null
        if (typeof parsed?.body !== 'string') throw new Error('need a markdown body')
        await writePlaybook(rt.playbookDir, kind, parsed.body)
        const p = await readPlaybook(rt.playbookDir, kind)
        const body: PlaybookResponse = { ok: true, kind, body: p.body, custom: p.custom, path: p.path }
        json(200, body)
      } else throw new Error('need ?kind= (GET or PUT)')
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/dispatch/template') {
    const kind = url.searchParams.get('kind') ?? ''
    try {
      if (!isPlaybookName(kind)) throw new Error('need ?kind=')
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { body?: unknown } | null
        if (typeof parsed?.body !== 'string') throw new Error('need a template body')
        await writeDispatchTemplate(rt.dispatchDir, kind, parsed.body)
      }
      json(200, { ok: true, kind, body: await readDispatchTemplate(rt.dispatchDir, kind) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  // Skills and agents (server/library.ts): list, read, write, create, delete — then reload everywhere.
  if (url.pathname.startsWith('/api/library')) {
    const route = `${req.method} ${url.pathname}`
    try {
      const roots = await libraryRootsFor(rt)
      if (route === 'GET /api/library') {
        const kind = url.searchParams.get('kind')
        if (kind !== 'skill' && kind !== 'agent') throw new Error('need ?kind=skill or ?kind=agent')
        const body: LibraryListResponse = { ok: true, entries: await listLibrary(kind, roots), targets: libraryTargets(roots) }
        json(200, body)
      } else if (route === 'GET /api/library/file') {
        const body: LibraryFileResponse = { ok: true, ...(await readLibraryFile(url.searchParams.get('path'), roots)) }
        json(200, body)
      } else if (route === 'PUT /api/library/file') {
        const b = ((await readJsonBody(req, 1_000_000)) ?? {}) as { path?: unknown; text?: unknown }
        const loc = await writeLibraryFile(b.path, b.text, roots)
        reloadLibraryEverywhere(rt)
        const body: LibraryFileResponse = { ok: true, ...(await readLibraryFile(loc.file, roots)) }
        json(200, body)
      } else if (route === 'POST /api/library') {
        const made = await createLibraryEntry(await readJsonBody(req), roots)
        reloadLibraryEverywhere(rt)
        json(200, { ok: true, path: made.path })
      } else if (route === 'DELETE /api/library') {
        await removeLibraryItem(url.searchParams.get('path'), roots, path.join(TRIAGE_DIR, 'trash'), {
          fileOnly: url.searchParams.get('file') === '1',
        })
        reloadLibraryEverywhere(rt)
        json(200, { ok: true })
      } else if (route === 'POST /api/library/open') {
        const b = ((await readJsonBody(req)) ?? {}) as { path?: unknown }
        const loc = locateLibrary(b.path, roots)
        await openInEditor(loc.kind === 'skill' ? loc.item : path.dirname(loc.item))
        json(200, { ok: true })
      } else json(404, { ok: false, error: 'not found' })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  // Teams v2 (.docs/teams.md): the library, the dispatch picker, and a run's card and controls.
  if (url.pathname.startsWith('/api/teams')) {
    const route = `${req.method} ${url.pathname}`
    try {
      const lib = rt.teamLibrary
      if (route === 'GET /api/teams/library') {
        json(200, await teamLibraryOp(rt))
      } else if (route === 'GET /api/teams/picker') {
        json(200, await teamPickerOp(rt, url.searchParams.get('kind') ?? ''))
      } else if (route === 'POST /api/teams/plan') {
        json(200, { ok: true, sessionId: await planTeamOp(rt, await readJsonBody(req)) })
      } else if (route === 'PUT /api/teams/agent') {
        await saveAgentOp(rt, await readJsonBody(req))
        json(200, await teamLibraryOp(rt))
      } else if (route === 'DELETE /api/teams/agent' || route === 'DELETE /api/teams/team') {
        await lib.remove(url.pathname.endsWith('agent') ? 'agent' : 'team', url.searchParams.get('name') ?? '')
        json(200, await teamLibraryOp(rt))
      } else if (route === 'POST /api/teams/reset') {
        const b = ((await readJsonBody(req)) ?? {}) as { kind?: unknown; name?: unknown }
        if (!isLibraryName(b.name) || (b.kind !== 'agent' && b.kind !== 'team')) throw new Error('need a kind and a name')
        await lib.reset(b.kind, b.name)
        json(200, await teamLibraryOp(rt))
      } else if (route === 'GET /api/teams/run') {
        const body: TeamRunResponse = { ok: true, run: teamRunView(teamRunFrom(rt, { runId: url.searchParams.get('runId') })) }
        json(200, body)
      } else if (route === 'GET /api/teams/file') {
        const run = teamRunFrom(rt, { runId: url.searchParams.get('runId') })
        await syncRunFolder(rt, run)
        const file = runFileOf(rt, run, url.searchParams.get('path') ?? '')
        if (!file) throw new Error('not a file in this run’s folder')
        const body: TeamRunFileResponse = { ok: true, text: (await readFile(file, 'utf8')).slice(0, 400_000) }
        json(200, body)
      } else if (route === 'GET /api/teams/folder') {
        const run = teamRunFrom(rt, { runId: url.searchParams.get('runId') })
        await syncRunFolder(rt, run)
        const body: TeamRunFolderResponse = { ok: true, title: run.title, team: run.recipe.label, state: run.state, leadSessionId: run.leadSessionId, dir: runDirOf(rt, run), files: runFolderList(rt, run) }
        json(200, body)
      } else if (route === 'GET /api/teams/files') {
        const body: TeamRunFilesResponse = { ok: true, files: await teamRunFilesOp(rt, teamRunFrom(rt, { runId: url.searchParams.get('runId') })) }
        json(200, body)
      } else if (route === 'PUT /api/teams/card') {
        await editTeamCardOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'PUT /api/teams/fast') {
        await setTeamFastOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'PUT /api/teams/plan') {
        await editPlanOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/revision') {
        await settleRevisionOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/approve') {
        await approveTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/discard') {
        await discardTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/pause') {
        const run = teamRunFrom(rt, await readJsonBody(req))
        await withTeamRun(rt, run, async () => {
          if (run.state !== 'running' && run.state !== 'gate' && run.state !== 'waiting') throw new Error(`the run is ${run.state}`)
          await pauseTeamRunNow(rt, run, 'paused by you')
        })
        json(200, { ok: true })
      } else if (route === 'GET /api/teams/goals') {
        const body: TeamGoalsResponse = { ok: true, goals: teamGoalsOp(rt) }
        json(200, body)
      } else if (route === 'POST /api/teams/goal/answer' || route === 'POST /api/teams/goal/accept' || route === 'POST /api/teams/goal/reopen' || route === 'POST /api/teams/goal/wake') {
        await goalActionOp(rt, url.pathname.split('/').pop() as 'answer' | 'accept' | 'reopen' | 'wake', await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/resume') {
        await resumeTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/stop') {
        await stopTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/save-as') {
        const team = await saveRunAsTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true, team, library: await teamLibraryOp(rt) })
      } else if (route === 'POST /api/teams/open') {
        await openInEditor(lib.root)
        json(200, { ok: true })
      } else json(404, { ok: false, error: 'not found' })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/dispatch/preview' && req.method === 'GET') {
    let body: DispatchPreviewResponse
    try {
      body = { ok: true, preview: await dispatchPreviewOp(rt, url.searchParams.get('itemId') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/briefs' && req.method === 'GET') {
    const itemId = url.searchParams.get('itemId')
    try {
      if (itemId) {
        const body: BriefResponse = { ok: true, brief: await briefViewFor(rt, itemId) }
        json(200, body)
      } else {
        const body: BriefJobsResponse = { ok: true, jobs: await rt.store.briefs.latestPerItem() }
        json(200, body)
      }
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/briefs' && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      body = { ok: true, jobs: await enqueueBriefsOp(rt, await readJsonBody(req)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/briefs/iterate' && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      body = { ok: true, jobs: [await iterateBriefOp(rt, await readJsonBody(req))] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if ((url.pathname === '/api/briefs/cancel' || url.pathname === '/api/briefs/promote') && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      const parsed = (await readJsonBody(req)) as { jobId?: unknown } | null
      const jobId = typeof parsed?.jobId === 'string' ? parsed.jobId : ''
      const job = jobId ? await rt.store.briefs.get(jobId) : null
      if (!job || job.status !== 'queued') throw new Error('only a queued brief can be cancelled or moved')
      if (url.pathname.endsWith('/cancel')) {
        await finishBrief(rt, job.id, 'failed', 'cancelled before it ran')
      } else {
        // To the head of the line: older than the oldest queued job.
        const [first] = await rt.store.briefs.list('queued')
        await rt.store.briefs.update(job.id, { createdAt: (first?.createdAt ?? job.createdAt) - 1 })
      }
      body = { ok: true, jobs: [(await rt.store.briefs.get(job.id)) ?? job] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/items/description' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; description?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const d = parsed?.description
      if (d !== null && d !== undefined && typeof d !== 'string') throw new Error('description must be a string')
      if (typeof d === 'string' && d.length > 5000) throw new Error('description is too long (5000 chars max)')
      await rt.store.items.setDescription(id, typeof d === 'string' && d.trim() ? d.trim() : null)
      invalidateInbox(rt)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // The human's links on any item. The list sent is the complete desired set.
  if (url.pathname === '/api/items/urls' && req.method === 'POST') {
    let body: ItemUrlsResponse
    try {
      const parsed = (await readJsonBody(req)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const urls = itemUrls(parsed?.urls) ?? []
      await rt.store.items.setUrls(id, urls)
      invalidateInbox(rt)
      body = { ok: true, urls }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Screenshots on an item. The list sent is the complete desired set: refs
  // to keep plus new base64 uploads, reconciled against what is on disk.
  if (url.pathname === '/api/items/images' && req.method === 'POST') {
    let body: ItemImagesResponse
    try {
      const parsed = (await readJsonBody(req, MAX_ITEM_BODY_BYTES)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, images: await setItemImagesOp(rt, id, itemImageEdits(parsed ?? {}) ?? []) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // The bytes behind one ref (`itemImageUrl`). Ids are uuids and files are
  // never rewritten in place, so this is safe to cache hard.
  if (url.pathname === '/api/items/image' && req.method === 'GET') {
    const itemId = url.searchParams.get('item') ?? ''
    const imageId = url.searchParams.get('image') ?? ''
    const item = ANY_ITEM_ID_RE.test(itemId) ? await rt.store.items.get(itemId).catch(() => null) : null
    const image = item?.images?.find((i) => i.id === imageId)
    if (!image) {
      json(404, { ok: false, error: 'no such image' })
      return
    }
    try {
      const bytes = await readItemImage(rt.attachmentsDir, itemId, image)
      res.writeHead(200, {
        'content-type': image.mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=31536000, immutable',
      })
      res.end(bytes)
    } catch {
      json(404, { ok: false, error: 'the image file is missing' })
    }
    return
  }
  // --- artifacts + links (.docs/next-version.md, phase 1) ---------------------
  if (url.pathname === '/api/artifacts' && req.method === 'GET') {
    let body: ArtifactsResponse
    try {
      body = { ok: true, root: rt.artifacts.root, artifacts: await listArtifactsOp(rt, url.searchParams.get('all') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  if (url.pathname === '/api/artifacts/content' && req.method === 'GET') {
    let body: ArtifactContentResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const a = id ? await rt.artifacts.read(id) : null
      if (!a) throw new Error('no such artifact')
      body = { ok: true, artifact: a.artifact, body: a.body, links: await linksFor(rt, 'artifact', id), abs: a.abs }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 404, body)
    return
  }
  if (url.pathname === '/api/artifacts' && (req.method === 'POST' || req.method === 'PUT')) {
    let body: ArtifactResponse
    try {
      const parsed = await readJsonBody(req)
      if (req.method === 'POST') body = { ok: true, artifact: await createArtifactOp(rt, parsed, 'human') }
      else {
        const id = url.searchParams.get('id') ?? ''
        if (!id) throw new Error('need an artifact id')
        // The stdio shim edits as the model (`?by=model`) and is held to the model's rule.
        const by: ArtifactAuthor = url.searchParams.get('by') === 'model' ? 'model' : 'human'
        body = { ok: true, artifact: await updateArtifactOp(rt, id, parsed, by) }
      }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/artifacts' && req.method === 'DELETE') {
    let body: OkBody
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!id) throw new Error('need an artifact id')
      await rt.artifacts.remove(id)
      log('info', 'artifacts', `removed ${id}`, { id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/artifacts/reindex' && req.method === 'POST') {
    let body: ArtifactsResponse
    try {
      await rt.artifacts.refresh(true)
      body = { ok: true, root: rt.artifacts.root, artifacts: await listArtifactsOp(rt, url.searchParams.get('all') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return
  }
  // Open the file in the user's own editor — the server runs on their machine.
  if (url.pathname === '/api/artifacts/open' && req.method === 'POST') {
    let body: OkBody
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const a = id ? await rt.artifacts.read(id) : null
      if (!a) throw new Error('no such artifact')
      await openInEditor(a.abs)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Outbound actions (core/actions): every effect a session had that left
  // this machine, newest first. `item` = filed against it or made by a session
  // linked to it; records the actions file now sets aside come back `hidden`.
  // Goals (server/goals.ts): list, the goal page, and the goal_* writes.
  const goalReply = await goalsRoute(rt.goalDeps, req, url, () => readJsonBody(req), goalEngineFor(rt))
  if (goalReply) {
    json(goalReply.status, goalReply.body)
    return
  }
  if (url.pathname === '/api/actions' && req.method === 'GET') {
    let body: ActionsResponse
    try {
      const kind = url.searchParams.get('kind')
      const sessionId = url.searchParams.get('session') ?? undefined
      const itemId = url.searchParams.get('item') ?? undefined
      const limit = Number(url.searchParams.get('limit')) || 500
      const sessionIds = itemId ? [...rt.sessionItem].filter(([, i]) => i === itemId).map(([s]) => s) : undefined
      const records = await rt.store.actions.list({ ...(isActionKind(kind) ? { kind } : {}), ...(sessionId ? { sessionId } : {}), ...(itemId ? { itemId, sessionIds } : {}), limit })
      const actions = await actionViews(rt, records)
      // The count line is the workspace's day, whatever the list is narrowed to.
      const since = localMidnight(Date.now())
      const { rules, errors } = rt.actionsFile.current()
      const today = (await rt.store.actions.list({ since, status: ['succeeded', 'failed'], limit: 5000 })).filter((a) => !overriddenOff(a, rules))
      const counts = countSince(today, since)
      const failedToday = today.filter((a) => a.status === 'failed').length
      body = { ok: true, actions, today: { line: countLine(counts, failedToday), counts }, file: { path: rt.actionsFile.path, errors }, needsYou: await needsYouCount(rt) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // A row's one-click override, written to the actions file.
  if (url.pathname === '/api/actions/override' && req.method === 'POST') {
    let body: ActionOverrideResponse
    try {
      const raw = (await readJsonBody(req, 10_000)) as Partial<Record<keyof ActionOverrideRequest, unknown>> | null
      const actionId = typeof raw?.actionId === 'string' ? raw.actionId : ''
      const verdict = raw?.verdict === 'action' || raw?.verdict === 'not_action' ? raw.verdict : null
      if (!actionId || !verdict) throw new Error("need actionId and verdict ('action' | 'not_action')")
      const a = await rt.store.actions.get(actionId)
      if (!a) throw new Error('no such action')
      body = { ok: true, entries: await setActionOverride(rt, a, verdict) }
      broadcast(rt, { type: 'actions_changed' })
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // The rail's badge: queued actions waiting on you.
  if (url.pathname === '/api/actions/pending' && req.method === 'GET') {
    let body: ActionsPendingResponse
    try {
      body = { ok: true, needsYou: await needsYouCount(rt) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // A queued action's verbs (core/actions/queue.ts): approve (optionally with
  // edited args), undo inside the window, send back with notes, reject, retry.
  const verbMatch = /^\/api\/actions\/(approve|undo|send-back|reject|retry)$/.exec(url.pathname)
  if (verbMatch && req.method === 'POST') {
    let body: ActionMoveResponse
    try {
      const raw = (await readJsonBody(req, 2_000_000)) as Partial<Record<keyof ActionMoveRequest, unknown>> | null
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('need a JSON object body')
      const next = await actionVerbOp(rt, verbMatch[1] as ActionVerb, raw)
      body = { ok: true, action: (await actionViews(rt, [next]))[0] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Re-read every session's log into the record. Idempotent; the boot runs it once.
  if (url.pathname === '/api/actions/backfill' && req.method === 'POST') {
    try {
      const done = await backfillActions(rt, { force: true })
      json(200, { ok: true, ...done })
    } catch (err) {
      json(500, { ok: false, error: errText(err) })
    }
    return
  }
  if (url.pathname === '/api/links') {
    let body: LinksResponse
    try {
      if (req.method === 'GET') {
        const kind = url.searchParams.get('kind')
        const id = url.searchParams.get('id') ?? ''
        if (!isLinkKind(kind) || !id) throw new Error('need kind (artifact|item|session) and id')
        body = { ok: true, links: await linksFor(rt, kind, id) }
      } else if (req.method === 'POST') {
        body = { ok: true, links: [await addLinkOp(rt, await readJsonBody(req))] }
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? ''
        if (!id) throw new Error('need a link id')
        await rt.store.links.remove(id)
        body = { ok: true, links: [] }
      } else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  await serveWeb(url.pathname, res)
})

// ---------------------------------------------------------------------------
// WebSocket — each connection binds to one workspace at upgrade time
// (?workspace= param, else the triage_ws cookie, else the default), and only
// ever sees that workspace's sessions and events.
// ---------------------------------------------------------------------------
// Drop other devices at accept while phone access is off — the same as a
// loopback-only bind, without a restart to switch it on (server/remote.ts).
server.on('connection', (sock) => {
  if (isLoopbackAddress(sock.remoteAddress)) return
  if (!remote.enabled) {
    sock.destroy()
    return
  }
  remoteSockets.add(sock)
  sock.on('close', () => remoteSockets.delete(sock))
})

// Upgrades are routed by path: the UI's socket, and the browser pane's host.
// Two servers can't share `server` — each aborts the other's paths with a 400.
const wss = new WebSocketServer({
  noServer: true,
  path: '/ws',
  // Browsers let any page open a WebSocket to localhost; only our own page,
  // from this machine or a paired device, gets one.
  verifyClient: ({ req }, done) => {
    const access = accessOf(req, remote)
    if (access === 'denied') done(false, 401, 'not paired')
    else if (!sameOrigin(req, access)) done(false, 403, 'cross-origin')
    else done(true)
  },
})

/** Triage.app's main process, hosting the browser pane's tabs (server/browser.ts). */
const hostWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === BROWSER_HOST_PATH) {
    // This machine only, and no Origin: every browser sends one, so no web
    // page — not even one the agent is looking at — can pose as the host.
    if (accessOf(req, remote) !== 'local' || req.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    hostWss.handleUpgrade(req, socket, head, (ws) => browserHub.attach(ws))
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(rt: WorkspaceRuntime, msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of rt.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

/** The inbox moved: drop the snapshot and tell every open page to refetch. */
function invalidateInbox(rt: WorkspaceRuntime) {
  rt.inboxCache = null
  broadcast(rt, { type: 'inbox_changed' })
}

function broadcastSessionList(rt: WorkspaceRuntime) {
  broadcast(rt, { type: 'sessions', sessions: summaries(rt) })
  noteDispatchedSessions(rt)
}

function expandHome(p: string): string {
  if (!p) return process.cwd()
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

/**
 * Open the OS-native folder chooser on the machine running the server — which,
 * since triage is a localhost app, is the user's own desktop. Returns the picked
 * absolute path, or null when the user dismisses the dialog. The picker command
 * exits non-zero on cancel; we treat that as a cancel rather than an error.
 */
async function pickNativeFolder(): Promise<string | null> {
  const prompt = 'Select a project folder'
  let cmd: string
  let args: string[]
  if (process.platform === 'darwin') {
    cmd = 'osascript'
    args = ['-e', `POSIX path of (choose folder with prompt "${prompt}")`]
  } else if (process.platform === 'win32') {
    cmd = 'powershell'
    args = [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`,
    ]
  } else {
    // Linux/other: prefer zenity, fall back to kdialog. Neither is guaranteed.
    cmd = 'zenity'
    args = ['--file-selection', '--directory', `--title=${prompt}`]
  }
  try {
    const { stdout } = await pExecFile(cmd, args)
    const out = stdout.trim()
    return out ? out : null
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string }
    // A missing picker binary (ENOENT) is a real error worth surfacing; a
    // non-zero exit from a present picker is the user cancelling.
    if (e.code === 'ENOENT') {
      if (process.platform === 'linux') {
        try {
          const { stdout } = await pExecFile('kdialog', ['--getexistingdirectory', os.homedir()])
          const out = stdout.trim()
          return out ? out : null
        } catch (err2) {
          const e2 = err2 as NodeJS.ErrnoException
          if (e2.code === 'ENOENT') throw new Error('no folder picker found (install zenity or kdialog)')
          return null
        }
      }
      throw new Error(`folder picker not available (${cmd} not found)`)
    }
    return null
  }
}

const effort = (v: unknown): EffortLevel | undefined => (isEffortLevel(v) ? v : undefined)

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/**
 * Unrecognized modes fall through to `undefined`, i.e. ask — a frame the
 * server does not understand must never widen what a session may do.
 */
const permissionMode = (v: unknown): PermissionMode | undefined =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : undefined

/**
 * AskUserQuestion answers off the socket: a flat string→string map, or nothing.
 * Non-string values are dropped rather than passed through — this object is
 * merged into a tool's input.
 */
const questionAnswers = (v: unknown): QuestionAnswers | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: QuestionAnswers = {}
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length > 0 ? out : undefined
}

/** Rough decoded size of a base64 payload, without decoding it. */
const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4)

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Image attachments off the socket. Anything malformed, oversized, or of an
 * unsupported media type is dropped rather than forwarded — these bytes go
 * both into the event log and up to the API.
 */
const imageAttachments = (v: unknown): ImageAttachment[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: ImageAttachment[] = []
  for (const raw of v.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = raw as Record<string, unknown>
    if (!isImageMediaType(a.mediaType)) continue
    if (typeof a.data !== 'string' || !a.data || !BASE64.test(a.data)) continue
    if (base64Bytes(a.data) > MAX_IMAGE_BYTES) continue
    out.push({
      mediaType: a.mediaType,
      data: a.data,
      name: typeof a.name === 'string' && a.name ? a.name.slice(0, 200) : undefined,
    })
  }
  return out.length > 0 ? out : undefined
}

const mentionList = (v: unknown): Mention[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: Mention[] = []
  for (const raw of v.slice(0, MAX_MENTIONS_PER_MESSAGE)) {
    if (typeof raw !== 'object' || raw === null) continue
    const m = raw as Record<string, unknown>
    if (!isMentionKind(m.kind)) continue
    if (typeof m.ref !== 'string' || !m.ref || m.ref.length > 1024) continue
    // Paths are resolved against the session folder later; an absolute path
    // or a `..` hop is refused here so the resolver only ever sees relatives.
    if (m.kind === 'file' && (path.isAbsolute(m.ref) || m.ref.split('/').includes('..'))) continue
    out.push({
      kind: m.kind,
      ref: m.ref,
      label: typeof m.label === 'string' && m.label ? m.label.slice(0, 200) : m.ref.slice(0, 200),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The socket is untrusted input (vision principle 6), so incoming frames are
 * validated into the ClientMessage union rather than cast into it.
 */
function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const model = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  switch (m.type) {
    case 'create_session':
      return {
        type: 'create_session',
        title: str(m.title),
        cwd: str(m.cwd),
        projectId: typeof m.projectId === 'string' && m.projectId ? m.projectId : undefined,
        checkoutId: typeof m.checkoutId === 'string' && m.checkoutId ? m.checkoutId : undefined,
        worktree:
          typeof m.worktree === 'object' && m.worktree !== null && typeof (m.worktree as { branch?: unknown }).branch === 'string'
            ? { branch: str((m.worktree as { branch: string }).branch).trim().slice(0, 200) }
            : undefined,
        firstMessage: typeof m.firstMessage === 'string' ? m.firstMessage : undefined,
        images: imageAttachments(m.images),
        mentions: mentionList(m.mentions),
        model: model(m.model),
        effort: effort(m.effort),
        fastMode: m.fastMode === true,
        permissionMode: permissionMode(m.permissionMode),
        // An agent this build doesn't know is dropped: the session runs on Claude.
        provider: isProviderId(m.provider) ? m.provider : undefined,
        itemId: typeof m.itemId === 'string' && m.itemId ? m.itemId : undefined,
      }
    case 'set_model':
      return typeof m.sessionId === 'string'
        ? { type: 'set_model', sessionId: m.sessionId, model: model(m.model), effort: effort(m.effort) }
        : null
    case 'set_fast_mode':
      // Anything but an explicit true is off — the paid-for mode is the one
      // that has to be asked for exactly.
      return typeof m.sessionId === 'string'
        ? { type: 'set_fast_mode', sessionId: m.sessionId, fastMode: m.fastMode === true }
        : null
    case 'set_permission_mode': {
      const mode = permissionMode(m.mode)
      return typeof m.sessionId === 'string' && mode
        ? { type: 'set_permission_mode', sessionId: m.sessionId, mode }
        : null
    }
    case 'rename_session':
      return typeof m.sessionId === 'string'
        ? { type: 'rename_session', sessionId: m.sessionId, title: str(m.title) }
        : null
    case 'set_pinned':
      return typeof m.sessionId === 'string'
        ? { type: 'set_pinned', sessionId: m.sessionId, pinned: m.pinned === true }
        : null
    case 'delete_session':
      return typeof m.sessionId === 'string' ? { type: 'delete_session', sessionId: m.sessionId } : null
    case 'subscribe':
      return typeof m.sessionId === 'string' ? { type: 'subscribe', sessionId: m.sessionId } : null
    case 'user_message':
      return typeof m.sessionId === 'string'
        ? {
            type: 'user_message',
            sessionId: m.sessionId,
            text: str(m.text),
            images: imageAttachments(m.images),
            mentions: mentionList(m.mentions),
          }
        : null
    case 'permission_response':
      return typeof m.sessionId === 'string' && typeof m.requestId === 'string'
        ? {
            type: 'permission_response',
            sessionId: m.sessionId,
            requestId: m.requestId,
            // Anything unrecognized is a denial: the permissive readings are
            // the ones that have to be spelled out exactly.
            behavior:
              m.behavior === 'allow' ? 'allow' : m.behavior === 'allow_always' ? 'allow_always' : 'deny',
            answers: questionAnswers(m.answers),
          }
        : null
    case 'interrupt':
      return typeof m.sessionId === 'string' ? { type: 'interrupt', sessionId: m.sessionId } : null
    case 'agent_stop':
      return typeof m.sessionId === 'string' && typeof m.agentId === 'string' && m.agentId
        ? { type: 'agent_stop', sessionId: m.sessionId, agentId: m.agentId }
        : null
    case 'agent_background':
      return typeof m.sessionId === 'string' && typeof m.toolUseId === 'string' && m.toolUseId
        ? { type: 'agent_background', sessionId: m.sessionId, toolUseId: m.toolUseId }
        : null
    case 'agent_message': {
      const r = (typeof m.relay === 'object' && m.relay !== null ? m.relay : {}) as Record<string, unknown>
      // The agent id is spliced into the prompt main reads: an id, nothing else.
      const agentId = typeof r.agentId === 'string' && /^[\w-]{1,64}$/.test(r.agentId) ? r.agentId : ''
      const relay = { toolUseId: str(r.toolUseId), agentId, label: str(r.label).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 120) }
      return typeof m.sessionId === 'string' && relay.toolUseId && relay.agentId && str(m.text).trim()
        ? { type: 'agent_message', sessionId: m.sessionId, relay, text: str(m.text).trim() }
        : null
    }
    case 'terminal_create':
      return {
        type: 'terminal_create',
        cwd: typeof m.cwd === 'string' && m.cwd ? m.cwd : undefined,
        projectId: typeof m.projectId === 'string' && m.projectId ? m.projectId : undefined,
        checkoutId: typeof m.checkoutId === 'string' && m.checkoutId ? m.checkoutId : undefined,
        title: typeof m.title === 'string' && m.title ? m.title : undefined,
        command: typeof m.command === 'string' && m.command ? m.command : undefined,
      }
    case 'terminal_input':
      return typeof m.terminalId === 'string' && typeof m.data === 'string'
        ? { type: 'terminal_input', terminalId: m.terminalId, data: m.data }
        : null
    case 'terminal_resize':
      return typeof m.terminalId === 'string' && Number.isFinite(m.cols) && Number.isFinite(m.rows)
        ? { type: 'terminal_resize', terminalId: m.terminalId, cols: Number(m.cols), rows: Number(m.rows) }
        : null
    case 'terminal_subscribe':
      return typeof m.terminalId === 'string' ? { type: 'terminal_subscribe', terminalId: m.terminalId } : null
    case 'terminal_rename':
      return typeof m.terminalId === 'string'
        ? { type: 'terminal_rename', terminalId: m.terminalId, title: str(m.title) }
        : null
    case 'terminal_close':
      return typeof m.terminalId === 'string' ? { type: 'terminal_close', terminalId: m.terminalId } : null
    default:
      return null
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', `http://localhost:${PORT}`)
  const rt = resolveRuntime(req, url)
  rt.clients.add(ws)
  if (accessOf(req, remote) !== 'local') {
    remoteWs.add(ws)
    ws.on('close', () => remoteWs.delete(ws))
  }
  send(ws, {
    type: 'hello',
    sessions: summaries(rt),
    workspaceId: rt.meta.id,
    workspaces: wireWorkspaces(),
    onboarded: registry.onboarded,
    terminals: rt.terminals.list(),
    checkouts: checkoutList(rt),
    build: BUILD,
    persona: rt.persona,
  })

  ws.on('message', async (raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    const msg = parseClientMessage(parsed)
    if (!msg) return

    try {
      switch (msg.type) {
        case 'create_session': {
          if (msg.provider && !isConnected(rt.meta, msg.provider))
            throw new Error(`${providerFor(msg.provider).label} isn't connected in this workspace — connect it in Settings → Providers`)
          // A checkout names both the folder and the project; it must still be there.
          let checkout = msg.checkoutId ? rt.checkouts.get(msg.checkoutId) : undefined
          if (msg.checkoutId && checkout?.state !== 'active') throw new Error('that checkout is gone — pick another folder')
          // A new worktree is made before the session exists, so the session's folder is the worktree.
          if (!checkout && msg.worktree?.branch) {
            const target = msg.projectId
              ? (await rt.store.projects.list()).find((p) => p.id === msg.projectId)
              : await projectForSession(rt, expandHome(msg.cwd || (await defaultProject(rt))?.path || '~'))
            if (!target) throw new Error('unknown project')
            checkout = await makeWorktree(rt, target, msg.worktree.branch, msg.itemId, (step) => send(ws, { type: 'create_progress', step }))
            send(ws, { type: 'create_progress', step: 'session' })
          }
          const fallback = msg.cwd || checkout ? null : await defaultProject(rt)
          const cwd = checkout?.path ?? expandHome(msg.cwd || fallback?.path || '~')
          const project = await projectForSession(rt, cwd, checkout?.projectId ?? msg.projectId ?? fallback?.id)
          const title = msg.title.trim() || `Session ${rt.rows.size + 1}`
          const row = await createSession(
            rt,
            title,
            msg.cwd || checkout ? cwd : project.path,
            msg.model ?? null,
            msg.effort ?? null,
            msg.fastMode === true,
            msg.permissionMode ?? null,
            { projectId: project.id, checkoutId: checkout?.id, provider: msg.provider },
          )
          // Dispatched from an item: the link is what the item page shows as "sessions".
          if (msg.itemId) await linkSessionToItem(rt, row.id, msg.itemId, 'dispatch').catch(() => {})
          send(ws, { type: 'session_created', session: summarize(rt, row) })
          broadcastSessionList(rt)
          // A dispatch opens with the item's screenshots attached — the draft
          // composer never carries the bytes, the server reads them off disk.
          const dispatched = msg.itemId ? await rt.store.items.get(msg.itemId).catch(() => null) : null
          const fromItem = dispatched
            ? await itemImageAttachments(rt.attachmentsDir, dispatched.id, dispatched.images)
            : undefined
          const images = [...(fromItem ?? []), ...(msg.images ?? [])].slice(0, MAX_IMAGES_PER_MESSAGE)
          if (msg.firstMessage?.trim() || images.length || msg.mentions?.length)
            void rt.live
              .get(row.id)
              ?.sendUserMessage(msg.firstMessage?.trim() ?? '', images.length ? images : undefined, msg.mentions)
          break
        }
        case 'set_model': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          const choice = await checkModelChoice(rt, row.provider, msg.model ?? null, msg.effort ?? null).catch((err) => {
            log('warn', 'models', `could not check ${row.provider} models: ${errText(err)}`, { workspace: rt.meta.id, session: row.id })
            return null
          })
          if (!choice) {
            log('warn', 'models', `refused ${row.provider} model ${msg.model}`, { workspace: rt.meta.id, session: row.id })
            broadcastSessionList(rt) // puts the picker back on the stored choice
            break
          }
          row.model = choice.model
          row.effort = choice.effort
          await rt.store.sessions.setModel(row.id, row.model, row.effort)
          // A session with no subprocess picks the choice up from its row when
          // it is revived; a live one is switched in place.
          await rt.live.get(row.id)?.setModel(row.model, row.effort)
          broadcastSessionList(rt)
          break
        }
        case 'set_fast_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.fastMode = msg.fastMode
          await rt.store.sessions.setFastMode(row.id, row.fastMode)
          // Same shape as set_model: the row is what a revival reads, and a
          // live subprocess is switched in place.
          await rt.live.get(row.id)?.setFastMode(row.fastMode)
          broadcastSessionList(rt)
          break
        }
        case 'set_permission_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.permissionMode = msg.mode
          await rt.store.sessions.setPermissionMode(row.id, msg.mode)
          // Same shape as set_model: the row is the source of truth for a
          // revival, and a live subprocess is switched in place where it can
          // be. Where it cannot (arming a bypass needs a spawn-time flag), the
          // subprocess is retired so the next turn brings up one that can.
          const session = rt.live.get(row.id)
          if (session && !(await session.setPermissionMode(msg.mode))) session.stop()
          broadcastSessionList(rt)
          break
        }
        case 'rename_session': {
          const row = rt.rows.get(msg.sessionId)
          const title = msg.title.trim()
          // An empty title would leave a nameless row in the sidebar; the old
          // one stays instead.
          if (!row || !title) break
          row.title = title
          await rt.store.sessions.rename(row.id, title)
          broadcastSessionList(rt)
          break
        }
        case 'set_pinned': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.pinned = msg.pinned
          await rt.store.sessions.setPinned(row.id, msg.pinned)
          broadcastSessionList(rt)
          break
        }
        case 'delete_session': {
          if (!rt.rows.has(msg.sessionId)) break
          await deleteSession(rt, msg.sessionId)
          break
        }
        case 'subscribe': {
          if (!rt.rows.has(msg.sessionId)) {
            // a dry run streams under an ephemeral id; its transcript lives in memory
            const pv = rt.previews.get(msg.sessionId)
            if (pv) send(ws, { type: 'history', sessionId: msg.sessionId, events: pv.events })
            break
          }
          const events = await rt.store.events.read(msg.sessionId)
          send(ws, {
            type: 'history',
            sessionId: msg.sessionId,
            events: events.map((e) => e.event),
            times: events.map((e) => e.createdAt),
          })
          break
        }
        case 'user_message': {
          if (!msg.text.trim() && !msg.images?.length && !msg.mentions?.length) break
          // A goal's session: a live one takes the message (its goal keeps a copy);
          // one that has ended is gone for good, so the message goes to the goal's lead.
          const row = rt.rows.get(msg.sessionId)
          if (row?.kind === 'goal' && !rt.goalLeads.has(row.id)) {
            const run = rt.goalRuns.get(row.id)
            if (run) void goalWorkerMessageOp(rt.goalDeps, run.goalId, row.id, msg.text.trim()).catch(() => {})
            else {
              const goal = await goalOfSession(rt.goalDeps, row.id).catch(() => null)
              // Plan review keeps M2's behaviour: the drafting lead's session is revived as before.
              if (goal && goal.state !== 'draft_plan' && goal.state !== 'plan_ready') {
                const r = await goalMessageOp(rt.goalDeps, goalEngineFor(rt), { goalId: goal.id, text: msg.text.trim() }).catch((err: unknown) => err)
                await sessionNotice(rt, row.id, r instanceof Error ? `Not sent: ${r.message}` : "This session has ended; your message went to the goal's lead.")
                break
              }
            }
          }
          const session = await getOrRevive(rt, msg.sessionId)
          void session?.sendUserMessage(msg.text.trim(), msg.images, msg.mentions)
          break
        }
        case 'permission_response': {
          rt.live.get(msg.sessionId)?.resolvePermission(msg.requestId, msg.behavior, msg.answers)
          break
        }
        case 'interrupt': {
          void rt.live.get(msg.sessionId)?.interrupt()
          break
        }
        // A subagent only runs inside a live subprocess: with none, there is nothing to stop or background.
        case 'agent_stop': {
          void rt.live.get(msg.sessionId)?.stopAgent(msg.agentId)
          break
        }
        case 'agent_background': {
          void rt.live.get(msg.sessionId)?.backgroundAgent(msg.toolUseId)
          break
        }
        case 'agent_message': {
          // A finished agent can still be written to: main resumes it, so revive main if needed.
          const session = await getOrRevive(rt, msg.sessionId)
          void session?.sendAgentMessage(msg.relay, msg.text)
          break
        }
        case 'terminal_create': {
          const checkout = msg.checkoutId ? rt.checkouts.get(msg.checkoutId) : undefined
          const cwd = checkout?.path ?? (msg.cwd ? path.resolve(expandHome(msg.cwd)) : undefined)
          const projects = await rt.store.projects.list()
          const project =
            (checkout ? projects.find((p) => p.id === checkout.projectId) : undefined) ??
            (msg.projectId ? projects.find((p) => p.id === msg.projectId) : undefined) ??
            (cwd ? projects.find((p) => path.resolve(p.path) === cwd) : undefined) ??
            projects.find((p) => p.isDefault)
          const terminal = rt.terminals.create({
            cwd: cwd ?? project?.path,
            projectId: project?.id ?? null,
            checkoutId: checkout?.id ?? mainCheckout(rt, project?.id)?.id ?? null,
            title: msg.title,
            command: msg.command,
            env: rt.env,
          })
          // The creator hears first so it can switch to the new tab; the list
          // broadcast (already sent by the manager) brings everyone else along.
          send(ws, { type: 'terminal_created', terminal })
          break
        }
        case 'terminal_input': {
          rt.terminals.write(msg.terminalId, msg.data)
          break
        }
        case 'terminal_resize': {
          rt.terminals.resize(msg.terminalId, msg.cols, msg.rows)
          break
        }
        case 'terminal_subscribe': {
          if (rt.terminals.get(msg.terminalId)) {
            send(ws, { type: 'terminal_history', terminalId: msg.terminalId, data: rt.terminals.history(msg.terminalId) })
          }
          break
        }
        case 'terminal_rename': {
          rt.terminals.rename(msg.terminalId, msg.title)
          break
        }
        case 'terminal_close': {
          rt.terminals.close(msg.terminalId)
          break
        }
      }
    } catch (err) {
      // A draft waiting on its session must hear why it didn't come, not just the console.
      if (msg.type === 'create_session') send(ws, { type: 'create_failed', message: errText(err) })
      else send(ws, { type: 'error', message: String(err) })
    }
  })

  ws.on('close', () => rt.clients.delete(ws))
})

// Boot: one runtime per registered workspace, each with its own store, seeds,
// cached snapshot, and background probes.
for (const meta of registry.workspaces) runtimes.set(meta.id, new WorkspaceRuntime(meta))
for (const rt of runtimes.values()) await initRuntime(rt)

// The wss wraps the http server and re-emits its errors, so the handler has
// to sit on both — an unhandled 'error' on either one crashes with a raw stack.
for (const emitter of [server, wss]) emitter.on('error', onListenError)
function onListenError(err: NodeJS.ErrnoException) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `triage: port ${PORT} is already in use — \`triage status\` shows whether it's another triage; ` +
        `otherwise pick a port with \`triage --port ${PORT + 1}\``,
    )
    process.exit(1)
  }
  throw err
}
server.listen(PORT, () => {
  syncTunnel()
  log('info', 'server', `triage v${VERSION} started on :${PORT} (${runtimes.size} workspace${runtimes.size === 1 ? '' : 's'}, default: ${registry.defaultId})`)
  // Record where we are so `triage stop/status` can find a --port server.
  writeState({ pid: process.pid, port: PORT, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err) => console.error('[state] could not write server.json:', err),
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', 'server', `received ${sig} — shutting down`)
    tunnel.stop()
    for (const rt of runtimes.values()) rt.terminals.killAll()
    clearState(process.pid).finally(() => process.exit(0))
  })
}
