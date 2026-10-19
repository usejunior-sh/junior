import type { SessionEvent } from './wire.js'

// Ultracode workflows
//
// An Ultracode session runs Claude Code with `settings.ultracode`, so the agent
// orchestrates big jobs with the Workflow tool: a script that fans work out to
// many agents. The Workflow call returns at once and the run goes on in the
// background. Its live state arrives on the session's own stream (task_*
// messages, each task_progress carrying a full `workflow_progress` snapshot),
// and core/workflows/fold.ts folds that into `WorkflowRun`s. What the stream
// doesn't carry (each agent's transcript, its cost, the script) is read from
// Claude Code's files on disk by GET /api/sessions/:id/workflows/:taskId.

export type WorkflowState = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'
export type WorkflowAgentState = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'

/** One entry of a task_progress `workflow_progress` snapshot, as the CLI sends it. */
export type WorkflowProgressEntry =
  | { type: 'workflow_phase'; index: number; title: string; detail?: string }
  | {
      type: 'workflow_agent'
      index: number
      label?: string
      phaseIndex?: number
      phaseTitle?: string
      agentId?: string
      model?: string
      /** 'start' while it runs, 'done' once it returned; other values are mapped by the fold. */
      state?: string
      startedAt?: number
      queuedAt?: number
      attempt?: number
      promptPreview?: string
      lastProgressAt?: number
      lastToolName?: string
      lastToolSummary?: string
      tokens?: number
      toolCalls?: number
      durationMs?: number
      resultPreview?: string
      error?: string
    }

export type WorkflowPhase = { index: number; title: string; detail?: string }

export type WorkflowAgent = {
  /** Order the script launched it in, 1-based. The key until the agent has an id. */
  index: number
  label: string
  phaseIndex?: number
  phase?: string
  /** The agent's own id: names its transcript file. Unknown while queued. */
  agentId?: string
  model?: string
  state: WorkflowAgentState
  queuedAt?: number
  startedAt?: number
  /** Last time it reported anything: the clock's end for a finished agent. */
  lastProgressAt?: number
  attempt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
  promptPreview?: string
  resultPreview?: string
  /** What it is doing now, e.g. "Bash · npm test". */
  activity?: string
  error?: string
}

export type WorkflowRun = {
  /** The Workflow tool_use that launched it: the key, and where its card sits in the transcript. */
  toolUseId: string
  /** The task id: what stopTask takes. Unknown until the CLI registers the run. */
  taskId?: string
  /** The run's own id (wf_…): names its folder on disk. */
  runId?: string
  /** meta.name from the script. */
  name: string
  /** meta.description from the script, or the CLI's summary. */
  summary: string
  /** The agent that launched it; null for the main agent. */
  parentToolUseId: string | null
  state: WorkflowState
  /** The CLI registered the run (its receipt or task_started). False while the call waits on a prompt, or after it was refused. */
  launched: boolean
  /** When the Workflow call was made: before any permission prompt. */
  requestedAt?: number
  /** When the CLI launched it: the run's clock starts here, not at the call. */
  startedAt?: number
  endedAt?: number
  /** The unlaunched call waits on the user's permission prompt. */
  awaitingOk?: boolean
  phases: WorkflowPhase[]
  agents: WorkflowAgent[]
  /** Totals as the CLI counts them (workflow agents only). */
  tokens: number
  toolUses: number
  durationMs?: number
  /** Sent to a cloud session (a 'remote_launched' receipt): where it runs. Its agents never show here. */
  sessionUrl?: string
  /** Absolute paths the Workflow call reported, used by the server only. */
  transcriptDir?: string
  scriptPath?: string
  /** The launch was refused, or the run failed: the reason. */
  error?: string
}

/** Disk-only extras for one run (GET /api/sessions/:id/workflows/:taskId). */
export type WorkflowAgentCost = { costUsd: number; tokens: number; toolCalls: number; model?: string }

export type WorkflowDetail = {
  runId: string
  /** List-price estimate of every workflow agent's calls, priced like the usage ledger. */
  costUsd: number
  /** Per agent, keyed by agentId. */
  agents: Record<string, WorkflowAgentCost>
  /** The script the run executed. */
  script?: string
  /** What the script returned, once it finished (clipped). */
  result?: string
  /** log() lines from the script. */
  logs?: string[]
  /** Terminal state as the run's state file has it, when it has one. */
  state?: WorkflowState
  /** Phases and agents from the state file, for runs whose stream was lost (an older session, a restart). */
  phases?: WorkflowPhase[]
  runAgents?: WorkflowAgent[]
}

/** One workflow agent's transcript (GET /api/sessions/:id/workflows/:taskId/agents/:agentId). */
export type WorkflowAgentTranscript = {
  agentId: string
  label?: string
  phase?: string
  model?: string
  /** The task text it was given, without the harness frame. */
  prompt?: string
  /** Its messages as `sdk` events, main-agent scoped (parent_tool_use_id null), for buildTranscript. */
  events: SessionEvent[]
  /** Epoch ms per event, same order as `events`. */
  times: number[]
  /** What it returned, from the run's journal. */
  result?: string
  costUsd: number
}

export type WorkflowDetailResponse = { ok: true; workflow: WorkflowDetail } | { ok: false; error: string }
export type WorkflowAgentResponse = { ok: true; transcript: WorkflowAgentTranscript } | { ok: false; error: string }
