/**
 * Goals on team runs (core/teams/engine.ts, .docs/junior-goals-teams/modes-autonomy-goals.md):
 * a run with a done-when. Junior judges it where the run would end, gets a
 * stuck team moving where it would give up, sleeps on the world, and asks you
 * questions; a gate and a budget pause still wait for you. Every resume is
 * recorded with who did it. No server, no clock: time is an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipe, type TeamRecipe } from '../core/teams/recipe.js'
import { renderPlan } from '../core/teams/plan.js'
import { renderLedger } from '../core/teams/files.js'
import {
  acceptGoal,
  answerQuestion,
  approve,
  askYou,
  cardFrom,
  checksDone,
  continueGate,
  criteriaFor,
  endOfDay,
  goalFrom,
  goalOverdue,
  goalVerdict,
  normalizeRun,
  openFindings,
  pause,
  reopenGoal,
  resume,
  submit,
  turnEnded,
  unstick,
  wake,
  wakeDue,
  type Action,
  type Submission,
  type TeamRun,
} from '../core/teams/engine.js'
import { SHIPPED_RECIPES } from '../server/team-recipes.js'

const LEAD_SID = 'lead-session'
const NOW = new Date(2026, 9, 17, 10, 0).getTime()
const recipeOf = (name: string): TeamRecipe => parseRecipe(name, SHIPPED_RECIPES[name]).recipe!

function goalRun(recipe: TeamRecipe, cardRaw: Record<string, unknown> = {}, goalRaw: Record<string, unknown> = {}): TeamRun {
  const card = cardFrom({ goal: 'Totals include discount codes', criteria: ['a discounted cart shows the lower total'], permissions: 'local', ...cardRaw }, recipe)
  return normalizeRun({
    id: 'r1',
    itemId: 'manual:1',
    title: 'Cart totals',
    createdAt: 0,
    team: 'x',
    recipe,
    card,
    agents: ['implementer', 'reviewer', 'code-reviewer'].map((name) => ({ name, label: name[0].toUpperCase() + name.slice(1), color: 'blue', model: null, effort: null, prompt: '', can: ['read', 'run'] })),
    leadSessionId: LEAD_SID,
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
    rev: 0,
    nudged: [],
    goal: goalFrom({ doneWhen: 'the discount PR is merged with checks green', horizon: 'until_done', ...goalRaw }, NOW),
  })
}

function spawn(run: TeamRun, actions: Action[]): Action[] {
  for (const a of actions) {
    if (a.kind !== 'tell') continue
    const w = run.workers.find((x) => x.id === a.workerId)!
    w.sessionId ??= `s-${w.id}`
  }
  return actions
}
const kinds = (as: Action[]) => as.map((a) => (a.kind === 'tell' ? `tell ${a.workerId}` : a.kind))
const tells = (as: Action[]) => as.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell')
const leadText = (as: Action[]) => as.filter((a): a is Extract<Action, { kind: 'tellLead' }> => a.kind === 'tellLead').map((a) => a.text).join('\n')
const sid = (run: TeamRun, workerId: string) => run.workers.find((w) => w.id === workerId)!.sessionId!

function complete(run: TeamRun, sub: Submission): Submission {
  const step = run.recipe.steps[run.step]
  const scope = step.forEach ? run.card.tasks[run.task ?? 0]?.id ?? 'R' : 'R'
  return {
    criteria: criteriaFor(run, run.step).map((c) => ({ id: c.id, status: 'met' as const, evidence: 'ran it' })),
    ...(step.output === 'change' && run.round > 0 ? { resolutions: openFindings(run, scope).map((id) => ({ id, status: 'fixed' as const, note: 'done' })) } : {}),
    ...sub,
  }
}
function hand(run: TeamRun, workerId: string, sub: Submission = { summary: 'done', body: 'did it' }): Action[] {
  const s = sid(run, workerId)
  submit(run, s, complete(run, sub), 1)
  return spawn(run, turnEnded(run, s))
}
const FAIL: Submission = { summary: 'no', body: '', verdict: 'fail', findings: [{ severity: 'P0', where: 'cart.ts:12', problem: 'code ignored', fix: 'apply it' }] }

/** Solo through one clean round, up to where a plain run would finish. */
function soloRound(run: TeamRun): Action[] {
  hand(run, 'build:1')
  spawn(run, checksDone(run, [], 2))
  return hand(run, 'verify:1', { summary: 'holds', body: '', verdict: 'pass' })
}

