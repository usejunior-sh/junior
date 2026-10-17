import { readFile } from 'node:fs/promises'
import { type BrowserPickResponse, type BrowserShotsResponse, isProviderId, type ProvidersStatusResponse, type ProviderVerifyResponse, type WorkspaceResponse } from '../../shared/protocol.js'
import { describePicked } from '../browser.js'
import { isConnected, saveRegistry, toAuthBackend } from '../workspaces.js'
import { providerFor } from '../providers/registry.js'
import { applyAuthChange, wireWorkspace, workspaceInfo } from '../workspace/wiring.js'
import { browserHub, registry } from '../workspace/runtime.js'
import { readJsonBody } from './http-util.js'
import { errText } from '../errors.js'
import { applyProviderChange, readProviderStatus, saveProviderKey } from '../workspace/providers.js'
import type { ScopedCtx } from './ctx.js'

export async function workspaceRoutes({ req, res, url, json, rt }: ScopedCtx): Promise<boolean> {
  // The workspace this request resolved to, singular and scoped — unlike the
  // daemon-wide /api/workspaces list. Backs get_workspace so a chat or the stdio
  // shim can answer "which workspace am I in?" (and the shim can tell whether its
  // TRIAGE_WORKSPACE matched or silently fell back to the default).
  if (url.pathname === '/api/workspace' && req.method === 'GET') {
    json(200, { ok: true, ...workspaceInfo(rt) })
    return true
  }

  // --- the browser pane (.docs/browser.md): host status, evidence, the picker ---
  if (url.pathname === '/api/browser/status' && req.method === 'GET') {
    json(200, { ok: true, ...browserHub.status })
    return true
  }
  const shotRoute = /^\/api\/browser\/shots\/([\w-]+)(?:\/(\d+))?$/.exec(url.pathname)
  if (shotRoute && req.method === 'GET') {
    const [, sessionId, n] = shotRoute
    if (!n) {
      const body: BrowserShotsResponse = { ok: true, shots: rt.shots.list(sessionId) }
      json(200, body)
      return true
    }
    const f = rt.shots.file(sessionId, Number(n))
    try {
      if (!f) throw new Error('no such shot')
      const bytes = await readFile(f.path)
      // Shots are numbered and never rewritten: cache hard.
      res.writeHead(200, { 'content-type': f.mime, 'content-length': String(bytes.length), 'cache-control': 'private, max-age=31536000, immutable' })
      res.end(bytes)
    } catch {
      json(404, { ok: false, error: 'no such shot' })
    }
    return true
  }
  if (url.pathname === '/api/browser/pick' && req.method === 'POST') {
    let body: BrowserPickResponse
    try {
      const b = (await readJsonBody(req, 10_000)) as { sessionId?: unknown; uid?: unknown } | null
      const row = typeof b?.sessionId === 'string' ? rt.rows.get(b.sessionId) : undefined
      if (!row || typeof b?.uid !== 'number') throw new Error('need a session of this workspace and a uid')
      body = { ok: true, ...(await describePicked({ hub: browserHub, shots: rt.shots, sessionId: row.id, projectRoot: row.cwd }, b.uid)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  // --- providers: the agents this workspace is connected to ------------------
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    let body: ProvidersStatusResponse
    try {
      body = { ok: true, providers: await readProviderStatus(rt, url.searchParams.get('refresh') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // Connect, disconnect, or change how one agent signs in here. The primary
  // can't be disconnected, and its auth is the workspace's own.
  if (url.pathname === '/api/providers' && req.method === 'PUT') {
    let body: WorkspaceResponse
    try {
      const provider = url.searchParams.get('provider')
      if (!isProviderId(provider)) throw new Error(`unknown provider: ${provider}`)
      const raw = (await readJsonBody(req)) as { connected?: unknown; authBackend?: unknown; apiKey?: unknown } | null
      const authBackend = raw?.authBackend === undefined ? undefined : toAuthBackend(raw.authBackend)
      if (raw?.authBackend !== undefined && !authBackend) throw new Error('authBackend must be inherit, api-key or config-dir')
      const apiKey = typeof raw?.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined
      const meta = rt.meta
      // The key first: a key the agent refuses fails the save before anything changes.
      if (apiKey) await saveProviderKey(meta, provider, apiKey)
      if (provider === meta.provider) {
        if (raw?.connected === false) throw new Error(`${providerFor(provider).label} runs this workspace's jobs and briefs — it can't be disconnected`)
        const changed = (authBackend && authBackend !== meta.authBackend) || apiKey !== undefined
        if (authBackend) meta.authBackend = authBackend
        saveRegistry(registry)
        if (changed) applyAuthChange(rt)
      } else {
        const was = meta.connections?.[provider]?.authBackend
        if (raw?.connected === false) {
          const { [provider]: _gone, ...rest } = meta.connections ?? {}
          meta.connections = rest
        } else {
          const next = authBackend ?? was ?? 'inherit'
          meta.connections = { ...(meta.connections ?? {}), [provider]: { authBackend: next } }
        }
        saveRegistry(registry)
        if (was !== meta.connections?.[provider]?.authBackend || apiKey !== undefined) applyProviderChange(rt, provider)
      }
      body = { ok: true, workspace: wireWorkspace(meta) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // One real round-trip with a provider's auth here — the account read can't
  // tell a revoked key from a good one for every backend; a turn can.
  if (url.pathname === '/api/providers/verify' && req.method === 'POST') {
    let body: ProviderVerifyResponse
    try {
      const provider = url.searchParams.get('provider')
      if (!isProviderId(provider)) throw new Error(`unknown provider: ${provider}`)
      if (!isConnected(rt.meta, provider)) throw new Error(`${providerFor(provider).label} isn't connected in this workspace`)
      const auth = await providerFor(provider).checkAuth(rt.envFor(provider))
      rt.providerStatus = null
      body = { ok: true, authOk: auth.ok, ...(auth.error ? { authError: auth.error } : {}) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
