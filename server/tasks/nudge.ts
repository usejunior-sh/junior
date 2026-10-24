/**
 * Nudges (plan item `nudge-suggest`; the rules are core/work/nudge.ts and
 * core/work/nudge-suggest.ts). Three ops, and only the last two write:
 *
 *   marks    the Junior page's read: each Waiting item with a due nudge.
 *            Creates nothing: no task, no draft.
 *   draft    you picked "Draft nudge" (POST /api/nudge/draft): one task on
 *            you, waiting, holding the text. An advance approval you wrote
 *            for that Slack channel sends it alone; else it waits for you.
 *   send     you sent it from the card (POST /api/tasks/send-nudge), as you
 *            edited it, on the source's own reply route; or you copied it,
 *            sent it yourself, and marked it sent (`byHand`).
 *
 * The route comes from the item's source descriptor (shared/sources.ts):
 * a source without a reply route only offers Copy text. Every send is a
 * record in Junior's log, and every nudge that went out starts the person's
 * cooldown (config NUDGES_SENT_KEY).
 */
import { recordFor } from '../../core/actions/track.js'
import type { ActionRecord } from '../../core/actions/types.js'
import { type AdvanceApproval, allowedDetailFor, describeApproval } from '../../core/approvals/approvals.js'
import { MAX_REPLY_CHARS, slackThreadOf } from '../../core/playbooks/item.js'
import { SLACK_SEND_TOOL, type ApprovedSend } from '../../core/playbooks/send.js'
import { NUDGE_DEFAULTS, personKey, type NudgeSent } from '../../core/work/nudge.js'
import {
  NUDGE_STEP,
  NUDGES_SENT_KEY,
  nudgeInputOf,
  nudgeMarks,
  nudgeRoute,
  nudgeSentWith,
  nudgesSentFrom,
  nudgeTask,
  pickWait,
  waitingOf,
  type NudgeMark,
} from '../../core/work/nudge-suggest.js'
import type { ItemTask } from '../../core/work/tasks.js'
import type { TurnContext } from '../../core/work/turn.js'
import type { ScoredItem, WorkItem } from '../../core/work/types.js'
import { coveringApproval, useApproval } from '../approvals-ops.js'
import { errText } from '../errors.js'
import { getInbox } from '../inbox/sync.js'
import { log } from '../log.js'
import { runSend } from '../playbooks/ops.js'
import { requireVeto } from '../providers/capabilities.js'
import { onActionChain } from '../session/actions-hold.js'
import { actionsChanged } from '../session/actions-record.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { tasksChanged } from './runner.js'

/** One Slack send, the way the reply card sends. Injected so a test stands in for Slack. */
export type NudgeSend = (rt: WorkspaceRuntime, want: ApprovedSend) => Promise<{ called: boolean; link: string | null; error: string | null; costUsd?: number }>

const slackSend: NudgeSend = async (rt, want) => {
  requireVeto(rt.provider, 'job')
  return runSend(rt, want)
}

/** The nudges already sent, for the cooldown. A config read that fails reads as none. */
async function sentList(rt: WorkspaceRuntime): Promise<NudgeSent[]> {
  return nudgesSentFrom(await rt.store.config.get(NUDGES_SENT_KEY).catch(() => null))
}

/**
 * The Junior page's marks: each Waiting item with a due nudge, by id. A read
 * only: it never adds a task or a draft (hand-offs, Phase 1).
 */
export async function nudgeMarksOp(
  rt: WorkspaceRuntime,
  items: readonly ScoredItem[],
  opts: { now: number; me?: string | null; ctxOf?: (id: string) => TurnContext | undefined },
): Promise<Record<string, NudgeMark>> {
  return nudgeMarks(items, opts.now, { ...NUDGE_DEFAULTS, ...(opts.me ? { me: opts.me } : {}) }, await sentList(rt), opts.ctxOf)
}

export type NudgeDeps = {
  /** the open inbox, ranked; default: the warm cache, else a sync */
  items?: () => Promise<readonly ScoredItem[]>
  send?: NudgeSend
}

const inbox = async (rt: WorkspaceRuntime): Promise<readonly ScoredItem[]> => (rt.inboxCache ?? (await getInbox(rt, false))).items

