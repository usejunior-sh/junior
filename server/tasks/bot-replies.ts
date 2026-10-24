/**
 * Sending a bot triage's drafted replies (plan item `bot-triage-send`; the
 * pure half is core/babysit/bot-replies.ts). Two ways in, and only two:
 *
 *   you      the item page's Send (POST /api/tasks/send-bot-replies): every
 *            reply left goes, as you edited it; a thread you turned into Fix
 *            becomes a fix task instead
 *   a rule   an advance approval you wrote (`bot-reply`, who = the bot's
 *            login) covers that bot's replies: those go alone, as Junior
 *            drafted them, the moment the task is added; the rest wait for you
 *
 * Each reply posts on its thread, resolves it, and is its own record in
 * Junior's log (Sent, with who allowed it). Your approved verdicts feed the
 * tally in config (BOT_TALLY_KEY).
 */
import type { AdvanceApproval } from '../../core/approvals/approvals.js'
import { allowedDetailFor, BOT_REPLY_TOOL, describeApproval } from '../../core/approvals/approvals.js'
import { recordFor } from '../../core/actions/track.js'
import type { ActionRecord } from '../../core/actions/types.js'
import {
  BOT_REPLY_STEP,
  BOT_TALLY_KEY,
  botRepliesOf,
  replyArgs,
  replyEditsFrom,
  replyFixTask,
  replyPlan,
  replyUrlOf,
  resolveArgs,
  SEND_BOT_REPLIES_STEP,
  sendCommandLine,
  sendRecordSummary,
  sentLine,
  tallyFrom,
  tallyWith,
  verdictRecords,
  type PlannedSend,
  type ReplyPlan,
} from '../../core/babysit/bot-replies.js'
import { counts } from '../../core/babysit/bot-triage.js'
import type { ItemTask } from '../../core/work/tasks.js'
import { coveringApproval, useApproval } from '../approvals-ops.js'
import { gh } from '../babysit/glue.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import { onActionChain } from '../session/actions-hold.js'
import { actionsChanged } from '../session/actions-record.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { prOfItem, pumpTasks, tasksChanged } from './runner.js'

/** One `gh` call. Injected so a test can stand in for GitHub. */
export type GhRun = (args: string[]) => Promise<string>

/** You pressed Send on the card: every reply left goes out, as you edited it. */
export async function sendBotRepliesOp(rt: WorkspaceRuntime, taskId: string, raw: unknown, run: GhRun = gh): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.step !== SEND_BOT_REPLIES_STEP || t.state !== 'waiting') throw new Error('only waiting bot replies can be sent')
  // Planned before the claim: an empty reply you wrote never leaves the card.
  const plan = replyPlan(botRepliesOf(t.input), t.output?.handled ?? [], { by: 'you' }, replyEditsFrom(raw))
  return carryOut(rt, t, plan, run, new Map())
}

/**
 * The replies task was just added: the replies an advance approval covers go
 * alone. True = nothing on it waits for you any more; false = you still have
 * replies to send (or none was covered, or it failed), so it pings you.
 */
export async function botRepliesUnderApproval(rt: WorkspaceRuntime, t: ItemTask, run: GhRun = gh): Promise<boolean> {
  if (t.step !== SEND_BOT_REPLIES_STEP || t.state !== 'waiting' || !prOfItem(t.itemId)) return false
  const replies = botRepliesOf(t.input)
  const rules = new Map<string, AdvanceApproval>()
  for (const r of replies) {
    const a = await coveringApproval(rt, BOT_REPLY_TOOL, { bot: r.author }, { playbook: BOT_REPLY_STEP })
    if (a) rules.set(r.threadId, a)
  }
  if (!rules.size) return false
  const plan = replyPlan(replies, t.output?.handled ?? [], { by: 'rule', covers: (r) => rules.get(r.threadId)?.id ?? null })
  try {
    const after = await carryOut(rt, t, plan, run, rules)
    return after.state === 'done'
  } catch (err) {
    log('warn', 'tasks', `approved bot replies failed, they wait for you: ${errText(err)}`, { task: t.id, workspace: rt.meta.id })
    return false
  }
}

