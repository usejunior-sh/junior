/**
 * Team-run state over the team-run store (server/team-run/state.ts): a save
 * writes the one run that changed and logs a move of state; boot loads only
 * the open runs, and a closed one comes in as a summary that still links its
 * sessions and still puts a done goal on your turn; a closed run is loaded
 * whole only when asked for, once. Nothing writes the old `team_runs` config
 * key. A fake runtime over a real SQLite store; nothing spawns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Store, StoredSession, TeamRunStore } from '../core/store/types.js'
import type { RunState, TeamRun } from '../core/teams/engine-types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-team-state-'))
process.env.JUNIOR_HOME = home
const { openSqliteStore } = await import('../core/store/sqlite.js')
const { LEGACY_TEAM_RUNS_KEY } = await import('../core/store/sqlite-team-runs.js')
const state = await import('../server/team-run/state.js')

/** A run the store and normalizeRun accept: a recipe with one step, workers by session. */
function teamRun(id: string, s: RunState, createdAt: number, lead: string, workers: string[] = [], extra: Partial<TeamRun> = {}): TeamRun {
  return {
    id,
    itemId: `manual:${id}`,
    title: `Run ${id}`,
    createdAt,
    team: 'build',
    recipe: { name: 'build', label: 'Build', description: '', useFor: [], steps: [{ id: 'build', output: 'change' }], budgetUsd: 5 },
    card: { goal: 'g', criteria: [], steps: [], tasks: [], decisions: [], budgetUsd: 5, permissions: 'local', fast: false },
    agents: [],
    leadSessionId: lead,
    state: s,
    step: 0,
    workers: workers.map((sid, i) => ({ id: `build:${i + 1}`, stepId: 'build', agent: 'implementer', label: `Implementer ${i + 1}`, color: 'blue', slice: null, sessionId: sid })),
    workerRuns: [],
    outputs: [],
    spend: {},
    budgetUsd: 5,
    planningUsd: 0,
    rev: 1,
    goal: null,
    ...extra,
  } as unknown as TeamRun
}

const goalOf = (acceptedAt: number | null, questions: { id: string; answer: string | null }[] = []) =>
  ({ doneWhen: 'CI green', horizon: 'today', round: 1, verdicts: [], questions, acceptedAt }) as unknown as TeamRun['goal']

/** Count the store's calls, so a test can say which rows a step touched. */
function spied(store: Store) {
  const calls: { method: string; id?: string }[] = []
  const inner = store.teamRuns
  const teamRuns: TeamRunStore = {
    upsert: (run, at) => (calls.push({ method: 'upsert', id: run.id }), inner.upsert(run, at)),
    get: (id) => (calls.push({ method: 'get', id }), inner.get(id)),
    listOpen: () => (calls.push({ method: 'listOpen' }), inner.listOpen()),
    listRecent: (n, o) => (calls.push({ method: 'listRecent' }), inner.listRecent(n, o)),
    closedSummaries: () => (calls.push({ method: 'closedSummaries' }), inner.closedSummaries()),
    remove: (id) => (calls.push({ method: 'remove', id }), inner.remove(id)),
    appendEvent: (id, d, at) => (calls.push({ method: 'appendEvent', id }), inner.appendEvent(id, d, at)),
    events: (id) => inner.events(id),
  }
  return { store: { ...store, teamRuns } as Store, calls }
}

function runtime(store: Store, sessions: string[]): WorkspaceRuntime {
  return {
    meta: { id: 'ws-test' },
    store,
    rows: new Map(sessions.map((id) => [id, { id, kind: 'chat', updatedAt: 0 } as unknown as StoredSession])),
    teamRuns: new Map(),
    teamRunSummaries: new Map(),
    teamRunLoads: new Map(),
    sessionTeam: new Map(),
  } as unknown as WorkspaceRuntime
}

