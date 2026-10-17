/**
 * The team run engine (Teams v2): triage — not an agent — moves a run through
 * its recipe's steps. Pure: every function takes the run, changes it in place
 * and returns the actions the server must carry out (tell a worker, run the
 * project's checks, post a notice, finish). No clock reads, no I/O, so the whole
 * state machine is unit-tested without a server.
 *
 *   proposed ──approve──▶ running ──(steps…)──▶ done
 *                           │  ▲
 *                gate: you  ▼  │ continue          budget / you: paused ⇄ running
 *                          gate
 *
 * Each step: its workers get one message (the plan's slice they need, the inputs
 * verbatim); each finishes by calling submit_step; when the last awaited worker's
 * turn ends, the step ends. A failed verdict or failed checks go back to the
 * change step (capped).
 *
 * The task loop: a recipe's contiguous `for-each: task` steps run once per task
 * on the plan, in order. Each task starts in a clean context (unless the change
 * step says `context: carry`) — what earlier tasks learned travels as the plan's
 * notes, not as transcript. A task still failing past its fix rounds is marked
 * unresolved and the run moves on to the next one.
 *
 * A goal (.docs/junior-goals-teams/modes-autonomy-goals.md) is a run with a
 * done-when: where a run would end, Junior judges the done-when instead, and
 * starts another round when it isn't met, or sleeps on the world and looks
 * again. Where a run would give up (fix rounds used up), Junior decides how to
 * get the team moving. A gate and a budget pause still wait for you; Junior
 * may ask you questions meanwhile. Every resume is recorded with who did it.
 */
import { taskLoop, CHECKS, LEAD, type RecipeStep } from './recipe.js'
import { judge, stuckGoal, unstickMessage, verdictMessage } from './engine-judge.js'
import { renderFindings, splitMessage, stepMessage } from './engine-messages.js'
import { bump, changeIndex, clip, criteriaFor, currentStep, currentTask, editTasks, findingScope, findingSlices, inLoop, openFindings, outputsOf, recordResume, stepOutputs, workerById, workersFor } from './engine-plan.js'
import type { Action, CheckResult, CriterionReport, CriterionStatus, DiffScope, Finding, Handoff, LedgerKind, Resolution, Slice, TaskStatus, TeamCard, TeamRun, Worker, WorkerRun } from './engine-types.js'

export type { Slice, Severity, Finding, FindingStatus, Resolution, CriterionStatus, CriterionReport, LedgerKind, LedgerEntry, CardStep, PlanTask, TeamCard, RunAgent, Worker, CheckResult, Handoff, WorkerRun, ResumeBy, RunResume, GoalHorizonKind, RunGoalHorizon, GoalQuestion, GoalVerdict, RunGoal, TaskStatus, TaskState, PlanNote, RunState, TeamRun, DiffScope, Action } from './engine-types.js'
export { runSpent, currentStep, workerById, currentTask, normalizeRun, MAX_CRITERIA, MAX_TASKS, MAX_RUN_BUDGET_USD, leadSlices, tasksFrom, cardFrom, endOfDay, goalFrom, horizonText, goalOverdue, editTasks, recipeFromRun, renderCard, renderTaskList, outputsOf, criteriaFor, openFindings } from './engine-plan.js'
export { MAX_GOAL_WAIT_MINUTES, MAX_GOAL_QUESTIONS } from './engine-judge.js'
export { goalVerdict, unstick, wakeDue, wake, askYou, answerQuestion, acceptGoal, reopenGoal } from './engine-goal.js'
export type { GoalVerdictInput } from './engine-goal.js'
export { runPath, renderHandoff, workerAppend, planMessage } from './engine-messages.js'

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** You approved the card (perhaps edited): photograph the tree and start step 1. */
export function approve(run: TeamRun, card: TeamCard): Action[] {
  if (run.state !== 'proposed') throw new Error(`the run is ${run.state}, not waiting for approval`)
  if (!card.permissions) throw new Error('pick what the team may do without asking before it runs')
  run.card = card
  run.budgetUsd = card.budgetUsd
  run.state = 'running'
  run.tasks = Object.fromEntries(card.tasks.map((t) => [t.id, { status: 'todo' as TaskStatus, round: 0 }]))
  delete run.reason
  const tasks = card.tasks.length ? `, ${card.tasks.length} task${card.tasks.length === 1 ? '' : 's'}` : ''
  return [
    { kind: 'snapshot', scope: 'run' },
    { kind: 'notice', text: `Team approved — ${run.recipe.label}${tasks}, up to $${card.budgetUsd}` },
    ...beginStep(run, 0),
  ]
}

