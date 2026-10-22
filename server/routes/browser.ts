import { readFile } from 'node:fs/promises'
import type {
  BrowserClearResponse,
  BrowserDefaultResponse,
  BrowserPickResponse,
  BrowserProfileResponse,
  BrowserProfilesResponse,
  BrowserShotsResponse,
  BrowserSitesResponse,
  BrowserTabResponse,
} from '../../shared/protocol.js'
import { profileOfSigninTab, type BrowserProfileColor } from '../../core/browser/profiles.js'
import type { SiteCookies } from '../../core/browser/wire.js'
import { resolveUrl } from '../../core/browser/policy.js'
import { describePicked } from '../browser.js'
import { browserProfiles } from '../browser/profiles.js'
import { broadcastProfiles } from '../browser/owners.js'
import { setWorkspaceBrowserProfile, workspaceBrowserProfile } from '../settings-ops.js'
import { browserHub, runtimes } from '../workspace/runtime.js'
import { readJsonBody } from './http-util.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import type { ScopedCtx } from './ctx.js'

/**
 * The browser pane (.docs/browser.md): host status, evidence, the picker, the
 * profiles (machine-wide: every workspace edits the same list) and each
 * session's tab: its profile, where it was, opening it.
 *
 * A tab key is a session of this workspace, or `profile-<id>`: a profile's
 * sign-in tab in Settings, which no tool can ever name.
 */
