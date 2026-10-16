/**
 * One goal: what it's for, where it stands, and its ledger — plan.md,
 * handoff.md and the latest log.md entries, read straight from the goal's
 * folder in the artifacts repo. Steps, gates and the event history sit in the
 * aside. A plan up for review gets the review box (M2): comment on a step or
 * the whole plan, send it back with the comments, or approve it. Once it runs
 * (M3), the steering box: message the lead, answer what it asked, take over
 * the worktree and hand it back, accept the result.
 */
import { useState } from 'react'
import { Check, Clock, Hand, MessageSquarePlus, Send, Undo2, X } from 'lucide-react'
import { GOAL_STATE_LABEL, type Goal, type GoalHorizon } from '../../../core/goals/types.js'
import type { PlanComment } from '../../../core/goals/review.js'
import { TURN_LABEL } from '../../../core/work/flow.js'
import type { GoalAsk, GoalEvent, GoalWriteResponse } from '../../../shared/protocol.js'
import { Select, SelectItem } from '../ui/Select.js'
import { useGoal } from '../goals.js'
import { itemHash } from '../hooks.js'
import { ago } from '../itemUi.js'
import { goalDot, spendText } from './GoalsPage.js'
import { Markdown } from './Markdown.js'

const HORIZON: Record<GoalHorizon, string> = { today: 'today', until_done: 'until done', ongoing: 'ongoing' }

/** plan.md without its machine-readable tail — the page shows the prose. */
const planProse = (md: string) => md.split(/\n## Plan data\n/)[0]!

function eventText(e: GoalEvent): string {
  if (e.kind === 'transition' && e.to) return `${e.from ? GOAL_STATE_LABEL[e.from] : '—'} → ${GOAL_STATE_LABEL[e.to]}`
  if (e.kind === 'created') return 'Created'
  return e.kind.replace(/_/g, ' ')
}

/**
 * The user's review of a proposed plan. Comments pile up against this plan
 * version; send back hands them all to the lead, approve starts the goal.
 * Every write names the version read, so a click never lands on a plan the
 * lead replaced in the meantime.
 */
function PlanReview({ goal, comments }: { goal: Goal; comments: PlanComment[] }) {
  const [stepId, setStepId] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const steps = goal.plan?.steps ?? []
  const typed = text.trim() ? { stepId: stepId || null, text: text.trim() } : null

  const post = async (verb: 'comment' | 'approve' | 'send-back', body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/goals/${encodeURIComponent(goal.id)}/${verb}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: goal.planVersion, ...body }),
      })
      const r = (await res.json()) as GoalWriteResponse
      if (!r.ok) throw new Error(r.error)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="secLabel">Your review</div>
      <div className="card goalReview">
        {comments.length > 0 && (
          <ul className="goalList goalComments">
            {comments.map((c) => (
              <li key={`${c.at}-${c.stepId}`}>
                <span className="mono">{c.stepId ?? 'plan'}</span>
                <span className="t">{c.text}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          value={text}
          rows={3}
          disabled={busy}
          placeholder="What should change, and why? Junior reads every comment when you send the plan back."
          aria-label="Comment on the plan"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="averbs">
          {steps.length > 0 && (
            <Select value={stepId} onValueChange={setStepId} aria-label="What the comment is on" className="goalReviewOn">
              <SelectItem value="">The whole plan</SelectItem>
              {steps.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.id} · {s.title}
                </SelectItem>
              ))}
            </Select>
          )}
          <button type="button" className="btn sm" disabled={busy || !typed} onClick={() => typed && void post('comment', typed)}>
            <MessageSquarePlus size={12} aria-hidden="true" /> Add comment
          </button>
          <span className="goalReviewGap" />
          <button
            type="button"
            className="btn sm"
            disabled={busy || (!typed && comments.length === 0)}
            title="Junior revises the plan against your comments and proposes it again"
            onClick={() => void post('send-back', typed ?? {})}
          >
            <Undo2 size={12} aria-hidden="true" /> Send back
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || !!typed}
            title={typed ? 'Add your comment or clear it first' : 'Start the goal on this plan'}
            onClick={() => void post('approve', {})}
          >
            <Check size={12} aria-hidden="true" /> Approve plan
          </button>
        </div>
        {error && <div className="astubErr">{error}</div>}
      </div>
    </section>
  )
}

/** POST one goal verb; the page re-reads on goals_changed. */
async function goalVerb(goalId: string, verb: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const r = (await res.json()) as GoalWriteResponse
  if (!r.ok) throw new Error(r.error)
}

