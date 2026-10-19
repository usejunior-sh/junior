import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionEvent, WorkflowAgent, WorkflowAgentResponse, WorkflowAgentTranscript, WorkflowDetail, WorkflowDetailResponse, WorkflowRun } from '../../../shared/protocol.js'

/** How often a running run (and a running agent's transcript) is read again off disk. */
const POLL_MS = 3000

const runUrl = (sessionId: string, taskId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(taskId)}`

/** Reads that fail in a row before a running run stops being polled: the answer won't change. */
const MAX_MISSES = 3

/**
 * One fetch per run, however many places show it (the card, the dock, the
 * panel, an agent's view). Each place says whether the run is still going;
 * while any does, the run is polled. When it settles it is read once more,
 * and, if this page saw it running, again a beat later, since the run's state
 * file can land after the stream says it ended.
 */
type Entry = {
  view: WorkflowDetailState
  /** Reads that failed in a row. */
  misses: number
  listeners: Set<() => void>
  watchers: Map<number, boolean>
  timer?: ReturnType<typeof setTimeout>
  /** The read a beat after it settles: on the entry, so leaving the session doesn't cancel it. */
  followUp?: ReturnType<typeof setTimeout>
  inflight: boolean
  /** Seen running on this page, so its settling is worth a second read. */
  seenRunning: boolean
  settledRead: boolean
}

/** The disk-only extras for a run, and why the last read failed (null: it didn't, or none yet). */
export type WorkflowDetailState = { detail: WorkflowDetail | null; error: string | null }

const NOTHING: WorkflowDetailState = { detail: null, error: null }
const entries = new Map<string, Entry>()
let watcherSeq = 0

function entryOf(key: string): Entry {
  let e = entries.get(key)
  if (!e) entries.set(key, (e = { view: NOTHING, misses: 0, listeners: new Set(), watchers: new Map(), inflight: false, seenRunning: false, settledRead: false }))
  return e
}

async function load(e: Entry, url: string) {
  if (e.inflight) return
  e.inflight = true
  try {
    const r = await fetch(url)
    const body = (await r.json().catch(() => null)) as WorkflowDetailResponse | null
    if (body?.ok) {
      e.misses = 0
      e.view = { detail: body.workflow, error: null }
    } else {
      e.misses += 1
      e.view = { detail: e.view.detail, error: body?.error ?? `The server answered ${r.status}.` }
    }
    e.listeners.forEach((f) => f())
  } catch {
    // The daemon restarting; the next read tries again.
  }
  e.inflight = false
}

const anyRunning = (e: Entry) => [...e.watchers.values()].some(Boolean)

function schedule(e: Entry, url: string) {
  clearTimeout(e.timer)
  if (!anyRunning(e) || e.misses >= MAX_MISSES) return
  e.timer = setTimeout(() => void load(e, url).then(() => schedule(e, url)), POLL_MS)
}

/** The disk-only extras for a run: cost, script, result, logs; null until read (or with no task id yet). */
export function useWorkflowDetail(sessionId: string, run: WorkflowRun | null | undefined): WorkflowDetailState {
  const taskId = run?.taskId
  const running = run?.state === 'running'
  const key = taskId ? `${sessionId}\0${taskId}` : null
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {}
      const e = entryOf(key)
      e.listeners.add(cb)
      return () => void e.listeners.delete(cb)
    },
    [key],
  )
  const get = useCallback(() => (key ? (entries.get(key)?.view ?? NOTHING) : NOTHING), [key])
  const view = useSyncExternalStore(subscribe, get)
  useEffect(() => {
    if (!key || !taskId) return
    const e = entryOf(key)
    const url = runUrl(sessionId, taskId)
    const id = ++watcherSeq
    e.watchers.set(id, running)
    if (running) {
      e.seenRunning = true
      if (!e.view.detail) void load(e, url)
      schedule(e, url)
    } else if (!e.settledRead) {
      e.settledRead = true
      void load(e, url)
      if (e.seenRunning) {
        clearTimeout(e.followUp)
        e.followUp = setTimeout(() => void load(e, url), POLL_MS)
      }
    } else if (!e.view.detail?.state && e.misses < MAX_MISSES) {
      // Settled, but the last read came before its state file did.
      void load(e, url)
    }
    return () => {
      e.watchers.delete(id)
      if (!anyRunning(e)) clearTimeout(e.timer)
    }
  }, [key, sessionId, taskId, running])
  return view
}

/**
 * The run as the panel draws it: the live fold, with the state file's phases
 * and agents filled in when the stream has none (an older session, a restart).
 */
export function mergeRun(run: WorkflowRun, detail: WorkflowDetail | null): WorkflowRun {
  if (!detail) return run
  const phases = run.phases.length ? run.phases : (detail.phases ?? [])
  const agents = run.agents.length ? run.agents : (detail.runAgents ?? [])
  return phases === run.phases && agents === run.agents ? run : { ...run, phases, agents }
}

export function useMergedRun(sessionId: string, run: WorkflowRun | null | undefined): { run: WorkflowRun | null; detail: WorkflowDetail | null; error: string | null } {
  const { detail, error } = useWorkflowDetail(sessionId, run)
  const merged = useMemo(() => (run ? mergeRun(run, detail) : null), [run, detail])
  return { run: merged, detail, error }
}

export type AgentTranscriptState = { transcript: WorkflowAgentTranscript | null; error?: string }

/** One workflow agent's messages, read off disk, polled while it runs. */
export function useWorkflowAgentTranscript(sessionId: string, taskId: string | undefined, agentId: string | undefined, running: boolean): AgentTranscriptState | null {
  const key = taskId && agentId ? `${sessionId}\0${taskId}\0${agentId}` : null
  const [data, setData] = useState<(AgentTranscriptState & { key: string }) | null>(null)
  useEffect(() => {
    if (!key || !taskId || !agentId) return
    const url = `${runUrl(sessionId, taskId)}/agents/${encodeURIComponent(agentId)}`
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const r = await fetch(url)
        const body = (await r.json().catch(() => null)) as WorkflowAgentResponse | null
        if (stop) return
        if (body?.ok) setData({ key, transcript: body.transcript })
        else setData((d) => ({ key, transcript: d?.key === key ? d.transcript : null, error: body?.error ?? `The server answered ${r.status}.` }))
      } catch {
        // The daemon restarting; the next tick tries again.
      }
      if (!stop && running) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [key, sessionId, taskId, agentId, running])
  return data && data.key === key ? data : null
}

/** A clock for fetched events: their times ride beside them rather than in the store. */
export function useEventTimes(t: WorkflowAgentTranscript | null | undefined): (ev: SessionEvent) => number | undefined {
  return useMemo(() => {
    const m = new Map<SessionEvent, number>()
    t?.events.forEach((ev, i) => {
      const at = t.times[i]
      if (typeof at === 'number') m.set(ev, at)
    })
    return (ev: SessionEvent) => m.get(ev)
  }, [t])
}

export type WorkflowSideTab = 'agents' | 'script' | 'result'

/**
 * The run panel (right drawer) and a workflow agent's view, per session. The
 * panel opens by itself the first time a run is launched in the session you're
 * looking at, not while its call waits on your OK (once per session; a panel
 * you close stays closed). `onOpenSide` lets the caller close the team drawer:
 * the two share one slot.
 */
export function useWorkflowRail({
  currentId,
  workflows,
  mobile,
  onOpenSide,
}: {
  currentId: string | null
  workflows: readonly WorkflowRun[]
  mobile: boolean
  onOpenSide?: () => void
}) {
  const [side, setSide] = useState<{ sessionId: string; toolUseId: string } | null>(null)
  const [tab, setTab] = useState<WorkflowSideTab>('agents')
  const [agentPick, setAgentPick] = useState<{ sessionId: string; toolUseId: string; index: number; agentId?: string } | null>(null)
  const openSideRef = useRef(onOpenSide)
  openSideRef.current = onOpenSide

  const sideRun = side && side.sessionId === currentId ? (workflows.find((r) => r.toolUseId === side.toolUseId) ?? null) : null
  const agentRun = agentPick && agentPick.sessionId === currentId ? (workflows.find((r) => r.toolUseId === agentPick.toolUseId) ?? null) : null

  const openedFor = useRef(new Set<string>())
  const live = workflows.find((r) => r.state === 'running' && r.launched)
  useEffect(() => {
    if (!currentId || !live || mobile || openedFor.current.has(currentId)) return
    openedFor.current.add(currentId)
    if (side?.sessionId === currentId) return
    setTab('agents')
    setSide({ sessionId: currentId, toolUseId: live.toolUseId })
    openSideRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, live?.toolUseId, mobile])

  const openRun = useCallback(
    (toolUseId: string) => {
      if (!currentId) return
      setSide({ sessionId: currentId, toolUseId })
      openSideRef.current?.()
    },
    [currentId],
  )
  const closeSide = useCallback(() => setSide(null), [])
  const openAgent = useCallback(
    (toolUseId: string, agent: Pick<WorkflowAgent, 'index' | 'agentId'>) => {
      if (currentId) setAgentPick({ sessionId: currentId, toolUseId, index: agent.index, agentId: agent.agentId })
    },
    [currentId],
  )
  const closeAgent = useCallback(() => setAgentPick(null), [])

  return {
    /** the run the panel shows, null = closed */
    sideRun,
    tab,
    setTab,
    openRun,
    closeSide,
    /** the workflow agent whose view replaces the transcript */
    agentView: agentRun && agentPick ? { run: agentRun, index: agentPick.index, agentId: agentPick.agentId } : null,
    openAgent,
    closeAgent,
  }
}
