/**
 * What you do with a first pass on an item (core/playbooks/item.ts): send
 * the drafted reply, approve the fix plan, or send the plan back with a note;
 * on an investigation, do what Junior recommends, or have it look again.
 * Only your OK sends the reply, and it lands in Junior's log under Sent.
 */
import { recordFor } from '../../core/actions/track.js'
import type { ActionRecord } from '../../core/actions/types.js'
import { APPROVE_PLAN_STEP, DEBUG_FIX_STEP, DEBUG_PLAN_STEP, DECIDE_STEP, INVESTIGATE_STEP, MAX_REPLY_CHARS, SEND_REPLY_STEP, slackThreadOf } from '../../core/playbooks/item.js'
import { isApprovedSend, sendPrompt, sentLink, SLACK_SEND_TOOL, type ApprovedSend } from '../../core/playbooks/send.js'
import type { ItemTask } from '../../core/work/tasks.js'
import { sourceOf } from '../../shared/sources.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import { requireVeto } from '../providers/capabilities.js'
import { onActionChain } from '../session/actions-hold.js'
import { actionsChanged } from '../session/actions-record.js'
import { pumpTasks, tasksChanged } from '../tasks/runner.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'

const SEND_TIMEOUT_MS = 120_000

async function waitingTask(rt: WorkspaceRuntime, taskId: string, step: string, what: string): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.step !== step || t.state !== 'waiting') throw new Error(`only a waiting ${what} can be`)
  return t
}

/**
 * You OK'd the reply on the card (as you edited it): it goes to the thread,
 * exactly as the card showed it. Slack only for now; elsewhere the card
 * copies it and you mark it sent.
 */