/** The plan, carried out: claimed, each reply sent and recorded, fixes added, the tally fed, the task moved on. */
async function carryOut(rt: WorkspaceRuntime, t: ItemTask, plan: ReplyPlan, run: GhRun, rules: ReadonlyMap<string, AdvanceApproval>): Promise<ItemTask> {
  const pr = prOfItem(t.itemId)
  if (!pr) throw new Error('this task is not on a GitHub PR')
  if (!plan.sends.length && !plan.fixes.length) throw new Error('nothing left to send')
  // Claim it first, so a double click (or the rule and you at once) sends once.
  if (!(await rt.store.tasks.move(t.id, 'queued', {}, Date.now()))) throw new Error('the task moved on before it could be sent')
  const handled = [...(t.output?.handled ?? [])]
  const sent: PlannedSend[] = []
  const errors: string[] = []
  for (const s of plan.sends) {
    const at = Date.now()
    const rule = s.allowedBy === 'rule' ? (rules.get(s.reply.threadId) ?? null) : null
    let url: string | null = null
    let error: string | null = null
    try {
      url = replyUrlOf(await run(replyArgs(s.reply.threadId, s.body)))
    } catch (err) {
      error = errText(err)
    }
    if (error === null) {
      handled.push(s.reply.threadId)
      sent.push(s)
      // The reply is out: a resolve that fails leaves the thread open, it never sends twice.
      await run(resolveArgs(s.reply.threadId)).catch((err) => log('warn', 'tasks', `replied, but could not resolve the thread: ${errText(err)}`, { task: t.id, workspace: rt.meta.id }))
      if (rule) await useApproval(rt, rule, `task-${t.id}`, undefined)
    } else errors.push(error)
    await recordReply(rt, t, pr, s, rule, at, url, error)
  }
  const now = Date.now()
  for (const r of plan.fixes) {
    await rt.store.tasks.add({ ...replyFixTask(r), itemId: t.itemId }, now)
    handled.push(r.threadId)
  }
  await feedTally(rt, pr.repo, sent, plan.fixes)

  const left = botRepliesOf(t.input).filter((r) => !handled.includes(r.threadId)).length
  const summary = sentLine(sent.length, plan.fixes.length, errors.length, plan.waiting.length)
  const output = { summary, handled }
  let after: ItemTask | null
  if (left === 0) {
    // queued → running → done: the same stamps a task Junior ran gets
    await rt.store.tasks.move(t.id, 'running', {}, Date.now())
    after = await rt.store.tasks.move(t.id, 'done', { output }, Date.now())
  } else after = await rt.store.tasks.move(t.id, 'waiting', { output, ...(errors.length ? { error: errors[0] } : {}) }, Date.now())

  const byRule = plan.sends.some((s) => s.allowedBy === 'rule')
  const firstRule = byRule ? [...rules.values()][0] : null
  if (sent.length || plan.fixes.length)
    await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: byRule ? 'junior' : 'you', text: firstRule ? `${summary} (approved in advance: ${describeApproval(firstRule)})` : summary, taskId: t.id })
  log('info', 'tasks', `bot replies on ${pr.repo}#${pr.number}: ${summary}${byRule ? ' (approved in advance)' : ''}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  if (plan.fixes.length) void pumpTasks(rt)
  // Nothing went out and nothing changed: say why on the card.
  if (!sent.length && !plan.fixes.length && errors.length) throw new Error(errors[0])
  return after ?? t
}

/** Your approved verdicts → the tally in config. A rule's sends don't count (bot-triage.ts, rule 3). */
async function feedTally(rt: WorkspaceRuntime, repo: string, sent: readonly PlannedSend[], fixes: Parameters<typeof verdictRecords>[2]): Promise<void> {
  const records = verdictRecords(repo, sent, fixes).filter(counts)
  if (!records.length) return
  try {
    const was = tallyFrom(await rt.store.config.get(BOT_TALLY_KEY))
    await rt.store.config.set(BOT_TALLY_KEY, tallyWith(was, records))
  } catch (err) {
    log('warn', 'tasks', `could not update the bot tally: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

/** One reply as one action record, so Junior's log lists each under Sent with who allowed it. */
async function recordReply(
  rt: WorkspaceRuntime,
  t: ItemTask,
  pr: { repo: string; number: number },
  s: PlannedSend,
  rule: AdvanceApproval | null,
  at: number,
  url: string | null,
  error: string | null,
): Promise<void> {
  const now = Date.now()
  const rec: ActionRecord = {
    ...recordFor(
      { sessionId: `task-${t.id}`, sessionKind: 'task', permissionMode: null, jobId: null, teamRunId: null, itemId: t.itemId },
      `bot-reply-${s.reply.threadId}-${at}`,
      'Bash',
      { command: sendCommandLine(s.reply.threadId, s.body) },
      { kind: 'comment', why: 'bash pattern', whyDetail: 'gh api graphql addPullRequestReviewThreadReply', summary: sendRecordSummary(s, pr) },
      at,
    ),
    status: error ? 'failed' : 'succeeded',
    link: url ?? s.reply.url ?? `https://github.com/${pr.repo}/pull/${pr.number}`,
    error,
    allowedBy: rule ? 'rule' : 'prompt',
    allowedDetail: rule ? allowedDetailFor(rule) : 'on the item page',
    settledAt: now,
    updatedAt: now,
  }
  await onActionChain(rt, () => rt.store.actions.put(rec))
    .then(() => actionsChanged(rt, new Set([rec.sessionId])))
    .catch((err) => log('warn', 'tasks', `could not record a bot reply: ${errText(err)}`, { task: t.id, workspace: rt.meta.id }))
}
