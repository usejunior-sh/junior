import path from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { type DiffScope, runStatus, type TeamRun, workerById, type WorkerRun } from '../../core/teams/engine.js'
import { snapshotTree, type TreeChange, treeDiff, treePatch, treeStat } from '../git.js'
import type { TeamRunFile } from '../../shared/protocol.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { runDirOf, syncRunFolder } from './state.js'

/** Diffs at most this long go inline; past it the reader gets the map and the patch by reference. */
const INLINE_DIFF_CHARS = 8000

/**
 * The diff a checker reads instead of anyone's transcript. This task's, or the
 * whole run's. Always the stat first (the map: which files, how much). A small
 * patch rides inline; a big one is written to the run's folder and the reader
 * pulls what it needs, file by file. It only pays for what it reads.
 */
export async function handoffDiff(rt: WorkspaceRuntime, run: TeamRun, scope: DiffScope): Promise<{ text: string; file?: string }> {
  const base = scope === 'task' ? run.baseTree : run.runBase ?? run.baseTree
  const what = scope === 'task' ? `this task's changes` : `the whole run's changes`
  if (!run.root || !base) return { text: '## Diff\n(no baseline — read the files the handoffs list)' }
  const now = await snapshotTree(run.root)
  if (!now) return { text: '## Diff\n(could not read the working tree)' }
  const [stat, { patch }] = await Promise.all([
    treeStat(run.root, base, now).catch(() => ''),
    treePatch(run.root, base, now, 20_000_000).catch(() => ({ patch: '', truncated: false })),
  ])
  if (!patch) return { text: `## Diff — ${what}\n(no file changes were detected)` }
  if (patch.length <= INLINE_DIFF_CHARS) return { text: `## Diff — ${what}\n\`\`\`\n${stat}\n\`\`\`\n\`\`\`diff\n${patch}\n\`\`\`` }
  const task = run.task !== null ? run.card.tasks[run.task]?.id : null
  const file = path.join(runDirOf(rt, run), 'patches', `${scope}${task && scope === 'task' ? `-${task}` : ''}-round${run.round}.patch`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, patch, 'utf8')
  const lines = patch.split('\n').length
  const text = [
    `## Diff — ${what}: ${lines} lines, too long to inline`,
    `\`\`\`\n${stat}\n\`\`\``,
    `The full patch is at ${file} — Read it in parts (offset/limit), or read one file's changes at a time:`,
    `\`git diff ${base} -- <file>\` (edits to files git already tracks; a brand-new file is only in the patch).`,
    'Start from the files that matter most for the criteria; you don\'t need to read every line.',
  ].join('\n')
  return { text, file }
}

/** A run label for a file row: "T2", "T2 r1", or the step. */
function runTag(run: TeamRun, r: WorkerRun): string {
  return r.task ? `${r.task}${r.round ? ` r${r.round}` : ''}` : r.stepId
}

const kb = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)

/**
 * The run's Files panel: what the team works from (the Plan, the item's brief and
 * notes), what the team is (the recipe and agent files), what it changed since it
 * started (with who changed it), and what it left as proof (patches, checks, findings).
 */
