/**
 * The team run engine (core/teams/engine.ts): a run moved through the shipped
 * recipes by hand — approve, submissions, turn ends, checks — asserting the
 * actions triage would carry out. No server, no clock: time is an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipe, type TeamRecipe } from '../core/teams/recipe.js'
import { renderPlan } from '../core/teams/plan.js'
import { runFiles } from '../core/teams/files.js'
import {
  approve,
  backfillRuns,
  STEP_MESSAGE,
  cardFrom,
  editTasks,
  normalizeRun,
  proposeRevision,
  settleRevision,
  checksDone,
  continueGate,
  recipeFromRun,
  resume,
  runStatus,
  split,
  stampRun,
  submit,
  turnEnded,
  criteriaFor,
  openFindings,
  type Action,
  type Submission,
  type TeamRun,
} from '../core/teams/engine.js'
import { SHIPPED_RECIPES } from '../server/team-recipes.js'

const LEAD_SID = 'lead-session'
const recipeOf = (name: string): TeamRecipe => parseRecipe(name, SHIPPED_RECIPES[name]).recipe!

function runOf(recipe: TeamRecipe, cardRaw: Record<string, unknown> = {}): TeamRun {
  const card = cardFrom({ goal: 'Totals include discount codes', criteria: ['a discounted cart shows the lower total'], permissions: 'local', ...cardRaw }, recipe)
  return {
    id: 'r1',
    itemId: 'manual:1',
    title: 'Cart totals',
    createdAt: 0,
    team: 'x',
    recipe,
    card,
    agents: ['implementer', 'reviewer', 'code-reviewer', 'validator', 'investigator', 'researcher'].map((name) => ({
      name,
      label: name[0].toUpperCase() + name.slice(1),
      color: 'blue',
      model: null,
      effort: null,
      prompt: `You are the ${name}.`,
      can: ['read', 'run'],
    })),
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
  }
}

/** Give every worker the engine asked to message a session id, the way the server does on spawn. */
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
const sid = (run: TeamRun, workerId: string) => run.workers.find((w) => w.id === workerId)!.sessionId!

/** A dutiful worker: every criterion reported met, every open finding fixed — unless the test says otherwise. */
function complete(run: TeamRun, sub: Submission): Submission {
  const step = run.recipe.steps[run.step]
  const scope = step.forEach ? run.card.tasks[run.task ?? 0]?.id ?? 'R' : 'R'
  return {
    criteria: criteriaFor(run, run.step).map((c) => ({ id: c.id, status: 'met' as const, evidence: 'ran it' })),
    ...(step.output === 'change' && run.round > 0 ? { resolutions: openFindings(run, scope).map((id) => ({ id, status: 'fixed' as const, note: 'done' })) } : {}),
    ...sub,
  }
}

/** submit + the turn ending, as one worker finishing its step. */
function hand(run: TeamRun, workerId: string, sub: Parameters<typeof submit>[2] = { summary: 'done', body: 'did it' }): Action[] {
  const s = sid(run, workerId)
  submit(run, s, complete(run, sub), 1)
  return spawn(run, turnEnded(run, s))
}

