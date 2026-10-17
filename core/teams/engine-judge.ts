import { taskLoop } from './recipe.js'
import { bump, clip, currentTask, horizonText } from './engine-plan.js'
import type { Action, RunGoal, TeamRun } from './engine-types.js'

// ---------------------------------------------------------------------------
// Goals: the done-when, getting unstuck, waiting on the world, your questions
// ---------------------------------------------------------------------------

export const MAX_GOAL_WAIT_MINUTES = 7 * 24 * 60
export const MAX_GOAL_QUESTIONS = 40

export const goalOf = (run: TeamRun): RunGoal => {
  if (!run.goal) throw new Error('this team run is not a goal')
  return run.goal
}

/** The team finished a round (or woke): the lead judges the done-when. Nothing else moves until it does. */
export function judge(run: TeamRun, woke: string | null): Action[] {
  const g = goalOf(run)
  g.owes = 'verdict'
  run.awaiting = []
  run.splitting = false
  bump(run)
  return [
    { kind: 'notice', text: woke ? `Junior is looking at the done-when again — ${woke}.` : `The team finished round ${g.round + 1}. Junior is checking the done-when.` },
    { kind: 'tellLead', text: verdictMessage(run, woke) },
  ]
}

/** Fix rounds ran out (a failing review or failing checks): the lead decides how to get the team moving. */
export function stuckGoal(run: TeamRun, why: string, backTo: number, feedback: string): Action[] {
  const g = goalOf(run)
  g.owes = 'unstick'
  g.stuck = { why, backTo }
  run.feedback = feedback
  run.awaiting = []
  bump(run)
  return [
    { kind: 'notice', text: `The team is stuck: ${why}. Junior is working out how to get it moving.` },
    { kind: 'tellLead', text: unstickMessage(run) },
  ]
}

/** The goal as every worker reads it: the done-when, the horizon, and what this round still has to close. */
export function goalSection(run: TeamRun): string {
  const g = run.goal
  if (!g) return ''
  const lines = [`## The goal's done-when (${horizonText(g.horizon)})\n${g.doneWhen}`]
  if (g.round > 0 && g.gap) lines.push(`## Goal round ${g.round + 1} — what's still missing\n${g.gap}`)
  return lines.join('\n\n')
}

export function verdictMessage(run: TeamRun, woke: string | null): string {
  const g = goalOf(run)
  const loop = !!taskLoop(run.recipe)
  return [
    woke ? `Look at the goal again — ${woke}.` : `The team finished round ${g.round + 1} of the goal "${run.title}".`,
    `## Done when (${horizonText(g.horizon)})\n${g.doneWhen}`,
    g.verdicts.length ? `## Your earlier verdicts\n${g.verdicts.slice(-5).map((v) => `- round ${v.round + 1}: ${v.met ? 'met' : 'not met'} — ${clip(v.evidence, 300)}`).join('\n')}` : '',
    run.dir ? `The run folder ${run.dir} has the plan, the ledger and every handoff.` : '',
    [
      'Judge it yourself — run the checks, read the diff, look at what the connectors you can see say. Do not take the handoffs\' word for it.',
      'Then call goal_verdict:',
      '- met: true, with the evidence — the user accepts the result',
      `- met: false, with the evidence and the gap (what's still missing)${loop ? ' and the tasks the next round works (1–4, each with criteria)' : ''} — triage starts another round`,
      '- met: false with waitFor and waitMinutes, when the world has to move first (CI to finish, a reviewer, a deploy, a date) — triage wakes you then',
      'If only the user can say, ask them with ask_you (a question and the answer you recommend) and end your turn; their answer comes back to you.',
      'Then END YOUR TURN.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function unstickMessage(run: TeamRun): string {
  const g = goalOf(run)
  const t = currentTask(run)
  return [
    `The team on the goal "${run.title}" is stuck${t ? ` on ${t.id} ${t.title}` : ''}: ${g.stuck?.why ?? 'its fix rounds ran out'}.`,
    run.feedback ? `## What the last round left failing\n${clip(run.feedback, 4000)}` : '',
    run.dir ? `The run folder ${run.dir} has the ledger (what was tried and failed) and every handoff.` : '',
    [
      'Work out why the fix rounds did not close it — read the failing output and the ledger\'s "tried, didn\'t work". Then call goal_unstick:',
      '- action "retry", with why (one line, for the ledger) and guidance for the builder: what to do differently this time',
      `- action "skip", with why — ${t ? 'the task is marked unresolved and the team moves on' : 'the run goes on with this unresolved'}`,
      'If only the user can decide, ask them with ask_you (a question and the answer you recommend) and end your turn; their answer comes back to you.',
      'Then END YOUR TURN.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
}
