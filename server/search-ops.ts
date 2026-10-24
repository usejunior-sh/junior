/**
 * Search over the workspace's local FTS index (core/store/sqlite-search.ts),
 * for GET /api/search and the ⌘K palette. Bound to one workspace by its
 * runtime: two workspaces never see each other's hits.
 */
import type { SearchResultHit } from '../shared/protocol.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

export const SEARCH_DEFAULT_LIMIT = 30
const SEARCH_MAX_LIMIT = 100
const QUERY_MAX = 200

/** Hits for `q`, best first. Item hits get their state and repo. */
export async function searchOp(rt: Pick<WorkspaceRuntime, 'store'>, q: unknown, limit?: unknown): Promise<SearchResultHit[]> {
  const text = typeof q === 'string' ? q.trim().slice(0, QUERY_MAX) : ''
  if (!text) return []
  const n = Number(limit)
  const max = Number.isFinite(n) && n >= 1 ? Math.min(SEARCH_MAX_LIMIT, Math.floor(n)) : SEARCH_DEFAULT_LIMIT
  const hits = await rt.store.search.search(text, { limit: max })
  return Promise.all(
    hits.map(async (h): Promise<SearchResultHit> => {
      if (h.kind !== 'item') return h
      const item = await rt.store.items.get(h.ref)
      if (!item) return h
      return { ...h, status: item.status ?? 'open', ...(item.repo ? { repo: item.repo } : {}) }
    }),
  )
}