/**
 * You picked "Draft nudge" on a Waiting row: one task on you, waiting, with
 * the drafted text. Asking again while one waits returns that one. `person`
 * picks who, when the item waits on more than one; else the longest wait.
 */
export async function draftNudgeOp(rt: WorkspaceRuntime, raw: unknown, deps: NudgeDeps = {}): Promise<ItemTask> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const itemId = typeof r.itemId === 'string' ? r.itemId.trim() : ''
  if (!itemId) throw new Error('itemId required')
  const item = (await (deps.items ?? (() => inbox(rt)))()).find((i) => i.id === itemId)
  if (!item) throw new Error(`no open item ${itemId}`)
  const wait = pickWait(waitingOf(item), typeof r.person === 'string' ? r.person : undefined)
  if (!wait) throw new Error(typeof r.person === 'string' && r.person.trim() ? `${item.title} isn't waiting on ${r.person.trim()}` : 'Junior can’t tell who this item waits on')

  const open = (await rt.store.tasks.list(itemId)).find((t) => t.step === NUDGE_STEP && t.state === 'waiting' && personKey(nudgeInputOf(t.input)?.person ?? '') === personKey(wait.person))
  if (open) return open

  const now = Date.now()
  const spec = nudgeTask(item, wait, now)
  const t = await rt.store.tasks.add(spec, now)
  if (!t) throw new Error('could not add the nudge')
  log('info', 'tasks', `nudge drafted for ${spec.input.person} on ${itemId}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  if (await nudgeUnderApproval(rt, t, deps.send)) return (await rt.store.tasks.get(t.id)) ?? t
  return t
}

/**
 * The nudge was just drafted: an advance approval you wrote for the Slack
 * channel it lands in sends it alone, as drafted. False = none covers it (or
 * it failed, or the source has no reply route): it waits for you.
 */
export async function nudgeUnderApproval(rt: WorkspaceRuntime, t: ItemTask, send: NudgeSend = slackSend): Promise<boolean> {
  const input = nudgeInputOf(t.input)
  if (t.step !== NUDGE_STEP || t.state !== 'waiting' || !input) return false
  const item = await rt.store.items.get(t.itemId)
  const route = nudgeRoute(item?.source)
  if (!item || !route.send || route.via !== 'slack-thread') return false
  const thread = slackThreadOf(item.url)
  if (!thread) return false
  const rule = await coveringApproval(rt, SLACK_SEND_TOOL, { channel_id: thread.channel })
  if (!rule) return false
  try {
    await carryOut(rt, t, item, input.person, input.text, rule, send)
    return true
  } catch (err) {
    log('warn', 'tasks', `an approved nudge failed, it waits for you: ${errText(err)}`, { task: t.id, workspace: rt.meta.id })
    return false
  }
}

/**
 * You sent the nudge from its card, as you edited it. `byHand` = you copied
 * it and sent it yourself: only the record changes, and the cooldown starts.
 */
export async function sendNudgeOp(rt: WorkspaceRuntime, taskId: string, raw: unknown, send: NudgeSend = slackSend): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  const input = nudgeInputOf(t.input)
  if (t.step !== NUDGE_STEP || t.state !== 'waiting' || !input) throw new Error('only a waiting nudge can be sent')
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (typeof r.text === 'string' ? r.text : input.text).trim()
  if (!text) throw new Error('the nudge is empty')
  if (text.length > MAX_REPLY_CHARS) throw new Error(`a nudge is at most ${MAX_REPLY_CHARS} characters`)
  const item = await rt.store.items.get(t.itemId)
  if (!item) throw new Error('the item is gone')

  if (r.byHand === true) {
    const done = await rt.store.tasks.move(t.id, 'done', { output: { summary: 'you sent it yourself' } }, Date.now())
    if (!done) throw new Error('the nudge moved on')
    await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: `Nudged ${input.person} by hand: ${firstLine(text)}`, taskId: t.id })
    await recordSent(rt, input.person, t.itemId)
    tasksChanged(rt)
    return done
  }
  // The route is read again from the source, never from what the draft carried.
  const route = nudgeRoute(item.source)
  if (!route.send) throw new Error('Junior can’t send here: copy the text, send it, then mark it sent')
  return carryOut(rt, t, item, input.person, text, null, send)
}

/** The send: claimed, sent once, recorded on the task, the item, Junior's log and the cooldown. */
async function carryOut(rt: WorkspaceRuntime, t: ItemTask, item: WorkItem, person: string, text: string, rule: AdvanceApproval | null, send: NudgeSend): Promise<ItemTask> {
  const route = nudgeRoute(item.source)
  if (!route.send || route.via !== 'slack-thread') throw new Error('Junior can’t send here: copy the text, send it, then mark it sent')
  const thread = slackThreadOf(item.url)
  if (!thread) throw new Error('this item’s link is not a Slack message: copy the text and send it yourself')
  // Claim it first, so a double click (or the rule and you at once) sends once.
  if (!(await rt.store.tasks.move(t.id, 'queued', {}, Date.now()))) throw new Error('the nudge moved on before it could be sent')
  tasksChanged(rt)
  const want: ApprovedSend = { channel: thread.channel, threadTs: thread.threadTs, message: text }
  const at = Date.now()
  const res = await send(rt, want).catch((err): Awaited<ReturnType<NudgeSend>> => ({ called: false, link: null, error: errText(err) }))
  if (res.costUsd) await rt.store.tasks.addCost(t.id, res.costUsd).catch(() => {})
  if (!res.called) {
    const error = res.error ?? 'the send did not happen'
    await rt.store.tasks.move(t.id, 'waiting', { error }, Date.now())
    await record(rt, t, person, want, rule, at, null, error)
    tasksChanged(rt)
    throw new Error(error)
  }
  // The call went through: it is sent, never retried on our own (a retry could post twice).
  await rt.store.tasks.move(t.id, 'running', {}, Date.now())
  const summary = `Nudged ${person}: ${firstLine(text)}`
  const done = await rt.store.tasks.move(t.id, 'done', { output: { summary } }, Date.now())
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: rule ? 'junior' : 'you', text: rule ? `${summary} (approved in advance: ${describeApproval(rule)})` : summary, taskId: t.id })
  await record(rt, t, person, want, rule, at, res.link, null)
  await recordSent(rt, person, t.itemId)
  if (rule) await useApproval(rt, rule, `task-${t.id}`, undefined)
  log('info', 'tasks', `nudged ${person} on ${t.itemId}${rule ? ' (approved in advance)' : ''}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  return done ?? t
}

