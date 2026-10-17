/**
 * Goals (.docs/junior-goals-teams/modes-autonomy-goals.md): team runs with a
 * done-when, which Junior keeps going round after round until it judges the
 * done-when met. A dense table, goal, where it stands, due, last touched,
 * spend, with Active / Finished tabs. Goals are made by talking to Junior
 * ("Turn into a goal", or "New goal:" in any chat), never from a form here.
 *
 * goalDot / spendText / money still serve the old goals engine's page (GoalPage).
 */
import { useMemo, useState } from 'react'
import { horizonText } from '../../../core/teams/engine.js'
import type { GoalSummary, SessionSummary, TeamGoalSummary } from '../../../shared/protocol.js'
import { ago } from '../itemUi.js'
import { rowOpen } from '../tabs.js'
import { useTeamGoals, usd } from '../teams.js'
import { wakeText } from './TeamGoal.js'

type Tab = 'active' | 'finished'
const TABS: { id: Tab; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'finished', label: 'Finished' },
]

/** A goal's one colour: yours is yellow, Junior's pulses, the world's is blue. */
export function goalDot(g: Pick<GoalSummary, 'state' | 'turn'>): string {
  if (g.state === 'done') return 'green'
  if (g.state === 'cancelled' || g.state === 'paused') return 'stone'
  return g.turn === 'me' ? 'yellow' : g.turn === 'ai' ? 'live' : g.turn === 'others' ? 'blue' : 'stone'
}

export const money = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`

export function spendText(g: Pick<GoalSummary, 'spentUsd' | 'budget'>): string {
  return g.budget.usd != null ? `${money(g.spentUsd)} / ${money(g.budget.usd)}` : money(g.spentUsd)
}

const finished = (g: TeamGoalSummary) => g.state === 'stopped' || (g.state === 'done' && !!g.acceptedAt)

/** Where a goal stands, in a few words. The one thing to know about it now. */
function standing(g: TeamGoalSummary): string {
  const round = g.round ? ` · round ${g.round + 1}` : ''
  if (g.asks) return `Junior asks you ${g.asks === 1 ? 'a question' : `${g.asks} questions`}`
  switch (g.state) {
    case 'running':
      return g.owes === 'verdict' ? `Junior is checking the done-when${round}` : g.owes === 'unstick' ? `Stuck — Junior is getting it moving${round}` : `Working${round}`
    case 'gate':
      return 'A step waits for you'
    case 'waiting':
      return g.wait ? `Waiting for ${g.wait.for} · ${wakeText(g.wait.until)}` : 'Waiting on the world'
    case 'paused':
      return g.reason?.startsWith('budget') ? 'Budget reached — raise it to resume' : 'Paused'
    case 'done':
      return g.acceptedAt ? `Done${round}` : 'Junior says it’s done — accept it'
    case 'stopped':
      return 'Stopped'
    default:
      return g.state
  }
}

/** A goal's one colour: yours is yellow, Junior's pulses, the world's is blue. */
function teamGoalDot(g: TeamGoalSummary): string {
  if (g.state === 'done' && g.acceptedAt) return 'green'
  if (g.state === 'stopped') return 'stone'
  return g.turn === 'you' ? 'yellow' : g.turn === 'junior' ? 'live' : g.turn === 'world' ? 'blue' : 'stone'
}

export function GoalsPage({ sessions, onNavigate, onPin }: { sessions: readonly SessionSummary[]; onNavigate: (hash: string) => void; onPin: (key: string, title: string) => void }) {
  const { goals, loaded, error } = useTeamGoals(sessions)
  const [tab, setTab] = useState<Tab>('active')
  const [filter, setFilter] = useState('')
  const counts = useMemo(() => {
    const done = goals.filter(finished).length
    return { active: goals.length - done, finished: done }
  }, [goals])
  const q = filter.trim().toLowerCase()
  const rows = goals
    .filter((g) => (tab === 'finished') === finished(g))
    .filter((g) => !q || g.title.toLowerCase().includes(q) || g.doneWhen.toLowerCase().includes(q))

  return (
    <div id="goalsPage" className="page full">
      <div className="glow yellow" aria-hidden="true" />
      <div className="inner">
        <div className="jobHead">
          <h1 className="display">Goals</h1>
          <div className="seg" role="tablist" aria-label="Show">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`segBtn${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
                <span className="n">{counts[t.id]}</span>
              </button>
            ))}
          </div>
          <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter goals…" aria-label="Filter goals" />
        </div>

        {!loaded && (
          <div className="probing">
            <span className="pip" /> Loading goals…
          </div>
        )}
        {error && <div className="msg error">{error}</div>}

        {loaded && !error && (
          <div className="wtblWrap">
            {rows.length === 0 ? (
              <div className="wtblEmpty">
                {goals.length === 0 ? (
                  <span>No goals yet. Tell Junior the outcome you want in any chat, or turn an item into a goal — a team keeps at it, round after round, until it's done.</span>
                ) : (
                  <span>Nothing {q ? 'matches' : tab} here.</span>
                )}
              </div>
            ) : (
              <table className="wtbl goalsTbl">
                <thead>
                  <tr>
                    <th aria-label="Whose turn" />
                    <th>Goal</th>
                    <th>Where it stands</th>
                    <th>Due</th>
                    <th>Updated</th>
                    <th className="r">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={g.runId} className={finished(g) ? 'off' : undefined}>
                      <td className="sw">
                        <span className={`dot ${teamGoalDot(g)}`} aria-hidden="true" />
                      </td>
                      <td className="nm">
                        <button type="button" className="t" title={`Done when ${g.doneWhen}`} {...rowOpen(() => onNavigate(g.leadSessionId), () => onPin(g.leadSessionId, g.title))}>
                          {g.title}
                        </button>
                        <div className="sub">done when {g.doneWhen}</div>
                      </td>
                      <td>
                        {standing(g)}
                        {g.resumes > 0 && <span className="mono"> · {g.resumes} resume{g.resumes === 1 ? '' : 's'}</span>}
                      </td>
                      <td>
                        {horizonText(g.horizon)}
                        {g.overdue && <span className="pill yellow">overdue</span>}
                      </td>
                      <td className="mono">{ago(g.updatedAt)}</td>
                      <td className="r mono">
                        {usd(g.spentUsd)} <span className="of">/ {usd(g.budgetUsd)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
