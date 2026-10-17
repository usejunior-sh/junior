import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { type GateChecker, ghPrSource, type GoalEngine, goalGateSweepOp, goalLeadSettledOp, goalLeadStartedOp, goalMaxTeam, goalSessionEndedOp, type GoalSessionTag, goalWatchPrsOp, pumpGoals, type StartSpec } from './goals.js'
import { DEFAULT_GOAL_MODELS, type GateVerdict, type Goal, type GoalEvent } from '../core/goals/types.js'
import { GATE_SERVER, GATE_TOOL_SEARCH, GATE_VERDICT_FULL, GATE_VERDICT_TOOL, gateCheckPrompt, gateFenceDecision, gateReadTools, gateServers, verdictFrom } from '../core/goals/gates.js'
import { power } from './power.js'
import { workspaceDir } from './workspaces.js'
import { log } from './log.js'
import { humanSpan } from '../core/job/schedule.js'
import { defaultBranch, removeWorktree } from './worktrees.js'
import type { Checkout, Project } from '../shared/protocol.js'
import { GOAL_SESSION_TIMEOUT_MS, ROLE_AGENT } from '../core/goals/run.js'
import { leadDraftPrompt, type LeadWake } from '../core/goals/review.js'
import { BRIEF_DISALLOWED_TOOLS } from './session/brief-tools.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { probeConnectors } from './workspace/probes.js'
import { pExecFile, VERSION } from './config.js'
import { errText } from './errors.js'
import { openInEditor } from './artifacts-ops.js'
import { makeWorktree, syncCheckouts } from './session/checkouts.js'
import { createSession, getOrRevive } from './session/sessions.js'
import { linkSessionToItem } from './settings-ops.js'

// ---------------------------------------------------------------------------
// Goals: the drafting lead (server/goals.ts reacts, this spawns). One headless,
// read-only session per wake whose one write is goal_propose_plan; its turn's
// end settles it, which marks the waking event handled.
// ---------------------------------------------------------------------------

const GOAL_LEAD_TIMEOUT_MS = 20 * 60_000
/** What a drafting lead may call beyond reads: the goal reads and its plan. */
export const GOAL_LEAD_TOOLS = new Set(['mcp__triage__goal_get', 'mcp__triage__goal_list', 'mcp__triage__goal_propose_plan'])
/** A brief's hidden tools, plus the goal writes that aren't the lead's in M2. */
export const GOAL_LEAD_DISALLOWED_TOOLS = [...BRIEF_DISALLOWED_TOOLS, ...['goal_create', 'goal_log_append', 'goal_handoff_write'].map((t) => `mcp__triage__${t}`)]

export type GoalLead = { goalId: string; sessionId: string; seq: number; timer: ReturnType<typeof setTimeout>; release: () => void }

/**
 * What a goal run's session can't reach: the questions nobody answers, the
 * triage writes outside its goal, and the unbound goal tools (it has its own,
 * bound to its goal, on the `goal` server). Write tools stay listed for a
 * worker that may write only so the filter in extrasFor can lift them.
 */
export const GOAL_RUN_DISALLOWED_TOOLS = [
  ...BRIEF_DISALLOWED_TOOLS,
  ...['goal_create', 'goal_propose_plan', 'goal_log_append', 'goal_handoff_write'].map((t) => `mcp__triage__${t}`),
]

/** One session the goal run loop started. */
export type GoalRun = GoalSessionTag & { spec: StartSpec; agentPrompt: string | null; timer: ReturnType<typeof setTimeout>; release: () => void }

/** How long one gate check session may run before it is cut off. */
const GATE_CHECK_TIMEOUT_MS = 5 * 60_000

/**
 * The gate checker (decision 6): one short, headless, read-only session over
 * every due AI gate in a batch. It gets the condition and the ids, the read
 * tools of the connectors those gates name (ToolSearch loads them), and one
 * write — its verdicts, on its own `gate` server. The fence refuses anything
 * else before any allow rule runs: no shell, no file tool, no connector write.
 */
