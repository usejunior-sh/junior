import type { Connector, ModelOption } from './catalog.js'

export type SessionStatus = 'starting' | 'idle' | 'running' | 'error'

// Workspaces (.docs/workspaces.md): the top-level scope isolating work from
// personal. Each workspace has its own DB (projects, inbox, jobs, sessions)
// and its own Claude auth backend. Every HTTP request and WS connection is
// bound to exactly one workspace (?workspace= param, else the triage_ws
// cookie, else the default).

/**
 * How a workspace's Claude subprocesses authenticate:
 * - `inherit`, no overrides; the machine's own ~/.claude login (and its
 *   claude.ai connectors), exactly like before workspaces existed.
 * - `api-key`, spawned with ANTHROPIC_API_KEY from the workspace's .env.
 *   Billed to the key; NO claude.ai connectors (they ride the claude.ai
 *   login), so Slack jobs don't run here. `gh` is unaffected.
 * - `config-dir`: spawned with CLAUDE_CONFIG_DIR pointing into the workspace:
 *   a separate claude.ai login with its own subscription and connectors.
 *   Needs a one-time interactive login (see `loginCommand`).
 */
export type WorkspaceAuthBackend = 'inherit' | 'api-key' | 'config-dir'

export type Workspace = {
  id: string
  name: string
  /** hex color: the ambient "which world am I in" signal in the UI */
  color: string
  description?: string
  authBackend: WorkspaceAuthBackend
  isDefault: boolean
  /** api-key backend: masked tail of the stored key ("…abcd"); null = none yet */
  apiKeyHint?: string | null
  /** config-dir backend: where that login lives, and the one-time login command */
  configDir?: string
  loginCommand?: string
  /** Every agent triage knows, connected or not, the primary (Claude) first. */
  providers: WorkspaceProvider[]
  createdAt: number
}

/**
 * One agent as a workspace has it set up. The primary runs everything,
 * jobs, briefs, team workers, and is always connected; its auth is the
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

/** One plan window, "5-hour", "Weekly", a spend cap, as a share used. */
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
    /** "chatgpt", "apiKey", "claude.ai", …, how it is signed in */
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

/** GET /api/providers: the workspace's connected agents, live. */
export type ProvidersStatusResponse = { ok: true; providers: ProviderStatus[] } | { ok: false; error: string }

/** POST /api/providers/verify: one real round-trip with a provider's auth. */
export type ProviderVerifyResponse = { ok: true; authOk: boolean; authError?: string } | { ok: false; error: string }

export type WorkspacesResponse =
  | { ok: true; workspaces: Workspace[]; defaultId: string; onboarded: boolean }
  | { ok: false; error: string }

export type WorkspaceResponse = { ok: true; workspace: Workspace } | { ok: false; error: string }

/**
 * POST /api/workspaces/verify: a live probe with the workspace's own env.
 * `authOk` is a real auth check (a one-turn headless prompt) for api-key and
 * config-dir backends. The model catalog alone doesn't prove a key works.
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
export type SessionKind = 'chat' | 'job-run' | 'brief' | 'goal' | 'task'

/**
 * The coding agent a session runs on, fixed for its life. Chats can pick;
 * jobs, briefs and team workers are always `claude`.
 */
export const PROVIDER_IDS = ['claude', 'codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]
export const isProviderId = (v: unknown): v is ProviderId => PROVIDER_IDS.includes(v as ProviderId)
