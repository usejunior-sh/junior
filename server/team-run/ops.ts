import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { approve, bookPlanning, cardFrom, type CheckResult, continueGate, editTasks, goalFrom, MAX_RUN_BUDGET_USD, pause as pauseRun, planMessage, recipeFromRun, resume, runSpent, settleRevision, type Action as TeamAction, type TeamRun, turnEnded } from '../../core/teams/engine.js'
import { agentFrom, detectChecks, isLibraryName } from '../teams.js'
import { repoRoot, snapshotTree } from '../git.js'
import { log } from '../log.js'
import { type Mention, mentionToken, type TeamLibraryResponse, type TeamPickerResponse } from '../../shared/protocol.js'
import { parseRecipe, recipeAgents, type RecipeStep, serializeRecipe, taskLoop, type TeamRecipe } from '../../core/teams/recipe.js'
import { requireVeto } from '../providers/capabilities.js'
import { itemImageAttachments } from '../itemImages.js'
import { pExec } from '../config.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { applyTeamActions, indexTeamRun, leadPlanning, runDirOf, saveTeamRuns, schedulePlanSync, sessionNotice, teamRunChanged, teamRunDir, teamRunOf, usd, withTeamRun } from './state.js'
import { errText } from '../errors.js'
import { createManualOp, itemFilesForSession } from '../items-ops.js'
import { linkSessionToItem, projectFor } from '../settings-ops.js'
import { broadcastSessionList } from '../ws/send.js'
import { createSession, getOrRevive } from '../session/sessions.js'
import { currentBrief } from '../brief-run.js'

const CHECK_TIMEOUT_MS = 240_000

/** The project's own typecheck/lint/test: free, and before any checker is paid to find a type error. */
export async function runProjectChecks(run: TeamRun): Promise<CheckResult[]> {
  const cmds = run.root ? await detectChecks(run.root) : []
  run.checkCmds = cmds
  const results: CheckResult[] = []
  for (const cmd of cmds) {
    try {
      await pExec(cmd, { cwd: run.root, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
      results.push({ cmd, ok: true, tail: '' })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'failed'
      results.push({ cmd, ok: false, tail: out.slice(-3000) })
    }
  }
  return results
}

/** The run is over: the plan gets its Outcome, it is the result on the item, and the lead says so. */
export async function finishTeamRun(rt: WorkspaceRuntime, run: TeamRun): Promise<void> {
  if (run.root) run.endTree = (await snapshotTree(run.root)) ?? undefined
  await schedulePlanSync(rt, run, true)
  await sessionNotice(rt, run.leadSessionId, run.goal ? `Goal done · ${usd(runSpent(run))}. Accept the result, or say what's missing.` : `Team done${run.unresolved ? ' — with something unresolved' : ''} · ${usd(runSpent(run))}. The outcome is in the run folder's plan.md.`)
  log('info', 'teams', `run done at ${usd(runSpent(run))}`, { teamId: run.id, workspace: rt.meta.id })
}

/**
 * A team session's turn ended: book its cost, pause the run past its budget (or
 * when the SDK already stopped the turn at its backstop), then let the engine act.
 */
export async function noteTeamSpend(rt: WorkspaceRuntime, sessionId: string, delta: number, overBudget = false): Promise<void> {
  const run = teamRunOf(rt, sessionId)
  if (!run) return
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') return
    run.spend[sessionId] = (run.spend[sessionId] ?? 0) + delta
    run.rev += 1
    const spent = runSpent(run)
    // The lead's verdict or unstick waits for its turn to end, like a handoff: triage never messages a
    // session mid-turn. Paused meanwhile (by you, or the budget), it waits for your resume instead.
    const decided = sessionId === run.leadSessionId ? rt.goalDecisions.get(run.id) : undefined
    const over = run.state === 'running' && (spent >= run.budgetUsd || overBudget)
    // Past the budget a "met" still closes the goal, it spends nothing more.
    if (decided && run.state === 'running' && (!over || closes(run, decided))) {
      rt.goalDecisions.delete(run.id)
      try {
        return await applyTeamActions(rt, run, decided(run))
      } catch (err) {
        log('warn', 'teams', `goal decision no longer applies: ${errText(err)}`, { teamId: run.id, workspace: rt.meta.id })
      }
    }
    if (over) {
      await pauseTeamRunNow(rt, run, `budget reached — ${usd(spent)} of ${usd(run.budgetUsd)}`)
      return
    }
    await applyTeamActions(rt, run, turnEnded(run, sessionId))
  })
}

