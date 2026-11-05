/**
 * DMs: each agent's one long-running chat on the Agents page. A DM is an
 * ordinary session with `kind: 'dm'` and the agent it talks as; there is at
 * most one per agent. Junior itself has no agent name, so its key is `junior`.
 *
 * Pure and browser-safe: the server finds the DM to reuse, the web finds the
 * one to show.
 */

/** Junior's own DM key: plain Junior, no chat agent. */
export const JUNIOR_DM = 'junior'

/** The DM key for a session's agent: its name, or `junior` for plain Junior. */
export const dmKey = (agent: string | null | undefined): string => agent || JUNIOR_DM

/** The chat agent a DM key talks as: undefined for Junior. */
export const dmAgent = (key: string): string | undefined => (key === JUNIOR_DM ? undefined : key)

/** The DM for one key, if it has one yet. */
export function findDm<T extends { kind?: string | null; agent?: string | null }>(rows: Iterable<T>, key: string): T | undefined {
  for (const r of rows) if (r.kind === 'dm' && dmKey(r.agent) === key) return r
  return undefined
}
