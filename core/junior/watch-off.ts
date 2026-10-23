/**
 * A PR handed off while its watch is switched off (handoffReadiness in
 * core/work/handoff.ts): the words the Junior page says about it, and the
 * spend limit shown next to the Turn on button. Design note:
 * .docs/overnight-2026-10-24/designs/handoff-readiness-ui.md §6.
 *
 * Neutral on purpose: a switched-off watch isn't Junior waiting on you, so
 * nothing here is orange. Pure and browser-safe.
 */
import type { HandoffReadiness, JuniorWork, WatchId } from '../work/handoff.js'
import type { Handoff } from '../work/fields.js'

/** The two spend limits a Turn on button names; null until loaded, or when they can't be. */
export type WatchCaps = { perDayUsd: number; perReviewUsd: number }

/** "$20", "$1.50": dollars, no decimals when whole. */
export const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/** The Ledger state column for a handed-off PR whose watch is off. */
export const WATCH_OFF_CHIP: Record<WatchId, string> = { babysit: 'Babysitting off', review: 'Reviews off' }

/** The Ledger state column for a handed-off PR no watch can read (not from GitHub). */
export const WATCH_CANT_CHIP: Record<WatchId, string> = { babysit: 'Can’t babysit', review: 'Can’t review' }

/** Junior's line on the open card, and the confirmation right after a hand-off. */
export const WATCH_OFF_SAYS: Record<WatchId, string> = {
  babysit: 'Babysitting is off. Turn it on for your PRs?',
  review: 'First-pass reviews are off. Turn them on for your review requests?',
}

export const WATCH_CANT_SAYS: Record<WatchId, string> = {
  babysit: 'I babysit GitHub PRs only. Nothing runs on this one.',
  review: 'I review GitHub PRs only. Nothing runs on this one.',
}

/** The open card's ⏎ button. */
export const TURN_ON_LABEL: Record<WatchId, string> = { babysit: 'Turn on babysitting', review: 'Turn on reviews' }

/** The note on Suggested once the watch is on. */
export const WATCH_ON_SAYS: Record<WatchId, string> = {
  babysit: 'Babysitting is on. I’ll pick up your PRs on the next check.',
  review: 'First-pass reviews are on. I’ll pick up your requests on the next check.',
}

/** What a failed Turn on says, ahead of the server's error. */
export const WATCH_STILL_OFF: Record<WatchId, string> = {
  babysit: 'Babysitting is still off.',
  review: 'First-pass reviews are still off.',
}

/** The cap shown next to the button: "Up to $20 a day". Null when the limits aren't known. */
export function capText(watch: WatchId, caps: WatchCaps | null): string | null {
  if (!caps) return null
  return watch === 'babysit' ? `Up to ${usd(caps.perDayUsd)} a day` : `Up to ${usd(caps.perReviewUsd)} a review, ${usd(caps.perDayUsd)} a day`
}

/** The Turn on button's title: what it switches on, and its limits (or where to find them). */
export function turnOnTitle(watch: WatchId, caps: WatchCaps | null): string {
  const what = watch === 'babysit' ? 'Turns on babysitting for every PR you hand off.' : 'Turns on first-pass reviews for every PR you hand off.'
  if (!caps) return `${what} Limits are in Settings → Automations.`
  return watch === 'babysit' ? `${what} ${capText(watch, caps)}, set in Settings → Automations.` : `${what} ${capText(watch, caps)}.`
}

/** The limits from GET /api/babysit/settings; null for anything that isn't them. */
export function capsFrom(body: unknown): WatchCaps | null {
  const b = (body as { ok?: unknown; settings?: { budget?: { perDayUsd?: unknown; perReviewUsd?: unknown } } } | null) ?? null
  const d = b?.settings?.budget?.perDayUsd
  const r = b?.settings?.budget?.perReviewUsd
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  return b?.ok === true && ok(d) && ok(r) ? { perDayUsd: d, perReviewUsd: r } : null
}

type Handed = { id: string; handoff?: Handoff; junior?: JuniorWork }

/**
 * The row as the hand-off's own answer left it, until the inbox refetch
 * brings its readiness: a PR handed off with its watch off reads "off" at
 * once instead of flickering through "On it". The snapshot's readiness wins
 * once it is there; a ready answer changes nothing.
 */
export function withAnswer<T extends Handed>(i: T, answered: Readonly<Record<string, HandoffReadiness>>): T {
  const a = answered[i.id]
  if (!a || a.state === 'ready' || i.handoff !== 'on' || i.junior?.readiness) return i
  return { ...i, junior: { stage: 'watching', ...i.junior, readiness: a } }
}

/** Once `watch` is on, every row that waited on it is ready; the refetch settles the rest. */
export function markWatchOn<T extends Handed>(items: readonly T[], watch: WatchId): T[] {
  return items.map((i) => {
    const r = i.junior?.readiness
    return r?.state === 'watch-off' && r.watch === watch ? { ...i, junior: { ...i.junior!, readiness: { state: 'ready' } } } : i
  })
}
