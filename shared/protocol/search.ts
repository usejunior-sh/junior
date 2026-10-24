// Local full-text search (core/store/sqlite-search.ts): one FTS5 index over
// work items, sessions and artifacts. Nothing leaves the machine.

export type SearchKind = 'item' | 'session' | 'artifact'
export const SEARCH_KINDS: readonly SearchKind[] = ['item', 'session', 'artifact']
export const isSearchKind = (v: unknown): v is SearchKind => SEARCH_KINDS.includes(v as SearchKind)

/**
 * One hit. `ref` is the row's id in its own table (an item id, a session id,
 * an artifact id). `snippet` is a short excerpt with every matched term
 * wrapped in SNIPPET_OPEN … SNIPPET_CLOSE; split it with snippetParts.
 */
export type SearchHit = {
  kind: SearchKind
  ref: string
  title: string
  snippet: string
}

/** Control characters, so no real text can be mistaken for a marker. */
export const SNIPPET_OPEN = '\u0002'
export const SNIPPET_CLOSE = '\u0003'

/** "fix the \u0002flaky\u0003 test" → plain and matched runs, in order. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  let hit = false
  let buf = ''
  const flush = () => {
    if (buf) out.push({ text: buf, hit })
    buf = ''
  }
  for (const ch of snippet) {
    if (ch === SNIPPET_OPEN) {
      flush()
      hit = true
    } else if (ch === SNIPPET_CLOSE) {
      flush()
      hit = false
    } else buf += ch
  }
  flush()
  return out
}

/**
 * GET /api/search?q=&limit= (server/search-ops.ts), for the ⌘K palette. Item
 * hits carry their state and repo, so a done item says so without a second
 * request. An empty or symbol-only query answers no hits, never an error.
 */
export type SearchResultHit = SearchHit & {
  status?: 'open' | 'snoozed' | 'done' | 'archived'
  repo?: string
}
export type SearchResponse = { ok: true; hits: SearchResultHit[] } | { ok: false; error: string }