/** Would this goal decision close the goal? Tried on a copy. */
function closes(run: TeamRun, decide: (r: TeamRun) => TeamAction[]): boolean {
  const probe = structuredClone(run)
  try {
    decide(probe)
  } catch {
    return false
  }
  return probe.state === 'done'
}

/** Stop every worker mid-turn and hold the run until it's resumed. The lead's chat is left alone. */
export async function pauseTeamRunNow(rt: WorkspaceRuntime, run: TeamRun, reason: string): Promise<void> {
  pauseRun(run, reason)
  for (const w of run.workers) {
    if (!w.sessionId || w.sessionId === run.leadSessionId) continue
    const live = rt.live.get(w.sessionId)
    if (!live) continue
    await live.interrupt()
    live.stop()
  }
  await teamRunChanged(rt, run)
  await sessionNotice(rt, run.leadSessionId, `${run.goal ? 'Goal' : 'Team'} paused: ${reason}.${reason.startsWith('budget') ? ' Only you can raise the budget and resume it.' : ''}`)
  log('info', 'teams', `run paused: ${reason}`, { teamId: run.id, workspace: rt.meta.id })
}

export function teamRunFrom(rt: WorkspaceRuntime, raw: unknown): TeamRun {
  const id = (raw as { runId?: unknown })?.runId
  const run = typeof id === 'string' ? rt.teamRuns.get(id) : undefined
  if (!run) throw new Error('no such team run')
  return run
}

export async function teamLibraryOp(rt: WorkspaceRuntime): Promise<TeamLibraryResponse & { ok: true }> {
  return { ok: true, ...(await rt.teamLibrary.list()), dir: rt.teamLibrary.root }
}

/** Create or update one agent file (Settings → Teams → Agents). */
export async function saveAgentOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const spec = agentFrom(r.agent)
  const lib = rt.teamLibrary
  const existing = isLibraryName(r.name) && (await lib.readAgent(r.name)) ? r.name : null
  const name = existing ?? (await lib.freeName('agent', spec.label))
  await lib.writeAgent({ ...spec, name })
  return name
}

/** What the lead sees when it picks or drafts a team. */
export async function listTeamsOp(rt: WorkspaceRuntime) {
  const { teams, agents } = await rt.teamLibrary.list()
  return {
    teams: teams
      .filter((t) => t.recipe && !t.missing.length)
      .map((t) => ({
        team: t.name,
        label: t.recipe!.label,
        description: t.recipe!.description,
        useFor: t.recipe!.useFor,
        budgetUsd: t.recipe!.budgetUsd,
        steps: t.recipe!.steps.map((s) => ({
          id: s.id,
          agent: s.agent,
          output: s.output,
          ...(s.fanOut ? { fanOut: s.fanOut } : {}),
          ...(s.onFail ? { onFail: s.onFail } : {}),
          ...(s.gate ? { gate: s.gate } : {}),
          ...(s.does ? { does: s.does } : {}),
        })),
        advice: t.recipe!.advice,
      })),
    agents: agents.map((a) => ({ agent: a.name, label: a.label, description: a.description, can: a.can, model: a.model })),
  }
}

