/**
 * Waiting on others: which people are past the wait threshold, and the short
 * line that nudges them. Pure, browser-safe, local time; `now` is always an
 * argument, never read from the clock.
 *
 * This module only says who is due and what the text would be. It creates
 * nothing and sends nothing: nudge-suggest turns a due nudge into a
 * suggestion on the row, and a draft exists only when the user asks for one.
 * Any send goes through core/actions/policy.ts like every other.
 *
 * The rules:
 *
 *   threshold  a wait is due once `thresholdWorkingDays` working days have
 *              passed since it started (default 2). Weekends don't count:
 *              a wait from Friday 10:00 is due Tuesday 10:00, not Sunday.
 *   cooldown   one nudge per person per `cooldownHours` (default 24),
 *              across every item. Two of your PRs waiting on @ana make one
 *              nudge, for the one that has waited longest; the rest ride
 *              along in `alsoWaiting`.
 *   skipped    you, bots (`name[bot]`), blank names, and waits with a start
 *              time that is missing or in the future.
 *
 * Holidays aren't known (shared/when.ts has the same limit).
 */
import { addWorkingDays, workingDaysBetween } from '../../shared/when.js'

export interface NudgeOptions {
  /** Working days a wait must reach before a nudge is due. Default 2. */
  thresholdWorkingDays?: number
  /** Hours between two nudges to the same person. Default 24. */
  cooldownHours?: number
  /** Your own handle: never nudge yourself. Compared without case or "@". */
  me?: string
}

export const NUDGE_DEFAULTS = { thresholdWorkingDays: 2, cooldownHours: 24 } as const

/** The item a nudge is about: enough to name it in one line. */
export interface NudgeItem {
  /** stable id, e.g. "github:owner/repo#123" */
  id: string
  title: string
  url?: string
  /** a short ref to name it by ("#3235", "NOV-456"); derived from `id` when absent */
  ref?: string
  /** what it holds up, in a few words ("release-4.2"); the second sentence */
  blocks?: string
}

/** One person an item waits on, and since when (epoch ms). */
export interface WaitingOn {
  person: string
  since: number
}

/** An item on the Waiting tab and the people it waits on. */
export interface WaitingItem extends NudgeItem {
  waitingOn: readonly WaitingOn[]
}

/** A nudge that went out: the cooldown reads these. */
export interface NudgeSent {
  person: string
  /** epoch ms it was sent */
  at: number
  itemId?: string
}

export interface DueNudge {
  /** the person as the item gave it, without a leading "@" */
  person: string
  /** the item that has waited on them longest */
  item: NudgeItem
  /** epoch ms the wait started */
  since: number
  /** working days waited so far (date-based, for "Waiting 3d") */
  workingDays: number
  /** other items waiting on the same person, longest first */
  alsoWaiting: string[]
}

const HOUR = 3_600_000

/** A handle for comparing: no "@", no case, no spaces around it. */
export function personKey(person: string): string {
  return person.trim().replace(/^@+/, '').toLowerCase()
}

const isBot = (key: string) => /\[bot\]$/.test(key) || /-bot$/.test(key)

/** When the wait that started at `since` is due: `threshold` working days later, same time of day. */
export function nudgeDueAt(since: number, thresholdWorkingDays: number = NUDGE_DEFAULTS.thresholdWorkingDays): number {
  return addWorkingDays(since, Math.max(0, thresholdWorkingDays))
}

/** The newest nudge per person (keyed by personKey). */
export function lastNudged(sent: readonly NudgeSent[]): Map<string, number> {
  const last = new Map<string, number>()
  for (const s of sent) {
    const key = personKey(s.person)
    if (!key || !Number.isFinite(s.at)) continue
    if ((last.get(key) ?? -Infinity) < s.at) last.set(key, s.at)
  }
  return last
}

/**
 * When the cooldown lets `person` be nudged again: the last nudge plus
 * `cooldownHours`, or 0 when they were never nudged.
 */
export function cooldownEndsAt(person: string, sent: readonly NudgeSent[], cooldownHours: number = NUDGE_DEFAULTS.cooldownHours): number {
  const last = lastNudged(sent).get(personKey(person))
  return last === undefined ? 0 : last + Math.max(0, cooldownHours) * HOUR
}

/**
 * The nudges due at `now`: at most one per person, past the threshold and
 * out of the cooldown, longest wait first. Ties keep the input order.
 */
