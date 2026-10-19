/**
 * What Junior does before it starts, as the new-session composer's Mode chip
 * describes it. Separate from Autonomy, which is how much it asks while it
 * works. 'normal' is "Junior decides": it starts small tasks and suggests a
 * plan or a goal when the hand-off looks bigger (shared/triageContext.ts), so
 * the others are overrides, not a choice you must make. Ultracode is the odd
 * one out: not how a job starts but how big jobs run for the whole session
 * (.docs/ultracode.md). Order is the Shift+Tab cycle.
 */
import type { SessionMode, SessionStatus, SessionSummary } from '../../shared/protocol.js'

export type SessionModeInfo = { id: SessionMode; name: string; description: string }

export const SESSION_MODE_INFO: SessionModeInfo[] = [
  { id: 'normal', name: 'Junior decides', description: 'Starts small tasks right away. Suggests a plan or a goal when it looks bigger.' },
  { id: 'plan', name: 'Plan first', description: 'Reads and writes a plan, edits nothing. You approve it, then it codes.' },
  { id: 'goal', name: 'Goal', description: 'Proposes a team with a done-when. It keeps going, round after round, until it’s done.' },
  { id: 'ultracode', name: 'Ultracode', description: 'Fans big jobs out to many agents at once, then checks their work. Costs more.' },
]

export const findSessionMode = (id: SessionMode | undefined): SessionModeInfo => SESSION_MODE_INFO.find((m) => m.id === id) ?? SESSION_MODE_INFO[0]

export function nextSessionMode(id: SessionMode | undefined): SessionMode {
  const i = SESSION_MODE_INFO.findIndex((m) => m.id === (id ?? 'normal'))
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