test('the goal on the card: a done-when, a horizon pinned to a day', () => {
  const g = goalFrom({ doneWhen: '  PR merged  ', horizon: 'today' }, NOW)
  assert.equal(g.doneWhen, 'PR merged')
  assert.deepEqual(g.horizon, { kind: 'today', at: endOfDay(NOW) })
  assert.deepEqual(goalFrom({ doneWhen: 'x', horizon: 'by', by: '2026-10-24' }, NOW).horizon, { kind: 'by', at: new Date(2026, 9, 24, 23, 59, 59, 999).getTime() })
  assert.deepEqual(goalFrom({ doneWhen: 'x' }, NOW).horizon, { kind: 'until_done', at: null })
  assert.throws(() => goalFrom({ horizon: 'today' }, NOW), /needs a done-when/)
  assert.throws(() => goalFrom({ doneWhen: 'x', horizon: 'by' }, NOW), /needs a date/)
  // An edit that leaves today alone keeps the day it was set.
  assert.equal(goalFrom({ doneWhen: 'y' }, NOW + 86_400_000, g).horizon.at, endOfDay(NOW))
  const run = goalRun(recipeOf('solo'), {}, { horizon: 'today' })
  run.state = 'running'
  assert.equal(goalOverdue(run, NOW), false)
  assert.equal(goalOverdue(run, endOfDay(NOW) + 1), true)
})

test('where a run would finish, Junior judges the done-when; met closes it and you accept', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  const a = soloRound(run)
  assert.deepEqual(kinds(a), ['notice', 'tellLead'])
  assert.equal(run.state, 'running', 'judging is not done')
  assert.equal(run.goal!.owes, 'verdict')
  assert.match(leadText(a), /## Done when \(until done\)\nthe discount PR is merged/)
  assert.match(leadText(a), /goal_verdict/)

  // The lead ends its turn without a verdict: nudged once.
  assert.deepEqual(kinds(turnEnded(run, LEAD_SID)), ['tellLead'])
  assert.deepEqual(turnEnded(run, LEAD_SID), [])

  assert.throws(() => goalVerdict(run, { met: true, evidence: '  ' }, 5), /evidence/)
  assert.throws(() => goalVerdict(run, { met: true, evidence: 'x', waitFor: 'CI', waitMinutes: 5 }, 5), /nothing to wait for/)
  const done = goalVerdict(run, { met: true, evidence: 'gh pr view: merged, checks green' }, 5)
  assert.deepEqual(kinds(done), ['notice', 'finish'])
  assert.equal(run.state, 'done')
  assert.equal(run.goal!.owes, null)
  assert.deepEqual(run.goal!.verdicts, [{ at: 5, met: true, evidence: 'gh pr view: merged, checks green', round: 0 }])
  assert.throws(() => goalVerdict(run, { met: true, evidence: 'again' }, 6), /the run is done/)

  assert.deepEqual(kinds(acceptGoal(run, 7)), ['notice'])
  assert.equal(run.goal!.acceptedAt, 7)
  assert.throws(() => acceptGoal(run, 8), /already accepted/)
  assert.throws(() => reopenGoal(run, 'more', 8), /accepted goal is closed/)
})

test('not met: another round on the change step, with the gap — resumed by Junior, on the ledger', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  soloRound(run)
  const runsBefore = run.workerRuns.length
  const r2 = spawn(run, goalVerdict(run, { met: false, evidence: 'the PR is open, not merged', gap: 'the empty-cart case still throws' }, 10))
  assert.deepEqual(kinds(r2), ['notice', 'tell build:1'])
  assert.equal(run.goal!.round, 1)
  assert.match(tells(r2)[0].text, /## Goal round 2 — what's still missing\nthe empty-cart case still throws/)
  assert.match(tells(r2)[0].text, /The goal's done-when isn't met yet: the empty-cart case still throws/)
  assert.deepEqual(run.resumes, [{ at: 10, by: 'junior', what: 'started goal round 2', why: 'the empty-cart case still throws' }])
  assert.deepEqual(run.ledger.at(-1), { kind: 'resume', task: null, by: 'Junior', text: 'started goal round 2', why: 'the empty-cart case still throws', at: 10 })
  assert.equal(run.workerRuns.length, runsBefore + 1, 'a new run, not a reused one')
  assert.equal(run.workerRuns.at(-1)!.resumedBy, 'junior')

  // The next step's run is the team's own doing again.
  hand(run, 'build:1')
  spawn(run, checksDone(run, [], 11))
  assert.equal(run.workerRuns.at(-1)!.resumedBy, undefined)
  // A fresh set of fix rounds for the round: two more before it's stuck.
  assert.deepEqual(kinds(hand(run, 'verify:1', FAIL)), ['notice', 'tell build:1'])
})

