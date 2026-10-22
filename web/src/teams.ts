/**
 * Teams v2 on the client (.docs/teams.md): the library fetch, the API calls a
 * run's card and strip make, and the display helpers both share.
 */
import { useEffect, useState } from 'react'
import type {
  AgentCan,
  AgentColor,
  AgentEntry,
  RecipeEntry,
  SessionSummary,
  TeamGoalSummary,
  TeamGoalsResponse,
  TeamLibraryResponse,
  TeamPickerResponse,
  TeamRunResponse,
  TeamRunView,
} from '../../shared/protocol.js'

export type TeamLibrary = { teams: RecipeEntry[]; agents: AgentEntry[]; dir: string }

export async function loadTeamLibrary(): Promise<TeamLibrary> {
  const b = (await (await fetch('/api/teams/library')).json()) as TeamLibraryResponse
  if (!b.ok) throw new Error(b.error)
  return { teams: b.teams, agents: b.agents, dir: b.dir }
}

/** POST/PUT/DELETE a /api/teams route; the parsed body comes back on success. */
export async function teamsCall<T = TeamLibraryResponse>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/teams/${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const b = (await res.json()) as { ok: boolean; error?: string }
  if (!b.ok) throw new Error(b.error ?? 'request failed')
  return b as T
}

export async function loadTeamPicker(kind: string): Promise<Extract<TeamPickerResponse, { ok: true }>> {
  const b = (await (await fetch(`/api/teams/picker?kind=${encodeURIComponent(kind)}`)).json()) as TeamPickerResponse
  if (!b.ok) throw new Error(b.error)
  return b
}

export async function loadTeamRun(runId: string): Promise<TeamRunView> {
  const b = (await (await fetch(`/api/teams/run?runId=${encodeURIComponent(runId)}`)).json()) as TeamRunResponse
  if (!b.ok) throw new Error(b.error)
  return b.run
}

/** The lead session of a run, read off the session list. */
export const leadOf = (sessions: readonly SessionSummary[], runId: string): SessionSummary | undefined =>
  sessions.find((s) => s.teamRun?.id === runId && s.teamRun.role === 'lead')

/** Claude Code's agent colours, drawn from the palette's accents where one exists. */
export const AGENT_HEX: Record<AgentColor, string> = {
  red: 'var(--red)',
  blue: 'var(--blue)',
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  purple: '#b48cff',
  orange: 'var(--orange)',
  pink: '#ff7ac8',
  cyan: '#4de1ff',
}

/** A worker's colour; the lead (and Junior's own checks) draw in ink. */
export const colorOf = (c: string): string => AGENT_HEX[c as AgentColor] ?? 'var(--ink)'

export const CAN_META: Record<AgentCan, { label: string; hint: string; short: string }> = {
  read: { label: 'Read code', hint: 'Read and search the project', short: 'reads code' },
  edit: { label: 'Edit files', hint: 'Change files — only on the step that changes files', short: 'edits files' },
  run: { label: 'Run commands', hint: 'Tests, builds, scripts — asks first', short: 'runs commands' },
  web: { label: 'Web', hint: 'Search and fetch pages', short: 'web' },
  browser: { label: 'Browser', hint: 'Your chrome-devtools connector — the only one loaded', short: 'browser' },
}

export const canSummary = (can: AgentCan[]): string => (can.length ? can.map((c) => CAN_META[c].short).join(' · ') : 'reads only what it is sent')

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

export const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

/** A step as one short line: "review ×4 · code-reviewer → findings". */
export function stepLine(s: { id: string; agent: string; output: string | null; fanOut: { by: string; max: number } | null }): string {
  return `${s.id}${s.fanOut ? ` ×${s.fanOut.max}` : ''}`
}

/** The three levels a team can run at (TeamPermissions), as the card offers them. */
export const PERMISSION_META: Record<'ask' | 'local' | 'everything', { label: string; hint: string }> = {
  ask: { label: 'Commands ask', hint: 'The builder’s edits run; every shell command asks you. You stay at the desk.' },
  local: { label: 'Local free, outbound held', hint: 'Edits and commands run unasked; anything that leaves this Mac waits for you. Start it and walk away.' },
  everything: { label: 'Everything runs', hint: 'Nothing asks and nothing is held — pushes and posts included. Only for work you’d let go out unseen.' },
}

type TeamGoalsState = { goals: TeamGoalSummary[]; waitingOnYou: number; loaded: boolean; error: string | null }

/**
 * The Goals tab's list (GET /api/teams/goals): every team run that is a goal.
 * Refetched when any goal's lead moves on the session list (its run's state or
 * revision). The same cue the team strip and dock refetch on.
 */
export function useTeamGoals(sessions: readonly SessionSummary[]): TeamGoalsState {
  const [state, setState] = useState<TeamGoalsState>({ goals: [], waitingOnYou: 0, loaded: false, error: null })
  const cue = sessions
    .filter((s) => s.teamRun?.role === 'lead' && s.teamRun.goal)
    .map((s) => `${s.teamRun!.id}:${s.teamRun!.state}:${s.teamRun!.rev}`)
    .sort()
    .join(',')
  useEffect(() => {
    let live = true
    fetch('/api/teams/goals')
      .then((r) => r.json() as Promise<TeamGoalsResponse>)
      .then((b) => {
        if (!live) return
        setState(b.ok ? { goals: b.goals, waitingOnYou: b.goals.filter((g) => g.turn === 'you').length, loaded: true, error: null } : (s) => ({ ...s, loaded: true, error: b.error }))
      })
      .catch((err) => live && setState((s) => ({ ...s, loaded: true, error: String(err) })))
    return () => {
      live = false
    }
  }, [cue])
  return state
}
