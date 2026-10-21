import { flowOf, type FlowOverride, type FlowSignals, isStage, isTurn, type ItemFlow, type SessionSignal } from '../../core/work/flow.js'
import type { WorkItem as CoreWorkItem } from '../../core/work/types.js'
import { log } from '../log.js'
import type { InboxAlert } from '../../shared/protocol.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { ANY_ITEM_ID_RE } from '../validate.js'
import { invalidateInbox } from '../ws/send.js'
import { jobsEnabled } from '../settings-ops.js'

// Stage and turn (core/work/flow.ts): read the signals around every item, its
// newest brief, its newest dispatched session, its team run, the user's
// override, and derive where it is and whose move it is.

async function flowSignals(rt: WorkspaceRuntime): Promise<Map<string, FlowSignals>> {
  const [jobs, links, stored] = await Promise.all([rt.store.briefs.list(), rt.store.links.list(), rt.store.items.flowState()])
  const out = new Map<string, FlowSignals>()
  const of = (id: string): FlowSignals => {
    let s = out.get(id)
    if (!s) out.set(id, (s = {}))
    return s
  }
  // newest job per item (list is oldest first, so the last one wins)
  for (const j of [...jobs].sort((a, b) => a.createdAt - b.createdAt)) {
    of(j.itemId).brief = { status: j.status, at: j.finishedAt ?? j.startedAt ?? j.createdAt }
  }
  for (const l of links) {
    if (l.fromKind !== 'session' || l.toKind !== 'item' || l.role !== 'dispatch') continue
    const row = rt.rows.get(l.fromId)
    if (!row || row.kind !== 'chat') continue
    const live = rt.live.get(row.id)
    const sig: SessionSignal = {
      // A Workflow run going in the background is Junior's turn too, after its launching turn ended.
      running: live?.status === 'running' || live?.status === 'starting' || (live?.workflows ?? 0) > 0,
      waiting: !!live?.waiting,
      error: live?.status === 'error',
      at: row.updatedAt,
    }
    const s = of(l.toId)
    if (!s.session || sig.at > s.session.at) s.session = sig
  }
  for (const run of rt.teamRuns.values()) {
    const lead = rt.rows.get(run.leadSessionId)
    const at = Math.max(run.createdAt, lead?.updatedAt ?? 0)
    const s = of(run.itemId)
    const asks = run.goal?.questions.filter((q) => q.answer === null).length ?? 0
    if (!s.team || at > s.team.at) s.team = { state: run.state, at, ...(asks ? { asks } : {}), ...(run.goal && run.state === 'done' && !run.goal.acceptedAt ? { toAccept: true } : {}) }
  }
  // Goals with an item: the newest live one per item (done and cancelled hand the item back to the rules).
  for (const g of await rt.store.goals.list({ states: ['draft_plan', 'plan_ready', 'queued', 'running', 'waiting_world', 'waiting_you', 'result_ready', 'paused'] })) {
    if (!g.sourceItemId || g.state === 'done' || g.state === 'cancelled') continue
    const s = of(g.sourceItemId)
    if (!s.goal || g.updatedAt > s.goal.at) s.goal = { state: g.state, at: g.updatedAt }
  }
  for (const [id, f] of stored) if (f.override) of(id).override = f.override
  // Queued actions waiting on you: the item is on your turn until they're answered.
  for (const a of await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })) {
    const itemId = a.itemId ?? rt.sessionItem.get(a.sessionId)
    if (!itemId) continue
    const s = of(itemId)
    const at = a.queue?.queuedAt ?? a.updatedAt
    s.actions = { pending: (s.actions?.pending ?? 0) + 1, at: Math.max(s.actions?.at ?? 0, at) }
  }
  return out
}

/**
 * Put each item's flow on it. For the open inbox (`persist`), a flow that
 * moved since it was last recorded is written back and logged on the item,
 * so its history reads "briefing → ready → working".
 */
