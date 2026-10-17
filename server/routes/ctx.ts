import type http from 'node:http'
import type { Access } from '../remote.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'

export type RouteCtx = {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  json: (status: number, body: unknown) => void
  access: Access
}

export type ScopedCtx = RouteCtx & { rt: WorkspaceRuntime }
