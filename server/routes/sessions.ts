import type { EditorsResponse, FileSearchResponse, OpenCheckoutResponse, OpenFileResponse, ProjectFileResponse, RemovalCheckResponse, RemoveCheckoutResponse, SaveProjectFileResponse, SessionChangesResponse, SessionDiffResponse, ShellOutputResponse, WorkflowAgentResponse, WorkflowDetailResponse, WorkingChangesResponse, WorkingDiffResponse } from '../../shared/protocol.js'
import { shellOutput } from '../shell-output.js'
import { workflowAgentOp, workflowDetailOp } from '../workflows.js'
import { worktreePatch } from '../git.js'
import { readProjectFile, writeProjectFile } from '../files.js'
import { sameOrigin } from '../remote.js'
import { log } from '../log.js'
import { detectEditors, openableFile, openFileIn, openFolderIn } from '../editors.js'
import { checkRemoval, prepareWorktree, recreateWorktree, removeWorktree } from '../worktrees.js'
import { summaries } from '../session/summaries.js'
import { errText } from '../errors.js'
import { computeSessionChanges, projectChanges, sessionFilePatch } from '../session/changes.js'
import { checkoutById, checkoutList, mainCheckout, runningIn, syncCheckouts } from '../session/checkouts.js'
import { readJsonBody } from './http-util.js'
import { broadcastSessionList } from '../ws/send.js'
import { expandHome } from '../folders.js'
import { isSearchableRoot } from '../session/mentions.js'
import type { ScopedCtx } from './ctx.js'

