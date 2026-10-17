import * as Tabs from '@radix-ui/react-tabs'
import { ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, PanelRight, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Handoff, ModelOption, SessionSummary, TeamRunFile, TeamRunFilesResponse, TeamRunView, WorkerRun } from '../../../shared/protocol.js'
import { runStatus } from '../../../core/teams/engine.js'
import { findModel } from '../models.js'
import { openSettings } from '../settings.js'
import { colorOf, teamsCall, usd } from '../teams.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'
import { runFileHash } from './RunFolderPage.js'
import { TeamFastToggle } from './TeamRun.js'
import { ResumedTag } from './TeamGoal.js'
import type { TranscriptMark } from './Transcript.js'

/**
 * A team run as a room you walk through (.docs/team-session-storybook.html, layout A):
 *
 *   TeamRuns    the drawer's Runs tab — the team by person (TeamRail) or by task (TeamMap)
 *   TeamRail    the team, each member's runs nested under it
 *   RunHeader   over the transcript — whose session this is, which run you're reading, the run's spend
 *   runMarks    a divider at the start of every run in the transcript, sticky while you read it
 *   TeamMap     every run, by task and step
 *   TeamFiles   in the drawer — what the team works from, what it changed, what it left as proof
 *
 * A run is one worker's go at one step, for one task and fix round (WorkerRun). The reviewer
 * starts fresh for every task, so its one session holds many runs; the dividers keep them apart.
 */

export type RunStatus = ReturnType<typeof runStatus>

/** Open a member's session, scrolled to a run (or to now) — in this tab, or in a new one behind it (⌘-click). */
export type OpenRun = (sessionId: string, runId: string | null, newTab?: boolean) => void
const newTab = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey

/** One run as the rail and the dividers draw it. */
export type RunRow = {
  run: WorkerRun
  sessionId: string | null
  status: RunStatus
  /** `T2`, `T2 r1`, or the step outside the loop */
  tag: string
  title: string
  cost: number | null
  /** when its handoff came in; null while it works, or if it never handed in */
  endAt: number | null
}

export type Member = { sessionId: string; label: string; color: string; runs: RunRow[] }
export type PlannedMember = { agent: string; label: string; color: string; first: string }

const GLYPH: Record<RunStatus, string> = { working: '●', pass: '✓', fail: '✗', done: '✓', stopped: '○' }
const STATUS_TEXT: Record<RunStatus, string> = { working: 'working', pass: 'pass', fail: 'fail', done: 'handed in', stopped: 'stopped' }

export function runTag(r: WorkerRun): string {
  return r.task ? `${r.task}${r.round ? ` r${r.round}` : ''}` : r.stepId
}

function runTitle(view: TeamRunView, r: WorkerRun): string {
  if (r.round) return `fix round ${r.round}`
  const step = view.recipe.steps.find((s) => s.id === r.stepId)
  const task = r.task ? view.card.tasks.find((t) => t.id === r.task) : undefined
  if (task && step?.output === 'change') return task.title
  if (step?.output === 'verdict') return task ? `review ${task.id}` : `${r.stepId} · verdict`
  return task ? `${r.stepId} · ${task.id}` : r.stepId
}

/** Every run, in order, with what it cost: its session's spend up to the next run there (or now). */
export function runRows(view: TeamRunView): RunRow[] {
  const rows = view.workerRuns.map((r) => {
    const w = view.workers.find((x) => x.id === r.workerId)
    const endAt = (r.handoffId && view.outputs.find((o) => o.id === r.handoffId)?.at) || null
    return { run: r, sessionId: w?.sessionId ?? null, status: runStatus(view, r), tag: runTag(r), title: runTitle(view, r), cost: null as number | null, endAt }
  })
  rows.forEach((row, i) => {
    if (row.run.spendAtStart === null || !row.sessionId) return
    const next = rows.slice(i + 1).find((x) => x.sessionId === row.sessionId && x.run.spendAtStart !== null)
    const end = next ? next.run.spendAtStart! : view.spend[row.sessionId] ?? row.run.spendAtStart
    row.cost = Math.max(0, end - row.run.spendAtStart)
  })
  return rows
}

