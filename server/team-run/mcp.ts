import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { acceptGoal, answerQuestion, askYou, goalOverdue, goalVerdict, proposeRevision, reopenGoal, runSpent, split, type Submission, submit, type TeamRun, unstick, wake, wakeDue } from '../../core/teams/engine.js'
import { snapshotTree, treeDiff } from '../git.js'
import { type DispatchPreview, type Mention, mentionToken, type TeamGoalSummary } from '../../shared/protocol.js'
import { log } from '../log.js'
import { readDispatchTemplate, renderTemplate } from '../briefs.js'
import { branchFromTitle } from '../../shared/branch.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { VERSION } from '../config.js'
import { applyTeamActions, teamRunChanged, teamRunOf, usd, withTeamRun } from './state.js'
import { errResult, okResult } from '../triage-mcp.js'
import { errText } from '../errors.js'
import { listTeamsOp, proposeTeamOp, teamRunFrom } from './ops.js'
import { invalidateInbox } from '../ws/send.js'
import { projectFor } from '../settings-ops.js'
import { currentBrief } from '../brief-run.js'
import { checkoutList, mainCheckout } from '../session/checkouts.js'

/**
 * The `team` MCP server a worker gets: its one job-critical tool, submit_step.
 * Rebuilt per spawn, like the brief server.
 */
export function makeTeamMcp(rt: WorkspaceRuntime, sessionId: string) {
  return createSdkMcpServer({
    name: 'team',
    version: VERSION,
    // Loaded up front, never behind tool search.
    alwaysLoad: true,
    tools: [submitStepTool(rt, sessionId)],
  })
}

const FINDING_SHAPE = z.object({
  id: z.string().optional().describe('only to say an earlier finding is still not fixed: its id (e.g. "T2-F1"); triage numbers new ones'),
  severity: z.enum(['P0', 'P1', 'P2']).describe('P0 = a criterion unmet or something broken; P1 = a real defect likely to bite; P2 = worth fixing, not blocking'),
  where: z.string().describe('file:line, or the behaviour'),
  problem: z.string(),
  fix: z.string(),
})

const SUBMIT_SHAPE = {
  summary: z.string().describe('one line: what you did or found'),
  body: z.string().describe('change: what you changed and how you verified it; verdict: what you ran or looked at — markdown, short'),
  verdict: z.enum(['pass', 'fail']).optional().describe('verdict steps only'),
  criteria: z
    .array(z.object({ id: z.string().describe('the criterion id, e.g. "T2.1" or "C1"'), status: z.enum(['met', 'not met', 'partly']), evidence: z.string().describe('what you ran or saw') }))
    .max(20)
    .optional()
    .describe('change and verdict steps: every acceptance criterion the step lists, by id'),
  findings: z.array(FINDING_SHAPE).max(20).optional().describe('findings and verdict steps: real defects only'),
  resolutions: z
    .array(z.object({ id: z.string(), status: z.enum(['fixed', 'disputed', 'deferred']), note: z.string() }))
    .max(30)
    .optional()
    .describe('a fix round: every open finding id, answered'),
  unsure: z.string().optional().describe('change steps: what a reviewer should look at hardest'),
  decisions: z.array(z.object({ what: z.string(), why: z.string() })).max(10).optional().describe('choices you made that whoever comes next must keep, each with why'),
  where: z.array(z.string()).max(10).optional().describe('"path — what it is": the files and symbols that matter for this area, so the next worker needn\'t search'),
  surprises: z.array(z.string()).max(10).optional().describe('what was not as expected'),
  failed: z.array(z.string()).max(10).optional().describe('approaches you tried that did not work, and why'),
  verify: z.array(z.string()).max(10).optional().describe('how to check this project or this change: commands, URLs, what to look at'),
  files: z.array(z.string()).max(50).optional().describe('change steps: files you changed (triage replaces this with what git says)'),
  notes: z.array(z.string()).max(10).optional().describe('anything else for whoever comes next (prefer the typed fields above)'),
}
const SUBMIT_DESCRIPTION = 'Hand in your step of the team run. triage forwards it verbatim to whoever needs it next and moves the run on. Then END YOUR TURN.'

