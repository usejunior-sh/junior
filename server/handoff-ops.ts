/**
 * Hand-offs, Phase 1 (artifact f335b876): you hand an item to Junior, pause
 * it, resume it, or say not this one to its suggestion. The Junior page, the
 * item page and the inbox all funnel through these.
 *
 *   your PR       handed off = babysat: its watch works it from the next poll
 *   review        handed off = first passes on its requests
 *   other items   handed off = its playbook starts (answer, debug-fix, investigate)
 *
 * Pause stops every task of Junior's on the item now; nothing of Junior's
 * runs on it until you resume (core/work/handoff.ts heldBy).
 *
 * Every answer carries the item's readiness: a PR handed off while its watch
 * is off reads "watch-off", so the client can say so. A hand-off never turns
 * a watch on; that stays your call in Settings → Automations.
 */
import { afterReason, clearSuppression, isNotNowReason, readSuppressState, REASON_WORDS, type NotNowReason, type Suppression, type SuppressState, SUPPRESS_KEY } from '../core/junior/suggest.js'
import { ruleFor, STARTABLE } from '../core/rules/rules.js'
import { isPlaybook, reasonOf, type Playbook } from '../core/work/fields.js'
import { handoffNote, handoffReadiness, PAUSED_ERROR, type HandoffReadiness } from '../core/work/handoff.js'
import type { WorkItem } from '../core/work/types.js'
import { babysitTick } from './babysit/glue.js'
import { errText } from './errors.js'
import { log } from './log.js'
import { reviewTick } from './review/glue.js'
import { currentRules, startPlaybook } from './rules-ops.js'
import { watchesOn } from './settings-ops.js'
import { pumpTasks, stopTaskOp, tasksChanged } from './tasks/runner.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

export type HandoffVerb = 'start' | 'pause' | 'resume' | 'not-now'
export const isHandoffVerb = (v: unknown): v is HandoffVerb => v === 'start' || v === 'pause' || v === 'resume' || v === 'not-now'

async function itemOf(rt: WorkspaceRuntime, raw: unknown): Promise<WorkItem> {
  const id = typeof (raw as { itemId?: unknown })?.itemId === 'string' ? (raw as { itemId: string }).itemId : ''
  const item = id ? await rt.store.items.get(id) : null
  if (!item) throw new Error('no such item')
  return item
}

/** The PR's watch reads it now, not at its next poll. */
function pollNow(rt: WorkspaceRuntime, item: WorkItem): void {
  const tick = reasonOf(item) === 'review-requested' ? reviewTick : babysitTick
  void tick(rt, true).catch((err) => log('error', 'handoff', `poll after hand-off failed: ${errText(err)}`, { item: item.id, workspace: rt.meta.id }))
}

const watched = (item: WorkItem) => {
  const r = reasonOf(item)
  return r === 'your-pr' || r === 'review-requested'
}

/** The playbook a hand-off starts: what you picked, else the item's rule, else investigate. */
async function playbookFor(rt: WorkspaceRuntime, item: WorkItem, picked: unknown): Promise<Playbook> {
  if (isPlaybook(picked)) {
    if (!STARTABLE.includes(picked)) throw new Error(`Junior can start ${STARTABLE.join(', ')} on an item`)
    return picked
  }
  const rule = ruleFor({ reason: reasonOf(item), ...(item.label ? { label: item.label } : {}) }, await currentRules(rt))
  return rule?.playbook && STARTABLE.includes(rule.playbook) ? rule.playbook : 'investigate'
}

