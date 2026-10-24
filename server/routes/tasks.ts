import { errText } from '../errors.js'
import { approveTaskOp, babysitSettingsOp, retryTaskOp, skipTaskOp, stopTaskOp } from '../tasks/ops.js'
import { readJsonBody } from './http-util.js'
import { postReviewOp, reviewAgainOp, reviewHeadOp } from '../review/post.js'
import { approvePlanOp, changePlanOp, sendReplyOp } from '../playbooks/ops.js'
import { sendBotRepliesOp } from '../tasks/bot-replies.js'
import { draftNudgeOp, sendNudgeOp } from '../tasks/nudge.js'
import { startPlaybookOp } from '../rules-ops.js'
import { clearSuppressionOp, handoffOp, isHandoffVerb, listSuppressionsOp, notNowReasonOp } from '../handoff-ops.js'
import type { ScopedCtx } from './ctx.js'
import type { HandoffResponse, NotNowReasonResponse, NudgeTaskResponse, SuppressionsResponse } from '../../shared/protocol.js'

/**
 * Tasks on items (POST /api/tasks/<verb> {id, …}), first-pass reviews
 * (post-review, review-again, the head the watch last read), the item playbooks
 * (start one, send its reply, approve or send back its plan), a bot triage's
 * replies (send-bot-replies), nudges (draft one, send it), hand-offs
 * (start, pause, resume, not this one) and babysitting's
 * settings (GET/POST /api/babysit/settings). Every answer is { ok, … }.
 */
export async function taskRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  const verb = /^\/api\/tasks\/(approve|retry|stop|skip)$/.exec(url.pathname)?.[1]
  if (verb && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown; reviewer?: unknown; note?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new Error('id required')
      const task =
        verb === 'approve'
          ? await approveTaskOp(rt, id, { ...(typeof body.reviewer === 'string' ? { reviewer: body.reviewer } : {}) })
          : verb === 'retry'
            ? await retryTaskOp(rt, id, typeof body.note === 'string' ? body.note : undefined)
            : verb === 'stop'
              ? await stopTaskOp(rt, id)
              : await skipTaskOp(rt, id)
      json(200, { ok: true, task })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // Playbooks on any item (server/playbooks/ops.ts): send the drafted reply, approve or send back the plan.
  const pb = /^\/api\/tasks\/(send-reply|approve-plan|change-plan)$/.exec(url.pathname)?.[1]
  if (pb && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new Error('id required')
      const task = pb === 'send-reply' ? await sendReplyOp(rt, body.id, body) : pb === 'approve-plan' ? await approvePlanOp(rt, body.id, body) : await changePlanOp(rt, body.id, body)
      json(200, { ok: true, task })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // Hand-offs (server/handoff-ops.ts): hand an item to Junior, pause it, resume it, or not this one.
  const ho = /^\/api\/handoff\/(start|pause|resume|not-now)$/.exec(url.pathname)?.[1]
  if (ho && isHandoffVerb(ho) && req.method === 'POST') {
    try {
      const { item, readiness } = await handoffOp(rt, ho, (await readJsonBody(req)) ?? {})
      json(200, { ok: true, item, readiness } satisfies HandoffResponse)
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // Why not this one (server/handoff-ops.ts): the reason on the item, and a suppression after two matching ones.
  if (url.pathname === '/api/handoff/reason' && req.method === 'POST') {
    try {
      json(200, { ok: true, ...(await notNowReasonOp(rt, (await readJsonBody(req)) ?? {})) } satisfies NotNowReasonResponse)
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // The kinds Junior stopped suggesting: listed and cleared in Junior's notebook.
  if (url.pathname === '/api/suggest/suppressions' && req.method === 'GET') {
    json(200, { ok: true, suppressions: await listSuppressionsOp(rt) } satisfies SuppressionsResponse)
    return true
  }
  if (url.pathname === '/api/suggest/suppressions/clear' && req.method === 'POST') {
    try {
      json(200, { ok: true, ...(await clearSuppressionOp(rt, (await readJsonBody(req)) ?? {})) } satisfies SuppressionsResponse)
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // You handed the item to Junior from its page: answer, investigate or debug-fix (server/rules-ops.ts).
  if (url.pathname === '/api/playbooks/start' && req.method === 'POST') {
    try {
      json(200, { ok: true, task: await startPlaybookOp(rt, (await readJsonBody(req)) ?? {}) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // A bot triage's drafted replies (server/tasks/bot-replies.ts): send them, as edited on the card.
  if (url.pathname === '/api/tasks/send-bot-replies' && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new Error('id required')
      json(200, { ok: true, task: await sendBotRepliesOp(rt, body.id, body) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // Nudges (server/tasks/nudge.ts): draft one when you pick it on a Waiting row; send it, as edited, or mark it sent by hand.
  if (url.pathname === '/api/nudge/draft' && req.method === 'POST') {
    try {
      json(200, { ok: true, task: await draftNudgeOp(rt, (await readJsonBody(req)) ?? {}) } satisfies NudgeTaskResponse)
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/tasks/send-nudge' && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new Error('id required')
      json(200, { ok: true, task: await sendNudgeOp(rt, body.id, body) } satisfies NudgeTaskResponse)
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  // First-pass reviews: post the one on the card, or read the PR again (server/review/post.ts).
  if (url.pathname === '/api/tasks/post-review' && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new Error('id required')
      json(200, { ok: true, task: await postReviewOp(rt, body.id, body) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/tasks/review-again' && req.method === 'POST') {
    try {
      const body = ((await readJsonBody(req)) ?? {}) as { id?: unknown }
      if (typeof body.id !== 'string' || !body.id) throw new Error('id required')
      json(200, { ok: true, task: await reviewAgainOp(rt, body.id) })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  if (url.pathname === '/api/review/head' && req.method === 'GET') {
    json(200, { ok: true, sha: await reviewHeadOp(rt, url.searchParams.get('item') ?? '') })
    return true
  }
  if (url.pathname === '/api/babysit/settings' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const settings = await babysitSettingsOp(rt, req.method === 'POST' ? ((await readJsonBody(req)) ?? {}) : undefined)
      json(200, { ok: true, settings })
    } catch (err) {
      json(400, { ok: false, error: errText(err) })
    }
    return true
  }
  return false
}