export async function teamRunFilesOp(rt: WorkspaceRuntime, run: TeamRun): Promise<TeamRunFile[]> {
  const out: TeamRunFile[] = []
  const labelOf = (workerId: string | null) => (workerId ? workerById(run, workerId)?.label ?? workerId : 'junior')
  const everyone = [...new Set(run.workers.map((w) => w.label))]

  // Ledger: the Plan (Junior writes it, every agent reads it), the run folder's own files, then the item's brief and notes.
  await syncRunFolder(rt, run)
  out.push({ group: 'ledger', name: 'plan.md', detail: 'goal, criteria, tasks, progress — and the outcome', writer: 'junior', readers: everyone, open: { kind: 'runfile', path: 'plan.md' }, runs: [], live: run.state !== 'done' && run.state !== 'stopped' })
  const notFixed = Object.values(run.findingState).filter((v) => v.status !== 'fixed').length
  out.push(
    { group: 'ledger', name: 'ledger.md', detail: 'decisions, where things are, surprises, what failed', writer: [...new Set(run.ledger.map((e) => e.by))].join(', ') || 'junior', readers: everyone, open: { kind: 'runfile', path: 'ledger.md' }, runs: [], badge: `${run.ledger.length}` },
    { group: 'ledger', name: 'verify.md', detail: 'how to check this project', writer: 'junior', readers: everyone, open: { kind: 'runfile', path: 'verify.md' }, runs: [], ...(run.baseline ? { badge: run.baseline.results.every((r) => r.ok) ? 'baseline ok' : 'baseline failing' } : {}) },
  )
  if (Object.keys(run.findingState).length) out.push({ group: 'ledger', name: 'reviews.md', detail: 'every finding by id', writer: 'junior', readers: [], open: { kind: 'runfile', path: 'reviews.md' }, runs: [], badge: notFixed ? `${notFixed} open` : 'all fixed' })
  const links = (await rt.store.links.list()).filter((l) => l.fromKind === 'artifact' && l.toKind === 'item' && l.toId === run.itemId && (l.role === 'brief' || l.role === 'context'))
  for (const l of links) {
    const a = await rt.store.artifacts.get(l.fromId)
    if (!a) continue
    out.push({ group: 'ledger', name: `${l.role === 'brief' ? 'Brief' : 'Notes'} · ${a.title}`, detail: a.path, writer: a.author === 'human' ? 'you' : 'Junior', readers: ['Lead'], open: { kind: 'artifact', id: a.id }, runs: [] })
  }

  // Team: the recipe it was copied from, and each agent file a step names.
  out.push({ group: 'team', name: run.team ? `teams/${run.team}.md` : 'Recipe drafted for this run', detail: `${run.recipe.label} · ${run.recipe.steps.length} steps · copied at approval`, writer: run.team ? 'you' : 'Lead', readers: [], open: run.team ? { kind: 'library', library: 'team', name: run.team } : null, runs: [] })
  for (const agent of run.agents) {
    if (!run.recipe.steps.some((s) => s.agent === agent.name)) continue
    out.push({ group: 'team', name: `agents/${agent.name}.md`, detail: agent.can.length ? agent.can.join(' · ') : 'reads only what it is sent', writer: 'you', readers: [agent.label], open: { kind: 'library', library: 'agent', name: agent.name }, runs: [] })
  }

  // Changed: the tree now against the tree the run started from. A file belongs to the
  // runs whose handoff lists it; one no handoff claims yet is the working run's.
  // A team that never edits (Research, Review) changed nothing; a finished run changed what it had when it ended.
  const edits = run.recipe.steps.some((s) => s.output === 'change')
  const ended = run.state === 'done' || run.state === 'stopped'
  if (edits && run.root && run.runBase && (!ended || run.endTree)) {
    const now = ended ? run.endTree! : await snapshotTree(run.root)
    const changes = now ? await treeDiff(run.root, run.runBase, now).catch(() => [] as TreeChange[]) : []
    const handed = run.workerRuns.filter((r) => r.handoffId)
    const working = run.workerRuns.findLast((r) => runStatus(run, r) === 'working' && run.recipe.steps.find((s) => s.id === r.stepId)?.output === 'change')
    for (const c of changes) {
      const claims = (files: string[] | undefined) => (files ?? []).some((f) => f === c.path || f.endsWith(`/${c.path}`) || c.path.endsWith(`/${f.replace(/^\.\//, '')}`))
      const by = handed.filter((r) => claims(run.outputs.find((o) => o.id === r.handoffId)?.files)).map((r) => r.id)
      const live = !by.length && !!working
      out.push({
        group: 'changed',
        name: c.path,
        detail: by.map((id) => runTag(run, run.workerRuns.find((r) => r.id === id)!)).join(', ') || (live ? `${runTag(run, working!)} · in progress` : ''),
        writer: by.length ? labelOf(run.workerRuns.find((r) => r.id === by[0])!.workerId) : live ? labelOf(working!.workerId) : '',
        readers: [],
        open: { kind: 'project', path: c.path },
        runs: by.length ? by : live ? [working!.id] : [],
        ...(live ? { live: true } : {}),
        added: c.insertions,
        removed: c.deletions,
        status: c.status,
      })
    }
  }

  // Evidence: every handoff as its file, and the patches readers were sent.
  const dir = runDirOf(rt, run)
  for (const h of run.outputs) {
    if (!h.file) continue
    const from = run.workerRuns.find((r) => r.handoffId === h.id)
    const ok = h.checks ? h.checks.filter((c) => c.ok).length : 0
    out.push({
      group: 'evidence',
      name: path.basename(h.file),
      detail: h.summary,
      writer: h.label,
      readers: [],
      open: { kind: 'runfile', path: h.file },
      runs: from ? [from.id] : [],
      ...(h.checks ? { badge: h.checks.length ? `${ok}/${h.checks.length}` : '—' } : h.verdict ? { badge: h.verdict } : h.findings?.length ? { badge: `${h.findings.length}` } : {}),
    })
  }
  for (const r of run.workerRuns) {
    if (!r.patch) continue
    const size = (await stat(r.patch).catch(() => null))?.size
    const rel = path.relative(dir, r.patch)
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel)
    out.push({ group: 'evidence', name: path.basename(r.patch), detail: inside ? rel : r.patch, writer: 'junior', readers: [labelOf(r.workerId)], open: inside ? { kind: 'runfile', path: rel } : { kind: 'file', path: r.patch }, runs: [r.id], ...(size != null ? { badge: kb(size) } : {}) })
  }
  return out
}
