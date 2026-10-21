/**
 * How a new chat works, the one choice New chat offers: Solo (Junior works
 * alone) or Ultracode (it fans big jobs out to subagents, .docs/ultracode.md).
 * Chosen once, at the start. "Plan first" is something you say, and the
 * protocol's 'plan' and 'goal' modes stay for the engine but are not offered
 * here (Triage for engineers, M0). How much it asks is not a choice: one
 * policy (core/actions/policy.ts) for every chat. Order is the Shift+Tab cycle.
 */
import type { SessionMode, SessionStatus, SessionSummary } from '../../shared/protocol.js'

export type SessionModeInfo = { id: SessionMode; name: string; description: string }

export const SESSION_MODE_INFO: SessionModeInfo[] = [
  { id: 'normal', name: 'Solo', description: 'Works alone, one step at a time.' },
  { id: 'ultracode', name: 'Ultracode', description: 'Fans big jobs out to many agents at once, then checks their work. Costs more.' },
]

export const findSessionMode = (id: SessionMode | undefined): SessionModeInfo => SESSION_MODE_INFO.find((m) => m.id === id) ?? SESSION_MODE_INFO[0]

export function nextSessionMode(id: SessionMode | undefined): SessionMode {
  const i = Math.max(0, SESSION_MODE_INFO.findIndex((m) => m.id === (id ?? 'normal')))
  return SESSION_MODE_INFO[(i + 1) % SESSION_MODE_INFO.length].id
}

/**
 * The status a session shows (header dot, sidebar row): an idle session with
 * Ultracode runs still going is working. The turn ended; its agents haven't.
 */
/** Junior is at work in it: a turn going, or Ultracode runs after one ended. */
export const isWorking = (s: Pick<SessionSummary, 'status' | 'workflows'>) => s.status === 'running' || s.status === 'starting' || (s.workflows ?? 0) > 0

export function shownStatus(s: Pick<SessionSummary, 'status' | 'workflows'>): { status: SessionStatus; title?: string } {
  const n = s.workflows ?? 0
  if (s.status !== 'idle' || n <= 0) return { status: s.status }
  return { status: 'running', title: n === 1 ? 'Ultracode run in progress' : `${n} Ultracode runs in progress` }
}
