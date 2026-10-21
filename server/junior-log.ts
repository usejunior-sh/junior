import { actionLine, jobLine, latestAt, type LogFilter, type LogLine, logPage, taskLine } from '../core/junior/log.js'
import { WorkspaceRuntime } from './workspace/runtime.js'

// Junior's log (core/junior/log.ts): the feed behind the Junior page's Log tab
// and the unread dot on the rail. Gathered from records the store keeps.

const SEEN_KEY = 'junior.logSeenAt'
/** How far back the feed reads each source: enough for weeks of work, bounded. */
const READ_CAP = 2000

async function allLines(rt: WorkspaceRuntime): Promise<LogLine[]> {
  const origin = (sessionId: string) => (sessionId.startsWith('task-') ? 'babysit' : (rt.rows.get(sessionId)?.title ?? null))
  const actions = (await rt.store.actions.list({ limit: READ_CAP })).map((a) => actionLine(a, origin(a.sessionId)))
  const tasks = (await rt.store.tasks.inState(['done', 'failed', 'stopped', 'skipped'])).flatMap((t) => taskLine(t) ?? [])
  const jobs = [...rt.rows.values()]
    .filter((r) => r.kind === 'job-run' && r.runStatus)
    .map((r) => jobLine({ sessionId: r.id, title: r.title, status: r.runStatus!, error: r.runError ?? null, ...(typeof r.runMatches === 'number' ? { matches: r.runMatches } : {}), at: r.updatedAt }))
  return [...actions, ...tasks, ...jobs]
}

export type JuniorLog = { lines: LogLine[]; more: boolean; latestAt: number; seenAt: number }

export async function juniorLogOp(rt: WorkspaceRuntime, q: { filter?: string | null; before?: number | null; limit?: number | null }): Promise<JuniorLog> {
  const filter: LogFilter = q.filter === 'sent' ? 'sent' : 'all'
  const before = typeof q.before === 'number' && Number.isFinite(q.before) && q.before > 0 ? q.before : null
  const limit = Math.max(0, Math.min(200, typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : 50))
  const lines = await allLines(rt)
  const page = logPage(lines, filter, before, limit)
  return { ...page, latestAt: latestAt(lines), seenAt: (await rt.store.config.get<number>(SEEN_KEY)) ?? 0 }
}

/** You opened the log: everything up to `at` is read. Never moves back. */
export async function juniorLogSeenOp(rt: WorkspaceRuntime, at: unknown): Promise<number> {
  const prev = (await rt.store.config.get<number>(SEEN_KEY)) ?? 0
  const next = typeof at === 'number' && Number.isFinite(at) ? Math.min(Math.max(prev, at), Date.now()) : prev
  if (next !== prev) await rt.store.config.set(SEEN_KEY, next)
  return next
}
