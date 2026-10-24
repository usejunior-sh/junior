/**
 * Due nudges are suggestions (plan item `nudge-suggest`). A built-in rule
 * never creates work or a draft on its own (hand-offs, Phase 1): the Junior
 * page marks a Waiting row with its due nudge, and a draft exists only when
 * you pick "Draft nudge". Then it is one task on you, holding the text, and
 * nothing goes out until you send it (or an advance approval you wrote
 * covers it).
 *
 * Who an item waits on, read off what Junior already knows:
 *
 *   reviewers  your open PR, waiting on the reviewers asked: each login, since
 *              the babysit watch first saw the request (`seen.reviewers`)
 *   follow-up  an item that says you wait on someone (ask `follow-up`): its
 *              author, since the turn went to them
 *
 * Every other item names nobody, so it never gets a nudge.
 *
 * How the nudge goes out comes from the item's source descriptor
 * (shared/sources.ts): a source with its own reply route (`canReply`) can
 * send it there; every other offers "Copy text", and you mark it sent.
 *
 * Pure and browser-safe: `now` is always an argument.
 */
import { sourceOf, type ReplyRoute } from '../../shared/sources.js'
import { dueNudges, nudgeText, personKey, type NudgeItem, type NudgeOptions, type NudgeSent, type WaitingItem, type WaitingOn } from './nudge.js'
import type { NewTask } from './tasks.js'
import { turnOf, type TurnContext, type TurnItem } from './turn.js'
import type { RequestedReviewer } from './handoff.js'

/** The task step a drafted nudge waits on. */
export const NUDGE_STEP = 'nudge'

/** Where the cooldown reads what went out: one JSON list in config. */
export const NUDGES_SENT_KEY = 'nudge.sent'

/** How a nudge leaves: sent on the source's own reply route, or copied by you. */
export type NudgeRoute = { send: true; via: ReplyRoute['via']; lands: string } | { send: false }

/** A Waiting row's due nudge, as the Junior page shows it ("Waiting 3d · Draft nudge?"). */
export type NudgeMark = {
  /** who to nudge, without a leading "@" */
  person: string
  /** epoch ms the wait started */
  since: number
  /** working days waited so far */
  workingDays: number
  /** other items waiting on the same person */
  alsoWaiting: string[]
  route: NudgeRoute
}

/** What a nudge reads off an item: its turn, and what names it. */
export type NudgeSourceItem = TurnItem & {
  id: string
  title: string
  url: string
  author: string
  updatedAt: string
}

/** The route from the source descriptor: its own reply route when it has one, else Copy text. */
export function nudgeRoute(source: string | null | undefined): NudgeRoute {
  const d = sourceOf(source)
  return d.canReply && d.reply ? { send: true, via: d.reply.via, lands: d.reply.lands } : { send: false }
}

const OWN_PR = /^own-pr-/

/** The people an item waits on, and since when. Empty unless it is someone else's turn and Junior can name them. */
export function waitingOf(item: NudgeSourceItem, ctx: TurnContext = {}): WaitingOn[] {
  const t = turnOf(item, ctx)
  if (t.turn !== 'others') return []
  if (t.reason === 'snoozed' || t.reason === 'closed' || t.reason === 'main-red' || t.reason === 'review-posted') return []
  const reviewers = OWN_PR.test(item.kind) ? (item.seen?.reviewers ?? []) : []
  if (reviewers.length) return reviewers.map((r) => ({ person: r.login, since: r.since }))
  if (t.reason === 'follow-up' && item.author.trim()) {
    const since = item.flow?.since ?? Date.parse(item.updatedAt)
    return Number.isFinite(since) ? [{ person: item.author, since }] : []
  }
  return []
}

/** How a nudge names the item: its id, title and link; the ref comes from the id (nudge.ts refOf). */
export const nudgeItemOf = (item: Pick<NudgeSourceItem, 'id' | 'title' | 'url'>): NudgeItem => ({ id: item.id, title: item.title, ...(item.url ? { url: item.url } : {}) })

/**
 * The due nudge per item, keyed by item id: at most one per person across
 * every item (nudge.ts), and one per item (its longest wait). Reads only:
 * it creates nothing.
 */