/** A recipe the lead drafted for this run: checked by the same parser a team file goes through. */
function draftedRecipe(raw: unknown, known: Set<string>): TeamRecipe {
  const r = (raw ?? {}) as Record<string, unknown>
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>
    const fan = (s.fanOut ?? null) as { by?: unknown; max?: unknown } | null
    const fail = (s.onFail ?? null) as { backTo?: unknown; max?: unknown } | null
    return {
      id: String(s.id ?? ''),
      agent: String(s.agent ?? ''),
      output: (typeof s.output === 'string' ? s.output : null) as RecipeStep['output'],
      does: typeof s.does === 'string' ? s.does : '',
      fanOut: fan ? { by: String(fan.by ?? ''), max: Number(fan.max) } : null,
      onFail: fail ? { backTo: String(fail.backTo ?? ''), max: Number(fail.max) } : null,
      gate: s.gate === 'you' ? ('you' as const) : null,
      model: typeof s.model === 'string' && s.model ? s.model : null,
      forEach: s.forEach === 'task' ? ('task' as const) : null,
      context: s.context === 'fresh' || s.context === 'carry' ? (s.context as 'fresh' | 'carry') : null,
    }
  })
  const recipe: TeamRecipe = {
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : 'Custom',
    description: typeof r.description === 'string' ? r.description.trim().slice(0, 400) : '',
    useFor: [],
    budgetUsd: typeof r.budgetUsd === 'number' && r.budgetUsd > 0 ? r.budgetUsd : 5,
    // A drafted team never decides how much it may do unasked, or what speed you pay for: you pick on the card.
    permissions: null,
    fast: null,
    lead: { model: null, effort: null },
    done: typeof r.done === 'string' ? r.done.trim() : '',
    steps,
    advice: '',
  }
  const parsed = parseRecipe('draft', serializeRecipe(recipe, 'draft'))
  if (!parsed.recipe) throw new Error(`the drafted team doesn't hold together: ${parsed.errors.join('; ')}`)
  const missing = recipeAgents(parsed.recipe).filter((a) => !known.has(a))
  if (missing.length) throw new Error(`no agent file named ${missing.join(', ')} — use list_teams to see the agents there are`)
  return parsed.recipe
}

/**
 * The lead proposes a team: a saved team or one it drafted, plus the card. The
 * run waits, proposed, until you approve. A session with no work item gets one,
 * the result, "needs you" and the cost all land on an item.
 */
export async function proposeTeamOp(rt: WorkspaceRuntime, sessionId: string, raw: unknown): Promise<TeamRun> {
  const r = (raw ?? {}) as Record<string, unknown>
  const lead = rt.rows.get(sessionId)
  if (!lead) throw new Error('no such session')
  requireVeto(rt.provider, 'team')
  const existing = teamRunOf(rt, sessionId)
  if (existing && existing.leadSessionId !== sessionId) throw new Error('this session is a worker on a team — only a lead proposes one')
  if (existing && existing.state !== 'proposed' && existing.state !== 'done' && existing.state !== 'stopped') {
    throw new Error(`this session already leads a ${existing.state} team run — stop it before proposing another`)
  }
  const lib = rt.teamLibrary
  const { teams, agents } = await lib.list()
  let recipe: TeamRecipe
  let team: string | null = null
  if (typeof r.team === 'string' && r.team) {
    const entry = teams.find((t) => t.name === r.team)
    if (!entry) throw new Error(`no team named "${r.team}" — call list_teams`)
    if (!entry.recipe) throw new Error(`teams/${entry.name}.md has errors: ${entry.errors.join('; ')}`)
    if (entry.missing.length) throw new Error(`teams/${entry.name}.md names agents with no file: ${entry.missing.join(', ')}`)
    recipe = entry.recipe
    team = entry.name
  } else if (r.recipe) recipe = draftedRecipe(r.recipe, new Set(agents.map((a) => a.name)))
  else throw new Error('give either team (a saved team\'s name) or recipe (a drafted one)')
  // How much the team may do unasked is yours to pick on the card, never the lead's.
  const card = cardFrom({ ...((r.card ?? {}) as object), permissions: undefined, fast: undefined }, recipe, existing?.state === 'proposed' ? existing.card : undefined)
  const kept = existing?.state === 'proposed' ? existing.goal ?? null : null
  // A goal: the lead's, or the one already on the card (proposing again keeps it).
  const goal = r.goal ? goalFrom(r.goal, Date.now(), kept) : kept

  let itemId = rt.sessionItem.get(sessionId) ?? null
  if (!itemId || !(await rt.store.items.get(itemId))) {
    const title = (typeof r.title === 'string' && r.title.trim() ? r.title.trim() : card.goal).slice(0, 120)
    itemId = await createManualOp(rt, { title, description: card.goal })
    await linkSessionToItem(rt, sessionId, itemId, 'dispatch')
  }
  const item = await rt.store.items.get(itemId)
  const root = (await repoRoot(lead.cwd)) ?? lead.cwd
  const used = new Set(recipeAgents(recipe))
  const id = existing?.state === 'proposed' ? existing.id : randomUUID()
  const run: TeamRun = {
    id,
    itemId,
    title: (item?.title ?? card.goal).slice(0, 80),
    createdAt: existing?.state === 'proposed' ? existing.createdAt : Date.now(),
    team,
    recipe,
    card,
    agents: agents.filter((a) => used.has(a.name)).map((a) => ({ name: a.name, label: a.label, color: a.color, model: a.model, effort: a.effort, prompt: a.prompt, can: a.can })),
    leadSessionId: sessionId,
    state: 'proposed',
    step: 0,
    splitting: false,
    round: 0,
    task: null,
    tasks: {},
    workers: [],
    workerRuns: [],
    ledger: [],
    findingState: {},
    awaiting: [],
    submitted: [],
    outputs: [],
    notes: [],
    revision: null,
    feedback: null,
    unresolved: null,
    spend: {},
    budgetUsd: card.budgetUsd,
    rev: (existing?.rev ?? 0) + 1,
    nudged: [],
    root,
    dir: teamRunDir(rt, id, root),
    goal,
    resumes: [],
    ...(existing?.state === 'proposed' && existing.planArtifactId ? { planArtifactId: existing.planArtifactId } : {}),
  }
  // What the lead spent getting here is the run's too. The turn it's in now books itself when it ends.
  bookPlanning(run, await leadPlanning(rt, sessionId))
  if (existing && existing.id !== run.id) rt.teamRuns.delete(existing.id)
  rt.teamRuns.set(run.id, run)
  indexTeamRun(rt, run)
  await teamRunChanged(rt, run)
  log('info', 'teams', `${goal ? 'goal' : 'team'} proposed: ${recipe.label} for ${run.title}`, { teamId: run.id, workspace: rt.meta.id })
  return run
}