test('fix rounds used up: Junior gets the team moving — retry with guidance, no cap on how often', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  let last: Action[] = []
  for (let r = 0; r < 3; r++) {
    hand(run, 'build:1')
    spawn(run, checksDone(run, [], 2))
    last = hand(run, 'verify:1', FAIL)
  }
  assert.deepEqual(kinds(last), ['notice', 'tellLead'], 'a goal does not give up at the cap')
  assert.equal(run.goal!.owes, 'unstick')
  assert.equal(run.unresolved, null)
  assert.match(leadText(last), /stuck: 1 open finding\(s\) from verify after 2 fix rounds/)
  assert.match(leadText(last), /\[P0\] cart\.ts:12 — code ignored/)
  assert.throws(() => submit(run, sid(run, 'build:1'), { summary: 'x', body: '' }, 3), /nothing for you to submit/)

  assert.throws(() => unstick(run, { action: 'retry', why: '' }, 4), /say why/)
  const go = spawn(run, unstick(run, { action: 'retry', why: 'the fixer patched the symptom', guidance: 'apply the code in applyDiscount, not in the view' }, 4))
  assert.deepEqual(kinds(go), ['notice', 'tell build:1'])
  assert.match(tells(go)[0].text, /### Junior's guidance for this round\napply the code in applyDiscount/)
  assert.equal(run.workerRuns.at(-1)!.resumedBy, 'junior')
  assert.equal(run.resumes!.at(-1)!.what, 'retried after: 1 open finding(s) from verify after 2 fix rounds')
  assert.throws(() => unstick(run, { action: 'retry', why: 'x' }, 5), /not stuck/)

  // The retry gets its own fix rounds; past them it's stuck again, and Junior can go again.
  for (let r = 0; r < 3; r++) {
    hand(run, 'build:1')
    spawn(run, checksDone(run, [], 6))
    last = hand(run, 'verify:1', FAIL)
  }
  assert.deepEqual(kinds(last), ['notice', 'tellLead'])
  assert.deepEqual(kinds(spawn(run, unstick(run, { action: 'retry', why: 'again' }, 7))), ['notice', 'tell build:1'])
  assert.equal(new Set(run.workerRuns.map((r) => r.id)).size, run.workerRuns.length, 'every run keeps its own id')
})

test('failing checks past the cap stick the same way; skip moves on with it unresolved', () => {
  const run = goalRun(recipeOf('build'), { tasks: [{ title: 'Field' }, { title: 'Checkout' }] })
  spawn(run, approve(run, run.card))
  let last: Action[] = []
  for (let r = 0; r < 3; r++) {
    hand(run, 'build:T1:1')
    last = spawn(run, checksDone(run, [{ cmd: 'npm test', ok: false, tail: 'boom' }], 2))
  }
  assert.deepEqual(kinds(last), ['notice', 'tellLead'])
  assert.match(leadText(last), /stuck on T1 Field: checks still failing: npm test after 2 fix rounds/)
  const skip = spawn(run, unstick(run, { action: 'skip', why: 'needs a fixture only you have' }, 3))
  assert.equal(run.tasks.T1.status, 'unresolved')
  assert.match(run.tasks.T1.why!, /skipped: needs a fixture only you have/)
  assert.deepEqual(kinds(skip), ['notice', 'snapshot', 'notice', 'tell build:T2:1'])
  assert.equal(run.workerRuns.at(-1)!.resumedBy, 'junior')
})