/** Start task `n` of the plan: a clean round, its own diff baseline. */
function startTask(run: TeamRun, n: number): Action[] {
  run.task = n
  run.round = 0
  run.feedback = null
  const t = run.card.tasks[n]
  run.tasks[t.id] = { status: 'running', round: 0 }
  bump(run)
  return [
    { kind: 'snapshot', scope: 'task' },
    { kind: 'notice', text: `Task ${t.id} of ${run.card.tasks.length}: ${t.title}` },
  ]
}

export function beginStep(run: TeamRun, i: number): Action[] {
  const loop = taskLoop(run.recipe)
  const pre: Action[] = []
  if (loop && i === loop.from && run.task === null) {
    const first = run.card.tasks.findIndex((t) => (run.tasks[t.id]?.status ?? 'todo') === 'todo')
    if (first === -1) return beginStep(run, loop.to + 1)
    pre.push(...startTask(run, first))
  }
  run.step = i
  run.splitting = false
  run.awaiting = []
  run.submitted = []
  bump(run)
  const s = run.recipe.steps[i]
  if (!s) return [...pre, ...finish(run)]
  if (s.agent === CHECKS) return [...pre, { kind: 'checks' }]
  if (!s.fanOut) return [...pre, ...tellAll(run, i, workersFor(run, i, [null]))]
  const prev = run.recipe.steps[i - 1]
  if (s.fanOut.by === 'finding') {
    const slices = findingSlices(run, i, s.fanOut.max)
    if (!slices.length) {
      record(run, { stepId: s.id, workerId: null, label: 'triage', summary: 'nothing to check — the step before reported no findings', body: '' })
      return [...pre, ...endStep(run)]
    }
    return [...pre, ...tellAll(run, i, workersFor(run, i, slices))]
  }
  if (prev?.fanOut && prev.fanOut.by === s.fanOut.by) {
    const before = run.workers.filter((w) => w.stepId === prev.id && outputsOf(run, prev.id).some((o) => o.workerId === w.id))
    return [...pre, ...tellAll(run, i, workersFor(run, i, before.map((w) => w.slice), before.map((w) => w.sessionId)))]
  }
  const planned = run.card.steps.find((c) => c.id === s.id)?.slices
  if (planned?.length) return [...pre, ...tellAll(run, i, workersFor(run, i, planned))]
  run.splitting = true
  return [...pre, { kind: 'tellLead', text: splitMessage(run, s) }]
}

/** The lead split the current fan-out step. */
export function split(run: TeamRun, slices: Slice[]): Action[] {
  const s = currentStep(run)
  if (run.state !== 'running' || !s || !run.splitting) throw new Error('no step is waiting to be split')
  const clean = slices.map((x) => ({ title: x.title.trim().slice(0, 80), brief: x.brief.trim().slice(0, 4000) })).filter((x) => x.title)
  if (!clean.length) throw new Error('give at least one slice')
  if (clean.length > s.fanOut!.max) throw new Error(`this step fans out to at most ${s.fanOut!.max}`)
  run.splitting = false
  const card = run.card.steps.find((c) => c.id === s.id)
  if (card) card.slices = clean
  return tellAll(run, run.step, workersFor(run, run.step, clean))
}

