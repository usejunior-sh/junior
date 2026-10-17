import path from 'node:path'
import type { InboxResponse, PickFolderResponse, Project, ProjectsResponse, ReposResponse } from '../../shared/protocol.js'
import { log } from '../log.js'
import { affiliatedRepos, connectedRepos, getInbox, REPOS_KEY } from '../inbox/sync.js'
import { readJsonBody } from './http-util.js'
import { broadcast, invalidateInbox } from '../ws/send.js'
import { expandHome, pickNativeFolder } from '../folders.js'
import { addProject } from '../session/sessions.js'
import { checkoutList } from '../session/checkouts.js'
import type { ScopedCtx } from './ctx.js'

export async function inboxRoutes({ req, url, json, access, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/inbox') {
    let body: InboxResponse
    try {
      const snap = await getInbox(rt, url.searchParams.get('refresh') === '1')
      body = { ok: true, ...snap }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  if (url.pathname === '/api/repos') {
    let body: ReposResponse
    try {
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { repos?: unknown } | null
        const repos = Array.isArray(parsed?.repos)
          ? parsed.repos.filter((r): r is string => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))
          : []
        await rt.store.config.set(REPOS_KEY, repos)
        invalidateInbox(rt) // scope changed — force a resync on the next view
      }
      body = { ok: true, connected: await connectedRepos(rt), available: await affiliatedRepos(rt) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  if (url.pathname === '/api/projects') {
    let body: ProjectsResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = (await readJsonBody(req)) as Partial<Project> | null
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
        const repo = typeof parsed?.repo === 'string' ? parsed.repo.trim() : ''
        const rawPath = typeof parsed?.path === 'string' ? parsed.path.trim() : ''
        const makeDefault = (parsed as { makeDefault?: unknown } | null)?.makeDefault === true
        const id = typeof parsed?.id === 'string' ? parsed.id : ''
        const atFolder = rawPath
          ? (await rt.store.projects.list()).find((p) => path.resolve(p.path) === path.resolve(expandHome(rawPath)))
          : undefined
        if (makeDefault && (id || atFolder) && (!rawPath || atFolder)) {
          // Replace the default: the one way to move it, since it can't be deleted.
          // Onboarding names a folder; one that is already a project just becomes the default.
          await rt.store.projects.setDefault(atFolder?.id ?? id)
        } else {
          if (!name || !rawPath) throw new Error('a project needs a name and a folder')
          if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`)
          const project = await addProject(rt, rawPath, name, repo)
          if (makeDefault && !project.isDefault) await rt.store.projects.setDefault(project.id)
        }
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          await rt.store.projects.remove(id)
          await rt.store.checkouts.removeForProject(id)
          for (const c of checkoutList(rt)) if (c.projectId === id) rt.checkouts.delete(c.id)
          broadcast(rt, { type: 'checkouts', checkouts: checkoutList(rt) })
          // Its jobs pause with a visible reason — never run somewhere else (job-spec.md, item 2).
          for (const w of await rt.store.jobs.list()) {
            if (w.projectId !== id) continue
            await rt.store.jobs.patchState(w.id, { enabled: false, configError: 'project removed — pick another project for this job' })
            log('info', 'job', `paused "${w.title}": its project was removed`, { jobId: w.id, workspace: rt.meta.id })
          }
        }
      }
      body = { ok: true, projects: await rt.store.projects.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return true
  }
  if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
    if (access !== 'local') {
      // The chooser would open on the Mac's screen, not the phone asking for it.
      json(200, { ok: false, error: 'the folder picker opens on the Mac — type the folder path instead' } satisfies PickFolderResponse)
      return true
    }
    let body: PickFolderResponse
    try {
      const picked = await pickNativeFolder()
      body = picked ? { ok: true, path: picked } : { ok: true, cancelled: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  return false
}
