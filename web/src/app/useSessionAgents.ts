import { useMemo, useState, useCallback } from 'react'
import type { SessionSummary } from '../../../shared/protocol.js'
import { buildAgents } from '../agents.js'
import { buildShells } from '../../../core/shells/fold.js'
import { useEvents } from '../hooks.js'
import { store } from '../store.js'

export function useSessionAgents({ events, current, currentId }: {
  events: ReturnType<typeof useEvents>
  current: SessionSummary | null
  currentId: string | null
}) {
  // Subagents: folded from the same events as the transcript. Opening one swaps
  // the transcript for its slice: remembered per session, so leaving and coming
  // back finds main again rather than an agent picked long ago.
  // With no subprocess behind the session, nothing it spawned can still be
  // running: a daemon restart ends them without a word in the log.
  const sessionLive = current?.live
  const agents = useMemo(() => {
    const runs = buildAgents(events, store.eventTime)
    if (sessionLive !== false) return runs
    return runs.map((r) => (r.state === 'running' ? { ...r, state: 'interrupted' as const, waiting: false } : r))
  }, [events, sessionLive])
  // Shells too: the transcript's Bash pills and the background dock read these.
  const shells = useMemo(() => {
    const runs = buildShells(events, store.eventTime)
    if (sessionLive !== false) return runs
    return runs.map((r) => (r.state === 'running' ? { ...r, state: 'interrupted' as const } : r))
  }, [events, sessionLive])
  const [agentPick, setAgentPick] = useState<{ sessionId: string; toolUseId: string } | null>(null)
  const openAgent = agentPick && agentPick.sessionId === currentId ? agents.find((a) => a.toolUseId === agentPick.toolUseId) ?? null : null
  const showAgent = useCallback(
    (toolUseId: string | null) => setAgentPick(toolUseId && currentId ? { sessionId: currentId, toolUseId } : null),
    [currentId],
  )

  return { agents, shells, openAgent, showAgent }
}
