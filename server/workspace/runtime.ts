import { WebSocket } from 'ws'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import path from 'node:path'
import type { Checkout, Connector, InboxSnapshot, ModelOption, ProviderStatus, SlashCommandInfo } from '../../shared/protocol.js'
import { dbFileFor, loadRegistry, spawnEnvFor, workspaceDir, type WorkspaceMeta } from '../workspaces.js'
import type { Store, StoredSession } from '../../core/store/types.js'
import type { Provider, ProviderId } from '../providers/types.js'
import { DEFAULT_PERSONA, type Persona } from '../../core/junior/persona.js'
import { providerFor } from '../providers/registry.js'
import { TerminalManager } from '../terminals.js'
import { FileIndexes } from '../files.js'
import { ArtifactIndex } from '../artifacts.js'
import { GoalLedger } from '../../core/goals/ledger.js'
import { type GoalDeps, GoalHeldIndex, onGoalEvent } from '../goals.js'
import { BrowserHub, makeBrowserMcp, ShotStore } from '../browser.js'
import { TeamLibrary } from '../teams.js'
import { JobFiles, renameLegacyFolders } from '../job-files.js'
import type { Action as TeamAction, TeamRun } from '../../core/teams/engine.js'
import { ActionsFile } from '../actions-file.js'
import { ActionTracker } from '../../core/actions/track.js'
import type { TreeChange } from '../git.js'
import { log } from '../log.js'
import { openSqliteStore } from '../../core/store/sqlite.js'
import { blockFromRecipe } from '../../core/goals/blocks.js'
import { ensureWorkspacePlugin } from '../library.js'
import { LiveSession, type SessionExtras } from '../session/live-session.js'
import type { QueuedRun } from '../jobs/queue.js'
import type { JobPreview } from '../jobs/preview.js'
import { goalEngineFor, type GoalLead, type GoalRun } from '../goal-glue.js'
import type { OpenTurn } from '../session/changes.js'
import { errText } from '../errors.js'
import { broadcast, invalidateInbox } from '../ws/send.js'
import { defaultProject } from '../session/sessions.js'
import { createManualOp } from '../items-ops.js'
import { makeTriageMcp } from '../triage-mcp.js'

// Workspace runtimes: everything that used to be a module singleton, one per
// workspace. Physical isolation: each runtime owns its own store (its own
// SQLite file), its own live sessions and WS clients, and its own caches, so
// nothing can bleed across the boundary by construction.
export type ConnectorProbe = { probedAt: number; connectors: Connector[] }
export type ModelProbe = { probedAt: number; models: ModelOption[] }
export type CommandProbe = { probedAt: number; commands: SlashCommandInfo[] }

export const registry = loadRegistry()

export class WorkspaceRuntime {
  readonly store: Store
  /** full spawn env for this workspace's auth backend; undefined = inherit */
  env: Record<string, string> | undefined

  // session registry: every session lives in the store; a subset is live
  readonly rows = new Map<string, StoredSession>()
  readonly live = new Map<string, LiveSession>()
  /** a project's folders, main and worktrees, by id. The rows, kept in step by syncCheckouts */
  readonly checkouts = new Map<string, Checkout>()
  /** checkout discovery runs one at a time; a call while one runs queues exactly one more */
  checkoutSyncRunning: Promise<void> | null = null
  checkoutSyncQueued: Promise<void> | null = null
  /** WS clients bound to THIS workspace: broadcasts never cross the boundary */
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
  /** `/` command lists, keyed by folder, a project's own commands live under it */
  readonly commandCache = new Map<string, CommandProbe>()
  readonly commandInFlight = new Map<string, Promise<CommandProbe>>()
  /** commands this CLI binds to a real terminal; learned from a session's init */
  terminalCommands: string[] | null = null
  affiliatedCache: { at: number; repos: string[] } | null = null

