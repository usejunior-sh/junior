import os from 'node:os'
import { type Persona, personaAppend, personaFrom } from '../core/junior/persona.js'
import { log } from './log.js'
import type { ActionView, JuniorDay, JuniorSeen, ScoredItem, SessionStatus } from '../shared/protocol.js'
import { type AddedBy, carryOver, dayKey, draftPlan, isOwner, matchItem, type Owner, type PlanItem, type PlanRow, planRows, type PlanSession, type PlanView, shortRef } from '../core/junior/today.js'
import { type NowCandidate, pickNow, todoProgress, type TodoProgress } from '../core/junior/now.js'
import { startOfDay } from '../core/work/due.js'
import { needsRows, type SendsSource, type TeamSource } from '../core/junior/needs.js'
import { briefFacts, type FactRun } from '../core/junior/facts.js'
import { canDoFill, firstOffers, type OfferItem } from '../core/junior/offers.js'
import { RESERVED_SERVER } from '../core/job/tools.js'
import { ghLogin } from '../core/sources/github.js'
import { listLibrary } from './library.js'
import { morningBrief } from '../core/junior/morning.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { broadcast } from './ws/send.js'
import { pExecFile } from './config.js'
import { getInbox, slackConnected } from './inbox/sync.js'
import { teamRunOf } from './team-run/state.js'
import { createManualOp } from './items-ops.js'
import { errText } from './errors.js'
import { actionViews } from './session/actions-record.js'
import { libraryRootsFor } from './session/changes.js'
import { inboxAlerts } from './inbox/flow.js'

// Junior (.docs/junior-goals-teams): the persona, the Junior page's day, and
// today's plan. The rules are pure and tested in core/junior/; everything
// here only gathers their inputs from the runtime and the store.

const PERSONA_KEY = 'junior.persona'

export async function readPersona(rt: WorkspaceRuntime): Promise<Persona> {
  return personaFrom(await rt.store.config.get<unknown>(PERSONA_KEY))
}

/** Save a patch onto the persona; every open page and the rail repaint from the broadcast. */
export async function savePersonaOp(rt: WorkspaceRuntime, raw: unknown): Promise<Persona> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('need a JSON object')
  const next = personaFrom(raw, rt.persona)
  await rt.store.config.set(PERSONA_KEY, next)
  rt.persona = next
  broadcast(rt, { type: 'persona', persona: next })
  log('info', 'junior', `persona saved: ${next.name}, ${next.voice}`, { workspace: rt.meta.id })
  return next
}

/** What the greeting calls the user: the first word of the Mac's full name, else of the login. Cached. */
let youName: Promise<string | null> | null = null
export function userFirstName(): Promise<string | null> {
  youName ??= (async () => {
    const full = process.platform === 'darwin' ? await pExecFile('id', ['-F']).then((r) => r.stdout.trim(), () => '') : ''
    const first = (full || os.userInfo().username).split(/[\s._-]+/).find(Boolean) ?? ''
    return first ? first[0].toUpperCase() + first.slice(1) : null
  })()
  return youName
}

/** "the Mentions job", "the Build team", or the session's title, where a send came from. */
function sendOrigin(v: ActionView): string {
  if (v.sessionKind === 'job-run') return v.jobTitle ? `the ${v.jobTitle} job` : 'a job'
  if (v.teamRunId) return v.teamLabel ? `the ${v.teamLabel} team` : 'a team'
  return v.sessionTitle ?? 'a session'
}

/** The open inbox as the Junior page reads it: the warm cache, else a sync. */
const juniorInbox = async (rt: WorkspaceRuntime): Promise<ScoredItem[]> => (rt.inboxCache ?? (await getInbox(rt, false))).items

/** No plan has ever existed and no chat was ever started: Junior introduces itself. */
async function isFirstOpen(rt: WorkspaceRuntime): Promise<boolean> {
  return !(await rt.store.today.everPlanned()) && ![...rt.rows.values()].some((r) => r.kind === 'chat')
}

/**
 * Today's plan, opened if it isn't yet: the day's record, and the rows that
 * carry over from the last planned day (every row whose item is still open).
 */
