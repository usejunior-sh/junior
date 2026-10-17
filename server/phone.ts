import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { type Access, bonjourName, codesAllowed, lanAddresses, livePairCode, loadRemote, newToken, type PairCode, pairCookie, pairPageHtml, saveRemote, tokenMatches, tryPairCode } from './remote.js'
import { NgrokTunnel } from './tunnel.js'
import { log } from './log.js'
import type { RemoteStatus } from '../shared/protocol.js'
import { PORT } from './config.js'
import { WEB_DIR } from './web.js'
import type { RouteCtx } from './routes/ctx.js'
import { readJsonBody } from './routes/http-util.js'
import { errText } from './errors.js'

/** Phone access (server/remote.ts): off until switched on in Settings → Phone. */
export let remote = loadRemote()
/** The 6-digit code Settings → Phone shows; memory only. A restart just mints another. */
let pairCode: PairCode | null = null
/** Phone access from anywhere: the user's ngrok, run while access and "Anywhere" are both on. */
export const tunnel = new NgrokTunnel((): void => {
  const s = tunnel.status
  if (s.state === 'up') log('info', 'remote', `tunnel up at ${s.url}`)
  else if (s.state === 'error') log('warn', 'remote', `tunnel failed: ${s.error}`)
})
export function syncTunnel() {
  if (remote.enabled && remote.tunnel) tunnel.start(PORT)
  else tunnel.stop()
}

/**
 * The bundled manifest, with the start URL swapped per device: a paired phone's
 * home-screen app opens through /api/pair, because iOS gives a standalone web
 * app its own cookie jar and the pairing cookie would not follow it there.
 */
export function webManifest(access: Access): Record<string, unknown> {
  let base: Record<string, unknown> = { name: 'Triage', short_name: 'Triage', display: 'standalone' }
  try {
    base = JSON.parse(readFileSync(path.join(WEB_DIR, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>
  } catch {
    // no build yet: the minimal manifest is fine
  }
  return { ...base, start_url: access === 'paired' ? `/api/pair?token=${encodeURIComponent(remote.token)}` : '/', scope: '/' }
}

function remoteStatus(): RemoteStatus {
  if (remote.enabled) pairCode = livePairCode(pairCode, Date.now())
  return {
    local: true,
    enabled: remote.enabled,
    token: remote.token,
    code: remote.enabled && pairCode ? { digits: pairCode.code, expiresAt: pairCode.expiresAt } : null,
    port: PORT,
    addresses: lanAddresses(),
    hostname: bonjourName(),
    tunnel: remote.tunnel,
    tunnelStatus: tunnel.status,
  }
}

/** Sockets and WebSockets from other devices, so switching access off or resetting the token cuts them at once. */
export const remoteSockets = new Set<import('node:net').Socket>()
export const remoteWs = new Set<WebSocket>()

function dropRemoteClients() {
  for (const ws of remoteWs) ws.close(4401, 'unpaired')
  remoteWs.clear()
  for (const sock of remoteSockets) sock.destroy()
  remoteSockets.clear()
}

export async function pairRoute({ req, res, url, access }: RouteCtx): Promise<boolean> {
  if (url.pathname === '/api/pair') {
    // The QR code's link: trade the token for the cookie, then go home. Also
    // the home-screen app's start URL, so a standalone web app with its own
    // cookie jar pairs itself on every launch.
    const given = url.searchParams.get('token')
    const typed = url.searchParams.get('code')
    let ok = access === 'local' || (remote.enabled && tokenMatches(given?.trim(), remote.token))
    if (!ok && remote.enabled && typed && codesAllowed(req)) {
      const spent = tryPairCode(pairCode, typed, Date.now())
      pairCode = spent.next
      ok = spent.ok
      log(ok ? 'info' : 'warn', 'remote', ok ? 'device paired with the code' : 'wrong pairing code')
    }
    if (ok) {
      res.writeHead(302, { location: '/', ...(access === 'local' ? {} : { 'set-cookie': pairCookie(remote.token) }) })
      res.end()
    } else {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        pairPageHtml(
          typed
            ? 'That code did not match, or it has expired. Check the code on your Mac — it changes after each use.'
            : given
              ? 'That link has stopped working — the code was reset on the Mac. Scan the new QR code.'
              : undefined,
          codesAllowed(req),
        ),
      )
    }
    return true
  }
  return false
}

export async function remoteRoute({ req, url, json, access }: RouteCtx): Promise<boolean> {
  if (url.pathname === '/api/remote') {
    // Phone access is managed from the Mac only: a paired phone can use triage
    // but cannot read the token, rotate it, or switch access off and on.
    if (access !== 'local') {
      json(200, { local: false } satisfies RemoteStatus)
      return true
    }
    if (req.method === 'POST') {
      let body: { enabled?: unknown; rotate?: unknown; newCode?: unknown; tunnel?: unknown } | null
      try {
        body = (await readJsonBody(req, 10_000)) as typeof body
      } catch (err) {
        json(400, { error: errText(err) })
        return true
      }
      const next = { ...remote }
      if (typeof body?.enabled === 'boolean') next.enabled = body.enabled
      if (typeof body?.tunnel === 'boolean') next.tunnel = body.tunnel
      if (body?.rotate === true) next.token = newToken()
      if (body?.rotate === true || body?.newCode === true || !next.enabled) pairCode = null
      await saveRemote(next)
      const unpair = !next.enabled || next.token !== remote.token
      remote = next
      if (unpair) dropRemoteClients()
      syncTunnel()
      log('info', 'remote', `phone access ${remote.enabled ? (remote.tunnel ? 'on, anywhere' : 'on, same network') : 'off'}${body?.rotate === true ? ', token reset' : ''}`)
    }
    json(200, remoteStatus())
    return true
  }
  return false
}