async function submitStepOp(rt: WorkspaceRuntime, sessionId: string, args: Submission) {
  const run = teamRunOf(rt, sessionId)
  if (!run) return errResult('this session is not on a team run')
  try {
    const said = submit(run, sessionId, args, Date.now())
    await filesFromGit(run)
    return okResult(said)
  } catch (err) {
    return errResult(errText(err))
  } finally {
    await teamRunChanged(rt, run)
  }
}

/**
 * A builder's handoff lists the files git says changed since its task (or the
 * run) began, not the ones it remembers changing, which is the part of a
 * handoff every summary gets wrong.
 */
async function filesFromGit(run: TeamRun): Promise<void> {
  const h = run.outputs.at(-1)
  const step = h && run.recipe.steps.find((x) => x.id === h.stepId)
  const base = step?.forEach ? run.baseTree : run.runBase ?? run.baseTree
  if (!h || step?.output !== 'change' || !run.root || !base) return
  const now = await snapshotTree(run.root)
  const changes = now ? await treeDiff(run.root, base, now).catch(() => null) : null
  if (changes) h.files = changes.map((c) => c.path)
}

/** A worker's submit_step: its session is known at spawn. */
function submitStepTool(rt: WorkspaceRuntime, sessionId: string) {
  return tool('submit_step', SUBMIT_DESCRIPTION, SUBMIT_SHAPE, (args) => submitStepOp(rt, sessionId, args))
}

