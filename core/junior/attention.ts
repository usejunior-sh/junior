/**
 * The attention split (.docs/overnight-2026-10-24/04-vision.md, the north
 * star): for one week, where each item Junior saw landed.
 *
 *   never-reached  closed without reaching Needs you, and you never touched it
 *   one-look       one read, one click: approve, answer, accept, dismiss
 *   your-work      you edited a send, did a task on it yourself, or it took
 *                  more than one look
 *   missed         a person waited past a working day before it reached you
 *
 * plus interrupt precision: of the items that reached Needs you, the share
 * you acted on (not snoozed first, not marked not useful, not left alone for
 * 3 days).
 *
 * The unit is an item's open cycle (core/work/state.ts itemCycles): a
 * reopened item is judged afresh. A cycle counts in the week it closed, or,
 * when missed, in the week its wait ran past the threshold, so it is counted
 * once, in one week, whenever you ask. An item with several cycles in a week
 * gets one row: the bucket that took most of you.
 *
 * Data only: nothing here is shown, scheduled or sent. Pure and
 * browser-safe: time is always an argument.
 */
import type { TrackOutcome } from '../approvals/track.js'
import { inboxTabOf } from '../work/inbox-tabs.js'
import { itemCycles, type ItemCycle, type ItemEvent } from '../work/state.js'
import type { TaskOwner, TaskState } from '../work/tasks.js'
import type { ScoredItem } from '../work/types.js'
import { juniorWaits } from './ledger.js'

export type AttentionBucket = 'never-reached' | 'one-look' | 'your-work' | 'missed'
export const ATTENTION_BUCKETS: readonly AttentionBucket[] = ['never-reached', 'one-look', 'your-work', 'missed']

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const WEEK_MS = 7 * DAY

/** A person waiting longer than this many working days before it reached you is a miss. */
export const MISSED_AFTER_WORKDAYS = 1
/** Reached you and nothing from you for this long: left unopened. */
export const UNOPENED_MS = 3 * DAY

/** Who did it, in the item log: a click in the web UI is `user`. */
const USER = 'user'

export type AttentionEvent = Pick<ItemEvent, 'at' | 'actor' | 'event'> & { detail?: Record<string, unknown> }

export type AttentionItem = {
  id: string
  /** when a person started waiting on you for it (epoch ms); null when nobody waits */
  waitingSince: number | null
  /** the item's whole log, oldest first */
  events: readonly AttentionEvent[]
}

/** A held send on an item, judged by core/approvals/track.ts. `at` = your decision. */
export type AttentionSend = { itemId: string; outcome: TrackOutcome; at: number | null }

/** A task on an item. Yours, done, means you worked it yourself. */
export type AttentionTask = { itemId: string; owner: TaskOwner; state: TaskState; endedAt?: number | null }

/** You handed the item to Junior. `at` unknown = before anything reached you. */
export type AttentionHandoff = { itemId: string; at: number | null }

export type AttentionInput = {
  items: readonly AttentionItem[]
  sends?: readonly AttentionSend[]
  tasks?: readonly AttentionTask[]
  handoffs?: readonly AttentionHandoff[]
}

export type AttentionOptions = {
  /** default MISSED_AFTER_WORKDAYS */
  missedAfterWorkdays?: number
  /** default UNOPENED_MS */
  unopenedMs?: number
}

export type AttentionRow = {
  itemId: string
  bucket: AttentionBucket
  /** one short sentence: why this bucket */
  reason: string
  /** the moment it counts: the close, or the moment the wait ran past the threshold */
  at: number
  /** cycles of this item that counted this week (2+ = it was reopened) */
  cycles: number
}

export type PrecisionMiss = 'snoozed' | 'not-useful' | 'unopened'

export type InterruptPrecision = {
  /** reached Needs you this week and you acted on it */
  acted: number
  /** reached Needs you this week, settled: acted plus missed */
  total: number
  /** reached you less than `unopenedMs` ago, nothing yet: not counted either way */
  pending: number
  /** acted / total; null when nothing settled */
  value: number | null
  misses: { itemId: string; why: PrecisionMiss }[]
}

