/**
 * Onboarding as Junior's first message (.docs/overnight-2026-10-24/designs/
 * onboarding-message.md): on a workspace with no projects, one Junior message
 * says what it can see on this Mac (chips), offers what it would set up
 * (rows pre-ticked to the suggested answers, from firstRunOffers), and one
 * button applies the ticked rows through the existing ops (applyOffers in
 * core/junior/onboarding.ts). Nothing changes until that button.
 */
import * as Checkbox from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectorsResponse, JobsResponse, ProjectSuggestionsResponse, ProjectsResponse, SettingsResponse } from '../../../shared/protocol.js'
import type { Connector, Job } from '../../../shared/protocol.js'
import type { ProjectSuggestion } from '../../../core/junior/project-rank.js'
import type { BabysitSettings } from '../../../core/babysit/settings.js'
import { firstRunOffers, starterFor } from '../../../core/junior/offers.js'
import { applyOffers, defaultPicks, jobToolLines, NEEDS_PROJECT, onboardRows, replyLine, rowVerb, type ApplyResult, type OnboardApi, type OnboardRow, type RowState } from '../../../core/junior/onboarding.js'
import { mcpGrants } from '../../../core/job/tools.js'
import { usePersona } from '../junior.js'
import { inboxStore } from '../inboxStore.js'
import { Tooltip } from '../ui/Tooltip.js'
import { JuniorFace } from './JuniorFace.js'

type Ok<T> = Extract<T, { ok: true }>

