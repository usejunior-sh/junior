/**
 * The team Plan (Teams v2): one artifact per run, on the work item and the lead
 * session. It is the plan you approve, the ledger every agent orients from, and
 * — at the end — the outcome. triage's code is its only writer: it is rendered
 * from the run's state after every change, so no agent can mark a task done
 * that isn't, and you change it through the drawer, never by editing the file.
 * Pure, so the rendering is tested without a server.
 */
import { horizonText, outputsOf, renderHandoff, runSpent, type TeamRun } from './engine.js'

const usd = (n: number) => `$${n.toFixed(2)}`
const when = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 16)
const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')

const STATE: Record<TeamRun['state'], string> = {
  proposed: 'proposed — waiting for your approval',
  running: 'running',
  gate: 'waiting for you',
  waiting: 'waiting on the world',
  paused: 'paused',
  stopped: 'stopped',
  done: 'done',
}

export const planTitle = (run: TeamRun): string => `Plan · ${run.title}`.slice(0, 120)

/** Where the run stands, in one line — the plan's subtitle and the item page's status. */
export function planStatus(run: TeamRun): string {
  const n = run.card.tasks.length
  const done = run.card.tasks.filter((t) => run.tasks[t.id]?.status === 'done' || run.tasks[t.id]?.status === 'unresolved').length
  const where =
    run.state === 'running' || run.state === 'gate' || run.state === 'waiting' || run.state === 'paused'
      ? n && run.task !== null
        ? ` · task ${run.task + 1} of ${n}`
        : ` · step ${run.step + 1} of ${run.recipe.steps.length}`
      : run.state === 'done' && n
        ? ` · ${done} of ${n} tasks`
        : ''
  const money = run.state === 'proposed' ? `cap ${usd(run.card.budgetUsd)}` : `${usd(runSpent(run))} of ${usd(run.budgetUsd)}`
  const goal = run.goal ? `goal${run.goal.round ? `, round ${run.goal.round + 1}` : ''} · ` : ''
  return `${goal}${run.recipe.label} team · ${STATE[run.state]}${where} · ${money}`
}

