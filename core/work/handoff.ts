/**
 * Hand-offs, Phase 1 (artifact f335b876): Junior works only what you hand it.
 * Your PRs and review requests are watched always, but a watch's task runs
 * only on a PR you handed off. Pause stops Junior on one item; nothing of
 * Junior's runs on it until you resume.
 *
 * Here: the gate the runner asks, where an item stands with Junior (the With
 * Junior tab's row), the draft PR Junior opened from an item, and the one-time
 * carry-over of the PRs Junior was already babysitting when the switch went.
 *
 * Pure, browser-safe.
 */
import type { Handoff } from './fields.js'
import type { ItemTask } from './tasks.js'

/** A PR at a glance, as the babysit watch last read it: what Junior would take on if you handed it off. */
export type PrSeen = {
  /** failing checks, by name */
  red: string[]
  /** open threads from bots, and from people */
  bots: number
  people: number
  rebase: 'conflict' | 'behind' | null
  draft: boolean
}

/** Steps a PR's watch adds for Junior: they run only on a PR you handed off. */
export const WATCH_STEPS: ReadonlySet<string> = new Set(['fix-ci', 'fix-thread', 'rebase', 'review'])

/** Why Junior may not run a task with this step on an item now; null = it may. */
export function heldBy(step: string | undefined, handoff: Handoff | undefined): string | null {
  if (handoff === 'paused') return 'you paused it'
  if (step && WATCH_STEPS.has(step) && handoff !== 'on') return 'not handed off'
  return null
}

/**
 * The watches a workspace switches on or off one by one (Settings → Automations):
 * babysit fixes your PRs, review takes a first pass at PRs that ask for you.
 * Off = it stops polling, and its queued tasks wait until it is back on.
 */
export type WatchId = 'babysit' | 'review'
export type WatchSwitches = Record<WatchId, boolean>

/** The watch a task came from; null = one you asked for (a retry, a resume, a playbook), which no switch holds. */
export function watchOf(t: Pick<ItemTask, 'step' | 'why'>): WatchId | null {
  if (t.why === 'you' || !t.step || !WATCH_STEPS.has(t.step)) return null
  return t.step === 'review' ? 'review' : 'babysit'
}

/** What a stop on pause writes on a task, so resume knows which to run again. */
export const PAUSED_ERROR = 'you paused it'

const unfinished = (t: Pick<ItemTask, 'state'>) => t.state === 'queued' || t.state === 'running' || t.state === 'waiting'

/** Handed to Junior: you said so, or Junior has a task of its own still open on it. */
export function handedOff(handoff: Handoff | undefined, tasks: readonly Pick<ItemTask, 'owner' | 'state'>[]): boolean {
  return handoff !== undefined || tasks.some((t) => t.owner === 'junior' && unfinished(t))
}

/**
 * Where an item stands with Junior, for its row on the With Junior tab:
 *   paused      you paused it
 *   needs-you   a task waits on you: a plan to approve, a send, a question,
 *               or Junior's task failed
 *   working     a task of Junior's runs or is queued
 *   watching    a PR handed off, nothing to do right now
 *   handed-in   Junior's last task finished; nothing left for it
 */
export type WorkStage = 'paused' | 'needs-you' | 'working' | 'watching' | 'handed-in'

/**
 * The debug-fix pipeline: plan → approve → work → PR → babysit. `done` steps
 * are behind it, `at` is whose move the current one is (null when finished).
 */
export type Pipeline = { done: number; at: 'junior' | 'you' | null }
export const PIPELINE_STEPS = ['Plan', 'Approve', 'Work', 'Draft PR', 'Babysit'] as const

export type JuniorWork = {
  stage: WorkStage
  /** debug-fix items only */
  pipeline?: Pipeline
  /** the draft PR Junior opened from this item, as its item id */
  pr?: string
}

type T = Pick<ItemTask, 'owner' | 'state' | 'step' | 'createdAt' | 'output'>

/** "https://github.com/acme/web/pull/3318" in a hand-in line → "github:acme/web#3318". */
export function prItemIn(text: string | undefined): string | null {
  const m = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(text ?? '')
  return m ? `github:${m[1]}#${m[2]}` : null
}

/** The draft PR an item's debug-fix opened: its done task's hand-in names it. */
export function openedPr(tasks: readonly T[]): string | null {
  const fix = [...tasks].reverse().find((t) => t.step === 'debug-fix' && t.state === 'done')
  return fix ? prItemIn(fix.output?.summary) : null
}

function pipelineOf(tasks: readonly T[], prHanded: boolean): Pipeline | undefined {
  const last = (step: string) => [...tasks].reverse().find((t) => t.step === step)
  const plan = last('debug-plan')
  if (!plan) return undefined
  const approve = last('approve-plan')
  const fix = last('debug-fix')
  if (fix?.state === 'done') return prHanded ? { done: 5, at: null } : { done: 3, at: 'you' }
  if (fix) return { done: 2, at: fix.state === 'waiting' || fix.state === 'failed' ? 'you' : 'junior' }
  if (approve && approve.state !== 'done') return { done: 1, at: 'you' }
  if (plan.state === 'done') return { done: 1, at: 'you' }
  return { done: 0, at: plan.state === 'failed' || plan.state === 'waiting' ? 'you' : 'junior' }
}

/**
 * Where an item stands with Junior; null when it isn't handed off. `isPr`:
 * a PR whose watch works it (babysit or review). `prHanded`: the draft PR
 * Junior opened from it is handed off too.
 */
export function juniorWork(handoff: Handoff | undefined, tasks: readonly T[], isPr: boolean, prHanded = false): JuniorWork | null {
  if (!handedOff(handoff, tasks)) return null
  const pr = openedPr(tasks)
  const pipeline = pipelineOf(tasks, prHanded)
  const extra = { ...(pipeline ? { pipeline } : {}), ...(pr ? { pr } : {}) }
  if (handoff === 'paused') return { stage: 'paused', ...extra }
  const lastDone = Math.max(0, ...tasks.filter((t) => t.state === 'done').map((t) => t.createdAt))
  const asks = tasks.some((t) => t.state === 'waiting' || (t.state === 'failed' && t.owner === 'junior' && t.createdAt > lastDone))
  if (asks) return { stage: 'needs-you', ...extra }
  if (tasks.some((t) => t.owner === 'junior' && (t.state === 'running' || t.state === 'queued'))) return { stage: 'working', ...extra }
  // a finished pipeline whose PR waits on your call to babysit it
  if (pipeline?.at === 'you') return { stage: 'needs-you', ...extra }
  return { stage: isPr && handoff === 'on' ? 'watching' : 'handed-in', ...extra }
}

/**
 * The switch-over: Junior used to babysit every PR and first-pass every
 * request. The PRs it had already worked stay handed off, so nothing in
 * flight is dropped. `babysit` / `reviews`: the old switches, as they were.
 */
export function legacyHandoffs(
  items: readonly { id: string; reason: string; handoff?: Handoff }[],
  tasks: ReadonlyMap<string, readonly Pick<ItemTask, 'owner' | 'step'>[]>,
  was: { babysit: boolean; reviews: boolean },
): string[] {
  const out: string[] = []
  for (const i of items) {
    if (i.handoff) continue
    const mine = (tasks.get(i.id) ?? []).filter((t) => t.owner === 'junior')
    if (was.babysit && i.reason === 'your-pr' && mine.some((t) => t.step !== 'review')) out.push(i.id)
    else if (was.reviews && i.reason === 'review-requested' && mine.some((t) => t.step === 'review')) out.push(i.id)
  }
  return out
}
