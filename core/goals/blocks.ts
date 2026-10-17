/**
 * Workflow blocks: a named run of steps a plan can include, expanded into
 * the plan as it is read so the user reviews what will run. They replace team
 * recipes: every recipe in `<ws>/teams/*.md` is a block, its steps mapped onto
 * plan steps (who does each → a role, `gate: you` → a user gate after the
 * step). `shepherd-pr` is built in and stays one watcher gate (shepherd.ts).
 *
 * What a recipe has that a plan step doesn't is dropped: fan-out (the lead
 * writes parallel steps itself, and the team section sizes them), task loops,
 * on-fail rounds (a failed step goes back to the lead, capped by
 * MAX_FIX_ATTEMPTS) and per-step models. Pure and browser-safe: Settings →
 * Teams shows a block's steps with the same code the plan reader runs.
 */
import { CHECKS, LEAD, type RecipeStep, type TeamRecipe } from '../teams/recipe.js'
import type { PlanStep, StepRole } from './types.js'

/** One step of a block, before it is placed in a plan: the plan gives it an id prefix and its dependencies. */
export type BlockStep = Pick<PlanStep, 'title' | 'type' | 'role' | 'doneWhen' | 'gate'> & { id: string }

export type WorkflowBlock = {
  name: string
  label: string
  description: string
  steps: BlockStep[]
}

/** Agent files that name a role outright; anything else is placed by what its step hands on. */
const AGENT_ROLE: Record<string, StepRole> = { implementer: 'builder', reviewer: 'reviewer', 'code-reviewer': 'reviewer', validator: 'tester' }

/** Who does a recipe step on a goal. The lead only writes reports; anything that changes files is a builder's. */
export function roleOf(s: Pick<RecipeStep, 'agent' | 'output'>): StepRole {
  if (s.agent === CHECKS) return 'tester'
  if (s.output === 'change') return 'builder'
  if (s.agent === LEAD) return s.output === 'report' ? 'lead' : 'reviewer'
  return AGENT_ROLE[s.agent] ?? 'reviewer'
}

export function blockFromRecipe(name: string, r: TeamRecipe): WorkflowBlock {
  const steps: BlockStep[] = []
  for (const s of r.steps) {
    const role = roleOf(s)
    const doneWhen = s.agent === CHECKS ? "the project's typecheck, lint and tests pass" : s.does.trim() || `the ${s.id} step's ${s.output ?? 'work'} is handed in`
    steps.push({ id: s.id, title: `${r.label}: ${s.id}`, type: 'agent', role, doneWhen, gate: null })
    if (s.gate === 'you')
      steps.push({
        id: `${s.id}-ok`,
        title: `You approve ${s.id}`,
        type: 'gate',
        role: null,
        doneWhen: `you approved the ${s.id} step's result`,
        gate: { evaluator: 'user', condition: `You approve the result of ${r.label}: ${s.id}`, checkEvery: null, deadline: null, confirmations: 1, connectors: [] },
      })
  }
  return { name, label: r.label, description: r.description, steps }
}

/** A block step's id inside a plan: `<the plan's block step id>.<the block's step id>`. */
export const blockStepId = (at: string, id: string) => `${at}.${id}`

/**
 * One block step of a plan → the steps it stands for, in order: the first
 * waits on what the block step waited on, each next one on the one before.
 * Returns the steps and the id that whatever depended on the block now waits on.
 */
export function expandBlock(at: Pick<PlanStep, 'id' | 'dependsOn'>, block: WorkflowBlock): { steps: PlanStep[]; last: string } {
  const steps: PlanStep[] = []
  let prev: string[] = at.dependsOn
  for (const b of block.steps) {
    const id = blockStepId(at.id, b.id)
    steps.push({ id, title: b.title, type: b.type, role: b.role, dependsOn: prev, doneWhen: b.doneWhen, gate: b.gate ? { ...b.gate } : null, block: null })
    prev = [id]
  }
  return { steps, last: prev[0] ?? at.id }
}
