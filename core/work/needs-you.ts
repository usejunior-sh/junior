/**
 * How many things in one workspace need the user right now: the rail's orange
 * number and a workspace tab's count. Pure and browser-safe, so the open page
 * and the daemon (counting every workspace for the tabs) can't disagree.
 *
 * A waiting session is one with a permission prompt or question on the user.
 * A DM counts the same as any other chat; job runs never reach the list.
 */
export type NeedsYouSession = { waiting?: boolean }

export function needsYouCount(sessions: readonly NeedsYouSession[], pendingActions: number): number {
  return pendingActions + sessions.filter((s) => s.waiting).length
}
