import { type ItemStateResponse, type ManualItemResponse, type SessionSpend, type SessionsUsageResponse, type UpsertResponse, USAGE_WINDOWS, type UsageModelSlice } from '../../shared/protocol.js'
import { scanUsage } from '../../core/usage/ledger.js'
import { summarizeBySession, summarizeModels } from '../../core/usage/summary.js'
import { log } from '../log.js'
import { dueInput } from '../../core/work/due.js'
import { claudeProjectRoots } from '../usage/logins.js'
import { reconcileGitHub, syncInbox } from '../inbox/sync.js'
import { invalidateInbox } from '../ws/send.js'
import { jobsEnabled } from '../settings-ops.js'
import { enqueueJob } from '../jobs/queue.js'
import { createManualOp, editManualOp, resolveItemOp, upsertItemOp } from '../items-ops.js'
import { readJsonBody } from './http-util.js'
import { MAX_ITEM_BODY_BYTES } from '../validate.js'
import { setFlowOverrideOp } from '../inbox/flow.js'
import { errText } from '../errors.js'
import type { ScopedCtx } from './ctx.js'

export async function itemWriteRoutes({ req, url, json, rt }: ScopedCtx): Promise<boolean> {
  // What a set of sessions cost: the item page's per-item spend readout. The
  // caller names the sessions (it owns the item→session join); we map each to
  // the Claude session id captured at init and fold the ledger by that.
  if (url.pathname === '/api/usage/sessions' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200)
    const asked = Number(url.searchParams.get('days'))
    const days = USAGE_WINDOWS.includes(asked as (typeof USAGE_WINDOWS)[number]) ? asked : 30
    const now = Date.now()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime() - (days - 1) * 86_400_000

    let body: SessionsUsageResponse
    try {
      const bySession: Record<string, SessionSpend> = {}
      let models: UsageModelSlice[] = []
      const totals: SessionSpend & { sessions: number } = {
        cost: 0,
        tokens: 0,
        messages: 0,
        priced: true,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        sessions: 0,
      }
      if (ids.length > 0) {
        // Only the newest sdk_session_id survives a resume today, so a resumed
        // session's earlier spend is not reachable from here. Whatever is on
        // the row is what can be joined.
        const stored = await rt.store.sessions.list()
        const sdkIds = new Map<string, string>()
        for (const sess of stored) {
          if (ids.includes(sess.id) && sess.sdkSessionId) sdkIds.set(sess.id, sess.sdkSessionId)
        }
        if (sdkIds.size > 0) {
          const { entries } = await scanUsage(claudeProjectRoots(), since)
          const folded = summarizeBySession(entries)
          // The model split is over these sessions only, not the machine.
          const wanted = new Set(sdkIds.values())
          models = summarizeModels(entries.filter((e) => wanted.has(e.sessionId)))
          for (const [id, sdkId] of sdkIds) {
            const row = folded.get(sdkId)
            if (!row) continue
            bySession[id] = row
            totals.cost += row.cost
            totals.tokens += row.tokens
            totals.messages += row.messages
            totals.input += row.input
            totals.output += row.output
            totals.cacheWrite += row.cacheWrite
            totals.cacheRead += row.cacheRead
            if (!row.priced) totals.priced = false
            if (row.subagents) {
              const sub = (totals.subagents ??= { cost: 0, messages: 0 })
              sub.cost += row.subagents.cost
              sub.messages += row.subagents.messages
            }
            if (row.workflows) {
              const wf = (totals.workflows ??= { cost: 0, messages: 0, tokens: 0 })
              wf.cost += row.workflows.cost
              wf.messages += row.workflows.messages
              wf.tokens += row.workflows.tokens
            }
            totals.sessions++
          }
        }
      }
      body = { ok: true, usage: { days, bySession, models, totals } }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 500, body)
    return true
  }
  // Manual "scan now": force every due (and overdue) job to run and refresh GitHub.
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      void reconcileGitHub(rt, true).then(() => {
        invalidateInbox(rt)
        void syncInbox(rt)
      })
      void (async () => {
        // "Scan now": every enabled job, now, as a manual run.
        if (!(await jobsEnabled(rt))) return
        for (const w of await rt.store.jobs.list()) if (w.enabled && !w.configError) enqueueJob(rt, w.id)
      })()
      log('info', 'scheduler', 'manual scan requested (all jobs + GitHub)', { workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return true
  }
  // The ingestion contract (.docs/jobs.md): idempotent upsert + resolve,
  // shared by external scanners over HTTP and the MCP shim (server/mcp.ts).
  // User state is never written by upsert; resolve is a normal 'done'.
  if (url.pathname === '/api/items/upsert' && req.method === 'POST') {
    let body: UpsertResponse
    try {
      const outcome = await upsertItemOp(rt, await readJsonBody(req))
      body = { ok: true, outcome }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  if (url.pathname === '/api/items/resolve' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      await resolveItemOp(rt, parsed?.id)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // Manual items, to-dos the user adds by hand. Create/edit/delete; they merge
  // into the inbox like any other source and share the done/snooze overlay.
  if (url.pathname === '/api/items/manual') {
    let body: ManualItemResponse
    let status = 200
    let id: string | undefined
    try {
      if (req.method === 'POST') {
        id = await createManualOp(rt, await readJsonBody(req, MAX_ITEM_BODY_BYTES))
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id) throw new Error('need a manual item id')
        await editManualOp(rt, id, await readJsonBody(req, MAX_ITEM_BODY_BYTES))
      } else if (req.method === 'DELETE') {
        // Never hard-delete (.docs/jobs-v2.md): "delete" archives the item,
        // recorded, so it survives in the Archived tab.
        const id = url.searchParams.get('id')
        if (id) {
          await rt.store.items.transition(id, { status: 'archived', actor: 'user', detail: { reason: 'deleted by user' } })
          invalidateInbox(rt)
        }
      } else {
        throw new Error('unsupported method')
      }
      body = id ? { ok: true, id } : { ok: true }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return true
  }
  // The user's stage/turn override (core/work/flow.ts), for what the rules can't see.
  if (url.pathname === '/api/items/flow' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      await setFlowOverrideOp(rt, await readJsonBody(req), 'user')
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: errText(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // A user priority override for any item (source or manual). null clears it.
  if (url.pathname === '/api/items/priority' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; priority?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!id) throw new Error('need an item id')
      const raw = parsed?.priority
      let priority: number | null
      if (raw === null || raw === 0 || raw === undefined) priority = null
      else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 4) priority = raw
      else throw new Error('priority must be 1–4, or null/0 to clear')
      await rt.store.items.setPriority(id, priority)
      invalidateInbox(rt)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  // A due set from the inbox (t / m / w / l or the date picker): a bucket or an
  // exact day, resolved to a day here. `due: null` goes back to the label's default.
  if (url.pathname === '/api/items/due' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; due?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!id) throw new Error('need an item id')
      const due = dueInput(parsed?.due, Date.now())
      if (due === undefined) throw new Error('need due: a YYYY-MM-DD day, a section name, or null')
      await rt.store.items.setDue(id, due)
      invalidateInbox(rt)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return true
  }
  return false
}
