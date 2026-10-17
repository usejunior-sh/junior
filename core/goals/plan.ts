/**
 * A goal's plan: validated from what a lead proposes (goal_propose_plan,
 * propose_plan_change), rendered to plan.md, and read back from it. plan.md is
 * the plan's source and the goals table caches it parsed (mapping note,
 * "Plan"); the step JSON rides in a fenced block so a person reads the prose
 * and the engine reads the block.
 *
 * Rejected, never repaired, the way core/teams/recipe.ts treats a recipe:
 * an unknown key, a dangling dependency or a cycle is an error the lead fixes.
 * Pure: no I/O, no clock.
 */
import { expandBlock, type WorkflowBlock } from './blocks.js'
import { parseDuration } from './machine.js'
import { policyLines, SHEPHERD_BLOCK, SHEPHERD_GATE } from './shepherd.js'
import {
  GATE_EVALUATORS,
  isGoalHorizon,
  STEP_ROLES,
  STEP_TYPES,
  type GateSpec,
  type Goal,
  type GoalBudget,
  type GoalPlan,
  type PlanStep,
  type StepRole,
  type StepType,
  type TeamSeat,
} from './types.js'

/** Recipes' cap (core/teams/recipe.ts MAX_BUDGET_USD): a plan asking for more is refused. */
export const MAX_PLAN_BUDGET_USD = 500
export const MAX_PLAN_STEPS = 40
export const MAX_CONFIRMATIONS = 3

export type PlanResult = { ok: true; plan: GoalPlan } | { ok: false; error: string }

const PLAN_KEYS = new Set(['summary', 'doneWhen', 'horizon', 'steps', 'team', 'budgetUsd', 'budgetMinutes', 'mayDo', 'models'])
const STEP_KEYS = new Set(['id', 'title', 'type', 'role', 'dependsOn', 'doneWhen', 'gate', 'block'])
const GATE_KEYS = new Set(['evaluator', 'condition', 'checkEvery', 'deadline', 'confirmations', 'connectors'])
const SEAT_KEYS = new Set(['role', 'count', 'why', 'model'])
const MODEL_KEYS = new Set(['lead', 'worker', 'gate'])

class PlanError extends Error {}
const fail = (msg: string): never => {
  throw new PlanError(msg)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function only(o: Record<string, unknown>, keys: Set<string>, where: string) {
  for (const k of Object.keys(o)) if (!keys.has(k)) fail(`${where}: unknown key "${k}"`)
}

function text(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) fail(`${where} must be a non-empty string`)
  return (v as string).trim()
}

function optText(v: unknown, where: string): string | null {
  if (v === undefined || v === null) return null
  return text(v, where)
}

function textList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) fail(`${where} must be a list of strings`)
  return (v as unknown[]).map((x, i) => text(x, `${where}[${i}]`))
}