export async function ensureToday(rt: WorkspaceRuntime, now = Date.now()): Promise<string> {
  const date = dayKey(now)
  if (await rt.store.today.day(date)) return date
  const prev = await rt.store.today.lastBefore(date)
  const open = new Set<string>()
  for (const e of prev?.entries ?? []) if ((await rt.store.items.get(e.itemId))?.status === 'open') open.add(e.itemId)
  const carried = prev ? carryOver(prev.entries, (id) => open.has(id), date, now) : []
  if (await rt.store.today.openDay({ date, createdAt: now, draftedAt: null }, carried)) {
    if (carried.length) {
      log('info', 'junior', `today: ${carried.length} carried over from ${prev?.date}`, { workspace: rt.meta.id })
      broadcast(rt, { type: 'today_changed' })
    }
  }
  return date
}

/**
 * The page opened: the first open of a day drafts the plan, once, unless
 * this is the first open ever, where Junior introduces itself instead.
 * `force` = the user asked for a draft ("draft one from my inbox").
 */
export async function openTodayOp(rt: WorkspaceRuntime, opts: { force?: boolean } = {}): Promise<PlanView> {
  const now = Date.now()
  const date = await ensureToday(rt, now)
  const day = await rt.store.today.day(date)
  if (opts.force || (day && !day.draftedAt && !(await isFirstOpen(rt)))) {
    await rt.store.today.setDrafted(date, now)
    const existing = await rt.store.today.entries(date)
    const candidates = (await juniorInbox(rt)).map((i) => ({ id: i.id, score: i.score, turn: i.flow?.turn, group: i.group, kind: i.kind, status: i.status ?? 'open' }))
    const rows = draftPlan({ date, now, existing, candidates })
    for (const r of rows) await rt.store.today.put(r)
    log('info', 'junior', `today: drafted ${rows.length} from the inbox`, { workspace: rt.meta.id })
    broadcast(rt, { type: 'today_changed' })
  }
  return todayView(rt, date)
}

/** Read a running session's todo list for "step 2 of 3". The last few hundred events are plenty. */
async function sessionProgress(rt: WorkspaceRuntime, sessionId: string): Promise<TodoProgress | null> {
  const last = await rt.store.events.lastSeq(sessionId)
  const events = await rt.store.events.read(sessionId, Math.max(0, last - 400))
  return todoProgress(events.map((e) => e.event))
}

const isRunning = (s: SessionStatus | undefined) => s === 'running' || s === 'starting'

/** The plan as the page shows it: each row's item, owner and status. */
export async function todayView(rt: WorkspaceRuntime, date: string): Promise<PlanView> {
  const entries = await rt.store.today.entries(date)
  const ids = entries.map((e) => e.itemId)
  const ranked = new Map((rt.inboxCache?.items ?? []).map((i) => [i.id, i]))
  const times = await rt.store.items.statusTimes(ids)
  const items = new Map<string, PlanItem>()
  for (const id of ids) {
    // The store is the truth for status; the ranked snapshot adds the ask and the flow.
    const it = await rt.store.items.get(id)
    if (!it) continue
    const r = ranked.get(id)
    items.set(id, { ...it, status: it.status ?? 'open', statusAt: times.get(id), ...(r ? { ask: r.ask, flow: r.flow } : {}) })
  }
  const sessions: PlanSession[] = []
  for (const [sessionId, itemId] of rt.sessionItem) {
    if (!items.has(itemId) || teamRunOf(rt, sessionId)) continue
    const row = rt.rows.get(sessionId)
    const l = rt.live.get(sessionId)
    if (!row || row.kind !== 'chat') continue
    const running = isRunning(l?.status)
    const todo = running ? await sessionProgress(rt, sessionId) : null
    sessions.push({ id: sessionId, itemId, running, waiting: !!l?.waiting, step: todo ? { n: todo.n, of: todo.of } : null, activity: todo?.activity ?? null, updatedAt: row.updatedAt })
  }
  for (const run of rt.teamRuns.values()) {
    if (!items.has(run.itemId) || run.state === 'done' || run.state === 'stopped') continue
    sessions.push({
      id: run.leadSessionId,
      itemId: run.itemId,
      running: run.state === 'running',
      waiting: run.state === 'proposed' || run.state === 'gate' || !!run.revision,
      step: { n: Math.min(run.step + 1, run.recipe.steps.length), of: run.recipe.steps.length },
      activity: null,
      updatedAt: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
    })
  }
  const projects = new Map((await rt.store.projects.list()).map((p) => [p.id, p.name]))
  return planRows({ date, entries, items, sessions, projectName: (id) => (id ? projects.get(id) : undefined) })
}

