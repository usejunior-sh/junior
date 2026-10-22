/**
 * The column Claude Code's transcripts leave out: which login a session ran
 * on. Every Claude spawn's init is noted here as it passes through
 * `server/providers/claude.ts`, chats and headless runs alike, one JSON line
 * apiece in `<JUNIOR_HOME>/usage-logins.jsonl`. An API key is kept as a
 * fingerprint and its last four characters, never the key itself.
 *
 * A leaf module on purpose: the provider imports it, so it must not import
 * anything that leads back to the provider registry.
 */
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { JUNIOR_DIR } from '../state.js'

const FILE = path.join(JUNIOR_DIR, 'usage-logins.jsonl')

/** An API key as a login: two workspaces on one key are one login. */
export type KeyLogin = { id: string; hint?: string }

/** An API-key start whose key nobody recorded. */
export const UNKNOWN_KEY = 'key:unknown'

export const keyLogin = (key: string): KeyLogin => ({
  id: `key:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
  hint: `…${key.slice(-4)}`,
})

/** `apiKeySource` values that mean a claude.ai login, not a key. */
const ACCOUNT_SOURCES = new Set(['none', 'oauth', '/login managed key'])

/**
 * The API-key login a start ran on, from its init's `apiKeySource` and the key
 * the spawn was handed. `undefined` = it ran on its config dir's claude.ai login.
 */
export function startKey(apiKeySource: string, key: string | undefined): KeyLogin | undefined {
  if (ACCOUNT_SOURCES.has(apiKeySource)) return undefined
  return apiKeySource === 'ANTHROPIC_API_KEY' && key ? keyLogin(key) : { id: UNKNOWN_KEY }
}

export type NotedStart = { sessionId: string; at: number; key?: string; hint?: string }

/** Note one spawn's login. `key` = the API key its env carried, if any. Never rejects. */
export async function noteClaudeStart(init: { session_id?: unknown; apiKeySource?: unknown }, key: string | undefined): Promise<void> {
  if (typeof init.session_id !== 'string' || typeof init.apiKeySource !== 'string') return
  const k = startKey(init.apiKeySource, key)
  const start: NotedStart = { sessionId: init.session_id, at: Date.now(), ...(k ? { key: k.id, ...(k.hint ? { hint: k.hint } : {}) } : {}) }
  await appendFile(FILE, JSON.stringify(start) + '\n', { mode: 0o600 }).catch(() => {})
}

/** Every start noted so far. A line per spawn, so it stays small enough to read whole. */
export async function notedStarts(): Promise<NotedStart[]> {
  let text: string
  try {
    text = await readFile(FILE, 'utf8')
  } catch {
    return []
  }
  const out: NotedStart[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const s = JSON.parse(line) as NotedStart
      if (typeof s.sessionId === 'string' && typeof s.at === 'number') out.push(s)
    } catch {
      // a torn last line from a crash mid-append
    }
  }
  return out
}
