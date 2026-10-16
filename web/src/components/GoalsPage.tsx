/**
 * Goals (.docs/goals/goals-engine.md): outcomes Junior drives across many
 * sessions. A dense table — title, state, whose turn, last touched, spend —
 * with Active / Finished tabs. Goals are made by talking to Junior (or
 * `triage goal create`), never from a form here.
 */
import { useMemo, useState } from 'react'
import { isTerminal } from '../../../core/goals/machine.js'
import { GOAL_STATE_LABEL } from '../../../core/goals/types.js'
import { TURN_LABEL } from '../../../core/work/flow.js'
import type { GoalSummary } from '../../../shared/protocol.js'
import { goalHash, useGoals } from '../goals.js'
import { ago } from '../itemUi.js'
import { rowOpen } from '../tabs.js'

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

export function GoalsPage({ onNavigate, onPin }: { onNavigate: (hash: string) => void; onPin: (id: string, title: string) => void }) {
  const { goals, loaded, error } = useGoals()
  const [tab, setTab] = useState<Tab>('active')
  const [filter, setFilter] = useState('')
  const counts = useMemo(() => {
    const finished = goals.filter((g) => isTerminal(g.state)).length
    return { active: goals.length - finished, finished }
  }, [goals])
  const q = filter.trim().toLowerCase()
  const rows = goals
    .filter((g) => (tab === 'finished') === isTerminal(g.state))
    .filter((g) => !q || g.title.toLowerCase().includes(q) || (g.reason ?? '').toLowerCase().includes(q))

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
                  <span>No goals yet. Tell Junior the outcome you want in any chat — it plans the work and keeps at it until it's done.</span>
                ) : (
                  <span>Nothing {q ? 'matches' : tab} here.</span>
                )}
              </div>
            ) : (
              <table className="wtbl">
                <thead>
                  <tr>
                    <th aria-label="State" />
                    <th>Goal</th>
                    <th>State</th>
                    <th>Turn</th>
                    <th>Updated</th>
                    <th className="r">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={g.id} className={isTerminal(g.state) ? 'off' : undefined}>
                      <td className="sw">
                        <span className={`dot ${goalDot(g)}`} aria-hidden="true" />
                      </td>
                      <td className="nm">
                        <button
                          type="button"
                          className="t"
                          title={g.reason ?? undefined}
                          {...rowOpen(
                            () => onNavigate(goalHash(g.id)),
                            () => onPin(g.id, g.title),
                          )}
                        >
                          {g.title}
                        </button>
                      </td>
                      <td>
                        {GOAL_STATE_LABEL[g.state]}
                        {g.currentStep && <span className="mono"> · {g.currentStep}</span>}
                        {g.openGates > 0 && <span className="mono"> · {g.openGates} gate{g.openGates === 1 ? '' : 's'}</span>}
                      </td>
                      <td>{TURN_LABEL[g.turn]}</td>
                      <td className="mono">{ago(g.updatedAt)}</td>
                      <td className="r mono">{spendText(g)}</td>
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