  /**
   * The in-process triage MCP server a chat session gets. One instance per
   * session, never shared: the SDK connects each instance to exactly one
   * transport, so a second concurrent session handed the same object loses
   * its connect and lands `status: "failed"` in system/init: a chat with no
   * mcp__triage__* tools whenever another session in the workspace is live.
   */
  readonly triageMcp: () => ReturnType<typeof createSdkMcpServer>
  /** Junior's persona here (core/junior/persona.ts): loaded at boot, replaced on every save */
  persona: Persona = DEFAULT_PERSONA
  /** the coding agent this workspace's sessions, runs and probes go through (its meta names it) */
  get provider(): Provider {
    return providerFor(this.meta.provider)
  }
  /** PTY shells opened from the web UI, run with this workspace's spawn env */
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
  /** playbooks and dispatch templates: the two prose-customisable stages, as files */
  readonly playbookDir: string
  readonly dispatchDir: string
  /** screenshots attached to work items: bytes on disk, refs on the item */
  readonly attachmentsDir: string

  // brief runs: one at a time per workspace
  briefActive: string | null = null
  briefPumping = false
  readonly briefTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly briefExtras = new Map<string, SessionExtras>()
  /** goal id → its drafting lead while one runs (startGoalLead) */
  readonly goalLeads = new Map<string, GoalLead>()
  /** the sessions the goal run loop started (run leads and workers), by session id */
  readonly goalRuns = new Map<string, GoalRun>()
  /** actions a goal's workers queued, across sessions and restarts (server/goals.ts GoalHeldIndex) */
  readonly goalHeld = new GoalHeldIndex()
  /** jobs whose run has called write_brief at least once */
  readonly briefWrote = new Set<string>()
  /** session id → the work item it was dispatched for or briefs (mirrors `links`) */
  readonly sessionItem = new Map<string, string>()

  // Teams (server/teams.ts): agents and recipes are files; runs persist under `team_runs`.
  readonly teamLibrary: TeamLibrary
  /** the workspace's own skills and agents: a local plugin every chat session loads (server/library.ts) */
  readonly libraryDir: string
  // Jobs are files (server/job-files.ts); rows hold their state.
  readonly jobFiles: JobFiles
  /** what the last file sync saw: files, projects, probes; unchanged = nothing to do */
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
  /** action writes run one at a time, in event order. A settle never beats its attempt */
  actionChain: Promise<void> = Promise.resolve()
  /** a broadcast of `actions_changed` is pending (coalesced per tick) */
  actionsDirty: Set<string> | null = null
  /** approved actions' send timers, by action id (the minute tick catches any a restart lost) */
  readonly actionTimers = new Map<string, NodeJS.Timeout>()
  /** held calls still waiting, by session + tool + args. An agent retrying the same call hears the same id */
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
      // Plan review reacts the moment its event is written (server/goals.ts onGoalEvent), no polling.
      emit: (ev) =>
        void onGoalEvent(this.goalDeps, goalEngineFor(this), ev).catch((err) =>
          log('error', 'goals', `event ${ev.kind} on ${ev.goalId}: ${errText(err)}`, { workspace: meta.id }),
        ),
      // A goal made in chat lives under a new manual item, like a team proposed from one.
      itemFor: (goal) =>
        createManualOp(this, { title: goal.title.slice(0, 120), description: `Goal — done when: ${goal.doneWhen}`, ...(goal.projectId ? { projectId: goal.projectId } : {}) }),
      // the workspace's team recipes are the workflow blocks a plan may name.
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

export const runtimes = new Map<string, WorkspaceRuntime>()

/**
 * The browser pane's host link (.docs/browser.md): Triage.app's main process,
 * when it is open. Daemon-wide, the app is one per machine, while each
 * session's tools and evidence stay in its own workspace.
 */
export const browserHub = new BrowserHub()
export const browserMcpFor = (rt: WorkspaceRuntime, row: StoredSession) =>
  makeBrowserMcp({ hub: browserHub, shots: rt.shots, sessionId: row.id, projectRoot: row.cwd })

export const defaultRuntime = (): WorkspaceRuntime => runtimes.get(registry.defaultId)!