test('a save writes one row, logs a move of state once, and never the team_runs config key', async () => {
  const dir = mkdtempSync(path.join(home, 'save-'))
  const file = path.join(dir, 'junior.db')
  try {
    const base = openSqliteStore(file)
    for (const [id, lead] of [['a', 'la'], ['b', 'lb'], ['c', 'lc']]) await base.teamRuns.upsert(teamRun(id, 'running', 1, lead), 100)
    const { store, calls } = spied(base)
    const rt = runtime(store, ['la', 'lb', 'lc'])
    await state.loadTeamRuns(rt)
    calls.length = 0

    const b = rt.teamRuns.get('b')!
    b.rev += 1
    await state.saveTeamRun(rt, b, 500)
    // Same state: one row written, nothing logged.
    assert.deepEqual(calls, [{ method: 'upsert', id: 'b' }])

    b.state = 'paused'
    b.reason = 'paused by you'
    await state.saveTeamRun(rt, b, 600)
    assert.deepEqual(calls.slice(1), [{ method: 'upsert', id: 'b' }, { method: 'appendEvent', id: 'b' }])
    assert.deepEqual((await base.teamRuns.events('b')).map((e) => e.data), [{ kind: 'state', from: 'running', to: 'paused', rev: 2, reason: 'paused by you' }])

    // On disk: only b's row moved, and the old config key was never written.
    const raw = new DatabaseSync(file, { readOnly: true })
    const rows = raw.prepare('SELECT id, updated_at FROM team_runs ORDER BY id').all() as { id: string; updated_at: number }[]
    assert.deepEqual(rows.map((r) => [r.id, r.updated_at]), [['a', 100], ['b', 600], ['c', 100]])
    assert.equal(raw.prepare('SELECT value FROM config WHERE key = ?').get(LEGACY_TEAM_RUNS_KEY), undefined)
    raw.close()
    await base.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new run logs where it started; a removed one is never saved back', async () => {
  const base = openSqliteStore(':memory:')
  const rt = runtime(base, ['l'])
  const run = teamRun('n', 'proposed', 1, 'l')
  rt.teamRuns.set(run.id, run)
  await state.saveTeamRun(rt, run, 10)
  await state.saveTeamRun(rt, run, 11)
  assert.deepEqual((await base.teamRuns.events('n')).map((e) => e.data), [{ kind: 'state', from: null, to: 'proposed', rev: 1 }])

  // Removed, then a late change lands: it stays removed.
  await state.removeTeamRun(rt, run)
  run.state = 'stopped'
  await state.saveTeamRun(rt, run, 12)
  assert.equal(await base.teamRuns.get('n'), null)
  await base.close()
})

test('boot loads only open runs; closed ones are summaries that still link their sessions and the flow', async () => {
  const base = openSqliteStore(':memory:')
  await base.teamRuns.upsert(teamRun('open', 'running', 1, 'L1', ['W1']), 1)
  await base.teamRuns.upsert(teamRun('goal', 'done', 2, 'L2', ['W2', 'gone'], { goal: goalOf(null, [{ id: 'q', answer: null }]) }), 2)
  await base.teamRuns.upsert(teamRun('stop', 'stopped', 3, 'L3'), 3)
  await base.teamRuns.upsert(teamRun('orphan', 'done', 4, 'no-such-lead'), 4)
  const { store, calls } = spied(base)
  const rt = runtime(store, ['L1', 'W1', 'L2', 'W2', 'L3'])
  await state.loadTeamRuns(rt)

  assert.deepEqual([...rt.teamRuns.keys()], ['open'])
  assert.deepEqual([...rt.teamRunSummaries.keys()], ['goal', 'stop'])
  // Boot never read a closed run whole.
  assert.deepEqual(calls.map((c) => c.method).sort(), ['closedSummaries', 'listOpen'])

  assert.equal(state.teamRunOf(rt, 'L2'), undefined)
  assert.ok(state.inTeamRun(rt, 'W2'))
  assert.deepEqual(state.teamRunLink(rt, 'L2'), { id: 'goal', role: 'lead', label: 'Lead', state: 'done', rev: 1, goal: true })
  assert.deepEqual(state.teamRunLink(rt, 'W2'), { id: 'goal', role: 'worker', label: 'Implementer 1', state: 'done', rev: 1, goal: true })
  assert.deepEqual(state.teamRunLink(rt, 'W1'), { id: 'open', role: 'worker', label: 'Implementer 1', state: 'running', rev: 1 })
  assert.equal(state.teamRunLink(rt, 'gone'), undefined)
  assert.equal(state.teamRunLabel(rt, 'stop'), 'Build')

  const flow = new Map(state.teamRunSummaries(rt).map((s) => [s.id, s]))
  assert.deepEqual([...flow.keys()].sort(), ['goal', 'open', 'stop'])
  assert.equal(flow.get('goal')!.toAccept, true)
  assert.equal(flow.get('goal')!.asks, 1)
  await base.close()
})

test('a closed run is loaded whole once, on demand, and then lives in memory', async () => {
  const base = openSqliteStore(':memory:')
  await base.teamRuns.upsert(teamRun('goal', 'done', 2, 'L2', ['W2'], { goal: goalOf(null) }), 2)
  await base.teamRuns.upsert(teamRun('open', 'running', 3, 'L3'), 3)
  const { store, calls } = spied(base)
  const rt = runtime(store, ['L2', 'W2', 'L3'])
  await state.loadTeamRuns(rt)
  calls.length = 0

  const [one, two] = await Promise.all([state.ensureTeamRun(rt, 'goal'), state.ensureSessionTeamRun(rt, 'W2')])
  assert.ok(one)
  assert.equal(one, two)
  assert.equal(calls.filter((c) => c.method === 'get').length, 1)
  assert.equal(rt.teamRuns.get('goal'), one)
  assert.equal(rt.teamRunSummaries.has('goal'), false)
  assert.equal(state.teamRunOf(rt, 'L2'), one)
  assert.equal(await state.ensureTeamRun(rt, 'missing'), undefined)

  // The Goals tab's list: memory's object where there is one, the store's newest for the rest.
  const goals = await state.recentTeamRuns(rt, 10, { goal: true })
  assert.deepEqual(goals.map((r) => r.id), ['goal'])
  assert.equal(goals[0], one)
  assert.deepEqual((await state.recentTeamRuns(rt, 10)).map((r) => r.id).sort(), ['goal', 'open'])

  await state.removeTeamRun(rt, one!)
  assert.equal(await base.teamRuns.get('goal'), null)
  assert.equal(rt.teamRuns.has('goal'), false)
  await base.close()
})

test('a lead that proposed again links to its newest run, whichever is loaded first', async () => {
  const base = openSqliteStore(':memory:')
  await base.teamRuns.upsert(teamRun('newer', 'done', 5, 'L'), 5)
  await base.teamRuns.upsert(teamRun('older', 'running', 1, 'L'), 1)
  const rt = runtime(base, ['L'])
  await state.loadTeamRuns(rt)
  assert.equal(rt.sessionTeam.get('L'), 'newer')
  await state.ensureTeamRun(rt, 'older')
  assert.equal(rt.sessionTeam.get('L'), 'newer')
  await base.close()
})

test.after(() => rmSync(home, { recursive: true, force: true }))