function positive(v: unknown, where: string, max?: number): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${where} must be a positive number`)
  if (max !== undefined && (v as number) > max) fail(`${where} is over the cap of ${max}`)
  return v as number
}

function duration(v: unknown, where: string): string | null {
  const s = optText(v, where)
  if (s !== null && parseDuration(s) === null) fail(`${where} must be a duration like "15m", "4h" or "1d"`)
  return s
}

function gateFrom(v: unknown, where: string): GateSpec {
  if (!isObj(v)) fail(`${where} must be an object`)
  const g = v as Record<string, unknown>
  only(g, GATE_KEYS, where)
  if (!GATE_EVALUATORS.includes(g.evaluator as GateSpec['evaluator'])) fail(`${where}.evaluator must be "ai", "user" or "watcher"`)
  let confirmations = 1
  if (g.confirmations !== undefined && g.confirmations !== null) {
    const c = g.confirmations
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > MAX_CONFIRMATIONS)
      fail(`${where}.confirmations must be a whole number from 1 to ${MAX_CONFIRMATIONS}`)
    confirmations = c as number
  }
  return {
    evaluator: g.evaluator as GateSpec['evaluator'],
    condition: text(g.condition, `${where}.condition`),
    checkEvery: duration(g.checkEvery, `${where}.checkEvery`),
    deadline: duration(g.deadline, `${where}.deadline`),
    confirmations,
    connectors: textList(g.connectors, `${where}.connectors`),
  }
}

function stepFrom(v: unknown, i: number): PlanStep {
  const where = `steps[${i}]`
  if (!isObj(v)) fail(`${where} must be an object`)
  const s = v as Record<string, unknown>
  only(s, STEP_KEYS, where)
  const id = text(s.id, `${where}.id`)
  if (!/^[\w.-]{1,40}$/.test(id)) fail(`${where}.id "${id}" must be short: letters, digits, "-", "_" or "."`)
  const type = s.type as StepType
  if (!STEP_TYPES.includes(type)) fail(`${where}.type must be one of ${STEP_TYPES.join(', ')}`)
  const has = (k: string) => s[k] !== undefined && s[k] !== null

  let role: StepRole | null = null
  if (type === 'agent') {
    if (!STEP_ROLES.includes(s.role as StepRole)) fail(`${where}.role must be one of ${STEP_ROLES.join(', ')} for an agent step`)
    role = s.role as StepRole
  } else if (has('role')) fail(`${where}.role is only for agent steps`)

  let gate: GateSpec | null = null
  if (type === 'gate') gate = gateFrom(s.gate, `${where}.gate`)
  else if (has('gate')) fail(`${where}.gate is only for gate steps`)

  let block: string | null = null
  if (type === 'block') block = text(s.block, `${where}.block`)
  else if (has('block')) fail(`${where}.block is only for block steps`)

  const step: PlanStep = { id, title: text(s.title, `${where}.title`), type, role, dependsOn: textList(s.dependsOn, `${where}.dependsOn`), doneWhen: text(s.doneWhen, `${where}.doneWhen`), gate, block }
  if (type !== 'block') return step
  // Blocks expand as the plan is read, so the user reviews what will run.
  if (block === SHEPHERD_BLOCK) return { ...step, type: 'gate', gate: { ...SHEPHERD_GATE }, block: null }
  return step
}

/**
 * Every recipe block step → the block's steps (blocks.ts), and whatever
 * depended on the block step → its last step. Ids stay unique and short, or
 * the plan is refused.
 */
function expandBlocks(steps: PlanStep[], blocks: readonly WorkflowBlock[]): PlanStep[] {
  const last = new Map<string, string>()
  const out: PlanStep[] = []
  for (const s of steps) {
    if (s.type !== 'block') {
      out.push(s)
      continue
    }
    const b = blocks.find((x) => x.name === s.block)
    if (!b) {
      const names = [SHEPHERD_BLOCK, ...blocks.map((x) => x.name)].map((n) => `"${n}"`).join(', ')
      fail(`step "${s.id}": "${s.block}" isn't a workflow block (there are ${names})`)
    }
    const x = expandBlock(s, b!)
    for (const e of x.steps) if (e.id.length > 40) fail(`step "${s.id}": block step id "${e.id}" is over 40 characters — give the block step a shorter id`)
    out.push(...x.steps)
    last.set(s.id, x.last)
  }
  return out.map((s) => (s.dependsOn.some((d) => last.has(d)) ? { ...s, dependsOn: s.dependsOn.map((d) => last.get(d) ?? d) } : s))
}

/** Workers the team section asks for at once: every seat but the lead's. */
export const teamSize = (team: readonly TeamSeat[]): number => team.reduce((n, t) => n + (t.role === 'lead' ? 0 : t.count), 0)

