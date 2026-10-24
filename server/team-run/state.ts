import path from 'node:path'
import { statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { backfillRuns, bookPlanning, checksDone, normalizeRun, runSpent, sessionSpend, stampRun, STEP_MESSAGE, type Action as TeamAction, type TeamRun, type Worker, workerById } from '../../core/teams/engine.js'
import type { RunState } from '../../core/teams/engine-types.js'
import { runLinkOf, summarizeRun, type TeamRunSummary } from '../../core/teams/summary.js'
import { log } from '../log.js'
import type { AgentCan, EffortLevel, SessionEvent, SessionTeamRun, TeamRunFolderFile, TeamRunView } from '../../shared/protocol.js'
import { workspaceDir } from '../workspaces.js'
import { runFiles } from '../../core/teams/files.js'
import { snapshotTree } from '../git.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { broadcast, broadcastSessionList } from '../ws/send.js'
import { finishTeamRun, runProjectChecks } from './ops.js'
import { createSession, getOrRevive } from '../session/sessions.js'
import { linkSessionToItem } from '../settings-ops.js'
import { handoffDiff } from './files.js'

// Teams v2 (server/teams.ts, core/teams/engine.ts): a recipe run by Junior. The
// lead is the chat session that proposed it; workers are sessions junior spawns
// per step. The engine decides; this section carries its actions out.
//
// Runs live in the team-run store (core/store/sqlite-team-runs.ts), one row
// each. A save writes the one run that changed, and a change of state is a
// line in its log. Boot loads the open runs whole; a closed one comes in as a
// summary (core/teams/summary.ts) and is loaded whole only when something asks
// for it (ensureTeamRun). The old `team_runs` config array is read only by the
// store's one-time copy.

/** The state each run was last saved in, so a save knows when to log a move. */
const savedState = new WeakMap<TeamRun, RunState>()

/**
 * Persist one run: its row, and a line in its log when its state moved. Only a
 * run in memory is saved: one already removed (its lead deleted mid-turn, a
 * card discarded) stays removed when a late change lands.
 */
export async function saveTeamRun(rt: WorkspaceRuntime, run: TeamRun, at = Date.now()): Promise<void> {
  if (rt.teamRuns.get(run.id) !== run) return
  await rt.store.teamRuns.upsert(run, at)
  const from = savedState.get(run) ?? null
  if (from !== run.state) {
    await rt.store.teamRuns.appendEvent(run.id, { kind: 'state', from, to: run.state, rev: run.rev, ...(run.reason ? { reason: run.reason } : {}) }, at)
    savedState.set(run, run.state)
  }
}

/** A run gone for good (a discarded card, its lead deleted): out of memory and the store. */
export async function removeTeamRun(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  rt.teamRuns.delete(run.id)
  rt.teamRunSummaries.delete(run.id)
  await rt.store.teamRuns.remove(run.id)
}

/** A stored run the server can still carry: runs from before recipes (no `recipe`), or whose lead is gone, are skipped. */
const usable = (rt: WorkspaceRuntime, run: TeamRun | null | undefined): run is TeamRun =>
  !!run && !!(run as Partial<TeamRun>).recipe && rt.rows.has(run.leadSessionId)

/**
 * Take a stored run into memory: drop worker sessions that are gone, index it,
 * and fill in what runs from older releases lack. Saves it when it filled
 * anything in.
 */
async function adoptTeamRun(rt: WorkspaceRuntime, stored: TeamRun): Promise<TeamRun> {
  for (const w of stored.workers) if (w.sessionId && !rt.rows.has(w.sessionId)) w.sessionId = null
  const unrecorded = !(stored as Partial<TeamRun>).workerRuns
  const run = normalizeRun(stored)
  savedState.set(run, run.state)
  rt.teamRuns.set(run.id, run)
  rt.teamRunSummaries.delete(run.id)
  indexTeamRun(rt, run)
  let filled = false
  if (unrecorded && run.outputs.length) {
    await backfillTeamRuns(rt, run).catch((err) => log('warn', 'teams', `could not backfill runs: ${err}`, { teamId: run.id, workspace: rt.meta.id }))
    filled = true
  }
  // A run proposed before planning was booked. Only once it's over, so a live
  // run's budget doesn't move under it.
  if (run.planningUsd === undefined && (run.state === 'done' || run.state === 'stopped')) {
    await leadPlanning(rt, run.leadSessionId, run.createdAt).then(
      (usd) => bookPlanning(run, usd),
      (err) => log('warn', 'teams', `could not book planning: ${err}`, { teamId: run.id, workspace: rt.meta.id }),
    )
    filled = true
  }
  if (filled) await saveTeamRun(rt, run)
  return run
}

/** Boot: the open runs into memory; the closed ones only as summaries, enough to link their sessions. */
export async function loadTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  for (const s of await rt.store.teamRuns.closedSummaries()) {
    if (!rt.rows.has(s.leadSessionId)) continue
    const summary = { ...s, workers: s.workers.filter((w) => rt.rows.has(w.sessionId)) }
    rt.teamRunSummaries.set(s.id, summary)
    indexTeamRun(rt, summary)
  }
  // Open after closed: a lead that went on to a new run links to the new one.
  for (const run of await rt.store.teamRuns.listOpen()) if (usable(rt, run)) await adoptTeamRun(rt, run)
}