/** The cooldown starts: one more entry in the sent list. */
async function recordSent(rt: WorkspaceRuntime, person: string, itemId: string): Promise<void> {
  try {
    const now = Date.now()
    await rt.store.config.set(NUDGES_SENT_KEY, nudgeSentWith(await sentList(rt), { person, at: now, itemId }, now))
  } catch (err) {
    log('warn', 'tasks', `could not record the nudge for the cooldown: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

const firstLine = (s: string) => {
  const l = s.trim().split('\n')[0]!.trim()
  return l.length > 120 ? `${l.slice(0, 119)}…` : l
}

/** The nudge as an action record: Junior's log lists it under Sent, with who allowed it. */
async function record(rt: WorkspaceRuntime, t: ItemTask, person: string, want: ApprovedSend, rule: AdvanceApproval | null, at: number, link: string | null, error: string | null): Promise<void> {
  const now = Date.now()
  const rec: ActionRecord = {
    ...recordFor(
      { sessionId: `task-${t.id}`, sessionKind: 'task', permissionMode: null, jobId: null, teamRunId: null, itemId: t.itemId },
      `nudge-${at}`,
      SLACK_SEND_TOOL,
      { channel_id: want.channel, thread_ts: want.threadTs, message: want.message },
      { kind: 'message', why: 'name verb', whyDetail: 'slack_send_message', summary: `Nudge ${person}: ${firstLine(want.message)}` },
      at,
    ),
    status: error ? 'failed' : 'succeeded',
    link,
    error,
    allowedBy: rule ? 'rule' : 'prompt',
    allowedDetail: rule ? allowedDetailFor(rule) : 'on the item page',
    settledAt: now,
    updatedAt: now,
  }
  await onActionChain(rt, () => rt.store.actions.put(rec))
    .then(() => actionsChanged(rt, new Set([rec.sessionId])))
    .catch((err) => log('warn', 'tasks', `could not record the nudge: ${errText(err)}`, { task: t.id, workspace: rt.meta.id }))
}
