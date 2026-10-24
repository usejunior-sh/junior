import { OWN_SERVER_NAMES } from '../../core/actions/own.js'
import { overriddenOff, overrideEntries, sortCall, type ToolHints, withRowOverride } from '../../core/actions/sort.js'
import type { StoredSession } from '../../core/store/types.js'
import { type ActionOp, ActionTracker, applyActionOps, type TrackContext } from '../../core/actions/track.js'
import type { ActionView, SessionEvent } from '../../shared/protocol.js'
import { log } from '../log.js'
import type { ActionRecord } from '../../core/actions/types.js'
import { actionTitle, countedText } from '../../core/actions/describe.js'
import { shortActionId } from '../../core/actions/view.js'
import { planCard } from '../../core/cards/spec.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { teamRunLabel, teamRunOf } from '../team-run/state.js'
import { errText } from '../errors.js'
import { fireAndLog } from '../supervise.js'
import { broadcast } from '../ws/send.js'

// Outbound actions (core/actions, record only).
// Every persisted event of a Claude session, chat, brief, team worker, job
// run: passes through its tracker; what leaves this machine becomes a record
// with a card. Permissions are untouched: this only jobs.

/** What a connector's server said about one of its tools, from the latest probes. */
function toolHints(rt: WorkspaceRuntime, toolName: string): ToolHints | undefined {
  for (const probe of [rt.connectorCache, ...rt.folderProbes.values()]) {
    for (const c of probe?.connectors ?? []) {
      const t = c.tools.find((x) => x.fullName === toolName)
      if (t) return { readOnly: t.readOnly, destructive: t.destructive, openWorld: t.openWorld }
    }
  }
  return undefined
}

/**
 * Sort one call against the workspace's actions file and the connector's
 * hints. `own`: the servers the session registered in-process
 * (core/actions/own.ts ownServersOf); a call to any other server, whatever
 * its name, is sorted on its merits.
 */
export const sortForWorkspace = (rt: WorkspaceRuntime, own: ReadonlySet<string>) => (toolName: string, input: Record<string, unknown>) =>
  sortCall(toolName, input, { rules: rt.actionsFile.current().rules, hints: toolHints(rt, toolName), own })

/**
 * What the record-only tracker counts as Junior's own: every one of its names.
 * It replays history (backfill) and Codex sessions, whose `junior` is the
 * stdio shim, so it can't know how a server was registered. It never gates:
 * the hold (actions-hold.ts) sorts against the session's real in-process set.
 */
const TRACKER_OWN = OWN_SERVER_NAMES

export function actionContext(rt: WorkspaceRuntime, row: StoredSession): TrackContext {
  return {
    sessionId: row.id,
    sessionKind: row.kind,
    permissionMode: row.permissionMode,
    jobId: row.jobId,
    teamRunId: teamRunOf(rt, row.id)?.id ?? null,
    itemId: rt.sessionItem.get(row.id) ?? null,
    ruleFor: (toolUseId) => {
      const key = `${row.id}:${toolUseId}`
      const line = rt.ruleAllowed.get(key) ?? null
      rt.ruleAllowed.delete(key)
      return line
    },
  }
}

/**
 * Fold one persisted event of a session into its action records. Claude
 * sessions only (Codex approves differently, later). Never throws into the
 * caller: a recording failure must not break a session.
 */
