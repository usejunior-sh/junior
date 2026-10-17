import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { SessionSummary } from '../../../shared/protocol.js'
import { useTeamRun, type TeamSideTab } from '../components/TeamRun.js'
import { type RunsView, useRunScroll, runMarks } from '../components/TeamRail.js'
import { useEvents } from '../hooks.js'
import type { Navigate, TabsApi } from './types.js'

export function useTeamRail({ current, currentId, events, mobile, navigate, openTab, sessions }: {
  current: SessionSummary | null
  currentId: string | null
  events: ReturnType<typeof useEvents>
  mobile: boolean
  navigate: Navigate
  openTab: TabsApi['open']
  sessions: readonly SessionSummary[]
}) {
  // A team run in this session: one fetch shared by the strip, the dock and the details drawer.
  const teamRun = useTeamRun(current?.teamRun)
  const [teamSide, setTeamSide] = useState(false)
  const [teamTab, setTeamTab] = useState<TeamSideTab>('runs')
  const [runsView, setRunsView] = useState<RunsView>('person')
  // The run rail (desktop): the team's runs in the drawer beside the transcript, and a run to scroll to once its session is up.
  const railOn = !!teamRun && !mobile
  const [teamJump, setTeamJump] = useState<{ sessionId: string; runId: string } | null>(null)
  // Arriving at a session of a team under way opens the drawer on its runs, unless it's already open.
  // Once per session, and only once the session has loaded: a drawer you close stays closed.
  const inRun = !!current?.teamRun && current.teamRun.state !== 'proposed'
  const sideOpenedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!inRun || mobile || !currentId || sideOpenedFor.current === currentId) return
    sideOpenedFor.current = currentId
    if (teamSide) return
    setTeamTab('runs')
    setTeamSide(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, inRun])
  const runScroll = useRunScroll(currentId ?? '', railOn, `${events.length}:${teamRun?.rev ?? 0}`)
  useEffect(() => {
    if (!teamJump || teamJump.sessionId !== currentId) return
    // The divider is there once the history has loaded and the transcript has drawn it.
    const t = requestAnimationFrame(() => runScroll.jump(teamJump.runId) && setTeamJump(null))
    return () => cancelAnimationFrame(t)
  }, [teamJump, currentId, events.length, teamRun?.rev]) // eslint-disable-line react-hooks/exhaustive-deps
  const openTeamRun = useCallback(
    (sessionId: string, runId: string | null, newTab?: boolean) => {
      // ⌘-click: its own tab, behind this one; you stay where you are.
      if (newTab) return openTab(sessionId)
      setTeamJump(runId ? { sessionId, runId } : null)
      if (sessionId !== currentId) navigate(sessionId)
    },
    [currentId, openTab], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const teamMarks = useMemo(() => (railOn && teamRun && currentId ? runMarks(teamRun, currentId) : undefined), [railOn, teamRun, currentId])
  const teamCheckoutId = (teamRun && sessions.find((s) => s.id === teamRun.leadSessionId)?.checkoutId) ?? current?.checkoutId ?? null

  return { teamRun, teamSide, setTeamSide, teamTab, setTeamTab, runsView, setRunsView, railOn, runScroll, openTeamRun, teamMarks, teamCheckoutId }
}
