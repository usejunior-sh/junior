import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentRelay, EffortLevel, FastModeDisabledReason, FastModeState, FileRef, ImageAttachment, Mention, PermissionBehavior, PermissionMode, QuestionAnswers, SessionEvent, SessionStatus } from '../../shared/protocol.js'
import type { AgentSession, FastModeVerdict, McpServers, PermissionResult, PermissionUpdate, Provider, ToolCall, UserTurn } from '../providers/types.js'
import type { StoredSession } from '../../core/store/types.js'
import { providerFor } from '../providers/registry.js'
import { snapshotTree } from '../git.js'
import { log } from '../log.js'
import { attachedFilesNote } from '../attachments.js'
import { frameTeamMessage, isCheckCommand } from '../teams.js'
import { GOAL_MODE_MARK } from '../../shared/triageContext.js'
import { browserCallAllowed } from '../../core/browser/policy.js'
import { readOnlyCommand } from '../../core/actions/commands.js'
import { frameAgentRelay } from '../../core/agents/relay.js'
import { AsyncQueue } from './async-queue.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { BRIEF_DISALLOWED_TOOLS, briefBashAllowed } from './brief-tools.js'
import { endGoalSession, GOAL_LEAD_DISALLOWED_TOOLS, GOAL_LEAD_TOOLS, settleGoalLead } from '../goal-glue.js'
import { sessionVeto } from './actions-hold.js'
import { EDIT_TOOLS, reloadLibraryEverywhere, sessionRepoRoot, writesLibrary } from './changes.js'
import { broadcast, broadcastSessionList } from '../ws/send.js'
import { errText } from '../errors.js'
import { noteCommands, toCommandInfo } from '../workspace/probes.js'
import { noteBrowserTurn, slimToolImages } from './summaries.js'
import { syncCheckouts } from './checkouts.js'
import { onBriefSessionEnded, onBriefTurnDone } from '../brief-run.js'
import { noteTeamSpend } from '../team-run/ops.js'
import { resolveMentions } from './mentions.js'
import { classifyEffect, sessionScoped, TEAM_TOOLS, TRIAGE_READ_TOOLS } from './effects.js'
import { teamRunOf } from '../team-run/state.js'
import { noteActionEvent } from './actions-record.js'

/**
 * Spawn-time extras for special-purpose sessions (briefs): text appended to
 * Claude Code's own system prompt (it survives `resume`), and MCP servers
 * beyond the workspace's triage server.
 */
export type SessionExtras = {
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
  /** load only the MCP servers passed here, none of the user's other connectors or plugins */
  strictMcpConfig?: boolean
  /** plain MCP server configs passed through (e.g. the user's chrome-devtools for a browser-allowed agent) */
  externalMcp?: Record<string, Record<string, unknown>>
}

