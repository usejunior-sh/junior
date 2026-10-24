/**
 * ⌘K search: the palette's local rows plus hits from GET /api/search (the
 * workspace's FTS index over items, chats and artifacts). Pure and store-free,
 * so the node tests can load it. One row per thing: a hit for a row the
 * palette already shows doesn't repeat, it lends that row its snippet when
 * the match was in the body. Design note: .docs/overnight-2026-10-24/designs/palette-search.md.
 */
import { snippetParts, type SearchKind, type SearchResultHit } from '../../shared/protocol.js'
import type { Listable } from './itemVerbs.js'

/** The index's shortest prefix: under this, no request. */
export const SEARCH_MIN_CHARS = 2
export const SEARCH_DEBOUNCE_MS = 150
export const SEARCH_LIMIT = 30

export const SEARCHING_LINE = 'Searching everything…'
export const SEARCH_FAILED_LINE = 'Couldn’t search. Showing what’s loaded.'

/** Ask the server once the query has 2+ characters and something besides symbols. */
export function wantsSearch(query: string): boolean {
  const q = query.trim()
  return q.length >= SEARCH_MIN_CHARS && /[\p{L}\p{N}]/u.test(q)
}

/** A hit's palette row id, the same id the local row for that thing uses. */
const PREFIX: Record<SearchKind, string> = { item: 'w:', session: 's:', artifact: 'a:' }
export const hitRowId = (h: Pick<SearchResultHit, 'kind' | 'ref'>) => PREFIX[h.kind] + h.ref

/** The snippet's plain text, without markers or the index's ellipses. */
export const snippetText = (snippet: string) =>
  snippetParts(snippet)
    .map((p) => p.text)
    .join('')
    .replace(/^…+|…+$/g, '')
    .trim()

/**
 * The match was in the body (the description, the chat's words, the
 * artifact's text), not the title or the id. A title match keeps the row's
 * own hint; only a body match is worth showing.
 */
export function bodyMatch(h: Pick<SearchResultHit, 'title' | 'ref' | 'snippet'>): boolean {
  const plain = snippetText(h.snippet)
  if (!plain) return false
  return !h.title.includes(plain) && !h.ref.includes(plain)
}

/** "done · acme/web" for a closed item; open items (and items with no state) say nothing. */
export function stateWord(h: Pick<SearchResultHit, 'status'>): string | null {
  return h.status && h.status !== 'open' ? h.status : null
}

/** A row the palette can draw: a hit, or a local row that may carry a hit's snippet. */
export type Searchable<S extends string> = Listable<S> & {
  /** a body match, with markers (draw with snippetParts) */
  snippet?: string
}

/**
 * The local rows (already filtered and sorted), then the hits merged in: a
 * hit for a shown row puts its snippet on that row (body matches only); a hit
 * for a known row the local filter missed brings that row in (so ⌘⏎ still
 * works on it); any other hit becomes a new row from `make`. Local matches
 * first, then extra hits in the server's (bm25) order, all in section order.
 */
export function mergeHits<S extends string, C extends Searchable<S>>(
  shown: readonly C[],
  all: readonly C[],
  hits: readonly SearchResultHit[],
  make: (h: SearchResultHit) => C | null,
  order: readonly S[],
): C[] {
  const shownIds = new Set(shown.map((c) => c.id))
  const known = new Map(all.map((c) => [c.id, c]))
  const snippets = new Map<string, string>()
  const extra: C[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    const id = hitRowId(h)
    if (seen.has(id)) continue
    seen.add(id)
    const snippet = bodyMatch(h) ? h.snippet : undefined
    if (shownIds.has(id)) {
      if (snippet) snippets.set(id, snippet)
      continue
    }
    const local = known.get(id)
    const row = local ? { ...local, ...(snippet ? { snippet } : {}) } : make(h)
    if (row) extra.push(row)
  }
  const rows = [...shown.map((c) => (snippets.has(c.id) ? { ...c, snippet: snippets.get(c.id) } : c)), ...extra]
  const rank = (s: S) => {
    const i = order.indexOf(s)
    return i < 0 ? order.length : i
  }
  return rows.sort((a, b) => rank(a.section) - rank(b.section))
}

/**
 * Hits from an earlier query still fit while you type forward ("bill" →
 * "billing"); once the query goes elsewhere they are stale and drop.
 */
export function hitsStillFit(hitsQuery: string, query: string): boolean {
  const a = hitsQuery.trim().toLowerCase()
  const b = query.trim().toLowerCase()
  return !!a && b.startsWith(a)
}
