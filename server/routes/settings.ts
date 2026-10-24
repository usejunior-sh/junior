import os from 'node:os'
import { type CommandsResponse, type ConnectorsResponse, isProviderId, type JuniorDayResponse, type ModelsResponse, type PersonaResponse, type PlaybookResponse, type PlaybooksResponse, type ScoreWeightsResponse, type SettingsResponse, type TodayMatchResponse, type TodayResponse } from '../../shared/protocol.js'
import { RESERVED_SERVER } from '../../core/job/tools.js'
import { isPlaybookName, listPlaybooks, readDispatchTemplate, readPlaybook, writeDispatchTemplate, writePlaybook } from '../briefs.js'
import { FOLDER_PROBE_TTL_MS, probeCommands, probeConnectors, probeModels, usableCommands } from '../workspace/probes.js'
import { expandHome } from '../folders.js'
import { localServersElsewhere } from '../jobs/preview.js'
import { addToTodayOp, ensureToday, juniorDayOp, matchTodayOp, openTodayOp, removeFromTodayOp, savePersonaOp, todayView, userFirstName } from '../junior-ops.js'
import { readJsonBody } from './http-util.js'
import { errText } from '../errors.js'
import { clearScoreWeightOp, listScoreWeightsOp, readSettings, setScoreWeightOp, touchesWatches, writeSettings } from '../settings-ops.js'
import { invalidateInbox } from '../ws/send.js'
import type { ScopedCtx } from './ctx.js'