/** Hand it to Junior. A note, if given, is kept on the item before any task starts, so the first one reads it. */
export async function handOffOp(rt: WorkspaceRuntime, raw: unknown): Promise<WorkItem> {
  const item = await itemOf(rt, raw)
  const note = handoffNote((raw as { note?: unknown })?.note)
  if (watched(item)) {
    await rt.store.items.setFields(item.id, { handoff: 'on', notNow: null, notNowReason: null })
    const what = reasonOf(item) === 'your-pr' ? 'babysit it' : 'do a first pass'
    await rt.store.items.addDecision(item.id, { at: Date.now(), by: 'you', text: `Handed to Junior to ${what}${note ? `. Note: ${note}` : ''}` })
    log('info', 'handoff', `handed off ${item.id}: ${what}`, { workspace: rt.meta.id })
    tasksChanged(rt)
    pollNow(rt, item)
  } else {
    const busy = (await rt.store.tasks.list(item.id)).find((t) => t.owner === 'junior' && (t.state === 'queued' || t.state === 'running'))
    if (busy) throw new Error(`"${busy.title}" is already on its way`)
    const playbook = await playbookFor(rt, item, (raw as { playbook?: unknown })?.playbook)
    if (note) await rt.store.items.addDecision(item.id, { at: Date.now(), by: 'you', text: `Handed to Junior. Note: ${note}` })
    const t = await startPlaybook(rt, item, playbook, 'you', 'you handed it off', `you@${Date.now()}`)
    if (!t) throw new Error('could not add the task')
  }
  return (await rt.store.items.get(item.id))!
}

/** Stop Junior on it: every task of its own stops now. */
export async function pauseOp(rt: WorkspaceRuntime, raw: unknown): Promise<WorkItem> {
  const item = await itemOf(rt, raw)
  await rt.store.items.setFields(item.id, { handoff: 'paused' })
  let stopped = 0
  for (const t of await rt.store.tasks.list(item.id)) {
    if (t.owner !== 'junior' || (t.state !== 'queued' && t.state !== 'running' && t.state !== 'waiting')) continue
    try {
      await stopTaskOp(rt, t.id, 'you', PAUSED_ERROR)
      stopped++
    } catch {
      // it finished in the meantime
    }
  }
  await rt.store.items.addDecision(item.id, { at: Date.now(), by: 'you', text: 'Paused Junior' })
  log('info', 'handoff', `paused ${item.id}${stopped ? `, ${stopped} task(s) stopped` : ''}`, { workspace: rt.meta.id })
  tasksChanged(rt)
  return (await rt.store.items.get(item.id))!
}

/** Junior picks it up again: a PR's watch reads it now; an item's paused tasks run again. */
export async function resumeOp(rt: WorkspaceRuntime, raw: unknown): Promise<WorkItem> {
  const item = await itemOf(rt, raw)
  if (item.handoff !== 'paused') throw new Error('it isn’t paused')
  await rt.store.items.setFields(item.id, { handoff: 'on' })
  await rt.store.items.addDecision(item.id, { at: Date.now(), by: 'you', text: 'Resumed Junior' })
  if (watched(item)) pollNow(rt, item)
  else {
    // the tasks the pause stopped, newest of each step, run again
    const tasks = await rt.store.tasks.list(item.id)
    const paused = new Map<string, (typeof tasks)[number]>()
    for (const t of tasks) if (t.owner === 'junior' && t.state === 'stopped' && t.error === PAUSED_ERROR) paused.set(t.step ?? t.title, t)
    for (const t of paused.values())
      await rt.store.tasks.add({ itemId: item.id, title: t.title, owner: 'junior', why: 'you', whyDetail: 'resumed', ...(t.step ? { step: t.step } : {}), ...(t.input ? { input: t.input } : {}) }, Date.now())
    void pumpTasks(rt)
  }
  log('info', 'handoff', `resumed ${item.id}`, { workspace: rt.meta.id })
  tasksChanged(rt)
  return (await rt.store.items.get(item.id))!
}

/** "Not this one": no more suggestions on it until something new happens. It stays in your inbox. */
export async function notNowOp(rt: WorkspaceRuntime, raw: unknown): Promise<WorkItem> {
  const item = await itemOf(rt, raw)
  await rt.store.items.setFields(item.id, { notNow: item.updatedAt })
  tasksChanged(rt)
  return (await rt.store.items.get(item.id))!
}