export async function sendReplyOp(rt: WorkspaceRuntime, taskId: string, raw: unknown): Promise<ItemTask> {
  const t = await waitingTask(rt, taskId, SEND_REPLY_STEP, 'reply sent')
  const item = await rt.store.items.get(t.itemId)
  if (!item) throw new Error('the item is gone')
  const r = (raw ?? {}) as Record<string, unknown>
  const drafted = typeof t.input?.reply === 'string' ? t.input.reply : ''
  const message = (typeof r.reply === 'string' ? r.reply : drafted).trim()
  if (!message) throw new Error('the reply is empty')
  if (message.length > MAX_REPLY_CHARS) throw new Error(`a reply is at most ${MAX_REPLY_CHARS} characters`)
  // Sent by hand (copied from the card): only the record changes.
  if (r.byHand === true) {
    const done = await rt.store.tasks.move(t.id, 'done', { output: { summary: 'you sent it yourself' } }, Date.now())
    await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: `Replied by hand: ${firstLine(message)}`, taskId: t.id })
    tasksChanged(rt)
    return done!
  }
  if (sourceOf(item.source).reply?.via !== 'slack-thread') throw new Error('Junior sends replies to Slack threads only: copy it, send it, then mark it sent')
  const thread = slackThreadOf(item.url)
  if (!thread) throw new Error('this item’s link is not a Slack message: copy the reply and send it yourself')
  requireVeto(rt.provider, 'job')
  // Claim it first, so a double click sends once.
  if (!(await rt.store.tasks.move(t.id, 'queued', {}, Date.now()))) throw new Error('the task moved on before it could be sent')
  tasksChanged(rt)
  const want: ApprovedSend = { channel: thread.channel, threadTs: thread.threadTs, message }
  const at = Date.now()
  const { called, link, error, costUsd } = await runSend(rt, want)
  if (costUsd) await rt.store.tasks.addCost(t.id, costUsd).catch(() => {})
  if (!called) {
    // nothing went out: it waits on the card again
    await rt.store.tasks.move(t.id, 'waiting', { error: error ?? 'the send did not happen' }, Date.now())
    await record(rt, t, want, at, null, error ?? 'the send did not happen')
    tasksChanged(rt)
    throw new Error(error ?? 'the send did not happen')
  }
  // The call went through the veto: it is sent, never retried on our own (a retry could post twice).
  const summary = `Sent: ${firstLine(message)}`
  const done = await rt.store.tasks.move(t.id, 'done', { output: { summary } }, Date.now())
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: `Replied in Slack: ${firstLine(message)}`, taskId: t.id })
  await record(rt, t, want, at, link, null)
  log('info', 'playbooks', `reply sent to ${item.id}${link ? `: ${link}` : ''}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  return done!
}

const firstLine = (s: string) => {
  const l = s.trim().split('\n')[0]!.trim()
  return l.length > 120 ? `${l.slice(0, 119)}…` : l
}

/** The one-call run. `called` = the approved call passed the veto. Nudges (server/tasks/nudge.ts) send through it too. */
export async function runSend(rt: WorkspaceRuntime, want: ApprovedSend): Promise<{ called: boolean; link: string | null; error: string | null; costUsd?: number }> {
  let called = false
  let text = ''
  let costUsd: number | undefined
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS)
  try {
    const q = rt.provider.run({
      prompt: sendPrompt(want),
      userConfig: true,
      model: 'haiku',
      tools: [],
      allowedTools: ['ToolSearch', SLACK_SEND_TOOL],
      unattended: true,
      maxTurns: 6,
      maxBudgetUsd: 0.25,
      veto: (toolName, input) => {
        if (toolName === 'ToolSearch') return { allow: true }
        if (called) return { allow: false, reason: 'already sent: stop now' }
        const ok = isApprovedSend(toolName, input, want)
        if (!ok.ok) return { allow: false, reason: ok.reason }
        called = true
        return { allow: true }
      },
      abort,
      ...(rt.env ? { env: rt.env } : {}),
    })
    for await (const ev of q) {
      if (ev.kind === 'result') {
        text = ev.text
        if (ev.costUsd != null) costUsd = ev.costUsd
      }
    }
    return { called, link: sentLink(text), error: called ? null : text.trim().slice(0, 300) || 'the Slack tool was not called', ...(costUsd != null ? { costUsd } : {}) }
  } catch (err) {
    return { called, link: null, error: errText(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** The send as an action record: Junior's log lists it under Sent, allowed by you on the item page. */
async function record(rt: WorkspaceRuntime, t: ItemTask, want: ApprovedSend, at: number, link: string | null, error: string | null): Promise<void> {
  const now = Date.now()
  const rec: ActionRecord = {
    ...recordFor(
      { sessionId: `task-${t.id}`, sessionKind: 'task', permissionMode: null, jobId: null, teamRunId: null, itemId: t.itemId },
      `reply-${at}`,
      SLACK_SEND_TOOL,
      { channel_id: want.channel, thread_ts: want.threadTs, message: want.message },
      { kind: 'message', why: 'name verb', whyDetail: 'slack_send_message', summary: `Slack reply: ${firstLine(want.message)}` },
      at,
    ),
    status: error ? 'failed' : 'succeeded',
    link,
    error,
    allowedBy: 'prompt',
    allowedDetail: 'on the item page',
    settledAt: now,
    updatedAt: now,
  }
  await onActionChain(rt, () => rt.store.actions.put(rec))
    .then(() => actionsChanged(rt, new Set([rec.sessionId])))
    .catch((err) => log('warn', 'playbooks', `could not record the reply: ${errText(err)}`, { task: t.id, workspace: rt.meta.id }))
}

/** You approved the plan: the fix is queued, in its own worktree, on Junior's own branch. */
export async function approvePlanOp(rt: WorkspaceRuntime, taskId: string, raw: unknown): Promise<ItemTask> {
  const t = await waitingTask(rt, taskId, APPROVE_PLAN_STEP, 'plan approved')
  const note = typeof (raw as { note?: unknown })?.note === 'string' ? (raw as { note: string }).note.trim().slice(0, 2000) : ''
  const done = await rt.store.tasks.move(t.id, 'done', { output: { summary: note ? `approved: ${note}` : 'approved' } }, Date.now())
  if (!done) throw new Error('the task moved on before it could be approved')
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: note ? `Plan approved: ${note}` : 'Plan approved', taskId: t.id })
  const fix = await rt.store.tasks.add(
    { itemId: t.itemId, title: 'Fix it', owner: 'junior', why: 'playbook', whyDetail: 'plan approved', step: DEBUG_FIX_STEP, key: `fix:${t.id}`, ...(note ? { input: { note } } : {}) },
    Date.now(),
  )
  if (!fix) throw new Error('could not add the fix')
  tasksChanged(rt)
  void pumpTasks(rt)
  return fix
}

/** You sent the plan back: Junior plans again with your note. */
export async function changePlanOp(rt: WorkspaceRuntime, taskId: string, raw: unknown): Promise<ItemTask> {
  const t = await waitingTask(rt, taskId, APPROVE_PLAN_STEP, 'plan sent back')
  const note = typeof (raw as { note?: unknown })?.note === 'string' ? (raw as { note: string }).note.trim().slice(0, 2000) : ''
  if (!note) throw new Error('say what should change')
  if (!(await rt.store.tasks.move(t.id, 'skipped', { error: `sent back: ${note}` }, Date.now()))) throw new Error('the task moved on')
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: `Plan sent back: ${note}`, taskId: t.id })
  const again = await rt.store.tasks.add(
    { itemId: t.itemId, title: 'Plan the fix', owner: 'junior', why: 'you', whyDetail: 'plan sent back', step: DEBUG_PLAN_STEP, key: `plan:again:${Date.now()}` },
    Date.now(),
  )
  if (!again) throw new Error('could not add the new plan')
  tasksChanged(rt)
  void pumpTasks(rt)
  return again
}

const noteOf = (raw: unknown) => (typeof (raw as { note?: unknown })?.note === 'string' ? (raw as { note: string }).note.trim().slice(0, 2000) : '')

/**
 * You said do it on an investigation: its recommendation (your note wins)
 * becomes the item's plan, with the options brief under it, and the change
 * runs like an approved fix: Junior's own branch, a draft PR.
 */
export async function goAheadOp(rt: WorkspaceRuntime, taskId: string, raw: unknown): Promise<ItemTask> {
  const t = await waitingTask(rt, taskId, DECIDE_STEP, 'decision made')
  const note = noteOf(raw)
  const rec = typeof t.input?.recommendation === 'string' ? t.input.recommendation : t.title
  const artifactId = typeof t.input?.artifactId === 'string' ? t.input.artifactId : null
  const brief = artifactId ? await rt.artifacts.read(artifactId).catch(() => null) : null
  const plan = [
    `Go with the recommendation: ${rec}`,
    ...(note ? ['', `The user's note (it wins over the brief): ${note}`] : []),
    ...(brief?.body.trim() ? ['', '#### The options brief', brief.body.trim()] : []),
  ].join('\n')
  const done = await rt.store.tasks.move(t.id, 'done', { output: { summary: note ? `do it: ${note}` : 'do it' } }, Date.now())
  if (!done) throw new Error('the task moved on before it could be decided')
  await rt.store.items.setPlan(t.itemId, plan)
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: note ? `Do it: ${note}` : `Do it: ${rec}`, taskId: t.id })
  const fix = await rt.store.tasks.add(
    { itemId: t.itemId, title: 'Make the change', owner: 'junior', why: 'playbook', whyDetail: 'you said do it', step: DEBUG_FIX_STEP, key: `fix:${t.id}`, ...(note ? { input: { note } } : {}) },
    Date.now(),
  )
  if (!fix) throw new Error('could not add the change')
  tasksChanged(rt)
  void pumpTasks(rt)
  return fix
}

/** You want something else: Junior investigates again, with your note in the item's decisions. */
export async function lookAgainOp(rt: WorkspaceRuntime, taskId: string, raw: unknown): Promise<ItemTask> {
  const t = await waitingTask(rt, taskId, DECIDE_STEP, 'decision sent back')
  const note = noteOf(raw)
  if (!note) throw new Error('say what Junior should look at')
  if (!(await rt.store.tasks.move(t.id, 'skipped', { error: `look again: ${note}` }, Date.now()))) throw new Error('the task moved on')
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: `Look again: ${note}`, taskId: t.id })
  const again = await rt.store.tasks.add(
    { itemId: t.itemId, title: 'Investigate options', owner: 'junior', why: 'you', whyDetail: 'look again', step: INVESTIGATE_STEP, key: `investigate:again:${Date.now()}` },
    Date.now(),
  )
  if (!again) throw new Error('could not add the new investigation')
  tasksChanged(rt)
  void pumpTasks(rt)
  return again
}
