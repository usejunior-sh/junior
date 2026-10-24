import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DispatchPreviewResponse, LibraryFileResponse, LibraryListResponse, TeamGoalsResponse, TeamRunFileResponse, TeamRunFilesResponse, TeamRunFolderResponse, TeamRunResponse } from '../../shared/protocol.js'
import { createLibraryEntry, libraryTargets, listLibrary, locate as locateLibrary, readLibraryFile, removeLibraryItem, writeLibraryFile } from '../library.js'
import { JUNIOR_DIR } from '../state.js'
import { isLibraryName } from '../teams.js'
import { libraryRootsFor, reloadLibraryEverywhere } from '../session/changes.js'
import { readJsonBody } from './http-util.js'
import { openInEditor } from '../artifacts-ops.js'
import { errText } from '../errors.js'
import { approveTeamOp, discardTeamOp, editPlanOp, editTeamCardOp, pauseTeamRunNow, planTeamOp, resumeTeamOp, saveAgentOp, saveRunAsTeamOp, setTeamFastOp, settleRevisionOp, stopTeamOp, teamLibraryOp, teamPickerOp, teamRunFrom } from '../team-run/ops.js'
import { runDirOf, runFileOf, runFolderList, syncRunFolder, teamRunView, withTeamRun } from '../team-run/state.js'
import { teamRunFilesOp } from '../team-run/files.js'
import { dispatchPreviewOp, goalActionOp, teamGoalsOp } from '../team-run/mcp.js'
import type { ScopedCtx } from './ctx.js'