function checkGraph(steps: PlanStep[]) {
  const ids = new Set<string>()
  for (const s of steps) {
    if (ids.has(s.id)) fail(`step id "${s.id}" is used twice`)
    ids.add(s.id)
  }
  for (const s of steps)
    for (const d of s.dependsOn) {
      if (d === s.id) fail(`step "${s.id}" depends on itself`)
      if (!ids.has(d)) fail(`step "${s.id}" depends on "${d}", which isn't a step`)
    }
  // Kahn: whatever can't be ordered sits on a cycle.
  const indeg = new Map(steps.map((s) => [s.id, s.dependsOn.length]))
  const ready = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id)
  let seen = 0
  while (ready.length) {
    const id = ready.pop()!
    seen++
    for (const s of steps)
      if (s.dependsOn.includes(id)) {
        const n = indeg.get(s.id)! - 1
        indeg.set(s.id, n)
        if (n === 0) ready.push(s.id)
      }
  }
  if (seen !== steps.length) fail(`steps ${steps.filter((s) => indeg.get(s.id)! > 0).map((s) => `"${s.id}"`).join(', ')} depend on each other in a cycle`)
}

function seatFrom(v: unknown, i: number): TeamSeat {
  const where = `team[${i}]`
  if (!isObj(v)) fail(`${where} must be an object`)
  const t = v as Record<string, unknown>
  only(t, SEAT_KEYS, where)
  if (!STEP_ROLES.includes(t.role as StepRole)) fail(`${where}.role must be one of ${STEP_ROLES.join(', ')}`)
  if (typeof t.count !== 'number' || !Number.isInteger(t.count) || t.count < 1 || t.count > 6) fail(`${where}.count must be a whole number from 1 to 6`)
  return { role: t.role as StepRole, count: t.count as number, why: text(t.why, `${where}.why`), model: optText(t.model, `${where}.model`) }
}

/**
 * A proposed plan → the plan the user reviews, or why not. `goal` supplies
 * what the plan may leave out (horizon, budget). A plan with a watcher gate
 * (a `shepherd-pr` block) carries the default policies, so the user approves
 * what the PR watcher may do on its own.
 */
export type PlanOpts = {
  /** the workflow blocks a block step may name, besides the built-in shepherd-pr */
  blocks?: readonly WorkflowBlock[]
  /** the user's max team size (Settings → Teams); a team section over it is refused */
  maxTeam?: number | null
}

export function planFrom(raw: unknown, goal: Pick<Goal, 'horizon' | 'budget'>, opts: PlanOpts = {}): PlanResult {
  try {
    if (!isObj(raw)) fail('plan must be an object')
    const p = raw as Record<string, unknown>
    only(p, PLAN_KEYS, 'plan')
    if (!Array.isArray(p.steps) || p.steps.length === 0) fail('plan.steps must list at least one step')
    if ((p.steps as unknown[]).length > MAX_PLAN_STEPS) fail(`plan.steps is over the cap of ${MAX_PLAN_STEPS}`)
    const steps = expandBlocks((p.steps as unknown[]).map(stepFrom), opts.blocks ?? [])
    if (steps.length > MAX_PLAN_STEPS) fail(`plan.steps is over the cap of ${MAX_PLAN_STEPS} once its blocks are expanded`)
    checkGraph(steps)
    if (p.horizon !== undefined && !isGoalHorizon(p.horizon)) fail('plan.horizon must be today, until_done or ongoing')
    if (p.team !== undefined && !Array.isArray(p.team)) fail('plan.team must be a list')
    let models: GoalPlan['models'] = null
    if (p.models !== undefined && p.models !== null) {
      if (!isObj(p.models)) fail('plan.models must be an object')
      const m = p.models as Record<string, unknown>
      only(m, MODEL_KEYS, 'plan.models')
      models = {}
      for (const k of ['lead', 'worker', 'gate'] as const) {
        const v = optText(m[k], `plan.models.${k}`)
        if (v) models[k] = v
      }
    }
    const team = ((p.team as unknown[] | undefined) ?? []).map(seatFrom)
    const size = teamSize(team)
    if (opts.maxTeam && size > opts.maxTeam)
      fail(`plan.team asks for ${size} workers at once, over the user's max team size of ${opts.maxTeam}: staff fewer seats, or say in the summary why more would help`)
    const usd = positive(p.budgetUsd, 'plan.budgetUsd', MAX_PLAN_BUDGET_USD)
    const minutes = positive(p.budgetMinutes, 'plan.budgetMinutes')
    const budget: GoalBudget = { usd: usd ?? goal.budget.usd, minutes: minutes ?? goal.budget.minutes }
    return {
      ok: true,
      plan: {
        summary: text(p.summary, 'plan.summary'),
        doneWhen: text(p.doneWhen, 'plan.doneWhen'),
        horizon: (p.horizon as GoalPlan['horizon'] | undefined) ?? goal.horizon,
        steps,
        team,
        budget,
        mayDo: textList(p.mayDo, 'plan.mayDo'),
        policies: steps.some((st) => st.gate?.evaluator === 'watcher') ? policyLines() : [],
        models,
      },
    }
  } catch (err) {
    if (err instanceof PlanError) return { ok: false, error: err.message }
    throw err
  }
}