export async function sessionRoutes({ req, url, json, access, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/sessions') {
    json(200, summaries(rt))
    return true
  }

  // The tail of a background shell's output, polled by the chat while it runs.
  {
    const m = /^\/api\/sessions\/([^/]+)\/shells\/([^/]+)\/output$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      let body: ShellOutputResponse
      try {
        body = await shellOutput((id) => rt.store.events.read(id), decodeURIComponent(m[1]), decodeURIComponent(m[2]))
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 404, body)
      return true
    }
  }

  // An Ultracode Workflow run's files on disk, and one of its agents' transcripts.
  // Polled by the run panel while the run goes on.
  {
    const m = /^\/api\/sessions\/([^/]+)\/workflows\/([\w-]+)(?:\/agents\/([^/]+))?$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const [sessionId, taskId] = [decodeURIComponent(m[1]), m[2]]
      let body: WorkflowDetailResponse | WorkflowAgentResponse
      try {
        body = m[3] === undefined ? await workflowDetailOp(rt, sessionId, taskId) : await workflowAgentOp(rt, sessionId, taskId, decodeURIComponent(m[3]))
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 404, body)
      return true
    }
  }

  // What this session changed, and one file's patch. Session-scoped on
  // purpose: the question is "what did this agent do", not "what is dirty".
  {
    const m = /^\/api\/sessions\/([^/]+)\/(changes|diff)$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const row = rt.rows.get(m[1]) ?? (await rt.store.sessions.get(m[1]))
      if (!row) {
        json(404, { ok: false, error: 'no such session' })
        return true
      }
      if (m[2] === 'changes') {
        let body: SessionChangesResponse
        try {
          body = { ok: true, changes: await computeSessionChanges(rt, row) }
        } catch (err) {
          body = { ok: false, error: errText(err) }
        }
        json(body.ok ? 200 : 500, body)
        return true
      }
      const file = url.searchParams.get('path') ?? ''
      let body: SessionDiffResponse
      try {
        if (!file) throw new Error('need a path')
        const got = await sessionFilePatch(rt, row, file)
        if (!got) throw new Error('no snapshots for this session')
        body = { ok: true, path: file, patch: got.patch, isBinary: got.patch.includes('Binary files'), truncated: got.truncated }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return true
    }
  }

  // The Changes rail: every project's uncommitted files, one file's patch, and
  // reading/saving a changed file. Project-scoped, the complement of the
  // session view above: "what is dirty", whoever made it.
  if (url.pathname === '/api/changes' && req.method === 'GET') {
    let body: WorkingChangesResponse
    try {
      // The poll is also when worktrees made elsewhere, or deleted, are noticed.
      await syncCheckouts(rt)
      const projects = await rt.store.projects.list()
      body = { ok: true, projects: await Promise.all(projects.map((p) => projectChanges(rt, p))) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  if (url.pathname === '/api/changes/diff' || url.pathname === '/api/changes/file') {
    // `projectId=` is the pre-checkout form: that project's main folder.
    const checkout = checkoutById(rt, url.searchParams.get('checkoutId') ?? url.searchParams.get('projectId'))
    const project = checkout && (await rt.store.projects.list()).find((p) => p.id === checkout.projectId)
    const file = url.searchParams.get('path') ?? ''
    if (!checkout || !project || !file) {
      json(400, { ok: false, error: checkout && project ? 'need a path' : 'unknown checkout' })
      return true
    }
    if (url.pathname === '/api/changes/diff' && req.method === 'GET') {
      let body: WorkingDiffResponse
      try {
        const got = await worktreePatch(checkout.path, file)
        body = { ok: true, path: file, patch: got.patch, isBinary: got.patch.includes('Binary files'), truncated: got.truncated }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return true
    }
    if (url.pathname === '/api/changes/file' && req.method === 'GET') {
      let body: ProjectFileResponse
      try {
        body = await readProjectFile(checkout.path, file)
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return true
    }
    if (url.pathname === '/api/changes/file' && req.method === 'PUT') {
      // A write to disk: any page in the browser can POST to localhost, so
      // only our own origin gets to do it.
      if (!sameOrigin(req, access)) {
        json(403, { ok: false, error: 'cross-origin writes are not accepted' })
        return true
      }
      let body: SaveProjectFileResponse
      try {
        const parsed = (await readJsonBody(req, 4_000_000)) as { content?: unknown; version?: unknown } | null
        if (typeof parsed?.content !== 'string' || typeof parsed.version !== 'string') {
          throw new Error('need content and the version it was edited from')
        }
        body = await writeProjectFile(checkout.path, file, parsed.content, parsed.version)
        if (body.ok) log('info', 'changes', `saved ${file}`, { project: project.name, checkout: checkout.branch ?? checkout.path, workspace: rt.meta.id })
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : body.conflict ? 409 : 400, body)
      return true
    }
  }

  // "Open in…": the editors on this Mac, and opening a checkout's folder in one.
  if (url.pathname === '/api/editors' && req.method === 'GET') {
    let body: EditorsResponse
    try {
      body = { ok: true, editors: access === 'local' ? await detectEditors() : [] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  // Bringing a removed worktree back, at the same folder, so its sessions resume.
  const recreateMatch = /^\/api\/checkouts\/([^/]+)\/recreate$/.exec(url.pathname)
  if (recreateMatch && req.method === 'POST') {
    if (!sameOrigin(req, access)) {
      json(403, { ok: false, error: 'cross-origin requests are not accepted' })
      return true
    }
    let body: OpenCheckoutResponse
    try {
      const checkout = checkoutById(rt, decodeURIComponent(recreateMatch[1]))
      if (!checkout || checkout.kind !== 'worktree') throw new Error('no such worktree')
      if (checkout.state !== 'removed') throw new Error('that worktree is still there')
      const project = (await rt.store.projects.list()).find((p) => p.id === checkout.projectId)
      if (!project) throw new Error('its project is gone')
      await recreateWorktree(checkout, project)
      const notes = await prepareWorktree(project.path, checkout.path)
      await syncCheckouts(rt)
      log('info', 'checkouts', `recreated worktree ${checkout.branch ?? checkout.path}`, {
        workspace: rt.meta.id,
        ...(notes.length ? { notes: notes.join('; ') } : {}),
      })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  // Removing a worktree: what it would lose (asked first), then the removal itself.
  const removalMatch = /^\/api\/checkouts\/([^/]+)\/(removal|remove)$/.exec(url.pathname)
  if (removalMatch) {
    const checkout = checkoutById(rt, decodeURIComponent(removalMatch[1]))
    const main = mainCheckout(rt, checkout?.projectId)
    if (!checkout || checkout.kind !== 'worktree' || checkout.state !== 'active' || !main) {
      json(404, { ok: false, error: checkout?.kind === 'main' ? "the main folder is yours — junior doesn't remove it" : 'no such worktree' })
      return true
    }
    if (removalMatch[2] === 'removal' && req.method === 'GET') {
      let body: RemovalCheckResponse
      try {
        body = { ok: true, check: await checkRemoval(checkout, main.path, runningIn(rt, checkout.id)) }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 500, body)
      return true
    }
    if (removalMatch[2] === 'remove' && req.method === 'POST') {
      if (!sameOrigin(req, access)) {
        json(403, { ok: false, error: 'cross-origin requests are not accepted' })
        return true
      }
      let body: RemoveCheckoutResponse
      try {
        const parsed = (await readJsonBody(req)) as { force?: unknown; deleteBranch?: unknown } | null
        const force = parsed?.force === true
        const check = await checkRemoval(checkout, main.path, runningIn(rt, checkout.id))
        if (!check.safe && !force) {
          body = { ok: false, error: 'this worktree has work that would be lost', check }
        } else {
          // Its sessions keep their transcripts; their subprocesses can't outlive the folder.
          for (const r of rt.rows.values()) {
            if (r.checkoutId !== checkout.id || !rt.live.has(r.id)) continue
            rt.live.get(r.id)?.stop()
            rt.live.delete(r.id)
          }
          const notes = await removeWorktree(checkout, { force, deleteBranch: parsed?.deleteBranch !== false, merged: check.unmerged === 0 })
          await syncCheckouts(rt)
          broadcastSessionList(rt)
          log('info', 'checkouts', `removed worktree ${checkout.branch ?? checkout.path}${force ? ' (forced)' : ''}`, {
            workspace: rt.meta.id,
            ...(notes.length ? { notes: notes.join('; ') } : {}),
          })
          body = { ok: true }
        }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
      json(body.ok ? 200 : 400, body)
      return true
    }
  }

  const openMatch = /^\/api\/checkouts\/([^/]+)\/open$/.exec(url.pathname)
  if (openMatch && req.method === 'POST') {
    let body: OpenCheckoutResponse
    if (access !== 'local') {
      // The editor would open on the Mac's screen, not the phone asking for it.
      body = { ok: false, error: 'editors open on the Mac — use it there' }
    } else if (!sameOrigin(req, access)) {
      json(403, { ok: false, error: 'cross-origin requests are not accepted' })
      return true
    } else {
      try {
        const checkout = checkoutById(rt, decodeURIComponent(openMatch[1]))
        if (!checkout || checkout.state !== 'active') throw new Error('that checkout is gone')
        const parsed = (await readJsonBody(req)) as { editor?: unknown } | null
        const editor = typeof parsed?.editor === 'string' ? parsed.editor : ''
        if (!editor) throw new Error('need an editor')
        await openFolderIn(checkout.path, editor)
        body = { ok: true }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  // A file a session wrote, opened in the user's editor. Only files inside the
  // session's project: its own folder and every checkout of its project.
  const openFileMatch = /^\/api\/sessions\/([^/]+)\/open-file$/.exec(url.pathname)
  if (openFileMatch && req.method === 'POST') {
    let body: OpenFileResponse
    if (access !== 'local') {
      body = { ok: false, error: 'editors open on the Mac — use it there' }
    } else if (!sameOrigin(req, access)) {
      json(403, { ok: false, error: 'cross-origin requests are not accepted' })
      return true
    } else {
      try {
        const id = decodeURIComponent(openFileMatch[1])
        const row = rt.rows.get(id) ?? (await rt.store.sessions.get(id))
        if (!row) throw new Error('no such session')
        const parsed = (await readJsonBody(req)) as { path?: unknown; editor?: unknown } | null
        const projectId = row.projectId ?? checkoutById(rt, row.checkoutId)?.projectId
        const checkouts = projectId ? checkoutList(rt).filter((c) => c.projectId === projectId && c.state === 'active') : []
        const file = await openableFile(typeof parsed?.path === 'string' ? parsed.path : '', row.cwd, [row.cwd, ...checkouts.map((c) => c.path)])
        await openFileIn(file, typeof parsed?.editor === 'string' ? parsed.editor : undefined)
        body = { ok: true }
      } catch (err) {
        body = { ok: false, error: errText(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }

  // The composer's `@` picker: fuzzy file matches under one folder.
  if (url.pathname === '/api/files/search' && req.method === 'GET') {
    const root = expandHome(url.searchParams.get('root') ?? '')
    const q = url.searchParams.get('q') ?? ''
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 200)
    let body: FileSearchResponse
    if (!(await isSearchableRoot(rt, root))) {
      body = { ok: false, error: 'not a folder Junior can list (a session folder, a project, or under your home)' }
    } else {
      try {
        body = { ok: true, root, ...(await rt.files.get(root).search(q, limit)) }
      } catch (err) {
        body = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