/** A proposed card's goal, from your edit: an object sets it, null makes it a plain team run. */
function goalEdit(run: TeamRun, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || !('goal' in raw)) return
  const g = (raw as { goal?: unknown }).goal
  run.goal = g === null ? null : goalFrom(g, Date.now(), run.goal)
}

/** Your edit to a proposed card (before approving). */
export async function editTeamCardOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  if (run.state !== 'proposed') throw new Error('only a proposed card can be edited')
  if ((raw as { card?: unknown }).card) run.card = cardFrom((raw as { card?: unknown }).card, run.recipe, run.card)
  goalEdit(run, raw)
  run.budgetUsd = run.card.budgetUsd
  run.rev += 1
  await teamRunChanged(rt, run)
}

/**
 * Your edit to a running plan, from the drawer: the tasks still to do, and the
 * decisions. Tasks land between tasks: the loop reads the list fresh each time.
 */
export async function editPlanOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  const r = raw as { tasks?: unknown; decisions?: unknown }
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') throw new Error(`the run is ${run.state}`)
    if (r.tasks !== undefined) {
      if (run.state === 'proposed') run.card = cardFrom({ ...run.card, tasks: r.tasks }, run.recipe, run.card)
      else editTasks(run, r.tasks)
    }
    if (Array.isArray(r.decisions)) {
      run.card.decisions = r.decisions.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20)
    }
    run.rev += 1
    await teamRunChanged(rt, run)
  })
}

export async function settleRevisionOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, () => applyTeamActions(rt, run, settleRevision(run, (raw as { accept?: unknown }).accept === true)))
}

/**
 * Fast mode for the whole team, any time: the card says it for workers still to
 * come, and every worker session already running switches now.
 */
export async function setTeamFastOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  const fast = (raw as { fast?: unknown }).fast === true
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') throw new Error(`the run is ${run.state}`)
    run.card.fast = fast
    run.rev += 1
    for (const sid of new Set(run.workers.map((w) => w.sessionId))) {
      if (!sid || sid === run.leadSessionId) continue
      const row = rt.rows.get(sid)
      if (!row || row.fastMode === fast) continue
      row.fastMode = fast
      await rt.store.sessions.setFastMode(sid, fast)
      await rt.live.get(sid)?.setFastMode(fast)
    }
    await teamRunChanged(rt, run)
  })
}

