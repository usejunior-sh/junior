import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StoredSession } from '../../core/store/types.js'
import { type RoleFence, roleFenceDecision } from '../../core/goals/fence.js'
import { roleWrites } from '../../core/goals/run.js'
import { goalDir } from '../../core/goals/types.js'
import type { ToolVeto, VetoDecision } from '../providers/types.js'
import { log } from '../log.js'
import { type ActionMove, canonJson, heldEntry, heldRecord, holdable, isArgsObject, move, queuedMessage, sendDelay } from '../../core/actions/queue.js'
import { destructiveCommand } from '../../core/actions/commands.js'
import { type BranchScope, chatBashVerdict, mayBeFree, selfApproval } from '../../core/actions/policy.js'
import { currentBranch } from '../git.js'
import { defaultBranch } from '../worktrees.js'
import { taskRunVerdict } from '../../core/babysit/policy.js'
import { joinHeldCall, recordFor } from '../../core/actions/track.js'
import { goalActionHeldOp } from '../goals.js'
import { shortActionId } from '../../core/actions/view.js'
import type { ActionRecord } from '../../core/actions/types.js'
import type { ActionVerb } from '../../shared/protocol.js'
import { browserGateFor, WorkspaceRuntime } from '../workspace/runtime.js'
import { teamRunOf, workerSpec } from '../team-run/state.js'
import { actionContext, actionsChanged, sortForWorkspace } from './actions-record.js'
import { errText } from '../errors.js'
import { coveringApproval, useApproval } from '../approvals-ops.js'
import { describeApproval } from '../../core/approvals/approvals.js'
import { invalidateInbox } from '../ws/send.js'
import { deliverSendBack, dispatchAction } from './actions-send.js'

// Queued actions (core/actions/queue.ts). One policy (core/actions/policy.ts):
// in a chat, a job run, a team's sessions or a task run, a call that sorts as
// an action is held, not run: the agent is told "queued as #a1b2c3", and the
// call waits on a card for approve / edit / send back / reject. An approved
// one goes out through a headless one-tool run fenced to the approved args:
// the daemon never calls an MCP server itself.

/** The model that sends approved actions: cheap, and it only copies JSON into one call. */
export const DISPATCH_MODEL = 'haiku'
/** A dispatch run that hasn't finished by now is stopped (and, if the call was let through, marked unknown). */
export const DISPATCH_TIMEOUT_MS = 3 * 60_000

export const isTeamWorker = (rt: WorkspaceRuntime, sessionId: string): boolean => {
  const run = teamRunOf(rt, sessionId)
  return !!run && run.leadSessionId !== sessionId
}

/** Every Claude chat, a team's lead and workers included: local work runs, sends are held. */
const chatHoldsSends = (row: StoredSession): boolean => row.provider === 'claude' && row.kind === 'chat'

/** Does this session hold its outbound calls for approval? Chats, job runs, goal workers and task runs do. */
const holdsActions = (rt: WorkspaceRuntime, row: StoredSession): boolean =>
  row.provider === 'claude' && (row.kind === 'job-run' || (rt.goalRuns.get(row.id)?.role ?? 'lead') !== 'lead' || rt.taskRuns.has(row.id) || chatHoldsSends(row))

/** The branch a chat's shell is on and the repo's default one: what a free push is judged against. */
async function branchScope(cwd: string): Promise<BranchScope> {
  const [current, def] = await Promise.all([currentBranch(cwd), defaultBranch(cwd).catch(() => null)])
  return { current, defaultBranch: def }
}

/**
 * The role fence a session runs under (core/goals/fence.ts), or null: a team
 * worker on a step that isn't the change step is read-only, and so is a brief.
 */
