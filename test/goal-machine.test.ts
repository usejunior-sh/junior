/**
 * The goal state machine (core/goals/machine.ts): every state × trigger × who
 * pulls it, against a table written out by hand here — so a change to the
 * machine has to change this table too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GOAL_TRIGGERS, TERMINAL_STATES, isTerminal, parseDuration, transition, triggersFrom, turnOf, type GoalTrigger, type TriggerBy } from '../core/goals/machine.js'
import { GOAL_STATES, isGoalState, type GoalState } from '../core/goals/types.js'

/** state → the triggers it accepts and where each lands. Anything not listed is refused. */
const ALLOWED: Record<GoalState, Partial<Record<GoalTrigger, GoalState>>> = {
  draft_plan: { plan_proposed: 'plan_ready', cancel: 'cancelled' },
  plan_ready: { approve: 'queued', send_back: 'draft_plan', cancel: 'cancelled' },
  queued: { start: 'running', ask_you: 'waiting_you', pause: 'paused', cancel: 'cancelled' },
  running: { yield: 'queued', wait_world: 'waiting_world', ask_you: 'waiting_you', result: 'result_ready', pause: 'paused', cancel: 'cancelled' },
  waiting_world: { gate_met: 'queued', ask_you: 'waiting_you', pause: 'paused', cancel: 'cancelled' },
  waiting_you: { answer: 'queued', keep_waiting: 'waiting_world', pause: 'paused', cancel: 'cancelled' },
  result_ready: { accept: 'done', reopen: 'queued', cancel: 'cancelled' },
  done: {},
  paused: { resume: 'queued', cancel: 'cancelled' },
  cancelled: {},
}

/** Who may pull each trigger. */
const BY: Record<GoalTrigger, TriggerBy> = {
  plan_proposed: 'engine',
  approve: 'you',
  send_back: 'you',
  start: 'engine',
  yield: 'engine',
  wait_world: 'engine',
  ask_you: 'engine',
  gate_met: 'engine',
  answer: 'you',
  keep_waiting: 'you',
  result: 'engine',
  accept: 'you',
  reopen: 'you',
  pause: 'you',
  resume: 'you',
  cancel: 'you',
}

const other = (by: TriggerBy): TriggerBy => (by === 'you' ? 'engine' : 'you')

test('the expected table names every state and every trigger', () => {
  assert.deepEqual(Object.keys(ALLOWED).sort(), [...GOAL_STATES].sort())
  assert.deepEqual(Object.keys(BY).sort(), [...GOAL_TRIGGERS].sort())
})

for (const from of GOAL_STATES) {
  for (const trigger of GOAL_TRIGGERS) {
    const to = ALLOWED[from][trigger]
    const by = BY[trigger]
    if (to) {
      test(`${from} --${trigger} (${by})--> ${to}`, () => {
        assert.deepEqual(transition(from, trigger, by), { ok: true, from, to })
      })
      test(`${from} --${trigger}: refused when ${other(by)} pulls it`, () => {
        const r = transition(from, trigger, other(by))
        assert.equal(r.ok, false)
        assert.match((r as { error: string }).error, /to pull/)
      })
    } else {
      test(`${from} --${trigger}: refused`, () => {
        for (const who of ['you', 'engine'] as const) assert.equal(transition(from, trigger, who).ok, false)
        const r = transition(from, trigger, by)
        assert.match((r as { error: string }).error, new RegExp(`a goal that is ${from}$`))
      })
    }
  }
}

test('an unknown trigger is refused, not thrown', () => {
  const r = transition('running', 'merge' as GoalTrigger, 'engine')
  assert.deepEqual(r, { ok: false, error: 'unknown trigger "merge"' })
})

test('done and cancelled are terminal: nothing leaves them', () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ['cancelled', 'done'])
  for (const s of GOAL_STATES) assert.equal(isTerminal(s), s === 'done' || s === 'cancelled')
  for (const s of TERMINAL_STATES) assert.deepEqual(triggersFrom(s), [])
})

test('every way back to running goes through queued — the lead resumes in a fresh session', () => {
  for (const from of GOAL_STATES) {
    for (const [trigger, to] of Object.entries(ALLOWED[from])) {
      if (to === 'running') assert.deepEqual([from, trigger], ['queued', 'start'])
    }
  }
})

test('pause and resume: take over from any working or waiting state, hand back to queued', () => {
  assert.deepEqual(
    GOAL_STATES.filter((s) => transition(s, 'pause', 'you').ok),
    ['queued', 'running', 'waiting_world', 'waiting_you'],
  )
  assert.deepEqual(triggersFrom('paused'), ['resume', 'cancel'])
})

test('triggersFrom splits what the user may click from what triage pulls', () => {
  assert.deepEqual(triggersFrom('plan_ready', 'you'), ['approve', 'send_back', 'cancel'])
  assert.deepEqual(triggersFrom('plan_ready', 'engine'), [])
  assert.deepEqual(triggersFrom('running', 'engine'), ['yield', 'wait_world', 'ask_you', 'result'])
  assert.deepEqual(triggersFrom('running', 'you'), ['pause', 'cancel'])
})

test('turn: the user at review, approval and result; the world at a gate; nobody when paused or over', () => {
  const turns = Object.fromEntries(GOAL_STATES.map((s) => [s, turnOf(s)]))
  assert.deepEqual(turns, {
    draft_plan: 'ai',
    plan_ready: 'me',
    queued: 'ai',
    running: 'ai',
    waiting_world: 'others',
    waiting_you: 'me',
    result_ready: 'me',
    done: 'none',
    paused: 'none',
    cancelled: 'none',
  })
})

test('isGoalState accepts the ten states only', () => {
  for (const s of GOAL_STATES) assert.ok(isGoalState(s))
  for (const v of ['stopped', 'gate', '', null, 3]) assert.equal(isGoalState(v), false)
})

test('parseDuration reads the plan format and rejects the rest', () => {
  assert.equal(parseDuration('30s'), 30_000)
  assert.equal(parseDuration('5m'), 300_000)
  assert.equal(parseDuration(' 4h '), 14_400_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.equal(parseDuration('1.5h'), 5_400_000)
  for (const bad of ['', '5', 'm', '0m', '-5m', '5 minutes', '5w']) assert.equal(parseDuration(bad), null, bad)
})