function tellAll(run: TeamRun, i: number, workers: Worker[]): Action[] {
  const s = run.recipe.steps[i]
  run.awaiting = workers.map((w) => w.id)
  const ci = changeIndex(run.recipe)
  const afterChange = ci >= 0 && ci < i
  // Which diff a reader gets: this task's, in the loop; the whole run's, after it (or without one).
  const scope: DiffScope = s.forEach && run.recipe.steps[ci]?.forEach ? 'task' : 'run'
  const firstOfTask = run.round === 0 && !!s.forEach
  const told = workers.map((w): Action => {
    const fresh =
      w.agent !== LEAD &&
      // A checker re-reads from scratch every round: never its own earlier verdict.
      ((s.output === 'verdict' && run.round > 0) ||
        // Every task starts clean, unless the change step carries its context across tasks.
        (firstOfTask && run.task! > 0 && !(s.output === 'change' && s.context === 'carry')))
    startRun(run, w, fresh)
    return {
      kind: 'tell' as const,
      workerId: w.id,
      text: stepMessage(run, i, w),
      fresh,
      diff: afterChange && s.output !== 'change' && s.agent !== LEAD ? scope : false,
    }
  })
  // Only the runs a resume started carry its mark.
  run.resumeMark = null
  return told
}

function startRun(run: TeamRun, w: Worker, fresh: boolean) {
  const id = `${w.id}#${run.round}`
  if (run.workerRuns.some((r) => r.id === id)) return
  run.workerRuns.push({
    id,
    workerId: w.id,
    stepId: w.stepId,
    ...(w.task ? { task: w.task } : {}),
    round: run.round,
    fresh,
    startSeq: null,
    at: null,
    spendAtStart: null,
    handoffId: null,
    ...(run.resumeMark ? { resumedBy: run.resumeMark } : {}),
  })
}

/** The server sent a worker its step: where in the session the run starts, when, and what the session had spent. A nudge finds nothing to stamp. */
export function stampRun(run: TeamRun, workerId: string, stamp: { startSeq: number; at: number; spendAtStart: number; patch?: string }): void {
  const r = [...run.workerRuns].reverse().find((x) => x.workerId === workerId)
  if (!r || r.startSeq !== null) return
  Object.assign(r, stamp)
}