export function noteActionEvent(rt: WorkspaceRuntime, row: StoredSession, ev: SessionEvent, at = Date.now()): void {
  if (row.provider !== 'claude') return
  let t = rt.actionTrackers.get(row.id)
  if (!t) {
    t = new ActionTracker(actionContext(rt, row), sortForWorkspace(rt, TRACKER_OWN))
    rt.actionTrackers.set(row.id, t)
  } else {
    // A session's mode, item and team can change mid-life; a record reads them as they are now.
    Object.assign(t.ctx, actionContext(rt, row))
  }
  let ops: ActionOp[]
  try {
    ops = t.feed(ev, at)
  } catch (err) {
    log('warn', 'actions', `could not sort an event: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
    return
  }
  if (ops.length) fireAndLog(rt, 'actions', queueActionOps(rt, ops))
}

/** Apply ops on the workspace's action chain, in order; resolves when they're stored. */
function queueActionOps(rt: WorkspaceRuntime, ops: ActionOp[]): Promise<void> {
  rt.actionChain = rt.actionChain
    .then(() => applyActionOps(rt.store.actions, ops))
    .then((touched) => actionsChanged(rt, touched))
    .catch((err) => log('warn', 'actions', `could not record an action: ${errText(err)}`, { workspace: rt.meta.id }))
  return rt.actionChain
}

/** Tell open pages, coalesced: a burst of calls is one refetch per session. */
export function actionsChanged(rt: WorkspaceRuntime, sessions: Set<string>): void {
  if (!sessions.size) return
  if (!rt.actionsDirty) {
    rt.actionsDirty = new Set()
    setTimeout(() => {
      const dirty = rt.actionsDirty ?? new Set<string>()
      rt.actionsDirty = null
      for (const sessionId of dirty) broadcast(rt, { type: 'actions_changed', sessionId })
    }, 250).unref()
  }
  for (const id of sessions) rt.actionsDirty.add(id)
}

const ACTIONS_BACKFILL_KEY = 'actions_backfill'

/**
 * Weeks of history on day one: replay every Claude session's stored log
 * through the same fold the live path uses. Runs once per workspace (the
 * config key); running it again changes nothing. A call already recorded is
 * skipped, and its outcome re-applies as the same outcome.
 */
export async function backfillActions(rt: WorkspaceRuntime, opts: { force?: boolean } = {}): Promise<{ sessions: number }> {
  if (!opts.force && (await rt.store.config.get<{ at: number }>(ACTIONS_BACKFILL_KEY))) return { sessions: 0 }
  let sessions = 0
  for (const row of [...rt.rows.values()]) {
    if (row.provider !== 'claude') continue
    const events = await rt.store.events.read(row.id)
    if (!events.length) continue
    const t = new ActionTracker(actionContext(rt, row), sortForWorkspace(rt, TRACKER_OWN))
    const ops = events.flatMap((e) => t.feed(e.event, e.createdAt))
    if (ops.length) await queueActionOps(rt, ops)
    sessions++
    // The store is synchronous: yield between sessions so boot isn't one long stall.
    await new Promise((res) => setImmediate(res))
  }
  await rt.store.config.set(ACTIONS_BACKFILL_KEY, { at: Date.now() })
  log('info', 'actions', `backfilled actions from ${sessions} session(s)`, { workspace: rt.meta.id })
  return { sessions }
}

/**
 * Records with names for their ids, as the Actions page and the item page show
 * them. Their titles and "why it counted" in words, and a queued one's
 * history. Batched: one job list, one history query, one item read per
 * distinct item, however many rows.
 */
export async function actionViews(rt: WorkspaceRuntime, records: ActionRecord[]): Promise<ActionView[]> {
  if (!records.length) return []
  const jobTitles = new Map((await rt.store.jobs.list()).map((w) => [w.id, w.title]))
  const queued = records.filter((a) => a.queue).map((a) => a.id)
  const history = queued.length ? await rt.store.actions.history(queued) : new Map()
  const itemOf = (a: ActionRecord) => a.itemId ?? rt.sessionItem.get(a.sessionId) ?? null
  const itemIds = [...new Set(records.map(itemOf).filter((x): x is string => !!x))]
  const itemTitles = new Map<string, string>()
  for (const id of itemIds) {
    const item = rt.inboxCache?.items.find((i) => i.id === id) ?? (await rt.store.items.get(id).catch(() => null))
    if (item) itemTitles.set(id, item.title)
  }
  const rules = rt.actionsFile.current().rules
  const specs = rt.cardSpecs.current().specs
  return records.map((a) => {
    const teamLabel = a.teamRunId ? teamRunLabel(rt, a.teamRunId) : undefined
    const itemId = itemOf(a)
    const row = rt.rows.get(a.sessionId)
    return {
      ...a,
      itemId,
      title: actionTitle(a),
      counted: countedText(a),
      short: shortActionId(a.id),
      ...(history.has(a.id) ? { history: history.get(a.id) } : {}),
      ...(row ? { sessionTitle: row.title } : {}),
      ...(a.jobId && jobTitles.has(a.jobId) ? { jobTitle: jobTitles.get(a.jobId) } : {}),
      ...(teamLabel !== undefined ? { teamLabel } : {}),
      ...(itemId && itemTitles.has(itemId) ? { itemTitle: itemTitles.get(itemId) } : {}),
      ...(overriddenOff(a, rules) ? { hidden: true } : {}),
      // An MCP tool's send reads by its card spec; Bash keeps its command view.
      ...(a.tool.startsWith('mcp__') ? { card: planCard(a.tool, a.queue?.args ?? a.args, specs) } : {}),
    }
  })
}

/** Queued actions waiting on you, workspace-wide, the rail's badge. */
export async function needsYouCount(rt: WorkspaceRuntime): Promise<number> {
  return (await rt.store.actions.list({ status: ['needs_you'], limit: 5000 })).length
}

/** A row's "Not an action" / "This is an action", written to the actions file as one edit (core/actions/sort.ts withRowOverride). */
export async function setActionOverride(rt: WorkspaceRuntime, a: ActionRecord, verdict: 'action' | 'not_action'): Promise<string[]> {
  const entries = overrideEntries(a)
  if (!entries.length) throw new Error('this action has no tool or pattern to override')
  const hints = toolHints(rt, a.tool)
  await rt.actionsFile.edit((text) => withRowOverride(text, a, verdict, hints))
  return entries
}