/** The lead's tools, in every chat's triage server: pick or draft a team, propose it, split a step, hand in its own steps. */
export function teamLeadTools(rt: WorkspaceRuntime) {
  const sid = z.string().describe('your triage session id — it is in your system prompt')
  return [
    tool(
      'list_teams',
      'The saved teams (recipes: steps, fan-out, gates, budget) and the agents they are made of. Call before propose_team; prefer a saved team over drafting one.',
      {},
      async () => {
        try {
          return okResult(JSON.stringify(await listTeamsOp(rt), null, 2))
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'propose_team',
      'Propose a team run for the work this session is on — when the user asks for a team ("get a team to …"), or the session was opened to plan one. Shows the user an editable team card; nothing runs until they approve it. Give `team` (a saved team, from list_teams) or `recipe` (a drafted one, only when no saved team fits). If this session has no work item, one is created from `title`. Proposing again replaces the card. After calling it, END YOUR TURN.',
      {
        sessionId: sid,
        team: z.string().optional().describe('a saved team\'s name, e.g. "solo"'),
        recipe: z
          .object({
            label: z.string(),
            description: z.string().optional(),
            done: z.string().optional(),
            budgetUsd: z.number().optional(),
            steps: z
              .array(
                z.object({
                  id: z.string().describe('short lowercase name, e.g. "build"'),
                  agent: z.string().describe('"lead", "checks", or an agent name from list_teams'),
                  output: z.enum(['change', 'findings', 'verdict', 'notes', 'report']).optional().describe('omit only for agent "checks"'),
                  does: z.string().optional(),
                  fanOut: z.object({ by: z.string(), max: z.number() }).optional(),
                  onFail: z.object({ backTo: z.string(), max: z.number() }).optional(),
                  gate: z.enum(['you']).optional(),
                  model: z.string().optional(),
                  forEach: z.enum(['task']).optional().describe('"task": part of the per-task loop (contiguous steps, run once per task)'),
                  context: z.enum(['fresh', 'carry']).optional().describe('the change step in a task loop: fresh (default) or carry'),
                }),
              )
              .min(1)
              .max(8),
          })
          .optional()
          .describe('a drafted recipe — same rules as a team file: one change step, never fanned out; fan-out ≤ 6; only the lead reports'),
        title: z.string().optional().describe('the work item title, when this session has none yet'),
        card: z.object({
          goal: z.string().describe('ONE sentence: what the run achieves — the user reads it at a glance'),
          criteria: z.array(z.string()).min(1).max(8).describe('3–5 observable behaviours a checker can prove by running something, each ONE short line (~12 words) — no file paths or line numbers'),
          outOfScope: z.array(z.string()).max(8).optional().describe('a few words each'),
          tasks: z
            .array(z.object({ title: z.string().describe('one line'), criteria: z.array(z.string()).max(3).optional().describe('1–3 short checkable lines') }))
            .max(8)
            .optional()
            .describe('teams with a task loop (e.g. Build): 2–6 tasks, in order, each leaving the project working; omit for other teams'),
          decisions: z.array(z.string()).max(10).optional().describe('decisions already made with the user'),
          steps: z
            .array(
              z.object({
                id: z.string().describe('a step id of the recipe'),
                model: z.string().optional().describe('a model for this step if it should differ'),
                slices: z.array(z.object({ title: z.string(), brief: z.string() })).max(6).optional().describe('fan-out steps: the slices, if you can already tell them apart'),
              }),
            )
            .optional(),
          budgetUsd: z.number().optional().describe('the run\'s spend cap; defaults to the team\'s budget'),
          note: z.string().optional().describe('one or two lines to the user: why this team and size'),
        }),
        goal: z
          .object({
            doneWhen: z.string().describe('ONE sentence: the outcome you will judge when the team finishes a round, e.g. "the PR is merged with checks green" — not a task list'),
            horizon: z.enum(['today', 'by', 'until_done']).describe('finish today, by a date, or keep going until done'),
            by: z.string().optional().describe('horizon "by": the date, YYYY-MM-DD'),
          })
          .optional()
          .describe('only when the user wants a goal: the team keeps going, round after round, until the done-when holds'),
      },
      async (args) => {
        try {
          const run = await proposeTeamOp(rt, args.sessionId, args)
          return okResult(`${run.goal ? 'Goal' : 'Team'} card shown to the user (${run.recipe.label}, ${run.recipe.steps.length} steps, up to ${usd(run.card.budgetUsd)}). END YOUR TURN — they approve or edit it, then triage runs the steps and wakes you when you're needed.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'split_step',
      'Split the current fan-out step of your team run into slices — one worker each. Only when triage asks you to. Then END YOUR TURN.',
      { sessionId: sid, slices: z.array(z.object({ title: z.string().describe('a few words'), brief: z.string().describe('what this worker looks at, and what could go wrong there') })).min(1).max(6) },
      async (args) => {
        const run = teamRunOf(rt, args.sessionId)
        if (!run || run.leadSessionId !== args.sessionId) return errResult('you are not leading a team run')
        try {
          await withTeamRun(rt, run, () => applyTeamActions(rt, run, split(run, args.slices)))
          return okResult('Split. END YOUR TURN — the workers start now.')
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'revise_plan',
      'Propose a change to the tasks still to do on your running team plan — add, split, reorder or drop tasks that have not started. The user accepts or turns it down; the run carries on meanwhile, and an accepted change applies from the next task. Give the whole task list as it should be (keep the ids of tasks that stay).',
      {
        sessionId: sid,
        tasks: z.array(z.object({ id: z.string().optional().describe('keep the id of a task that stays'), title: z.string(), criteria: z.array(z.string()).max(3).optional() })).min(1).max(8),
        why: z.string().describe('one line the user reads: why the plan should change'),
      },
      async (args) => {
        const run = teamRunOf(rt, args.sessionId)
        if (!run || run.leadSessionId !== args.sessionId) return errResult('you are not leading a team run')
        try {
          await withTeamRun(rt, run, () => applyTeamActions(rt, run, proposeRevision(run, args.tasks, args.why)))
          return okResult('Proposed. The user decides; carry on — do not wait for it.')
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool('submit_step', `${SUBMIT_DESCRIPTION} Only when triage hands you a step.`, { sessionId: sid, ...SUBMIT_SHAPE }, ({ sessionId, ...args }) => submitStepOp(rt, sessionId, args)),
    tool(
      'goal_verdict',
      'Judge your goal\'s done-when — only when triage asks you to (the team finished a round, or a wait is over). Look for yourself first: run the checks, read the diff, query the connectors you can see. met: true closes the goal for the user to accept; met: false starts another round with the gap (and, for a team with a task loop, the next round\'s tasks); met: false with waitFor + waitMinutes sleeps until the world has moved (CI, a reviewer, a deploy) and wakes you then. Then END YOUR TURN.',
      {
        sessionId: sid,
        met: z.boolean(),
        evidence: z.string().describe('what you ran or looked at, and what it showed'),
        gap: z.string().optional().describe('not met: what is still missing, in a line or two — every worker in the next round reads it'),
        tasks: z.array(z.object({ title: z.string(), criteria: z.array(z.string()).max(3).optional() })).max(4).optional().describe('not met, a team with a task loop: the next round\'s tasks, in order'),
        waitFor: z.string().optional().describe('not met yet because the world has to move first: what for, e.g. "CI on PR #42"'),
        waitMinutes: z.number().optional().describe('with waitFor: when to look again, in minutes'),
      },
      async ({ sessionId, ...v }) => {
        const run = teamRunOf(rt, sessionId)
        if (!run || run.leadSessionId !== sessionId) return errResult('you are not leading a team run')
        try {
          const at = Date.now()
          const decide = (r: TeamRun) => goalVerdict(r, v, at)
          // Checked now on a copy, so a mistake comes back to you; carried out when your turn ends.
          const probe = structuredClone(run)
          decide(probe)
          rt.goalDecisions.set(run.id, decide)
          const said = probe.state === 'done' ? 'met — the user accepts the result' : probe.state === 'waiting' ? 'waiting — triage wakes you then' : 'not met — the next round starts when your turn ends'
          return okResult(`Recorded: ${said}. END YOUR TURN now.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'goal_unstick',
      'Get your goal\'s team moving again — only when triage tells you the team is stuck (its fix rounds ran out on a failing review or failing checks). "retry" goes back to the change step with your guidance for the builder and a fresh set of fix rounds; "skip" leaves it unresolved and moves on. Every resume is logged with your why. Then END YOUR TURN.',
      {
        sessionId: sid,
        action: z.enum(['retry', 'skip']),
        why: z.string().describe('one line for the ledger: why this is the way past it'),
        guidance: z.string().optional().describe('retry: what the builder should do differently this time'),
      },
      async ({ sessionId, ...u }) => {
        const run = teamRunOf(rt, sessionId)
        if (!run || run.leadSessionId !== sessionId) return errResult('you are not leading a team run')
        try {
          const at = Date.now()
          const decide = (r: TeamRun) => unstick(r, u, at)
          decide(structuredClone(run))
          rt.goalDecisions.set(run.id, decide)
          return okResult(`Recorded: ${u.action === 'retry' ? 'retry' : 'skip'} — the team moves when your turn ends, logged as resumed by Junior. END YOUR TURN now.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
    tool(
      'ask_you',
      'Ask the user a question about your goal — something only they can decide, or help you need. Always give the answer you recommend; they can take it with one click. The run carries on meanwhile (a gate or a budget pause still waits for them). Their answer comes back to you as a message. Ask once, everything in one question.',
      {
        sessionId: sid,
        question: z.string(),
        recommended: z.string().describe('the answer you recommend, and why in a few words'),
      },
      async ({ sessionId, question, recommended }) => {
        const run = teamRunOf(rt, sessionId)
        if (!run || run.leadSessionId !== sessionId) return errResult('you are not leading a team run')
        try {
          const id = await withTeamRun(rt, run, async () => {
            const q = askYou(run, question, recommended, Date.now())
            await applyTeamActions(rt, run, q.actions)
            return q.id
          })
          invalidateInbox(rt)
          return okResult(`Asked (${id}). Their answer comes back to you as a message. If nothing else needs you now, END YOUR TURN.`)
        } catch (err) {
          return errResult(errText(err))
        }
      },
    ),
  ]
}

/** Your answers on a goal: a question, accepting the result, "not done yet", waking a wait early. */
export async function goalActionOp(rt: WorkspaceRuntime, verb: 'answer' | 'accept' | 'reopen' | 'wake', raw: unknown): Promise<void> {
  const run = teamRunFrom(rt, raw)
  const r = (raw ?? {}) as Record<string, unknown>
  await withTeamRun(rt, run, async () => {
    const now = Date.now()
    if (verb === 'answer') await applyTeamActions(rt, run, answerQuestion(run, String(r.questionId ?? ''), String(r.answer ?? ''), now))
    else if (verb === 'accept') {
      await applyTeamActions(rt, run, acceptGoal(run, now))
      // Accepting the result is accepting the report: the item is done.
      if (await rt.store.items.get(run.itemId)) await rt.store.items.transition(run.itemId, { status: 'done', actor: 'user', detail: { reason: 'goal accepted' } })
    } else if (verb === 'reopen') await applyTeamActions(rt, run, reopenGoal(run, String(r.why ?? ''), now))
    else await applyTeamActions(rt, run, wake(run, now, true))
  })
  invalidateInbox(rt)
}

/** The Goals tab: every team run that is a goal, newest first. */
export function teamGoalsOp(rt: WorkspaceRuntime): TeamGoalSummary[] {
  const now = Date.now()
  return [...rt.teamRuns.values()]
    .filter((run) => run.goal && run.state !== 'proposed')
    .map((run) => {
      const g = run.goal!
      const asks = g.questions.filter((q) => q.answer === null).length
      const lead = rt.rows.get(run.leadSessionId)
      const turn: TeamGoalSummary['turn'] =
        asks || run.state === 'gate' || run.state === 'paused' || (run.state === 'done' && !g.acceptedAt) ? 'you' : run.state === 'waiting' ? 'world' : run.state === 'running' ? 'junior' : 'none'
      return {
        runId: run.id,
        itemId: run.itemId,
        leadSessionId: run.leadSessionId,
        title: run.title,
        team: run.recipe.label,
        doneWhen: g.doneWhen,
        horizon: g.horizon,
        state: run.state,
        reason: run.reason ?? null,
        round: g.round,
        owes: g.owes,
        asks,
        wait: g.wait,
        acceptedAt: g.acceptedAt,
        lastVerdict: g.verdicts.at(-1) ?? null,
        resumes: run.resumes?.length ?? 0,
        overdue: goalOverdue(run, now),
        spentUsd: runSpent(run),
        budgetUsd: run.budgetUsd,
        turn,
        updatedAt: Math.max(run.createdAt, lead?.updatedAt ?? 0, run.resumes?.at(-1)?.at ?? 0),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The minute tick: goals asleep on the world whose time is up look again. */
export async function wakeTeamGoals(rt: WorkspaceRuntime): Promise<void> {
  const now = Date.now()
  for (const run of rt.teamRuns.values()) {
    if (!wakeDue(run, now)) continue
    await withTeamRun(rt, run, async () => {
      if (wakeDue(run, Date.now())) await applyTeamActions(rt, run, wake(run, Date.now()))
    })
    log('info', 'teams', `goal woke: ${run.title}`, { teamId: run.id, workspace: rt.meta.id })
  }
}

/** What a dispatched session opens with: the kind's template, the item, and the brief as a mention. */
export async function dispatchPreviewOp(rt: WorkspaceRuntime, itemId: string): Promise<DispatchPreview> {
  const scored = rt.inboxCache?.items.find((i) => i.id === itemId)
  const item = scored ?? (await rt.store.items.get(itemId))
  if (!item) throw new Error('no such work item')
  const [project, brief, latest, tpl] = await Promise.all([
    projectFor(rt, item),
    currentBrief(rt, item.id),
    rt.store.briefs.latestForItem(item.id),
    readDispatchTemplate(rt.dispatchDir, item.kind),
  ])
  const mentions: Mention[] = [{ kind: 'item', ref: item.id, label: item.title }]
  if (brief) mentions.push({ kind: 'artifact', ref: brief.artifact.id, label: brief.artifact.title })
  // No description here: the @item: mention below attaches the work item itself,
  // and the agent can read its description via get_work_item rather than duplicating it.
  const body = renderTemplate(tpl, {
    kind: item.kind,
    title: item.title,
    url: item.url || undefined,
    reason: scored?.rankWhy,
    note: latest?.note ?? undefined,
    brief: !!brief,
    source: item.source !== 'manual',
  })
  // The item's screenshots are attached by the server when the draft is sent
  // (they never ride in localStorage), so the text says they are coming.
  const shots = item.images?.length ?? 0
  const note = shots ? `\n\n${shots} screenshot${shots === 1 ? '' : 's'} from this item ${shots === 1 ? 'is' : 'are'} attached to this message.` : ''
  // The mention tokens must appear in the text. The composer attaches only what the text names.
  const text = `${body}${note}\n\n${mentions.map(mentionToken).join(' ')}`
  // What the draft offers, never picks: a branch for a new worktree, and the item's own worktree if it has one.
  const main = mainCheckout(rt, project?.id)
  const existing = checkoutList(rt).find((c) => c.itemId === item.id && c.kind === 'worktree' && c.state === 'active')
  return {
    title: item.title.slice(0, 80),
    cwd: project?.path ?? null,
    text,
    mentions,
    branch: main?.branch ? branchFromTitle(item.title) || null : null,
    checkoutId: existing?.id ?? null,
  }
}
