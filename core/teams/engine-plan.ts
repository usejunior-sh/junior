import { type RecipeStep, type TeamRecipe, taskLoop, CHECKS, isTeamPermissions, LEAD } from './recipe.js'
import type { CardStep, Finding, GoalHorizonKind, Handoff, PlanTask, ResumeBy, RunGoal, RunGoalHorizon, Slice, TaskStatus, TeamCard, TeamRun, Worker } from './engine-types.js'

export const runSpent = (run: TeamRun): number => Object.values(run.spend).reduce((a, b) => a + b, 0)
export const currentStep = (run: TeamRun): RecipeStep | undefined => run.recipe.steps[run.step]
export const workerById = (run: TeamRun, id: string): Worker | undefined => run.workers.find((w) => w.id === id)
export const currentTask = (run: TeamRun): PlanTask | undefined => (run.task === null ? undefined : run.card.tasks[run.task])
export const changeIndex = (r: TeamRecipe) => r.steps.findIndex((s) => s.output === 'change')
/** Cut at a word, and say so. A note that stops mid-word reads as a bug. */
export const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, s.lastIndexOf(' ', max - 1) > max * 0.6 ? s.lastIndexOf(' ', max - 1) : max - 1)}…`)
export const bump = (run: TeamRun) => {
  run.rev += 1
}

/** A resume goes on the run's list and on the ledger, with who did it and why. */
export function recordResume(run: TeamRun, by: ResumeBy, what: string, why: string, at: number): void {
  const task = run.task !== null ? currentTask(run)?.id ?? null : null
  ;(run.resumes ??= []).push({ at, by, what, why })
  run.ledger.push({ kind: 'resume', task, by: by === 'junior' ? 'Junior' : 'you', text: what, ...(why ? { why } : {}), at })
  bump(run)
}

/** Runs stored before tasks and plans existed get today's empty defaults. */
export function normalizeRun(run: TeamRun): TeamRun {
  run.card.tasks ??= []
  run.card.decisions ??= []
  // Runs from before the choice existed ran as `ask` does now.
  run.card.permissions ??= run.state === 'proposed' ? null : 'ask'
  run.recipe.permissions ??= null
  run.recipe.fast ??= null
  run.card.fast ??= false
  run.task ??= null
  run.tasks ??= {}
  run.notes ??= []
  run.revision ??= null
  run.workerRuns ??= []
  run.ledger ??= run.notes.map((n) => ({ kind: 'note' as const, task: n.task, by: n.by, text: n.text }))
  run.findingState ??= {}
  run.goal ??= null
  run.resumes ??= []
  if (run.goal) {
    run.goal.verdicts ??= []
    run.goal.questions ??= []
    run.goal.acceptedAt ??= null
  }
  for (const s of run.recipe.steps) {
    s.forEach ??= null
    s.context ??= null
  }
  return run
}

export const MAX_CRITERIA = 8
export const MAX_TASKS = 8
export const MAX_RUN_BUDGET_USD = 500

export const strList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, max)

/** Does this fan-out step take its slices from the lead? (Not `by: finding`, not a reuse of the step before.) */
export function leadSlices(recipe: TeamRecipe, i: number): boolean {
  const s = recipe.steps[i]
  if (!s?.fanOut || s.fanOut.by === 'finding') return false
  const prev = recipe.steps[i - 1]
  return !(prev?.fanOut && prev.fanOut.by === s.fanOut.by)
}

/**
 * Tasks from the lead's call or your edit. Ids survive edits (a task you
 * retitled keeps its place in the run); new tasks get the next free id.
 */
export function tasksFrom(raw: unknown, recipe: TeamRecipe, prev: PlanTask[] = []): PlanTask[] {
  const list = (Array.isArray(raw) ? raw : []).map((x) => (x ?? {}) as Record<string, unknown>)
  if (!taskLoop(recipe)) {
    if (list.length > 1) throw new Error(`the ${recipe.label} team has no task loop — put the work in one card, or pick a team that runs tasks (Build)`)
    return []
  }
  if (list.length > MAX_TASKS) throw new Error(`a plan has at most ${MAX_TASKS} tasks — fold small ones together`)
  let next = Math.max(0, ...prev.map((t) => Number(t.id.slice(1)) || 0))
  const taken = new Set<string>()
  return list
    .map((x) => {
      const title = typeof x.title === 'string' ? x.title.trim().slice(0, 160) : ''
      const known = typeof x.id === 'string' && prev.some((t) => t.id === x.id) && !taken.has(x.id) ? x.id : null
      const id = known ?? `T${++next}`
      taken.add(id)
      return { id, title, criteria: strList(x.criteria, 6) }
    })
    .filter((t) => t.title)
}

/** A card from the lead's tool call or your edit, checked against the recipe. Throws a message the lead can act on. */
export function cardFrom(raw: unknown, recipe: TeamRecipe, prev?: TeamCard): TeamCard {
  const r = (raw ?? {}) as Record<string, unknown>
  const goal = typeof r.goal === 'string' ? r.goal.trim().slice(0, 1000) : ''
  if (!goal) throw new Error('the card needs a goal')
  const criteria = strList(r.criteria, MAX_CRITERIA)
  if (!criteria.length) throw new Error('the card needs at least one acceptance criterion')
  const given = new Map<string, Record<string, unknown>>()
  for (const s of Array.isArray(r.steps) ? r.steps : []) {
    const o = (s ?? {}) as Record<string, unknown>
    if (typeof o.id !== 'string') continue
    if (!recipe.steps.some((x) => x.id === o.id)) throw new Error(`the recipe has no step "${o.id}" — its steps are ${recipe.steps.map((x) => x.id).join(', ')}`)
    given.set(o.id, o)
  }
  const steps: CardStep[] = recipe.steps.map((s, i) => {
    const o = given.get(s.id) ?? {}
    const model = typeof o.model === 'string' && o.model.trim() && o.model.trim() !== 'default' ? o.model.trim().slice(0, 80) : null
    let slices: Slice[] | null = null
    if (Array.isArray(o.slices) && o.slices.length) {
      if (!leadSlices(recipe, i)) throw new Error(`step "${s.id}" takes no slices — ${s.fanOut ? 'triage splits it itself' : 'it has no fan-out'}`)
      slices = o.slices
        .map((x) => (x ?? {}) as Record<string, unknown>)
        .map((x) => ({ title: typeof x.title === 'string' ? x.title.trim().slice(0, 80) : '', brief: typeof x.brief === 'string' ? x.brief.trim().slice(0, 4000) : '' }))
        .filter((x) => x.title)
      if (slices.length > s.fanOut!.max) throw new Error(`step "${s.id}" fans out to at most ${s.fanOut!.max}`)
      if (!slices.length) slices = null
    }
    return { id: s.id, model: s.agent === CHECKS ? null : model, slices }
  })
  let tasks = tasksFrom(r.tasks, recipe, prev?.tasks)
  // A team with a loop and no tasks given: the whole card is the one task.
  if (taskLoop(recipe) && !tasks.length) tasks = [{ id: 'T1', title: goal.slice(0, 160), criteria: [] }]
  const b = typeof r.budgetUsd === 'number' ? r.budgetUsd : typeof r.budgetUsd === 'string' ? Number(r.budgetUsd) : NaN
  return {
    goal,
    criteria,
    outOfScope: strList(r.outOfScope, MAX_CRITERIA),
    tasks,
    decisions: strList(r.decisions, 20),
    steps,
    budgetUsd: Number.isFinite(b) && b > 0 ? Math.min(Math.round(b * 100) / 100, MAX_RUN_BUDGET_USD) : recipe.budgetUsd,
    permissions: isTeamPermissions(r.permissions) ? r.permissions : prev?.permissions ?? recipe.permissions ?? null,
    fast: typeof r.fast === 'boolean' ? r.fast : prev?.fast ?? recipe.fast ?? false,
    note: typeof r.note === 'string' ? r.note.trim().slice(0, 2000) : '',
  }
}

/** The last moment of the local day `at` falls in. */
export function endOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

/** A date from the lead or the card: `YYYY-MM-DD` is that local day; anything else Date.parse reads. */
function dateFrom(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return NaN
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(v)
}

/**
 * The goal part of a card, from the lead's propose_team or your edit. `now`
 * pins "today" to the day it was set. Throws a message the lead can act on.
 */
export function goalFrom(raw: unknown, now: number, prev?: RunGoal | null): RunGoal {
  const r = (raw ?? {}) as Record<string, unknown>
  const doneWhen = typeof r.doneWhen === 'string' ? r.doneWhen.trim().slice(0, 1000) : prev?.doneWhen ?? ''
  if (!doneWhen) throw new Error('a goal needs a done-when: the outcome that says it is finished, in a sentence')
  const kind: GoalHorizonKind = r.horizon === 'today' || r.horizon === 'by' || r.horizon === 'until_done' ? r.horizon : prev?.horizon.kind ?? 'until_done'
  let at: number | null = null
  if (kind === 'today') at = prev?.horizon.kind === 'today' && r.horizon === undefined ? prev.horizon.at : endOfDay(now)
  if (kind === 'by') {
    const given = r.by !== undefined ? dateFrom(r.by) : prev?.horizon.at ?? NaN
    if (!Number.isFinite(given)) throw new Error('a "by" horizon needs a date, e.g. "2026-10-24"')
    at = endOfDay(given)
  }
  return {
    doneWhen,
    horizon: { kind, at },
    round: 0,
    gap: null,
    owes: null,
    stuck: null,
    wait: null,
    verdicts: [],
    questions: [],
    acceptedAt: null,
  }
}

/** The horizon in words: "today", "by Fri 24 Oct", "until done". */
export function horizonText(h: RunGoalHorizon): string {
  if (h.kind === 'until_done' || h.at === null) return 'until done'
  if (h.kind === 'today') return 'today'
  return `by ${new Date(h.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`
}

/** Past its horizon and not done. */
export const goalOverdue = (run: Pick<TeamRun, 'goal' | 'state'>, now: number): boolean =>
  !!run.goal && run.goal.horizon.at !== null && now > run.goal.horizon.at && run.state !== 'done' && run.state !== 'stopped'

/**
 * A new task list for a running plan, your drawer edit, or the lead's revision
 * you accepted. Tasks already started stay exactly where they are; only what is
 * still to do can change. Applied between tasks: the loop reads the list fresh
 * each time it starts one.
 */
export function editTasks(run: TeamRun, raw: unknown): PlanTask[] {
  const next = tasksFrom(raw, run.recipe, run.card.tasks)
  const started = run.card.tasks.filter((t) => (run.tasks[t.id]?.status ?? 'todo') !== 'todo')
  for (const [i, t] of started.entries()) {
    if (next[i]?.id !== t.id) throw new Error(`${t.id} has already started — only tasks still to do can be changed or reordered`)
    next[i] = t
  }
  if (!next.length) throw new Error('the plan needs at least one task')
  run.card.tasks = next
  bump(run)
  return next
}

/** The recipe a run would save as a team file: its steps with the card's model choices and fan-out widths. */
export function recipeFromRun(run: TeamRun, label: string): TeamRecipe {
  return {
    ...run.recipe,
    label,
    steps: run.recipe.steps.map((s) => {
      const c = run.card.steps.find((x) => x.id === s.id)
      const width = c?.slices?.length
      return {
        ...s,
        model: c?.model ?? s.model,
        fanOut: s.fanOut && width && width > 1 ? { ...s.fanOut, max: Math.max(width, 2) } : s.fanOut,
      }
    }),
    budgetUsd: run.card.budgetUsd,
  }
}

export const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')
const TASK_MARK: Record<TaskStatus, string> = { todo: '[ ]', running: '[~]', done: '[x]', unresolved: '[!]' }

export function renderCard(c: TeamCard): string {
  return [
    `## Goal\n${c.goal}`,
    `## Acceptance criteria\n${bullet(c.criteria)}`,
    c.outOfScope.length ? `## Out of scope\n${bullet(c.outOfScope)}` : '',
    c.decisions.length ? `## Decisions\n${bullet(c.decisions)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The task list, one line each, what every agent in the loop sees of the plan. */
export function renderTaskList(run: TeamRun, mark?: string): string {
  return run.card.tasks
    .map((t) => {
      const st = run.tasks[t.id]?.status ?? 'todo'
      return `- ${TASK_MARK[st]} ${t.id} ${t.title}${t.id === mark ? '   ← yours' : ''}${st === 'unresolved' && run.tasks[t.id]?.why ? ` — unresolved: ${run.tasks[t.id].why}` : ''}`
    })
    .join('\n')
}

export const inLoop = (run: TeamRun, i: number) => !!run.recipe.steps[i]?.forEach

export function workersFor(run: TeamRun, i: number, slices: (Slice | null)[], sessions: (string | null)[] = []): Worker[] {
  const s = run.recipe.steps[i]
  const agent = run.agents.find((a) => a.name === s.agent)
  const base = s.agent === LEAD ? 'Lead' : agent?.label ?? s.agent
  const task = inLoop(run, i) ? currentTask(run)?.id : undefined
  return slices.map((slice, n) => {
    const id = task ? `${s.id}:${task}:${n + 1}` : `${s.id}:${n + 1}`
    const existing = workerById(run, id)
    // In the loop, every task's worker for a step reuses that step's session, one Implementer
    // tab, not one per task; a fresh context per task is a fresh start, not a new session.
    const earlier = task ? [...run.workers].reverse().find((w) => w.stepId === s.id && w.sessionId && w.id.endsWith(`:${n + 1}`)) : undefined
    const w: Worker = {
      id,
      stepId: s.id,
      ...(task ? { task } : {}),
      agent: s.agent,
      label: slice ? `${base} · ${slice.title}` : base,
      color: s.agent === LEAD ? 'lead' : agent?.color ?? 'blue',
      slice,
      sessionId: s.agent === LEAD ? run.leadSessionId : sessions[n] ?? existing?.sessionId ?? earlier?.sessionId ?? null,
    }
    if (existing) Object.assign(existing, w)
    else run.workers.push(w)
    return existing ?? w
  })
}

/** The latest-round handoffs of a step: of one task, in the loop. */
export function outputsOf(run: TeamRun, stepId: string, task?: string): Handoff[] {
  const all = run.outputs.filter((o) => o.stepId === stepId && (task === undefined || o.task === task))
  const latest = Math.max(-1, ...all.map((o) => o.round))
  return all.filter((o) => o.round === latest)
}

/** Every task's latest handoffs of a step (or the step's latest, outside the loop). */
export function latestOf(run: TeamRun, stepId: string): Handoff[] {
  const s = run.recipe.steps.find((x) => x.id === stepId)
  if (!s?.forEach) return outputsOf(run, stepId)
  return run.card.tasks.flatMap((t) => outputsOf(run, stepId, t.id))
}

/** This step's handoffs, scoped to the current task when it's in the loop. */
export const stepOutputs = (run: TeamRun, i: number) => outputsOf(run, run.recipe.steps[i].id, inLoop(run, i) ? currentTask(run)?.id : undefined)

/** Split the previous step's findings into at most `max` groups, round-robin. */
export function findingSlices(run: TeamRun, i: number, max: number): Slice[] {
  if (!run.recipe.steps[i - 1]) return []
  const findings = stepOutputs(run, i - 1).flatMap((o) => (o.findings ?? []).map((f) => ({ f, from: o.label })))
  if (!findings.length) return []
  const groups: { f: Finding; from: string }[][] = Array.from({ length: Math.min(max, findings.length) }, () => [])
  findings.forEach((x, n) => groups[n % groups.length].push(x))
  let k = 0
  return groups.map((g) => ({
    title: g.length === 1 ? `finding ${++k}` : `findings ${k + 1}–${(k += g.length)}`,
    brief: g.map((x) => `- [${x.f.severity}] ${x.f.where} — ${x.f.problem}\n  Suggested fix: ${x.f.fix}\n  (from ${x.from})`).join('\n'),
  }))
}

/** The acceptance criteria a step answers for: the task's in the loop (`T2.1`), else the card's (`C1`). */
export function criteriaFor(run: TeamRun, i: number): { id: string; text: string }[] {
  const s = run.recipe.steps[i]
  if (!s || (s.output !== 'change' && s.output !== 'verdict')) return []
  const t = s.forEach ? currentTask(run) : undefined
  if (t) return t.criteria.map((text, n) => ({ id: `${t.id}.${n + 1}`, text }))
  return run.card.criteria.map((text, n) => ({ id: `C${n + 1}`, text }))
}

/** Findings belong to their task in the loop, else to the run. */
export const findingScope = (run: TeamRun, i: number) => (run.recipe.steps[i]?.forEach ? currentTask(run)?.id ?? 'R' : 'R')
export const openFindings = (run: TeamRun, scope: string): string[] =>
  Object.keys(run.findingState).filter((id) => id.startsWith(`${scope}-F`) && run.findingState[id].status === 'open')
