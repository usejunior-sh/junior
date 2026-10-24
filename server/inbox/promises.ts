/**
 * Promise items on the server (core/work/promise-items.ts):
 *
 * - filePromises: a source brought in a thread with the user's own messages
 *   (a job run's `yours`, the built-in Slack rows). Every promise in them is
 *   upserted as a `promise` item, deduped by thread + quote, unless you said
 *   that thread holds no promises.
 * - markNotAPromise: "Not a promise" on a promise item. One `not-a-promise`
 *   event by you, carrying the thread, then the item is archived. That
 *   thread files no more promises. Your own signal: HTTP only, never on the
 *   MCP surface.
 *
 * Both take the item store, so tests run them on a real SQLite file; the
 * `*Op` wrappers add the workspace's inbox refresh and the log line.
 */
import { isPromiseItemId, promiseItemsFrom, suppressedThreads, type PromiseThread } from '../../core/work/promise-items.js'
import type { Provenance } from '../../core/work/types.js'
import type { WorkItemStore } from '../../core/store/types.js'
import { log } from '../log.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { invalidateInbox } from '../ws/send.js'

/** What filing did: the promise ids it inserted, and every id it touched. */
export interface PromiseFiling {
  inserted: string[]
  filed: string[]
  /** the thread is one you marked "not a promise" */
  suppressed: boolean
}

/** Upsert every promise the thread's messages make. Never throws on a thread with none. */
export async function filePromises(items: WorkItemStore, thread: PromiseThread, provenance?: Provenance): Promise<PromiseFiling> {
  const out: PromiseFiling = { inserted: [], filed: [], suppressed: false }
  if (!thread.messages.length) return out
  const suppressed = suppressedThreads(await items.notesOf('not-a-promise'))
  if (suppressed.has(thread.thread)) return { ...out, suppressed: true }
  for (const item of promiseItemsFrom(thread, suppressed)) {
    const { outcome } = await items.upsert(item, provenance ? { ...provenance, why: item.why } : undefined)
    out.filed.push(item.id)
    if (outcome === 'inserted') out.inserted.push(item.id)
  }
  return out
}

/** "Not a promise": the event that suppresses the thread, then the item archived. */
export async function markNotAPromise(items: WorkItemStore, raw: unknown, now = Date.now()): Promise<{ id: string; thread: string }> {
  const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id.trim() : ''
  if (!isPromiseItemId(id)) throw new Error('need a promise item id')
  const item = await items.get(id)
  if (!item) throw new Error('no such item')
  const thread = item.promise?.thread ?? item.refs?.[0] ?? ''
  if (!thread) throw new Error('this promise has no thread')
  await items.note(id, 'not-a-promise', 'user', now, { thread })
  if (item.status !== 'archived') await items.transition(id, { status: 'archived', actor: 'user', detail: { reason: 'not a promise' } })
  return { id, thread }
}

export async function filePromisesOp(rt: WorkspaceRuntime, thread: PromiseThread, provenance?: Provenance): Promise<PromiseFiling> {
  const res = await filePromises(rt.store.items, thread, provenance)
  if (res.filed.length) invalidateInbox(rt)
  if (res.inserted.length) {
    log('info', 'inbox', `${res.inserted.length} promise(s) filed from ${thread.thread}`, { ids: res.inserted, thread: thread.thread, jobId: thread.jobId, workspace: rt.meta.id })
  }
  return res
}

export async function notAPromiseOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<void> {
  const { id, thread } = await markNotAPromise(rt.store.items, raw, now)
  invalidateInbox(rt)
  log('info', 'inbox', `not a promise: ${id} (by user); ${thread} files no more promises`, { id, thread, workspace: rt.meta.id })
}
