import type { StoredSession } from '../../core/store/types.js'
import type { RawBlock, SessionSummary } from '../../shared/protocol.js'
import { DEFAULT_PROVIDER } from '../providers/registry.js'
import { renderVerification } from '../browser.js'
import { log } from '../log.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { teamRunLink } from '../team-run/state.js'
import { errText } from '../errors.js'

// ---------------------------------------------------------------------------
// Session registry helpers — all per-workspace.
// ---------------------------------------------------------------------------
export function summarize(rt: WorkspaceRuntime, row: StoredSession): SessionSummary {
  const l = rt.live.get(row.id)
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    status: l?.status ?? 'idle',
    updatedAt: row.updatedAt,
    // The user's pick wins: it is what the next turn runs on, and it is set
    // before the subprocess has reported anything.
    model: row.model ?? l?.model,
    effort: row.effort ?? undefined,
    fastMode: row.fastMode || undefined,
    fastModeState: l?.fastModeState,
    fastModeDisabledReason: l?.fastModeDisabledReason,
    permissionMode: row.permissionMode ?? undefined,
    planning: row.planning || undefined,
    ...(row.provider !== DEFAULT_PROVIDER ? { provider: row.provider } : {}),
    pinned: row.pinned || undefined,
    ...(row.checkoutId ? { checkoutId: row.checkoutId } : {}),
    ...(row.kind !== 'chat' ? { kind: row.kind } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(rt.sessionItem.has(row.id) ? { itemId: rt.sessionItem.get(row.id) } : {}),
    ...(teamRunLink(rt, row.id) ? { teamRun: teamRunLink(rt, row.id) } : {}),
    ...(l?.waiting ? { waiting: true, waitingOn: l.waitingOn } : {}),
    live: !!l,
  }
}

/**
 * The chat session list: pinned first, then most recently active. Job-run
 * sessions are real sessions but not chats — they are excluded here and reached
 * through the job that owns them (.docs/jobs-v2.md).
 */
export function summaries(rt: WorkspaceRuntime): SessionSummary[] {
  return [...rt.rows.values()]
    .filter((r) => r.kind !== 'job-run')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .map((r) => summarize(rt, r))
}

/**
 * Delete a session for good: its subprocess, its in-memory state, and its
 * whole log. The subprocess is stopped first so nothing is still writing to a
 * row that is about to go.
 */
/**
 * Image blocks inside tool results (a browser screenshot, a Read of a PNG) are
 * for the model, which already has them. The log and every open page get the
 * block without its bytes — the transcript shows saved shots from disk.
 */
export function slimToolImages<T>(record: T): T {
  const m = record as { type?: string; message?: { content?: unknown } }
  if (m?.type !== 'user' || !Array.isArray(m.message?.content)) return record
  let changed = false
  const content = (m.message.content as RawBlock[]).map((b) => {
    if (b?.type !== 'tool_result' || !Array.isArray(b.content)) return b
    const inner = b.content as RawBlock[]
    if (!inner.some((c) => c?.type === 'image')) return b
    changed = true
    return { ...b, content: inner.map((c) => (c?.type === 'image' ? { type: 'image', omitted: true } : c)) }
  })
  return changed ? ({ ...m, message: { ...m.message, content } } as T) : record
}

/**
 * A turn ended: if it used the browser, add it to the session's Verification
 * note (server/browser.ts renderVerification), linked to the session and its
 * item — the evidence "done" points at.
 */
export async function noteBrowserTurn(rt: WorkspaceRuntime, row: StoredSession, startedAt: number, record: unknown): Promise<void> {
  try {
    const taken = rt.shots.list(row.id).filter((s) => s.at >= startedAt && s.kind !== 'pick')
    if (!taken.length) return
    const r = record as { result?: unknown }
    const turns = await rt.shots.addTurn(row.id, {
      startedAt,
      endedAt: Date.now(),
      summary: typeof r?.result === 'string' ? r.result : '',
      shots: taken.map((s) => s.n),
    })
    const title = `Verification · ${row.title || 'session'}`.slice(0, 120)
    const body = renderVerification({ title, workspaceId: rt.meta.id, sessionId: row.id, turns, shots: rt.shots.list(row.id) })
    const artifact = await rt.artifacts.writeAt(`verification/${row.id}.md`, { title, body, author: 'model' })
    await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'session', toId: row.id, role: 'context' })
    const itemId = rt.sessionItem.get(row.id)
    if (itemId) await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: itemId, role: 'context' })
  } catch (err) {
    log('warn', 'browser', `could not write the verification note: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
  }
}