function roleFenceOf(rt: WorkspaceRuntime, row: StoredSession): RoleFence | null {
  if (row.kind === 'brief') return { write: false, role: 'brief' }
  const goalRun = rt.goalRuns.get(row.id)
  if (goalRun)
    return {
      write: roleWrites(goalRun.role),
      role: goalRun.role,
      // Reviewer independence: not the builders' handoff, log or transcripts.
      ...(goalRun.role === 'reviewer' ? { hidden: [path.join(rt.goalLedger.root, goalDir(goalRun.goalId)), `${path.sep}.claude${path.sep}projects${path.sep}`] } : {}),
    }
  if (row.kind === 'goal') return { write: false, role: 'lead' }
  const run = teamRunOf(rt, row.id)
  const worker = run && run.leadSessionId !== row.id ? [...run.workers].reverse().find((w) => w.sessionId === row.id) : undefined
  if (!run || !worker) return null
  const { writes } = workerSpec(run, worker)
  return { write: writes, role: (worker.agent || 'worker').toLowerCase() }
}

/** A session's PreToolUse veto: its role fence first, then the hold. None for a session with neither. */
export function sessionVeto(rt: WorkspaceRuntime, row: StoredSession): { veto?: ToolVeto } {
  const fence = roleFenceOf(rt, row)
  const chat = row.kind === 'chat' && row.provider === 'claude'
  if (!fence && !chat && !holdsActions(rt, row)) return {}
  return {
    veto: async (toolName, input, ctx) => {
      const d = fence ? roleFenceDecision(fence, toolName, input) : { allow: true as const }
      if (!d.allow) {
        log('info', 'fence', `refused ${toolName} in a read-only session: ${d.reason}`, { session: row.id, workspace: rt.meta.id })
        return d
      }
      if (toolName === 'Bash' && isArgsObject(input) && selfApproval(String(input.command ?? ''))) {
        log('info', 'actions', 'refused a command that approves through junior’s API', { session: row.id, workspace: rt.meta.id })
        return { allow: false, reason: 'Only the user approves sends and adds advance approvals, in the app. Propose one with propose_approval instead.' }
      }
      // Claude's auto mode runs local work; a command that destroys work still comes to you.
      if (toolName === 'Bash' && chatHoldsSends(row) && isArgsObject(input)) {
        const why = destructiveCommand(String(input.command ?? ''))
        if (why) return { allow: false, ask: true, reason: `This command ${why}, so it needs your OK.` }
      }
      // The browser on a signed-in site: a commit click asks, a password is refused (server/browser/gate.ts).
      const gate = await browserGateFor(row, { mode: 'chat' })(toolName, input)
      if (gate) return gate
      return holdIfAction(rt, row, toolName, input, ctx)
    },
  }
}

/**
 * The veto a holding session gets: an MCP call or a Bash command that sorts
 * as an action is refused with "queued as #…" and filed for approval, unless
 * the policy makes it free (a push to your own branch, a draft PR);
 * everything else passes. A held command is sent from the session's folder.
 */
