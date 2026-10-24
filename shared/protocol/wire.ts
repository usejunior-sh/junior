import type { FileRef, ImageAttachment } from './attachments.js'
import type { BriefJob } from './briefs.js'
import type { SlashCommandInfo } from './catalog.js'
import type { Mention, ResolvedMention } from './mentions.js'
import type { Checkout, CreateStep } from './projects.js'
import type { SdkMessage } from './sdk.js'
import type { EffortLevel, PermissionBehavior, PermissionMode, RewindResult, SessionMode, SessionSummary, ToolEffect } from './session.js'
import type { Build } from './system.js'
import type { ProviderId, Workspace } from './workspace.js'

// Session events (the replay log, and the live stream)

export type SessionEvent =
  | { kind: 'sdk'; message: SdkMessage }
  | {
      kind: 'local_user'
      text: string
      images?: ImageAttachment[]
      /** files saved under the session's attachments folder */
      files?: FileRef[]
      mentions?: ResolvedMention[]
      /** who sent it when it wasn't the user. A teammate agent's label, or 'junior'; absent = the user */
      from?: string
      /** the session that sent it (start_session / message_session), so its badge links back */
      fromSession?: string
      /** A message the user wrote to a subagent, relayed to it through the main agent. */
      relay?: AgentRelay
      /** sent in Goal mode: Junior proposes a goal for it */
      mode?: 'goal'
      /**
       * The id the agent keeps this turn under: rewind_files can put the files
       * back to how they were before it. Claude chats only; absent on older logs.
       */
      messageId?: string
    }
  | { kind: 'error'; message: string }
  /** a line Junior writes into the transcript itself. A team paused, a stage began */
  | { kind: 'notice'; text: string }
  /**
   * A new Claude subprocess took over a session that already had history (a
   * revival after the last one ended). Whatever the old one had running,
   * subagents, background shells, ended with it. Written by Junior, because
   * the SDK's own `init` arrives at the start of every turn, not once per process.
   * `fresh`: started without resume, so its cost counters start from zero.
   */
  | { kind: 'subprocess'; fresh?: boolean }
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
      /** Set when the agent asking is one of an Ultracode Workflow run's: that run's task id. */
      workflowTaskId?: string
      /** The tool_use this prompt is about: how an action record learns who allowed it. Absent on older logs. */
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

// Terminals: PTY-backed shells the daemon runs for the browser. Ephemeral:
// they live in the daemon's memory and die with it, so nothing here is stored.

/**
 * GET / POST /api/remote: phone access (server/remote.ts). Only this machine
 * sees the token; a paired device gets `{ local: false }`.
 */