test('not met on a task-loop team: the next round works new tasks', () => {
  const run = goalRun(recipeOf('build'), { tasks: [{ title: 'Field' }] })
  spawn(run, approve(run, run.card))
  hand(run, 'build:T1:1')
  spawn(run, checksDone(run, [], 2))
  hand(run, 'verify:T1:1', { summary: 'ok', body: '', verdict: 'pass' })
  hand(run, 'final:1', { summary: 'ok', body: '', verdict: 'pass' })
  const judged = hand(run, 'report:1', { summary: 'report', body: 'all done' })
  assert.deepEqual(kinds(judged), ['notice', 'tellLead'])
  assert.match(leadText(judged), /the tasks the next round works/)
  const r2 = spawn(run, goalVerdict(run, { met: false, evidence: 'no CSV export', tasks: [{ title: 'CSV export', criteria: ['a download has the totals'] }] }, 9))
  assert.deepEqual(run.card.tasks.map((t) => t.id), ['T1', 'T2'])
  assert.equal(run.tasks.T1.status, 'done', 'what was done stays done')
  assert.deepEqual(kinds(r2), ['notice', 'snapshot', 'notice', 'tell build:T2:1'])
  assert.match(tells(r2)[0].text, /### Your task: T2 CSV export\nDone when:\n- T2.1 a download has the totals/)
  assert.throws(() => goalVerdict(run, { met: false, evidence: 'x', tasks: [] }, 10), /triage has not asked/)
})

test('waiting on the world: asleep until the time, then Junior looks again; a pause keeps the wait', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  soloRound(run)
  assert.throws(() => goalVerdict(run, { met: false, evidence: 'CI running', waitFor: 'CI' }, 10), /waitMinutes/)
  const w = goalVerdict(run, { met: false, evidence: 'PR open, CI running', waitFor: 'CI on the PR', waitMinutes: 20 }, 10)
  assert.deepEqual(kinds(w), ['notice'])
  assert.equal(run.state, 'waiting')
  assert.equal(run.reason, 'waiting for CI on the PR')
  assert.deepEqual(run.goal!.wait, { until: 10 + 20 * 60_000, for: 'CI on the PR' })

  assert.equal(wakeDue(run, 10 + 19 * 60_000), false)
  assert.deepEqual(wake(run, 10 + 19 * 60_000), [], 'not yet')
  pause(run, 'paused by you')
  assert.deepEqual(resume(run, 11), [])
  assert.equal(run.state, 'waiting', 'a resume goes back to the wait')
  assert.equal(run.reason, 'waiting for CI on the PR')

  assert.equal(wakeDue(run, 10 + 20 * 60_000), true)
  const look = wake(run, 10 + 20 * 60_000)
  assert.deepEqual(kinds(look), ['notice', 'tellLead'])
  assert.match(leadText(look), /it was waiting for CI on the PR/)
  assert.equal(run.state, 'running')
  assert.equal(run.goal!.owes, 'verdict')
  assert.equal(run.goal!.wait, null)
})

test('you can wake a waiting goal early', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  soloRound(run)
  goalVerdict(run, { met: false, evidence: 'review pending', waitFor: 'a review', waitMinutes: 600 }, 10)
  assert.match(leadText(wake(run, 11, true)), /you woke it early; it was waiting for a review/)
})

test('questions: Junior asks with a recommended answer; your answer goes to the lead; no nudge while it waits on you', () => {
  const run = goalRun(recipeOf('solo'))
  assert.throws(() => askYou(run, 'q', 'r', 1), /proposed/)
  spawn(run, approve(run, run.card))
  soloRound(run)
  assert.throws(() => askYou(run, 'Which branch?', ' ', 2), /recommend/)
  const q = askYou(run, 'Merge into main or release?', 'main — release is frozen', 2)
  assert.equal(q.id, 'Q1')
  assert.deepEqual(kinds(q.actions), ['notice'])
  assert.deepEqual(turnEnded(run, LEAD_SID), [], 'waiting on your answer is not a dropped ball')
  const a = answerQuestion(run, 'Q1', 'main', 3)
  assert.match(leadText(a), /answered your question Q1 \("Merge into main or release\?"\):\n\nmain Then judge the done-when with goal_verdict/)
  assert.deepEqual(run.goal!.questions[0], { id: 'Q1', text: 'Merge into main or release?', recommended: 'main — release is frozen', at: 2, answer: 'main', answeredAt: 3 })
  assert.throws(() => answerQuestion(run, 'Q1', 'again', 4), /already answered/)
  assert.throws(() => answerQuestion(run, 'Q9', 'x', 4), /no such question/)
})