const STEERABLE = new Set<Goal['state']>(['queued', 'running', 'waiting_world', 'waiting_you', 'result_ready', 'paused'])

const GATE_WHY = { approval: 'Approval', needs_user: "The checker can't tell", deadline: 'Past its deadline' } as const

/** "in 5m", "in 3h" — or "due" once the time has come. */
function inSpan(at: number | null): string {
  if (at == null) return '—'
  const s = Math.round((at - Date.now()) / 1000)
  if (s < 45) return 'due'
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `in ${Math.round(s / 3600)}h`
  return `in ${Math.round(s / 86400)}d`
}

/** What the goal waits on you for, in the words the lead used. */
function AskText({ ask }: { ask: GoalAsk }) {
  if (ask.kind === 'plan_change')
    return (
      <div className="goalAsk">
        <div className="t">Junior wants to change the plan: {ask.why}</div>
        <div className="artEmpty">The proposed plan has {ask.plan.steps.length} steps. Accept it to continue on it, or turn it down and say why.</div>
      </div>
    )
  if (ask.kind === 'ask')
    return (
      <div className="goalAsk">
        {ask.gate && <div className="artEmpty">{GATE_WHY[ask.gate.why]} · step {ask.gate.stepId}</div>}
        <div className="t">{ask.question}</div>
        <div className="artEmpty">Recommended: {ask.recommended}</div>
        {ask.evidence && <div className="artEmpty">{ask.evidence}</div>}
      </div>
    )
  return <div className="goalAsk t">{ask.reason}</div>
}

/**
 * Steering a goal that runs (decision 8): one box that says the right thing
 * for where the goal stands. A message wakes the lead; an answer settles what
 * it asked; take over pauses it and opens the worktree; hand back wakes the
 * lead to what you changed.
 */