/** The team: the lead, one entry per worker session (a session that worked two steps is one member), then who's still to come. */
export function teamMembers(view: TeamRunView): { members: Member[]; planned: PlannedMember[] } {
  const rows = runRows(view)
  const members: Member[] = [{ sessionId: view.leadSessionId, label: 'Lead', color: 'lead', runs: [] }]
  for (const w of view.workers) {
    if (!w.sessionId || w.sessionId === view.leadSessionId) continue
    const at = members.findIndex((m) => m.sessionId === w.sessionId)
    // A fan-out worker's label names its slice; the member reads as the agent.
    const label = w.slice ? w.label.split(' · ')[0] : w.label
    if (at === -1) members.push({ sessionId: w.sessionId, label, color: w.color, runs: [] })
  }
  for (const m of members) m.runs = rows.filter((r) => r.sessionId === m.sessionId)
  const planned: PlannedMember[] = []
  for (const s of view.recipe.steps) {
    if (s.agent === 'lead' || s.agent === 'checks') continue
    if (view.workers.some((w) => w.agent === s.agent && w.sessionId) || planned.some((p) => p.agent === s.agent)) continue
    const a = view.agents.find((x) => x.name === s.agent)
    planned.push({ agent: s.agent, label: a?.label ?? s.agent, color: a?.color ?? 'blue', first: s.id })
  }
  return { members, planned }
}

function Mark({ color }: { color: string }) {
  if (color === 'lead') return <span className="mgrGlyph" aria-hidden="true" />
  if (color === 'checks') return <span className="swatch sys" aria-hidden="true" />
  return <span className="swatch" style={{ background: colorOf(color) }} aria-hidden="true" />
}

/** How long a run took: start to handoff, or so far while it works. Null when either end is unknown. */
export function runDuration(row: RunRow, now: number): number | null {
  const end = row.endAt ?? (row.status === 'working' ? now : null)
  return row.run.at && end ? Math.max(0, end - row.run.at) : null
}

/** `48s`, `4m 12s`, `1h 05m` */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The time, ticking while something is working so a live run's duration counts up. */
function useNow(ticking: boolean, every = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), every)
    return () => window.clearInterval(t)
  }, [ticking, every])
  return ticking ? now : Date.now()
}

const clock = (at: number | null) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
const checkOutputs = (view: TeamRunView) => view.outputs.filter((o) => o.checks)

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