export async function approveTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, async () => {
    requireVeto(rt.provider, 'team')
    const card = (raw as { card?: unknown }).card ? cardFrom((raw as { card?: unknown }).card, run.recipe, run.card) : run.card
    if (run.state !== 'proposed') throw new Error(`the run is ${run.state}, not waiting for approval`)
    if (!card.permissions) throw new Error('pick what the team may do without asking before it runs')
    goalEdit(run, raw)
    log('info', 'teams', `${run.goal ? 'goal' : 'team'} approved: ${run.recipe.label}`, { teamId: run.id, workspace: rt.meta.id })
    // The checks as they stand before anyone touches the code: a failure already there is nobody's regression.
    if (run.root) {
      await sessionNotice(rt, run.leadSessionId, 'Running the project’s checks before the team starts…')
      run.baseline = { results: await runProjectChecks(run), at: Date.now() }
    }
    await applyTeamActions(rt, run, approve(run, card))
  })
}

export async function discardTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  if (run.state !== 'proposed') throw new Error('only a proposed run can be discarded — stop a running one')
  rt.teamRuns.delete(run.id)
  rt.sessionTeam.delete(run.leadSessionId)
  if (run.planArtifactId) await rt.artifacts.remove(run.planArtifactId).catch(() => {})
  // A card never approved leaves nothing behind: its folder only ever held the proposed plan.
  await rm(runDirOf(rt, run), { recursive: true, force: true }).catch(() => {})
  await saveTeamRuns(rt)
  broadcastSessionList(rt)
  await sessionNotice(rt, run.leadSessionId, 'Team card discarded.')
}

export async function resumeTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, async () => {
    requireVeto(rt.provider, 'team')
    if (run.state === 'gate') return applyTeamActions(rt, run, continueGate(run, Date.now()))
    const spent = runSpent(run)
    const addUsd = Number((raw as { addUsd?: unknown }).addUsd)
    // Resume always leaves room to work: at least the requested amount above what's spent.
    const add = Number.isFinite(addUsd) && addUsd > 0 ? Math.min(addUsd, MAX_RUN_BUDGET_USD) : Math.max(2, Math.round(run.budgetUsd * 0.5))
    const before = run.budgetUsd
    // You named an amount: it goes on top. Otherwise only a spent budget grows, by the default step.
    if (spent >= run.budgetUsd || (Number.isFinite(addUsd) && addUsd > 0)) run.budgetUsd = Math.round((Math.max(spent, run.budgetUsd) + add) * 100) / 100
    // Workers respawn on their next message, with the new remaining budget as their backstop.
    for (const w of run.workers) if (w.sessionId && w.sessionId !== run.leadSessionId) rt.live.get(w.sessionId)?.stop()
    const raised = run.budgetUsd > before
    await sessionNotice(rt, run.leadSessionId, `${run.goal ? 'Goal' : 'Team'} resumed by you — budget ${usd(run.budgetUsd)} (${usd(spent)} spent).`)
    const actions = resume(run, Date.now(), raised ? `raised the budget from ${usd(before)} to ${usd(run.budgetUsd)} and resumed` : 'resumed after a pause')
    // A verdict or unstick the lead gave just before the pause: carry it out now, instead of asking again.
    const decided = rt.goalDecisions.get(run.id)
    if (decided && run.state === 'running') {
      rt.goalDecisions.delete(run.id)
      try {
        return await applyTeamActions(rt, run, decided(run))
      } catch (err) {
        log('warn', 'teams', `goal decision no longer applies: ${errText(err)}`, { teamId: run.id, workspace: rt.meta.id })
      }
    }
    await applyTeamActions(rt, run, actions)
  })
}

export async function stopTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  await withTeamRun(rt, run, async () => {
    if (run.state === 'done' || run.state === 'stopped') return
    for (const w of run.workers) {
      if (!w.sessionId || w.sessionId === run.leadSessionId) continue
      const live = rt.live.get(w.sessionId)
      if (!live) continue
      await live.interrupt()
      live.stop()
    }
    run.state = 'stopped'
    rt.goalDecisions.delete(run.id)
    if (run.root) run.endTree = (await snapshotTree(run.root)) ?? undefined
    run.awaiting = []
    run.rev += 1
    await teamRunChanged(rt, run)
    await sessionNotice(rt, run.leadSessionId, `Team stopped at ${usd(runSpent(run))}.`)
  })
}