export function dueNudges(
  waiting: readonly WaitingItem[],
  now: number,
  opts: NudgeOptions = {},
  sent: readonly NudgeSent[] = [],
): DueNudge[] {
  const threshold = opts.thresholdWorkingDays ?? NUDGE_DEFAULTS.thresholdWorkingDays
  const cooldownMs = Math.max(0, opts.cooldownHours ?? NUDGE_DEFAULTS.cooldownHours) * HOUR
  const me = opts.me ? personKey(opts.me) : ''
  const last = lastNudged(sent)

  // every person's waits, past the threshold, longest first
  const byPerson = new Map<string, { person: string; waits: { item: WaitingItem; since: number; order: number }[] }>()
  let order = 0
  for (const item of waiting) {
    const seen = new Set<string>()
    for (const w of item.waitingOn) {
      order++
      const key = personKey(w.person)
      if (!key || key === me || isBot(key) || seen.has(key)) continue
      if (!Number.isFinite(w.since) || w.since > now) continue
      if (nudgeDueAt(w.since, threshold) > now) continue
      seen.add(key)
      const entry = byPerson.get(key) ?? { person: w.person.trim().replace(/^@+/, ''), waits: [] }
      entry.waits.push({ item, since: w.since, order })
      byPerson.set(key, entry)
    }
  }

  const out: (DueNudge & { order: number })[] = []
  for (const [key, { person, waits }] of byPerson) {
    const prev = last.get(key)
    if (prev !== undefined && now - prev < cooldownMs) continue
    waits.sort((a, b) => a.since - b.since || a.order - b.order)
    const [first, ...rest] = waits
    if (!first) continue
    out.push({
      person,
      item: pickItem(first.item),
      since: first.since,
      workingDays: workingDaysBetween(first.since, now),
      alsoWaiting: rest.map((w) => w.item.id),
      order: first.order,
    })
  }
  out.sort((a, b) => a.since - b.since || a.order - b.order)
  return out.map(({ order: _order, ...n }) => n)
}

function pickItem(i: WaitingItem): NudgeItem {
  return {
    id: i.id,
    title: i.title,
    ...(i.url !== undefined ? { url: i.url } : {}),
    ...(i.ref !== undefined ? { ref: i.ref } : {}),
    ...(i.blocks !== undefined ? { blocks: i.blocks } : {}),
  }
}

// ── Text ──────────────────────────────────────────────────────────────────

const TITLE_MAX = 60
const BLOCKS_MAX = 40

/** "#3235" from "github:owner/repo#3235", "NOV-456" from "linear:NOV-456"; else null. */
export function refOf(id: string): string | null {
  const num = /#(\d+)$/.exec(id)
  if (num) return `#${num[1]}`
  const key = /^[a-z]+:([A-Z][A-Z0-9]+-\d+)$/.exec(id)
  return key ? key[1]! : null
}

/**
 * One line of free text, safe inside a sentence: no line breaks, no
 * sentence-ending marks, cut at a word near `max`.
 */
function phrase(text: string, max: number): string {
  let s = text.replace(/\s+/g, ' ').replace(/[.!?]+(\s|$)/g, '$1').trim()
  s = s.replace(/[.!?:;,\s]+$/, '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}…`
}

/** "@ana", or the mention as given when it is already a Slack-style "<@U123>". */
export function mentionOf(person: string): string {
  const p = person.trim()
  if (p.startsWith('<@')) return p
  return `@${p.replace(/^@+/, '')}`
}

/** How the item is named: its ref and title ("#3235 (Fix login redirect)"), or the title alone. */
export function itemName(item: NudgeItem): string {
  const ref = item.ref?.trim() || refOf(item.id)
  const title = phrase(item.title, TITLE_MAX)
  if (ref && title) return `${ref} (${title})`
  return ref || (title ? `"${title}"` : 'this')
}

/**
 * The nudge, at most two sentences, naming what's blocked:
 * "Hi @ana, could you look at #3235 (Fix login redirect)? It blocks release-4.2."
 * Without `blocks`, just the first sentence.
 */
export function nudgeText(item: NudgeItem, person: string): string {
  const ask = `Hi ${mentionOf(person)}, could you look at ${itemName(item)}?`
  const blocks = item.blocks ? phrase(item.blocks, BLOCKS_MAX) : ''
  return blocks ? `${ask} It blocks ${blocks}.` : ask
}