export type AttentionSplit = {
  weekStart: number
  /** weekStart + 7 days */
  weekEnd: number
  counts: Record<AttentionBucket, number>
  /** one row per item, by the moment it counts */
  items: AttentionRow[]
  /** cycles open now that started before the window's end and aren't missed: they count when they close */
  open: number
  interruptPrecision: InterruptPrecision
}

/** What put an item on Needs you: Junior waits on you (the Junior page), or the inbox's Needs you now tab. */
export function needsYouVia(item: ScoredItem, now: number): 'junior' | 'inbox' | null {
  if (item.status && item.status !== 'open') return null
  if (juniorWaits(item)) return 'junior'
  return inboxTabOf(item, now) === 'needs' ? 'inbox' : null
}

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6

/**
 * `days` working days after `start`, in local time: Saturday and Sunday
 * don't count. A wait that starts on a weekend starts on Monday at 00:00.
 */
export function addWorkdays(start: number, days: number): number {
  const d = new Date(start)
  if (isWeekend(d)) {
    while (isWeekend(d)) d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
  }
  for (let left = Math.max(0, Math.floor(days)); left > 0; left--) {
    d.setDate(d.getDate() + 1)
    while (isWeekend(d)) d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

/** "26h", "3d": how long someone waited. */
export function waitText(ms: number): string {
  const h = Math.max(0, Math.round(ms / HOUR))
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** One thing you did on an item. `known: false` = when isn't recorded. */
type Act = {
  at: number
  known: boolean
  kind: 'close' | 'snooze' | 'not-useful' | 'other' | 'approve' | 'decide' | 'edit' | 'task' | 'handoff'
}

/** Everything known about one cycle, for the table. */
type Facts = {
  itemId: string
  closed: boolean
  closedAt: number | null
  closedByUser: boolean
  surfacedAt: number | null
  /** when it reached you: it surfaced, or you acted on it first, whichever came first */
  reachedAt: number | null
  /** when the person's wait started in this cycle, null when nobody waits */
  waitStart: number | null
  /** the wait ran past the threshold here, null when nobody waits */
  deadline: number | null
  acts: Act[]
  /** your touches from the moment it reached you (or from the start, if it never did) */
  looks: number
  now: number
}

const LOOK_VERB: Record<Act['kind'], string> = {
  close: 'you closed it',
  snooze: 'you snoozed it',
  'not-useful': 'you marked it not useful',
  other: 'you moved it',
  approve: 'you approved a send',
  decide: 'you decided on a send',
  edit: 'you edited a send',
  task: 'you did a task on it',
  handoff: 'you handed it off',
}

type Rule = { bucket: AttentionBucket; when: (f: Facts) => boolean; reason: (f: Facts) => string }

/** True when the wait ran past the threshold before the item reached you (or before it closed, or now). */
const isMissed = (f: Facts) => f.deadline !== null && f.deadline < (f.reachedAt ?? f.closedAt ?? f.now)

/**
 * The bucket rules, first match wins. Only `missed` can match an open cycle;
 * the last rule matches every closed cycle the others didn't, so each closed
 * cycle gets exactly one bucket.
 */
export const ATTENTION_RULES: readonly Rule[] = [
  {
    bucket: 'missed',
    when: isMissed,
    reason: (f) => {
      const waited = waitText((f.reachedAt ?? f.closedAt ?? f.now) - f.waitStart!)
      if (f.reachedAt !== null) return `Someone waited ${waited} before it reached you.`
      return f.closed ? `Someone waited ${waited}. It never reached you.` : `Someone has waited ${waited}. It hasn't reached you.`
    },
  },
  { bucket: 'your-work', when: (f) => f.closed && f.acts.some((a) => a.kind === 'edit'), reason: () => 'You edited a send before it went out.' },
  { bucket: 'your-work', when: (f) => f.closed && f.acts.some((a) => a.kind === 'task'), reason: () => 'You did a task on it yourself.' },
  { bucket: 'never-reached', when: (f) => f.closed && f.surfacedAt === null && f.looks === 0, reason: () => 'It closed without reaching you.' },
  {
    bucket: 'one-look',
    when: (f) => f.closed && f.looks <= 1,
    reason: (f) => {
      if (f.looks === 0) return 'It reached you, then closed with nothing from you.'
      const act = lookActs(f)[0]
      return `One look: ${act ? LOOK_VERB[act.kind] : 'you closed it'}.`
    },
  },
  { bucket: 'your-work', when: (f) => f.closed, reason: (f) => `It took ${f.looks} looks from you.` },
]

/** Your touches that count as looks: from when it reached you, or the whole cycle if it never did. */
function lookActs(f: Pick<Facts, 'acts' | 'surfacedAt'>): Act[] {
  return f.acts.filter((a) => a.kind !== 'close' && (f.surfacedAt === null || (a.known && a.at >= f.surfacedAt)))
}

/** Which bucket took more of you, for an item with several cycles in a week. */
const WEIGHT: Record<AttentionBucket, number> = { missed: 3, 'your-work': 2, 'one-look': 1, 'never-reached': 0 }

/** Your acts on each item, oldest first. Item events by `user`, send decisions, your tasks done, hand-offs. */
function actsByItem(input: AttentionInput, now: number): Map<string, Act[]> {
  const out = new Map<string, Act[]>()
  const add = (itemId: string, act: Act) => {
    if (act.known && act.at > now) return
    const list = out.get(itemId) ?? []
    list.push(act)
    out.set(itemId, list)
  }
  for (const item of input.items) {
    for (const e of item.events) {
      if (e.event === 'not-useful') add(item.id, { at: e.at, known: true, kind: 'not-useful' })
      else if (e.actor !== USER) continue
      else if (e.event === 'done' || e.event === 'archived') add(item.id, { at: e.at, known: true, kind: 'close' })
      else if (e.event === 'snoozed') add(item.id, { at: e.at, known: true, kind: 'snooze' })
      else if (e.event === 'reopened' || e.event === 'flow-set') add(item.id, { at: e.at, known: true, kind: 'other' })
    }
  }
  for (const s of input.sends ?? []) {
    const kind: Act['kind'] | null =
      s.outcome === 'as-drafted' || s.outcome === 'quick' ? 'approve' : s.outcome === 'edited' ? 'edit' : s.outcome === 'rejected' || s.outcome === 'sent-back' || s.outcome === 'undone' ? 'decide' : null
    if (kind) add(s.itemId, { at: s.at ?? 0, known: s.at !== null, kind })
  }
  for (const t of input.tasks ?? []) {
    if (t.owner === 'you' && t.state === 'done') add(t.itemId, { at: t.endedAt ?? 0, known: t.endedAt != null, kind: 'task' })
  }
  for (const h of input.handoffs ?? []) add(h.itemId, { at: h.at ?? 0, known: h.at !== null, kind: 'handoff' })
  for (const list of out.values()) list.sort((a, b) => a.at - b.at)
  return out
}

/** One cycle's facts. `nextStart` bounds which of your acts belong to it; unknown-time acts go to the last cycle, at its start. */
function factsOf(item: AttentionItem, cycle: ItemCycle<AttentionEvent>, nextStart: number | null, acts: readonly Act[], now: number, opts: Required<AttentionOptions>): Facts {
  const start = cycle.start.at
  const last = nextStart === null
  const mine = acts
    .filter((a) => (a.known ? a.at >= start && (last || a.at < nextStart) : last))
    .map((a) => (a.known ? a : { ...a, at: start }))
  const surfaced = cycle.events.find((e) => e.event === 'surfaced')
  const waitStart = item.waitingSince === null ? null : Math.max(item.waitingSince, start)
  const f: Facts = {
    itemId: item.id,
    closed: !!cycle.end,
    closedAt: cycle.end?.at ?? null,
    closedByUser: cycle.end?.actor === USER,
    surfacedAt: surfaced?.at ?? null,
    reachedAt: null,
    waitStart,
    deadline: waitStart === null ? null : addWorkdays(waitStart, opts.missedAfterWorkdays),
    acts: mine,
    looks: 0,
    now,
  }
  // your first act on it means it reached you, surfaced or not (a mark of not useful only follows a surfacing)
  const firstAct = mine.reduce<number | null>((m, a) => (a.kind === 'not-useful' || (m !== null && m <= a.at) ? m : a.at), null)
  f.reachedAt = f.surfacedAt === null ? firstAct : firstAct === null ? f.surfacedAt : Math.min(f.surfacedAt, firstAct)
  const looks = lookActs(f).length
  // closing it is part of the look you gave it; a close alone is one look
  f.looks = looks === 0 && f.closedByUser ? 1 : looks
  return f
}

/** Did you act on an interruption? Null = too early to say. */
function precisionOf(f: Facts, opts: Required<AttentionOptions>): 'acted' | PrecisionMiss | null {
  const from = f.surfacedAt!
  const after = f.acts.filter((a) => a.known && a.at >= from)
  if (after.some((a) => a.kind === 'not-useful')) return 'not-useful'
  const first = after[0]
  if (first && first.at - from <= opts.unopenedMs) return first.kind === 'snooze' ? 'snoozed' : 'acted'
  // nothing from you: unopened once the time is up, or once it closed without you
  if (f.now - from >= opts.unopenedMs || f.closed) return 'unopened'
  return null
}

/**
 * The attention split for the week starting `weekStart`, as known at `now`
 * (events after `now` haven't happened yet). A week still under way counts
 * up to `now`.
 */
export function attentionSplit(input: AttentionInput, weekStart: number, now: number, options: AttentionOptions = {}): AttentionSplit {
  const opts: Required<AttentionOptions> = {
    missedAfterWorkdays: options.missedAfterWorkdays ?? MISSED_AFTER_WORKDAYS,
    unopenedMs: options.unopenedMs ?? UNOPENED_MS,
  }
  const weekEnd = weekStart + WEEK_MS
  const end = Math.min(weekEnd, now)
  const inWeek = (at: number) => at >= weekStart && at < end
  const acts = actsByItem(input, now)

  const rows: AttentionRow[] = []
  let open = 0
  const precision: InterruptPrecision = { acted: 0, total: 0, pending: 0, value: null, misses: [] }

  for (const item of input.items) {
    const cycles = itemCycles(item.events.filter((e) => e.at <= now))
    let best: AttentionRow | null = null
    let counted = 0
    cycles.forEach((cycle, n) => {
      const f = factsOf(item, cycle, cycles[n + 1]?.start.at ?? null, acts.get(item.id) ?? [], now, opts)

      if (f.surfacedAt !== null && inWeek(f.surfacedAt)) {
        const p = precisionOf(f, opts)
        if (p === null) precision.pending++
        else if (p === 'acted') precision.acted++
        else precision.misses.push({ itemId: item.id, why: p })
      }

      const rule = ATTENTION_RULES.find((r) => r.when(f))
      if (!rule) {
        // open and not missed: it counts in the week it closes
        if (cycle.start.at < end) open++
        return
      }
      const at = rule.bucket === 'missed' ? f.deadline! : f.closedAt!
      if (!inWeek(at)) return
      counted++
      const row: AttentionRow = { itemId: item.id, bucket: rule.bucket, reason: rule.reason(f), at, cycles: 1 }
      if (!best || WEIGHT[row.bucket] > WEIGHT[best.bucket]) best = row
    })
    if (best) rows.push({ ...(best as AttentionRow), cycles: counted })
  }

  precision.total = precision.acted + precision.misses.length
  precision.value = precision.total ? precision.acted / precision.total : null
  rows.sort((a, b) => a.at - b.at || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
  const counts = Object.fromEntries(ATTENTION_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length])) as Record<AttentionBucket, number>
  return { weekStart, weekEnd, counts, items: rows, open, interruptPrecision: precision }
}
