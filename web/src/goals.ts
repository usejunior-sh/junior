/**
 * Goals on the client: the list (`GET /api/goals`) and one goal's page
 * (`GET /api/goals/<id>`), both refetched when the server sends
 * `goals_changed`. Goals are written by Junior through the goal_* tools and by
 * `triage goal`; the UI's one write is the plan review (GoalPage → POST
 * /api/goals/<id>/comment | approve | send-back).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GoalResponse, GoalsResponse, GoalSummary } from '../../shared/protocol.js'
import { store } from './store.js'

type GoalsState = { goals: GoalSummary[]; waitingOnYou: number; loaded: boolean; error: string | null }

const EMPTY_LIST: GoalsState = { goals: [], waitingOnYou: 0, loaded: false, error: null }

/** Refetch on `goals_changed`, coalesced: one plan write is a burst of frames. */
function useOnGoalsChanged(load: () => Promise<void>, goalId?: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    void load()
    const off = store.onGoalsChanged((id) => {
      if (goalId && id && id !== goalId) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(), 200)
    })
    return () => {
      off()
      clearTimeout(timer.current)
    }
  }, [load, goalId])
}

/** Every goal, most recently touched first, plus how many wait on you. */
export function useGoals(): GoalsState {
  const [state, setState] = useState<GoalsState>(EMPTY_LIST)
  const load = useCallback(async () => {
    try {
      const body = (await (await fetch('/api/goals')).json()) as GoalsResponse
      setState(body.ok ? { goals: body.goals, waitingOnYou: body.waitingOnYou, loaded: true, error: null } : (s) => ({ ...s, loaded: true, error: body.error }))
    } catch (err) {
      setState((s) => ({ ...s, loaded: true, error: String(err) }))
    }
  }, [])
  useOnGoalsChanged(load)
  return state
}

export type GoalPageState = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; data: Extract<GoalResponse, { ok: true }> }

/** One goal: its record, run-time state and ledger files. */
export function useGoal(id: string): GoalPageState {
  const [state, setState] = useState<GoalPageState>({ phase: 'loading' })
  const load = useCallback(async () => {
    try {
      const body = (await (await fetch(`/api/goals/${encodeURIComponent(id)}`)).json()) as GoalResponse
      setState(body.ok ? { phase: 'ready', data: body } : { phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [id])
  useOnGoalsChanged(load, id)
  return state
}

export const goalHash = (id: string) => `/goals/${encodeURIComponent(id)}`