/** Put an item on today (an existing one, or a new to-do made from `title`), or change whose it is. */
export async function addToTodayOp(rt: WorkspaceRuntime, raw: unknown, by: AddedBy): Promise<{ plan: PlanView; itemId: string; created: boolean }> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // "user" is how the MCP tools say it (a model reads "you" as itself).
  const owner: Owner = r.owner === 'user' ? 'you' : isOwner(r.owner) ? r.owner : 'you'
  let itemId = typeof r.itemId === 'string' ? r.itemId.trim() : ''
  let created = false
  if (!itemId) {
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (!title) throw new Error('need an itemId, or a title to create a to-do from')
    itemId = await createManualOp(rt, { title })
    created = true
  } else if (!(await rt.store.items.get(itemId))) throw new Error(`no work item ${itemId} — find it with list_work_items, or create it first`)
  const now = Date.now()
  const date = await ensureToday(rt, now)
  const existing = await rt.store.today.entries(date)
  const had = existing.find((e) => e.itemId === itemId)
  await rt.store.today.put({
    date,
    itemId,
    owner,
    addedBy: had?.addedBy ?? by,
    addedAt: had?.addedAt ?? now,
    order: had?.order ?? existing.reduce((m, e) => Math.max(m, e.order + 1), 0),
    carriedFrom: had?.carriedFrom ?? null,
  })
  log('info', 'junior', `today: ${had ? 'owner of' : 'added'} ${itemId} → ${owner} (by ${by})`, { workspace: rt.meta.id })
  broadcast(rt, { type: 'today_changed' })
  return { plan: await todayView(rt, date), itemId, created }
}

export async function removeFromTodayOp(rt: WorkspaceRuntime, raw: unknown): Promise<{ plan: PlanView; removed: boolean }> {
  const itemId = typeof (raw as { itemId?: unknown } | null)?.itemId === 'string' ? (raw as { itemId: string }).itemId : ''
  if (!itemId) throw new Error('need an itemId')
  const date = await ensureToday(rt)
  const removed = await rt.store.today.remove(date, itemId)
  if (removed) broadcast(rt, { type: 'today_changed' })
  return { plan: await todayView(rt, date), removed }
}

/** "Also today…": the open item a few typed words mean, if any. */
export async function matchTodayOp(rt: WorkspaceRuntime, q: string): Promise<{ id: string; title: string; ref: string; onToday: boolean } | null> {
  const items = await juniorInbox(rt)
  const hit = matchItem(q, items)
  if (!hit) return null
  const item = items.find((i) => i.id === hit.id)!
  const date = await ensureToday(rt)
  const onToday = (await rt.store.today.entries(date)).some((e) => e.itemId === hit.id)
  return { id: item.id, title: item.title, ref: shortRef(item), onToday }
}

/** The plan for a model: compact JSON, ids first so every row is a next call. */
export function todayJson(plan: PlanView): string {
  const status = (s: PlanRow['status']) =>
    s.kind === 'done' ? 'done' : s.kind === 'needs' ? 'a session on it waits on the user' : s.kind === 'live' ? `in progress${s.step ? `, step ${s.step.n} of ${s.step.of}` : ''}` : s.kind === 'waiting' ? `${s.who ?? 'someone'} is waiting on the user` : s.kind === 'carried' ? `carried over from ${s.from}` : (s.note ?? 'to do')
  return JSON.stringify(
    { date: plan.date, done: plan.done, total: plan.total, rows: plan.rows.map((r) => ({ itemId: r.itemId, title: r.title, ref: r.ref, owner: r.owner === 'you' ? 'the user' : 'you (Junior)', status: status(r.status) })) },
    null,
    2,
  )
}