export async function holdIfAction(rt: WorkspaceRuntime, row: StoredSession, toolName: string, input: unknown, ctx?: { toolUseId?: string }): Promise<VetoDecision> {
  if (!holdable(toolName) || !holdsActions(rt, row)) return { allow: true }
  const args = isArgsObject(input) ? input : {}
  // A babysit task's shell (core/babysit/policy.ts): pushes to its PR's branch and
  // its bot thread's reply and resolve run; force and other branches are refused;
  // any other send falls through and is held like a chat's.
  const taskRun = rt.taskRuns.get(row.id)
  if (taskRun && toolName === 'Bash') {
    const sort = sortForWorkspace(rt)
    let v
    try {
      v = taskRunVerdict(String(args.command ?? ''), taskRun.scope, (part) => sort('Bash', { command: part }))
    } catch {
      v = { verdict: 'hold' as const }
    }
    if (v.verdict === 'refuse') {
      log('info', 'tasks', `refused in a task session: ${v.reason}`, { session: row.id, workspace: rt.meta.id })
      return { allow: false, reason: v.reason }
    }
    if (v.verdict === 'allow') return { allow: true }
  }
  // A chat's shell: a push to your own branch and a draft PR run; any other send is held,
  // and sent from the chat's folder. (A job's Bash isn't held in this phase: sending needs its folder.)
  if (toolName === 'Bash' && !taskRun) {
    if (!chatHoldsSends(row)) return { allow: true }
    const command = String(args.command ?? '')
    const sort = sortForWorkspace(rt)
    try {
      const scope = mayBeFree(command) ? await branchScope(row.cwd) : { current: null, defaultBranch: null }
      const v = chatBashVerdict(command, scope, (part) => sort('Bash', { command: part }))
      if (v.verdict === 'allow') return v.free ? { allow: true, sure: `Free under the user's policy: ${v.free === 'draft PR' ? 'a draft PR' : 'a push to your own branch'}.` } : { allow: true }
    } catch (err) {
      log('warn', 'actions', `could not judge a command against the policy, holding it: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
    }
  }
  if (!toolName.startsWith('mcp__') && toolName !== 'Bash') return { allow: true }
  let sorted
  try {
    sorted = sortForWorkspace(rt)(toolName, args)
  } catch (err) {
    log('warn', 'actions', `could not sort a call to hold it: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
    return { allow: true }
  }
  if (!sorted) return { allow: true }
  // A read-only task (a first pass, an answer's draft, a plan) sends nothing: the user does.
  if (taskRun?.scope.readOnly) {
    log('info', 'tasks', `refused a send in a read-only task: ${sorted.summary}`, { session: row.id, workspace: rt.meta.id })
    return { allow: false, reason: 'This task is read-only: nothing is sent from here. Hand in with your submit tool; sending is the user’s call.' }
  }
  // Approved in advance (core/approvals): it goes out now, and its record says which approval let it.
  const rule = await coveringApproval(rt, toolName, args)
  if (rule) {
    await useApproval(rt, rule, row.id, ctx?.toolUseId)
    return { allow: true, sure: `Approved in advance by the user: ${describeApproval(rule)}.` }
  }
  // A goal's worker: the same call any of the goal's sessions already filed
  // before a crash, or by the worker this one replaced, is that action.
  const goalRun = rt.goalRuns.get(row.id)
  const filed = goalRun ? rt.goalHeld.find(goalRun.goalId, toolName, args) : null
  if (filed) return { allow: false, reason: queuedMessage(filed) }
  // The same call with the same args, still waiting: name the action already filed.
  const key = `${row.id}\u0000${toolName}\u0000${canonJson(args)}`
  const dup = rt.heldCalls.get(key)
  if (dup) {
    // The repeat is the same action: its call joins the record already waiting, so no second row appears.
    const again = ctx?.toolUseId
    if (again) {
      void onActionChain(rt, () => joinHeldCall(rt.store.actions, row.id, again, dup))
        .then(() => actionsChanged(rt, new Set([row.id])))
        .catch((err) => log('warn', 'actions', `could not join a repeated held call: ${errText(err)}`, { session: row.id, workspace: rt.meta.id }))
    }
    return { allow: false, reason: queuedMessage(dup) }
  }
  const toolUseId = ctx?.toolUseId || `held-${randomUUID()}`
  const id = `${row.id}:${toolUseId}`
  rt.heldCalls.set(key, id)
  if (goalRun)
    void goalActionHeldOp(rt.goalDeps, rt.goalHeld, { goalId: goalRun.goalId, sessionId: row.id, actionId: id, tool: toolName, args }).catch((err) =>
      log('warn', 'goals', `could not note a held action on its goal: ${errText(err)}`, { session: row.id, workspace: rt.meta.id }),
    )
  const now = Date.now()
  const base = recordFor(actionContext(rt, row), toolUseId, toolName, args, sorted, now)
  void onActionChain(rt, async () => {
    // The call's message may have been recorded as an attempt already: hold that record.
    const existing = await rt.store.actions.byCall(row.id, toolUseId)
    const rec = heldRecord(existing ?? base, args, now)
    await rt.store.actions.put(rec)
    await rt.store.actions.addHistory(heldEntry(rec, args, now))
    log('info', 'actions', `held for approval: ${rec.summary} (#${shortActionId(rec.id)})`, { session: row.id, action: rec.id, tool: toolName, workspace: rt.meta.id })
  })
    .then(() => {
      actionsChanged(rt, new Set([row.id]))
      invalidateInbox(rt)
    })
    .catch((err) => log('warn', 'actions', `could not hold an action: ${errText(err)}`, { session: row.id, workspace: rt.meta.id }))
  return { allow: false, reason: queuedMessage(id) }
}

/** Run `fn` on the workspace's action chain, after every write queued before it, before any after. */
export function onActionChain<T>(rt: WorkspaceRuntime, fn: () => Promise<T>): Promise<T> {
  const run = rt.actionChain.then(fn)
  rt.actionChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** A held call that left the queue: an agent repeating it is a new action from now on. */
function forgetHeld(rt: WorkspaceRuntime, actionId: string): void {
  for (const [k, id] of rt.heldCalls) if (id === actionId) rt.heldCalls.delete(k)
}

/**
 * One move on a queued action (core/actions/queue.ts `move`), stored with its
 * history line. The effects that follow a move, a send timer, notes to the
 * drafting session, the inbox's "my turn", are the caller's.
 */
export async function moveAction(rt: WorkspaceRuntime, id: string, m: ActionMove, now = Date.now()): Promise<ActionRecord> {
  const next = await onActionChain(rt, async () => {
    const rec = await rt.store.actions.get(id)
    if (!rec) throw new Error('no such action')
    const r = move(rec, m, now)
    if (!r.ok) throw new Error(r.error)
    await rt.store.actions.put(r.next)
    await rt.store.actions.addHistory(r.entry)
    return r.next
  })
  if (next.status !== 'needs_you') forgetHeld(rt, id)
  // Sent back or lapsed: a goal's worker may file the same call again.
  if (next.status === 'sent_back' || next.status === 'expired') rt.goalHeld.drop(id)
  actionsChanged(rt, new Set([next.sessionId]))
  return next
}

/** Arm (or re-arm) the timer that sends an approved action at its time. */
export function armDispatch(rt: WorkspaceRuntime, rec: ActionRecord): void {
  disarmDispatch(rt, rec.id)
  if (rec.status !== 'scheduled') return
  const delay = sendDelay(rec, Date.now())
  if (delay === 0) {
    void dispatchAction(rt, rec.id)
    return
  }
  const t = setTimeout(() => {
    rt.actionTimers.delete(rec.id)
    void dispatchAction(rt, rec.id)
  }, delay + 50)
  t.unref()
  rt.actionTimers.set(rec.id, t)
}

export function disarmDispatch(rt: WorkspaceRuntime, id: string): void {
  const t = rt.actionTimers.get(id)
  if (t) clearTimeout(t)
  rt.actionTimers.delete(id)
}

/** A user's verb on a queued action, with what follows it. */
export async function actionVerbOp(rt: WorkspaceRuntime, verb: ActionVerb, raw: unknown): Promise<ActionRecord> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id || id.length > 400) throw new Error('need the action id')
  let m: ActionMove
  switch (verb) {
    case 'approve': {
      if (r.args !== undefined && !isArgsObject(r.args)) throw new Error('args must be a JSON object')
      // Kept exactly as sent: the edited args are what goes out, word for word.
      m = r.args !== undefined ? { type: 'approve', args: r.args as Record<string, unknown> } : { type: 'approve' }
      break
    }
    case 'undo':
      m = { type: 'undo' }
      break
    case 'send-back': {
      if (typeof r.notes !== 'string' || !r.notes.trim()) throw new Error('send back needs notes: say what to change')
      m = { type: 'send_back', notes: r.notes }
      break
    }
    case 'reject': {
      if (r.reason !== undefined && typeof r.reason !== 'string') throw new Error('reason must be text')
      m = { type: 'reject', reason: typeof r.reason === 'string' ? r.reason : '' }
      break
    }
    case 'retry':
      m = { type: 'retry' }
      break
  }
  const next = await moveAction(rt, id, m)
  if (next.status === 'scheduled') armDispatch(rt, next)
  else disarmDispatch(rt, id)
  if (verb === 'send-back') void deliverSendBack(rt, next)
  if (verb !== 'retry') invalidateInbox(rt)
  log('info', 'actions', `${verb}: ${next.summary} (#${shortActionId(next.id)}) → ${next.status}`, { action: id, workspace: rt.meta.id })
  return next
}