export async function withFlows<T extends CoreWorkItem & { flow?: ItemFlow }>(rt: WorkspaceRuntime, items: T[], persist: boolean): Promise<T[]> {
  const signals = await flowSignals(rt)
  const stored = persist ? await rt.store.items.flowState() : null
  for (const item of items) {
    item.flow = flowOf(item, signals.get(item.id))
    if (!stored) continue
    const was = stored.get(item.id)
    if (was?.stage === item.flow.stage && was?.turn === item.flow.turn) continue
    await rt.store.items
      .recordFlow(item.id, { stage: item.flow.stage, turn: item.flow.turn }, item.flow.next ? { next: item.flow.next } : {})
      .catch((err) => log('error', 'inbox', `could not record the flow of ${item.id}: ${err}`, { workspace: rt.meta.id }))
  }
  return items
}

/** The flow of one item, at any status, what the item page shows. */
export async function flowFor(rt: WorkspaceRuntime, item: CoreWorkItem): Promise<ItemFlow> {
  return flowOf(item, (await flowSignals(rt)).get(item.id))
}

/** Set or clear the stage/turn override on an item. Every change lands in its event log. */
export async function setFlowOverrideOp(rt: WorkspaceRuntime, raw: unknown, actor: string): Promise<void> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  if (!(await rt.store.items.get(id))) throw new Error('no such work item')
  if (r.clear === true) {
    await rt.store.items.setFlowOverride(id, null, actor)
  } else {
    if (r.stage !== undefined && !isStage(r.stage)) throw new Error('stage must be one of new, briefing, ready, working, review, done')
    if (r.turn !== undefined && !isTurn(r.turn)) throw new Error('turn must be one of me, ai, others, none')
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 200) : ''
    if (r.stage === undefined && r.turn === undefined && !note) throw new Error('set a stage, a turn or a note — or clear')
    const o: FlowOverride = { at: Date.now() }
    if (isStage(r.stage)) o.stage = r.stage
    if (isTurn(r.turn)) o.turn = r.turn
    if (note) o.note = note
    await rt.store.items.setFlowOverride(id, o, actor)
  }
  invalidateInbox(rt)
}

/** Broken things that aren't items: a job whose last run failed, a team run that paused. */
export async function inboxAlerts(rt: WorkspaceRuntime): Promise<InboxAlert[]> {
  const alerts: InboxAlert[] = []
  if (await jobsEnabled(rt)) {
    for (const w of await rt.store.jobs.list()) {
      if (!w.enabled || (w.lastRunStatus !== 'failed' && w.lastRunStatus !== 'timeout')) continue
      alerts.push({
        id: `job:${w.id}`,
        kind: 'job',
        title: `Job “${w.title}” ${w.lastRunStatus === 'timeout' ? 'timed out' : 'failed'}`,
        ...(w.lastRunError ? { detail: w.lastRunError } : {}),
        jobId: w.id,
        at: w.lastRunAt ?? 0,
      })
    }
  }
  for (const run of rt.teamRuns.values()) {
    if (run.state !== 'paused') continue
    alerts.push({
      id: `team:${run.id}`,
      kind: 'team',
      title: `${run.goal ? 'Goal' : 'Team run'} paused: ${run.title}`,
      ...(run.reason ? { detail: run.reason } : {}),
      sessionId: run.leadSessionId,
      at: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
    })
  }
  return alerts.sort((a, b) => b.at - a.at)
}

/**
 * A session dispatched for an item started, stopped or began waiting on you,
 * or a team run changed state: its item's turn moved, so the inbox is stale. Fingerprinted, so the many
 * session-list broadcasts that change nothing here cost nothing.
 */
export function noteDispatchedSessions(rt: WorkspaceRuntime): void {
  const fp = [...rt.sessionItem.keys()]
    .filter((sid) => rt.rows.get(sid)?.kind === 'chat')
    .map((sid) => {
      const l = rt.live.get(sid)
      return `${sid}:${l?.status ?? '-'}:${l?.waiting ? 1 : 0}:${l?.workflows ? 1 : 0}`
    })
    .concat([...rt.teamRuns.values()].map((r) => `team:${r.id}:${r.state}`))
    .join('|')
  if (fp === rt.dispatchFingerprint) return
  const first = rt.dispatchFingerprint === null
  rt.dispatchFingerprint = fp
  if (!first) invalidateInbox(rt)
}