export function nudgeMarks(
  items: readonly NudgeSourceItem[],
  now: number,
  opts: NudgeOptions = {},
  sent: readonly NudgeSent[] = [],
  ctxOf: (id: string) => TurnContext | undefined = () => undefined,
): Record<string, NudgeMark> {
  const bySource = new Map<string, string>()
  const waiting: WaitingItem[] = []
  for (const i of items) {
    if (i.status && i.status !== 'open') continue
    const on = waitingOf(i, ctxOf(i.id) ?? {})
    if (!on.length) continue
    bySource.set(i.id, String(i.source))
    waiting.push({ ...nudgeItemOf(i), waitingOn: on })
  }
  const out: Record<string, NudgeMark> = {}
  for (const n of dueNudges(waiting, now, opts, sent)) {
    if (out[n.item.id]) continue
    out[n.item.id] = { person: n.person, since: n.since, workingDays: n.workingDays, alsoWaiting: n.alsoWaiting, route: nudgeRoute(bySource.get(n.item.id)) }
  }
  return out
}

// ── The draft: one task on you ─────────────────────────────────────────────

/** What a nudge task carries. `route` is what the source offered when it was drafted; the send reads it again. */
export type NudgeInput = { person: string; text: string; since: number; route: ReplyRoute['via'] | null }

export function nudgeInputOf(input: Record<string, unknown> | undefined): NudgeInput | null {
  if (!input) return null
  const { person, text, since, route } = input
  if (typeof person !== 'string' || !person.trim() || typeof text !== 'string' || typeof since !== 'number') return null
  return { person, text, since, route: route === 'slack-thread' ? route : null }
}

/** The task you asked for: on you, waiting, holding the drafted text. Keyed per draft so a later nudge is its own task. */
export function nudgeTask(item: NudgeSourceItem, wait: WaitingOn, now: number): NewTask & { input: NudgeInput } {
  const person = wait.person.trim().replace(/^@+/, '')
  const route = nudgeRoute(item.source)
  return {
    itemId: item.id,
    title: `Nudge ${person}`,
    owner: 'you',
    why: 'you',
    whyDetail: 'you asked for a nudge',
    step: NUDGE_STEP,
    state: 'waiting',
    key: `nudge:${personKey(person)}:${now}`,
    input: { person, text: nudgeText(nudgeItemOf(item), person), since: wait.since, route: route.send ? route.via : null },
  }
}

/** The wait a draft is for: the person you named (matched without case or "@"), else the longest. */
export function pickWait(waits: readonly WaitingOn[], person?: string): WaitingOn | null {
  if (person?.trim()) return waits.find((w) => personKey(w.person) === personKey(person)) ?? null
  return [...waits].sort((a, b) => a.since - b.since)[0] ?? null
}

// ── The cooldown's record ─────────────────────────────────────────────────

const SENT_KEEP_MS = 30 * 86_400_000
const SENT_CAP = 500

/** The sent list as config holds it; junk reads as nothing. */
export function nudgesSentFrom(raw: unknown): NudgeSent[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r): NudgeSent[] => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    if (typeof o.person !== 'string' || !o.person.trim() || typeof o.at !== 'number' || !Number.isFinite(o.at)) return []
    return [{ person: o.person, at: o.at, ...(typeof o.itemId === 'string' ? { itemId: o.itemId } : {}) }]
  })
}

/** A nudge went out: appended, and the list kept to the last 30 days (and 500 entries). */
export function nudgeSentWith(list: readonly NudgeSent[], entry: NudgeSent, now: number): NudgeSent[] {
  return [...list, entry].filter((s) => now - s.at < SENT_KEEP_MS).slice(-SENT_CAP)
}

/**
 * The reviewers a PR asked, each since the first poll that saw the request.
 * A request seen before keeps its time; a reviewer no longer asked drops off,
 * and comes back with a fresh time if asked again.
 */
export function requestedSince(prev: readonly RequestedReviewer[] | undefined, logins: readonly string[], now: number): RequestedReviewer[] {
  const was = new Map((prev ?? []).map((r) => [r.login.toLowerCase(), r.since]))
  const seen = new Set<string>()
  const out: RequestedReviewer[] = []
  for (const login of logins) {
    const key = login.toLowerCase()
    if (!login || seen.has(key)) continue
    seen.add(key)
    out.push({ login, since: was.get(key) ?? now })
  }
  return out
}