/**
 * A run by id: from memory, else loaded whole from the store (a closed run boot
 * left as a summary). Undefined when there is no such run, or the server can't
 * carry it (see `usable`).
 */
export function ensureTeamRun(rt: WorkspaceRuntime, id: string): Promise<TeamRun | undefined> {
  const have = rt.teamRuns.get(id)
  if (have) return Promise.resolve(have)
  const inFlight = rt.teamRunLoads.get(id)
  if (inFlight) return inFlight
  const load = (async () => {
    const stored = await rt.store.teamRuns.get(id)
    // Raced with a save of the same run (a proposal reusing it): memory wins.
    const raced = rt.teamRuns.get(id)
    if (raced) return raced
    return usable(rt, stored) ? adoptTeamRun(rt, stored) : undefined
  })().finally(() => rt.teamRunLoads.delete(id))
  rt.teamRunLoads.set(id, load)
  return load
}

/** The run a session leads or works on, loaded whole: before anything that needs the full run for a session. */
export async function ensureSessionTeamRun(rt: WorkspaceRuntime, sessionId: string): Promise<TeamRun | undefined> {
  const id = rt.sessionTeam.get(sessionId)
  return id ? ensureTeamRun(rt, id) : undefined
}

/**
 * Runs for a list (the Goals tab, the picker's costs): the store's newest
 * `limit`, plus every run in memory, with the in-memory object where there is
 * one. Runs the server can't carry are left out, as boot leaves them out.
 */
export async function recentTeamRuns(rt: WorkspaceRuntime, limit: number, opts: { goal?: boolean } = {}): Promise<TeamRun[]> {
  const out = new Map<string, TeamRun>()
  for (const run of rt.teamRuns.values()) if (opts.goal === undefined || !!run.goal === opts.goal) out.set(run.id, run)
  for (const stored of await rt.store.teamRuns.listRecent(limit, opts)) {
    if (out.has(stored.id) || !usable(rt, stored)) continue
    out.set(stored.id, normalizeRun(stored))
  }
  return [...out.values()]
}

/** How many stored runs a list reads at most. */
export const RECENT_TEAM_RUNS = 200

/** Every run the server knows, as summaries: the ones in memory and the closed ones boot left out. */
export function teamRunSummaries(rt: WorkspaceRuntime): TeamRunSummary[] {
  return [...[...rt.teamRuns.values()].map(summarizeRun), ...rt.teamRunSummaries.values()]
}

/** A run's recipe label by id, whether it is in memory or only summarised. */
export function teamRunLabel(rt: WorkspaceRuntime, id: string): string | undefined {
  return rt.teamRuns.get(id)?.recipe.label ?? rt.teamRunSummaries.get(id)?.label
}

/** A run this session led before ended here, and booked what the session spent up to it. */
const RUN_ENDED = /^(Team done|Team stopped|Goal done)\b/

/**
 * What the lead spent planning a run: its spend from where the last run it led
 * ended up to the proposal. `before` is the proposal's time, for a run proposed
 * earlier; the turn that proposed was booked by the run itself.
 */
