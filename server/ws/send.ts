import { WebSocket } from 'ws'
import type { ServerMessage } from '../../shared/protocol.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { summaries } from '../session/summaries.js'
import { noteDispatchedSessions } from '../inbox/flow.js'

export function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export function broadcast(rt: WorkspaceRuntime, msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of rt.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

/** The inbox moved: drop the snapshot and tell every open page to refetch. */
export function invalidateInbox(rt: WorkspaceRuntime) {
  rt.inboxCache = null
  broadcast(rt, { type: 'inbox_changed' })
}

export function broadcastSessionList(rt: WorkspaceRuntime) {
  broadcast(rt, { type: 'sessions', sessions: summaries(rt) })
  noteDispatchedSessions(rt)
}
