/**
 * The goals adapter (GoalStore in core/store/types.ts) over the tables in
 * GOALS_SCHEMA (core/store/sqlite-migrations.ts). openSqliteStore wires it in
 * like every other store.
 *
 * Every method is synchronous underneath (node:sqlite), so a check-then-write
 * inside one method can't interleave with another caller. Transitions are
 * `UPDATE … WHERE id = ? AND state = ?` plus the event insert in one
 * BEGIN/COMMIT, the same first-writer-wins shape as job_runs.finish.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  isGoalHorizon,
  isGoalState,
  GATE_STATUSES,
  GOAL_EVENT_KINDS,
  STEP_ROLES,
  STEP_STATUSES,
  type Gate,
  type GateStatus,
  type GateVerdict,
  type Goal,
  type GoalActor,
  type GoalBudget,
  type GoalEvent,
  type GoalEventKind,
  type GoalPlan,
  type GoalState,
  type GoalStepState,
  type SessionOutcome,
  type StepRole,
  type StepStatus,
  TERMINAL_STATES,
} from '../goals/types.js'
import type { GoalQuery, GoalSessionRecord, GoalStore, NewGoal } from './types.js'

type GoalRow = {
  id: string
  title: string
  done_when: string
  horizon: string
  state: string
  reason: string | null
  source_item_id: string | null
  key: string | null
  project_id: string | null
  checkout_id: string | null
  plan: string | null
  plan_version: number
  current_step: string | null
  budget: string
  spent_usd: number
  priority: number
  created_at: number
  updated_at: number
}

type EventRow = {
  goal_id: string
  seq: number
  at: number
  actor: string
  session_id: string | null
  kind: string
  from_state: string | null
  to_state: string | null
  detail: string | null
  handled_at: number | null
}

type StepRow = {
  goal_id: string
  step_id: string
  status: string
  attempts: number
  session_id: string | null
  started_at: number | null
  ended_at: number | null
  updated_at: number
}

type GateRow = {
  id: string
  goal_id: string
  step_id: string
  evaluator: string
  condition: string
  connectors: string
  status: string
  refs: string
  armed_at: number
  next_check_at: number | null
  checks: number
  check_every_ms: number | null
  deadline_at: number
  confirmations_needed: number
  confirmations_seen: number
  last_verdict: string | null
  item_id: string | null
  settled_at: number | null
}

type SessionRow = {
  goal_id: string
  session_id: string
  role: string
  step_id: string | null
  plan_version: number
  started_at: number
  ended_at: number | null
  commits: string
  files: string
  commands: string
  actions: string
  outcome: string | null
  cost_usd: number | null
}

function json<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const strings = (raw: string): string[] => {
  const v = json<unknown>(raw, [])
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function toBudget(raw: string): GoalBudget {
  const b = json<Partial<GoalBudget>>(raw, {})
  return { usd: typeof b.usd === 'number' ? b.usd : null, minutes: typeof b.minutes === 'number' ? b.minutes : null }
}

const ACTORS: readonly GoalActor[] = ['you', 'engine', 'lead', 'worker', 'gate', 'watcher']

/** Storage is text; a value this build doesn't know reads back as the safest neighbour. */
const toGoal = (r: GoalRow): Goal => ({
  id: r.id,
  title: r.title,
  doneWhen: r.done_when,
  horizon: isGoalHorizon(r.horizon) ? r.horizon : 'until_done',
  state: isGoalState(r.state) ? r.state : 'paused',
  reason: r.reason,
  sourceItemId: r.source_item_id,
  key: r.key,
  projectId: r.project_id,
  checkoutId: r.checkout_id,
  plan: json<GoalPlan | null>(r.plan, null),
  planVersion: r.plan_version,
  currentStep: r.current_step,
  budget: toBudget(r.budget),
  spentUsd: r.spent_usd,
  priority: r.priority,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toEvent = (r: EventRow): GoalEvent => ({
  goalId: r.goal_id,
  seq: r.seq,
  at: r.at,
  actor: (ACTORS as readonly string[]).includes(r.actor) ? (r.actor as GoalActor) : 'engine',
  sessionId: r.session_id,
  kind: (GOAL_EVENT_KINDS as readonly string[]).includes(r.kind) ? (r.kind as GoalEventKind) : 'transition',
  from: isGoalState(r.from_state) ? r.from_state : null,
  to: isGoalState(r.to_state) ? r.to_state : null,
  detail: json<Record<string, unknown> | null>(r.detail, null),
  handledAt: r.handled_at,
})

const toStep = (r: StepRow): GoalStepState => ({
  goalId: r.goal_id,
  stepId: r.step_id,
  status: (STEP_STATUSES as readonly string[]).includes(r.status) ? (r.status as StepStatus) : 'blocked',
  attempts: r.attempts,
  sessionId: r.session_id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  updatedAt: r.updated_at,
})

const toGate = (r: GateRow): Gate => ({
  id: r.id,
  goalId: r.goal_id,
  stepId: r.step_id,
  evaluator: r.evaluator === 'ai' || r.evaluator === 'watcher' ? r.evaluator : 'user',
  condition: r.condition,
  connectors: strings(r.connectors),
  status: (GATE_STATUSES as readonly string[]).includes(r.status) ? (r.status as GateStatus) : 'needs_user',
  refs: strings(r.refs),
  armedAt: r.armed_at,
  nextCheckAt: r.next_check_at,
  checks: r.checks,
  checkEveryMs: r.check_every_ms,
  deadlineAt: r.deadline_at,
  confirmationsNeeded: r.confirmations_needed,
  confirmationsSeen: r.confirmations_seen,
  lastVerdict: json<GateVerdict | null>(r.last_verdict, null),
  itemId: r.item_id,
  settledAt: r.settled_at,
})

const OUTCOMES: readonly SessionOutcome[] = ['done', 'failed', 'blocked']

const toSession = (r: SessionRow): GoalSessionRecord => ({
  goalId: r.goal_id,
  sessionId: r.session_id,
  role: (STEP_ROLES as readonly string[]).includes(r.role) ? (r.role as StepRole) : 'builder',
  stepId: r.step_id,
  planVersion: r.plan_version,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  commits: strings(r.commits),
  files: strings(r.files),
  commands: json<{ cmd: string; ok: boolean }[]>(r.commands, []),
  actions: strings(r.actions),
  outcome: (OUTCOMES as readonly string[]).includes(r.outcome ?? '') ? (r.outcome as SessionOutcome) : null,
  costUsd: r.cost_usd,
})

/** goal fields that `update` may write → their columns. */
const PATCHABLE: Record<string, { col: string; enc?: (v: unknown) => unknown }> = {
  title: { col: 'title' },
  doneWhen: { col: 'done_when' },
  horizon: { col: 'horizon' },
  reason: { col: 'reason' },
  sourceItemId: { col: 'source_item_id' },
  key: { col: 'key' },
  projectId: { col: 'project_id' },
  checkoutId: { col: 'checkout_id' },
  plan: { col: 'plan', enc: (v) => (v === null ? null : JSON.stringify(v)) },
  planVersion: { col: 'plan_version' },
  currentStep: { col: 'current_step' },
  budget: { col: 'budget', enc: (v) => JSON.stringify(v) },
  spentUsd: { col: 'spent_usd' },
  priority: { col: 'priority' },
}

export class SqliteGoals implements GoalStore {
  constructor(private db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private insertEvent(e: Omit<GoalEvent, 'seq' | 'handledAt'>): GoalEvent {
    const row = this.db
      .prepare(
        `INSERT INTO goal_events (goal_id, seq, at, actor, session_id, kind, from_state, to_state, detail)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM goal_events WHERE goal_id = ?
         RETURNING *`,
      )
      .get(e.goalId, e.at, e.actor, e.sessionId, e.kind, e.from, e.to, e.detail === null ? null : JSON.stringify(e.detail), e.goalId) as EventRow
    return toEvent(row)
  }

  async get(id: string): Promise<Goal | null> {
    const r = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined
    return r ? toGoal(r) : null
  }

  async byKey(key: string): Promise<Goal | null> {
    const r = this.db.prepare('SELECT * FROM goals WHERE key = ?').get(key) as GoalRow | undefined
    return r ? toGoal(r) : null
  }

  async list(q: GoalQuery = {}): Promise<Goal[]> {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.states?.length) {
      where.push(`state IN (${q.states.map(() => '?').join(', ')})`)
      args.push(...q.states)
    }
    if (q.sourceItemId) {
      where.push('source_item_id = ?')
      args.push(q.sourceItemId)
    }
    const sql = `SELECT * FROM goals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id LIMIT ?`
    return (this.db.prepare(sql).all(...args, q.limit ?? 500) as GoalRow[]).map(toGoal)
  }

  async create(goal: NewGoal, at: number): Promise<{ goal: Goal; created: boolean }> {
    return this.tx(() => {
      const taken = goal.key
        ? (this.db.prepare('SELECT * FROM goals WHERE key = ?').get(goal.key) as GoalRow | undefined)
        : ((this.db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id) as GoalRow | undefined) ??
          (this.db
            .prepare(`SELECT * FROM goals WHERE key IS NULL AND title = ? AND done_when = ? AND state NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 1`)
            .get(goal.title, goal.doneWhen, ...TERMINAL_STATES) as GoalRow | undefined))
      if (taken) return { goal: toGoal(taken), created: false }
      this.db
        .prepare(
          `INSERT INTO goals (id, title, done_when, horizon, state, source_item_id, key, project_id, budget, priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft_plan', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(goal.id, goal.title, goal.doneWhen, goal.horizon, goal.sourceItemId, goal.key, goal.projectId, JSON.stringify(goal.budget), goal.priority, at, at)
      this.insertEvent({ goalId: goal.id, at, actor: 'engine', sessionId: null, kind: 'created', from: null, to: 'draft_plan', detail: null })
      return { goal: toGoal(this.db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id) as GoalRow), created: true }
    })
  }

  async update(id: string, patch: Partial<Omit<Goal, 'id' | 'state' | 'createdAt' | 'updatedAt'>>, at: number): Promise<Goal | null> {
    const sets: string[] = []
    const args: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      const p = PATCHABLE[k]
      if (!p || v === undefined) continue
      sets.push(`${p.col} = ?`)
      args.push(p.enc ? p.enc(v) : v)
    }
    sets.push('updated_at = ?')
    args.push(at)
    this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...(args as (string | number | null)[]), id)
    return this.get(id)
  }

  async move(id: string, from: GoalState, to: GoalState, ev: Pick<GoalEvent, 'actor' | 'sessionId' | 'detail'> & { reason?: string | null }, at: number): Promise<boolean> {
    return this.tx(() => {
      const res = this.db
        .prepare('UPDATE goals SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND state = ?')
        .run(to, ev.reason ?? null, at, id, from)
      if (Number(res.changes) === 0) return false
      this.insertEvent({ goalId: id, at, actor: ev.actor, sessionId: ev.sessionId, kind: 'transition', from, to, detail: ev.detail })
      return true
    })
  }

  async addEvent(e: Omit<GoalEvent, 'seq' | 'handledAt'>): Promise<GoalEvent> {
    return this.insertEvent(e)
  }

  async events(goalId: string, opts: { after?: number; limit?: number } = {}): Promise<GoalEvent[]> {
    const rows = this.db
      .prepare('SELECT * FROM goal_events WHERE goal_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(goalId, opts.after ?? 0, opts.limit ?? 10_000) as EventRow[]
    return rows.map(toEvent)
  }

  async unhandled(): Promise<GoalEvent[]> {
    const rows = this.db.prepare('SELECT * FROM goal_events WHERE handled_at IS NULL ORDER BY at, goal_id, seq').all() as EventRow[]
    return rows.map(toEvent)
  }

  async markHandled(goalId: string, seq: number, at: number): Promise<void> {
    this.db.prepare('UPDATE goal_events SET handled_at = ? WHERE goal_id = ? AND seq = ? AND handled_at IS NULL').run(at, goalId, seq)
  }

  async steps(goalId: string): Promise<GoalStepState[]> {
    return (this.db.prepare('SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY rowid').all(goalId) as StepRow[]).map(toStep)
  }

  async putStep(s: GoalStepState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_steps (goal_id, step_id, status, attempts, session_id, started_at, ended_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (goal_id, step_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
           session_id = excluded.session_id, started_at = excluded.started_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
      )
      .run(s.goalId, s.stepId, s.status, s.attempts, s.sessionId, s.startedAt, s.endedAt, s.updatedAt)
  }

  async gate(id: string): Promise<Gate | null> {
    const r = this.db.prepare('SELECT * FROM goal_gates WHERE id = ?').get(id) as GateRow | undefined
    return r ? toGate(r) : null
  }

  async gates(goalId: string): Promise<Gate[]> {
    return (this.db.prepare('SELECT * FROM goal_gates WHERE goal_id = ? ORDER BY armed_at, id').all(goalId) as GateRow[]).map(toGate)
  }

  async putGate(g: Gate): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_gates (id, goal_id, step_id, evaluator, condition, connectors, status, refs, armed_at, next_check_at, checks,
           check_every_ms, deadline_at, confirmations_needed, confirmations_seen, last_verdict, item_id, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET evaluator = excluded.evaluator, condition = excluded.condition, connectors = excluded.connectors,
           status = excluded.status, refs = excluded.refs, next_check_at = excluded.next_check_at, checks = excluded.checks,
           check_every_ms = excluded.check_every_ms, deadline_at = excluded.deadline_at, confirmations_needed = excluded.confirmations_needed,
           confirmations_seen = excluded.confirmations_seen, last_verdict = excluded.last_verdict, item_id = excluded.item_id,
           settled_at = excluded.settled_at`,
      )
      .run(g.id, g.goalId, g.stepId, g.evaluator, g.condition, JSON.stringify(g.connectors), g.status, JSON.stringify(g.refs), g.armedAt,
        g.nextCheckAt, g.checks, g.checkEveryMs, g.deadlineAt, g.confirmationsNeeded, g.confirmationsSeen,
        g.lastVerdict === null ? null : JSON.stringify(g.lastVerdict), g.itemId, g.settledAt)
  }

  async dueGates(now: number): Promise<Gate[]> {
    const rows = this.db
      .prepare(`SELECT * FROM goal_gates WHERE status = 'open' AND evaluator = 'ai' AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at, id`)
      .all(now) as GateRow[]
    return rows.map(toGate)
  }

  async overdueGates(now: number): Promise<Gate[]> {
    const rows = this.db.prepare(`SELECT * FROM goal_gates WHERE status = 'open' AND deadline_at <= ? ORDER BY deadline_at, id`).all(now) as GateRow[]
    return rows.map(toGate)
  }

  async putSession(r: GoalSessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_sessions (goal_id, session_id, role, step_id, plan_version, started_at, ended_at, commits, files, commands, actions, outcome, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (goal_id, session_id) DO UPDATE SET role = excluded.role, step_id = excluded.step_id, plan_version = excluded.plan_version,
           ended_at = excluded.ended_at, commits = excluded.commits, files = excluded.files, commands = excluded.commands,
           actions = excluded.actions, outcome = excluded.outcome, cost_usd = excluded.cost_usd`,
      )
      .run(r.goalId, r.sessionId, r.role, r.stepId, r.planVersion, r.startedAt, r.endedAt, JSON.stringify(r.commits), JSON.stringify(r.files),
        JSON.stringify(r.commands), JSON.stringify(r.actions), r.outcome, r.costUsd)
  }

  async sessions(goalId: string): Promise<GoalSessionRecord[]> {
    return (this.db.prepare('SELECT * FROM goal_sessions WHERE goal_id = ? ORDER BY started_at, session_id').all(goalId) as SessionRow[]).map(toSession)
  }
}
