/**
 * The run folder (.docs/team-handoffs.md): the run's state and its ledger as
 * files, so any worker — or you — can pick the run up from the folder alone.
 *
 *   plan.md         the plan, rendered from the run — goal, criteria, tasks, progress, the outcome
 *   ledger.md       what workers learned: decisions, where things are, surprises, what failed
 *   verify.md       how to check this project: the checks at the start, and what workers found
 *   reviews.md      every finding by id, with its state
 *   handoffs/NN-…   each handoff, written once
 *
 * triage's code is the only writer: workers hand in through submit_step and
 * the engine appends; nothing here is ever edited by an agent. Pure — the
 * server decides where the folder is and writes what changed.
 */
import { renderHandoff, type Handoff, type LedgerEntry, type LedgerKind, type TeamRun } from './engine.js'
import { renderPlan } from './plan.js'

const when = (at: number) => (at ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) : '')
const entry = (e: LedgerEntry) => `- ${e.at ? `${when(e.at)} · ` : ''}${e.task ? `**${e.task}** · ` : ''}${e.text}${e.why ? ` — because ${e.why}` : ''} _(${e.by})_`

const SECTIONS: { kind: LedgerKind; title: string }[] = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'where', title: 'Where things are' },
  { kind: 'surprise', title: 'Surprises' },
  { kind: 'failed', title: 'Tried, didn’t work' },
  { kind: 'verify', title: 'How to check' },
  { kind: 'note', title: 'Notes' },
  { kind: 'resume', title: 'Resumes — who got the team moving again, and why' },
]

export function renderLedger(run: TeamRun): string {
  const out = [`# Ledger · ${run.title}`, 'What the team learned, in the order it was handed in. Appended by triage from each submit_step; never rewritten.']
  if (run.card.decisions.length) out.push(`## Decisions on the card\n${run.card.decisions.map((d) => `- ${d}`).join('\n')}`)
  for (const s of SECTIONS) {
    const xs = run.ledger.filter((e) => e.kind === s.kind)
    if (xs.length) out.push(`## ${s.title}\n${xs.map(entry).join('\n')}`)
  }
  if (!run.ledger.length) out.push('_Nothing handed in yet._')
  return out.join('\n\n') + '\n'
}

export function renderVerify(run: TeamRun): string {
  const out = [`# How to check · ${run.title}`]
  if (run.checkCmds?.length) out.push(`## The project's checks\ntriage runs these between steps, for free:\n${run.checkCmds.map((c) => `- \`${c}\``).join('\n')}`)
  if (run.baseline) {
    const lines = run.baseline.results.map((r) => `- \`${r.cmd}\`: ${r.ok ? 'passed' : `FAILED — already failing before any change\n\n  \`\`\`\n${r.tail.slice(-1200).replace(/\n/g, '\n  ')}\n  \`\`\``}`)
    out.push(`## When the run started (${when(run.baseline.at)})\n${lines.join('\n') || '- no checks configured'}`)
  }
  const learned = run.ledger.filter((e) => e.kind === 'verify')
  if (learned.length) out.push(`## What workers found\n${learned.map(entry).join('\n')}`)
  if (out.length === 1) out.push('_Nothing yet._')
  return out.join('\n\n') + '\n'
}

export function renderReviews(run: TeamRun): string {
  const out = [`# Reviews · ${run.title}`]
  const raised = new Map<string, { h: Handoff; i: number }>()
  run.outputs.forEach((h) => h.findings?.forEach((f, i) => f.id && raised.set(f.id, { h, i })))
  const ids = Object.keys(run.findingState)
  if (!ids.length) return `${out[0]}\n\n_No findings._\n`
  for (const id of ids) {
    const st = run.findingState[id]
    const at = raised.get(id)
    const f = at?.h.findings?.[at.i]
    out.push(
      [
        `## ${id} · ${st.status}${f ? ` · ${f.severity}` : ''}`,
        f ? `${f.where} — ${f.problem}\n\nFix: ${f.fix}` : '',
        at ? `Raised by ${at.h.label}${at.h.round ? ` in fix round ${at.h.round}` : ''}${at.h.file ? ` (${at.h.file})` : ''}.` : '',
        st.note ? `Answer: ${st.note}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
  }
  return out.join('\n\n') + '\n'
}

export function renderHandoffFile(h: Handoff): string {
  const head = `# ${h.label}${h.task ? ` · ${h.task}` : ''} · ${h.stepId}${h.round ? ` · fix round ${h.round}` : ''}`
  return `${head}\n\n${when(h.at)}\n\n${renderHandoff(h).replace(/^### .*\n\n?/, `**${h.summary}**\n\n`)}\n`
}

/** Every file in the run folder, by its path relative to the folder. */
export function runFiles(run: TeamRun): Record<string, string> {
  const files: Record<string, string> = {
    'plan.md': renderPlan(run),
    'ledger.md': renderLedger(run),
    'verify.md': renderVerify(run),
    'reviews.md': renderReviews(run),
  }
  for (const h of run.outputs) if (h.file) files[h.file] = renderHandoffFile(h)
  return files
}
