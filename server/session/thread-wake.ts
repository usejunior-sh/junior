/**
 * Thread reports wake the DM that started them (core/junior/thread-wake.ts has
 * the rules). Reports queue per parent DM; a parent mid-turn or waiting on a
 * prompt gets them after its turn, never in the middle of it, and reports that
 * arrive together go out as one wake. Kept in memory: a restart drops a queued
 * wake, and the notice line in the DM still says what happened.
 */
import {
  allowAnswer,
  closeReportTurn,
  coalesce,
  decideWake,
  newGuard,
  noteAnswer,
  noteUserInThread,
  openReportTurn,
  type ThreadReport,
  type WakeGuard,
  wakeFrom,
  wakeMessage,
} from '../../core/junior/thread-wake.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { getOrRevive } from './sessions.js'

/** How long a report waits for others to fold into the same wake. */
const COALESCE_MS = 1500

type Pending = { report: ThreadReport; answer: boolean }
type State = { guards: Map<string, WakeGuard>; queue: Map<string, Pending[]>; timers: Map<string, ReturnType<typeof setTimeout>> }

const states = new WeakMap<WorkspaceRuntime, State>()

function stateOf(rt: WorkspaceRuntime): State {
  let s = states.get(rt)
  if (!s) states.set(rt, (s = { guards: new Map(), queue: new Map(), timers: new Map() }))
  return s
}

function guardOf(rt: WorkspaceRuntime, parentId: string): WakeGuard {
  const s = stateOf(rt)
  let g = s.guards.get(parentId)
  if (!g) s.guards.set(parentId, (g = newGuard()))
  return g
}

/** A thread's report for its parent: queued for a wake when the parent is a DM, else nothing. */
export function queueThreadReport(rt: WorkspaceRuntime, parentId: string, report: ThreadReport): void {
  const parent = rt.rows.get(parentId)
  const decision = decideWake(parent?.kind, report, guardOf(rt, parentId), Date.now())
  if (!decision.wake) {
    if (parent?.kind === 'dm') log('info', 'session', `thread report did not wake its DM: ${decision.why}`, { sessionId: parentId })
    return
  }
  const s = stateOf(rt)
  s.queue.set(parentId, [...(s.queue.get(parentId) ?? []), { report, answer: decision.answer }])
  schedule(rt, parentId)
}

function schedule(rt: WorkspaceRuntime, parentId: string): void {
  const s = stateOf(rt)
  if (s.timers.has(parentId)) return
  s.timers.set(
    parentId,
    setTimeout(() => {
      s.timers.delete(parentId)
      void flush(rt, parentId).catch((err) => log('warn', 'session', `could not wake a DM with a thread report: ${errText(err)}`, { sessionId: parentId }))
    }, COALESCE_MS),
  )
}

async function flush(rt: WorkspaceRuntime, parentId: string): Promise<void> {
  const s = stateOf(rt)
  const queued = s.queue.get(parentId)
  if (!queued?.length) return
  // Mid-turn or waiting on the user: its turn's end flushes (dmTurnEnded).
  if (rt.live.get(parentId)?.busy) return
  s.queue.delete(parentId)
  const reports = coalesce(queued.map((p) => p.report))
  // A thread is answerable only if every report of it that folded in was.
  const answerable = new Set(reports.filter((r) => queued.filter((p) => p.report.threadId === r.threadId).every((p) => p.answer)).map((r) => r.threadId))
  const live = await getOrRevive(rt, parentId)
  if (!live) return
  openReportTurn(guardOf(rt, parentId), reports, answerable, Date.now())
  await live.sendUserMessage(wakeMessage(reports, answerable), undefined, undefined, {
    from: wakeFrom(reports),
    ...(reports.length === 1 ? { fromSession: reports[0].threadId } : {}),
    report: true,
  })
}

/** A DM's turn ended: its report turn closes, and what queued meanwhile goes out. */
export function dmTurnEnded(rt: WorkspaceRuntime, parentId: string): void {
  const s = states.get(rt)
  if (!s) return
  const g = s.guards.get(parentId)
  if (g) closeReportTurn(g)
  if (s.queue.get(parentId)?.length) schedule(rt, parentId)
}

/** The DM `fromId` messages `targetId`: throws when the loop guard says no; an allowed auto-answer is counted. */
export function checkAnswer(rt: WorkspaceRuntime, fromId: string, targetId: string): void {
  const g = states.get(rt)?.guards.get(fromId)
  if (!g) return
  const ok = allowAnswer(g, targetId)
  if (!ok.ok) throw new Error(ok.why)
  if (ok.auto) noteAnswer(g, targetId)
}

/** The user wrote in a thread themselves: its next report may be answered again. */
export function threadUserMessage(rt: WorkspaceRuntime, threadId: string, parentId: string | undefined): void {
  const g = parentId ? states.get(rt)?.guards.get(parentId) : undefined
  if (g) noteUserInThread(g, threadId)
}
