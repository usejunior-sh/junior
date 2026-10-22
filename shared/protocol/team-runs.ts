import type { RunState, RunGoalHorizon, RunGoal, GoalVerdict, TeamRun } from '../../core/teams/engine.js'
import type { TeamLibraryResponse } from './library.js'

export type {
  CardStep,
  CriterionReport,
  Finding,
  GoalHorizonKind,
  GoalQuestion,
  GoalVerdict,
  Handoff,
  LedgerEntry,
  PlanNote,
  PlanTask,
  ResumeBy,
  RunGoal,
  RunGoalHorizon,
  RunResume,
  RunState,
  Slice,
  TaskState,
  TeamCard,
  TeamRun,
  Worker,
  WorkerRun,
} from '../../core/teams/engine.js'

/** A session's place on a team run: the lead (the chat that proposed it) or one of its workers. `goal`: the run is a goal. */
export type SessionTeamRun = { id: string; role: 'lead' | 'worker'; label: string; state: RunState; rev: number; goal?: boolean }

/** One row of the Goals tab (GET /api/teams/goals): a team run that is a goal. */
export type TeamGoalSummary = {
  runId: string
  itemId: string
  leadSessionId: string
  title: string
  team: string
  doneWhen: string
  horizon: RunGoalHorizon
  state: RunState
  reason: string | null
  /** rounds after the first */
  round: number
  /** what Junior is working out before the team moves */
  owes: RunGoal['owes']
  /** questions waiting on your answer */
  asks: number
  wait: RunGoal['wait']
  acceptedAt: number | null
  lastVerdict: GoalVerdict | null
  resumes: number
  overdue: boolean
  spentUsd: number
  budgetUsd: number
  /** whose move it is */
  turn: 'you' | 'junior' | 'world' | 'none'
  updatedAt: number
}
export type TeamGoalsResponse = { ok: true; goals: TeamGoalSummary[] } | { ok: false; error: string }

/** A run as the client reads it (GET /api/teams/run): everything but the server's bookkeeping. */
export type TeamRunView = Omit<TeamRun, 'root' | 'checkCmds' | 'baseTree' | 'nudged'> & { spentUsd: number }
export type TeamRunResponse = { ok: true; run: TeamRunView } | { ok: false; error: string }

/**
 * One row of a run's Files panel (GET /api/teams/files): what the team works
 * from (ledger), what it is (team), what it changed, and what it left as proof.
 */
export type TeamRunFile = {
  group: 'ledger' | 'team' | 'changed' | 'evidence'
  name: string
  /** a path or a short description, shown under the name */
  detail: string
  /** who wrote it: `junior`, `you`, `Junior`, or a member's label */
  writer: string
  /** who reads it, when that's known */
  readers: string[]
  /** what the row opens */
  open:
    | { kind: 'artifact'; id: string }
    | { kind: 'project'; path: string }
    | { kind: 'file'; path: string }
    /** a file in the run folder, relative to it, opens inline (GET /api/teams/file) */
    | { kind: 'runfile'; path: string }
    | { kind: 'library'; library: 'team' | 'agent'; name: string }
    | { kind: 'handoff'; id: string }
    | null
  /** the runs that wrote or produced it (WorkerRun ids). The row's "by T2" links */
  runs: string[]
  /** still being written: the plan, or a file the working run is changing */
  live?: boolean
  /** changed files: lines added and removed since the run started */
  added?: number
  removed?: number
  status?: 'added' | 'modified' | 'deleted'
  /** a short count or result shown on the right (`548/548`, `3`, `14.2k`) */
  badge?: string
}
export type TeamRunFilesResponse = { ok: true; files: TeamRunFile[] } | { ok: false; error: string }
export type TeamRunFileResponse = { ok: true; text: string } | { ok: false; error: string }
/** One file in a run's folder, as the run page lists it (GET /api/teams/folder). */
export type TeamRunFolderFile = { path: string; label: string; group: 'run' | 'handoffs' | 'patches'; badge?: string }
export type TeamRunFolderResponse =
  | { ok: true; title: string; team: string; state: RunState; leadSessionId: string; dir: string; files: TeamRunFolderFile[] }
  | { ok: false; error: string }

/** One team in the dispatch picker, with what its finished runs really cost (never an estimate). */
export type TeamPickerOption = {
  team: string
  label: string
  description: string
  /** step ids, a fan-out shown as "review ×4" */
  steps: string[]
  budgetUsd: number
  runs: number
  avgUsd?: number
}
export type TeamPickerResponse = { ok: true; suggested: string | null; options: TeamPickerOption[] } | { ok: false; error: string }
export type TeamPlanResponse = { ok: true; sessionId: string } | { ok: false; error: string }
export type SaveAsTeamResponse = { ok: true; team: string; library: TeamLibraryResponse & { ok: true } } | { ok: false; error: string }
