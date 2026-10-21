import { goalsRoute } from '../goals.js'
import { type ActionMoveRequest, type ActionMoveResponse, type ActionOverrideRequest, type ActionOverrideResponse, type ActionsPendingResponse, type ActionsResponse, type ActionVerb, type CardSpecsResponse, isLinkKind, type LinksResponse } from '../../shared/protocol.js'
import { isActionKind } from '../../core/actions/types.js'
import { localMidnight } from '../../core/job/schedule.js'
import { overriddenOff } from '../../core/actions/sort.js'
import { countLine, countSince } from '../../core/actions/count.js'
import { readJsonBody } from './http-util.js'
import { goalEngineFor } from '../goal-glue.js'
import { actionViews, backfillActions, needsYouCount, setActionOverride } from '../session/actions-record.js'
import { errText } from '../errors.js'
import { broadcast } from '../ws/send.js'
import { actionVerbOp } from '../session/actions-hold.js'
import { addLinkOp, linksFor } from '../artifacts-ops.js'
import type { ScopedCtx } from './ctx.js'

export async function actionRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  // Outbound actions (core/actions): every effect a session had that left
  // this machine, newest first. `item` = filed against it or made by a session
  // linked to it; records the actions file now sets aside come back `hidden`.
  // Goals (server/goals.ts): list, the goal page, and the goal_* writes.
  const goalReply = await goalsRoute(rt.goalDeps, req, url, () => readJsonBody(req), goalEngineFor(rt))
  if (goalReply) {
    json(goalReply.status, goalReply.body)
    return true
  }
  if (url.pathname === '/api/actions' && req.method === 'GET') {
    let body: ActionsResponse
    try {
      const kind = url.searchParams.get('kind')
      const sessionId = url.searchParams.get('session') ?? undefined
      const itemId = url.searchParams.get('item') ?? undefined
      const limit = Number(url.searchParams.get('limit')) || 500
      const sessionIds = itemId ? [...rt.sessionItem].filter(([, i]) => i === itemId).map(([s]) => s) : undefined
      const records = await rt.store.actions.list({ ...(isActionKind(kind) ? { kind } : {}), ...(sessionId ? { sessionId } : {}), ...(itemId ? { itemId, sessionIds } : {}), limit })
      const actions = await actionViews(rt, records)
      // The count line is the workspace's day, whatever the list is narrowed to.
      const since = localMidnight(Date.now())
      const { rules, errors } = rt.actionsFile.current()
      const today = (await rt.store.actions.list({ since, status: ['succeeded', 'failed'], limit: 5000 })).filter((a) => !overriddenOff(a, rules))
      const counts = countSince(today, since)
      const failedToday = today.filter((a) => a.status === 'failed').length
      body = { ok: true, actions, today: { line: countLine(counts, failedToday), counts }, file: { path: rt.actionsFile.path, errors }, needsYou: await needsYouCount(rt) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // A row's one-click override, written to the actions file.
  if (url.pathname === '/api/actions/override' && req.method === 'POST') {
    let body: ActionOverrideResponse
    try {
      const raw = (await readJsonBody(req, 10_000)) as Partial<Record<keyof ActionOverrideRequest, unknown>> | null
      const actionId = typeof raw?.actionId === 'string' ? raw.actionId : ''
      const verdict = raw?.verdict === 'action' || raw?.verdict === 'not_action' ? raw.verdict : null
      if (!actionId || !verdict) throw new Error("need actionId and verdict ('action' | 'not_action')")
      const a = await rt.store.actions.get(actionId)
      if (!a) throw new Error('no such action')
      body = { ok: true, entries: await setActionOverride(rt, a, verdict) }
      broadcast(rt, { type: 'actions_changed' })
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // The rail's badge: queued actions waiting on you.
  // The card specs in force (core/cards): the workspace's files first, then the built-ins, and any file that didn't load.
  if (url.pathname === '/api/actions/cards' && req.method === 'GET') {
    const { specs, errors } = rt.cardSpecs.current()
    json(200, { ok: true, dir: rt.cardSpecs.dir, specs, errors } satisfies CardSpecsResponse)
    return true
  }
  if (url.pathname === '/api/actions/pending' && req.method === 'GET') {
    let body: ActionsPendingResponse
    try {
      body = { ok: true, needsYou: await needsYouCount(rt) }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // A queued action's verbs (core/actions/queue.ts): approve (optionally with
  // edited args), undo inside the window, send back with notes, reject, retry.
  const verbMatch = /^\/api\/actions\/(approve|undo|send-back|reject|retry)$/.exec(url.pathname)
  if (verbMatch && req.method === 'POST') {
    let body: ActionMoveResponse
    try {
      const raw = (await readJsonBody(req, 2_000_000)) as Partial<Record<keyof ActionMoveRequest, unknown>> | null
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('need a JSON object body')
      const next = await actionVerbOp(rt, verbMatch[1] as ActionVerb, raw)
      body = { ok: true, action: (await actionViews(rt, [next]))[0] }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Re-read every session's log into the record. Idempotent; the boot runs it once.
  if (url.pathname === '/api/actions/backfill' && req.method === 'POST') {
    try {
      const done = await backfillActions(rt, { force: true })
      json(200, { ok: true, ...done })
    } catch (err) {
      json(500, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/links') {
    let body: LinksResponse
    try {
      if (req.method === 'GET') {
        const kind = url.searchParams.get('kind')
        const id = url.searchParams.get('id') ?? ''
        if (!isLinkKind(kind) || !id) throw new Error('need kind (artifact|item|session) and id')
        body = { ok: true, links: await linksFor(rt, kind, id) }
      } else if (req.method === 'POST') {
        body = { ok: true, links: [await addLinkOp(rt, await readJsonBody(req))] }
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? ''
        if (!id) throw new Error('need a link id')
        await rt.store.links.remove(id)
        body = { ok: true, links: [] }
      } else throw new Error('method not allowed')
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