/**
 * Today's plan in a new Junior session's context, and what to do when the
 * user adds to it mid-chat. A snapshot, said to be one: get_today reads it
 * live. (shared/juniorContext.ts keeps live state out of prompts; this is
 * the one deliberate exception, so "today we also want X" works in any chat.)
 */
function todayAppend(plan: PlanView, name: string, now: number): string {
  const when = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const rows = plan.rows.length
    ? plan.rows
        .map((r) => {
          const who = r.owner === 'you' ? 'the user' : name
          const st = r.status.kind === 'done' ? 'done' : r.status.kind === 'live' ? 'in progress' : r.status.kind === 'carried' ? 'carried over' : 'to do'
          return `- [${who}] ${r.title} (${r.itemId}) — ${st}`
        })
        .join('\n')
    : '(nothing on it yet)'
  return `

Today's plan, as of ${when} on ${plan.date}. It may have moved since; get_today reads it live:
${rows}

The plan is shared: you and the user both work from it, and every session today can see it. When the user says
something is also for today ("today we also want X"), find the work item first with list_work_items, matching the
title or a ref. If there is one, put it on with add_to_today, asking whose it is today (theirs or yours) only when
they didn't say. If there is none, offer to create it with create_work_item and put it on today, in one reply.
Take something off with remove_from_today.`
}

/** Spawn-time additions for one of Junior's chats: the persona, then today's plan. */
export async function juniorAppend(rt: WorkspaceRuntime): Promise<string> {
  const now = Date.now()
  let plan: PlanView | null = null
  try {
    plan = await todayView(rt, await ensureToday(rt, now))
  } catch (err) {
    log('warn', 'junior', `could not read today's plan for a session: ${errText(err)}`, { workspace: rt.meta.id })
  }
  return `${personaAppend(rt.persona)}${plan ? todayAppend(plan, rt.persona.name, now) : ''}`
}