const runGateCheck = (rt: WorkspaceRuntime): GateChecker => async (gates, model) => {
  const verdicts = new Map<string, GateVerdict>()
  let costUsd = 0
  const home = rt.connectorCache ?? (await probeConnectors(rt).catch(() => null))
  const probes = home?.connectors ?? []
  const connectors = [...new Set(gates.flatMap((g) => g.connectors))]
  const readTools = new Set(gateReadTools(connectors, probes))
  const keep = new Set(gateServers(connectors, probes))
  // Every other connector the user has: out of the run entirely (the fence would refuse them anyway).
  const disallowedTools = [...new Set(probes.filter((c) => !keep.has(c.server)).map((c) => `mcp__${c.server.replace(/[^a-zA-Z0-9_-]/g, '_')}`))].sort()
  const ids = new Set(gates.map((g) => g.id))
  const server = createSdkMcpServer({
    name: GATE_SERVER,
    version: VERSION,
    alwaysLoad: true,
    tools: [
      tool(
        GATE_VERDICT_TOOL,
        'Hand in one verdict per gate id you were given, then stop.',
        {
          verdicts: z.array(
            z.object({
              gateId: z.string(),
              verdict: z.enum(['met', 'not_met', 'needs_user', 'error']),
              evidence: z.string().describe('one short line: what you saw'),
              checkAgainIn: z.string().optional().describe('like "2h", when you can tell it will be a while'),
            }),
          ),
        },
        async (a) => {
          const bad: string[] = []
          for (const raw of a.verdicts) {
            const v = verdictFrom(raw)
            if (v && ids.has(raw.gateId)) verdicts.set(raw.gateId, v)
            else bad.push(raw.gateId)
          }
          const missing = [...ids].filter((id) => !verdicts.has(id))
          const text = [bad.length ? `ignored: ${bad.join(', ')} (unknown id or off-format)` : null, missing.length ? `still missing: ${missing.join(', ')}` : 'all recorded; stop now'].filter(Boolean).join('; ')
          return { content: [{ type: 'text' as const, text }] }
        },
      ),
    ],
  })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), GATE_CHECK_TIMEOUT_MS)
  const release = power.hold(`gate sweep ${rt.meta.id}`)
  try {
    const run = rt.provider.run({
      prompt: gateCheckPrompt(gates),
      cwd: workspaceDir(rt.meta.id),
      // The user's own MCP servers and claude.ai connectors; no project settings, skills or hooks.
      userConfig: true,
      tools: [GATE_TOOL_SEARCH],
      allowedTools: [GATE_TOOL_SEARCH, GATE_VERDICT_FULL, ...readTools],
      ...(disallowedTools.length ? { disallowedTools } : {}),
      unattended: true,
      veto: (toolName) => {
        const dec = gateFenceDecision(readTools, toolName)
        if (!dec.allow) log('warn', 'goals', `gate checker refused ${toolName}`, { workspace: rt.meta.id, gates: [...ids] })
        return dec
      },
      model,
      // A few reads per gate, the verdict, the stop.
      maxTurns: 4 + 3 * gates.length,
      maxBudgetUsd: 0.5,
      mcpServers: { [GATE_SERVER]: server },
      abort,
      ...(rt.env ? { env: rt.env } : {}),
    })
    for await (const ev of run) if (ev.kind === 'result' && ev.costUsd != null) costUsd = ev.costUsd
  } catch (err) {
    log('error', 'goals', `gate check failed: ${abort.signal.aborted ? `timed out after ${humanSpan(GATE_CHECK_TIMEOUT_MS)}` : errText(err)}`, { workspace: rt.meta.id })
  } finally {
    clearTimeout(timer)
    release()
  }
  return { verdicts, costUsd }
}

/** One sweep per workspace at a time: a slow check never overlaps the next tick. */
const gateSweeping = new WeakSet<WorkspaceRuntime>()
export async function sweepGates(rt: WorkspaceRuntime): Promise<void> {
  if (gateSweeping.has(rt)) return
  gateSweeping.add(rt)
  try {
    const r = await goalGateSweepOp(rt.goalDeps, goalEngineFor(rt), runGateCheck(rt))
    if (r.checked || r.toUser) log('info', 'goals', `gate sweep: ${r.checked} checked, ${r.resolved} met, ${r.toUser} to you`, { workspace: rt.meta.id })
  } finally {
    gateSweeping.delete(rt)
  }
}

