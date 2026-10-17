import { codesAllowed, pairPageHtml, sameOrigin } from '../remote.js'
import { dbFileFor, ensureWorkspaceDirs, saveRegistry, slugify, type WorkspaceMeta, writeApiKey } from '../workspaces.js'
import type { WorkspaceResponse, WorkspacesResponse, WorkspaceVerifyResponse } from '../../shared/protocol.js'
import { DEFAULT_PROVIDER } from '../providers/registry.js'
import { log } from '../log.js'
import { MCP_PATH, mcpDispatch, type McpRpc } from '../mcp-http.js'
import { webManifest } from '../phone.js'
import { registry, runtimes, WorkspaceRuntime } from '../workspace/runtime.js'
import { readJsonBody } from './http-util.js'
import { errText } from '../errors.js'
import { BUILD, pExecFile, PORT, VERSION } from '../config.js'
import type { RouteCtx } from './ctx.js'
import { expandHome } from '../folders.js'
import { applyAuthChange, initRuntime, wireWorkspace, wireWorkspaces, workspacePatchFrom } from '../workspace/wiring.js'
import { probeAuth, probeConnectors, probeModels } from '../workspace/probes.js'
import { slackConnected } from '../inbox/sync.js'

export async function gateRoutes({ req, res, url, json, access }: RouteCtx): Promise<boolean> {
  if (access === 'denied') {
    if (url.pathname.startsWith('/api/') || url.pathname === MCP_PATH) {
      json(401, { error: 'this device is not paired with triage' })
    } else {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pairPageHtml(undefined, codesAllowed(req)))
    }
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, access)) {
    // Any page can make a browser POST to us; only our own page gets to write.
    json(403, { ok: false, error: 'cross-origin writes are not accepted' })
    return true
  }
  if (url.pathname === '/manifest.webmanifest') {
    // Served, not bundled: a paired device's start URL carries the token (see /api/pair).
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(webManifest(access)))
    return true
  }
  if (url.pathname === MCP_PATH) {
    if (!sameOrigin(req, access)) {
      json(403, { error: 'cross-origin requests are not accepted on /mcp' })
      return true
    }
    // No SSE stream is offered: every response is a plain JSON body, which the
    // spec covers by answering 405 to the stream methods.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ error: 'POST a JSON-RPC message to /mcp' }))
      return true
    }
    const wanted = url.searchParams.get('workspace')
    if (wanted && !runtimes.has(wanted)) {
      // Loud, at connect time: the alternative is filing work into the wrong
      // inbox for as long as it takes someone to notice.
      json(404, {
        error: `unknown workspace "${wanted}"`,
        known: [...runtimes.keys()],
        hint: 'the URL takes a workspace id, not its display name; drop the parameter to use the default',
      })
      return true
    }
    let payload: unknown
    try {
      payload = await readJsonBody(req, 4_000_000)
    } catch (err) {
      json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${errText(err)}` } })
      return true
    }
    const serverUrl = `http://localhost:${PORT}${MCP_PATH}`
    const batch = Array.isArray(payload) ? (payload as McpRpc[]) : [payload as McpRpc]
    const out = (await Promise.all(batch.map((m) => mcpDispatch(m, wanted, serverUrl)))).filter((r) => r !== null)
    if (out.length === 0) {
      res.writeHead(202)
      res.end()
      return true
    }
    json(200, Array.isArray(payload) ? out : out[0])
    return true
  }

  if (url.pathname === '/api/health') {
    // The CLI's "is triage running" probe — see server/state.ts. Daemon-wide.
    json(200, {
      app: 'triage',
      version: VERSION,
      build: BUILD,
      pid: process.pid,
      port: PORT,
      db: dbFileFor(registry.defaultId, registry.defaultId),
      liveSessions: [...runtimes.values()].reduce((n, rt) => n + rt.live.size, 0),
      workspaces: runtimes.size,
    })
    return true
  }
  return false
}

