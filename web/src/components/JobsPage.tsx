/**
 * Jobs, as a table: one row per job, switch, name, the integrations it
 * may use and its project, schedule, last run (with failure streaks, catch-ups
 * and config errors), next run, the last seven outcomes, tokens this week. Active /
 * Paused / All tabs, a filter, and Add job. Runs live on each job, not on
 * this page; the dots are the only history shown here.
 */
import * as Switch from '@radix-ui/react-switch'
import { Ellipsis, Pencil, Play, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActivityResponse, ActivityRun, Project, ProjectsResponse, SettingsResponse, Job, JobsResponse } from '../../../shared/protocol.js'
import { rowOpen } from '../tabs.js'
import { nextScheduled } from '../../../core/job/cron.js'
import { relTime } from '../itemUi.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'
import { cronText, fmtUntil, grantIcon, grantLabel, runStatusText } from '../jobUi.js'

/** "5m ago", "3d ago", or a plain date past two weeks, where "ago" would read wrong. */
export const ago = (at: number): string => {
  const r = relTime(at)
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r
}

/** The dot colour for one run outcome. */
export const runDotClass = (status: string | undefined): string =>
  !status ? 'blue' : status === 'ok' ? 'green' : status === 'failed' || status === 'timeout' ? 'red' : status === 'interrupted' || status === 'slept' ? 'yellow' : 'stone'

/** When the job runs next, as the due rule sees it. */
export function nextRunText(w: Job, now = Date.now()): string {
  if (!w.enabled) return '—'
  if (w.configError) return 'blocked'
  if (w.lastRunStartedAt == null) return 'now'
  const next = nextScheduled(w.schedule, w.lastRunStartedAt)
  if (next == null) return '—'
  return next <= now ? 'due now' : fmtUntil(next, now)
}

type Tab = 'active' | 'paused' | 'all'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'all', label: 'All' },
]

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; jobs: Job[] }
  | { phase: 'error'; message: string }

const WEEK_MS = 7 * 86_400_000

const fmtTokens = (n: number) => (n === 0 ? '0' : n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)

