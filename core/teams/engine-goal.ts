import { taskLoop, LEAD } from './recipe.js'
import { MAX_GOAL_QUESTIONS, MAX_GOAL_WAIT_MINUTES, goalOf, judge } from './engine-judge.js'
import { MAX_TASKS, bump, changeIndex, clip, currentStep, currentTask, recordResume, strList } from './engine-plan.js'
import type { Action, PlanTask, ResumeBy, TeamRun } from './engine-types.js'
import { beginStep, close, finish, finishTask } from './engine.js'

export type GoalVerdictInput = {
  met: boolean
  evidence: string
  /** not met: what's still missing. Every worker in the next round reads it */
  gap?: string
  /** not met, a team with a task loop: the tasks the next round works */
  tasks?: unknown
  /** the world has to move first: what for, and when to look again */
  waitFor?: string
  waitMinutes?: number
}

/** The lead's verdict on the done-when: done, another round, or sleep and look again. */
export function goalVerdict(run: TeamRun, v: GoalVerdictInput, at: number): Action[] {
  const g = goalOf(run)
  if (run.state !== 'running') throw new Error(`the run is ${run.state} — stop; the user resumes it`)
  if (g.owes !== 'verdict') throw new Error('triage has not asked you to judge the done-when — the team is still working')
  const evidence = (v.evidence ?? '').trim().slice(0, 2000)
  if (!evidence) throw new Error('give the evidence: what you ran or looked at, and what it showed')
  const waitFor = v.waitFor?.trim().slice(0, 200)
  if (v.met && waitFor) throw new Error('a met goal has nothing to wait for — give met: true, or waitFor without it')
  if (waitFor && !(typeof v.waitMinutes === 'number' && v.waitMinutes > 0)) throw new Error('say when to look again: waitMinutes')
  g.verdicts.push({ at, met: v.met, evidence, round: g.round })
  g.owes = null
  if (v.met) {
    bump(run)
    return [{ kind: 'notice', text: `Junior says the goal is done: ${clip(evidence, 300)} Accept the result, or say what's missing.` }, ...close(run)]
  }
  if (waitFor) {
    const minutes = Math.min(Math.max(1, Math.round(v.waitMinutes!)), MAX_GOAL_WAIT_MINUTES)
    g.wait = { until: at + minutes * 60_000, for: waitFor }
    run.state = 'waiting'
    run.reason = `waiting for ${waitFor}`
    bump(run)
    return [{ kind: 'notice', text: `Waiting for ${waitFor} — Junior looks again in ${minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}.` }]
  }
  const gap = (v.gap ?? '').trim() || evidence
  return nextRound(run, 'junior', gap, v.tasks, at)
}

/** Another round on the goal: new tasks for a task loop, else the change step again with what's missing. */
function nextRound(run: TeamRun, by: ResumeBy, gap: string, rawTasks: unknown, at: number): Action[] {
  const g = goalOf(run)
  g.round += 1
  g.gap = gap.slice(0, 1500)
  g.owes = null
  g.stuck = null
  run.state = 'running'
  delete run.reason
  recordResume(run, by, `started goal round ${g.round + 1}`, g.gap, at)
  run.resumeMark = by
  const notice: Action = { kind: 'notice', text: `Goal round ${g.round + 1}${by === 'you' ? ' (you reopened it)' : ''}: ${clip(g.gap, 300)}` }
  const loop = taskLoop(run.recipe)
  if (loop) {
    const given = (Array.isArray(rawTasks) ? rawTasks : []).map((x) => (x ?? {}) as Record<string, unknown>)
    const list = given.length ? given : [{ title: g.gap }]
    let n = Math.max(0, ...run.card.tasks.map((t) => Number(t.id.slice(1)) || 0))
    const added: PlanTask[] = list
      .map((x) => ({ title: typeof x.title === 'string' ? x.title.trim().slice(0, 160) : '', criteria: strList(x.criteria, 6) }))
      .filter((x) => x.title)
      .slice(0, MAX_TASKS)
      .map((x) => ({ id: `T${++n}`, ...x }))
    if (!added.length) throw new Error('give the next round at least one task with a title')
    run.card.tasks.push(...added)
    for (const t of added) run.tasks[t.id] = { status: 'todo', round: 0 }
    run.task = null
    bump(run)
    return [notice, ...beginStep(run, loop.from)]
  }
  // Fix rounds start fresh for the round (ids keep counting, so every run stays its own).
  run.round += 1
  run.roundFloor = run.round
  run.feedback = `The goal's done-when isn't met yet: ${g.gap}`
  const ci = changeIndex(run.recipe)
  return [notice, ...beginStep(run, ci >= 0 ? ci : 0)]
}

