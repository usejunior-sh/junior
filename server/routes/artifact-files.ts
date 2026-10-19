import path from 'node:path'
import type { ArtifactContentResponse, ArtifactVersionsResponse } from '../../shared/protocol.js'
import { slug } from '../artifacts.js'
import { openArtifactFile, linksFor, type OkBody } from '../artifacts-ops.js'
import { openDenied, rawHeaders } from '../artifact-serve.js'
import { errText } from '../errors.js'
import { readJsonBody } from './http-util.js'
import type { ScopedCtx } from './ctx.js'

/** `?v=`: a positive integer, or absent. Anything else is the caller's mistake. */
function versionParam(url: URL): { v: number | undefined } | { error: string } {
  const raw = url.searchParams.get('v')
  if (raw === null) return { v: undefined }
  if (!/^[1-9]\d{0,8}$/.test(raw)) return { error: 'v must be a positive whole number' }
  return { v: Number(raw) }
}

/**
 * The file side of artifacts: raw bytes, versions, the text at a version, and
 * "open on this Mac". All under /api/, so the gate in front of every /api
 * route (a device that is not paired gets 401, writes must be same-origin)
 * covers them without new code here. Registered before briefRoutes.
 */
export async function artifactFileRoutes({ req, res, url, json, rt, access }: ScopedCtx): Promise<boolean> {
  if (!url.pathname.startsWith('/api/artifacts/')) return false

  // The file itself. A generated page must never reach /api: see server/artifact-serve.ts for the headers.
  if (url.pathname === '/api/artifacts/raw' && req.method === 'GET') {
    const ver = versionParam(url)
    if ('error' in ver) {
      json(400, { ok: false, error: ver.error })
      return true
    }
    try {
      const r = await rt.artifacts.readBytes(url.searchParams.get('id') ?? '', ver.v)
      if (!r) {
        json(404, { ok: false, error: 'no such artifact' })
        return true
      }
      res.writeHead(
        200,
        rawHeaders(r.format, {
          filename: `${slug(r.artifact.title)}.${r.format}`,
          scripts: url.searchParams.get('scripts') === '1',
          download: url.searchParams.get('download') === '1',
          versioned: ver.v !== undefined && !r.latest,
          size: r.bytes.length,
        }),
      )
      res.end(r.bytes)
    } catch (err) {
      json(404, { ok: false, error: errText(err) })
    }
    return true
  }

  if (url.pathname === '/api/artifacts/versions' && req.method === 'GET') {
    let body: ArtifactVersionsResponse
    try {
      const r = await rt.artifacts.versions(url.searchParams.get('id') ?? '')
      if (!r) throw new Error('no such artifact')
      body = { ok: true, ...r, ...(r.history ? {} : { historyNote: 'Files over 10 MB keep no history.' }) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 404, body)
    return true
  }

  // The text of one version (the latest without `v`); binary formats answer with an empty body and are read from /raw.
  if (url.pathname === '/api/artifacts/content' && req.method === 'GET') {
    const ver = versionParam(url)
    if ('error' in ver) {
      json(400, { ok: false, error: ver.error })
      return true
    }
    let body: ArtifactContentResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const t = id ? await rt.artifacts.readText(id, ver.v) : null
      if (!t) throw new Error('no such artifact')
      body = {
        ok: true,
        artifact: t.artifact,
        body: t.text,
        links: await linksFor(rt, 'artifact', id),
        abs: t.abs,
        version: t.version,
        latest: t.latest,
        binary: t.binary,
        truncated: t.truncated,
      }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 404, body)
    return true
  }

  // Open the file on this Mac, in an editor, selected in the file manager, or in its default app.
  if (url.pathname === '/api/artifacts/open' && req.method === 'POST') {
    let body: OkBody
    const denied = openDenied(access)
    if (denied) body = { ok: false, error: denied }
    else {
      try {
        const parsed = (await readJsonBody(req)) as { id?: unknown; mode?: unknown } | null
        const id = typeof parsed?.id === 'string' ? parsed.id : ''
        const mode = parsed?.mode === undefined ? 'editor' : parsed.mode
        if (mode !== 'editor' && mode !== 'reveal' && mode !== 'default') throw new Error('mode must be editor, reveal or default')
        const a = id ? await rt.artifacts.read(id) : null
        if (!a) throw new Error('no such artifact')
        await openArtifactFile(path.resolve(a.abs), mode)
        body = { ok: true }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