/** One PR watcher pass per workspace at a time. */
const prWatching = new WeakSet<WorkspaceRuntime>()
export async function watchPrs(rt: WorkspaceRuntime): Promise<void> {
  if (prWatching.has(rt)) return
  prWatching.add(rt)
  try {
    const src = ghPrSource((goal) => (goal.checkoutId ? (rt.checkouts.get(goal.checkoutId)?.path ?? null) : null))
    const r = await goalWatchPrsOp(rt.goalDeps, goalEngineFor(rt), src)
    if (r.acted || r.toUser) log('info', 'goals', `PR watcher: ${r.polled} polled, ${r.acted} acted on, ${r.toUser} to you`, { workspace: rt.meta.id })
  } finally {
    prWatching.delete(rt)
  }
}

export function goalEngineFor(rt: WorkspaceRuntime): GoalEngine {
  const eng: GoalEngine = {
    wakeLead: (goal, wake, ev) => startGoalLead(rt, goal, wake, ev),
    stepsQueued: () => void pumpGoals(rt.goalDeps, eng).catch((err) => log('error', 'goals', `pump failed: ${errText(err)}`, { workspace: rt.meta.id })),
    startSession: (goal, spec, started) => startGoalSession(rt, goal, spec, started),
    stopSessions: async (goalId) => {
      for (const g of [...rt.goalRuns.values()]) if (g.goalId === goalId) await endGoalSession(rt, g.sessionId, 'stopped: you took over')
    },
    worktreeHead: async (goal) => {
      const c = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
      if (!c) return null
      const { stdout } = await pExecFile('git', ['-C', c.path, 'rev-parse', 'HEAD'])
      return stdout.trim() || null
    },
    openWorktree: async (goal) => {
      const c = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
      if (c) await openInEditor(c.path)
    },
    mergeBack: (goal, sessionId) => mergeGoalChild(rt, goal, sessionId),
    worktreeDiff: async (goal) => {
      const c = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
      if (!c) return ''
      const base = c.base ?? (await defaultBranch(c.path))
      if (!base) return ''
      const range = `${base}...HEAD`
      const opts = { maxBuffer: 32 * 1024 * 1024 }
      const [stat, patch] = await Promise.all([pExecFile('git', ['-C', c.path, 'diff', '--stat', range], opts), pExecFile('git', ['-C', c.path, 'diff', range], opts)])
      return [stat.stdout.trim(), patch.stdout.trim()].filter(Boolean).join('\n\n')
    },
  }
  return eng
}

/**
 * A builder that worked beside others did it in a child worktree (decision 2,
 * M6): commit what it left, merge its branch into the goal branch, then remove
 * the child. A conflict aborts the merge and is the step's failure; the child
 * stays for the lead's next move or the user's look.
 */
async function mergeGoalChild(rt: WorkspaceRuntime, goal: Goal, sessionId: string): Promise<string | null> {
  const childId = rt.rows.get(sessionId)?.checkoutId
  if (!childId || !goal.checkoutId || childId === goal.checkoutId) return null
  const child = rt.checkouts.get(childId)
  const into = rt.checkouts.get(goal.checkoutId)
  if (!child?.branch || !into) return child ? "the child worktree's branch is gone" : null
  const git = (cwd: string, args: string[]) => pExecFile('git', ['-C', cwd, ...args])
  try {
    await git(child.path, ['add', '-A'])
    const staged = await git(child.path, ['diff', '--cached', '--quiet']).then(
      () => false,
      () => true,
    )
    if (staged) await git(child.path, ['commit', '-m', `work left uncommitted on ${child.branch}`])
    await git(into.path, ['merge', '--no-ff', '--no-edit', child.branch])
  } catch (err) {
    await git(into.path, ['merge', '--abort']).catch(() => {})
    return errText(err).split('\n').find((l) => l.trim())?.slice(0, 300) ?? 'git merge failed'
  }
  try {
    await removeWorktree(child, { force: false, deleteBranch: true, merged: true })
    await syncCheckouts(rt)
  } catch (err) {
    log('warn', 'goals', `merged ${child.branch} but couldn't remove its worktree: ${errText(err)}`, { goalId: goal.id, workspace: rt.meta.id })
  }
  log('info', 'goals', `merged ${child.branch} into ${into.branch ?? 'the goal branch'}`, { goalId: goal.id, sessionId, workspace: rt.meta.id })
  return null
}