export async function leadPlanning(rt: WorkspaceRuntime, leadSessionId: string, before = Infinity): Promise<number> {
  const events = (await rt.store.events.read(leadSessionId)).filter((e) => e.createdAt < before)
  const ended = events.findLastIndex((e) => e.event.kind === 'notice' && RUN_ENDED.test(e.event.text))
  return Math.max(0, sessionSpend(events) - sessionSpend(events.slice(0, ended + 1)))
}

/** A run from before runs were recorded: find where each step arrived in its session's log. */
async function backfillTeamRuns(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  const starts: Record<string, { seq: number; at: number; fresh: boolean }[]> = {}
  for (const sid of new Set(run.workers.map((w) => w.sessionId).filter((x): x is string => !!x))) {
    const events = await rt.store.events.read(sid)
    starts[sid] = []
    events.forEach((e, i) => {
      const ev = e.event
      if (ev.kind !== 'local_user' || ev.from !== 'junior' || !STEP_MESSAGE.test(ev.text)) return
      // A fresh context announces itself just before the step that starts it.
      const prev = events[i - 1]?.event
      const fresh = prev?.kind === 'notice' && prev.text.startsWith('fresh context')
      starts[sid].push({ seq: fresh ? events[i - 1].seq : e.seq, at: e.createdAt, fresh })
    })
  }
  backfillRuns(run, starts)
}

/**
 * session id → run id, for the lead and every worker session. A session already
 * on a newer run stays there: a lead that went on to propose again links to its
 * latest run, whatever order runs are loaded in.
 */
export function indexTeamRun(rt: WorkspaceRuntime, run: { id: string; createdAt: number; leadSessionId: string; workers: readonly { sessionId: string | null }[] }): void {
  const claim = (sid: string) => {
    const was = rt.sessionTeam.get(sid)
    const other = was && was !== run.id ? rt.teamRuns.get(was) ?? rt.teamRunSummaries.get(was) : undefined
    if (other && other.createdAt > run.createdAt) return
    rt.sessionTeam.set(sid, run.id)
  }
  claim(run.leadSessionId)
  for (const w of run.workers) if (w.sessionId) claim(w.sessionId)
}

export const teamRunOf = (rt: WorkspaceRuntime, sessionId: string): TeamRun | undefined => {
  const id = rt.sessionTeam.get(sessionId)
  return id ? rt.teamRuns.get(id) : undefined
}

/** A session's place on a run, as the wire carries it. */
export function teamRunLink(rt: WorkspaceRuntime, sessionId: string): SessionTeamRun | undefined {
  const id = rt.sessionTeam.get(sessionId)
  const run = id ? rt.teamRuns.get(id) ?? rt.teamRunSummaries.get(id) : undefined
  return run ? runLinkOf(run, sessionId) : undefined
}

/** The session leads or works on a run, open or closed, loaded or not. */
export const inTeamRun = (rt: WorkspaceRuntime, sessionId: string): boolean => rt.sessionTeam.has(sessionId)

/** The run as the client reads it: everything but the server's own bookkeeping. */
export function teamRunView(run: TeamRun): TeamRunView {
  const { root: _root, checkCmds: _cmds, baseTree: _base, nudged: _nudged, ...view } = run
  return { ...view, spentUsd: runSpent(run) }
}

/** A worker's history is compacted past this many tokens (see extrasFor). */
export const TEAM_COMPACT_WINDOW = 200_000

/** Write a notice into a session's transcript, live or not. */
export async function sessionNotice(rt: WorkspaceRuntime, sessionId: string, text: string): Promise<void> {
  const live = rt.live.get(sessionId)
  if (live) return live.notice(text)
  const seq = (await rt.store.events.lastSeq(sessionId)) + 1
  const event: SessionEvent = { kind: 'notice', text }
  await rt.store.events.append(sessionId, seq, event)
  broadcast(rt, { type: 'session_event', sessionId, event, at: Date.now() })
}

export const usd = (n: number) => `$${n.toFixed(2)}`