/** The lead's way past what stopped the team: retry with guidance, or skip past it. */
export function unstick(run: TeamRun, u: { action: 'retry' | 'skip'; why: string; guidance?: string }, at: number): Action[] {
  const g = goalOf(run)
  if (run.state !== 'running') throw new Error(`the run is ${run.state} — stop; the user resumes it`)
  if (g.owes !== 'unstick' || !g.stuck) throw new Error('the team is not stuck — nothing to unstick')
  const why = (u.why ?? '').trim().slice(0, 600)
  if (!why) throw new Error('say why, in a line — it goes on the ledger')
  const { backTo, why: what } = g.stuck
  g.owes = null
  g.stuck = null
  const s = currentStep(run)
  const t = currentTask(run)
  if (u.action === 'skip') {
    recordResume(run, 'junior', `skipped past: ${what}`, why, at)
    run.resumeMark = 'junior'
    if (s?.forEach && t) return finishTask(run, 'unresolved', `${what} — skipped: ${why}`)
    run.unresolved = `${what} — skipped: ${why}`
    const last = run.recipe.steps.length - 1
    const report = run.recipe.steps[last]
    if (report.agent === LEAD && report.output === 'report' && run.step < last) return beginStep(run, last)
    return finish(run)
  }
  recordResume(run, 'junior', `retried after: ${what}`, why, at)
  run.resumeMark = 'junior'
  // The retry is a fresh start against the cap: its own attempt, then the recipe's fix rounds.
  run.round += 1
  run.roundFloor = run.round
  if (t && s?.forEach) run.tasks[t.id] = { ...run.tasks[t.id], round: run.round }
  const guidance = u.guidance?.trim().slice(0, 2000)
  g.guidance = guidance ? { text: guidance, round: run.round } : null
  return [{ kind: 'notice', text: `Junior resumed the team: ${why}` }, ...beginStep(run, backTo)]
}

/** A waiting goal is due a look. */
export const wakeDue = (run: Pick<TeamRun, 'state' | 'goal'>, now: number): boolean => run.state === 'waiting' && !!run.goal?.wait && now >= run.goal.wait.until

/** Time's up on a wait (or you woke it early): the lead judges the done-when again. */
export function wake(run: TeamRun, at: number, early = false): Action[] {
  const g = goalOf(run)
  if (run.state !== 'waiting' || !g.wait) throw new Error('the goal is not waiting')
  if (!early && at < g.wait.until) return []
  const w = g.wait
  g.wait = null
  run.state = 'running'
  delete run.reason
  return judge(run, early ? `you woke it early; it was waiting for ${w.for}` : `it was waiting for ${w.for}`)
}

/** Junior asks you something, with the answer it recommends. The run carries on meanwhile. */
export function askYou(run: TeamRun, text: string, recommended: string, at: number): { id: string; actions: Action[] } {
  const g = goalOf(run)
  if (run.state === 'proposed' || run.state === 'done' || run.state === 'stopped') throw new Error(`the run is ${run.state} — ask in the chat instead`)
  const q = text.trim().slice(0, 1000)
  const rec = recommended.trim().slice(0, 1000)
  if (!q) throw new Error('ask a question')
  if (!rec) throw new Error('every question comes with the answer you recommend')
  if (g.questions.length >= MAX_GOAL_QUESTIONS) throw new Error('too many questions on this goal — put the rest in one message')
  const id = `Q${g.questions.length + 1}`
  g.questions.push({ id, text: q, recommended: rec, at, answer: null, answeredAt: null })
  bump(run)
  return { id, actions: [{ kind: 'notice', text: `Needs you: Junior asks — ${clip(q, 300)}` }] }
}

/** You answered one of Junior's questions: it goes to the lead, verbatim. */
export function answerQuestion(run: TeamRun, id: string, answer: string, at: number): Action[] {
  const g = goalOf(run)
  const q = g.questions.find((x) => x.id === id)
  if (!q) throw new Error('no such question')
  if (q.answer !== null) throw new Error('that question is already answered')
  const a = answer.trim().slice(0, 4000)
  if (!a) throw new Error('the answer is empty')
  q.answer = a
  q.answeredAt = at
  bump(run)
  const then =
    run.state === 'running' && g.owes === 'verdict'
      ? ' Then judge the done-when with goal_verdict.'
      : run.state === 'running' && g.owes === 'unstick'
        ? ' Then get the team moving with goal_unstick.'
        : run.state === 'paused'
          ? ' The run is paused — nothing moves until the user resumes it.'
          : ''
  return [{ kind: 'tellLead', text: `The user answered your question ${id} ("${clip(q.text, 200)}"):\n\n${a}${then}` }]
}

/** You accepted the result Junior judged done. */
export function acceptGoal(run: TeamRun, at: number): Action[] {
  const g = goalOf(run)
  if (run.state !== 'done') throw new Error('the goal is not done yet')
  if (g.acceptedAt) throw new Error('already accepted')
  g.acceptedAt = at
  bump(run)
  return [{ kind: 'notice', text: 'Result accepted. The goal is closed.' }]
}

/** Not done yet, you say: another round, with what you said is missing. */
export function reopenGoal(run: TeamRun, why: string, at: number): Action[] {
  const g = goalOf(run)
  if (run.state !== 'done') throw new Error('only a done goal can be reopened')
  if (g.acceptedAt) throw new Error('an accepted goal is closed — start a new one')
  const gap = why.trim().slice(0, 1500)
  if (!gap) throw new Error("say what's missing")
  g.verdicts.push({ at, met: false, evidence: `You: ${gap}`, round: g.round })
  return nextRound(run, 'you', gap, undefined, at)
}