/** Save as team: the run's recipe, with your card's models and widths, as a new team file. */
export async function saveRunAsTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const run = teamRunFrom(rt, raw)
  const label = String((raw as { label?: unknown }).label ?? '').trim().slice(0, 60)
  if (!label) throw new Error('the team needs a name')
  const name = await rt.teamLibrary.freeName('team', label)
  await rt.teamLibrary.writeRecipe(name, recipeFromRun(run, label))
  log('info', 'teams', `team saved from a run: ${label}`, { team: name, teamId: run.id, workspace: rt.meta.id })
  return name
}

/**
 * The dispatch picker: open a lead session on the item, in its project, told to
 * plan with the chosen team (or to pick/draft one). Nothing runs until you
 * approve the card it proposes.
 */
export async function planTeamOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const r = (raw ?? {}) as Record<string, unknown>
  const item = await rt.store.items.get(typeof r.itemId === 'string' ? r.itemId : '')
  if (!item) throw new Error('no such work item')
  const project = await projectFor(rt, item)
  if (!project) throw new Error('this item has no project — set one on the item so the team knows which folder to work in')
  const entry = typeof r.team === 'string' && r.team ? (await rt.teamLibrary.list()).teams.find((t) => t.name === r.team) : null
  if (r.team && !entry?.recipe) throw new Error(entry ? `teams/${entry.name}.md has errors: ${entry.errors.join('; ')}` : `no team named "${r.team}"`)
  const recipe = entry?.recipe ?? null
  const row = await createSession(rt, `${recipe?.label ?? 'Team'} · ${item.title}`.slice(0, 80), project.path, recipe?.lead.model ?? null, recipe?.lead.effort ?? null, false, null, { spawn: false, projectId: project.id })
  await linkSessionToItem(rt, row.id, item.id, 'dispatch')
  const live = await getOrRevive(rt, row.id)
  if (!live) throw new Error('could not start the lead session')
  const brief = await currentBrief(rt, item.id)
  const mentions: Mention[] = [{ kind: 'item', ref: item.id, label: item.title }]
  if (brief) mentions.push({ kind: 'artifact', ref: brief.artifact.id, label: brief.artifact.title })
  const images = await itemImageAttachments(rt.attachmentsDir, item.id, item.images)
  const text = planMessage({ team: entry && recipe ? { name: entry.name, label: recipe.label, tasks: !!taskLoop(recipe) } : null, itemTitle: item.title })
  const { files, note: missingNote } = await itemFilesForSession(rt, row.id, item)
  await live.sendUserMessage(`${text}\n\n${mentions.map(mentionToken).join(' ')}${missingNote ? `\n\n${missingNote}` : ''}`, images, mentions, files.length ? { files } : {})
  log('info', 'teams', `team planning: ${recipe?.label ?? 'pick or draft'} for ${item.title}`, { itemId: item.id, workspace: rt.meta.id })
  return row.id
}

/** Which team the picker suggests for an item kind, and what each team has really cost. */
export async function teamPickerOp(rt: WorkspaceRuntime, kind: string): Promise<TeamPickerResponse & { ok: true }> {
  const { teams } = await rt.teamLibrary.list()
  const usable = teams.filter((t) => t.recipe && !t.missing.length)
  const costs = new Map<string, number[]>()
  for (const run of rt.teamRuns.values()) {
    if (run.state !== 'done' || !run.team) continue
    costs.set(run.team, [...(costs.get(run.team) ?? []), runSpent(run)])
  }
  const options = usable.map((t) => {
    const c = costs.get(t.name) ?? []
    return {
      team: t.name,
      label: t.recipe!.label,
      description: t.recipe!.description,
      steps: t.recipe!.steps.map((s) => (s.fanOut ? `${s.id} ×${s.fanOut.max}` : s.id)),
      budgetUsd: t.recipe!.budgetUsd,
      runs: c.length,
      ...(c.length ? { avgUsd: Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 100) / 100 } : {}),
    }
  })
  const suggested = usable.find((t) => t.recipe!.useFor.includes(kind))?.name ?? (usable.some((t) => t.name === 'solo') ? 'solo' : null)
  return { ok: true, suggested, options }
}