function GoalSteer({ goal, ask }: { goal: Goal; ask: GoalAsk | null }) {
  const [text, setText] = useState('')
  const [usd, setUsd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typed = text.trim()

  const act = async (verb: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setError(null)
    try {
      await goalVerb(goal.id, verb, body)
      setText('')
      setUsd('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const waiting = goal.state === 'waiting_you'
  const paused = goal.state === 'paused'
  const result = goal.state === 'result_ready'
  const gate = waiting && ask?.kind === 'ask' ? ask.gate : null
  const placeholder = waiting
    ? gate
      ? 'A note for Junior with your answer (optional)'
      : ask?.kind === 'plan_change'
      ? 'Why, if you turn it down (optional when accepting)'
      : 'Your answer — Junior wakes with it'
    : result
      ? "What's missing? Sending this reopens the goal."
      : paused
        ? 'What you changed, for the lead (optional)'
        : 'A message to the lead — it reads it at its next wake'
  const budget = Number(usd)
  const raised = usd.trim() && Number.isFinite(budget) && budget > 0 ? { budgetUsd: budget } : {}

  return (
    <section>
      <div className="secLabel">{waiting ? 'Waiting on you' : result ? 'Result' : paused ? 'You have it' : 'Steer'}</div>
      <div className="card goalReview">
        {waiting && ask && <AskText ask={ask} />}
        {ask?.kind === 'ask' && ask.options.length > 0 && (
          <div className="averbs">
            {ask.options.map((o) => (
              <button key={o} type="button" className="btn sm" disabled={busy} onClick={() => void act('answer', { text: o })}>
                {o}
              </button>
            ))}
          </div>
        )}
        <textarea value={text} rows={3} disabled={busy} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setText(e.target.value)} />
        <div className="averbs">
          {waiting && ask?.kind === 'other' && (
            <input className="goalBudget mono" value={usd} disabled={busy} inputMode="decimal" placeholder="new budget, $" aria-label="Raise the budget to, in dollars" onChange={(e) => setUsd(e.target.value)} />
          )}
          {!paused && !result && (
            <button type="button" className="btn sm" disabled={busy} title="Pause the goal, stop its session and open its worktree in your editor" onClick={() => void act('take-over')}>
              <Hand size={12} aria-hidden="true" /> Take over
            </button>
          )}
          <span className="goalReviewGap" />
          {gate ? (
            <>
              <button type="button" className="btn sm" disabled={busy} title="The step failed; Junior wakes to decide what's next" onClick={() => void act('answer', { gate: 'reject', ...(typed ? { text: typed } : {}) })}>
                <X size={12} aria-hidden="true" /> Reject
              </button>
              {gate.evaluator !== 'user' && (
                <button type="button" className="btn sm" disabled={busy} title="Checks resume with a fresh 24h deadline; Junior isn't woken" onClick={() => void act('answer', { gate: 'wait', ...(typed ? { text: typed } : {}) })}>
                  <Clock size={12} aria-hidden="true" /> Keep waiting
                </button>
              )}
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void act('answer', { gate: 'approve', ...(typed ? { text: typed } : {}) })}>
                <Check size={12} aria-hidden="true" /> Approve
              </button>
            </>
          ) : waiting && ask?.kind === 'plan_change' ? (
            <>
              <button type="button" className="btn sm" disabled={busy || !typed} onClick={() => void act('answer', { accept: false, text: typed })}>
                <Undo2 size={12} aria-hidden="true" /> Turn down
              </button>
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void act('answer', { accept: true, ...(typed ? { text: typed } : {}) })}>
                <Check size={12} aria-hidden="true" /> Accept change
              </button>
            </>
          ) : waiting ? (
            <button type="button" className="btn sm primary" disabled={busy || (!typed && !raised.budgetUsd)} onClick={() => void act('answer', { ...(typed ? { text: typed } : {}), ...raised })}>
              <Send size={12} aria-hidden="true" /> Answer
            </button>
          ) : paused ? (
            <button type="button" className="btn sm primary" disabled={busy} title="The lead wakes to what changed in the worktree" onClick={() => void act('hand-back', typed ? { text: typed } : {})}>
              <Undo2 size={12} aria-hidden="true" /> Hand back
            </button>
          ) : (
            <>
              <button type="button" className={result ? 'btn sm' : 'btn sm primary'} disabled={busy || !typed} onClick={() => void act('message', { text: typed })}>
                <Send size={12} aria-hidden="true" /> {result ? 'Reopen' : 'Send'}
              </button>
              {result && (
                <button type="button" className="btn sm primary" disabled={busy || !!typed} onClick={() => void act('accept')}>
                  <Check size={12} aria-hidden="true" /> Accept result
                </button>
              )}
            </>
          )}
        </div>
        {error && <div className="astubErr">{error}</div>}
      </div>
    </section>
  )
}

export function GoalPage({ id, onNavigate }: { id: string; onNavigate: (hash: string) => void }) {
  const state = useGoal(id)

  const crumbs = (title: string | null) => (
    <div className="crumbs" style={{ marginBottom: 14 }}>
      <button type="button" className="crumb link" onClick={() => onNavigate('/goals')}>
        Goals
      </button>
      {title && (
        <>
          <span className="crumbSep">›</span>
          <span className="crumb now">{title}</span>
        </>
      )}
    </div>
  )

  if (state.phase !== 'ready')
    return (
      <div className="page">
        <div className="inner">
          {crumbs(null)}
          {state.phase === 'loading' ? (
            <div className="probing">
              <span className="pip" /> Loading goal…
            </div>
          ) : (
            <div className="msg error">{state.message}</div>
          )}
        </div>
      </div>
    )

  const { goal, turn, steps, gates, events, plan, handoff, log, ledgerWarning, comments, leadSessionId, team, ask } = state.data
  const planSteps = goal.plan?.steps ?? []

  return (
    <div id="goalPage" className="page">
      <div className="glow yellow" aria-hidden="true" />
      <div className="inner">
        {crumbs(goal.title)}

        <div className="jobPageHead">
          <div style={{ minWidth: 0 }}>
            <h1 className="display">{goal.title}</h1>
            <div className="jobMetaLine">
              <span className={`dot ${goalDot({ state: goal.state, turn })}`} aria-hidden="true" />
              <span>{GOAL_STATE_LABEL[goal.state]}</span>
              <span className="sep">·</span>
              <span>{TURN_LABEL[turn]}</span>
              <span className="sep">·</span>
              <span>{HORIZON[goal.horizon]}</span>
              <span className="sep">·</span>
              <span className="mono">{spendText(goal)}</span>
              {goal.sourceItemId && (
                <>
                  <span className="sep">·</span>
                  <button type="button" className="crumb link" onClick={() => onNavigate(itemHash(goal.sourceItemId!))}>
                    from its item
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {goal.reason && <div className="notice">{goal.reason}</div>}
        {ledgerWarning && <div className="notice goalWarn">{ledgerWarning}</div>}
        {goal.state === 'draft_plan' && leadSessionId && (
          <div className="notice">
            Junior is {goal.planVersion > 0 ? 'revising' : 'drafting'} the plan.{' '}
            <button type="button" className="crumb link" onClick={() => onNavigate(leadSessionId)}>
              Watch the session
            </button>
          </div>
        )}
        {team.length === 1 && goal.state === 'running' && (
          <div className="notice">
            {team[0]!.role === 'lead' ? 'Junior is deciding the next move.' : `A ${team[0]!.role} is on ${team[0]!.stepId}.`}{' '}
            <button type="button" className="crumb link" onClick={() => onNavigate(team[0]!.sessionId)}>
              Watch the session
            </button>
          </div>
        )}
        {team.length > 1 && goal.state === 'running' && (
          <div className="notice">
            {team.length} working side by side, each on its own branch; Junior wakes when the last one ends.
            <ul className="goalList">
              {team.map((m) => (
                <li key={m.sessionId}>
                  <span className="mono">{m.stepId}</span>
                  <span className="t">
                    {m.role} · started {ago(m.startedAt)}
                    {m.lastActivityAt ? ` · last active ${ago(m.lastActivityAt)}` : ''}
                  </span>
                  <button type="button" className="crumb link" onClick={() => onNavigate(m.sessionId)}>
                    Watch
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="artGrid">
          <div className="goalMain">
            <section>
              <div className="secLabel">Done when</div>
              <p className="goalDoneWhen">{goal.doneWhen}</p>
            </section>
            {goal.state === 'plan_ready' && <PlanReview key={goal.planVersion} goal={goal} comments={comments} />}
            {STEERABLE.has(goal.state) && <GoalSteer goal={goal} ask={ask} />}
            <section>
              <div className="secLabel">
                Plan{goal.planVersion > 0 && <span className="n"> v{goal.planVersion}</span>}
              </div>
              <div className="card artBody">
                {plan.trim() ? <Markdown text={planProse(plan)} /> : <div className="artEmpty">No plan yet. Junior proposes one, and it waits here for you.</div>}
              </div>
            </section>
            <section>
              <div className="secLabel">Handoff</div>
              <div className="card artBody">
                {handoff.trim() ? <Markdown text={handoff} /> : <div className="artEmpty">Nothing handed over yet. Each session leaves what it did and what's next here.</div>}
              </div>
            </section>
            <section>
              <div className="secLabel">Log</div>
              <div className="card artBody">{log.trim() ? <Markdown text={log} /> : <div className="artEmpty">No sessions have logged work yet.</div>}</div>
            </section>
          </div>

          <aside className="artAside">
            {planSteps.length > 0 && (
              <section>
                <div className="secLabel">
                  Steps <span className="n">{planSteps.length}</span>
                </div>
                <ul className="goalList">
                  {planSteps.map((s) => {
                    const st = steps.find((x) => x.stepId === s.id)
                    return (
                      <li key={s.id} className={goal.currentStep === s.id ? 'now' : undefined}>
                        <span className="mono">{s.id}</span>
                        <span className="t">{s.title}</span>
                        <span className="mono s">{st?.status ?? 'pending'}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
            {gates.some((g) => g.status === 'open') && (
              <section>
                <div className="secLabel">Waiting on the world</div>
                <ul className="goalList">
                  {gates
                    .filter((g) => g.status === 'open')
                    .map((g) => (
                      <li key={g.id} title={g.lastVerdict ? `Last check: ${g.lastVerdict.verdict.replace(/_/g, ' ')}${g.lastVerdict.evidence ? ` — ${g.lastVerdict.evidence}` : ''}` : 'Not checked yet'}>
                        <span className="t">{g.condition}</span>
                        <span className="mono s">
                          next {inSpan(g.nextCheckAt)} · deadline {inSpan(g.deadlineAt)}
                          {g.confirmationsNeeded > 1 ? ` · ${g.confirmationsSeen}/${g.confirmationsNeeded} met` : ''}
                        </span>
                      </li>
                    ))}
                </ul>
              </section>
            )}
            {gates.some((g) => g.status !== 'open') && (
              <section>
                <div className="secLabel">
                  Gates <span className="n">{gates.filter((g) => g.status !== 'open').length}</span>
                </div>
                <ul className="goalList">
                  {gates.filter((g) => g.status !== 'open').map((g) => (
                    <li key={g.id} title={g.lastVerdict?.evidence ?? undefined}>
                      <span className="mono">{g.evaluator}</span>
                      <span className="t">{g.condition}</span>
                      <span className="mono s">{g.status.replace(/_/g, ' ')}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <div className="secLabel">History</div>
              <ul className="goalList">
                {[...events].reverse().slice(0, 30).map((e) => (
                  <li key={e.seq}>
                    <span className="t">{eventText(e)}</span>
                    <span className="mono s">{ago(e.at)}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <div className="secLabel">Ledger</div>
              <div className="artEmpty mono" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
                artifacts/goals/{goal.id}/
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
