/**
 * Which login paid for each usage entry. Claude Code's transcripts don't say,
 * so it is pieced together from two things triage knows:
 *
 *  - the config dir a transcript sits under: one claude.ai login per dir
 *    (`~/.claude` is the machine's, a config-dir workspace has its own);
 *  - the starts triage recorded: each Claude spawn's init says whether it ran
 *    on an API key, and the server knows which key it handed it.
 *
 * A session can change login mid-life (its workspace moved to an API key and
 * it was resumed), so a session's starts are a timeline and each entry takes
 * the last start at or before it. A session triage never started (a terminal,
 * an IDE) has no starts and stays with its dir's login.
 */
import { entryCost, type UsageEntry } from './ledger.js'

/** One Claude spawn. `key` is the API-key login it ran on; absent = its config dir's own login. */
export type LoginStart = { sessionId: string; at: number; key?: string }

/** The login of `~/.claude`, and of any transcript under a root nobody claimed. */
export const MACHINE_LOGIN = 'machine'

export type LoginTotals = { cost: number; tokens: number; messages: number }

/** Starts grouped by Claude session id, each timeline oldest first. */
export function timelines(starts: Iterable<LoginStart>): Map<string, LoginStart[]> {
  const out = new Map<string, LoginStart[]>()
  for (const s of starts) {
    const list = out.get(s.sessionId)
    if (list) list.push(s)
    else out.set(s.sessionId, [s])
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at)
  return out
}

export function loginOf(e: UsageEntry, starts: ReadonlyMap<string, LoginStart[]>, rootLogins: ReadonlyMap<string, string>): string {
  const own = rootLogins.get(e.root) ?? MACHINE_LOGIN
  const timeline = e.sessionId ? starts.get(e.sessionId) : undefined
  if (!timeline?.length) return own
  // An entry stamped before the first start (clock skew, a replayed parent) takes the first.
  let pick = timeline[0]
  for (const s of timeline) {
    if (s.at > e.ts) break
    pick = s
  }
  return pick.key ?? own
}

/** Entries split by the login that paid for them. */
export function byLogin(
  entries: UsageEntry[],
  starts: ReadonlyMap<string, LoginStart[]>,
  rootLogins: ReadonlyMap<string, string>,
): Map<string, UsageEntry[]> {
  const out = new Map<string, UsageEntry[]>()
  for (const e of entries) {
    const id = loginOf(e, starts, rootLogins)
    const list = out.get(id)
    if (list) list.push(e)
    else out.set(id, [e])
  }
  return out
}

export function loginTotals(entries: UsageEntry[]): LoginTotals {
  const t: LoginTotals = { cost: 0, tokens: 0, messages: 0 }
  for (const e of entries) {
    t.cost += entryCost(e) ?? 0
    t.tokens += e.input + e.output + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead
    t.messages++
  }
  return t
}