// "Not this one", with a reason (core/junior/suggest.ts): the reason is kept on
// the item; two matching reasons for one repo and kind add a suppression, kept
// in one config value and listed in Junior's notebook. HTTP only: your own signal.

const suppressWrites = new WeakMap<WorkspaceRuntime, Promise<unknown>>()

/** One writer at a time per workspace, so two quick reasons can't drop one. */
function serialSuppress<T>(rt: WorkspaceRuntime, fn: () => Promise<T>): Promise<T> {
  const next = (suppressWrites.get(rt) ?? Promise.resolve()).catch(() => undefined).then(fn)
  suppressWrites.set(rt, next)
  return next
}

export async function readSuppressions(rt: WorkspaceRuntime): Promise<SuppressState> {
  return readSuppressState(await rt.store.config.get<unknown>(SUPPRESS_KEY))
}

/** Every suppression in force, newest first. */
export async function listSuppressionsOp(rt: WorkspaceRuntime): Promise<Suppression[]> {
  return [...(await readSuppressions(rt)).suppressions].sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0))
}

/**
 * Why not this one ({ itemId, reason }): kept on the item, with when. Answers
 * the suppression it made, when it made one. Saying a reason also marks the
 * item not this one, so a reason never arrives without its mark.
 */
export async function notNowReasonOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<{ item: WorkItem; reason: NotNowReason; suppression: Suppression | null }> {
  const item = await itemOf(rt, raw)
  const reason = (raw as { reason?: unknown })?.reason
  if (!isNotNowReason(reason)) throw new Error('reason must be not-mine, too-small or handled')
  const at = new Date(now).toISOString()
  const made = await serialSuppress(rt, async () => {
    await rt.store.items.setFields(item.id, { notNow: item.notNow ?? item.updatedAt, notNowReason: { reason, at } })
    const items = await rt.store.items.list()
    const state = await readSuppressions(rt)
    const out = afterReason(state, items, item.id)
    if (out.made) await rt.store.config.set(SUPPRESS_KEY, out.state)
    return out.made
  })
  await rt.store.items.addDecision(item.id, { at: now, by: 'you', text: `Not this one: ${REASON_WORDS[reason]}` })
  log('info', 'handoff', `not this one, ${reason}: ${item.id}${made ? `; stopped suggesting ${made.key}` : ''}`, { workspace: rt.meta.id })
  tasksChanged(rt)
  return { item: (await rt.store.items.get(item.id))!, reason, suppression: made }
}

/** Clear one ({ key }): Junior suggests that kind in that repo again. */
export async function clearSuppressionOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<{ cleared: Suppression; suppressions: Suppression[] }> {
  const key = (raw as { key?: unknown } | null)?.key
  if (typeof key !== 'string' || !key.trim()) throw new Error('key is required')
  const removed = await serialSuppress(rt, async () => {
    const out = clearSuppression(await readSuppressions(rt), key, new Date(now).toISOString())
    if (out.removed) await rt.store.config.set(SUPPRESS_KEY, out.state)
    return out.removed
  })
  if (!removed) throw new Error(`nothing is suppressed for ${key}`)
  log('info', 'handoff', `suggesting ${key} again`, { workspace: rt.meta.id })
  tasksChanged(rt)
  return { cleared: removed, suppressions: await listSuppressionsOp(rt) }
}

/** Whether a hand-off of this item can do anything now: reads the watch switches, never writes them. */
export async function readinessOf(rt: WorkspaceRuntime, item: WorkItem): Promise<HandoffReadiness> {
  return handoffReadiness({ reason: reasonOf(item), source: item.source }, await watchesOn(rt))
}

export async function handoffOp(rt: WorkspaceRuntime, verb: HandoffVerb, raw: unknown): Promise<{ item: WorkItem; readiness: HandoffReadiness }> {
  const item = await (verb === 'start' ? handOffOp(rt, raw) : verb === 'pause' ? pauseOp(rt, raw) : verb === 'resume' ? resumeOp(rt, raw) : notNowOp(rt, raw))
  return { item, readiness: await readinessOf(rt, item) }
}
