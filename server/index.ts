#!/usr/bin/env node
/**
 * The triage daemon: serves the web UI on :5178 and drives the locally
 * installed Claude Code via @anthropic-ai/claude-agent-sdk.
 *
 * Sessions are persisted to SQLite (core/store): the row + an append-only
 * event log (the same events the UI renders; stream deltas excluded). The
 * Claude subprocess itself is ephemeral: a session with no live subprocess
 * is revived on the next user message via the SDK's `resume`, keyed by the
 * sdk_session_id captured from the init message. The agent's own memory of
 * the conversation lives in ~/.claude's transcript, not here; our event log
 * is for rendering, never for re-feeding the model.
 *
 * Workspaces (.docs/workspaces.md): one daemon, N isolated workspaces. Each
 * workspace has its own SQLite file, its own Claude auth backend (spawn env),
 * and its own runtime state. Every map and cache that used to be a module
 * singleton lives on a WorkspaceRuntime. Every HTTP request and WS connection
 * is bound to exactly one workspace (?workspace= param, else the triage_ws
 * cookie, else the default), and broadcasts stay inside that boundary.
 *
 * The wire format lives in shared/protocol/ and is shared with the frontend.
 */
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { clearState, TRIAGE_DIR, writeState } from './state.js'
import { initLogFile, log } from './log.js'
import { accessOf, isLoopbackAddress, sameOrigin } from './remote.js'
import { BROWSER_HOST_PATH } from '../core/browser/wire.js'
import { PORT, VERSION } from './config.js'
import { serveWeb } from './web.js'
import { pairRoute, remote, remoteRoute, remoteSockets, syncTunnel, tunnel } from './phone.js'
import { startTicks } from './ticks.js'
import { browserHub, registry, runtimes, WorkspaceRuntime } from './workspace/runtime.js'
import { initRuntime } from './workspace/wiring.js'
import { handleConnection } from './ws/connection.js'
import { resolveRuntime } from './routes/http-util.js'
import { gateRoutes, workspaceListRoutes } from './routes/daemon.js'
import { workspaceRoutes } from './routes/workspace.js'
import { sessionRoutes } from './routes/sessions.js'
import { inboxRoutes } from './routes/inbox.js'
import { jobRoutes } from './routes/jobs.js'
import { itemRoutes } from './routes/items.js'
import { itemWriteRoutes } from './routes/items-write.js'
import { taskRoutes } from './routes/tasks.js'
import { approvalRoutes } from './routes/approvals.js'
import { settingsRoutes } from './routes/settings.js'
import { libraryRoutes } from './routes/library.js'
import { artifactFileRoutes } from './routes/artifact-files.js'
import { briefRoutes } from './routes/briefs.js'
import { actionRoutes } from './routes/actions.js'
import type { RouteCtx, ScopedCtx } from './routes/ctx.js'

// Daemon-wide logs (one process, one log stream); workspace ids ride in fields.
initLogFile(path.join(TRIAGE_DIR, 'logs'))

startTicks()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const access = accessOf(req, remote)
  const ctx: RouteCtx = { req, res, url, json, access }
  if (await pairRoute(ctx)) return
  if (await gateRoutes(ctx)) return
  if (await remoteRoute(ctx)) return
  if (await workspaceListRoutes(ctx)) return

  // everything below is scoped to one workspace
  const rt = resolveRuntime(req, url)
  const scoped: ScopedCtx = { ...ctx, rt }
  if (await workspaceRoutes(scoped)) return
  if (await sessionRoutes(scoped)) return
  if (await inboxRoutes(scoped)) return
  if (await jobRoutes(scoped)) return
  if (await itemRoutes(scoped)) return
  if (await itemWriteRoutes(scoped)) return
  if (await taskRoutes(scoped)) return
  if (await approvalRoutes(scoped)) return
  if (await settingsRoutes(scoped)) return
  if (await libraryRoutes(scoped)) return
  if (await artifactFileRoutes(scoped)) return
  if (await briefRoutes(scoped)) return
  if (await actionRoutes(scoped)) return
  await serveWeb(url.pathname, res)
})

// WebSocket: each connection binds to one workspace at upgrade time
// (?workspace= param, else the triage_ws cookie, else the default), and only
// ever sees that workspace's sessions and events.
// Drop other devices at accept while phone access is off, the same as a
// loopback-only bind, without a restart to switch it on (server/remote.ts).
server.on('connection', (sock) => {
  if (isLoopbackAddress(sock.remoteAddress)) return
  if (!remote.enabled) {
    sock.destroy()
    return
  }
  remoteSockets.add(sock)
  sock.on('close', () => remoteSockets.delete(sock))
})

// Upgrades are routed by path: the UI's socket, and the browser pane's host.
// Two servers can't share `server`: each aborts the other's paths with a 400.
const wss = new WebSocketServer({
  noServer: true,
  path: '/ws',
  // Browsers let any page open a WebSocket to localhost; only our own page,
  // from this machine or a paired device, gets one.
  verifyClient: ({ req }, done) => {
    const access = accessOf(req, remote)
    if (access === 'denied') done(false, 401, 'not paired')
    else if (!sameOrigin(req, access)) done(false, 403, 'cross-origin')
    else done(true)
  },
})

/** Triage.app's main process, hosting the browser pane's tabs (server/browser.ts). */
const hostWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === BROWSER_HOST_PATH) {
    // This machine only, and no Origin: every browser sends one, so no web
    // page, not even one the agent is looking at, can pose as the host.
    if (accessOf(req, remote) !== 'local' || req.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    hostWss.handleUpgrade(req, socket, head, (ws) => browserHub.attach(ws))
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', handleConnection)

// Boot: one runtime per registered workspace, each with its own store, seeds,
// cached snapshot, and background probes.
for (const meta of registry.workspaces) runtimes.set(meta.id, new WorkspaceRuntime(meta))
for (const rt of runtimes.values()) await initRuntime(rt)

// The wss wraps the http server and re-emits its errors, so the handler has
// to sit on both: an unhandled 'error' on either one crashes with a raw stack.
for (const emitter of [server, wss]) emitter.on('error', onListenError)
function onListenError(err: NodeJS.ErrnoException) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `triage: port ${PORT} is already in use — \`triage status\` shows whether it's another triage; ` +
        `otherwise pick a port with \`triage --port ${PORT + 1}\``,
    )
    process.exit(1)
  }
  throw err
}
server.listen(PORT, () => {
  syncTunnel()
  log('info', 'server', `triage v${VERSION} started on :${PORT} (${runtimes.size} workspace${runtimes.size === 1 ? '' : 's'}, default: ${registry.defaultId})`)
  // Record where we are so `triage stop/status` can find a --port server.
  writeState({ pid: process.pid, port: PORT, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err) => console.error('[state] could not write server.json:', err),
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', 'server', `received ${sig} — shutting down`)
    tunnel.stop()
    for (const rt of runtimes.values()) rt.terminals.killAll()
    clearState(process.pid).finally(() => process.exit(0))
  })
}