// Live session: one running Claude subprocess bound to a stored session row.
export class LiveSession {
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
      /** the tool asking: the inbox says "Permission: Bash" or "Question" */
      toolName: string
      /** The SDK's own "don't ask again" rules, replayed on `allow_always`. */
      suggestions: PermissionUpdate[]
      resolve: (r: PermissionResult) => void
    }
  >()
  private readonly q: AgentSession
  /** The subprocess's cumulative cost at its last result, turn cost is the difference. */
  private costSeen = 0
  /** This turn wrote a skill or agent file, reload them everywhere when it ends. */
  private libraryTouched = false
  /** Whether this subprocess was spawned able to bypass permission checks. */
  private readonly bypassArmed: boolean
  /** The agent this session runs on: its own, not the workspace's. */
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
      // work items directly: same tool surface as the stdio shim external
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
      // Plan mode: the agent reads and plans until you approve its plan (ExitPlanMode).
      ...(row.planning ? { planning: true } : {}),
      // Attached files live outside the project folder; Read there would prompt.
      // Listing the workspace's attachments folder makes it part of the session's scope.
      additionalDirectories: [rt.attachmentsDir],
      // Revival: replay the agent's own transcript into the new subprocess.
      ...(resumeSdkSessionId ? { resume: resumeSdkSessionId } : {}),
      // The workspace's own skills and agents, for a chat. Not for briefs, job
      // runs or team workers: each runs a lean, fixed toolset on purpose.
      ...(row.kind === 'chat' && !extras.tools ? { plugins: [rt.libraryDir] } : {}),
      // A read-only worker or brief is fenced, and a job run or a team worker
      // holds its outbound calls for you (core/actions/queue.ts), a hook, so
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
        // init and result messages carry what fast mode is really doing,
        // including why it is not serving, which is the only way the user
        // learns their toggle was overruled (wrong model, wrong plan, …).
        if (ev.fastMode) this.noteFastMode(ev.fastMode)
        if (ev.kind === 'started') {
          this.model = ev.model
          // The key for `resume`; without it a stored session can't continue.
          if (ev.sessionId && ev.sessionId !== this.row.sdkSessionId) {
            this.row.sdkSessionId = ev.sessionId
            void this.rt.store.sessions.setSdkSessionId(this.row.id, ev.sessionId)
          }
          // What this CLI won't drive from a browser. Cwd-independent, so it
          // is kept on the workspace: the first session to start teaches the
          // draft tabs too. Set before the list is asked for, which reads it.
          if (ev.terminalCommands) this.rt.terminalCommands = ev.terminalCommands
          // The subprocess already knows what `/` offers in this folder.
          // Take it rather than make the composer pay for its own probe.
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
          // The turn may have created files: the next `@` search relists.
          this.rt.files.invalidate(this.row.cwd)
          // A brief run is one turn: its result is the run's end.
          if (this.row.kind === 'brief') void onBriefTurnDone(this.rt, this.row.id)
          // So is a goal lead's: it proposed the plan, or it never will.
          if (this.row.kind === 'goal') void settleGoalLead(this.rt, this.row.id)
          // A skill or agent this turn wrote is usable now, here and in every other session.
          if (this.libraryTouched) {
            this.libraryTouched = false
            reloadLibraryEverywhere(this.rt)
          }
          // Team spend: total_cost_usd is cumulative for this subprocess, so
          // the turn's cost is the difference from the last result it sent.
          // Tracked for every session, so a chat that becomes a lead mid-way
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

  /** `opts.files` are already claimed into this session's folder (claimSessionFiles). */
  async sendUserMessage(text: string, images?: ImageAttachment[], mentions?: Mention[], opts: { from?: string; mode?: 'goal'; files?: FileRef[] } = {}) {
    // Mentions are resolved now, against this session's folder, so the event
    // log records what the model was actually given (and why a file wasn't).
    const attached = mentions?.length ? await resolveMentions(this.rt, this.row.cwd, mentions) : null
    // Before the agent can touch anything: the tree this turn starts from.
    await this.beginTurn()
    this.emit({ kind: 'local_user', text, images, ...(opts.files?.length ? { files: opts.files } : {}), mentions: attached?.resolved, ...(opts.from ? { from: opts.from } : {}), ...(opts.mode ? { mode: opts.mode } : {}) }, true)
    // A message from triage or a teammate is framed for the model; the transcript keeps the raw text and a badge.
    // One sent in Goal mode says so, so Junior goes straight to a goal card.
    const filesNote = attachedFilesNote(this.rt.attachmentsDir, this.row.id, opts.files ?? [])
    const modelText = opts.from && text ? frameTeamMessage(opts.from, text) : opts.mode === 'goal' ? `${GOAL_MODE_MARK}${text}` : text
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
      // Files go in as a path: Read opens them (pdf, csv, notebook, image) without a prompt.
      ...(filesNote ? [{ type: 'text' as const, text: filesNote }] : []),
    ]
    this.input.push({ content })
  }

  private requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[]; agentID?: string; toolUseID?: string },
  ): Promise<PermissionResult> {
    const effect = classifyEffect(toolName)
    // Plan mode: the plan is yours to approve, like a PR, never waved through by a mode or a rule.
    if (toolName === 'ExitPlanMode') return this.askUser(toolName, toolInput, opts, effect)
    // Reading our own inbox is harmless in any mode, never prompt for it. Every
    // triage write (create/edit/upsert/resolve) still goes through the prompt.
    if (TRIAGE_READ_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    // Team runs: triage's own team tools only record and route, the card is
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
    // machine: except a connector write nothing recognised as an action, which still asks.
    if (run && run.leadSessionId !== this.row.id) {
      const level = run.card.permissions ?? 'ask'
      if (level === 'everything' || (level === 'local' && (toolName === 'Bash' || effect !== 'external-write'))) {
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      }
    }
    // Brief sessions are headless (.docs/next-version.md): nobody is there to
    // answer a prompt, so the policy is fixed, reads and the brief's own write
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
          // Which call this is: the action record's "who allowed it" keys on it.
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
    if (pending.toolName === 'ExitPlanMode') {
      if (behavior === 'deny') pending.resolve({ behavior: 'deny', message: 'The user wants to keep planning. Wait for what they say should change, then revise the plan.' })
      else {
        // Out of plan mode, back to the session's own level, in the same answer, so nothing runs in between.
        const back = this.row.permissionMode ?? 'default'
        const sdkBack = back === 'gated' ? 'default' : back
        pending.resolve({ behavior: 'allow', updatedInput: pending.input, updatedPermissions: [{ type: 'setMode', mode: sdkBack, destination: 'session' }] })
        void this.planApproved(typeof pending.input.plan === 'string' ? pending.input.plan : '')
      }
    } else if (behavior === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'Denied by the user in the triage web UI.' })
    } else if (answers) {
      // AskUserQuestion: the picked labels ride back in on the tool's input,
      // which is where the tool reads the user's answer from.
      pending.resolve({
        behavior: 'allow',
        updatedInput: { ...pending.input, answers },
      })
    } else {
      // 'allow_always' is 'allow' plus the SDK's suggested rules, re-homed to
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

  /** Plan mode on or off, for the next turn on. Returns false when the subprocess can't switch (it is revived instead). */
  async setPlanning(on: boolean): Promise<boolean> {
    if (!this.q.setPlanning) return false
    try {
      await this.q.setPlanning(on, this.row.permissionMode ?? 'default')
      return true
    } catch {
      return false
    }
  }

  /**
   * You approved the plan: the session leaves plan mode and codes at its own
   * level, and the plan is kept as a file on the session and its item.
   */
  private async planApproved(plan: string): Promise<void> {
    this.row.planning = false
    await this.rt.store.sessions.setPlanning(this.row.id, false)
    broadcastSessionList(this.rt)
    // The SDK took the mode change with the answer; this makes sure, for agents that don't.
    await this.q.setPlanning?.(false, this.row.permissionMode ?? 'default').catch(() => {})
    if (!plan.trim()) return
    try {
      const title = `Plan · ${this.row.title || 'session'}`.slice(0, 120)
      const artifact = await this.rt.artifacts.writeAt(`plans/${this.row.id}.md`, { title, body: plan, author: 'model' })
      await this.rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'session', toId: this.row.id, role: 'plan' })
      const itemId = this.rt.sessionItem.get(this.row.id)
      if (itemId) await this.rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: itemId, role: 'plan' })
      this.notice(`Plan approved — kept as ${artifact.path}. Coding at the session's own permission level.`)
    } catch (err) {
      log('warn', 'sessions', `could not save the plan: ${errText(err)}`, { session: this.row.id, workspace: this.rt.meta.id })
    }
  }

  /**
   * Switch how much this session asks, for every turn from here on.
   *
   * Returns false when the running subprocess cannot take the switch. The
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
   * it to pass the text on with SendMessage, which also resumes an agent that
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