export function TeamRail({
  run,
  sessionId,
  sessions,
  models,
  current,
  onOpenRun,
}: {
  run: TeamRunView
  sessionId: string
  sessions: readonly SessionSummary[]
  models: ModelOption[]
  /** the run you're reading */
  current: string | null
  /** open a member's session, scrolled to a run (or to now) */
  onOpenRun: OpenRun
}) {
  const { members, planned } = useMemo(() => teamMembers(run), [run])
  const checks = checkOutputs(run)
  const ended = run.state === 'done' || run.state === 'stopped'
  const now = useNow(members.some((m) => m.runs.some((r) => r.status === 'working')))
  return (
    <nav className="teamRail" aria-label="Team">
      {members.map((m) => {
        const s = sessions.find((x) => x.id === m.sessionId)
        const working = s?.status === 'running' || s?.status === 'starting'
        const needsYou = s?.waiting || (m.sessionId === run.leadSessionId && (run.state === 'proposed' || run.state === 'gate'))
        const model = s?.model ? findModel(models, s.model)?.name ?? s.model : null
        const spent = run.spend[m.sessionId] ?? 0
        const on = m.sessionId === sessionId
        return (
          <div key={m.sessionId} className="trMember">
            <button type="button" className={`trRow${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onClick={(e) => onOpenRun(m.sessionId, null, newTab(e))}>
              <Mark color={m.color} />
              <span className="nm">{m.label}</span>
              {model && <span className="md">{model}</span>}
              <span className="sp" />
              {needsYou ? <span className="dot yellow" aria-label="needs you" /> : working ? <span className="dot live" aria-label="working" /> : s?.status === 'error' ? <span className="dot red" aria-label="error" /> : null}
              {spent > 0 && <span className="money">{usd(spent)}</span>}
            </button>
            {m.runs.length > 0 && (
              <ol className="trRuns">
                {m.runs.map((r) => {
                  const took = runDuration(r, now)
                  return (
                  <li key={r.run.id}>
                    <button type="button" className={`trRun${r.run.id === current ? ' on' : ''}`} aria-current={r.run.id === current ? 'true' : undefined} data-run={r.run.id} onClick={(e) => onOpenRun(m.sessionId, r.run.id, newTab(e))} title={`${r.tag} · ${r.title} — ${STATUS_TEXT[r.status]}${r.run.resumedBy ? ` · resumed by ${r.run.resumedBy === 'junior' ? 'Junior' : 'you'}` : ''}${took !== null ? ` · ${fmtDuration(took)}` : ''}${r.cost ? ` · ${usd(r.cost)}` : ''}${r.run.at ? ` · started ${clock(r.run.at)}` : ''}`}>
                      <span className={`trGlyph ${r.status}`} aria-hidden="true">{GLYPH[r.status]}</span>
                      <span className="tag">{r.run.task ? r.tag : ''}</span>
                      <span className="tt">{r.run.task ? r.title : r.tag}</span>
                      <ResumedTag by={r.run.resumedBy} />
                      {took !== null && <span className="dur">{fmtDuration(took)}</span>}
                      <span className="k">{clock(r.run.at)}</span>
                    </button>
                  </li>
                  )
                })}
              </ol>
            )}
          </div>
        )
      })}
      {(run.resumes?.length ?? 0) > 0 && (
        <div className="trMember">
          <div className="trRow static">
            <span className="nm">Resumes</span>
            <span className="md">who got the team moving again</span>
          </div>
          <ol className="trRuns">
            {run.resumes!.map((r, n) => (
              <li key={n}>
                <div className="trRun static" title={r.why ? `${r.what} — because ${r.why}` : r.what}>
                  <ResumedTag by={r.by} />
                  <span className="tt">{r.what}</span>
                  <span className="k">{clock(r.at)}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {checks.length > 0 && (
        <div className="trMember">
          <div className="trRow static">
            <Mark color="checks" />
            <span className="nm">Checks</span>
            <span className="md">free</span>
          </div>
          <ol className="trRuns">
            {checks.map((h) => {
              const ok = h.checks!.every((c) => c.ok)
              return (
                <li key={h.id}>
                  <div className="trRun static" title={h.summary}>
                    <span className={`trGlyph ${ok ? 'pass' : 'fail'}`} aria-hidden="true">{ok ? '✓' : '✗'}</span>
                    <span className="tag">{h.task ? `${h.task}${h.round ? ` r${h.round}` : ''}` : ''}</span>
                    <span className="tt">{ok ? 'checks' : 'failed'}</span>
                    <span className="k">{clock(h.at)}</span>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}
      {planned.map((p) => (
        <div key={p.agent} className="trRow planned" title={ended ? "didn't run" : `starts at ${p.first}`}>
          <Mark color={p.color} />
          <span className="nm">{p.label}</span>
          <span className="sp" />
          <span className="k">{ended ? "didn't run" : `at ${p.first}`}</span>
        </div>
      ))}
    </nav>
  )
}

export type RunsView = 'person' | 'task'

/** The drawer's Runs tab: the team by person (the rail), or every run by task and step (the map). */
export function TeamRuns({
  view,
  ...props
}: {
  view: RunsView
  run: TeamRunView
  sessionId: string
  sessions: readonly SessionSummary[]
  models: ModelOption[]
  current: string | null
  onOpenRun: OpenRun
}) {
  return view === 'task' ? <TeamMap run={props.run} current={props.current} onOpenRun={props.onOpenRun} /> : <TeamRail {...props} />
}

/** By person / by task, at the end of the drawer's tab row while Runs is open. */
export function RunsViewToggle({ view, onView }: { view: RunsView; onView: (view: RunsView) => void }) {
  return (
    <Tabs.Root value={view} onValueChange={(v) => onView(v as RunsView)}>
      <Tabs.List className="trViews" aria-label="Show runs">
        <Tabs.Trigger value="person" className="trView" aria-label="By person" title="By person">
          <Users size={13} aria-hidden="true" />
        </Tabs.Trigger>
        <Tabs.Trigger value="task" className="trView" aria-label="By task" title="By task and step">
          <LayoutGrid size={13} aria-hidden="true" />
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  )
}

// ---------------------------------------------------------------------------
// The header over a member's transcript, and the dividers inside it
// ---------------------------------------------------------------------------

export function RunHeader({
  run,
  sessionId,
  sessions,
  models,
  current,
  onJump,
  sideOpen,
  onToggleSide,
  onOpenRun,
}: {
  run: TeamRunView
  sessionId: string
  sessions: readonly SessionSummary[]
  models: ModelOption[]
  /** the run the reader is in, from the scroll */
  current: string | null
  onJump: (runId: string) => void
  sideOpen: boolean
  onToggleSide: () => void
  /** open a member's session: the breadcrumb's way back to the lead */
  onOpenRun: OpenRun
}) {
  const [busy, setBusy] = useState(false)
  const { members } = useMemo(() => teamMembers(run), [run])
  const m = members.find((x) => x.sessionId === sessionId)
  const runs = m?.runs ?? []
  const i = Math.max(0, runs.findIndex((r) => r.run.id === current))
  const cur = runs[i]
  const s = sessions.find((x) => x.id === sessionId)
  const model = s?.model ? findModel(models, s.model)?.name ?? s.model : null
  const going = run.state === 'running' || run.state === 'gate' || run.state === 'waiting'
  const pct = Math.min(100, (run.spentUsd / Math.max(0.01, run.budgetUsd)) * 100)
  const act = (path: 'pause' | 'stop') => {
    setBusy(true)
    teamsCall('POST', path, { runId: run.id })
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <div className="runHeader">
      <span className="rhWho">
        {sessionId !== run.leadSessionId && (
          <>
            <button type="button" className="rhCrumb" onClick={(e) => onOpenRun(run.leadSessionId, null, newTab(e))} title="This worker runs under the lead — open the lead's session">
              <Mark color="lead" /> Lead
            </button>
            <ChevronRight size={12} className="rhSep" aria-hidden="true" />
          </>
        )}
        <Mark color={m?.color ?? 'lead'} /> {m?.label ?? 'Session'}
      </span>
      {model && <span className="rhMeta">{model}</span>}
      <span className="rhMeta">
        {runs.length} run{runs.length === 1 ? '' : 's'}
        {run.spend[sessionId] ? ` · ${usd(run.spend[sessionId])}` : ''}
      </span>
      {runs.length > 0 && (
        <span className="rhJump">
          <button type="button" className="iconBtn" aria-label="Previous run" disabled={i === 0} onClick={() => onJump(runs[i - 1].run.id)}>
            <ChevronLeft size={13} aria-hidden="true" />
          </button>
          <Menu>
            <MenuTrigger className="rhJumpLbl">
              Run {i + 1} of {runs.length}
              {cur && <span className="k">{cur.run.task ? cur.tag : cur.title}</span>}
              <ChevronDown size={12} aria-hidden="true" />
            </MenuTrigger>
            <MenuContent className="rhMenu" align="end">
                {runs.map((r, n) => (
                  <MenuItem key={r.run.id} className={`rhItem${r === cur ? ' cur' : ''}`} onSelect={() => onJump(r.run.id)}>
                    <span className={`trGlyph ${r.status}`} aria-hidden="true">{GLYPH[r.status]}</span>
                    <span className="k">{n + 1}</span>
                    <span className="tt">{r.run.task ? `${r.tag} · ${r.title}` : r.title}</span>
                    <span className="money">{clock(r.run.at)}</span>
                  </MenuItem>
                ))}
            </MenuContent>
          </Menu>
          <button type="button" className="iconBtn" aria-label="Next run" disabled={i >= runs.length - 1} onClick={() => onJump(runs[i + 1].run.id)}>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </span>
      )}
      <span className="sp" />
      {run.state !== 'proposed' && (
        <span className={`teamRun ${run.state}`}>
          <span className="teamMeter" title={`${usd(run.spentUsd)} of ${usd(run.budgetUsd)} budget`} aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="teamRunSpend">
            {usd(run.spentUsd)} <span className="of">/ {usd(run.budgetUsd)}</span>
          </span>
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
        </span>
      )}
      {run.state !== 'done' && run.state !== 'stopped' && <TeamFastToggle run={run} />}
      <button type="button" className={`btn sm ghost teamSideBtn${sideOpen ? ' on' : ''}`} onClick={onToggleSide} aria-pressed={sideOpen} title="Files, the plan and every detail of the run">
        <PanelRight size={13} aria-hidden="true" /> <span className="lbl">Details</span>
      </button>
    </div>
  )
}

function RunDivider({ row, n, of }: { row: RunRow; n: number; of: number }) {
  const first = n === 1
  const took = runDuration(row, Date.now())
  return (
    <div className={`runDiv ${row.status}`} data-run={row.run.id}>
      <div className="in">
        <span className="n">
          Run {n}/{of}
        </span>
        {row.run.task && <span className="tag">{row.tag}</span>}
        <span className="t">{row.run.task ? row.title : row.tag}</span>
        <span className="sp" />
        <ResumedTag by={row.run.resumedBy} long />
        {!first && <span className={`ctx${row.run.fresh ? '' : ' carry'}`}>{row.run.fresh ? 'fresh context' : 'same context'}</span>}
        <span className={`st ${row.status}`}>
          {row.status === 'working' ? <span className="dot live" aria-hidden="true" /> : GLYPH[row.status]} {STATUS_TEXT[row.status]}
        </span>
        <span className="money">
          {clock(row.run.at)}
          {took !== null ? ` · ${fmtDuration(took)}` : ''}
          {row.cost ? ` · ${usd(row.cost)}` : ''}
        </span>
      </div>
    </div>
  )
}

/** A divider before each of this session's runs, at the event its step arrived. */
export function runMarks(run: TeamRunView, sessionId: string): TranscriptMark[] {
  const runs = runRows(run).filter((r) => r.sessionId === sessionId)
  return runs.flatMap((r, i) => (r.run.startSeq === null ? [] : [{ at: r.run.startSeq - 1, key: `run:${r.run.id}`, node: <RunDivider row={r} n={i + 1} of={runs.length} /> }]))
}

/**
 * Which run the reader is in: the last divider at or above the top of the
 * transcript (the last one, at the bottom). And a jump: scroll a divider to the top.
 */
export function useRunScroll(sessionId: string, enabled: boolean, depsKey: string): { current: string | null; jump: (runId: string) => boolean } {
  const [current, setCurrent] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    const el = document.getElementById('transcript')
    if (!el) return
    const read = () => {
      const divs = [...el.querySelectorAll<HTMLElement>('.runDiv[data-run]')]
      if (!divs.length) return setCurrent(null)
      const top = el.getBoundingClientRect().top
      let c = divs[0].dataset.run!
      for (const d of divs) if (d.getBoundingClientRect().top - top <= 40) c = d.dataset.run!
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) c = divs[divs.length - 1].dataset.run!
      setCurrent(c)
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    return () => el.removeEventListener('scroll', read)
  }, [sessionId, enabled, depsKey])
  const jump = (runId: string): boolean => {
    const el = document.getElementById('transcript')
    const d = el?.querySelector<HTMLElement>(`.runDiv[data-run="${CSS.escape(runId)}"]`)
    if (!el || !d) return false
    // Sticky dividers report where they're stuck, not where they sit: measure the item after.
    const anchor = (d.nextElementSibling as HTMLElement | null) ?? d
    el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - d.offsetHeight - 8
    d.classList.remove('flash')
    void d.offsetWidth
    d.classList.add('flash')
    setCurrent(runId)
    return true
  }
  return { current, jump }
}

// ---------------------------------------------------------------------------
// The run map
// ---------------------------------------------------------------------------

export function TeamMap({
  run,
  current,
  onOpenRun,
}: {
  run: TeamRunView
  /** the run you're reading, outlined so the map says where you are */
  current: string | null
  onOpenRun: OpenRun
}) {
  const rows = useMemo(() => runRows(run), [run])
  const loopSteps = run.recipe.steps.filter((s) => s.forEach)
  const outside = run.recipe.steps.filter((s) => !s.forEach)
  const who = (agent: string) => (agent === 'lead' ? { label: 'Lead', color: 'lead' } : agent === 'checks' ? { label: 'Checks', color: 'checks' } : { label: run.agents.find((a) => a.name === agent)?.label ?? agent, color: run.agents.find((a) => a.name === agent)?.color ?? 'blue' })

  const cellsFor = (stepId: string, task?: string): ReactNode[] => {
    const s = run.recipe.steps.find((x) => x.id === stepId)!
    if (s.agent === 'checks') {
      return run.outputs
        .filter((o) => o.stepId === stepId && o.task === task && o.checks)
        .map((o) => {
          const ok = o.checks!.every((c) => c.ok)
          return (
            <span key={o.id} className={`tmCell static ${ok ? 'pass' : 'fail'}`} title={o.summary}>
              <span className={`trGlyph ${ok ? 'pass' : 'fail'}`} aria-hidden="true">{ok ? '✓' : '✗'}</span>
              {o.round ? `r${o.round}` : null}
            </span>
          )
        })
    }
    return rows
      .filter((r) => r.run.stepId === stepId && r.run.task === task)
      .map((r) => (
        <button
          key={r.run.id}
          type="button"
          className={`tmCell ${r.status}${r.run.id === current ? ' cur' : ''}`}
          aria-current={r.run.id === current ? 'true' : undefined}
          disabled={!r.sessionId}
          onClick={(e) => r.sessionId && onOpenRun(r.sessionId, r.run.id, newTab(e))}
          title={`${r.tag} · ${r.title} — ${STATUS_TEXT[r.status]}${r.endAt && r.run.at ? ` · ${fmtDuration(r.endAt - r.run.at)}` : ''}${r.cost ? ` · ${usd(r.cost)}` : ''}`}
        >
          <span className={`trGlyph ${r.status}`} aria-hidden="true">{GLYPH[r.status]}</span>
          {r.run.round ? `r${r.run.round}` : null}
        </button>
      ))
  }
  const empty = <span className="tmCell todo" title="Not started" aria-label="Not started" />
  const done = run.card.tasks.filter((t) => run.tasks[t.id]?.status === 'done').length
  const after = loopSteps.length ? outside.filter((s) => run.recipe.steps.indexOf(s) > run.recipe.steps.indexOf(loopSteps[0])) : outside
  const stepRows = (steps: typeof outside) =>
    steps.map((s) => {
      const cells = cellsFor(s.id)
      return (
        <div key={s.id} className="tmStep">
          <span className="lbl" title={who(s.agent).label}>
            <Mark color={who(s.agent).color} /> {s.id}
          </span>
          <span className="tmCells">{cells.length ? cells : empty}</span>
        </div>
      )
    })

  return (
    <div className="teamMap">
      <p className="tmSub">
        {run.card.tasks.length ? `${done} of ${run.card.tasks.length} tasks done · ` : ''}
        {rows.length} run{rows.length === 1 ? '' : 's'} · <span className="money">{usd(run.spentUsd)}</span> of <span className="money">{usd(run.budgetUsd)}</span>
      </p>
      {loopSteps.length > 0 && (
        <div className="tmGrid" style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${loopSteps.length}, minmax(64px, max-content))` }}>
          <div className="tmH">Task</div>
          {loopSteps.map((s) => (
            <div key={s.id} className="tmH" title={who(s.agent).label}>
              <Mark color={who(s.agent).color} /> <span className="t">{who(s.agent).label}</span>
            </div>
          ))}
          {run.card.tasks.map((t) => {
            const st = run.tasks[t.id]?.status ?? 'todo'
            return [
              <div key={t.id} className={`tmTask ${st}`} title={t.title}>
                <span className="tag">{t.id}</span>
                <span className="tt">{t.title}</span>
                {st === 'unresolved' && <span className="why">{run.tasks[t.id]?.why}</span>}
              </div>,
              ...loopSteps.map((s) => {
                const cells = cellsFor(s.id, t.id)
                return (
                  <div key={`${t.id}:${s.id}`} className="tmCells">
                    {cells.length ? cells : empty}
                  </div>
                )
              }),
            ]
          })}
        </div>
      )}
      {after.length > 0 && <div className="tmSteps">{stepRows(after)}</div>}
      {run.unresolved && <div className="teamUnresolved">Unresolved: {run.unresolved}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const GROUPS: { id: TeamRunFile['group']; label: string }[] = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'team', label: 'Team' },
  { id: 'changed', label: 'Changed' },
  { id: 'evidence', label: 'Evidence' },
]

export function TeamFiles({
  run,
  checkoutId,
  onNavigate,
  onOpenRun,
}: {
  run: TeamRunView
  /** the checkout the run works in: a changed file opens as its diff there */
  checkoutId: string | null
  onNavigate: (to: string) => void
  onOpenRun: OpenRun
}) {
  const [files, setFiles] = useState<TeamRunFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openHandoff, setOpenHandoff] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    teamsCall<Extract<TeamRunFilesResponse, { ok: true }>>('GET', `files?runId=${encodeURIComponent(run.id)}`)
      .then((b) => live && (setFiles(b.files), setError(null)))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [run.id, run.rev])
  const rows = useMemo(() => runRows(run), [run])
  const sessionOf = (runId: string) => rows.find((r) => r.run.id === runId)?.sessionId ?? null

  const open = (f: TeamRunFile) => {
    const o = f.open
    if (!o) return
    if (o.kind === 'artifact') onNavigate(`/artifact/${o.id}`)
    else if (o.kind === 'project' && checkoutId) onNavigate(`/change/${checkoutId}/${encodeURIComponent(o.path)}`)
    else if (o.kind === 'library') openSettings(o.library === 'team' ? 'teams' : 'agents')
    else if (o.kind === 'handoff') setOpenHandoff((x) => (x === o.id ? null : o.id))
    else if (o.kind === 'runfile') onNavigate(runFileHash(run.id, o.path))
    else if (o.kind === 'file') void navigator.clipboard?.writeText(o.path)
  }

  if (error) return <div className="tdErr">{error}</div>
  if (!files) return <div className="tfEmpty">Loading files…</div>
  return (
    <div className="teamFiles">
      {GROUPS.map((g) => {
        const list = files.filter((f) => f.group === g.id)
        if (!list.length) return null
        return (
          <section key={g.id} className="tfGroup">
            <div className="tsK">
              {g.label} <span className="c">{list.length}</span>
            </div>
            {list.map((f, n) => {
              const h: Handoff | undefined = f.open?.kind === 'handoff' ? run.outputs.find((o) => o.id === (f.open as { id: string }).id) : undefined
              return (
                <div key={`${f.name}:${n}`} className={`tfRow${f.live ? ' live' : ''}`}>
                  <button
                    type="button"
                    className="tfMain"
                    disabled={!f.open || (f.open.kind === 'project' && !checkoutId)}
                    onClick={() => open(f)}
                    title={f.open?.kind === 'file' ? `${f.open.path} — click to copy the path` : f.detail}
                  >
                    <span className="nm">{f.name}</span>
                    <span className="r">
                      {f.live && <span className="dot live" aria-label="being written" />}
                      {f.added !== undefined && (
                        <>
                          {f.added > 0 && <span className="add">+{f.added}</span>}
                          {f.removed ? <span className="del">−{f.removed}</span> : null}
                          {f.status === 'added' && !f.added && <span className="k">new</span>}
                          {f.status === 'deleted' && <span className="del">deleted</span>}
                        </>
                      )}
                      {f.badge && <span className="k">{f.badge}</span>}
                    </span>
                  </button>
                  <div className="tfMeta">
                    {f.runs.length > 0 && f.group === 'changed' ? null : f.detail && <span className="tag">{f.detail}</span>}
                    {f.writer && <span>{f.writer}</span>}
                    {f.readers.length > 0 && <span>read by {f.readers.length > 3 ? `${f.readers.length} members` : f.readers.join(', ')}</span>}
                    {f.runs.map((id) => {
                      const sid = sessionOf(id)
                      const r = rows.find((x) => x.run.id === id)
                      return (
                        <button key={id} type="button" className="tfLink" disabled={!sid} onClick={(e) => sid && onOpenRun(sid, id, newTab(e))}>
                          {f.group === 'changed' ? `by ${r ? r.tag : id}${f.live ? ' · in progress' : ''}` : `open ${r ? r.tag : 'run'}`}
                        </button>
                      )
                    })}
                  </div>
                  {h && openHandoff === h.id && <pre className="hoText tfHandoff">{h.body || h.summary}</pre>}
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