export async function browserRoutes({ req, url, json, res, rt }: ScopedCtx): Promise<boolean> {
  const p = url.pathname
  if (!p.startsWith('/api/browser/')) return false

  if (p === '/api/browser/status' && req.method === 'GET') {
    json(200, { ok: true, ...browserHub.status })
    return true
  }

  const shotRoute = /^\/api\/browser\/shots\/([\w-]+)(?:\/(\d+))?$/.exec(p)
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

  if (p === '/api/browser/pick' && req.method === 'POST') {
    let body: BrowserPickResponse
    try {
      const b = (await readJsonBody(req, 10_000)) as { sessionId?: unknown; uid?: unknown } | null
      const row = typeof b?.sessionId === 'string' ? rt.rows.get(b.sessionId) : undefined
      if (!row || typeof b?.uid !== 'number') throw new Error('need a session of this workspace and a uid')
      body = { ok: true, ...(await describePicked({ hub: browserHub, shots: rt.shots, sessionId: row.id, projectRoot: row.cwd, mode: 'chat' }, b.uid)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  const profiles = browserProfiles()
  if (p === '/api/browser/profiles' && req.method === 'GET') {
    const body: BrowserProfilesResponse = { ok: true, profiles: profiles.list(), workspaceDefault: await workspaceBrowserProfile(rt), app: browserHub.status }
    json(200, body)
    return true
  }
  if (p === '/api/browser/profiles' && req.method === 'POST') {
    let body: BrowserProfileResponse
    try {
      const b = ((await readJsonBody(req, 10_000)) ?? {}) as { name?: unknown; color?: unknown }
      if (typeof b.name !== 'string') throw new Error('need a name')
      body = { ok: true, profile: await profiles.create({ name: b.name, ...(b.color !== undefined ? { color: b.color as BrowserProfileColor } : {}) }) }
      log('info', 'browser', `profile created: ${body.profile.name} (${body.profile.id})`)
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  const one = /^\/api\/browser\/profiles\/([a-z0-9-]{1,32})(\/sites|\/clear)?$/.exec(p)
  if (one) {
    const [, id, sub] = one
    if (!profiles.get(id)) {
      json(404, { ok: false, error: `No profile "${id}".` })
      return true
    }
    if (!sub && req.method === 'PATCH') {
      let body: BrowserProfileResponse
      try {
        const b = ((await readJsonBody(req, 10_000)) ?? {}) as { name?: unknown; color?: unknown }
        if (b.name !== undefined && typeof b.name !== 'string') throw new Error('name must be a string')
        body = { ok: true, profile: await profiles.update(id, { ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(b.color !== undefined ? { color: b.color as BrowserProfileColor } : {}) }) }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return true
    }
    if (!sub && req.method === 'DELETE') {
      try {
        await deleteProfile(id)
        json(200, { ok: true })
      } catch (err) {
        json(400, { ok: false, error: errText(err) })
      }
      return true
    }
    if (sub === '/sites' && req.method === 'GET') {
      let body: BrowserSitesResponse
      try {
        const r = await browserHub.profileCall<{ sites: SiteCookies[] }>(id, { op: 'sites' })
        body = { ok: true, sites: [...(r?.sites ?? [])].sort((a, b) => b.persistent - a.persistent || a.site.localeCompare(b.site)) }
        await profiles.setSites(id, body.sites)
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 503, body)
      return true
    }
    if (sub === '/clear' && req.method === 'POST') {
      let body: BrowserClearResponse
      try {
        const b = ((await readJsonBody(req, 10_000)) ?? {}) as { site?: unknown }
        const site = typeof b.site === 'string' && b.site.trim() ? b.site.trim().toLowerCase() : undefined
        const r = await browserHub.profileCall<{ removed: number }>(id, { op: 'clear', ...(site ? { site } : {}) })
        body = { ok: true, removed: r?.removed ?? 0 }
        // what it is signed in to now
        const after = await browserHub.profileCall<{ sites: SiteCookies[] }>(id, { op: 'sites' }).catch(() => null)
        if (after) await profiles.setSites(id, after.sites)
        log('info', 'browser', `profile ${id}: cleared ${site ?? 'every site'} (${body.removed})`)
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 503, body)
      return true
    }
  }
  if (p === '/api/browser/default' && req.method === 'PUT') {
    let body: BrowserDefaultResponse
    try {
      const b = ((await readJsonBody(req, 10_000)) ?? {}) as { profile?: unknown }
      body = { ok: true, workspaceDefault: await setWorkspaceBrowserProfile(rt, b.profile) }
      void broadcastProfiles()
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  // ── a session's tab ──────────────────────────────────────────────────────

  const tab = /^\/api\/browser\/tabs\/([\w-]{1,80})(\/open|\/takeover|\/page)?$/.exec(p)
  if (tab) {
    const [, key, sub] = tab
    const open = sub === '/open'
    const signin = profileOfSigninTab(key)
    if (!signin && !rt.rows.has(key)) {
      json(404, { ok: false, error: 'no such session in this workspace' })
      return true
    }
    if (signin && !profiles.get(signin)) {
      json(404, { ok: false, error: `No profile "${signin}".` })
      return true
    }
    let body: BrowserTabResponse
    try {
      if (!sub && req.method === 'GET') body = { ok: true, tab: await browserHub.tabInfo(key) }
      else if (sub === '/takeover' && req.method === 'PUT') {
        const b = ((await readJsonBody(req, 10_000)) ?? {}) as { on?: unknown }
        if (typeof b.on !== 'boolean') throw new Error('need on: true (take over) or false (hand back)')
        body = { ok: true, tab: await browserHub.setHeld(key, b.on) }
      } else if (!sub && req.method === 'PUT') {
        if (signin) throw new Error("a profile's sign-in tab is always in that profile")
        const b = ((await readJsonBody(req, 10_000)) ?? {}) as { profile?: unknown }
        let profile: string | null = null
        if (b.profile !== null) {
          const found = typeof b.profile === 'string' ? profiles.find(b.profile) : null
          if (!found) throw new Error(`no browser profile ${typeof b.profile === 'string' ? `"${b.profile}"` : 'given'}`)
          profile = found.id
        }
        body = { ok: true, tab: await browserHub.setProfile(key, profile, { byUser: true }) }
      } else if (open && req.method === 'POST') {
        const b = ((await readJsonBody(req, 10_000)) ?? {}) as { url?: unknown }
        let target: string | null = null
        if (typeof b.url === 'string' && b.url.trim()) {
          target = resolveUrl(b.url, await browserHub.remembered(browserHub.activeKey(key)))
          if (!target) throw new Error(`"${b.url}" is not a URL this browser can open`)
        }
        // the address bar drives the page the pane shows
        await browserHub.open(browserHub.activeKey(key), target, 'load', { byUser: true })
        body = { ok: true, tab: await browserHub.tabInfo(key) }
      } else if (sub === '/page' && req.method === 'POST') {
        // the pane's page strip: switch to a page or close one
        if (signin) throw new Error("a profile's sign-in tab has one page")
        const b = ((await readJsonBody(req, 10_000)) ?? {}) as { action?: unknown; page?: unknown }
        if (typeof b.page !== 'number' || !Number.isInteger(b.page)) throw new Error('need page: a page number')
        if (b.action === 'switch') browserHub.switchPage(key, b.page, { byUser: true })
        else if (b.action === 'close') browserHub.closePage(key, b.page)
        else throw new Error('need action: switch or close')
        body = { ok: true, tab: await browserHub.tabInfo(key) }
      } else return false
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  return false
}

/**
 * Delete a profile: sessions put in it follow their default again, a
 * workspace whose default it was falls back to Default (read-time), and the
 * app wipes its jar now, or at its next hello.
 */
async function deleteProfile(id: string) {
  const profiles = browserProfiles()
  await profiles.remove(id)
  browserHub.unbindProfile(id)
  for (const rt of runtimes.values()) {
    for (const sessionId of await rt.store.browserTabs.withProfile(id)) await rt.store.browserTabs.put(sessionId, { profile: null }, Date.now())
  }
  log('info', 'browser', `profile deleted: ${id}`)
  if (browserHub.status.compatible) void browserHub.sendDrops()
}