export type RemoteStatus =
  | { local: false }
  | {
      local: true
      enabled: boolean
      /** the pairing token: the QR code carries it; never shown as text */
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

/** server/tunnel.ts: the ngrok tunnel behind "Anywhere". */
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
      /** Upload ids of files attached to that first message. */
      files?: string[]
      /** `@` mentions in that first message, resolved against `cwd`. */
      mentions?: Mention[]
      model?: string
      effort?: EffortLevel
      /** Plan: start in plan mode. Goal: the first message is a goal. Ultracode: the session runs with ultracode on. Omitted = normal. */
      mode?: SessionMode
      fastMode?: boolean
      /** The agent to run on, for the session's whole life. Omitted = 'claude'. */
      provider?: ProviderId
      /** The work item this session is dispatched for, recorded as a `dispatch` link. */
      itemId?: string
    }
  /** Switch a session's model/effort: mid-session, and for every turn after. */
  | { type: 'set_model'; sessionId: string; model?: string; effort?: EffortLevel }
  /** Turn fast mode on or off: mid-session, and for every turn after. */
  | { type: 'set_fast_mode'; sessionId: string; fastMode: boolean }
  /** Plan mode on or off, mid-session. (Goal rides on the message: user_message.mode; Ultracode has set_ultracode.) */
  | { type: 'set_session_mode'; sessionId: string; mode: Exclude<SessionMode, 'goal' | 'ultracode'> }
  /** Ultracode on or off, mid-session, for every turn after. Runs already going carry on. */
  | { type: 'set_ultracode'; sessionId: string; on: boolean }
  /** Give a session a new title. */
  | { type: 'rename_session'; sessionId: string; title: string }
  /** Pin a session to the top of the list, or unpin it. */
  | { type: 'set_pinned'; sessionId: string; pinned: boolean }
  /** Delete a session and its transcript. Irreversible: the UI confirms. */
  | { type: 'delete_session'; sessionId: string }
  /**
   * Replay a session's log, then stream. `paged`: send only the newest page
   * (`limit` events at most, cut on a turn) with `hasEarlier`; older pages come
   * from session_events_before. Without it the whole log is sent, as before.
   */
  | { type: 'subscribe'; sessionId: string; paged?: boolean; limit?: number }
  /** The page of a session's log just before `beforeSeq`: answered by session_events_page. */
  | { type: 'session_events_before'; sessionId: string; beforeSeq: number; limit?: number }
  | { type: 'user_message'; sessionId: string; text: string; images?: ImageAttachment[]; files?: string[]; mentions?: Mention[]; mode?: 'goal' }
  | {
      type: 'permission_response'
      sessionId: string
      requestId: string
      behavior: PermissionBehavior
      /** Set only for AskUserQuestion prompts: folded into the tool's input. */
      answers?: QuestionAnswers
    }
  | { type: 'interrupt'; sessionId: string }
  /** Stop one running task: a subagent, or a shell by its task id (`stopTask`). */
  | { type: 'agent_stop'; sessionId: string; agentId: string }
  /** Let the main agent carry on while a foreground subagent keeps running. */
  | { type: 'agent_background'; sessionId: string; toolUseId: string }
  /** A message for a subagent: relayed by the main agent with SendMessage, since the SDK can't address one directly. */
  | { type: 'agent_message'; sessionId: string; relay: AgentRelay; text: string }
  /**
   * Put a chat's files back to how they were before one of its messages
   * (`messageId` off its `local_user` event). `dryRun` only lists what would
   * change and touches nothing; only an exact `false` rewinds. Answered by
   * rewind_result, to this socket.
   */
  | { type: 'rewind_files'; sessionId: string; messageId: string; dryRun: boolean }
  /** Open a shell in `cwd` (default: the project's folder); `command` is typed in first, if given. */
  | { type: 'terminal_create'; cwd?: string; projectId?: string; checkoutId?: string; title?: string; command?: string }
  /** Keystrokes / pasted text: raw, exactly as the terminal emulator produced them. */
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
      /** which copy of Junior this socket is talking to, the UI badges it */
      build: Build
      /** the workspace's Junior persona: the rail's name and face colour from the first frame */
      persona: import('../../core/junior/persona.js').Persona
    }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session_created'; session: SessionSummary }
  | { type: 'session_deleted'; sessionId: string }
  /**
   * `times[i]` is when `events[i]` was stored (ms epoch), so the transcript can
   * say how long a run of tool calls took. Absent for an in-memory dry run.
   */
  | {
      type: 'history'
      sessionId: string
      events: SessionEvent[]
      times?: number[]
      /**
       * Set only for a paged subscribe. `hasEarlier`: older events exist;
       * `firstSeq`: the seq of `events[0]`, the `beforeSeq` that asks for them.
       */
      hasEarlier?: boolean
      firstSeq?: number
    }
  /**
   * One older page of a session's log, oldest first, answering
   * session_events_before. `beforeSeq` echoes the request, so a stale answer
   * can be told apart. An unknown session gets an empty page.
   */
  | {
      type: 'session_events_page'
      sessionId: string
      beforeSeq: number
      events: SessionEvent[]
      times: number[]
      hasEarlier: boolean
      firstSeq?: number
    }
  /** `at` is when the server saw the event (ms epoch). */
  | { type: 'session_event'; sessionId: string; event: SessionEvent; at?: number }
  | { type: 'terminals'; terminals: TerminalSummary[] }
  /** A create_session from this socket that makes a worktree, step by step. The draft shows where it's got to. */
  | { type: 'create_progress'; step: CreateStep }
  /** A create_session from this socket failed (e.g. the worktree couldn't be made). The draft stays open to say so. */
  | { type: 'create_failed'; message: string }
  /** The workspace's checkouts changed: a worktree appeared or went, a branch moved. The whole list. */
  | { type: 'checkouts'; checkouts: Checkout[] }
  | { type: 'terminal_created'; terminal: TerminalSummary }
  /** The scrollback so far: sent once per subscribe, before live output resumes. */
  | { type: 'terminal_history'; terminalId: string; data: string }
  | { type: 'terminal_output'; terminalId: string; data: string }
  | { type: 'terminal_exit'; terminalId: string; exitCode: number }
  | { type: 'terminal_closed'; terminalId: string }
  /** The artifacts index changed (a write, a delete, or a re-index found edits), refetch. */
  | { type: 'artifacts_changed' }
  /** A skill or agent file changed (the settings editor, or a session wrote one), refetch. */
  | { type: 'library_changed' }
  /** A work item was created, edited or moved (by a chat, a job, another tab), refetch the inbox. */
  | { type: 'inbox_changed' }
  /**
   * A folder's `/` command list changed: a session's subprocess discovered
   * skills mid-run, or a probe just finished. Carries the whole list because
   * the SDK's own contract is replace-don't-merge, and it is small.
   */
  | { type: 'commands_changed'; cwd: string; commands: SlashCommandInfo[] }
  /** A session's turn ended (or its repo moved). The changes view should refetch. */
  | { type: 'session_changed'; sessionId: string }
  /** A brief job moved (queued → running → ready | failed); the item page and inbox row follow. */
  | { type: 'brief_status'; job: BriefJob }
  /** An action was recorded or settled (or the actions file changed), refetch the Actions page, the item, the transcript's lines. */
  | { type: 'actions_changed'; sessionId?: string }
  /** Advance approvals changed (added, revoked, used): Settings → Approvals and Rule cards refetch. */
  | { type: 'approvals_changed' }
  /** Learnings changed (proposed, kept, edited, forgotten, expired): Junior's notebook refetches. */
  | { type: 'learnings_changed' }
  /** The workspace's Junior persona changed (About me, or a chat's set_reply_style), the whole persona. */
  | { type: 'persona'; persona: import('../../core/junior/persona.js').Persona }
  /** Today's plan changed (a row added or removed, the day drafted), refetch. */
  | { type: 'today_changed' }
  /** The browser profiles changed (machine-wide: sent to every workspace): the whole list. */
  | { type: 'browser_profiles'; profiles: import('./browser.js').BrowserProfile[]; workspaceDefault: string }
  /** A session's tab moved: its profile, URL or title (what the pane's chip and revive state show). */
  | { type: 'browser_tab'; tab: import('./browser.js').BrowserTabInfo }
  /** A session's tab downloaded a file (or refused one). */
  | { type: 'browser_download'; download: import('./browser.js').BrowserDownload }
  /** The answer to a rewind_files from this socket. */
  | { type: 'rewind_result'; result: RewindResult }
  | { type: 'error'; message: string }
