import type { TeamRecipe } from '../../core/teams/recipe.js'
import type { ChatAgent } from '../../core/junior/agents.js'
import type { EffortLevel } from './session.js'

// Teams v2 (server/teams.ts, core/teams/recipe.ts): a team is a recipe file
// (steps, fan-out, gates, budget), filled in by agents, which are Claude Code
// agent files. Both live in the workspace folder, seeded with defaults.

/** What an agent may do. Compiled to tool rules at spawn, never a prompt-only promise. */
export type AgentCan = 'read' | 'edit' | 'run' | 'web' | 'browser'
export const AGENT_CANS: AgentCan[] = ['read', 'edit', 'run', 'web', 'browser']

/** Claude Code's own agent colours. */
export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

/** One agent: the fields of a Claude Code agent file junior understands. */
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
 * Where a library file stands against what junior ships: untouched, edited,
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

// Skills and agents (server/library.ts): every Claude Code skill and subagent a
// session can see: the workspace's own (a local plugin, `junior:<name>`), the
// user's (~/.claude), each project's (.claude/), and installed plugins' (read-only).

export type LibraryKind = 'skill' | 'agent'
export type LibrarySource = 'workspace' | 'personal' | 'project' | 'plugin'

export type LibraryEntry = {
  kind: LibraryKind
  /** what Claude calls it: `/name` or the subagent type; `junior:name` / `plugin:name` when namespaced */
  name: string
  /** the folder (skill) or file stem (agent) */
  slug: string
  description: string
  source: LibrarySource
  /** where it comes from, said plainly: Personal, a project's name, a plugin's name, the workspace */
  scope: string
  /** SKILL.md, or the agent's .md */
  path: string
  /** false for plugins: the plugin manager rewrites their files */
  editable: boolean
  /** agents: frontmatter extras */
  model?: string
  color?: string
  tools?: string
  /** agents: `chat: true`, so a chat can talk as it (core/junior/agents.ts) */
  chat?: boolean
  /** skills: how many files sit beside SKILL.md */
  files?: number
}

/** A place a new skill or agent can be made: 'workspace', 'personal', or 'project:<folder>'. */
export type LibraryTarget = { id: string; label: string; dir: string }

export type LibraryListResponse =
  | { ok: true; entries: LibraryEntry[]; targets: LibraryTarget[] }
  | { ok: false; error: string }

/** The agents a chat can talk as (core/junior/agents.ts). */
export type ChatAgentsResponse = { ok: true; agents: ChatAgent[] } | { ok: false; error: string }

/** One file of a skill or agent. `files` lists a skill folder's files relative to it. */
export type LibraryFileResponse =
  | { ok: true; path: string; text: string; editable: boolean; binary: boolean; files: string[]; dir: string }
  | { ok: false; error: string }
