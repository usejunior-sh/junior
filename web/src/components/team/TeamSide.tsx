import * as Collapsible from '@radix-ui/react-collapsible'
import * as RadioGroup from '@radix-ui/react-radio-group'
import * as Tabs from '@radix-ui/react-tabs'
import { X, Plus, ChevronRight } from 'lucide-react'
import { type ReactNode, useState, useEffect } from 'react'
import type { TeamRunView, ModelOption, TeamCard, Slice, LedgerEntry, Handoff } from '../../../../shared/protocol.js'
import { leadSlices } from '../../../../core/teams/engine.js'
import { type TeamPermissions, TEAM_PERMISSIONS } from '../../../../core/teams/recipe.js'
import { runFileHash } from '../RunFolderPage.js'
import { GoalSide } from '../TeamGoal.js'
import { findModel } from '../../models.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { teamsCall, usd, PERMISSION_META } from '../../teams.js'
import { Mark, call, errText, who, widthOf, wireCard } from './shared.js'
import { EditList, Editable, TeamFastToggle } from './TeamEditors.js'

export type TeamSideTab = 'runs' | 'files' | 'run'

export function TeamSide({
  run,
  lead,
  models,
  onClose,
  onNavigate,
  runs,
  runsTools,
  files,
  tab: tabIn,
  onTab,
}: {
  run: TeamRunView
  /** only the lead's session edits and approves */
  lead: boolean
  models: ModelOption[]
  onClose: () => void
  onNavigate: (to: string) => void
  /** the team's runs (TeamRuns) and Files panel (TeamFiles): with them, the drawer has tabs */
  runs?: ReactNode
  /** shown at the end of the tab row while Runs is open (RunsViewToggle) */
  runsTools?: ReactNode
  files?: ReactNode
  tab: TeamSideTab
  onTab: (tab: TeamSideTab) => void
}) {
  const tabbed = !!(runs && files)
  const tab = tabbed ? tabIn : 'run'
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [saveName, setSaveName] = useState<string | null>(null)
  const [allHandoffs, setAllHandoffs] = useState(false)
  // What you just saved, shown until the server's copy comes back, so an edit never flickers back.
  const [pending, setPending] = useState<TeamCard | null>(null)
  useEffect(() => setPending(null), [run.rev])
  const card = pending ?? run.card
  const editable = lead && run.state === 'proposed'
  // Running, the plan stays yours to steer: tasks not yet started, and the decisions.
  const steerable = lead && run.state !== 'done' && run.state !== 'stopped'
  const savePlan = (patch: { tasks?: TeamCard['tasks']; decisions?: string[] }) => {
    if (editable) return save(patch)
    setPending({ ...card, ...patch })
    setError(null)
    teamsCall('PUT', 'plan', { runId: run.id, ...patch }).catch((err) => {
      setPending(null)
      setError(errText(err))
    })
  }
  const taskEditable = (id: string) => steerable && (run.state === 'proposed' || (run.tasks[id]?.status ?? 'todo') === 'todo')

  const save = (patch: Partial<TeamCard>) => {
    const next = { ...card, ...patch }
    setPending(next)
    setError(null)
    teamsCall('PUT', 'card', { runId: run.id, card: wireCard(next) }).catch((err) => {
      setPending(null)
      setError(errText(err))
    })
  }
  const saveStep = (id: string, patch: Partial<TeamCard['steps'][number]>) => save({ steps: card.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const saveSlice = (id: string, slices: Slice[], n: number, patch: Partial<Slice>) =>
    saveStep(id, { slices: slices.map((x, k) => (k === n ? { ...x, ...patch } : x)).filter((x) => x.title) })
  const act = (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setError(null)
    fn()
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(null))
  }
  const saveAs = () => saveName?.trim() && act('save', () => call('save-as', { runId: run.id, label: saveName }).then(() => setSaveName(null)))
  const at = run.state === 'done' ? run.recipe.steps.length : run.step
  const handoffs = allHandoffs ? run.outputs : run.outputs.slice(-6)

  return (
    <aside className="teamSide" aria-label="Team run details">
      <header className="tsHead">
        <span className="t">{run.goal ? 'Goal' : 'Team'} · {run.recipe.label}</span>
        <span className="k">{run.team ? `teams/${run.team}.md` : 'drafted for this run'}</span>
        <span className="sp" />
        <button type="button" className="btn xs ghost" onClick={() => onNavigate(runFileHash(run.id))} title="The run folder: plan, ledger, reviews and every handoff">
          Open plan
        </button>
        <button type="button" className="iconBtn" aria-label="Close details" title="Close (the card stays above the composer)" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {tabbed && (
        <Tabs.Root value={tab} onValueChange={(v) => onTab(v as TeamSideTab)} className="tsTabs">
          <Tabs.List className="tsTabList" aria-label="Run details">
            <Tabs.Trigger value="runs" className="tsTab">
              Runs
            </Tabs.Trigger>
            <Tabs.Trigger value="files" className="tsTab">
              Files
            </Tabs.Trigger>
            <Tabs.Trigger value="run" className="tsTab">
              Plan & steps
            </Tabs.Trigger>
          </Tabs.List>
          {tab === 'runs' && runsTools && (
            <>
              <span className="sp" />
              {runsTools}
            </>
          )}
        </Tabs.Root>
      )}
      {tab === 'runs' ? (
        <div className="tsBody">{runs}</div>
      ) : tab === 'files' ? (
        <div className="tsBody">{files}</div>
      ) : (
      <div className="tsBody">
        {card.note && <p className="tsNote">{card.note}</p>}

        <GoalSide run={run} editable={editable} onError={setError} />

        <section className="tsSec">
          <div className="tsK">{run.goal ? 'what the team does' : 'goal'}</div>
          <Editable value={card.goal} disabled={!editable} multiline onCommit={(v) => v && save({ goal: v })} />
        </section>
        <section className="tsSec">
          <div className="tsK">{run.goal ? 'acceptance criteria' : 'done when'}</div>
          <EditList items={card.criteria} disabled={!editable} add="add a check" onChange={(criteria) => criteria.length && save({ criteria })} />
        </section>
        <section className="tsSec">
          <div className="tsK">out of scope</div>
          {card.outOfScope.length || editable ? (
            <EditList items={card.outOfScope} disabled={!editable} add="add" onChange={(outOfScope) => save({ outOfScope })} />
          ) : (
            <div className="edText muted">nothing listed</div>
          )}
        </section>

        {(card.tasks.length > 0 || run.recipe.steps.some((s) => s.forEach)) && (
          <section className="tsSec">
            <div className="tsK">tasks{run.state !== 'proposed' ? ` · ${card.tasks.filter((t) => run.tasks[t.id]?.status === 'done').length} of ${card.tasks.length} done` : ''}</div>
            <ol className="tsTasks">
              {card.tasks.map((t) => {
                const st = run.tasks[t.id] ?? { status: 'todo', round: 0 }
                const can = taskEditable(t.id)
                const set = (patch: Partial<typeof t>) => savePlan({ tasks: card.tasks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) })
                return (
                  <li key={t.id} className={`tsTask ${st.status}`}>
                    <span className="tsMark" title={st.status}>
                      {st.status === 'done' ? '✓' : st.status === 'unresolved' ? '!' : st.status === 'running' ? '' : ''}
                      {st.status === 'running' && <span className="dot live" aria-hidden="true" />}
                    </span>
                    <div className="tsTaskMain">
                      <div className="tsTaskHead">
                        <span className="tsId mono">{t.id}</span>
                        <Editable value={t.title} disabled={!can} onCommit={(v) => v && set({ title: v })} />
                        {can && card.tasks.length > 1 && (
                          <button type="button" className="iconBtn edDel" aria-label={`Remove ${t.id}`} onClick={() => savePlan({ tasks: card.tasks.filter((x) => x.id !== t.id) })}>
                            <X size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      {(t.criteria.length > 0 || can) && <EditList items={t.criteria} disabled={!can} add="add a check" onChange={(criteria) => set({ criteria })} />}
                      {st.status === 'running' && st.round > 0 && <div className="tsMeta">fix round {st.round}</div>}
                      {st.status === 'unresolved' && st.why && <div className="tsMeta warn">{st.why}</div>}
                    </div>
                  </li>
                )
              })}
            </ol>
            {steerable && card.tasks.length < 8 && (
              <button type="button" className="edAdd" onClick={() => savePlan({ tasks: [...card.tasks, { id: '', title: `New task ${card.tasks.length + 1}`, criteria: [] }] })}>
                <Plus size={11} aria-hidden="true" /> add a task
              </button>
            )}
            {run.state !== 'proposed' && steerable && <div className="tsMeta">Changes land between tasks; a task that has started stays as it is.</div>}
          </section>
        )}

        {run.revision && (
          <section className="tsSec tsRevision">
            <div className="tsK">the lead proposes a change</div>
            <div className="edText">{run.revision.why}</div>
            <ol className="tsTasks">
              {run.revision.tasks.map((t) => (
                <li key={t.id} className="tsTask todo">
                  <span className="tsMark" />
                  <div className="tsTaskMain">
                    <div className="tsTaskHead">
                      <span className="tsId mono">{t.id}</span>
                      <span className="edText">{t.title}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {lead && (
              <div className="tsRevActs">
                <button type="button" className="btn sm ghost" onClick={() => act('revision', () => call('revision', { runId: run.id, accept: false }))}>
                  Turn down
                </button>
                <button type="button" className="btn sm" onClick={() => act('revision', () => call('revision', { runId: run.id, accept: true }))}>
                  Accept
                </button>
              </div>
            )}
          </section>
        )}

        {(card.decisions.length > 0 || steerable) && (
          <section className="tsSec">
            <div className="tsK">decisions · every agent reads these</div>
            <EditList items={card.decisions} disabled={!steerable} add="add a decision" onChange={(decisions) => savePlan({ decisions })} />
          </section>
        )}

        {run.ledger.length > 0 && (
          <section className="tsSec">
            <div className="tsK">ledger · what the team learned</div>
            {LEDGER_GROUPS.map(({ kind, label }) => {
              const xs = run.ledger.filter((e) => e.kind === kind)
              if (!xs.length) return null
              return (
                <div key={kind} className="tsLedger">
                  <div className="tsMeta">{label}</div>
                  <ul className="tsNotes">
                    {xs.slice(-12).map((n, i) => (
                      <li key={i}>
                        {n.task && <span className="tsId mono">{n.task}</span>} {n.text}
                        {n.why && <span className="muted"> — because {n.why}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </section>
        )}

        <section className="tsSec">
          <div className="tsK">steps</div>
          <ol className="tsSteps">
            {run.recipe.steps.map((s, i) => {
              const w = who(run, s.agent)
              const c = card.steps.find((x) => x.id === s.id) ?? { id: s.id, model: null, slices: null }
              const state = run.state === 'proposed' ? '' : i < at ? 'done' : i === at ? 'on' : 'todo'
              const own = s.agent === 'lead' || s.agent === 'checks' ? null : run.agents.find((a) => a.name === s.agent)?.model ?? null
              const fallback = s.model ?? own
              const sliceable = leadSlices(run.recipe, i)
              const slices = c.slices ?? []
              const workers = run.workers.filter((x) => x.stepId === s.id)
              return (
                <li key={s.id} className={`tsStep ${state}`}>
                  <span className="tsNode" aria-hidden="true">
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <div className="tsStepMain">
                    <div className="tsStepHead">
                      <span className="tsId mono">{s.forEach ? `↻ ${s.id}` : s.id}</span>
                      <Mark color={w.color} />
                      <span className="tsWho">{w.label}</span>
                      {widthOf(run, i) && <span className="tsMeta mono">{widthOf(run, i)}</span>}
                      {s.output && <span className="tsMeta mono">→ {s.output}</span>}
                    </div>
                    {s.does && <div className="tsDoes">{s.does}</div>}
                    {(s.onFail || s.gate) && (
                      <div className="tsMeta">
                        {s.onFail && `a failure goes back to ${s.onFail.backTo}, at most ${s.onFail.max}×`}
                        {s.onFail && s.gate && ' · '}
                        {s.gate && 'waits for you after'}
                      </div>
                    )}
                    {s.agent !== 'checks' &&
                      (editable ? (
                        <Select className="teamSel tsModel" aria-label={`Model for ${s.id}`} value={c.model ?? ''} onValueChange={(v) => saveStep(s.id, { model: v || null })}>
                          <SelectItem value="">{fallback ? `Default · ${findModel(models, fallback)?.name ?? fallback}` : s.agent === 'lead' ? 'Default · the lead’s own' : 'Default'}</SelectItem>
                          {models.map((m) => (
                            <SelectItem key={m.id} value={m.id} description={m.description}>
                              {m.name}
                            </SelectItem>
                          ))}
                        </Select>
                      ) : (
                        <div className="tsMeta mono">{findModel(models, c.model ?? fallback ?? '')?.name ?? c.model ?? fallback ?? 'default model'}</div>
                      ))}
                    {s.fanOut && sliceable && (editable || slices.length > 0) && (
                      <div className="tsSlices">
                        <div className="tsMeta">{slices.length ? `split by ${s.fanOut.by}` : `the lead splits by ${s.fanOut.by} when the step starts`}</div>
                        {slices.map((x, n) => (
                          <div key={n} className="tsSlice">
                            <div className="tsSliceText">
                              <Editable value={x.title} disabled={!editable} placeholder={s.fanOut!.by} onCommit={(v) => saveSlice(s.id, slices, n, { title: v })} />
                              <Editable value={x.brief} disabled={!editable} multiline placeholder="what this worker looks at" onCommit={(v) => saveSlice(s.id, slices, n, { brief: v })} />
                            </div>
                            {editable && (
                              <button type="button" className="iconBtn edDel" aria-label={`Remove ${x.title}`} onClick={() => saveStep(s.id, { slices: slices.length > 1 ? slices.filter((_, k) => k !== n) : null })}>
                                <X size={12} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        ))}
                        {editable && slices.length < s.fanOut.max && (
                          <button type="button" className="edAdd" onClick={() => saveStep(s.id, { slices: [...slices, { title: `${s.fanOut!.by} ${slices.length + 1}`, brief: '' }] })}>
                            <Plus size={11} aria-hidden="true" /> {s.fanOut.by}
                          </button>
                        )}
                      </div>
                    )}
                    {s.fanOut && !sliceable && <div className="tsMeta">{s.fanOut.by === 'finding' ? 'triage splits the findings' : `same slices as ${run.recipe.steps[i - 1]?.id}`}</div>}
                    {workers.length > 0 && run.state !== 'proposed' && (
                      <div className="tsWorkers">
                        {workers.map((x) => (
                          <button key={x.id} type="button" className="tsWorker" disabled={!x.sessionId} onClick={() => x.sessionId && onNavigate(x.sessionId)}>
                            {run.awaiting.includes(x.id) && <span className="dot live" aria-label="working" />}
                            {x.label}
                            {x.sessionId && run.spend[x.sessionId] ? <span className="mono">{usd(run.spend[x.sessionId])}</span> : null}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <section className="tsSec">
          <div className="tsK">budget</div>
          {editable ? (
            <div className="tsBudget">
              <span className="mono">$</span>
              <Editable value={String(card.budgetUsd)} mono onCommit={(v) => Number(v) > 0 && save({ budgetUsd: Number(v) })} />
              <span className="muted">cap · the run pauses there</span>
            </div>
          ) : (
            <div className="edText mono">
              {usd(run.spentUsd)} <span className="muted">of {usd(run.budgetUsd)}</span>
            </div>
          )}
        </section>

        <section className="tsSec">
          <div className="tsK">without asking</div>
          {editable ? (
            <RadioGroup.Root className="tsPerms" aria-label="What the team may do without asking" value={card.permissions ?? ''} onValueChange={(v) => save({ permissions: v as TeamPermissions })}>
              {TEAM_PERMISSIONS.map((p) => (
                <RadioGroup.Item key={p} value={p} className="tsPerm">
                  <span className="tsPermDot" aria-hidden="true" />
                  <span className="tsPermText">
                    <span className="l">{PERMISSION_META[p].label}</span>
                    <span className="h">{PERMISSION_META[p].hint}</span>
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          ) : (
            <div className="edText">{card.permissions ? PERMISSION_META[card.permissions].label : <span className="muted">not picked</span>}</div>
          )}
          {editable && !card.permissions && <div className="tsMeta warn">Pick one — the team can’t start until you do.</div>}
        </section>

        <section className="tsSec">
          <div className="tsK">speed</div>
          <div className="tsFast">
            <TeamFastToggle run={run} onError={setError} />
            <span className="muted">{run.card.fast ? 'every agent runs in fast mode — premium price' : 'standard speed for every agent'}</span>
          </div>
        </section>

        {run.unresolved && <div className="teamUnresolved">Unresolved: {run.unresolved}</div>}

        {run.outputs.length > 0 && (
          <section className="tsSec">
            <div className="tsK">handoffs · {run.outputs.length}</div>
            <ol className="hoList">
              {!allHandoffs && run.outputs.length > handoffs.length && (
                <li>
                  <button type="button" className="btn xs ghost" onClick={() => setAllHandoffs(true)}>
                    Show all {run.outputs.length}
                  </button>
                </li>
              )}
              {handoffs.map((h) => (
                <HandoffRow key={h.id} h={h} />
              ))}
            </ol>
          </section>
        )}
      </div>
      )}

      {error && (
        <div className="tdErr tsErr" role="alert">
          {error}
        </div>
      )}
      <footer className="tsFoot">
        {saveName === null ? (
          <button type="button" className="btn sm ghost" onClick={() => setSaveName(`${run.recipe.label} (custom)`)} title="Keep this shape — steps, models, widths, budget — as a new team file">
            Save as team
          </button>
        ) : (
          <span className="teamSaveInline">
            <input
              className="teamInp"
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAs()
                if (e.key === 'Escape') setSaveName(null)
              }}
              aria-label="New team's name"
            />
            <button type="button" className="btn sm" disabled={!saveName.trim() || !!busy} onClick={saveAs}>
              Save
            </button>
          </span>
        )}
        <span className="sp" />
        {editable && (
          <>
            <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => act('discard', () => call('discard', { runId: run.id }))}>
              Discard
            </button>
            <button type="button" className="btn primary sm" disabled={!!busy || !card.permissions} title={card.permissions ? undefined : 'Pick what the team may do without asking first'} onClick={() => act('approve', () => call('approve', { runId: run.id }))}>
              {busy === 'approve' ? 'Starting…' : 'Approve & run'}
            </button>
          </>
        )}
      </footer>
    </aside>
  )
}

const LEDGER_GROUPS: { kind: LedgerEntry['kind']; label: string }[] = [
  { kind: 'decision', label: 'decisions' },
  { kind: 'where', label: 'where things are' },
  { kind: 'surprise', label: 'surprises' },
  { kind: 'failed', label: 'tried, didn’t work' },
  { kind: 'verify', label: 'how to check' },
  { kind: 'note', label: 'notes' },
  { kind: 'resume', label: 'resumes' },
]

/** One handoff as one line; open it for the full text. */
function HandoffRow({ h }: { h: Handoff }) {
  const [open, setOpen] = useState(false)
  const full = h.body || h.findings?.length || h.files?.length || h.criteria?.length || h.unsure
  return (
    <li className="hoRow">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="hoLine" disabled={!full}>
          <ChevronRight size={12} className={`hoCaret${open ? ' on' : ''}${full ? '' : ' none'}`} aria-hidden="true" />
          <span className="hoStep mono">
            {h.stepId}
            {h.round ? ` · fix ${h.round}` : ''}
          </span>
          <span className="hoWho">{h.label}</span>
          {h.verdict && <span className={`hoVerdict ${h.verdict}`}>{h.verdict}</span>}
          <span className="hoSum">{h.summary}</span>
        </Collapsible.Trigger>
        <Collapsible.Content className="hoBody">
          {h.criteria?.length ? (
            <ul className="hoCriteria">
              {h.criteria.map((c) => (
                <li key={c.id} className={c.status.replace(' ', '-')}>
                  <span className="mono">{c.id}</span> <span className="st">{c.status}</span>
                  {c.evidence && <span className="ev"> — {c.evidence}</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {h.resolutions?.length ? (
            <ul className="hoCriteria">
              {h.resolutions.map((r) => (
                <li key={r.id} className={r.status}>
                  <span className="mono">{r.id}</span> <span className="st">{r.status}</span>
                  {r.note && <span className="ev"> — {r.note}</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {h.unsure && <div className="hoUnsure">Unsure: {h.unsure}</div>}
          {h.body && <pre className="hoText">{h.body}</pre>}
          {h.findings?.length ? (
            <ol className="hoFindings">
              {h.findings.map((f, i) => (
                <li key={i}>
                  {f.id && <span className="mono hoFid">{f.id}</span>} <span className={`hoSev ${f.severity}`}>{f.severity}</span> <span className="mono">{f.where}</span> — {f.problem}
                  <div className="hoFix">Fix: {f.fix}</div>
                </li>
              ))}
            </ol>
          ) : null}
          {h.files?.length ? <div className="hoFiles mono">{h.files.join(' · ')}</div> : null}
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  )
}