/** The goal's one worktree (decision 2): made on its first session, on a goal/<slug> branch. */
async function goalCheckout(rt: WorkspaceRuntime, goal: Goal, project: Project): Promise<Checkout> {
  const have = goal.checkoutId ? rt.checkouts.get(goal.checkoutId) : undefined
  if (have) return have
  const slug = goal.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'goal'
  const made = await makeWorktree(rt, project, `goal/${slug}-${goal.id.slice(0, 6)}`, goal.sourceItemId ?? undefined)
  await rt.goalDeps.store.goals.update(goal.id, { checkoutId: made.id }, Date.now())
  return made
}

/**
 * Start the session the scheduler picked (server/goals.ts startGoal): the run
 * lead for a wake, or a worker for one dispatched step, in the goal's
 * worktree. A worker's first message is `/goal <the step is done>`, so it
 * keeps going until the step's done-when holds. A throw before `started` is
 * the scheduler's to handle; after, the session ends here.
 */
async function startGoalSession(rt: WorkspaceRuntime, stale: Goal, spec: StartSpec, started: (sessionId: string) => Promise<void>): Promise<void> {
  // Read again: a worker started a moment ago in the same batch may have made the goal's worktree.
  const goal = (await rt.goalDeps.store.goals.get(stale.id)) ?? stale
  const project = goal.projectId ? (await rt.store.projects.list()).find((p) => p.id === goal.projectId) : undefined
  if (!project) throw new Error(goal.projectId ? `its project ${goal.projectId} is gone` : 'it has no project to work in')
  const main = await goalCheckout(rt, goal, project)
  // A builder beside others gets its own branch off the goal's, merged back when its step is done (mergeGoalChild).
  const checkout =
    spec.role !== 'lead' && spec.worktree === 'child' && main.branch
      ? await makeWorktree(rt, project, `${main.branch}--${spec.stepId.replace(/[^\w-]+/g, '-')}-${randomUUID().slice(0, 4)}`, goal.sourceItemId ?? undefined, undefined, main.branch)
      : main
  const agent = spec.role === 'lead' ? null : ROLE_AGENT[spec.role]
  const agentPrompt = agent ? ((await rt.teamLibrary.readAgent(agent))?.prompt ?? null) : null
  const title = spec.role === 'lead' ? `Goal lead · ${goal.title.slice(0, 70)}` : `${spec.role[0]!.toUpperCase()}${spec.role.slice(1)} · ${spec.stepId} · ${goal.title.slice(0, 60)}`
  const row = await createSession(rt, title, checkout.path, spec.model, null, false, 'gated', { kind: 'goal', projectId: project.id, checkoutId: checkout.id, spawn: false })
  rt.goalRuns.set(row.id, {
    goalId: goal.id,
    sessionId: row.id,
    role: spec.role,
    stepId: spec.role === 'lead' ? null : spec.stepId,
    spec,
    agentPrompt,
    // The Mac stays awake while a goal session runs: a sleeping Mac hangs a headless run (M0).
    release: power.hold(`goal ${goal.id}`),
    timer: setTimeout(() => void endGoalSession(rt, row.id, `timed out after ${GOAL_SESSION_TIMEOUT_MS / 60_000} minutes`), GOAL_SESSION_TIMEOUT_MS),
  })
  try {
    await started(row.id)
  } catch (err) {
    const g = rt.goalRuns.get(row.id)
    rt.goalRuns.delete(row.id)
    if (g) {
      clearTimeout(g.timer)
      g.release()
    }
    throw err
  }
  try {
    if (goal.sourceItemId && (await rt.store.items.get(goal.sourceItemId))) await linkSessionToItem(rt, row.id, goal.sourceItemId, 'dispatch')
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not start the session')
    await live.sendUserMessage(spec.role === 'lead' ? spec.prompt : spec.first)
    log('info', 'goals', `${spec.role}${spec.role === 'lead' ? '' : ` on ${spec.stepId}`} started: ${goal.title}`, { goalId: goal.id, sessionId: row.id, workspace: rt.meta.id })
  } catch (err) {
    await endGoalSession(rt, row.id, errText(err))
  }
}