test('Solo: the lead builds, checks pass, a fresh checker passes it, the run finishes', () => {
  const run = runOf(recipeOf('solo'))
  const a = spawn(run, approve(run, run.card))
  assert.deepEqual(kinds(a), ['snapshot', 'notice', 'tell build:1'])
  assert.deepEqual(run.card.tasks, [], 'Solo has no task loop')
  assert.equal(run.workers[0].sessionId, LEAD_SID, 'the lead builds in its own session')
  assert.match(tells(a)[0].text, /## Done when\n- C1 a discounted cart/)
  assert.equal(tells(a)[0].diff, false)

  assert.deepEqual(kinds(hand(run, 'build:1', { summary: 'added applyDiscount', body: 'cart.ts', files: ['cart.ts'] })), ['checks'])
  const v = spawn(run, checksDone(run, [{ cmd: 'npm run typecheck', ok: true, tail: '' }], 2))
  assert.deepEqual(kinds(v), ['tell verify:1'])
  assert.equal(tells(v)[0].diff, 'run', 'the checker reads the diff, never the builder\'s transcript')
  assert.equal(tells(v)[0].fresh, false)
  assert.match(tells(v)[0].text, /Lead — added applyDiscount/)
  assert.match(tells(v)[0].text, /checks — passed: npm run typecheck/)

  assert.deepEqual(kinds(hand(run, 'verify:1', { summary: 'all criteria hold', body: 'ran the tests', verdict: 'pass' })), ['finish'])
  assert.equal(run.state, 'done')
  assert.equal(run.unresolved, null)
})

test('Solo: failed checks and a failed verdict loop back to the lead, then give up at the cap', () => {
  const run = runOf(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  hand(run, 'build:1')
  const fix1 = spawn(run, checksDone(run, [{ cmd: 'npm run lint', ok: false, tail: 'no-unused-vars' }], 2))
  assert.deepEqual(kinds(fix1), ['notice', 'tell build:1'])
  assert.equal(run.round, 1)
  assert.match(tells(fix1)[0].text, /## Fix round 1[\s\S]*no-unused-vars/)

  hand(run, 'build:1')
  const v = spawn(run, checksDone(run, [{ cmd: 'npm run lint', ok: true, tail: '' }], 3))
  assert.equal(tells(v)[0].fresh, true, 'a checker re-reads from scratch after a fix round')
  const fail = { summary: 'total ignores codes', body: 'ran it', verdict: 'fail' as const, findings: [{ severity: 'P0' as const, where: 'cart.ts:12', problem: 'code ignored', fix: 'apply it' }] }
  const fix2 = hand(run, 'verify:1', fail)
  assert.deepEqual(kinds(fix2), ['notice', 'tell build:1'])
  assert.match(tells(fix2)[0].text, /\[P0\] cart\.ts:12 — code ignored/)

  hand(run, 'build:1')
  spawn(run, checksDone(run, [], 4))
  assert.deepEqual(kinds(hand(run, 'verify:1', fail)), ['finish'], 'past two rounds: no third, the run ends')
  assert.match(run.unresolved!, /1 open finding\(s\) from verify after 2 fix rounds/)
})

test('Build runs task by task: fresh contexts, notes travel, per-task diffs, final review, report', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'Add the discount field', criteria: ['the cart stores a code'] }, { title: 'Apply codes at checkout' }] })
  assert.deepEqual(run.card.tasks.map((t) => t.id), ['T1', 'T2'])
  const a = spawn(run, approve(run, run.card))
  assert.deepEqual(kinds(a), ['snapshot', 'notice', 'snapshot', 'notice', 'tell build:T1:1'])
  assert.deepEqual(a.filter((x) => x.kind === 'snapshot').map((x) => (x as { scope: string }).scope), ['run', 'task'])
  assert.equal(tells(a)[0].fresh, false, 'the first task needs no reset')
  assert.match(tells(a)[0].text, /### Your task: T1 Add the discount field\nDone when:\n- T1.1 the cart stores a code/)
  assert.match(tells(a)[0].text, /- \[~\] T1 Add the discount field   ← yours\n- \[ \] T2 Apply codes at checkout/)
  assert.equal(run.tasks.T1.status, 'running')

  assert.deepEqual(kinds(hand(run, 'build:T1:1', { summary: 'field added', body: '', notes: ['the cart store is async — await it'] })), ['checks'])
  assert.deepEqual(run.ledger, [{ kind: 'note', task: 'T1', by: 'Implementer', text: 'the cart store is async — await it' }])
  const v = spawn(run, checksDone(run, [], 1))
  assert.deepEqual(kinds(v), ['tell verify:T1:1'])
  assert.equal(tells(v)[0].diff, 'task', 'a task\'s reviewer reads that task\'s diff only')

  const t2 = spawn(run, hand(run, 'verify:T1:1', { summary: 'holds', body: '', verdict: 'pass' }))
  assert.deepEqual(kinds(t2), ['snapshot', 'notice', 'tell build:T2:1'])
  assert.equal(run.tasks.T1.status, 'done')
  assert.equal(tells(t2)[0].fresh, true, 'every task starts in a clean context')
  assert.equal(sid(run, 'build:T2:1'), sid(run, 'build:T1:1'), 'but in the same Implementer session')
  assert.match(tells(t2)[0].text, /## Learned so far\n- T1 · the cart store is async — await it/)
  assert.doesNotMatch(tells(t2)[0].text, /## Done when/, 'the card\'s criteria are for the final review')

  // T2 fails past its two fix rounds: it's unresolved and the run moves on (out of the loop: the final review).
  const fail = { summary: 'no', body: '', verdict: 'fail' as const, findings: [{ severity: 'P0' as const, where: 'x', problem: 'p', fix: 'f' }] }
  let last: Action[] = []
  for (let r = 0; r < 3; r++) {
    hand(run, 'build:T2:1')
    spawn(run, checksDone(run, [], 2))
    last = hand(run, 'verify:T2:1', fail)
  }
  assert.equal(run.tasks.T2.status, 'unresolved')
  assert.deepEqual(kinds(last), ['notice', 'tell final:1'])
  assert.equal(tells(last)[0].diff, 'run', 'the final review reads the whole run')
  assert.match(tells(last)[0].text, /## Done when\n- C1 a discounted cart/)
  assert.match(tells(last)[0].text, /\[!\] T2 Apply codes at checkout — unresolved/)
  const rep = hand(run, 'final:1', { summary: 'seams hold', body: '', verdict: 'pass' })
  assert.deepEqual(kinds(rep), ['tell report:1'])
  assert.match(tells(rep)[0].text, /## Unresolved\nT2 Apply codes at checkout: 1 open finding\(s\) from verify after 2 fix rounds/)
  assert.deepEqual(kinds(hand(run, 'report:1', { summary: 'mostly', body: '# Done' })), ['finish'])
})

test('context: carry keeps the implementer\'s context across tasks; the reviewer still starts clean', () => {
  const build = recipeOf('build')
  build.steps[0] = { ...build.steps[0], context: 'carry' }
  const run = runOf(build, { tasks: [{ title: 'a' }, { title: 'b' }] })
  spawn(run, approve(run, run.card))
  hand(run, 'build:T1:1')
  spawn(run, checksDone(run, [], 1))
  const t2 = spawn(run, hand(run, 'verify:T1:1', { summary: 'ok', body: '', verdict: 'pass' }))
  assert.equal(tells(t2)[0].fresh, false)
  hand(run, 'build:T2:1')
  assert.equal(tells(spawn(run, checksDone(run, [], 2)))[0].fresh, true)
})

test('the plan changes between tasks: your edits and the lead\'s accepted revision; started tasks stay put', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a' }, { title: 'b' }] })
  spawn(run, approve(run, run.card))
  assert.throws(() => editTasks(run, [{ id: 'T2', title: 'b' }]), /T1 has already started/)
  editTasks(run, [{ id: 'T1', title: 'a' }, { title: 'new first' }, { id: 'T2', title: 'b, renamed' }])
  assert.deepEqual(run.card.tasks.map((t) => [t.id, t.title]), [['T1', 'a'], ['T3', 'new first'], ['T2', 'b, renamed']])

  assert.deepEqual(kinds(proposeRevision(run, [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b, renamed' }], 'T3 is already covered')), ['notice'])
  assert.equal(run.card.tasks.length, 3, 'nothing changes until you accept')
  assert.deepEqual(kinds(settleRevision(run, true)), ['notice', 'tellLead'])
  assert.deepEqual(run.card.tasks.map((t) => t.id), ['T1', 'T2'])
  assert.throws(() => settleRevision(run, true), /no plan change waiting/)

  hand(run, 'build:T1:1')
  spawn(run, checksDone(run, [], 1))
  const next = spawn(run, hand(run, 'verify:T1:1', { summary: 'ok', body: '', verdict: 'pass' }))
  assert.match(tells(next)[0].text, /### Your task: T2 b, renamed/)
})

test('tasks only on a team with a loop; a loop with none given makes the goal its one task', () => {
  assert.throws(() => cardFrom({ goal: 'g', criteria: ['c'], tasks: [{ title: 'a' }, { title: 'b' }] }, recipeOf('solo')), /no task loop/)
  assert.deepEqual(cardFrom({ goal: 'Do the thing', criteria: ['c'] }, recipeOf('build')).tasks, [{ id: 'T1', title: 'Do the thing', criteria: [] }])
  assert.throws(() => cardFrom({ goal: 'g', criteria: ['c'], tasks: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}` })) }, recipeOf('build')), /at most 8 tasks/)
})

test('the plan renders from the run: status, tasks with marks, notes, decisions, outcome', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a', criteria: ['x works'] }, { title: 'b' }], decisions: ['codes don\'t stack'], note: 'Two tasks.' })
  assert.match(renderPlan(run), /^# Plan · Cart totals\n\nBuild team · proposed — waiting for your approval · cap \$10\.00/)
  spawn(run, approve(run, run.card))
  hand(run, 'build:T1:1', { summary: 's', body: '', notes: ['money is in cents'] })
  const md = renderPlan(run)
  assert.match(md, /Build team · running · task 1 of 2/)
  assert.match(md, /- \[~\] \*\*T1\*\* a — checks\n  - x works\n- \[ \] \*\*T2\*\* b/)
  assert.match(md, /## Decisions\n- codes don't stack/)
  assert.match(md, /## Decided along the way\n- T1 · money is in cents/)
  assert.match(md, /↻ build \(Implementer\) → ↻ checks \(checks\) → ↻ verify \(Reviewer · sonnet\)|↻ build/)
  assert.doesNotMatch(md, /## Outcome/)
  run.state = 'stopped'
  assert.match(renderPlan(run), /## Outcome\nStopped before the end\./)
})

test('Review: the lead splits by area, triage splits the findings itself, the lead reports on everything', () => {
  const run = runOf(recipeOf('review'))
  const a = approve(run, run.card)
  assert.deepEqual(kinds(a), ['snapshot', 'notice', 'tellLead'])
  assert.equal(run.splitting, true)
  assert.throws(() => submit(run, LEAD_SID, { summary: 'x', body: '' }, 1), /nothing for you to submit/)
  assert.deepEqual(turnEnded(run, LEAD_SID).map((x) => x.kind), ['tellLead'], 'a lead that stops without splitting gets one nudge')
  assert.deepEqual(turnEnded(run, LEAD_SID), [], 'and only one')
  assert.throws(() => split(run, [1, 2, 3, 4, 5].map((n) => ({ title: `a${n}`, brief: '' }))), /at most 4/)

  const r = spawn(run, split(run, [{ title: 'api', brief: 'server/' }, { title: 'ui', brief: 'web/' }]))
  assert.deepEqual(kinds(r), ['tell review:1', 'tell review:2'])
  assert.match(tells(r)[0].text, /## Your slice: api\nserver\//)
  assert.equal(run.workers[0].label, 'Code-reviewer · api')

  const f = (n: number) => ({ severity: 'P1' as const, where: `f${n}.ts:1`, problem: `p${n}`, fix: 'x' })
  assert.deepEqual(hand(run, 'review:1', { summary: '3 issues', body: '', findings: [f(1), f(2), f(3)] }), [], 'waits for the other reviewer')
  const v = hand(run, 'review:2', { summary: '2 issues', body: '', findings: [f(4), f(5)] })
  assert.deepEqual(kinds(v), ['tell validate:1', 'tell validate:2', 'tell validate:3', 'tell validate:4'], 'five findings over at most four validators')
  assert.match(tells(v)[0].text, /\[P1\] f1\.ts:1 — p1[\s\S]*\[P1\] f5\.ts:1 — p5/)

  for (const w of ['validate:1', 'validate:2', 'validate:3']) hand(run, w, { summary: 'kept', body: '', verdict: 'pass' })
  const rep = hand(run, 'validate:4', { summary: 'dropped', body: '', verdict: 'pass' })
  assert.deepEqual(kinds(rep), ['tell report:1'])
  assert.match(tells(rep)[0].text, /What the team handed in[\s\S]*Code-reviewer · api — 3 issues[\s\S]*Validator · finding/)
  assert.deepEqual(kinds(hand(run, 'report:1', { summary: 'two real bugs', body: '# Review' })), ['finish'])
})

test('Review with no findings skips validation', () => {
  const run = runOf(recipeOf('review'), { steps: [{ id: 'review', slices: [{ title: 'all', brief: 'the diff' }] }] })
  const a = spawn(run, approve(run, run.card))
  assert.deepEqual(kinds(a), ['snapshot', 'notice', 'tell review:1'], 'slices planned on the card: no split needed')
  const rep = hand(run, 'review:1', { summary: 'clean', body: 'looked hard' })
  assert.deepEqual(kinds(rep), ['tell report:1'])
  assert.match(run.outputs.find((o) => o.stepId === 'validate')!.summary, /nothing to check/)
})

test('Debug: the challenge round reuses each investigator\'s session and shows it the others\' findings', () => {
  const run = runOf(recipeOf('debug'))
  approve(run, run.card)
  spawn(run, split(run, [{ title: 'cache', brief: 'stale cache' }, { title: 'race', brief: 'two writers' }]))
  hand(run, 'investigate:1', { summary: 'cache is fine', body: 'evidence A' })
  const c = spawn(run, hand(run, 'investigate:2', { summary: 'race reproduced', body: 'evidence B' }))
  assert.deepEqual(kinds(c), ['tell challenge:1', 'tell challenge:2'])
  assert.equal(sid(run, 'challenge:1'), sid(run, 'investigate:1'))
  assert.equal(sid(run, 'challenge:2'), sid(run, 'investigate:2'))
  assert.match(tells(c)[0].text, /The others' handoffs[\s\S]*race reproduced/)
  assert.doesNotMatch(tells(c)[0].text, /cache is fine/)
})

test('a gate waits for you after its step', () => {
  const recipe = parseRecipe(
    'g',
    `---\nsteps:\n  - id: research\n    agent: researcher\n    output: notes\n    gate: you\n  - id: write\n    agent: lead\n    output: report\n---\n`,
  ).recipe!
  const run = runOf(recipe)
  spawn(run, approve(run, run.card))
  assert.deepEqual(kinds(hand(run, 'research:1', { summary: 'found it', body: '' })), ['notice'])
  assert.equal(run.state, 'gate')
  assert.throws(() => submit(run, LEAD_SID, { summary: 'x', body: '' }, 1), /the run is gate/)
  assert.deepEqual(kinds(continueGate(run)), ['tell write:1'])
  assert.equal(run.state, 'running')
})

test('submissions are checked: the right worker, a verdict where one is due, one line of summary', () => {
  const run = runOf(recipeOf('solo'))
  spawn(run, approve(run, run.card))
  assert.throws(() => submit(run, 'stranger', { summary: 'x', body: '' }, 1), /nothing for you to submit/)
  assert.throws(() => submit(run, LEAD_SID, { summary: '  ', body: '' }, 1), /summary/)
  hand(run, 'build:1')
  spawn(run, checksDone(run, [], 2))
  const v = sid(run, 'verify:1')
  assert.throws(() => submit(run, v, { summary: 'ok', body: '' }, 3), /needs a verdict/)
  assert.throws(() => submit(run, v, { summary: 'bad', body: '', verdict: 'fail' }, 3), /at least one finding/)
  submit(run, v, complete(run, { summary: 'fine\nsecond line dropped', body: '', verdict: 'pass' }), 3)
  assert.throws(() => submit(run, v, { summary: 'again', body: '', verdict: 'pass' }, 3), /nothing for you to submit/)
  assert.equal(run.outputs.at(-1)!.summary, 'fine')
})

test('a worker that stops without submitting is nudged once', () => {
  const run = runOf(recipeOf('build'))
  spawn(run, approve(run, run.card))
  const s = sid(run, 'build:T1:1')
  assert.deepEqual(kinds(turnEnded(run, s)), ['tell build:T1:1'])
  assert.deepEqual(turnEnded(run, s), [])
})

test('resume acts on a submission the pause interrupted, or re-sends the step', () => {
  const run = runOf(recipeOf('build'))
  spawn(run, approve(run, run.card))
  const s = sid(run, 'build:T1:1')
  run.state = 'paused'
  assert.deepEqual(kinds(resume(run)), ['tell build:T1:1'], 'nothing handed in: the builder is asked to carry on')
  submit(run, s, complete(run, { summary: 'built', body: '' }), 1)
  run.state = 'paused'
  assert.deepEqual(kinds(resume(run)), ['checks'], 'handed in before the pause: the run moves on')
  assert.throws(() => resume(run), /not paused/)
})

test('the card: checked against the recipe, budget defaults to the team\'s', () => {
  const review = recipeOf('review')
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'] }, review).budgetUsd, 4)
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'], budgetUsd: 9000 }, review).budgetUsd, 500)
  assert.throws(() => cardFrom({ criteria: ['c'] }, review), /needs a goal/)
  assert.throws(() => cardFrom({ goal: 'g', criteria: [] }, review), /at least one acceptance criterion/)
  assert.throws(() => cardFrom({ goal: 'g', criteria: ['c'], steps: [{ id: 'nope' }] }, review), /no step "nope"/)
  assert.throws(() => cardFrom({ goal: 'g', criteria: ['c'], steps: [{ id: 'validate', slices: [{ title: 'x', brief: '' }] }] }, review), /triage splits it itself/)
  assert.throws(() => cardFrom({ goal: 'g', criteria: ['c'], steps: [{ id: 'report', slices: [{ title: 'x', brief: '' }] }] }, review), /no fan-out/)
  const card = cardFrom({ goal: 'g', criteria: ['c'], steps: [{ id: 'review', model: 'haiku', slices: [{ title: 'a', brief: '' }, { title: 'b', brief: '' }] }] }, review)
  assert.deepEqual(card.steps.map((s) => [s.id, s.model, s.slices?.length ?? 0]), [['review', 'haiku', 2], ['validate', null, 0], ['report', null, 0]])
})

test('Save as team keeps the card\'s models and widths', () => {
  const run = runOf(recipeOf('review'), { budgetUsd: 2, steps: [{ id: 'review', model: 'haiku', slices: [{ title: 'a', brief: '' }, { title: 'b', brief: '' }, { title: 'c', brief: '' }] }] })
  const r = recipeFromRun(run, 'Quick review')
  assert.equal(r.label, 'Quick review')
  assert.equal(r.budgetUsd, 2)
  assert.deepEqual(r.steps[0].fanOut, { by: 'area', max: 3 })
  assert.equal(r.steps[0].model, 'haiku')
  assert.equal(r.steps[1].model, 'sonnet', 'a step the card left alone keeps the recipe\'s model')
})

test('M6: a run stored before goals (no tasks, notes or revision) reads back from the config store and still renders', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { openSqliteStore } = await import('../core/store/sqlite.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'team-runs-'))
  try {
    const run = runOf(recipeOf('build'), { tasks: [{ title: 'a' }] })
    spawn(run, approve(run, run.card))
    run.state = 'done'
    // The older shape: fields later releases added are missing.
    const old = JSON.parse(JSON.stringify(run)) as Partial<TeamRun>
    delete old.tasks, delete old.notes, delete old.revision, delete old.task
    for (const s of old.recipe!.steps) delete (s as Partial<typeof s>).forEach
    const store = openSqliteStore(path.join(dir, 'triage.db'))
    await store.config.set('team_runs', [old])
    const [back] = (await store.config.get<TeamRun[]>('team_runs'))!
    const md = renderPlan(normalizeRun(back!))
    assert.match(md, /^# Plan · Cart totals\n\nBuild team · done/)
    assert.match(md, /## Outcome/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runs: one per step sent (task, round, fresh), stamped by the server, closed by their handoff; a nudge is no new run', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a' }, { title: 'b' }] })
  spawn(run, approve(run, run.card))
  assert.deepEqual(run.workerRuns.map((r) => r.id), ['build:T1:1#0'])
  assert.equal(runStatus(run, run.workerRuns[0]), 'working')

  stampRun(run, 'build:T1:1', { startSeq: 4, at: 100, spendAtStart: 0 })
  // A nudge re-sends to the same worker: more of the same run, nothing new to stamp.
  turnEnded(run, sid(run, 'build:T1:1'))
  stampRun(run, 'build:T1:1', { startSeq: 9, at: 200, spendAtStart: 1 })
  assert.equal(run.workerRuns.length, 1)
  assert.deepEqual([run.workerRuns[0].startSeq, run.workerRuns[0].at], [4, 100])

  hand(run, 'build:T1:1', { summary: 'built', body: '' })
  assert.equal(runStatus(run, run.workerRuns[0]), 'done')
  spawn(run, checksDone(run, [], 1))
  const fail = { summary: 'no', body: '', verdict: 'fail' as const, findings: [{ severity: 'P1' as const, where: 'x', problem: 'p', fix: 'f' }] }
  hand(run, 'verify:T1:1', fail)
  spawn(run, checksDone(run, [], 2))
  assert.deepEqual(
    run.workerRuns.map((r) => [r.id, r.task, r.round, r.fresh]),
    [
      ['build:T1:1#0', 'T1', 0, false],
      ['verify:T1:1#0', 'T1', 0, false],
      ['build:T1:1#1', 'T1', 1, false],
    ],
    'a fix round is a new run of the same worker',
  )
  assert.equal(runStatus(run, run.workerRuns[1]), 'fail')
  hand(run, 'build:T1:1')
  spawn(run, checksDone(run, [], 3))
  const re = run.workerRuns.at(-1)!
  assert.deepEqual([re.id, re.fresh], ['verify:T1:1#1', true], 'the re-review starts clean')
  hand(run, 'verify:T1:1', { summary: 'ok', body: '', verdict: 'pass' })
  assert.equal(runStatus(run, re), 'pass')
  const t2 = run.workerRuns.at(-1)!
  assert.deepEqual([t2.id, t2.task, t2.round, t2.fresh], ['build:T2:1#0', 'T2', 0, true])
  assert.equal(sid(run, t2.workerId), sid(run, 'build:T1:1'), 'every implementer run lands in one session')
  assert.equal(runStatus(run, run.workerRuns[0]), 'done', 'an earlier run keeps its handoff')
})

test('backfill: a run stored before runs were recorded gets the same runs, placed at the step messages in each session', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a' }, { title: 'b' }] })
  // Every message triage sends, per session, as the transcript would hold it (seq = position).
  const logs: Record<string, { seq: number; text: string }[]> = {}
  const send = (as: Action[]) => {
    for (const a of tells(spawn(run, as))) {
      const s = sid(run, a.workerId)
      const log = (logs[s] ??= [])
      log.push({ seq: log.length + 1, text: a.text })
    }
    return as
  }
  send(approve(run, run.card))
  send(turnEnded(run, sid(run, 'build:T1:1'))) // a nudge: not a step message
  send((submit(run, sid(run, 'build:T1:1'), complete(run, { summary: 'built', body: '' }), 1), turnEnded(run, sid(run, 'build:T1:1'))))
  send(checksDone(run, [], 2))
  send(hand(run, 'verify:T1:1', { summary: 'ok', body: '', verdict: 'pass' }))
  const recorded = run.workerRuns.map((r) => [r.id, r.handoffId])

  for (const l of Object.values(logs)) assert.equal(l.filter((m) => STEP_MESSAGE.test(m.text)).length, l.length - (l.some((m) => m.text.startsWith('You ended')) ? 1 : 0))
  const starts = Object.fromEntries(Object.entries(logs).map(([s, l]) => [s, l.filter((m) => STEP_MESSAGE.test(m.text)).map((m) => ({ seq: m.seq, at: m.seq * 10, fresh: false }))]))
  run.workerRuns = []
  backfillRuns(run, starts)
  assert.deepEqual(run.workerRuns.map((r) => [r.id, r.handoffId]), recorded)
  const impl = sid(run, 'build:T1:1')
  assert.deepEqual(
    run.workerRuns.filter((r) => sid(run, r.workerId) === impl).map((r) => [r.id, r.startSeq]),
    [['build:T1:1#0', 1], ['build:T2:1#0', 3]],
    'the nudge between them is skipped',
  )
})

test('permissions: no run starts until you pick them; the team file can preselect; the lead\'s re-proposal keeps your pick', () => {
  const run = runOf(recipeOf('build'), { permissions: undefined })
  assert.equal(run.card.permissions, null, 'no default: the shipped teams leave it to you')
  assert.throws(() => approve(run, run.card), /pick what the team may do without asking/)
  assert.equal(run.state, 'proposed')
  const picked = cardFrom({ ...run.card, permissions: 'ask' }, run.recipe, run.card)
  assert.equal(picked.permissions, 'ask')
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'] }, run.recipe, picked).permissions, 'ask', 'kept across an edit that leaves it out')
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'], permissions: 'nonsense' }, run.recipe).permissions, null)
  const preset = parseRecipe('build', SHIPPED_RECIPES.build.replace(/^budget: .*$/m, (l) => `${l}\npermissions: local`)).recipe!
  assert.equal(preset.permissions, 'local')
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'] }, preset).permissions, 'local')
  assert.deepEqual(parseRecipe('x', SHIPPED_RECIPES.build.replace(/^budget: .*$/m, (l) => `${l}\npermissions: yolo`)).errors, ['permissions must be one of ask, local, everything'])
  spawn(run, approve(run, picked))
  assert.equal(run.state, 'running')
})

test('handoffs: criteria by id (turned back once), the ledger feeds the next task, the reviewer sees pointers not claims', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'Add the field', criteria: ['stores a code', 'survives reload'] }, { title: 'Apply codes' }] })
  run.dir = '/runs/r1'
  run.baseline = { results: [{ cmd: 'npm test', ok: false, tail: 'flaky.spec failed' }], at: 1 }
  const a = spawn(run, approve(run, run.card))
  const first = tells(a)[0].text
  assert.match(first, /## How to check this project\n- `npm test` FAILED when the run started — a failure that was already there/)
  assert.match(first, /The run folder is \/runs\/r1/)
  assert.match(first, /Done when:\n- T1.1 stores a code\n- T1.2 survives reload/)

  // No criteria: turned back once, naming what's missing; the second try is taken with the gap marked.
  const b = sid(run, 'build:T1:1')
  assert.throws(() => submit(run, b, { summary: 'built', body: '' }, 1), /missing T1.1, T1.2/)
  submit(run, b, {
    summary: 'built',
    body: 'I VERIFIED EVERYTHING, IT IS PERFECT',
    criteria: [{ id: 'T1.1', status: 'met', evidence: 'unit test' }],
    unsure: 'the reload path',
    decisions: [{ what: 'codes are stored upper-case', why: 'the API compares exactly' }],
    where: ['src/cart.ts — the cart store'],
    failed: ['tried localStorage — blocked in the webview'],
    verify: ['open /cart and reload'],
  }, 1)
  assert.deepEqual(run.outputs.at(-1)!.criteria, [
    { id: 'T1.1', status: 'met', evidence: 'unit test' },
    { id: 'T1.2', status: 'unreported', evidence: '' },
  ])
  assert.deepEqual(run.ledger.map((e) => e.kind), ['decision', 'failed', 'where', 'verify'])
  assert.equal(run.outputs.at(-1)!.file, 'handoffs/01-T1-build-r0.md')
  spawn(run, turnEnded(run, b))

  // The reviewer: the builder's pointers, the checks as done, never the builder's own account.
  const v = tells(spawn(run, checksDone(run, [{ cmd: 'npm test', ok: true, tail: '' }], 2)))[0].text
  assert.match(v, /Look hardest at:\nthe reload path/)
  assert.doesNotMatch(v, /I VERIFIED EVERYTHING/)
  assert.match(v, /Its full account is at \/runs\/r1\/handoffs\/01-T1-build-r0.md/)
  assert.match(v, /Don't run them again unless you change something/)

  // The next task starts fresh but knows where things are, what was decided and why, and what failed.
  const t2 = tells(hand(run, 'verify:T1:1', { summary: 'ok', body: '', verdict: 'pass' }))[0].text
  assert.match(t2, /## Decisions\n- T1 · codes are stored upper-case — because the API compares exactly/)
  assert.match(t2, /## Where things are\n- T1 · src\/cart.ts — the cart store/)
  assert.match(t2, /## Learned so far\n- tried, failed: T1 · tried localStorage/)
  assert.match(t2, /- T1 · open \/cart and reload/)
})

test('findings: ids that hold across rounds, every one answered, history in the fix round, a pass closes them', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a', criteria: ['works'] }] })
  spawn(run, approve(run, run.card))
  hand(run, 'build:T1:1')
  spawn(run, checksDone(run, [], 1))
  const two = [
    { severity: 'P0' as const, where: 'a.ts:1', problem: 'crashes on empty', fix: 'guard it' },
    { severity: 'P2' as const, where: 'a.ts:9', problem: 'naming', fix: 'rename' },
  ]
  const fix1 = tells(hand(run, 'verify:T1:1', { summary: 'no', body: '', verdict: 'fail', findings: two }))[0].text
  assert.deepEqual(Object.keys(run.findingState), ['T1-F1', 'T1-F2'])
  assert.match(fix1, /### Open\nT1-F1. \[P0\] a.ts:1 — crashes on empty/)

  const b = sid(run, 'build:T1:1')
  const crit = [{ id: 'T1.1', status: 'met' as const, evidence: 'x' }]
  assert.throws(() => submit(run, b, { summary: 'fixed', body: '', criteria: crit, resolutions: [{ id: 'T1-F1', status: 'fixed', note: 'guarded' }] }, 2), /missing T1-F2/)
  submit(run, b, { summary: 'fixed', body: '', criteria: crit, resolutions: [{ id: 'T1-F1', status: 'fixed', note: 'guarded' }, { id: 'T1-F2', status: 'disputed', note: 'matches the codebase' }], failed: ['an early return broke the reducer'] }, 2)
  assert.equal(run.findingState['T1-F2'].status, 'disputed')
  spawn(run, turnEnded(run, b))
  const re = tells(spawn(run, checksDone(run, [], 3)))[0].text
  assert.match(re, /What it says about the open findings:\n- T1-F1: fixed — guarded\n- T1-F2: disputed — matches the codebase/)

  // The reviewer says F1 is still broken, by id: it reopens rather than becoming F3.
  const fix2 = tells(hand(run, 'verify:T1:1', { summary: 'still', body: '', verdict: 'fail', findings: [{ ...two[0], id: 'T1-F1' }] }))[0].text
  assert.deepEqual(Object.keys(run.findingState), ['T1-F1', 'T1-F2'])
  assert.match(fix2, /### Open\nT1-F1\./)
  assert.match(fix2, /### Earlier rounds\n- T1-F2 disputed — matches the codebase/)
  assert.match(fix2, /### Already tried, didn't work\n- T1 · an early return broke the reducer/)

  hand(run, 'build:T1:1')
  spawn(run, checksDone(run, [], 4))
  hand(run, 'verify:T1:1', { summary: 'holds', body: '', verdict: 'pass' })
  assert.equal(run.findingState['T1-F1'].status, 'fixed')
  assert.equal(run.tasks.T1.status, 'done')
})

test('the final review and the report get one line per handoff and its file, not every word', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a' }] })
  run.dir = '/runs/r1'
  spawn(run, approve(run, run.card))
  hand(run, 'build:T1:1', { summary: 'built a', body: 'A VERY LONG ACCOUNT OF THE BUILD' })
  spawn(run, checksDone(run, [], 1))
  const fin = tells(hand(run, 'verify:T1:1', { summary: 'a holds', body: 'LONG REVIEW', verdict: 'pass' }))[0].text
  assert.match(fin, /## What the team handed in\n- Implementer \(T1\) — built a → \/runs\/r1\/handoffs\/01-T1-build-r0.md/)
  assert.doesNotMatch(fin, /A VERY LONG ACCOUNT|LONG REVIEW/)
  const rep = tells(hand(run, 'final:1', { summary: 'seams hold', body: 'FINAL WORDS', verdict: 'pass' }))[0].text
  assert.match(rep, /- Reviewer \(T1\) — PASS — a holds → \/runs\/r1\/handoffs\/03-T1-verify-r0.md/)
  assert.doesNotMatch(rep, /A VERY LONG ACCOUNT|FINAL WORDS/)
})

test('the run folder: plan, ledger, verify, reviews and one file per handoff, all rendered from the run', () => {
  const run = runOf(recipeOf('build'), { tasks: [{ title: 'a', criteria: ['works'] }] })
  run.baseline = { results: [{ cmd: 'npm test', ok: true, tail: '' }], at: Date.UTC(2026, 9, 17, 9, 0) }
  run.checkCmds = ['npm test']
  spawn(run, approve(run, run.card))
  hand(run, 'build:T1:1', { summary: 'built', body: 'did a', decisions: [{ what: 'cents', why: 'no floats' }] })
  spawn(run, checksDone(run, [{ cmd: 'npm test', ok: true, tail: '' }], 2))
  hand(run, 'verify:T1:1', { summary: 'no', body: '', verdict: 'fail', findings: [{ severity: 'P1', where: 'a.ts', problem: 'off by one', fix: 'fix it' }] })
  const files = runFiles(run)
  assert.deepEqual(Object.keys(files).sort(), ['handoffs/01-T1-build-r0.md', 'handoffs/02-T1-checks-r0.md', 'handoffs/03-T1-verify-r0.md', 'ledger.md', 'plan.md', 'reviews.md', 'verify.md'])
  assert.match(files['ledger.md'], /## Decisions\n- \*\*T1\*\* · cents — because no floats _\(Implementer\)_/)
  assert.match(files['verify.md'], /## When the run started \(2026-10-17 09:00\)\n- `npm test`: passed/)
  assert.match(files['reviews.md'], /## T1-F1 · open · P1\n\na.ts — off by one/)
  assert.match(files['handoffs/01-T1-build-r0.md'], /^# Implementer · T1 · build\n/)
  assert.match(files['plan.md'], /## Findings not fixed\n- T1-F1 open/)
})

test('fast mode: off unless you turn it on; the team file can preselect it; it survives an edit that leaves it out', () => {
  const run = runOf(recipeOf('build'))
  assert.equal(run.card.fast, false)
  assert.equal(cardFrom({ ...run.card, fast: true }, run.recipe, run.card).fast, true)
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'] }, run.recipe, { ...run.card, fast: true }).fast, true)
  const preset = parseRecipe('build', SHIPPED_RECIPES.build.replace(/^budget: .*$/m, (l) => `${l}\nfast: true`)).recipe!
  assert.equal(preset.fast, true)
  assert.equal(cardFrom({ goal: 'g', criteria: ['c'] }, preset).fast, true)
  assert.deepEqual(parseRecipe('x', SHIPPED_RECIPES.build.replace(/^budget: .*$/m, (l) => `${l}\nfast: yes`)).errors, ['fast must be true or false'])
})
