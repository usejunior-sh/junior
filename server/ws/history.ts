/**
 * Replaying a session's log to one socket: `subscribe` and
 * `session_events_before`.
 *
 * A paged subscribe sends the newest page (core/store/event-page.ts cuts it on
 * a turn) with `hasEarlier` and the cursor for the page before it, so a long
 * session opens without parsing its whole log. Each session_events_before
 * answers with the page just older than its `beforeSeq`. A plain subscribe
 * still sends everything, so a client that doesn't page sees what it always did.
 *
 * Only sessions in this socket's workspace answer (`rows`); a job's dry run
 * lives in memory and is always sent whole.
 */
import type { WebSocket } from 'ws'
import type { ClientMessage, SessionEvent } from '../../shared/protocol.js'
import type { EventStore } from '../../core/store/types.js'
import { send } from './send.js'

/** What a replay reads from a WorkspaceRuntime. */
export type ReplayRuntime = {
  rows: { has(sessionId: string): boolean }
  previews: { get(sessionId: string): { events: SessionEvent[] } | undefined }
  store: { events: Pick<EventStore, 'read' | 'readPage'> }
}

type ReplayRequest = Extract<ClientMessage, { type: 'subscribe' | 'session_events_before' }>

export async function replaySession(rt: ReplayRuntime, ws: WebSocket, msg: ReplayRequest): Promise<void> {
  const { sessionId } = msg
  const known = rt.rows.has(sessionId)

  if (msg.type === 'session_events_before') {
    // A dry run was sent whole and a gone session has nothing; either way an
    // empty last page, so a client waiting on "load earlier" settles.
    if (!known) {
      send(ws, { type: 'session_events_page', sessionId, beforeSeq: msg.beforeSeq, events: [], times: [], hasEarlier: false })
      return
    }
    const page = await rt.store.events.readPage(sessionId, { beforeSeq: msg.beforeSeq, limit: msg.limit })
    send(ws, {
      type: 'session_events_page',
      sessionId,
      beforeSeq: msg.beforeSeq,
      events: page.events.map((e) => e.event),
      times: page.events.map((e) => e.createdAt),
      hasEarlier: page.hasEarlier,
      ...(page.events.length ? { firstSeq: page.events[0].seq } : {}),
    })
    return
  }

  if (!known) {
    // A dry run streams under an ephemeral id; its transcript lives in memory.
    const pv = rt.previews.get(sessionId)
    if (pv) send(ws, { type: 'history', sessionId, events: pv.events, ...(msg.paged ? { hasEarlier: false } : {}) })
    return
  }

  if (!msg.paged) {
    const events = await rt.store.events.read(sessionId)
    send(ws, { type: 'history', sessionId, events: events.map((e) => e.event), times: events.map((e) => e.createdAt) })
    return
  }

  const page = await rt.store.events.readPage(sessionId, { limit: msg.limit })
  send(ws, {
    type: 'history',
    sessionId,
    events: page.events.map((e) => e.event),
    times: page.events.map((e) => e.createdAt),
    hasEarlier: page.hasEarlier,
    ...(page.events.length ? { firstSeq: page.events[0].seq } : {}),
  })
}
