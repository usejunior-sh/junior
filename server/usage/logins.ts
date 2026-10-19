/**
 * Usage split by the login that paid for it, for the Usage tab's filter and
 * the Providers popover. A claude.ai login is a Claude config dir (`~/.claude`,
 * or a config-dir workspace's own); an API key is one login however many
 * workspaces share it. Which one a session ran on comes from the starts
 * triage noted (login-ledger.ts) and, for spawns from before that ledger, the
 * inits every workspace's event log kept (core/usage/logins.ts does the pairing).
 */
import type { UsageLogin } from '../../shared/protocol.js'
import type { UsageEntry } from '../../core/usage/ledger.js'
import { byLogin, loginTotals, MACHINE_LOGIN, timelines, type LoginStart } from '../../core/usage/logins.js'
import { claudeSignedIn, claudeTranscriptDir, CLAUDE_API_KEY_VAR } from '../providers/claude-config.js'
import { envOverridesFor, loadRegistry, providerAuthBackend, storedApiKey, type WorkspaceMeta } from '../workspaces.js'
import { runtimes } from '../workspace/runtime.js'
import { keyLogin, notedStarts, startKey, UNKNOWN_KEY } from './login-ledger.js'
import { log } from '../log.js'

type LoginRoot = { root: string; id: string; workspace?: WorkspaceMeta }

/**
 * Where Claude Code keeps its transcripts, and whose login each dir is: the
 * user's own `~/.claude` (or whatever `CLAUDE_CONFIG_DIR` points at), plus the
 * private config dir of every Claude workspace on the `config-dir` backend.
 * Claude's only: the usage ledger reads Claude Code's transcript format.
 */
export function claudeLoginRoots(): LoginRoot[] {
  const out: LoginRoot[] = [{ root: claudeTranscriptDir(undefined), id: MACHINE_LOGIN }]
  for (const ws of loadRegistry().workspaces) {
    if (ws.provider !== 'claude' || ws.authBackend !== 'config-dir') continue
    const root = claudeTranscriptDir(envOverridesFor(ws))
    if (!out.some((r) => r.root === root)) out.push({ root, id: `dir:${ws.id}`, workspace: ws })
  }
  return out
}

export const claudeProjectRoots = (): string[] => claudeLoginRoots().map((r) => r.root)

/** The login a workspace's Claude runs on now. */
export function workspaceLogin(meta: WorkspaceMeta): string {
  const backend = providerAuthBackend(meta, 'claude') ?? 'inherit'
  if (backend === 'config-dir') return `dir:${meta.id}`
  const key = backend === 'api-key' ? storedApiKey(meta, 'claude') : process.env[CLAUDE_API_KEY_VAR]
  if (key) return keyLogin(key).id
  return backend === 'api-key' ? UNKNOWN_KEY : MACHINE_LOGIN
}

/** Each workspace's event log, read so far: a cursor and the starts found behind it. */
const logged = new Map<string, { next: number; starts: LoginStart[] }>()
let catchingUp: Promise<void> | null = null

/**
 * Bring every workspace's logged starts up to date. The first pass reads whole
 * logs (hundreds of MB on a busy workspace), so it goes a page at a time and
 * gives the loop back in between; later passes read only what is new. An
 * API-key start is credited to the workspace's key as it is now: the log
 * never said which key, and the key in use then is usually still the one.
 */
function catchUp(): Promise<void> {
  catchingUp ??= (async () => {
    for (const rt of runtimes.values()) {
      const seen = logged.get(rt.meta.id) ?? { next: 0, starts: [] }
      const key = storedApiKey(rt.meta, 'claude') ?? process.env[CLAUDE_API_KEY_VAR]
      try {
        for (;;) {
          const page = await rt.store.events.sdkInits(seen.next)
          for (const i of page.inits) {
            const k = startKey(i.apiKeySource, key)
            seen.starts.push({ sessionId: i.sessionId, at: i.at, ...(k ? { key: k.id } : {}) })
          }
          seen.next = page.next
          if (page.done) break
          await new Promise((r) => setImmediate(r))
        }
      } catch (err) {
        log('warn', 'usage', `couldn't read session starts: ${err instanceof Error ? err.message : String(err)}`, { workspace: rt.meta.id })
      }
      logged.set(rt.meta.id, seen)
    }
  })().finally(() => (catchingUp = null))
  return catchingUp
}

/** Every login a workspace has set up, labelled, spent or not. Keys read from each workspace's .env. */
async function setUpLogins(roots: LoginRoot[]): Promise<Map<string, Omit<UsageLogin, 'cost' | 'tokens' | 'messages'>>> {
  const out = new Map<string, Omit<UsageLogin, 'cost' | 'tokens' | 'messages'>>()
  for (const r of roots) {
    const who = await claudeSignedIn(r.workspace ? envOverridesFor(r.workspace) : undefined)
    const where = r.workspace ? `${r.workspace.name} workspace` : 'includes terminal sessions'
    out.set(r.id, {
      id: r.id,
      kind: 'account',
      label: who?.email ?? (r.workspace ? `${r.workspace.name} login` : 'This Mac’s Claude login'),
      detail: [who?.plan, where].filter(Boolean).join(' · '),
    })
  }
  const keys = new Map<string, { hint?: string; names: string[] }>()
  for (const ws of loadRegistry().workspaces) {
    if (providerAuthBackend(ws, 'claude') !== 'api-key') continue
    const key = storedApiKey(ws, 'claude')
    if (!key) continue
    const k = keyLogin(key)
    const row = keys.get(k.id) ?? { hint: k.hint, names: [] }
    row.names.push(ws.name)
    keys.set(k.id, row)
  }
  for (const [id, { hint, names }] of keys) out.set(id, { id, kind: 'api-key', label: `API key ${hint}`, detail: names.join(', ') })
  return out
}

/**
 * `entries` split by login, with every login set up anywhere listed alongside
 * the ones only history knows (a key since replaced): accounts first, then by
 * spend.
 */
export async function usageByLogin(entries: UsageEntry[]): Promise<{ logins: UsageLogin[]; groups: Map<string, UsageEntry[]> }> {
  const roots = claudeLoginRoots()
  const [noted] = await Promise.all([notedStarts(), catchUp()])
  // The ledger is exact from its first line on; the event logs fill in before it.
  const since = noted.reduce((min, s) => Math.min(min, s.at), Infinity)
  const starts = [...noted, ...[...logged.values()].flatMap((l) => l.starts.filter((s) => s.at < since))]
  const groups = byLogin(entries, timelines(starts), new Map(roots.map((r) => [r.root, r.id])))

  const known = await setUpLogins(roots)
  const hints = new Map(noted.flatMap((s) => (s.key && s.hint ? [[s.key, s.hint] as const] : [])))
  const logins: UsageLogin[] = []
  for (const id of new Set([...known.keys(), ...groups.keys()])) {
    const base = known.get(id) ?? {
      id,
      kind: 'api-key' as const,
      label: hints.has(id) ? `API key ${hints.get(id)}` : 'API key',
      detail: id === UNKNOWN_KEY ? 'which key wasn’t recorded' : 'no workspace uses it now',
    }
    logins.push({ ...base, ...loginTotals(groups.get(id) ?? []) })
  }
  logins.sort((a, b) => (a.kind === b.kind ? b.cost - a.cost : a.kind === 'account' ? -1 : 1))
  return { logins, groups }
}
