import type { TeamPermissions, TeamRecipe } from './recipe.js'

export type Slice = { title: string; brief: string }
export type Severity = 'P0' | 'P1' | 'P2'
/** A review finding. `id` is triage's (`T2-F1`): stable across fix rounds, so a fixer closes each one by name. */
export type Finding = { id?: string; severity: Severity; where: string; problem: string; fix: string }
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'deferred'
/** A fixer's answer to one finding. */
export type Resolution = { id: string; status: Exclude<FindingStatus, 'open'>; note: string }

/** One acceptance criterion as a worker reports it: by id (`T2.1` for a task's, `C1` for the card's). */
export type CriterionStatus = 'met' | 'not met' | 'partly' | 'unreported'
export type CriterionReport = { id: string; status: CriterionStatus; evidence: string }

/**
 * The run's ledger: what workers learned, appended as they hand in, never
 * rewritten, never capped on disk (only what's inlined into a prompt is cut).
 * `where` maps the code for whoever comes next; `failed` keeps a fix round from
 * repeating an earlier one; `verify` says how to check this project.
 */
export type LedgerKind = 'decision' | 'surprise' | 'failed' | 'where' | 'verify' | 'note' | 'resume'
export type LedgerEntry = { kind: LedgerKind; task: string | null; by: string; text: string; why?: string; at?: number }

/** The lead's sizing of one step: a model override, and the slices of a fan-out step it chose upfront. */
export type CardStep = { id: string; model: string | null; slices: Slice[] | null }

/** One task on the plan: a unit the task loop builds and verifies on its own. */
export type PlanTask = { id: string; title: string; criteria: string[] }

/** What you approve: the work, the tasks it splits into, and how the team is sized for it. */
export type TeamCard = {
  goal: string
  criteria: string[]
  outOfScope: string[]
  /** the task loop's work list, in order; empty for a team without a loop */
  tasks: PlanTask[]
  /** what you (or the lead, with your OK) decided, every agent reads these */
  decisions: string[]
  steps: CardStep[]
  budgetUsd: number
  /** what the workers may do without asking, yours to pick before it runs (the team file may preselect it) */
  permissions: TeamPermissions | null
  /** every worker in fast mode: yours to turn on (the team file may preselect it); switchable mid-run */
  fast: boolean
  /** the lead's note to you: why this team, what it left out */
  note: string
}

/** The agent fields a run needs, copied at approval so a later file edit never rewrites a run. */
export type RunAgent = { name: string; label: string; color: string; model: string | null; effort: string | null; prompt: string; can: string[] }

export type Worker = {
  /** `<step>:<n>`, or `<step>:<task>:<n>` in the task loop */
  id: string
  stepId: string
  /** the task it works, in the loop */
  task?: string
  /** `lead` or an agent's name */
  agent: string
  label: string
  color: string
  slice: Slice | null
  /** null until triage spawns its session */
  sessionId: string | null
}

export type CheckResult = { cmd: string; ok: boolean; tail: string }

/** One handoff: a worker's submission, or triage's own record of a checks step. */
export type Handoff = {
  id: string
  stepId: string
  /** the task it belongs to, in the loop */
  task?: string
  round: number
  /** null for a checks step */
  workerId: string | null
  label: string
  at: number
  /** one line: what the step tracker shows */
  summary: string
  /** the full text, forwarded verbatim to whoever reads it next */
  body: string
  verdict?: 'pass' | 'fail'
  findings?: Finding[]
  files?: string[]
  checks?: CheckResult[]
  /** each acceptance criterion the step answered for, by id */
  criteria?: CriterionReport[]
  /** what the reviewer should look at hardest. The one part of a builder's handoff a reviewer reads */
  unsure?: string
  /** a fix round: the builder's answer to each open finding */
  resolutions?: Resolution[]
  /** this handoff's file in the run folder, relative to it */
  file?: string
}

/**
 * One run: a worker's go at one step, for one task and fix round, what the
 * session page marks with a divider. Recorded when triage sends the step; a
 * nudge or a resume is more of the same run, not a new one.
 */
export type WorkerRun = {
  /** `<worker id>#<round>` */
  id: string
  workerId: string
  stepId: string
  task?: string
  round: number
  /** started in a clean context */
  fresh: boolean
  /** stamped by the server as it sends the step: the session event the run starts at, when, and the session's spend before it */
  startSeq: number | null
  at: number | null
  spendAtStart: number | null
  /** the patch file it was sent, when its diff was too long to inline */
  patch?: string
  /** the handoff it ended with; null while it works, or if it never submitted */
  handoffId: string | null
  /** this run started (or carried on) because someone resumed the team */
  resumedBy?: ResumeBy
}

/** Who got a stopped team moving again. */
export type ResumeBy = 'junior' | 'you'
/** One resume, as the runs panel and the ledger show it. */
export type RunResume = { at: number; by: ResumeBy; what: string; why: string }

/** A goal's horizon: finish today, by a date (`at` = the deadline), or keep going until done. */
export type GoalHorizonKind = 'today' | 'by' | 'until_done'
export type RunGoalHorizon = { kind: GoalHorizonKind; at: number | null }
/** A question Junior asked you, with the answer it recommends. */
export type GoalQuestion = { id: string; text: string; recommended: string; at: number; answer: string | null; answeredAt: number | null }
/** Junior's judgement of the done-when, each time it looked. */
export type GoalVerdict = { at: number; met: boolean; evidence: string; round: number }