/** Everything the Junior page shows, in one read. `since` = the brief's window. */
export async function juniorDayOp(rt: WorkspaceRuntime, q: { since: number; away: boolean }): Promise<JuniorDay> {
  const now = Date.now()
  const since = Number.isFinite(q.since) && q.since > 0 && q.since <= now ? q.since : startOfDay(now)
  const items = await juniorInbox(rt)
  const rows = [...rt.rows.values()]
  const jobs = await rt.store.jobs.list()
  const jobTitles = new Map(jobs.map((j) => [j.id, j.title]))
  const projects = await rt.store.projects.list()
  const plan = await todayView(rt, await ensureToday(rt, now))

  // Needs you: held sessions, team runs waiting on you, sends waiting for your OK.
  const blocked = rows
    .filter((r) => rt.live.get(r.id)?.waiting)
    .map((r) => ({ id: r.id, title: r.title, waitingOn: rt.live.get(r.id)?.waitingOn, at: r.updatedAt }))
  const teams: TeamSource[] = []
  for (const run of rt.teamRuns.values()) {
    const state = run.revision ? 'revision' : run.state === 'proposed' ? 'proposed' : run.state === 'gate' ? 'gate' : null
    if (!state) continue
    teams.push({
      runId: run.id,
      leadSessionId: run.leadSessionId,
      label: run.title,
      goal: run.card.goal,
      state,
      steps: run.recipe.steps.length,
      team: run.recipe.label || run.team,
      budgetUsd: run.card.budgetUsd || run.budgetUsd,
      ...(state === 'revision' ? { reason: run.revision?.why } : run.reason ? { reason: run.reason } : {}),
      at: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
    })
  }
  const sends = new Map<string, SendsSource>()
  for (const v of await actionViews(rt, await rt.store.actions.list({ status: ['needs_you'], limit: 500 }))) {
    if (v.hidden) continue
    const at = v.queue?.queuedAt ?? v.attemptedAt
    const s = sends.get(v.sessionId) ?? { sessionId: v.sessionId, origin: sendOrigin(v), titles: [], at }
    s.titles.push(v.title)
    s.at = Math.min(s.at, at)
    sends.set(v.sessionId, s)
  }
  const needs = needsRows({ blocked, teams, sends: [...sends.values()] }, now)

  // The brief's facts.
  const runs: FactRun[] = rows
    .filter((r) => r.kind === 'job-run' && r.jobId && r.runStatus)
    .map((r) => ({ jobId: r.jobId!, ok: r.runStatus === 'ok', endedAt: r.updatedAt, filed: r.runNew ?? r.runMatches ?? 0 }))
  const sent = (await rt.store.actions.list({ since, status: ['succeeded'], limit: 1000 })).length
  const facts = briefFacts({ since, away: q.away, items, runs, jobTitles, sent })

  // Right now: team runs count once (at their lead), job runs by their job, chats by their own todo list.
  const onPlan = new Set(plan.rows.map((r) => r.itemId))
  const running: NowCandidate[] = []
  for (const run of rt.teamRuns.values()) {
    if (run.state !== 'running') continue
    running.push({
      target: { kind: 'session', id: run.leadSessionId },
      title: run.card.goal || run.title,
      updatedAt: rt.rows.get(run.leadSessionId)?.updatedAt ?? run.createdAt,
      onPlan: onPlan.has(run.itemId),
      todo: null,
      team: { n: Math.min(run.step + 1, run.recipe.steps.length), of: run.recipe.steps.length },
    })
  }
  for (const r of rows) {
    if (r.kind !== 'chat' || !isRunning(rt.live.get(r.id)?.status) || teamRunOf(rt, r.id)) continue
    const itemId = rt.sessionItem.get(r.id)
    running.push({ target: { kind: 'session', id: r.id }, title: r.title, updatedAt: r.updatedAt, onPlan: !!itemId && onPlan.has(itemId), todo: await sessionProgress(rt, r.id), team: null })
  }
  for (const jobId of rt.runningJobs) {
    running.push({ target: { kind: 'job', id: jobId }, title: `running the ${jobTitles.get(jobId) ?? 'scheduled'} job`, updatedAt: now, onPlan: false, todo: null, team: null })
  }

  const firstOpen = await isFirstOpen(rt)
  const slack = slackConnected(rt) === true
  const offerItems = items as OfferItem[]
  let seen: JuniorSeen | null = null
  {
    // Every MCP server Claude Code can see is a source, by its plain name; Junior's own server isn't one.
    const conns = new Map<string, boolean>()
    for (const c of rt.connectorCache?.connectors ?? []) {
      if (c.server === RESERVED_SERVER || c.name === RESERVED_SERVER) continue
      const name = c.name.replace(/^plugin:(?:[^:]+:)?/, '')
      conns.set(name, (conns.get(name) ?? false) || c.status === 'connected')
    }
    seen = {
      github: await ghLogin().catch(() => null),
      sources: [...conns].map(([name, connected]) => ({ name, connected })).sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
      projects: projects.map((p) => p.name),
    }
  }

  let routines: JuniorDay['routines'] = []
  try {
    const roots = await libraryRootsFor(rt)
    routines = [...(await listLibrary('skill', roots)), ...(await listLibrary('agent', roots))]
      .filter((e) => e.source === 'workspace')
      .map((e) => ({ name: e.name, kind: e.kind, path: e.path }))
  } catch (err) {
    log('warn', 'junior', `could not list the workspace library: ${errText(err)}`, { workspace: rt.meta.id })
  }

  const you = await userFirstName()
  return {
    you: { name: you, initial: (you ?? 'You')[0].toUpperCase() },
    firstOpen,
    now: pickNow(running),
    needs,
    facts,
    plan,
    seen,
    offers: firstOpen ? firstOffers(offerItems, { slack, now }) : [],
    fill: canDoFill(offerItems, projects.map((p) => p.name), slack),
    stuck: (await inboxAlerts(rt)).length > 0 || rows.some((r) => rt.live.get(r.id)?.status === 'error'),
    routines,
    morning: morningBrief({ items, facts, now }),
    jobsOn: jobs.filter((j) => j.enabled).length,
  }
}