/** A goal run's session ended, timed out or was stopped: stop it, then let the run loop move the goal. Once per session. */
export async function endGoalSession(rt: WorkspaceRuntime, sessionId: string, error: string | null, costUsd = 0): Promise<void> {
  const g = rt.goalRuns.get(sessionId)
  if (!g) return
  rt.goalRuns.delete(sessionId)
  clearTimeout(g.timer)
  g.release()
  const live = rt.live.get(sessionId)
  if (live) {
    if (error) void live.interrupt()
    live.stop()
  }
  try {
    await goalSessionEndedOp(rt.goalDeps, goalEngineFor(rt), { goalId: g.goalId, sessionId, error, costUsd })
  } catch (err) {
    log('error', 'goals', `could not settle a session of ${g.goalId}: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

/** Start the lead for one wake. A throw before the session exists is settled by onGoalEvent; after, here. */
async function startGoalLead(rt: WorkspaceRuntime, goal: Goal, wake: LeadWake, ev: GoalEvent): Promise<void> {
  const prior = rt.goalLeads.get(goal.id)
  if (prior) await settleGoalLead(rt, prior.sessionId, 'a newer wake replaced it')
  const project = goal.projectId ? (await rt.store.projects.list()).find((p) => p.id === goal.projectId) : undefined
  if (!project) throw new Error(goal.projectId ? `its project ${goal.projectId} is gone` : 'it has no project to work in')
  const row = await createSession(
    rt,
    `Goal lead · ${goal.title.slice(0, 70)}`,
    project.path,
    goal.plan?.models?.lead ?? DEFAULT_GOAL_MODELS.lead,
    null,
    false,
    'gated',
    { kind: 'goal', projectId: project.id, spawn: false },
  )
  // The Mac stays awake while the lead drafts: a sleeping Mac hangs a headless run (M0).
  const lead: GoalLead = {
    goalId: goal.id,
    sessionId: row.id,
    seq: ev.seq,
    release: power.hold(`goal ${goal.id}`),
    timer: setTimeout(() => void settleGoalLead(rt, row.id, `timed out after ${GOAL_LEAD_TIMEOUT_MS / 60_000} minutes`), GOAL_LEAD_TIMEOUT_MS),
  }
  rt.goalLeads.set(goal.id, lead)
  try {
    await goalLeadStartedOp(rt.goalDeps, goal.id, row.id)
    if (goal.sourceItemId && (await rt.store.items.get(goal.sourceItemId))) await linkSessionToItem(rt, row.id, goal.sourceItemId, 'dispatch')
    const live = await getOrRevive(rt, row.id)
    if (!live) throw new Error('could not start the lead session')
    const plan = wake.kind === 'revise' ? (await rt.goalLedger.read(goal.id, 0)).plan : ''
    const blocks = (await rt.goalDeps.blocks?.()) ?? []
    const staffing = { blocks: blocks.map((b) => ({ name: b.name, label: b.label, description: b.description, steps: b.steps.length })), maxTeam: await goalMaxTeam(rt.goalDeps) }
    await live.sendUserMessage(leadDraftPrompt(goal, wake, plan.trim() ? plan : null, staffing))
    log('info', 'goals', `lead ${wake.kind === 'draft' ? 'drafting' : `revising v${wake.version}`}: ${goal.title}`, { goalId: goal.id, sessionId: row.id, workspace: rt.meta.id })
  } catch (err) {
    await settleGoalLead(rt, row.id, errText(err))
  }
}

/** The lead's turn ended, it timed out, or its session died: stop it and settle its wake. Once per lead. */
export async function settleGoalLead(rt: WorkspaceRuntime, sessionId: string, error?: string): Promise<void> {
  const lead = [...rt.goalLeads.values()].find((l) => l.sessionId === sessionId)
  if (!lead) return
  rt.goalLeads.delete(lead.goalId)
  clearTimeout(lead.timer)
  lead.release()
  const live = rt.live.get(sessionId)
  if (live) {
    if (error) void live.interrupt()
    live.stop()
  }
  try {
    await goalLeadSettledOp(rt.goalDeps, { goalId: lead.goalId, seq: lead.seq, sessionId, error: error ?? null })
  } catch (err) {
    log('error', 'goals', `could not settle the lead of ${lead.goalId}: ${errText(err)}`, { workspace: rt.meta.id })
  }
}
