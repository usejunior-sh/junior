import * as Tabs from '@radix-ui/react-tabs'
import { PanelRight } from 'lucide-react'
import { useState, useMemo, type ReactNode } from 'react'
import type { TeamRunView, SessionSummary, ModelOption } from '../../../shared/protocol.js'
import { goalOverdue, horizonText } from '../../../core/teams/engine.js'
import { runFileHash } from './RunFolderPage.js'
import { wakeText, WakeNow, RaiseBudget, ResultActions, GoalAsks } from './TeamGoal.js'
import { findModel } from '../models.js'
import { usd } from '../teams.js'
import { Mark, call, errText, who, widthOf } from './team/shared.js'
import { PermissionSelect, TeamFastToggle } from './team/TeamEditors.js'

export { useTeamRun } from './team/shared.js'
export { TeamFastToggle } from './team/TeamEditors.js'
export { TeamSide } from './team/TeamSide.js'
export type { TeamSideTab } from './team/TeamSide.js'

// The strip: one tab per session, then the planned agents, the spend and controls

export function TeamStrip({
  run,
  sessionId,
  sessions,
  models,
  sideOpen,
  onToggleSide,
  onNavigate,
}: {
  run: TeamRunView
  sessionId: string
  sessions: readonly SessionSummary[]
  models: ModelOption[]
  sideOpen: boolean
  onToggleSide: () => void
  onNavigate: (to: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const modelName = (m: string | null | undefined) => (m ? findModel(models, m)?.name ?? m : undefined)
  // One tab per session: a session that worked two steps (Debug's challenge) is one member.
  const members = useMemo(() => {
    const out = [{ sessionId: run.leadSessionId, label: 'Lead', color: 'lead' }]
    for (const w of run.workers) {
      if (!w.sessionId || w.sessionId === run.leadSessionId) continue
      const at = out.findIndex((m) => m.sessionId === w.sessionId)
      if (at === -1) out.push({ sessionId: w.sessionId, label: w.label, color: w.color })
      else out[at] = { ...out[at], label: w.label }
    }
    return out
  }, [run])
  // Everyone the recipe brings in, from the card on: an agent with no session yet is a dashed chip.
  const planned = useMemo(() => {
    const out: { agent: string; label: string; color: string; model: string | null; width: string; first: string }[] = []
    run.recipe.steps.forEach((s, i) => {
      if (s.agent === 'lead' || s.agent === 'checks') return
      if (run.workers.some((w) => w.agent === s.agent && w.sessionId) || out.some((x) => x.agent === s.agent)) return
      const a = run.agents.find((x) => x.name === s.agent)
      out.push({
        agent: s.agent,
        label: a?.label ?? s.agent,
        color: a?.color ?? 'blue',
        model: run.card.steps.find((c) => c.id === s.id)?.model ?? s.model ?? a?.model ?? null,
        width: widthOf(run, i),
        first: s.id,
      })
    })
    return out
  }, [run])
  const ended = run.state === 'done' || run.state === 'stopped'
  const going = run.state === 'running' || run.state === 'gate' || run.state === 'waiting'
  const act = (path: 'pause' | 'resume' | 'stop') => {
    setBusy(true)
    call(path, { runId: run.id })
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  const pct = Math.min(100, (run.spentUsd / Math.max(0.01, run.budgetUsd)) * 100)

  return (
    <Tabs.Root value={sessionId} onValueChange={onNavigate} activationMode="manual">
      <Tabs.List id="teamStrip" aria-label="Team members">
        <span className="teamLabel">{run.goal ? `Goal · ${run.recipe.label}` : run.recipe.label}</span>
        {members.map((m) => {
          const s = sessions.find((x) => x.id === m.sessionId)
          const working = s?.status === 'running' || s?.status === 'starting'
          const asks = run.goal?.questions.some((q) => q.answer === null)
          const needsYou = s?.waiting || (m.sessionId === run.leadSessionId && (run.state === 'proposed' || run.state === 'gate' || asks))
          const state = needsYou ? 'needs you' : working ? 'working' : s?.status === 'error' ? 'error' : 'idle'
          const model = modelName(s?.model)
          const spent = run.spend[m.sessionId] ?? 0
          return (
            <Tabs.Trigger key={m.sessionId} value={m.sessionId} className="teamTab" title={`${m.label} — ${state}${model ? ` · ${model}` : ''} · ${usd(spent)}`}>
              <Mark color={m.color} />
              <span className="role">{m.label}</span>
              {model && <span className="model">{model}</span>}
              {spent > 0 && <span className="spend">{usd(spent)}</span>}
              {(needsYou || working) && (
                <span className="state">
                  <span className={`dot ${needsYou ? 'yellow' : 'live'}`} aria-hidden="true" /> {state}
                </span>
              )}
              {s?.status === 'error' && <span className="dot red" aria-label="error" />}
            </Tabs.Trigger>
          )
        })}
        {planned.map((p) => (
          <span key={p.agent} className="teamTab planned" title={`${p.label}${p.width ? ` ${p.width}` : ''} — ${ended ? "didn't run" : `starts at ${p.first}`}${p.model ? ` · ${p.model}` : ''}`}>
            <Mark color={p.color} />
            <span className="role">{p.label}</span>
            {p.width && <span className="model">{p.width}</span>}
            {p.model && <span className="model">{modelName(p.model)}</span>}
            <span className="state">{ended ? "didn't run" : `at ${p.first}`}</span>
          </span>
        ))}
        <span className={`teamRun ${run.state}`}>
          {run.state !== 'proposed' && (
            <>
              <span className="teamMeter" title={`${usd(run.spentUsd)} of ${usd(run.budgetUsd)} budget`} aria-hidden="true">
                <i style={{ width: `${pct}%` }} />
              </span>
              <span className="teamRunSpend">
                {usd(run.spentUsd)} <span className="of">/ {usd(run.budgetUsd)}</span>
              </span>
            </>
          )}
          {going && (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act('pause')} title="Stop every worker now; resume later">
              Pause
            </button>
          )}
          {(going || run.state === 'paused') && (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act('stop')} title="End the run">
              Stop
            </button>
          )}
          <button type="button" className={`btn sm ghost teamSideBtn${sideOpen ? ' on' : ''}`} onClick={onToggleSide} aria-pressed={sideOpen} title="Every detail of the run — and, before you approve, where you change it">
            <PanelRight size={13} aria-hidden="true" /> Details
          </button>
        </span>
      </Tabs.List>
    </Tabs.Root>
  )
}

// The dock: small, above the composer, on the lead, what the run needs now

function Flow({ run }: { run: TeamRunView }) {
  const at = run.state === 'done' ? run.recipe.steps.length : run.step
  const live = run.state !== 'proposed'
  return (
    <span className="tdFlow">
      {run.recipe.steps.map((s, i) => {
        const w = who(run, s.agent)
        const state = !live ? '' : i < at ? ' done' : i === at ? ' on' : ''
        const loopStart = s.forEach && !run.recipe.steps[i - 1]?.forEach
        return (
          <span key={s.id} className="tdStepWrap">
            {i > 0 && <span className="tdArrow" aria-hidden="true">→</span>}
            {loopStart && (
              <span className="tdEach" title="These steps run once per task on the plan">
                ↻ per task{run.card.tasks.length ? ` ×${run.card.tasks.length}` : ''}
              </span>
            )}
            <span className={`tdChip${s.agent === 'checks' ? ' sys' : ''}${state}`} title={`${s.id}${s.does ? ` — ${s.does}` : ''}`}>
              {state === ' done' ? <span className="tdTick" aria-hidden="true">✓</span> : <Mark color={w.color} />}
              {w.label}
              {widthOf(run, i) && <span className="m">{widthOf(run, i)}</span>}
            </span>
            {s.onFail && <span className="tdLoop" title={`a failure goes back to ${s.onFail.backTo}, at most ${s.onFail.max}×`}>↺≤{s.onFail.max}</span>}
          </span>
        )
      })}
    </span>
  )
}

export function TeamDock({ run, onDetails, onNavigate }: { run: TeamRunView; onDetails: () => void; onNavigate: (to: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = (path: string, body: unknown) => {
    setBusy(true)
    setError(null)
    call(path, body)
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  const step = run.recipe.steps[run.step]
  const waiting = run.awaiting.map((id) => run.workers.find((w) => w.id === id)?.label).filter(Boolean)
  const task = run.task !== null && step?.forEach ? run.card.tasks[run.task] : undefined
  const g = run.goal ?? null
  const asks = g?.questions.some((q) => q.answer === null) ?? false
  const toAccept = !!g && run.state === 'done' && !g.acceptedAt
  const needsYou = run.state === 'proposed' || run.state === 'gate' || run.state === 'paused' || !!run.revision || asks || toAccept
  const overdue = goalOverdue(run, Date.now())

  let dot = 'live'
  let title: ReactNode = null
  let line: ReactNode = null
  let primary: ReactNode = null
  if (run.state === 'proposed') {
    dot = 'yellow'
    title = g ? 'Run this goal?' : 'Run this team?'
    line = g ? `done when ${g.doneWhen} · ${horizonText(g.horizon)}` : run.card.goal
    primary = (
      <>
        <PermissionSelect run={run} disabled={busy} onError={setError} />
        <TeamFastToggle run={run} onError={setError} />
        <button
          type="button"
          className="btn primary sm"
          disabled={busy || !run.card.permissions}
          title={run.card.permissions ? undefined : 'Pick what the team may do without asking first'}
          onClick={() => go('approve', { runId: run.id })}
        >
          {busy ? 'Starting…' : 'Approve & run'}
        </button>
      </>
    )
  } else if (run.revision) {
    dot = 'yellow'
    title = 'Plan change proposed'
    line = run.revision.why
    primary = (
      <>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => go('revision', { runId: run.id, accept: false })}>
          Turn down
        </button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => go('revision', { runId: run.id, accept: true })} title="Applies from the next task">
          Accept
        </button>
      </>
    )
  } else if (run.state === 'running' && g?.owes === 'verdict') {
    title = 'Junior is checking the done-when'
    line = g.doneWhen
  } else if (run.state === 'running' && g?.owes === 'unstick') {
    dot = 'yellow'
    title = 'The team is stuck'
    line = `${g.stuck?.why ?? 'its fix rounds ran out'} — Junior is working out how to get it moving`
  } else if (run.state === 'running') {
    title = task
      ? `Task ${run.task! + 1} of ${run.card.tasks.length} · ${step?.id ?? ''}`
      : `Step ${run.step + 1} of ${run.recipe.steps.length} · ${step?.id ?? ''}`
    line = run.splitting
      ? 'the lead is splitting this step'
      : step?.agent === 'checks'
        ? 'running the project’s checks'
        : waiting.length
          ? `${task ? `${task.title} · ` : ''}${waiting.join(', ')} ${waiting.length === 1 ? 'is' : 'are'} on it`
          : 'moving on'
  } else if (run.state === 'gate') {
    dot = 'yellow'
    title = 'Needs you'
    line = run.reason
    primary = (
      <button type="button" className="btn primary sm" disabled={busy} onClick={() => go('resume', { runId: run.id })}>
        Continue
      </button>
    )
  } else if (run.state === 'waiting' && g?.wait) {
    dot = 'blue'
    title = 'Waiting on the world'
    line = `for ${g.wait.for} · ${wakeText(g.wait.until)}`
    primary = <WakeNow run={run} onError={setError} />
  } else if (run.state === 'paused') {
    dot = 'yellow'
    title = 'Paused'
    line = run.reason
    // Only you lift a budget pause: say how much more, then it resumes.
    primary = run.reason?.startsWith('budget') ? (
      <RaiseBudget run={run} onError={setError} />
    ) : (
      <button type="button" className="btn sm" disabled={busy} onClick={() => go('resume', { runId: run.id })} title="Carry on where it stopped">
        Resume
      </button>
    )
  } else if (toAccept) {
    dot = 'yellow'
    title = 'Junior says it’s done'
    line = g!.verdicts.at(-1)?.evidence ?? g!.doneWhen
    primary = <ResultActions run={run} onError={setError} />
  } else if (run.state === 'done' && g) {
    dot = 'green'
    title = `Goal done · ${usd(run.spentUsd)}`
    line = `accepted · ${g.doneWhen}`
  } else if (run.state === 'done') {
    dot = run.unresolved ? 'yellow' : 'green'
    title = `Team done · ${usd(run.spentUsd)}`
    line = run.unresolved ? `unresolved: ${run.unresolved}` : 'the outcome is in the run’s plan.md'
    // Runs from before plans saved their result as its own artifact.
    primary =
      !run.planArtifactId && run.resultArtifactId ? (
        <button type="button" className="btn sm" onClick={() => onNavigate(`/artifact/${run.resultArtifactId}`)}>
          Open the result
        </button>
      ) : null
  } else {
    dot = 'stone'
    title = `Team stopped · ${usd(run.spentUsd)}`
  }

  return (
    <div className={`teamDock${needsYou ? ' ask' : ''}`} role="region" aria-label="Team run">
      <div className="tdRow">
        <span className={`dot ${dot}`} aria-hidden="true" />
        <span className="tdTitle">{title}</span>
        {line && <span className="tdLine">{line}</span>}
        {overdue && <span className="pill yellow" title={`The goal was due ${horizonText(g!.horizon)}`}>overdue</span>}
        <span className="sp" />
        <button type="button" className="btn sm ghost" onClick={() => onNavigate(runFileHash(run.id))} title="The run folder: plan, ledger, reviews and every handoff — the outcome when it's done">
          Open plan
        </button>
        <button type="button" className="btn sm ghost" onClick={onDetails}>
          Details
        </button>
        {primary}
      </div>
      <div className="tdRow">
        <Flow run={run} />
        <span className="sp" />
        <span className="tdCap mono">{run.state === 'proposed' ? `cap ${usd(run.card.budgetUsd)}` : `${usd(run.spentUsd)} / ${usd(run.budgetUsd)}`}</span>
      </div>
      <GoalAsks run={run} />
      {error && <div className="tdErr" role="alert">{error}</div>}
    </div>
  )
}