/** Work on one run at a time: a turn ending and an API call never interleave their actions. */
export function withTeamRun<T>(rt: WorkspaceRuntime, run: TeamRun, fn: () => Promise<T>): Promise<T> {
  const prev = rt.teamLocks.get(run.id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  rt.teamLocks.set(run.id, next.catch(() => {}))
  return next
}

export async function teamRunChanged(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  await saveTeamRun(rt, run)
  broadcastSessionList(rt)
  schedulePlanSync(rt, run)
}

/**
 * The run folder, plan, ledger, verify, reviews, handoffs, rendered from the
 * run (core/teams/files.ts); junior's code is its only writer. Coalesced: a
 * burst of changes is one write, and an unchanged file is no write. Runs from
 * before the folder kept their Plan artifact; it is left as it was.
 */
const FOLDER_SYNC_MS = 1500
export function schedulePlanSync(rt: WorkspaceRuntime, run: TeamRun, now = false): Promise<void> | void {
  const key = `${rt.meta.id}:${run.id}`
  clearTimeout(planTimers.get(key))
  planTimers.delete(key)
  if (now) return syncPlan(rt, run)
  planTimers.set(
    key,
    setTimeout(() => {
      planTimers.delete(key)
      void syncPlan(rt, run)
    }, FOLDER_SYNC_MS),
  )
}
const planTimers = new Map<string, ReturnType<typeof setTimeout>>()

async function syncPlan(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  if (rt.teamRuns.has(run.id)) await syncRunFolder(rt, run)
}

/**
 * Where a run's folder lives (.docs/team-handoffs.md): in the project's own
 * `.junior/` when it has one, so the run sits beside the code it changed; else
 * in the workspace folder under ~/.junior.
 */
export function teamRunDir(rt: WorkspaceRuntime, runId: string, root: string | undefined): string {
  const local = root ? path.join(root, '.junior') : null
  if (local) {
    try {
      if (statSync(local).isDirectory()) return path.join(local, 'team-runs', runId)
    } catch {
      /* no project folder: the workspace's */
    }
  }
  return path.join(workspaceDir(rt.meta.id), 'team-runs', runId)
}

/** A run's folder; runs from before folders get one now. */
export function runDirOf(rt: WorkspaceRuntime, run: TeamRun): string {
  run.dir ??= teamRunDir(rt, run.id, run.root)
  return run.dir
}

/** What each run-folder file last held, so an unchanged file is never rewritten. */
const runFolderSeen = new Map<string, string>()

/** Write the run folder (core/teams/files.ts): every file that changed since the last write. */
export async function syncRunFolder(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  const dir = runDirOf(rt, run)
  try {
    // Inside the project, the runs folder ignores itself: the team's own notes must never show up
    // in the diff a reviewer reads, or in a handoff's changed files.
    if (run.root && dir.startsWith(path.join(run.root, '.junior') + path.sep)) {
      const ignore = path.join(path.dirname(dir), '.gitignore')
      if (!runFolderSeen.has(ignore)) {
        await mkdir(path.dirname(ignore), { recursive: true })
        await writeFile(ignore, '# junior team runs — local working notes, never committed\n*\n', { flag: 'wx' }).catch(() => {})
        runFolderSeen.set(ignore, '')
      }
    }
    for (const [rel, text] of Object.entries(runFiles(run))) {
      const key = `${dir}\u0000${rel}`
      if (runFolderSeen.get(key) === text) continue
      const file = path.join(dir, rel)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text, 'utf8')
      runFolderSeen.set(key, text)
    }
  } catch (err) {
    log('error', 'teams', `could not write the run folder: ${err}`, { teamId: run.id, workspace: rt.meta.id })
  }
}

/** The run folder's files, in reading order: plan, ledger, verify, reviews, then each handoff and patch. */
export function runFolderList(rt: WorkspaceRuntime, run: TeamRun): TeamRunFolderFile[] {
  const dir = runDirOf(rt, run)
  const names = Object.keys(runFiles(run))
  const top = ['plan.md', 'ledger.md', 'verify.md', 'reviews.md'].filter((p) => names.includes(p))
  const out: TeamRunFolderFile[] = top.map((p) => ({ path: p, label: p.replace(/\.md$/, '').replace(/^\w/, (c) => c.toUpperCase()), group: 'run' }))
  for (const h of run.outputs) if (h.file) out.push({ path: h.file, label: `${h.label}${h.task ? ` · ${h.task}` : ''} · ${h.stepId}${h.round ? ` r${h.round}` : ''}`, group: 'handoffs', ...(h.verdict ? { badge: h.verdict } : {}) })
  for (const r of run.workerRuns) {
    if (!r.patch) continue
    const rel = path.relative(dir, r.patch)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) out.push({ path: rel, label: path.basename(rel), group: 'patches' })
  }
  return out
}