test('a gate still waits for you: Junior can\'t pass it; continuing it is your resume', () => {
  const recipe = parseRecipe('g', `---\nsteps:\n  - id: research\n    agent: researcher\n    output: notes\n    gate: you\n  - id: write\n    agent: lead\n    output: report\n---\n`).recipe!
  const run = goalRun(recipe)
  run.agents.push({ name: 'researcher', label: 'Researcher', color: 'blue', model: null, effort: null, prompt: '', can: ['read'] })
  spawn(run, approve(run, run.card))
  hand(run, 'research:1', { summary: 'found it', body: '' })
  assert.equal(run.state, 'gate')
  assert.throws(() => goalVerdict(run, { met: true, evidence: 'x' }, 2), /the run is gate/)
  assert.throws(() => unstick(run, { action: 'retry', why: 'x' }, 2), /the run is gate/)
  // A question is fine while it waits.
  askYou(run, 'Is the research enough?', 'yes', 2)
  // Paused at the gate, a resume goes back to the gate — it doesn't skip it.
  pause(run, 'paused by you')
  assert.deepEqual(resume(run, 3), [])
  assert.equal(run.state, 'gate')
  assert.match(run.reason!, /step "research" is done/)
  assert.deepEqual(kinds(continueGate(run, 4)), ['tell write:1'])
  assert.equal(run.resumes!.at(-1)!.by, 'you')
  assert.equal(run.resumes!.at(-1)!.what, 'continued past the gate after "research"')
  assert.equal(run.workerRuns.at(-1)!.resumedBy, 'you')
})

test('a budget pause: only your resume lifts it; the workers carry on in the same run, marked resumed by you', () => {
  const run = goalRun(recipeOf('build'))
  spawn(run, approve(run, run.card))
  pause(run, 'budget reached — $10.00 of $10.00')
  assert.throws(() => askYou(run, 'raise it?', 'yes', 1).actions && goalVerdict(run, { met: true, evidence: 'x' }, 1), /the run is paused/)
  const before = run.workerRuns.length
  const a = resume(run, 5, 'raised the budget to $15.00 and resumed')
  assert.deepEqual(kinds(a), ['tell build:T1:1'])
  assert.equal(run.workerRuns.length, before, 'more of the same run, not a new one')
  assert.equal(run.workerRuns.at(-1)!.resumedBy, 'you')
  assert.deepEqual(run.resumes!.at(-1), { at: 5, by: 'you', what: 'raised the budget to $15.00 and resumed', why: 'budget reached — $10.00 of $10.00' })
})

test('a pause while Junior owes a verdict: the resume asks it again', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  soloRound(run)
  pause(run, 'paused by you')
  assert.match(leadText(resume(run, 3)), /goal_verdict/)
})

test('you say it is not done: reopened as another round, resumed by you', () => {
  const run = goalRun(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  soloRound(run)
  goalVerdict(run, { met: true, evidence: 'merged' }, 5)
  assert.throws(() => reopenGoal(run, ' ', 6), /what's missing/)
  const r = spawn(run, reopenGoal(run, 'the changelog is missing', 6))
  assert.deepEqual(kinds(r), ['notice', 'tell build:1'])
  assert.equal(run.state, 'running')
  assert.deepEqual(run.resumes!.at(-1), { at: 6, by: 'you', what: 'started goal round 2', why: 'the changelog is missing' })
  assert.equal(run.goal!.verdicts.at(-1)!.evidence, 'You: the changelog is missing')
})

test('a plain team run is untouched: it still gives up at the cap and finishes without a verdict', () => {
  const run = goalRun(recipeOf('solo'))
  run.goal = null
  spawn(run, approve(run, run.card))
  assert.deepEqual(kinds(soloRound(run)), ['finish'])
  assert.throws(() => goalVerdict(run, { met: true, evidence: 'x' }, 1), /not a goal/)
})

test('the run folder shows the goal, the verdicts, the questions and every resume', () => {
  const run = goalRun(recipeOf('solo'), {}, { horizon: 'by', by: '2026-10-24' })
  spawn(run, approve(run, run.card))
  soloRound(run)
  askYou(run, 'Squash?', 'yes', NOW)
  goalVerdict(run, { met: false, evidence: 'not merged', gap: 'merge it' }, NOW)
  const plan = renderPlan(run)
  assert.match(plan, /^goal, round 2 · Solo team · running/m)
  assert.match(plan, /## The goal is done when\nthe discount PR is merged with checks green\n\nHorizon: by Sat 24 Oct · round 2/)
  assert.match(plan, /## Junior's verdicts\n- .* · round 1 · not met — not merged/)
  assert.match(plan, /## Questions for you\n- \*\*Q1\*\* Squash\?\n  Recommended: yes\n  _Waiting for your answer._/)
  assert.match(plan, /## Acceptance criteria\n- a discounted cart/)
  const ledger = renderLedger(run)
  assert.match(ledger, /## Resumes — who got the team moving again, and why\n- 2026-10-17 \d\d:\d\d · started goal round 2 — because merge it _\(Junior\)_/)
})