async function getJson<T extends { ok: boolean }>(url: string, init?: RequestInit): Promise<Ok<T>> {
  const r = await fetch(url, init)
  const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as T | { ok: false; error: string }
  if (!b.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`)
  return b as Ok<T>
}

const send = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Junior's own servers: never a chip. */
const OWN = /^(junior|junior-dev|browser|team|triage|triage-dev)$/i

/** What the message reads, each landing on its own so chips fill in. */
type Seen = {
  connectors: Connector[] | null
  suggestions: ProjectSuggestion[] | null
  settings: { babysit: boolean; review: boolean } | null
  caps: BabysitSettings['budget'] | null
  jobs: Job[] | null
}
const NONE: Seen = { connectors: null, suggestions: null, settings: null, caps: null, jobs: null }

function useSeen(): { seen: Seen; error: string | null; retry: () => void } {
  const [seen, setSeen] = useState<Seen>(NONE)
  const [error, setError] = useState<string | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    setSeen(NONE)
    setError(null)
    const land = <K extends keyof Seen>(k: K, p: Promise<Seen[K]>) =>
      p.then(
        (v) => live && setSeen((s) => ({ ...s, [k]: v })),
        (err: unknown) => live && setError((e) => e ?? (err instanceof Error ? err.message : String(err))),
      )
    void land('connectors', getJson<ConnectorsResponse>('/api/connectors').then((b) => b.connectors))
    void land('suggestions', getJson<ProjectSuggestionsResponse>('/api/projects/suggestions').then((b) => b.suggestions))
    void land('settings', getJson<SettingsResponse>('/api/settings').then((b) => ({ babysit: b.settings.babysitEnabled, review: b.settings.reviewsEnabled })))
    void land('caps', getJson<{ ok: true; settings: BabysitSettings } | { ok: false; error: string }>('/api/babysit/settings').then((b) => b.settings.budget))
    void land('jobs', getJson<JobsResponse>('/api/jobs').then((b) => b.jobs))
    return () => {
      live = false
    }
  }, [n])
  return { seen, error, retry: () => setN((x) => x + 1) }
}

/** The ops, over the HTTP API every other screen uses. */
function httpApi(connectors: readonly Connector[]): OnboardApi {
  return {
    async addProject(p) {
      const b = await getJson<ProjectsResponse>('/api/projects', send('POST', p))
      const made = b.projects.find((x) => x.path === p.path) ?? b.projects.find((x) => x.name === p.name)
      if (!made) throw new Error('the project didn’t show up')
      return { id: made.id }
    },
    async turnOnWatch(watch) {
      await getJson<SettingsResponse>('/api/settings', send('PUT', watch === 'babysit' ? { babysitEnabled: true } : { reviewsEnabled: true }))
    },
    async listJobs() {
      return (await getJson<JobsResponse>('/api/jobs')).jobs
    },
    async enableJob(id) {
      await getJson<JobsResponse>(`/api/jobs?id=${encodeURIComponent(id)}`, send('PUT', { enabled: true }))
    },
    async draftJob(d) {
      await getJson<{ ok: true } | { ok: false; error: string }>('/api/jobs/drafted', send('POST', d))
    },
    toolsFor(server) {
      return jobToolLines(server, connectors.find((c) => c.server === server)?.tools ?? [])
    },
  }
}

/** A folder as the row shows it: the home folder as ~. */
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')

type Props = {
  /** who gh is signed in as (day.seen.github) */
  github: string | null
  /** everything worked: refetch the day, and the normal page takes over */
  onDone: () => void
  /** Skip for now: the old first-open block, for this session */
  onSkip: () => void
  onNavigate: (hash: string) => void
}

export function JuniorOnboarding({ github, onDone, onSkip, onNavigate }: Props) {
  const persona = usePersona()
  const { seen, error, retry } = useSeen()
  const ready = !!(seen.connectors && seen.suggestions && seen.settings && seen.caps && seen.jobs)

  const rows = useMemo(() => {
    if (!ready) return null
    const offers = firstRunOffers({
      ghLogin: github,
      connectors: seen.connectors!,
      suggestions: seen.suggestions!,
      watches: seen.settings!,
      caps: { perDayUsd: seen.caps!.perDayUsd, perReviewUsd: seen.caps!.perReviewUsd },
      jobs: seen.jobs!.map((j) => ({ enabled: j.enabled, servers: mcpGrants(j.tools ?? []).map((g) => g.source.server) })),
    })
    return onboardRows(offers)
  }, [ready, github, seen])

  const [picks, setPicks] = useState<Set<string>>(new Set())
  const [states, setStates] = useState<Record<string, { state: RowState; error?: string }>>({})
  const [running, setRunning] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const project = useRef<string | null>(null)
  const results = useRef<ApplyResult['rows']>({})
  useEffect(() => {
    if (rows) setPicks(defaultPicks(rows))
  }, [rows])

  const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(doneTimer.current), [])

  const projectRows = rows?.filter((r) => r.kind === 'project') ?? []
  const hasProject = project.current !== null || projectRows.some((r) => picks.has(r.key))
  const blocked = (r: OnboardRow) => r.kind === 'job' && !hasProject
  const stateOf = (r: OnboardRow): RowState => states[r.key]?.state ?? 'idle'
  // what the button runs: ticked, not done, not waiting on a project
  const todo = (rows ?? []).filter((r) => picks.has(r.key) && stateOf(r) !== 'done' && !blocked(r))
  const anyFailed = (rows ?? []).some((r) => stateOf(r) === 'fail')

  const toggle = (key: string, on: boolean) =>
    setPicks((p) => {
      const next = new Set(p)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const apply = async () => {
    if (!rows || !seen.connectors || running || !todo.length) return
    setRunning(true)
    setReply(null)
    const run = new Set(todo.map((r) => r.key))
    const res: ApplyResult = await applyOffers(rows, run, httpApi(seen.connectors), {
      project: project.current,
      onRow: (key, state, err) => setStates((s) => ({ ...s, [key]: err ? { state, error: err } : { state } })),
    })
    project.current = res.project
    setRunning(false)
    // the reply speaks for every row applied so far, this pass and the ones before
    results.current = { ...results.current, ...res.rows }
    const all: ApplyResult = { project: res.project, rows: results.current }
    setReply(replyLine(rows, all))
    void inboxStore.refreshAfterChange()
    if (!Object.values(all.rows).some((v) => v.state === 'fail')) doneTimer.current = setTimeout(onDone, 1800)
  }

  const ticked = projectRows.filter((r) => picks.has(r.key)).length
  const groups: Array<{ id: string; head: string; rows: OnboardRow[] }> = rows
    ? [
        { id: 'projects', head: 'Projects', rows: projectRows },
        { id: 'prs', head: 'Pull requests', rows: rows.filter((r) => r.kind === 'watch') },
        { id: 'sources', head: 'Sources', rows: rows.filter((r) => r.kind === 'job') },
      ].filter((g) => g.rows.length > 0)
    : []

  const label = running ? 'Setting up…' : todo.length === 0 ? 'Nothing ticked' : anyFailed ? `Try again (${todo.length})` : `Set up ${todo.length}`

  return (
    <section className="jbMsg" aria-label={`${persona.name}'s first message`}>
      <div className="jbWho">
        <JuniorFace mood="hello" size={24} motion="still" decorative />
        <b>{persona.name}</b>
      </div>
      <div className="jbBody">
        {error ? (
          <p className="jbLine err" role="alert">
            I couldn't look around this Mac. {error}{' '}
            <button type="button" className="jrRef" onClick={retry}>
              Try again
            </button>
          </p>
        ) : (
          <p className="jbLine">{ready ? 'Here’s what I can see on this Mac.' : 'Looking around this Mac…'}</p>
        )}
        <Chips github={github} seen={seen} />

        {!ready && !error && (
          <div className="jbSkel" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        )}

        {rows && rows.length === 0 && (
          <>
            <p className="jbLine">I can't see much yet. Add a project folder, and I'll start there.</p>
            <div className="jbFoot">
              <button type="button" className="btn primary" onClick={() => onNavigate('/settings/projects')}>
                Add a project
              </button>
            </div>
          </>
        )}

        {rows && rows.length > 0 && (
          <>
            <p className="jbLine">Here’s what I’d set up. Untick anything you don’t want.</p>
            {groups.map((g) => (
              <div key={g.id} className="jbGroup" role="group" aria-label={g.head}>
                <div className="jbHead">
                  {g.id === 'projects' ? (
                    <label className="jbHeadPick">
                      <Checkbox.Root
                        className="cbox"
                        disabled={running}
                        checked={ticked === 0 ? false : ticked === g.rows.length ? true : 'indeterminate'}
                        onCheckedChange={(v) =>
                          setPicks((p) => {
                            const next = new Set(p)
                            for (const r of g.rows) if (stateOf(r) !== 'done') (v === true ? next.add(r.key) : next.delete(r.key))
                            return next
                          })
                        }
                      >
                        <Checkbox.Indicator>{ticked === g.rows.length ? <Check size={11} aria-hidden="true" /> : <Minus size={11} aria-hidden="true" />}</Checkbox.Indicator>
                      </Checkbox.Root>
                      {g.head}
                    </label>
                  ) : (
                    <span>{g.head}</span>
                  )}
                  {g.id === 'projects' && <span className="n">{`${ticked} of ${g.rows.length}`}</span>}
                </div>
                {g.rows.map((r) => (
                  <Row key={r.key} row={r} on={picks.has(r.key)} state={stateOf(r)} error={states[r.key]?.error} blocked={blocked(r)} disabled={running} onToggle={(v) => toggle(r.key, v)} />
                ))}
              </div>
            ))}
            {reply && (
              <p className={`jbLine jbReply${anyFailed ? ' part' : ''}`} role="status">
                {reply}
              </p>
            )}
            <div className="jbFoot">
              <button type="button" className="btn primary" disabled={running || todo.length === 0 || (!!reply && !anyFailed)} onClick={() => void apply()}>
                {label}
              </button>
              <button type="button" className="jrRef jbSkip" disabled={running} onClick={onSkip}>
                Skip for now
              </button>
              <span className="jbNote">Nothing changes until you press this.</span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/** What Junior can see: gh, the connected sources, the repos it found. */
function Chips({ github, seen }: { github: string | null; seen: Seen }) {
  const on = (seen.connectors ?? []).filter((c) => c.status === 'connected' && !OWN.test(c.server) && !OWN.test(c.name))
  const shown = on.slice(0, 4)
  const more = on.length - shown.length
  const repos = seen.suggestions?.length ?? 0
  return (
    <ul className="jbChips" aria-label="What I can see">
      {github ? (
        <li>
          <i />
          GitHub as {github}
        </li>
      ) : (
        <li className="off">
          <i />
          GitHub not signed in <code>gh auth login</code>
        </li>
      )}
      {shown.map((c) => (
        <li key={c.server}>
          <i />
          {c.name}
        </li>
      ))}
      {repos > 0 && (
        <li>
          <i />
          {repos} {repos === 1 ? 'repo' : 'repos'} with Claude Code
        </li>
      )}
      {more > 0 && <li className="more">+{more} more</li>}
    </ul>
  )
}

function Row({
  row,
  on,
  state,
  error,
  blocked,
  disabled,
  onToggle,
}: {
  row: OnboardRow
  on: boolean
  state: RowState
  error?: string
  blocked: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  const done = state === 'done'
  const meta = row.kind === 'project' ? row.why : row.kind === 'job' ? (blocked ? NEEDS_PROJECT : row.name) : ''
  const verb = rowVerb(row.kind === 'job' ? { kind: 'job', ...(row.library ? { library: row.library } : {}) } : row, state)
  const line =
    row.kind === 'project' ? (
      <span className="ln">
        {row.name} <span className="path">{tilde(row.path)}</span>
      </span>
    ) : (
      <span className="ln">{row.line}</span>
    )
  const tip = row.kind === 'job' ? `${row.instruction} Runs ${starterFor(row.name).when}.` : null
  const stateEl = (
    <span className={`st ${state}`}>
      {done && <Check size={12} aria-hidden="true" />}
      {verb}
    </span>
  )
  return (
    <label className={`jbRow${blocked ? ' blocked' : ''}${done ? ' done' : ''}`}>
      <Checkbox.Root className="cbox" checked={on && !blocked} disabled={disabled || done || blocked} onCheckedChange={(v) => onToggle(v === true)}>
        <Checkbox.Indicator>
          <Check size={11} aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      {tip ? (
        <Tooltip content={tip}>
          <span className="lnWrap">{line}</span>
        </Tooltip>
      ) : (
        line
      )}
      <span className="meta">{meta}</span>
      {state === 'fail' && error ? (
        <Tooltip content={error} align="end">
          {stateEl}
        </Tooltip>
      ) : (
        stateEl
      )}
    </label>
  )
}