export async function settingsRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  if (url.pathname === '/api/models') {
    // ?provider= names the agent whose list to read; absent = the workspace's.
    const asked = url.searchParams.get('provider')
    if (asked !== null && !isProviderId(asked)) {
      json(400, { ok: false, error: `unknown provider: ${asked}` } satisfies ModelsResponse)
      return true
    }
    const provider = asked ?? rt.meta.provider
    let body: ModelsResponse
    try {
      const cached = url.searchParams.get('refresh') === '1' ? undefined : rt.modelCache.get(provider)
      const probe = cached ?? (await probeModels(rt, provider))
      body = { ok: true, probedAt: probe.probedAt, models: probe.models }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  if (url.pathname === '/api/commands') {
    let body: CommandsResponse
    try {
      const cwd = expandHome(url.searchParams.get('cwd') ?? os.homedir())
      const cached = url.searchParams.get('refresh') === '1' ? null : rt.commandCache.get(cwd)
      const probe = cached ?? (await probeCommands(rt, cwd))
      body = { ok: true, cwd, probedAt: probe.probedAt, commands: usableCommands(rt, probe.commands) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  if (url.pathname === '/api/connectors') {
    let body: ConnectorsResponse
    try {
      const refresh = url.searchParams.get('refresh') === '1'
      const projectId = url.searchParams.get('projectId')
      if (projectId) {
        // The job picker: what a run in this project's folder can load.
        const project = (await rt.store.projects.list()).find((p) => p.id === projectId)
        if (!project) throw new Error('unknown project')
        const cached = rt.folderProbes.get(project.path)
        const probe = cached && !refresh && Date.now() - cached.probedAt < FOLDER_PROBE_TTL_MS ? cached : await probeConnectors(rt, project.path)
        // the run's own server shadows any user server named junior, never offer it
        const connectors = probe.connectors.filter((c) => c.server !== RESERVED_SERVER)
        body = { ok: true, probedAt: probe.probedAt, connectors, cwd: project.path, elsewhere: await localServersElsewhere(rt, project.path, connectors) }
      } else {
        const probe = rt.connectorCache && !refresh ? rt.connectorCache : await probeConnectors(rt)
        if (refresh) rt.folderProbes.clear()
        body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
      }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // Score weights you set (core/work/weights.ts): list, set, clear. All three through the settings ops.
  if (url.pathname === '/api/score-weights' && req.method === 'GET') {
    json(200, { ok: true, weights: await listScoreWeightsOp(rt) } satisfies ScoreWeightsResponse)
    return true
  }
  if ((url.pathname === '/api/score-weights' || url.pathname === '/api/score-weights/clear') && req.method === 'POST') {
    let body: ScoreWeightsResponse
    try {
      const raw = (await readJsonBody(req, 10_000)) ?? {}
      body = url.pathname.endsWith('/clear') ? { ok: true, ...(await clearScoreWeightOp(rt, raw)) } : { ok: true, ...(await setScoreWeightOp(rt, raw)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // settings, briefs, playbooks, dispatch
  // Junior (.docs/junior-goals-teams): the persona, the page's day, today's plan.
  if (url.pathname === '/api/persona') {
    let body: PersonaResponse
    try {
      if (req.method === 'GET') body = { ok: true, persona: rt.persona, you: await userFirstName() }
      else if (req.method === 'PUT') body = { ok: true, persona: await savePersonaOp(rt, await readJsonBody(req, 10_000)) }
      else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/junior' && req.method === 'GET') {
    let body: JuniorDayResponse
    try {
      body = { ok: true, day: await juniorDayOp(rt, { since: Number(url.searchParams.get('since')), away: url.searchParams.get('away') === '1' }) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  if (url.pathname === '/api/today/match' && req.method === 'GET') {
    let body: TodayMatchResponse
    try {
      body = { ok: true, match: await matchTodayOp(rt, (url.searchParams.get('q') ?? '').slice(0, 300)) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/today' || url.pathname.startsWith('/api/today/')) {
    let body: TodayResponse
    try {
      if (url.pathname === '/api/today' && req.method === 'GET') body = { ok: true, plan: await todayView(rt, await ensureToday(rt)) }
      else if (req.method !== 'POST') throw new Error('method not allowed')
      else if (url.pathname === '/api/today/open') {
        const raw = (await readJsonBody(req, 1_000).catch(() => null)) as { force?: unknown } | null
        body = { ok: true, plan: await openTodayOp(rt, { force: raw?.force === true }) }
      } else if (url.pathname === '/api/today/add') {
        const raw = (await readJsonBody(req, 10_000)) as { by?: unknown } | null
        body = { ok: true, plan: (await addToTodayOp(rt, raw, raw?.by === 'junior' ? 'junior' : 'you')).plan }
      } else if (url.pathname === '/api/today/remove') body = { ok: true, plan: (await removeFromTodayOp(rt, await readJsonBody(req, 10_000))).plan }
      else throw new Error('unknown route')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/settings') {
    let body: SettingsResponse
    try {
      if (req.method === 'GET') body = { ok: true, settings: await readSettings(rt) }
      else if (req.method === 'PUT') {
        const patch = await readJsonBody(req)
        body = { ok: true, settings: await writeSettings(rt, patch) }
        // each handed-off PR's readiness is read off the switches at sync: resync, so its row stops saying "off"
        if (touchesWatches(patch)) invalidateInbox(rt)
      } else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/playbooks') {
    const kind = url.searchParams.get('kind')
    try {
      if (req.method === 'GET' && !kind) {
        const body: PlaybooksResponse = { ok: true, playbooks: await listPlaybooks(rt.playbookDir) }
        json(200, body)
      } else if (req.method === 'GET' && kind) {
        const p = await readPlaybook(rt.playbookDir, kind)
        const body: PlaybookResponse = { ok: true, kind, body: p.body, custom: p.custom, path: p.path }
        json(200, body)
      } else if (req.method === 'PUT' && kind) {
        const parsed = (await readJsonBody(req)) as { body?: unknown } | null
        if (typeof parsed?.body !== 'string') throw new Error('need a markdown body')
        await writePlaybook(rt.playbookDir, kind, parsed.body)
        const p = await readPlaybook(rt.playbookDir, kind)
        const body: PlaybookResponse = { ok: true, kind, body: p.body, custom: p.custom, path: p.path }
        json(200, body)
      } else throw new Error('need ?kind= (GET or PUT)')
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/dispatch/template') {
    const kind = url.searchParams.get('kind') ?? ''
    try {
      if (!isPlaybookName(kind)) throw new Error('need ?kind=')
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { body?: unknown } | null
        if (typeof parsed?.body !== 'string') throw new Error('need a template body')
        await writeDispatchTemplate(rt.dispatchDir, kind, parsed.body)
      }
      json(200, { ok: true, kind, body: await readDispatchTemplate(rt.dispatchDir, kind) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
