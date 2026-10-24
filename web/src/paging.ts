/**
 * A paged session log on the client: which part of it the store holds, and
 * how a newly arrived page joins what is already there. Pure, so the store
 * stays a thin shell over it (and it can be tested without a socket).
 *
 * The server sends the newest page on a paged `subscribe` (a `history` frame
 * with `firstSeq` and `hasEarlier`) and each older page on request
 * (`session_events_page`). Seqs are dense from 1, so an event's place in the
 * whole log is `firstSeq - 1 + index`: what transcript keys and team-run
 * dividers count in.
 */
import type { SessionEvent } from '../../shared/protocol.js'

export type LoadedRange = {
  /** seq of the first event held */
  firstSeq: number
  /** older events exist on the server */
  hasEarlier: boolean
  /**
   * How many events from the start of the held array came from server pages,
   * one seq each. Live events appended after them may include some the log
   * never kept, so only this prefix is known to line up with seqs.
   */
  dense: number
}

/** A newest-page `history` frame from a paged subscribe. */
export type NewestPage = { events: readonly SessionEvent[]; hasEarlier: boolean; firstSeq?: number }

/**
 * Where the store lands when the newest page arrives: on open, after a
 * reconnect, or coming back to a session already read.
 *
 * If what is held reaches back past the new page's start through the part
 * known to line up with seqs, the older held events stay and the new page
 * replaces everything from its start on. A reconnect or a revisit then keeps
 * the pages you scrolled through. Otherwise the new page stands alone.
 * `range` is null for an empty session (nothing to page).
 */
export function joinNewest(
  held: readonly SessionEvent[] | undefined,
  heldRange: LoadedRange | undefined,
  page: NewestPage,
): { events: readonly SessionEvent[]; range: LoadedRange | null } {
  if (page.firstSeq === undefined || page.events.length === 0) return { events: page.events, range: null }
  const keep = heldRange && held ? page.firstSeq - heldRange.firstSeq : -1
  if (heldRange && held && keep >= 0 && keep <= heldRange.dense && keep <= held.length) {
    return {
      events: keep === 0 ? page.events : [...held.slice(0, keep), ...page.events],
      range: { firstSeq: heldRange.firstSeq, hasEarlier: heldRange.hasEarlier, dense: keep + page.events.length },
    }
  }
  return { events: page.events, range: { firstSeq: page.firstSeq, hasEarlier: page.hasEarlier, dense: page.events.length } }
}

/** An older page, `session_events_page`. */
export type OlderPage = { events: readonly SessionEvent[]; hasEarlier: boolean; firstSeq?: number }

/**
 * An older page goes in front. An empty one means there is nothing before:
 * the start is reached (or the session went away).
 */
export function prependOlder(
  held: readonly SessionEvent[],
  range: LoadedRange,
  page: OlderPage,
): { events: readonly SessionEvent[]; range: LoadedRange } {
  if (page.events.length === 0) return { events: held, range: { ...range, hasEarlier: false } }
  const firstSeq = page.firstSeq ?? range.firstSeq - page.events.length
  return {
    events: [...page.events, ...held],
    range: { firstSeq, hasEarlier: page.hasEarlier && firstSeq > 1, dense: range.dense + page.events.length },
  }
}

/** What the transcript needs to draw the "Earlier messages" row. */
export type SessionPaging = {
  /** events before the first one held: keys and dividers count from here */
  base: number
  hasEarlier: boolean
  state: 'idle' | 'loading' | 'failed'
}
