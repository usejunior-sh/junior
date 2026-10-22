import path from 'node:path'
import { statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { backfillRuns, bookPlanning, checksDone, normalizeRun, runSpent, sessionSpend, stampRun, STEP_MESSAGE, type Action as TeamAction, type TeamRun, type Worker, workerById } from '../../core/teams/engine.js'
import { log } from '../log.js'
import type { AgentCan, EffortLevel, SessionEvent, SessionTeamRun, TeamRunFolderFile, TeamRunView } from '../../shared/protocol.js'
import { LEAD } from '../../core/teams/recipe.js'
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
const TEAM_RUNS_KEY = 'team_runs'

export async function saveTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  await rt.store.config.set(TEAM_RUNS_KEY, [...rt.teamRuns.values()])
}

/** Boot: mirror stored runs into memory. Runs from before recipes (no `recipe`) are dropped. */
export async function loadTeamRuns(rt: WorkspaceRuntime): Promise<void> {
  let backfilled = false
  for (const run of (await rt.store.config.get<TeamRun[]>(TEAM_RUNS_KEY)) ?? []) {
    if (!run || !(run as Partial<TeamRun>).recipe || !rt.rows.has(run.leadSessionId)) continue
    for (const w of run.workers) if (w.sessionId && !rt.rows.has(w.sessionId)) w.sessionId = null
    const unrecorded = !(run as Partial<TeamRun>).workerRuns
    rt.teamRuns.set(run.id, normalizeRun(run))
    indexTeamRun(rt, run)
    if (unrecorded && run.outputs.length) {
      await backfillTeamRuns(rt, run).catch((err) => log('warn', 'teams', `could not backfill runs: ${err}`, { teamId: run.id, workspace: rt.meta.id }))
      backfilled = true
    }
    // A run proposed before planning was booked. Only once it's over, so a live
    // run's budget doesn't move under it.
    if (run.planningUsd === undefined && (run.state === 'done' || run.state === 'stopped')) {
      await leadPlanning(rt, run.leadSessionId, run.createdAt).then(
        (usd) => bookPlanning(run, usd),
        (err) => log('warn', 'teams', `could not book planning: ${err}`, { teamId: run.id, workspace: rt.meta.id }),
      )
      backfilled = true
    }
  }
  if (backfilled) await saveTeamRuns(rt)
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

/** session id → run id, for the lead and every worker session. */
export function indexTeamRun(rt: WorkspaceRuntime, run: TeamRun): void {
  rt.sessionTeam.set(run.leadSessionId, run.id)
  for (const w of run.workers) if (w.sessionId) rt.sessionTeam.set(w.sessionId, run.id)
}

export const teamRunOf = (rt: WorkspaceRuntime, sessionId: string): TeamRun | undefined => {
  const id = rt.sessionTeam.get(sessionId)
  return id ? rt.teamRuns.get(id) : undefined
}

/** A session's place on a run, as the wire carries it. */
export function teamRunLink(rt: WorkspaceRuntime, sessionId: string): SessionTeamRun | undefined {
  const run = teamRunOf(rt, sessionId)
  if (!run) return undefined
  const lead = run.leadSessionId === sessionId
  const w = [...run.workers].reverse().find((x) => x.sessionId === sessionId && x.agent !== LEAD)
  return { id: run.id, role: lead ? 'lead' : 'worker', label: lead ? 'Lead' : w?.label ?? 'Worker', state: run.state, rev: run.rev, ...(run.goal ? { goal: true } : {}) }
}

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
  await saveTeamRuns(rt)
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