/** How a step message from triage begins — not a nudge, a resume, or a request to split. */
export const STEP_MESSAGE = /^(Task T\d+ \(\d+ of \d+\) — step "|Step "[^"]+" \(\d+ of \d+\))/

/**
 * Runs stored before runs were recorded: one per handoff (and per worker still
 * on its step), placed in each session at the step messages triage sent it, in
 * order. `starts` is those messages per session, oldest first.
 */
export function backfillRuns(run: TeamRun, starts: Record<string, { seq: number; at: number; fresh: boolean }[]>): void {
  const out: WorkerRun[] = []
  const add = (w: Worker, round: number, handoffId: string | null, stepId: string, task?: string) => {
    const id = `${w.id}#${round}`
    if (out.some((r) => r.id === id)) return
    out.push({ id, workerId: w.id, stepId, ...(task ? { task } : {}), round, fresh: false, startSeq: null, at: null, spendAtStart: null, handoffId })
  }
  for (const h of run.outputs) {
    const w = h.workerId ? workerById(run, h.workerId) : undefined
    if (w) add(w, h.round, h.id, h.stepId, h.task)
  }
  for (const id of run.awaiting) {
    const w = workerById(run, id)
    if (w) add(w, run.round, null, w.stepId, w.task)
  }
  const placed = new Map<string, number>()
  for (const r of out) {
    const sid = workerById(run, r.workerId)?.sessionId
    if (!sid) continue
    const n = placed.get(sid) ?? 0
    placed.set(sid, n + 1)
    const s = starts[sid]?.[n]
    if (s) Object.assign(r, { startSeq: s.seq, at: s.at, fresh: s.fresh })
  }
  run.workerRuns = out
}

/** A run's state, from its handoff and the run around it. */
export function runStatus(run: Pick<TeamRun, 'outputs' | 'awaiting' | 'workerRuns' | 'state'>, r: WorkerRun): 'working' | 'pass' | 'fail' | 'done' | 'stopped' {
  const h = r.handoffId ? run.outputs.find((o) => o.id === r.handoffId) : undefined
  if (h) return h.verdict ?? 'done'
  const live = run.awaiting.includes(r.workerId) && run.workerRuns.findLast((x) => x.workerId === r.workerId) === r
  return live && (run.state === 'running' || run.state === 'paused') ? 'working' : 'stopped'
}

export type Submission = {
  summary: string
  body: string
  verdict?: 'pass' | 'fail'
  findings?: Finding[]
  files?: string[]
  /** change and verdict steps: every acceptance criterion by id */
  criteria?: { id: string; status: Exclude<CriterionStatus, 'unreported'>; evidence: string }[]
  decisions?: { what: string; why: string }[]
  surprises?: string[]
  /** approaches tried that didn't work, and why */
  failed?: string[]
  /** files and symbols that matter here: "path — what it is" */
  where?: string[]
  /** how to check this project: commands, URLs, what to look at */
  verify?: string[]
  unsure?: string
  /** a fix round: an answer to every open finding */
  resolutions?: Resolution[]
  /** runs from before the ledger: one-liners for whoever builds next */
  notes?: string[]
}

const LEDGER_CAP = 10
const handoffFile = (n: number, stepId: string, round: number, task?: string) => `handoffs/${String(n).padStart(2, '0')}-${task ? `${task}-` : ''}${stepId}-r${round}.md`

function record(run: TeamRun, h: Omit<Handoff, 'id' | 'round' | 'at' | 'task'> & { at?: number }): Handoff {
  const task = inLoop(run, run.step) ? currentTask(run)?.id : undefined
  const n = run.outputs.length + 1
  const out: Handoff = { id: `${h.stepId}:${task ? `${task}:` : ''}${run.round}:${n}`, ...(task ? { task } : {}), round: run.round, at: h.at ?? 0, file: handoffFile(n, h.stepId, run.round, task), ...h }
  run.outputs.push(out)
  bump(run)
  return out
}

/** Refuse once, by key; after that, accept and let the caller fill the gap. */
function insistOnce(run: TeamRun, key: string, missing: string[], message: string): void {
  if (!missing.length || run.nudged.includes(key)) return
  run.nudged.push(key)
  throw new Error(message)
}

/**
 * A worker called submit_step. Recorded now; acted on when its turn ends, so
 * triage never messages a session mid-turn. Returns what to tell the caller.
 * A handoff that skips a criterion, or (in a fix round) an open finding, is
 * turned back once with the ids it missed; the second try is taken as it is.
 */
export function submit(run: TeamRun, sessionId: string, sub: Submission, at: number): string {
  if (run.state !== 'running') throw new Error(`the run is ${run.state}${run.reason ? ` (${run.reason})` : ''} — stop; the user resumes it`)
  const s = currentStep(run)
  const w = run.awaiting.map((id) => workerById(run, id)!).find((x) => x && x.sessionId === sessionId && !run.submitted.includes(x.id))
  if (!s || !w) throw new Error(`there's nothing for you to submit — the run is at step "${s?.id ?? 'end'}"${run.splitting ? ' (waiting for the lead to split it)' : ''}`)
  const summary = sub.summary.trim().split('\n')[0].slice(0, 200)
  if (!summary) throw new Error('summary must be one line saying what you found or did')
  if (s.output === 'verdict') {
    if (sub.verdict !== 'pass' && sub.verdict !== 'fail') throw new Error('this step needs a verdict: "pass" or "fail"')
    if (sub.verdict === 'fail' && !sub.findings?.length) throw new Error('a "fail" needs at least one finding')
  }
  const scope = findingScope(run, run.step)

  // Every criterion, by id.
  const wanted = criteriaFor(run, run.step)
  const given = new Map((sub.criteria ?? []).filter((c) => wanted.some((x) => x.id === c.id)).map((c) => [c.id, c]))
  const missingCrit = wanted.filter((c) => !given.has(c.id)).map((c) => c.id)
  insistOnce(run, `crit:${w.id}:${run.round}`, missingCrit, `Report every acceptance criterion by id in "criteria" — missing ${missingCrit.join(', ')}. Each: { id, status: "met" | "not met" | "partly", evidence: what you ran or saw }. Then call submit_step again.`)

  // A fix round answers for every open finding.
  const open = s.output === 'change' && run.round > 0 ? openFindings(run, scope) : []
  const answered = new Map((sub.resolutions ?? []).filter((r) => open.includes(r.id)).map((r) => [r.id, r]))
  const missingRes = open.filter((id) => !answered.has(id))
  insistOnce(run, `res:${w.id}:${run.round}`, missingRes, `Answer every open finding in "resolutions" — missing ${missingRes.join(', ')}. Each: { id, status: "fixed" | "disputed" | "deferred", note }. Then call submit_step again.`)

  const criteria: CriterionReport[] = wanted.map((c) => {
    const g = given.get(c.id)
    return g ? { id: c.id, status: g.status, evidence: (g.evidence ?? '').trim().slice(0, 600) } : { id: c.id, status: 'unreported', evidence: '' }
  })
  for (const r of answered.values()) run.findingState[r.id] = { status: r.status, note: (r.note ?? '').trim().slice(0, 400), round: run.round }

  // A pass closes what the round before left open; what it raises (or re-raises by id) is open.
  if (s.output === 'verdict' && sub.verdict === 'pass') {
    for (const id of openFindings(run, scope)) run.findingState[id] = { ...run.findingState[id], status: 'fixed', note: run.findingState[id].note ?? 'passed on re-review' }
  }
  const findings = sub.findings?.map((f) => {
    const known = f.id && f.id.startsWith(`${scope}-F`) && run.findingState[f.id] ? f.id : null
    const id = known ?? `${scope}-F${Object.keys(run.findingState).filter((k) => k.startsWith(`${scope}-F`)).length + 1}`
    run.findingState[id] = { status: 'open', round: run.round }
    return { ...f, id }
  })

  const h = record(run, {
    stepId: s.id,
    workerId: w.id,
    label: w.label,
    at,
    summary,
    body: sub.body.trim(),
    ...(s.output === 'verdict' ? { verdict: sub.verdict } : {}),
    ...(findings?.length ? { findings } : {}),
    ...(sub.files?.length ? { files: sub.files } : {}),
    ...(criteria.length ? { criteria } : {}),
    ...(sub.unsure?.trim() ? { unsure: sub.unsure.trim().slice(0, 2000) } : {}),
    ...(answered.size ? { resolutions: [...answered.values()] } : {}),
  })
  const mine = run.workerRuns.findLast((r) => r.workerId === w.id)
  if (mine && !mine.handoffId) mine.handoffId = h.id

  // What the worker learned goes on the ledger — appended, never rewritten.
  const task = s.forEach ? currentTask(run)?.id ?? null : null
  const line = (x: string) => clip(x.trim().split('\n')[0], 400)
  const add = (kind: LedgerKind, xs: string[] | undefined) => {
    for (const text of (xs ?? []).map(line).filter(Boolean).slice(0, LEDGER_CAP)) run.ledger.push({ kind, task, by: w.label, text })
  }
  for (const d of (sub.decisions ?? []).slice(0, LEDGER_CAP)) {
    const text = line(d.what ?? '')
    if (text) run.ledger.push({ kind: 'decision', task, by: w.label, text, ...(d.why?.trim() ? { why: line(d.why) } : {}) })
  }
  add('surprise', sub.surprises)
  add('failed', sub.failed)
  add('where', sub.where)
  add('verify', sub.verify)
  add('note', sub.notes)
  run.submitted.push(w.id)
  return 'Submitted. End your turn now — triage moves the run on.'
}

/** A session's turn ended: settle its submissions, nudge an awaited worker that stopped without one. */
export function turnEnded(run: TeamRun, sessionId: string): Action[] {
  if (run.state !== 'running') return []
  const mine = (id: string) => workerById(run, id)?.sessionId === sessionId
  const done = run.submitted.filter(mine)
  if (done.length) {
    run.submitted = run.submitted.filter((id) => !done.includes(id))
    run.awaiting = run.awaiting.filter((id) => !done.includes(id))
    bump(run)
    if (!run.awaiting.length && !run.splitting) return endStep(run)
    return []
  }
  const g = run.goal
  if (g?.owes && sessionId === run.leadSessionId) {
    // Waiting on your answer is not a dropped ball.
    if (g.questions.some((q) => q.answer === null)) return []
    const key = `goal:${g.owes}:${g.round}:${g.verdicts.length}:${run.resumes?.length ?? 0}`
    const text =
      g.owes === 'verdict'
        ? 'You ended your turn without calling goal_verdict. Judge the done-when now (met, not met, or wait on the world) — or, if only the user can say, ask them with ask_you.'
        : 'You ended your turn without calling goal_unstick. Decide now: retry with guidance, or skip past it — or, if only the user can decide, ask them with ask_you.'
    return nudge(run, key, { kind: 'tellLead', text })
  }
  const s = currentStep(run)
  if (!s) return []
  if (run.splitting && sessionId === run.leadSessionId) return nudge(run, `${s.id}:${run.round}:split`, { kind: 'tellLead', text: 'You ended your turn without calling split_step. Split the step now, or tell the user why you can\'t.' })
  const owed = run.awaiting.find(mine)
  if (owed) {
    const text = `You ended your turn without calling submit_step. If the step is done, call it now; if you're stuck on something only the user can decide, submit what you have and say so in the body.`
    return nudge(run, `${s.id}:${run.round}:${owed}`, workerById(run, owed)?.agent === LEAD ? { kind: 'tellLead', text } : { kind: 'tell', workerId: owed, text, fresh: false, diff: false })
  }
  return []
}

function nudge(run: TeamRun, key: string, a: Action): Action[] {
  if (run.nudged.includes(key)) return []
  run.nudged.push(key)
  return [a]
}

/** The current step is finished: loop back on a failed verdict, wait at a gate, or go on. */
export function endStep(run: TeamRun): Action[] {
  const s = currentStep(run)
  if (!s) return finish(run)
  if (s.output === 'verdict' && s.onFail) {
    const failing = stepOutputs(run, run.step).filter((o) => o.verdict === 'fail')
    if (failing.length) {
      const feedback = failing.map((o) => `Findings from ${o.label}:\n${renderFindings(o.findings ?? [])}`).join('\n\n')
      return fixOrGiveUp(run, s, feedback, `${failing.reduce((n, o) => n + (o.findings?.length ?? 0), 0)} open finding(s) from ${s.id}`)
    }
  }
  return next(run)
}

function next(run: TeamRun): Action[] {
  const s = currentStep(run)
  if (s?.gate === 'you' && run.state === 'running') {
    run.state = 'gate'
    run.reason = `step "${s.id}"${currentTask(run) && s.forEach ? ` (${currentTask(run)!.id})` : ''} is done — look it over, then continue`
    bump(run)
    return [{ kind: 'notice', text: `Needs you: step "${s.id}" is done. Look over its handoffs, then Continue.` }]
  }
  return advance(run)
}

/** On past the current step: the next step, the next task, or out of the loop. */
function advance(run: TeamRun): Action[] {
  const loop = taskLoop(run.recipe)
  if (loop && run.step === loop.to && run.task !== null) return finishTask(run, 'done')
  return beginStep(run, run.step + 1)
}

/** The current task is over — done, or unresolved past its fix rounds. Start the next, or leave the loop. */
export function finishTask(run: TeamRun, status: 'done' | 'unresolved', why?: string): Action[] {
  const loop = taskLoop(run.recipe)!
  const t = currentTask(run)!
  run.tasks[t.id] = { status, round: run.round, ...(why ? { why } : {}) }
  if (status === 'unresolved') run.unresolved = [run.unresolved, `${t.id} ${t.title}: ${why}`].filter(Boolean).join('; ')
  const out: Action[] = status === 'unresolved' ? [{ kind: 'notice', text: `${t.id} unresolved — ${why}. Moving on to the next task.` }] : []
  run.task = null
  bump(run)
  // The list is read fresh here: your edits and accepted revisions land between tasks.
  const n = run.card.tasks.findIndex((x) => (run.tasks[x.id]?.status ?? 'todo') === 'todo')
  if (n !== -1) return [...out, ...startTask(run, n), ...beginStep(run, loop.from)]
  return [...out, ...beginStep(run, loop.to + 1)]
}

/** You looked at a gated step's result: go on. */
export function continueGate(run: TeamRun, at = 0): Action[] {
  if (run.state !== 'gate') throw new Error('the run is not waiting at a gate')
  const step = currentStep(run)?.id ?? ''
  run.state = 'running'
  delete run.reason
  recordResume(run, 'you', `continued past the gate after "${step}"`, '', at)
  run.resumeMark = 'you'
  return advance(run)
}

/** triage ran the project's checks for a `checks` step. */
export function checksDone(run: TeamRun, results: CheckResult[], at: number): Action[] {
  const s = currentStep(run)
  if (!s || s.agent !== CHECKS || run.state !== 'running') return []
  const failed = results.filter((r) => !r.ok)
  record(run, {
    stepId: s.id,
    workerId: null,
    label: 'checks',
    at,
    summary: !results.length ? 'no checks configured in package.json' : failed.length ? `failed: ${failed.map((f) => f.cmd).join(', ')}` : `passed: ${results.map((r) => r.cmd).join(', ')}`,
    body: results.map((r) => `$ ${r.cmd} → ${r.ok ? 'ok' : 'FAILED'}${r.ok ? '' : `\n${r.tail}`}`).join('\n\n'),
    checks: results,
  })
  if (failed.length && s.onFail) {
    const feedback = failed.map((f) => `Failed check \`${f.cmd}\`:\n\`\`\`\n${f.tail}\n\`\`\``).join('\n\n')
    return fixOrGiveUp(run, s, feedback, `checks still failing: ${failed.map((f) => f.cmd).join(', ')}`)
  }
  return next(run)
}

/** Another fix round on the change step, or — past the cap — move on (in the loop) or straight to the report. */
function fixOrGiveUp(run: TeamRun, s: RecipeStep, feedback: string, unresolved: string): Action[] {
  const back = run.recipe.steps.findIndex((x) => x.id === s.onFail!.backTo)
  const used = run.round - (run.roundFloor ?? 0)
  if (used >= s.onFail!.max) {
    const why = `${unresolved} after ${used} fix round${used === 1 ? '' : 's'}`
    // A goal doesn't give up here: Junior decides how to get the team moving.
    if (run.goal) return stuckGoal(run, why, back, feedback)
    if (s.forEach && run.task !== null) return finishTask(run, 'unresolved', why)
    run.unresolved = why
    bump(run)
    const last = run.recipe.steps.length - 1
    const report = run.recipe.steps[last]
    if (report.agent === LEAD && report.output === 'report' && run.step < last) return beginStep(run, last)
    return finish(run)
  }
  run.round += 1
  const t = currentTask(run)
  if (t && s.forEach) run.tasks[t.id] = { ...run.tasks[t.id], round: run.round }
  run.feedback = feedback
  return [{ kind: 'notice', text: `Fix round ${used + 1} of ${s.onFail!.max}${t && s.forEach ? ` on ${t.id}` : ''}: ${unresolved}` }, ...beginStep(run, back)]
}

/** Where a run would end. A goal's run asks Junior whether the done-when holds instead. */
export function finish(run: TeamRun): Action[] {
  if (run.goal && run.state === 'running') return judge(run, null)
  return close(run)
}

export function close(run: TeamRun): Action[] {
  run.state = 'done'
  run.awaiting = []
  run.splitting = false
  bump(run)
  return [{ kind: 'finish' }]
}

/** Pause the run, remembering what it was doing so a resume goes back to it. */
export function pause(run: TeamRun, reason: string): void {
  if (run.state !== 'running' && run.state !== 'gate' && run.state !== 'waiting') throw new Error(`the run is ${run.state}`)
  run.pausedFrom = { state: run.state, ...(run.reason ? { reason: run.reason } : {}) }
  run.state = 'paused'
  run.reason = reason
  bump(run)
}

/** After a pause (yours, or the budget's): back to what it was doing, and re-send the step to whoever still owes it. */
export function resume(run: TeamRun, at = 0, what = 'resumed after a pause'): Action[] {
  if (run.state !== 'paused') throw new Error('the run is not paused')
  const from = run.pausedFrom
  run.pausedFrom = null
  recordResume(run, 'you', what, run.reason ?? '', at)
  if (from?.state === 'gate' || from?.state === 'waiting') {
    run.state = from.state
    if (from.reason) run.reason = from.reason
    else delete run.reason
    bump(run)
    return []
  }
  run.state = 'running'
  delete run.reason
  bump(run)
  // The workers still on their step carry on: their run is resumed, not a new one.
  for (const id of run.awaiting) {
    const r = run.workerRuns.findLast((x) => x.workerId === id)
    if (r && !r.handoffId) r.resumedBy = 'you'
  }
  if (run.goal?.owes) return [{ kind: 'tellLead', text: run.goal.owes === 'verdict' ? verdictMessage(run, null) : unstickMessage(run) }]
  const s = currentStep(run)
  if (!s) return finish(run)
  if (s.agent === CHECKS) return [{ kind: 'checks' }]
  if (run.splitting) return [{ kind: 'tellLead', text: splitMessage(run, s) }]
  // Submissions made before the pause still count.
  const actions: Action[] = []
  for (const id of [...run.submitted]) actions.push(...turnEnded(run, workerById(run, id)!.sessionId!))
  if (actions.length || run.state !== 'running' || currentStep(run) !== s) return actions
  return run.awaiting.map((id) => {
    const w = workerById(run, id)!
    const text = 'The run was paused and is now resumed. Carry on with your step where you left off, and finish with submit_step.'
    return w.agent === LEAD ? { kind: 'tellLead' as const, text } : { kind: 'tell' as const, workerId: id, text, fresh: false, diff: false as const }
  })
}

/** The lead proposed a change to the tasks still to do. It waits for your OK; the run carries on meanwhile. */
export function proposeRevision(run: TeamRun, raw: unknown, why: string): Action[] {
  if (run.state === 'proposed' || run.state === 'done' || run.state === 'stopped') throw new Error('only a running plan can be revised — before approval, propose the card again')
  if (!taskLoop(run.recipe)) throw new Error('this team has no task list to revise')
  // Validate against a copy: nothing changes until you accept.
  const probe = { ...run, card: { ...run.card } } as TeamRun
  const tasks = editTasks(probe, raw)
  run.revision = { tasks, why: why.trim().slice(0, 600) }
  bump(run)
  return [{ kind: 'notice', text: `Needs you: the lead proposes a change to the plan — ${run.revision.why || 'see the plan'}` }]
}

/** You accepted (or turned down) the lead's revision. Accepted, it lands at the next task boundary. */
export function settleRevision(run: TeamRun, accept: boolean): Action[] {
  if (!run.revision) throw new Error('there is no plan change waiting')
  const r = run.revision
  run.revision = null
  if (accept) editTasks(run, r.tasks)
  bump(run)
  return [
    { kind: 'notice', text: accept ? 'Plan change accepted — it applies from the next task.' : 'Plan change turned down.' },
    { kind: 'tellLead', text: accept ? 'The user accepted your plan change.' : 'The user turned down your plan change. Carry on with the plan as it is.' },
  ]
}