export function renderPlan(run: TeamRun): string {
  const c = run.card
  const out: string[] = [`# ${planTitle(run)}`, planStatus(run)]
  if (c.note) out.push(`> ${c.note.replace(/\n/g, '\n> ')}`)
  out.push(`## Goal\n${c.goal}`)
  const g = run.goal
  if (g) {
    const lines = [g.doneWhen, `Horizon: ${horizonText(g.horizon)}${g.round ? ` · round ${g.round + 1}` : ''}`]
    if (g.wait) lines.push(`Waiting for ${g.wait.for} — Junior looks again at ${when(g.wait.until)}.`)
    if (g.round && g.gap) lines.push(`Still missing (round ${g.round + 1}): ${g.gap}`)
    out.push(`## The goal is done when\n${lines.join('\n\n')}`)
    if (g.verdicts.length) out.push(`## Junior's verdicts\n${g.verdicts.map((v) => `- ${when(v.at)} · round ${v.round + 1} · ${v.met ? '**met**' : 'not met'} — ${v.evidence}`).join('\n')}`)
    if (g.questions.length) {
      out.push(
        `## Questions for you\n${g.questions
          .map((q) => `- **${q.id}** ${q.text}\n  Recommended: ${q.recommended}\n  ${q.answer === null ? '_Waiting for your answer._' : `You: ${q.answer}`}`)
          .join('\n')}`,
      )
    }
  }
  out.push(`## ${g ? 'Acceptance criteria' : 'Done when'}\n${bullet(c.criteria)}`)
  if (c.outOfScope.length) out.push(`## Out of scope\n${bullet(c.outOfScope)}`)

  if (c.tasks.length) {
    const lines = c.tasks.map((t) => {
      const st = run.tasks[t.id] ?? { status: 'todo', round: 0 }
      const mark = st.status === 'done' ? '[x]' : st.status === 'running' ? '[~]' : st.status === 'unresolved' ? '[!]' : '[ ]'
      const verdict = outputsOf(run, run.recipe.steps.find((s) => s.output === 'verdict' && s.forEach)?.id ?? '', t.id)[0]
      const detail =
        st.status === 'running'
          ? ` — ${run.recipe.steps[run.step]?.id ?? ''}${st.round ? `, fix round ${st.round}` : ''}`
          : st.status === 'done'
            ? ` — ✓${st.round ? ` after ${st.round} fix round${st.round === 1 ? '' : 's'}` : ''}${verdict ? ` · ${verdict.summary}` : ''}`
            : st.status === 'unresolved'
              ? ` — unresolved: ${st.why ?? ''}`
              : ''
      const crit = t.criteria.length ? `\n${t.criteria.map((x) => `  - ${x}`).join('\n')}` : ''
      return `- ${mark} **${t.id}** ${t.title}${detail}${crit}`
    })
    out.push(`## Tasks\n${lines.join('\n')}`)
  }

  if (run.revision) {
    out.push(`## Proposed change — waiting for you\n${run.revision.why}\n\n${run.revision.tasks.map((t) => `- ${t.id} ${t.title}`).join('\n')}`)
  }
  if (c.decisions.length) out.push(`## Decisions\n${bullet(c.decisions)}`)
  const learned = run.ledger.filter((e) => e.kind === 'decision' || e.kind === 'note')
  if (learned.length) out.push(`## Decided along the way\n${learned.map((n) => `- ${n.task ? `${n.task} · ` : ''}${n.text}${n.why ? ` — because ${n.why}` : ''}`).join('\n')}`)
  const open = Object.entries(run.findingState).filter(([, v]) => v.status !== 'fixed')
  if (open.length) out.push(`## Findings not fixed\n${open.map(([id, v]) => `- ${id} ${v.status}${v.note ? ` — ${v.note}` : ''}`).join('\n')}`)
  if (run.ledger.length || run.outputs.length) out.push(`Everything the team learned is in the run folder's ledger.md; every handoff is under handoffs/.`)

  const steps = run.recipe.steps.map((s) => {
    const who = s.agent === 'lead' ? 'lead' : s.agent === 'checks' ? 'checks' : run.agents.find((a) => a.name === s.agent)?.label ?? s.agent
    const model = run.card.steps.find((x) => x.id === s.id)?.model ?? s.model
    return `${s.forEach ? '↻ ' : ''}${s.id} (${who}${model ? ` · ${model}` : ''}${s.fanOut ? ` ×≤${s.fanOut.max}` : ''})`
  })
  out.push(`## Team\n${steps.join(' → ')}${run.recipe.steps.some((s) => s.forEach) ? '\n\n↻ = once per task' : ''}${run.team ? `\n\nFrom teams/${run.team}.md.` : ''}`)

  if (run.state === 'done' || run.state === 'stopped') {
    const last = run.recipe.steps[run.recipe.steps.length - 1]
    const report = last?.output === 'report' ? outputsOf(run, last.id)[0] : undefined
    const outcome = report
      ? report.body
      : run.state === 'stopped'
        ? 'Stopped before the end.'
        : run.recipe.steps.flatMap((s) => outputsOf(run, s.id)).slice(-3).map(renderHandoff).join('\n\n') || 'No handoffs.'
    const verdict = run.goal?.verdicts.at(-1)
    const judged = run.goal && run.state === 'done' && verdict?.met ? `\n\n**Junior judged the done-when met:** ${verdict.evidence}${run.goal.acceptedAt ? `\n\nAccepted by you ${when(run.goal.acceptedAt)}.` : '\n\n_Waiting for you to accept the result._'}` : ''
    out.push(`## Outcome\n${outcome}${judged}${run.unresolved ? `\n\n**Unresolved:** ${run.unresolved}` : ''}\n\n${usd(runSpent(run))} spent of ${usd(run.budgetUsd)}.`)
  }
  return out.join('\n\n') + '\n'
}