/** Same plan, ignoring key order, what makes a repeat proposal a no-op. */
export function samePlan(a: GoalPlan | null, b: GoalPlan | null): boolean {
  return canonical(a) === canonical(b)
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** The fence the engine reads; everything else in plan.md is for people. */
const FENCE_OPEN = '```json goal-plan'

function budgetLine(b: GoalBudget): string {
  const parts = [b.usd !== null ? `$${b.usd}` : null, b.minutes !== null ? `${b.minutes} min` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'no cap'
}

function stepLine(s: PlanStep, n: number): string {
  const who = s.type === 'agent' ? s.role : s.type === 'gate' ? `gate (${s.gate?.evaluator})` : `block ${s.block}`
  const after = s.dependsOn.length ? ` · after ${s.dependsOn.join(', ')}` : ''
  const lines = [`${n}. **${s.id}** ${s.title} — ${who}${after}`, `   Done when: ${s.doneWhen}`]
  if (s.gate) lines.push(`   Waits for: ${s.gate.condition}`)
  return lines.join('\n')
}

/** plan.md for a goal's plan, at a plan version. Deterministic: the same plan renders byte for byte the same. */
export function renderPlanMd(goal: Pick<Goal, 'id' | 'title'>, plan: GoalPlan, version: number): string {
  const out = [
    `# Plan · ${goal.title}`,
    '',
    `Goal \`${goal.id}\` · plan version ${version}`,
    '',
    `**Done when:** ${plan.doneWhen}`,
    `**Horizon:** ${plan.horizon.replace('_', ' ')}`,
    `**Budget:** ${budgetLine(plan.budget)}`,
    '',
    '## Summary',
    '',
    plan.summary,
    '',
    '## Steps',
    '',
    ...plan.steps.map((s, i) => stepLine(s, i + 1)),
    '',
  ]
  if (plan.team.length) out.push('## Team', '', ...plan.team.map((t) => `- ${t.count} × ${t.role}${t.model ? ` (${t.model})` : ''} — ${t.why}`), '')
  if (plan.mayDo.length) out.push('## May do without asking', '', ...plan.mayDo.map((m) => `- ${m}`), '')
  if (plan.policies.length) out.push('## Policies', '', ...plan.policies.map((m) => `- ${m}`), '')
  out.push('## Plan data', '', FENCE_OPEN, JSON.stringify(plan, null, 2), '```', '')
  return out.join('\n')
}

/** The plan back out of plan.md's fenced block, or null when there is none or it doesn't parse. */
export function parsePlanMd(md: string): GoalPlan | null {
  const start = md.indexOf(`${FENCE_OPEN}\n`)
  if (start < 0) return null
  const from = start + FENCE_OPEN.length + 1
  const end = md.indexOf('\n```', from)
  if (end < 0) return null
  try {
    const v = JSON.parse(md.slice(from, end)) as unknown
    return isObj(v) && Array.isArray(v.steps) ? (v as GoalPlan) : null
  } catch {
    return null
  }
}