export async function libraryRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  // Skills and agents (server/library.ts): list, read, write, create, delete, then reload everywhere.
  if (url.pathname.startsWith('/api/library')) {
    const route = `${req.method} ${url.pathname}`
    try {
      const roots = await libraryRootsFor(rt)
      if (route === 'GET /api/library') {
        const kind = url.searchParams.get('kind')
        if (kind !== 'skill' && kind !== 'agent') throw new Error('need ?kind=skill or ?kind=agent')
        const body: LibraryListResponse = { ok: true, entries: await listLibrary(kind, roots), targets: libraryTargets(roots) }
        json(200, body)
      } else if (route === 'GET /api/library/file') {
        const body: LibraryFileResponse = { ok: true, ...(await readLibraryFile(url.searchParams.get('path'), roots)) }
        json(200, body)
      } else if (route === 'PUT /api/library/file') {
        const b = ((await readJsonBody(req, 1_000_000)) ?? {}) as { path?: unknown; text?: unknown }
        const loc = await writeLibraryFile(b.path, b.text, roots)
        reloadLibraryEverywhere(rt)
        const body: LibraryFileResponse = { ok: true, ...(await readLibraryFile(loc.file, roots)) }
        json(200, body)
      } else if (route === 'POST /api/library') {
        const made = await createLibraryEntry(await readJsonBody(req), roots)
        reloadLibraryEverywhere(rt)
        json(200, { ok: true, path: made.path })
      } else if (route === 'DELETE /api/library') {
        await removeLibraryItem(url.searchParams.get('path'), roots, path.join(JUNIOR_DIR, 'trash'), {
          fileOnly: url.searchParams.get('file') === '1',
        })
        reloadLibraryEverywhere(rt)
        json(200, { ok: true })
      } else if (route === 'POST /api/library/open') {
        const b = ((await readJsonBody(req)) ?? {}) as { path?: unknown }
        const loc = locateLibrary(b.path, roots)
        await openInEditor(loc.kind === 'skill' ? loc.item : path.dirname(loc.item))
        json(200, { ok: true })
      } else json(404, { ok: false, error: 'not found' })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // Teams v2 (.docs/teams.md): the library, the dispatch picker, and a run's card and controls.
  if (url.pathname.startsWith('/api/teams')) {
    const route = `${req.method} ${url.pathname}`
    try {
      const lib = rt.teamLibrary
      if (route === 'GET /api/teams/library') {
        json(200, await teamLibraryOp(rt))
      } else if (route === 'GET /api/teams/picker') {
        json(200, await teamPickerOp(rt, url.searchParams.get('kind') ?? ''))
      } else if (route === 'POST /api/teams/plan') {
        json(200, { ok: true, sessionId: await planTeamOp(rt, await readJsonBody(req)) })
      } else if (route === 'PUT /api/teams/agent') {
        await saveAgentOp(rt, await readJsonBody(req))
        json(200, await teamLibraryOp(rt))
      } else if (route === 'DELETE /api/teams/agent' || route === 'DELETE /api/teams/team') {
        await lib.remove(url.pathname.endsWith('agent') ? 'agent' : 'team', url.searchParams.get('name') ?? '')
        json(200, await teamLibraryOp(rt))
      } else if (route === 'POST /api/teams/reset') {
        const b = ((await readJsonBody(req)) ?? {}) as { kind?: unknown; name?: unknown }
        if (!isLibraryName(b.name) || (b.kind !== 'agent' && b.kind !== 'team')) throw new Error('need a kind and a name')
        await lib.reset(b.kind, b.name)
        json(200, await teamLibraryOp(rt))
      } else if (route === 'GET /api/teams/run') {
        const body: TeamRunResponse = { ok: true, run: teamRunView(await teamRunFrom(rt, { runId: url.searchParams.get('runId') })) }
        json(200, body)
      } else if (route === 'GET /api/teams/file') {
        const run = await teamRunFrom(rt, { runId: url.searchParams.get('runId') })
        await syncRunFolder(rt, run)
        const file = runFileOf(rt, run, url.searchParams.get('path') ?? '')
        if (!file) throw new Error('not a file in this run’s folder')
        const body: TeamRunFileResponse = { ok: true, text: (await readFile(file, 'utf8')).slice(0, 400_000) }
        json(200, body)
      } else if (route === 'GET /api/teams/folder') {
        const run = await teamRunFrom(rt, { runId: url.searchParams.get('runId') })
        await syncRunFolder(rt, run)
        const body: TeamRunFolderResponse = { ok: true, title: run.title, team: run.recipe.label, state: run.state, leadSessionId: run.leadSessionId, dir: runDirOf(rt, run), files: runFolderList(rt, run) }
        json(200, body)
      } else if (route === 'GET /api/teams/files') {
        const body: TeamRunFilesResponse = { ok: true, files: await teamRunFilesOp(rt, await teamRunFrom(rt, { runId: url.searchParams.get('runId') })) }
        json(200, body)
      } else if (route === 'PUT /api/teams/card') {
        await editTeamCardOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'PUT /api/teams/fast') {
        await setTeamFastOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'PUT /api/teams/plan') {
        await editPlanOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/revision') {
        await settleRevisionOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/approve') {
        await approveTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/discard') {
        await discardTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/pause') {
        const run = await teamRunFrom(rt, await readJsonBody(req))
        await withTeamRun(rt, run, async () => {
          if (run.state !== 'running' && run.state !== 'gate' && run.state !== 'waiting') throw new Error(`the run is ${run.state}`)
          await pauseTeamRunNow(rt, run, 'paused by you')
        })
        json(200, { ok: true })
      } else if (route === 'GET /api/teams/goals') {
        const body: TeamGoalsResponse = { ok: true, goals: await teamGoalsOp(rt) }
        json(200, body)
      } else if (route === 'POST /api/teams/goal/answer' || route === 'POST /api/teams/goal/accept' || route === 'POST /api/teams/goal/reopen' || route === 'POST /api/teams/goal/wake') {
        await goalActionOp(rt, url.pathname.split('/').pop() as 'answer' | 'accept' | 'reopen' | 'wake', await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/resume') {
        await resumeTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/stop') {
        await stopTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true })
      } else if (route === 'POST /api/teams/save-as') {
        const team = await saveRunAsTeamOp(rt, await readJsonBody(req))
        json(200, { ok: true, team, library: await teamLibraryOp(rt) })
      } else if (route === 'POST /api/teams/open') {
        await openInEditor(lib.root)
        json(200, { ok: true })
      } else json(404, { ok: false, error: 'not found' })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/dispatch/preview' && req.method === 'GET') {
    let body: DispatchPreviewResponse
    try {
      body = { ok: true, preview: await dispatchPreviewOp(rt, url.searchParams.get('itemId') ?? '') }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