export async function workspaceListRoutes({ req, url, json }: RouteCtx): Promise<boolean> {
  if (url.pathname === '/api/git/branch') {
    // Which branch a folder has checked out — the draft composer shows it
    // beside the project before any session exists. Not a repo → null.
    const cwd = expandHome(url.searchParams.get('cwd') ?? '')
    try {
      const { stdout } = await pExecFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
      json(200, { ok: true, branch: stdout.trim() || null })
    } catch {
      json(200, { ok: true, branch: null })
    }
    return true
  }

  // --- workspace management (daemon-wide, not workspace-scoped) --------------
  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const body: WorkspacesResponse = {
      ok: true,
      workspaces: wireWorkspaces(),
      defaultId: registry.defaultId,
      onboarded: registry.onboarded,
    }
    json(200, body)
    return true
  }
  if (url.pathname === '/api/workspaces' && req.method === 'POST') {
    let body: WorkspaceResponse
    try {
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.name) throw new Error('a workspace needs a name')
      let id = slugify(p.name)
      for (let n = 2; runtimes.has(id); n++) id = `${slugify(p.name)}-${n}`
      const meta: WorkspaceMeta = {
        id,
        name: p.name,
        color: p.color ?? '#7aa2f7',
        ...(p.description ? { description: p.description } : {}),
        provider: DEFAULT_PROVIDER,
        authBackend: p.authBackend ?? 'inherit',
        createdAt: Date.now(),
      }
      ensureWorkspaceDirs(id)
      if (p.apiKey) writeApiKey(meta, p.apiKey)
      registry.workspaces.push(meta)
      saveRegistry(registry)
      const rt = new WorkspaceRuntime(meta)
      runtimes.set(id, rt)
      await initRuntime(rt)
      log('info', 'workspaces', `created: ${meta.name}`, { workspace: id, authBackend: meta.authBackend })
      body = { ok: true, workspace: wireWorkspace(meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/workspaces' && req.method === 'PUT') {
    let body: WorkspaceResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (p.name) rt.meta.name = p.name
      if (p.color) rt.meta.color = p.color
      if (p.description !== undefined) rt.meta.description = p.description || undefined
      const authChanged = (p.authBackend && p.authBackend !== rt.meta.authBackend) || p.apiKey !== undefined
      if (p.authBackend) rt.meta.authBackend = p.authBackend
      if (p.apiKey) writeApiKey(rt.meta, p.apiKey)
      saveRegistry(registry)
      if (authChanged) applyAuthChange(rt)
      body = { ok: true, workspace: wireWorkspace(rt.meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/workspaces' && req.method === 'DELETE') {
    let body: WorkspacesResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      if (id === registry.defaultId) throw new Error('the default workspace cannot be deleted — make another workspace the default first')
      // Remove from the registry and stop the runtime. The directory (DB,
      // .env, claude/) stays on disk — never delete data, only unregister.
      for (const s of rt.live.values()) s.stop()
      for (const ws of rt.clients) ws.close()
      runtimes.delete(id)
      registry.workspaces = registry.workspaces.filter((w) => w.id !== id)
      saveRegistry(registry)
      await rt.store.close()
      log('info', 'workspaces', `removed: ${rt.meta.name} (files kept on disk)`, { workspace: id })
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/workspaces/default' && req.method === 'POST') {
    let body: WorkspacesResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!runtimes.has(id)) throw new Error('unknown workspace id')
      registry.defaultId = id
      saveRegistry(registry)
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/workspaces/onboarded' && req.method === 'POST') {
    registry.onboarded = true
    saveRegistry(registry)
    json(200, { ok: true })
    return true
  }
  // A live probe with the workspace's own env — the creation modal's verify
  // step, and the settings dialog's "Check again". Clears the caches first so
  // the answer reflects the auth as configured right now.
  if (url.pathname === '/api/workspaces/verify' && req.method === 'POST') {
    let body: WorkspaceVerifyResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      rt.refreshEnv()
      rt.connectorCache = null
      rt.modelCache.clear()
      const [models, connectors, auth] = await Promise.all([
        probeModels(rt),
        probeConnectors(rt),
        // inherit is the machine's own login — already proven by daily use.
        rt.meta.authBackend === 'inherit' ? Promise.resolve({ ok: true as const }) : probeAuth(rt),
      ])
      body = {
        ok: true,
        models: models.models,
        connectors: connectors.connectors,
        slackConnected: slackConnected(rt) === true,
        authOk: auth.ok,
        ...('error' in auth && auth.error ? { authError: auth.error } : {}),
      }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  return false
}