/** What makes a run a goal. */
export type RunGoal = {
  /** the outcome, in words, Junior judges it when the team finishes a round */
  doneWhen: string
  horizon: RunGoalHorizon
  /** rounds after the first: each starts when Junior judged the done-when not met */
  round: number
  /** what's still missing, from the last verdict. Every worker in the round reads it */
  gap: string | null
  /** what the lead owes before the team can move: a verdict on the done-when, or a way past what stopped the team */
  owes: 'verdict' | 'unstick' | null
  /** what stopped the team, and the step a retry goes back to */
  stuck: { why: string; backTo: number } | null
  /** asleep on the world until a time */
  wait: { until: number; for: string } | null
  /** Junior's guidance for the builder, for the fix round it retried with */
  guidance?: { text: string; round: number } | null
  verdicts: GoalVerdict[]
  questions: GoalQuestion[]
  /** you accepted the result */
  acceptedAt: number | null
}

export type TaskStatus = 'todo' | 'running' | 'done' | 'unresolved'
export type TaskState = { status: TaskStatus; round: number; why?: string }
export type PlanNote = { task: string | null; by: string; text: string }

/** `waiting`: a goal asleep on the world (CI, a reviewer, a date) until `goal.wait.until`. */
export type RunState = 'proposed' | 'running' | 'gate' | 'waiting' | 'paused' | 'stopped' | 'done'

export type TeamRun = {
  id: string
  itemId: string
  title: string
  createdAt: number
  /** the team file it came from; null = drafted for this run */
  team: string | null
  recipe: TeamRecipe
  card: TeamCard
  agents: RunAgent[]
  leadSessionId: string
  state: RunState
  /** why it's paused, stopped or waiting */
  reason?: string
  /** index into recipe.steps */
  step: number
  /** the lead was asked to split the current fan-out step and hasn't yet */
  splitting: boolean
  /** fix rounds used, on the current task, in the loop */
  round: number
  /** index into card.tasks while the task loop runs, else null */
  task: number | null
  /** per task id */
  tasks: Record<string, TaskState>
  workers: Worker[]
  /** every run, in the order triage sent them */
  workerRuns: WorkerRun[]
  /** workers the current step still waits on */
  awaiting: string[]
  /** awaited workers that submitted mid-turn: acted on when their turn ends */
  submitted: string[]
  outputs: Handoff[]
  /** runs from before the ledger: what implementers left for whoever builds next (read-only now) */
  notes: PlanNote[]
  /** what workers learned, append-only (see LedgerEntry) */
  ledger: LedgerEntry[]
  /** every review finding's state, by id */
  findingState: Record<string, { status: FindingStatus; note?: string; round: number }>
  /** the project's checks as they stood when you approved, so a worker tells a pre-existing failure from its own */
  baseline?: { results: CheckResult[]; at: number } | null
  /** the run folder (plan, ledger, verify, handoffs, reviews, patches), set by the server */
  dir?: string
  /** a change to the task list the lead proposed, waiting for your OK (applied between tasks) */
  revision: { tasks: PlanTask[]; why: string } | null
  /** what a fix round sends back to the change step */
  feedback: string | null
  /** set when a fix loop ran out: what's still failing */
  unresolved: string | null
  /** USD per session id (the lead's included) */
  spend: Record<string, number>
  budgetUsd: number
  /** bumps on every change: the client's cue to refetch */
  rev: number
  /** `<step>:<round>:<worker>` already nudged, so a nudge never loops */
  nudged: string[]
  /** runs from before the run folder: their Plan artifact (left as it was; new runs keep everything in the folder) */
  planArtifactId?: string
  resultArtifactId?: string
  /** server-side: the project root, its checks, the tree the run and the current task started from */
  root?: string
  checkCmds?: string[]
  runBase?: string
  baseTree?: string
  /** the tree when the run ended: what it changed stays what it changed, whatever happens to the checkout after */
  endTree?: string
  /** set when the run is a goal */
  goal?: RunGoal | null
  /** every resume, oldest first, by Junior or by you */
  resumes?: RunResume[]
  /** fix rounds before this one don't count against the cap: Junior got the team moving again here */
  roundFloor?: number
  /** the state a pause interrupted, so a resume goes back to it */
  pausedFrom?: { state: 'running' | 'gate' | 'waiting'; reason?: string } | null
  /** who the next worker runs are marked as resumed by */
  resumeMark?: ResumeBy | null
}

export type DiffScope = 'task' | 'run'

export type Action =
  /** message a worker (spawning its session first if it has none); `fresh` = a clean context; `diff` = append that diff */
  | { kind: 'tell'; workerId: string; text: string; fresh: boolean; diff: DiffScope | false }
  /** message the lead session */
  | { kind: 'tellLead'; text: string }
  | { kind: 'checks' }
  | { kind: 'notice'; text: string }
  /** photograph the working tree: the run's start, or the current task's */
  | { kind: 'snapshot'; scope: DiffScope }
  | { kind: 'finish' }
