import type { ArtifactAuthor, ArtifactContentResponse, ArtifactResponse, ArtifactsResponse, BriefJobsResponse, BriefResponse, ItemFilesResponse, ItemImagesResponse, ItemStateResponse, ItemUrlsResponse, UploadResponse } from '../../shared/protocol.js'
import { handleUpload, readItemFile } from '../attachments.js'
import { readItemImage } from '../itemImages.js'
import { log } from '../log.js'
import { briefViewFor, enqueueBriefsOp, finishBrief, iterateBriefOp } from '../brief-run.js'
import { errText } from '../errors.js'
import { readJsonBody } from './http-util.js'
import { ANY_ITEM_ID_RE, MAX_ITEM_BODY_BYTES } from '../validate.js'
import { invalidateInbox } from '../ws/send.js'
import { itemFilePlan, itemImageEdits, itemUrls, setItemFilesOp, setItemImagesOp } from '../items-ops.js'
import { createArtifactOp, linksFor, listArtifactsOp, type OkBody, openInEditor, updateArtifactOp } from '../artifacts-ops.js'
import type { ScopedCtx } from './ctx.js'

export async function briefRoutes({ req, res, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/briefs' && req.method === 'GET') {
    const itemId = url.searchParams.get('itemId')
    try {
      if (itemId) {
        const body: BriefResponse = { ok: true, brief: await briefViewFor(rt, itemId) }
        json(200, body)
      } else {
        const body: BriefJobsResponse = { ok: true, jobs: await rt.store.briefs.latestPerItem() }
        json(200, body)
      }
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/briefs' && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      body = { ok: true, jobs: await enqueueBriefsOp(rt, await readJsonBody(req)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/briefs/iterate' && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      body = { ok: true, jobs: [await iterateBriefOp(rt, await readJsonBody(req))] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if ((url.pathname === '/api/briefs/cancel' || url.pathname === '/api/briefs/promote') && req.method === 'POST') {
    let body: BriefJobsResponse
    try {
      const parsed = (await readJsonBody(req)) as { jobId?: unknown } | null
      const jobId = typeof parsed?.jobId === 'string' ? parsed.jobId : ''
      const job = jobId ? await rt.store.briefs.get(jobId) : null
      if (!job || job.status !== 'queued') throw new Error('only a queued brief can be cancelled or moved')
      if (url.pathname.endsWith('/cancel')) {
        await finishBrief(rt, job.id, 'failed', 'cancelled before it ran')
      } else {
        // To the head of the line: older than the oldest queued job.
        const [first] = await rt.store.briefs.list('queued')
        await rt.store.briefs.update(job.id, { createdAt: (first?.createdAt ?? job.createdAt) - 1 })
      }
      body = { ok: true, jobs: [(await rt.store.briefs.get(job.id)) ?? job] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/items/description' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; description?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const d = parsed?.description
      if (d !== null && d !== undefined && typeof d !== 'string') throw new Error('description must be a string')
      if (typeof d === 'string' && d.length > 5000) throw new Error('description is too long (5000 chars max)')
      await rt.store.items.setDescription(id, typeof d === 'string' && d.trim() ? d.trim() : null)
      invalidateInbox(rt)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // The human's links on any item. The list sent is the complete desired set.
  if (url.pathname === '/api/items/urls' && req.method === 'POST') {
    let body: ItemUrlsResponse
    try {
      const parsed = (await readJsonBody(req)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const urls = itemUrls(parsed?.urls) ?? []
      await rt.store.items.setUrls(id, urls)
      invalidateInbox(rt)
      body = { ok: true, urls }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Screenshots on an item. The list sent is the complete desired set: refs
  // to keep plus new base64 uploads, reconciled against what is on disk.
  if (url.pathname === '/api/items/images' && req.method === 'POST') {
    let body: ItemImagesResponse
    try {
      const parsed = (await readJsonBody(req, MAX_ITEM_BODY_BYTES)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, images: await setItemImagesOp(rt, id, itemImageEdits(parsed ?? {}) ?? []) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Files of any type on an item: the complete desired set, as ids — ones the
  // item holds stay, pending uploads are claimed, anything left out is deleted.
  if (url.pathname === '/api/items/files' && req.method === 'POST') {
    let body: ItemFilesResponse
    try {
      const parsed = (await readJsonBody(req, 64 * 1024)) as Record<string, unknown> | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      const held = (await rt.store.items.get(id))?.files ?? []
      const plan = (await itemFilePlan(rt, { files: parsed?.files ?? [] }, held))!
      body = { ok: true, files: await setItemFilesOp(rt, id, plan) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // One item file as a download (`itemFileUrl`). Always an attachment of an
  // opaque type: a user's html or svg must never run on triage's origin.
  if (url.pathname === '/api/items/file' && req.method === 'GET') {
    const itemId = url.searchParams.get('item') ?? ''
    const fileId = url.searchParams.get('file') ?? ''
    const item = ANY_ITEM_ID_RE.test(itemId) ? await rt.store.items.get(itemId).catch(() => null) : null
    const file = item?.files?.find((f) => f.id === fileId)
    if (!file) {
      json(404, { ok: false, error: 'no such file' })
      return true
    }
    try {
      const bytes = await readItemFile(rt.attachmentsDir, itemId, file)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'content-length': String(bytes.length),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
      })
      res.end(bytes)
    } catch {
      json(404, { ok: false, error: 'the file is missing' })
    }
    return true
  }
  // The bytes behind one ref (`itemImageUrl`). Ids are uuids and files are
  // never rewritten in place, so this is safe to cache hard.
  if (url.pathname === '/api/items/image' && req.method === 'GET') {
    const itemId = url.searchParams.get('item') ?? ''
    const imageId = url.searchParams.get('image') ?? ''
    const item = ANY_ITEM_ID_RE.test(itemId) ? await rt.store.items.get(itemId).catch(() => null) : null
    const image = item?.images?.find((i) => i.id === imageId)
    if (!image) {
      json(404, { ok: false, error: 'no such image' })
      return true
    }
    try {
      const bytes = await readItemImage(rt.attachmentsDir, itemId, image)
      res.writeHead(200, {
        'content-type': image.mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=31536000, immutable',
      })
      res.end(bytes)
    } catch {
      json(404, { ok: false, error: 'the image file is missing' })
    }
    return true
  }
  // A file picked, dropped or pasted into a composer or an item description:
  // the raw body, stored under attachments/uploads/<uuid>/<name> until a
  // message or item save names its id (shared/protocol.ts FileRef).
  if (url.pathname === '/api/uploads' && req.method === 'POST') {
    let body: UploadResponse
    try {
      body = { ok: true, file: await handleUpload(rt.attachmentsDir, req, url.searchParams.get('name')) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // --- artifacts + links (.docs/next-version.md, phase 1) ---------------------
  if (url.pathname === '/api/artifacts' && req.method === 'GET') {
    let body: ArtifactsResponse
    try {
      body = { ok: true, root: rt.artifacts.root, artifacts: await listArtifactsOp(rt, url.searchParams.get('all') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  if (url.pathname === '/api/artifacts/content' && req.method === 'GET') {
    let body: ArtifactContentResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const a = id ? await rt.artifacts.read(id) : null
      if (!a) throw new Error('no such artifact')
      body = { ok: true, artifact: a.artifact, body: a.body, links: await linksFor(rt, 'artifact', id), abs: a.abs }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 404, body)
    return true
  }
  if (url.pathname === '/api/artifacts' && (req.method === 'POST' || req.method === 'PUT')) {
    let body: ArtifactResponse
    try {
      const parsed = await readJsonBody(req)
      if (req.method === 'POST') body = { ok: true, artifact: await createArtifactOp(rt, parsed, 'human') }
      else {
        const id = url.searchParams.get('id') ?? ''
        if (!id) throw new Error('need an artifact id')
        // The stdio shim edits as the model (`?by=model`) and is held to the model's rule.
        const by: ArtifactAuthor = url.searchParams.get('by') === 'model' ? 'model' : 'human'
        body = { ok: true, artifact: await updateArtifactOp(rt, id, parsed, by) }
      }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/artifacts' && req.method === 'DELETE') {
    let body: OkBody
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!id) throw new Error('need an artifact id')
      await rt.artifacts.remove(id)
      log('info', 'artifacts', `removed ${id}`, { id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/artifacts/reindex' && req.method === 'POST') {
    let body: ArtifactsResponse
    try {
      await rt.artifacts.refresh(true)
      body = { ok: true, root: rt.artifacts.root, artifacts: await listArtifactsOp(rt, url.searchParams.get('all') === '1') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  // Open the file in the user's own editor — the server runs on their machine.
  if (url.pathname === '/api/artifacts/open' && req.method === 'POST') {
    let body: OkBody
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const a = id ? await rt.artifacts.read(id) : null
      if (!a) throw new Error('no such artifact')
      await openInEditor(a.abs)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