export function JobsPage({
  onNavigate,
  onAddJob,
  onPin,
}: {
  onNavigate: (hash: string) => void
  /** "Add job": a chat with Junior, not a form. */
  onAddJob: () => void
  /** Keep a job in the band without leaving the list (⌘-click, middle-click). */
  onPin: (id: string, title: string) => void
}) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [runs, setRuns] = useState<ActivityRun[]>([])
  const [tab, setTab] = useState<Tab>('active')
  const [filter, setFilter] = useState('')
  const [running, setRunning] = useState<Set<string>>(new Set())
  // The global switch (Settings → Automations). Off = the scheduler never runs a job.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => setProjects(b.ok ? b.projects : []))
      .catch(() => {})
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => setEnabled(b.ok ? b.settings.jobsEnabled : null))
      .catch(() => setEnabled(null))
  }, [])

  const load = useCallback(async () => {
    try {
      const [wr, ar] = await Promise.all([fetch('/api/jobs'), fetch('/api/activity')])
      const body = (await wr.json()) as JobsResponse
      if (body.ok) setState({ phase: 'ready', jobs: body.jobs })
      else setState({ phase: 'error', message: body.error })
      const act = (await ar.json()) as ActivityResponse
      if (act.ok) setRuns(act.runs)
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Per job: the last seven outcomes (oldest first) and tokens spent this week.
  const history = useMemo(() => {
    const byJob = new Map<string, { dots: ActivityRun[]; tokens: number }>()
    const since = Date.now() - WEEK_MS
    for (const r of runs) {
      if (!r.jobId) continue
      const h = byJob.get(r.jobId) ?? { dots: [], tokens: 0 }
      if (h.dots.length < 7) h.dots.push(r)
      if (r.startedAt >= since) h.tokens += r.tokens ?? 0
      byJob.set(r.jobId, h)
    }
    for (const h of byJob.values()) h.dots.reverse()
    return byJob
  }, [runs])

  async function toggle(w: Job, on: boolean) {
    await fetch(`/api/jobs?id=${encodeURIComponent(w.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: on }),
    })
    void load()
  }

  async function remove(w: Job) {
    if (!confirm(`Delete job “${w.title}”? Its open items move to Archived (nothing is deleted).`)) return
    await fetch(`/api/jobs?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
    void load()
  }

  // Force-run one job now (independent of its cadence). The run is a session;
  // we refresh a few times so the row reflects its outcome when it lands.
  async function run(w: Job) {
    setRunning((prev) => new Set(prev).add(w.id))
    try {
      const res = await fetch(`/api/jobs/run?id=${encodeURIComponent(w.id)}`, { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) alert(body.error ?? 'could not start the run')
    } catch (err) {
      alert(String(err))
    }
    for (const ms of [5000, 12000, 30000]) setTimeout(() => void load(), ms)
    setTimeout(
      () =>
        setRunning((prev) => {
          const next = new Set(prev)
          next.delete(w.id)
          return next
        }),
      12000,
    )
  }

  const all = state.phase === 'ready' ? state.jobs : []
  const counts = { active: all.filter((w) => w.enabled).length, paused: all.filter((w) => !w.enabled).length, all: all.length }
  const q = filter.trim().toLowerCase()
  const rows = all
    .filter((w) => (tab === 'all' ? true : tab === 'active' ? w.enabled : !w.enabled))
    .filter((w) => !q || w.title.toLowerCase().includes(q) || w.instruction.toLowerCase().includes(q))

  const edit = (w: Job) => onNavigate(`/jobs/${encodeURIComponent(w.id)}/edit`)
  const open = (w: Job) => onNavigate(`/jobs/${encodeURIComponent(w.id)}`)

  return (
    <div id="jobsPage" className="page full">
      <div className="glow yellow" aria-hidden="true" />
      <div className="inner">
        <div className="jobHead">
          <h1 className="display">Jobs</h1>
          <div className="seg" role="tablist" aria-label="Show">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`segBtn${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
                <span className="n">{counts[t.id]}</span>
              </button>
            ))}
          </div>
          <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter jobs…" aria-label="Filter jobs" />
          <button type="button" className="btn primary" onClick={onAddJob}>
            <Plus size={13} aria-hidden="true" /> Add job
          </button>
        </div>

        {enabled === false && (
          <div className="notice jobsOff">
            Scheduled runs are <b>off</b> for this workspace. Jobs stay editable and “Run now” still works, but nothing runs on its own.{' '}
            <a href="#/settings/babysit">Turn jobs on in Settings → Automations</a>.
          </div>
        )}

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> Loading jobs…
          </div>
        )}
        {state.phase === 'error' && <div className="msg error">{state.message}</div>}

        {state.phase === 'ready' && (
          <div className="wtblWrap">
            {rows.length === 0 ? (
              <div className="wtblEmpty">
                {all.length === 0 ? (
                  <>
                    <span>No jobs yet. Tell Junior what to keep doing for you — it asks what it needs and drafts the job.</span>
                    <button type="button" className="btn" onClick={onAddJob}>
                      <Plus size={13} aria-hidden="true" /> Add your first job
                    </button>
                  </>
                ) : (
                  <span>Nothing {tab === 'all' ? 'matches' : tab} here.</span>
                )}
              </div>
            ) : (
              <table className="wtbl">
                <thead>
                  <tr>
                    <th aria-label="On" />
                    <th>Job</th>
                    <th>Uses</th>
                    <th>Schedule</th>
                    <th>Last run</th>
                    <th>Next</th>
                    <th>Last 7</th>
                    <th className="r">Tokens 7d</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => {
                    const h = history.get(w.id)
                    const failed = w.lastRunStatus === 'failed' || w.lastRunStatus === 'timeout' || Boolean(w.configError)
                    const project = projects.find((p) => p.id === w.projectId)
                    return (
                      <tr key={w.id} className={w.enabled ? undefined : 'off'}>
                        <td className="sw">
                          <Switch.Root className="uiSwitch" checked={w.enabled} onCheckedChange={(on) => void toggle(w, on)} aria-label={w.enabled ? `Pause ${w.title}` : `Resume ${w.title}`}>
                            <Switch.Thumb className="uiSwitchThumb" />
                          </Switch.Root>
                        </td>
                        <td className="nm">
                          <button
                            type="button"
                            className="t"
                            title={w.instruction}
                            {...rowOpen(
                              () => open(w),
                              () => onPin(w.id, w.title),
                            )}
                          >
                            {w.title}
                          </button>
                          {w.draft && !w.enabled && (
                            <span className="draftTag" title="Drafted from a chat — open it to review and enable">
                              draft
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="uses">
                            {w.tools.map((g) => {
                              const Icon = grantIcon(g)
                              return (
                                <span key={grantLabel(g)} className="u" title={`${grantLabel(g)} · ${g.tools.length} tool${g.tools.length === 1 ? '' : 's'}`}>
                                  <Icon size={11} aria-hidden="true" />
                                </span>
                              )
                            })}
                            {project && (
                              <span className="u proj" title={project.path}>
                                {project.name}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="mono">{cronText(w.schedule)}</td>
                        <td>
                          <span className={`mono${failed ? ' bad' : ''}`} title={w.configError ?? w.lastRunError ?? undefined}>
                            {w.configError
                              ? 'config error'
                              : w.lastRunAt == null
                                ? 'never'
                                : `${ago(w.lastRunAt)} · ${!w.enabled ? 'paused' : running.has(w.id) ? 'running' : runStatusText(w.lastRunStatus, w.lastRunTrigger, w.consecutiveFailures)}`}
                          </span>
                        </td>
                        <td className="mono">{nextRunText(w)}</td>
                        <td>
                          <span className="runDots" aria-label="Last seven runs">
                            {Array.from({ length: 7 }, (_, i) => {
                              const r = h?.dots[i]
                              const cls = !r ? 'none' : runDotClass(r.status)
                              return (
                                <span
                                  key={i}
                                  className={`dot ${cls}`}
                                  title={
                                    r
                                      ? `${ago(r.startedAt)} · ${r.status ?? 'running'}${r.trigger && r.trigger !== 'scheduled' ? ` (${r.trigger.replace('_', '-')})` : ''}${r.newCount != null ? ` · ${r.newCount} new` : r.matches != null ? ` · ${r.matches} filed` : ''}${r.error ? ` · ${r.error}` : ''}`
                                      : undefined
                                  }
                                />
                              )
                            })}
                          </span>
                        </td>
                        <td className="r mono">{fmtTokens(h?.tokens ?? 0)}</td>
                        <td className="acts">
                          <div className="actRow">
                            <button type="button" className="iconBtn sm" title="Run now" disabled={running.has(w.id)} onClick={() => void run(w)}>
                              <Play size={13} aria-hidden="true" />
                            </button>
                            <button type="button" className="iconBtn sm" title="Edit" onClick={() => edit(w)}>
                              <Pencil size={13} aria-hidden="true" />
                            </button>
                            <Menu>
                              <MenuTrigger asChild>
                                <button type="button" className="iconBtn sm" title="More" aria-label={`More actions for ${w.title}`}>
                                  <Ellipsis size={13} aria-hidden="true" />
                                </button>
                              </MenuTrigger>
                              <MenuContent align="end">
                                {w.lastRunSessionId && <MenuItem onSelect={() => onNavigate(`/${w.lastRunSessionId}`)}>Open last run</MenuItem>}
                                <MenuItem onSelect={() => void toggle(w, !w.enabled)}>{w.enabled ? 'Pause' : 'Resume'}</MenuItem>
                                <MenuItem className="danger" onSelect={() => void remove(w)}>
                                  Delete…
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {state.phase === 'ready' && all.length > 0 && (
          <div className="wtblFoot">
            <span className="mono">{enabled === false ? 'scheduler off' : 'scheduler on'}</span>
            <span style={{ marginLeft: 'auto' }}>Open a job to see its runs and what it filed.</span>
          </div>
        )}
      </div>
    </div>
  )
}