/** A path inside a run's folder, or null when it reaches outside it. */
export function runFileOf(rt: WorkspaceRuntime, run: TeamRun, rel: string): string | null {
  const dir = runDirOf(rt, run)
  const file = path.resolve(dir, rel)
  return file.startsWith(dir + path.sep) ? file : null
}

/** The spawn-time settings a worker's session gets for the step it is on. */
export function workerSpec(run: TeamRun, w: Worker) {
  const step = run.recipe.steps.find((s) => s.id === w.stepId)
  const agent = run.agents.find((a) => a.name === w.agent)
  const writes = step?.output === 'change'
  const can = (agent?.can ?? ['read']).filter((c) => writes || c !== 'edit') as AgentCan[]
  const model = run.card.steps.find((c) => c.id === w.stepId)?.model ?? step?.model ?? agent?.model ?? null
  return { step, agent, writes, can, model }
}

/** Carry out the engine's actions, in order. */
export async function applyTeamActions(rt: WorkspaceRuntime, run: TeamRun, actions: TeamAction[]): Promise<void> {
  for (const a of actions) {
    if (a.kind === 'notice') await sessionNotice(rt, run.leadSessionId, a.text)
    else if (a.kind === 'tellLead') await tellSession(rt, run.leadSessionId, a.text)
    else if (a.kind === 'snapshot') {
      const tree = (run.root && (await snapshotTree(run.root))) || undefined
      if (a.scope === 'run') run.runBase = tree
      run.baseTree = tree
    }
    else if (a.kind === 'checks') {
      await teamRunChanged(rt, run)
      const results = await runProjectChecks(run)
      await applyTeamActions(rt, run, checksDone(run, results, Date.now()))
    } else if (a.kind === 'finish') await finishTeamRun(rt, run)
    else if (a.kind === 'tell') {
      const w = workerById(run, a.workerId)
      if (!w) continue
      if (!w.sessionId) {
        const lead = rt.rows.get(run.leadSessionId)
        const { writes, model, agent } = workerSpec(run, w)
        const effort = (agent?.effort ?? null) as EffortLevel | null
        const row = await createSession(rt, `${w.label} · ${run.title}`, lead?.cwd ?? run.root ?? os.homedir(), model, effort, run.card.fast, writes ? 'acceptEdits' : 'gated', { spawn: false, projectId: lead?.projectId ?? null })
        w.sessionId = row.id
        rt.sessionTeam.set(row.id, run.id)
        await linkSessionToItem(rt, row.id, run.itemId, 'dispatch').catch(() => {})
      }
      let text = a.text
      const diff = a.diff ? await handoffDiff(rt, run, a.diff) : null
      if (diff) text += `\n\n${diff.text}`
      if (a.fresh) rt.freshNext.add(w.sessionId)
      // The run starts at the next event: a fresh context's notice, else junior's message.
      const seen = rt.live.get(w.sessionId)?.lastSeq ?? (await rt.store.events.lastSeq(w.sessionId))
      stampRun(run, w.id, { startSeq: seen + 1, at: Date.now(), spendAtStart: run.spend[w.sessionId] ?? 0, ...(diff?.file ? { patch: diff.file } : {}) })
      await tellSession(rt, w.sessionId, text)
    }
  }
  await teamRunChanged(rt, run)
}

/** A message from Junior itself: badged "from Junior" in the transcript, framed as not-the-user for the model. */
async function tellSession(rt: WorkspaceRuntime, sessionId: string, text: string): Promise<void> {
  const live = await getOrRevive(rt, sessionId)
  await live?.sendUserMessage(text, undefined, undefined, { from: 'junior' })
}
