import * as Tabs from '@radix-ui/react-tabs'
import { Check, ChevronDown, Copy, X } from 'lucide-react'
import { useState } from 'react'
import type { WorkflowAgent, WorkflowDetail, WorkflowRun } from '../../../../shared/protocol.js'
import { agentCounts, workflowElapsedMs } from '../../../../core/workflows/fold.js'
import { useMergedRun, type WorkflowSideTab } from '../../app/useWorkflows.js'
import { formatDuration } from '../../transcript.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu.js'
import { useNow } from '../Agents.js'
import { RunState, WfState, agentElapsed, agentLine, byPhase, modelShort, money, pendingNote, tok, unlaunched } from './shared.js'

/**
 * The run panel: the team drawer's slot and styles. Agents (phase by phase,
 * one row per agent), the script, and what the run returned and cost.
 */
export function WorkflowSide({
  sessionId,
  run: live,
  runs,
  tab,
  onTab,
  onPick,
  onClose,
  onOpenAgent,
}: {
  sessionId: string
  run: WorkflowRun
  /** every run in the session, for the picker */
  runs: readonly WorkflowRun[]
  tab: WorkflowSideTab
  onTab: (tab: WorkflowSideTab) => void
  onPick: (toolUseId: string) => void
  onClose: () => void
  onOpenAgent: (run: WorkflowRun, agent: WorkflowAgent) => void
}) {
  const { run: merged, detail, error } = useMergedRun(sessionId, live)
  const run = merged ?? live
  const now = useNow(runs.some((r) => r.state === 'running' && r.launched))
  return (
    <aside className="teamSide wfSide" aria-label="Workflow run">
      <header className="tsHead">
        <span className="wfKey">Ultracode</span>
        {runs.length > 1 ? (
          <RunPicker runs={runs} current={run.toolUseId} onPick={onPick} now={now} />
        ) : (
          <span className="t wfTitle">{run.name}</span>
        )}
        <span className="sp" />
        <button type="button" className="iconBtn" aria-label="Close the run panel" title="Close (the card stays in the transcript)" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <Tabs.Root value={tab} onValueChange={(v) => onTab(v as WorkflowSideTab)} className="tsTabs">
        <Tabs.List className="tsTabList" aria-label="Run details">
          <Tabs.Trigger value="agents" className="tsTab">
            Agents
          </Tabs.Trigger>
          <Tabs.Trigger value="script" className="tsTab">
            Script
          </Tabs.Trigger>
          <Tabs.Trigger value="result" className="tsTab">
            Result
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
      <div className="tsBody">
        {tab === 'agents' ? (
          <AgentsTab run={run} detail={detail} now={now} onOpenAgent={onOpenAgent} />
        ) : tab === 'script' ? (
          <ScriptTab run={run} detail={detail} error={error} />
        ) : (
          <ResultTab run={run} detail={detail} error={error} />
        )}
      </div>
    </aside>
  )
}

function RunPicker({ runs, current, onPick, now }: { runs: readonly WorkflowRun[]; current: string; onPick: (toolUseId: string) => void; now: number }) {
  const cur = runs.find((r) => r.toolUseId === current)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="wfPick" title="Switch to another run">
          <span className="t">{cur?.name ?? 'workflow'}</span>
          <span className="n">
            {runs.findIndex((r) => r.toolUseId === current) + 1} of {runs.length}
          </span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent className="wfPickMenu" align="start">
        {[...runs].reverse().map((r) => (
          <MenuItem key={r.toolUseId} className={`wfPickItem${r.toolUseId === current ? ' on' : ''}`} onSelect={() => onPick(r.toolUseId)}>
            <RunState run={r} label={false} />
            <span className="t">{r.name}</span>
            <span className="n">{unlaunched(r) ? '' : formatDuration(workflowElapsedMs(r, now) ?? 0)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function AgentsTab({
  run,
  detail,
  now,
  onOpenAgent,
}: {
  run: WorkflowRun
  detail: WorkflowDetail | null
  now: number
  onOpenAgent: (run: WorkflowRun, agent: WorkflowAgent) => void
}) {
  const c = agentCounts(run)
  const waiting = unlaunched(run)
  const ms = waiting ? undefined : workflowElapsedMs(run, now)
  const groups = byPhase(run)
  const costOf = (a: WorkflowAgent) => (a.agentId ? detail?.agents[a.agentId]?.costUsd : undefined)
  return (
    <>
      <div className="wfTotals">
        <RunState run={run} />
        {ms !== undefined && <span>{formatDuration(ms)}</span>}
        {c.total > 0 && (
          <span>
            {c.done}/{c.total} agents
          </span>
        )}
        {run.tokens > 0 && <span>{tok(run.tokens)}</span>}
        {detail && (detail.costUsd > 0 || run.state !== 'running') && <span title="What the workflow's agents cost, at list price">{money(detail.costUsd)}</span>}
      </div>
      {run.error && <div className="wfErrBox">{run.error}</div>}
      {!groups.length && <p className="tsNote">{waiting ? pendingNote(run) : run.state === 'running' ? 'The script hasn’t started an agent yet.' : 'This run started no agents.'}</p>}
      {groups.map((g) => {
        const done = g.agents.filter((a) => a.state === 'done').length
        const tokens = g.agents.reduce((n, a) => n + (a.tokens ?? 0), 0)
        return (
          <section key={g.key} className="tsSec">
            <div className="tsK">
              {g.title} · {done}/{g.agents.length}
              {tokens > 0 ? ` · ${tok(tokens)}` : ''}
            </div>
            {g.agents.length === 0 ? (
              <div className="tsMeta">no agents yet</div>
            ) : (
              <ul className="wfAgents">
                {g.agents.map((a) => (
                  <li key={a.index}>
                    <AgentRow agent={a} cost={costOf(a)} now={now} onOpen={() => onOpenAgent(run, a)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </>
  )
}

function AgentRow({ agent: a, cost, now, onOpen }: { agent: WorkflowAgent; cost: number | undefined; now: number; onOpen: () => void }) {
  const ms = agentElapsed(a, now)
  const nums = [a.tokens ? tok(a.tokens) : '', cost !== undefined && (cost > 0 || (a.state !== 'running' && a.state !== 'queued')) ? money(cost) : '', ms !== undefined ? formatDuration(ms) : ''].filter(Boolean).join(' · ')
  return (
    <button type="button" className={`wfAgent ${a.state}`} onClick={onOpen} title="Open this agent’s transcript">
      <WfState state={a.state} label={false} />
      <span className="wfaMain">
        <span className="wfaHead">
          <span className="wfaLabel">{a.label}</span>
          {a.model && <span className="wfaModel">{modelShort(a.model)}</span>}
          {(a.attempt ?? 1) > 1 && <span className="wfaModel">try {a.attempt}</span>}
        </span>
        <span className="wfaLine">{agentLine(a)}</span>
      </span>
      {nums && <span className="wfaNums">{nums}</span>}
    </button>
  )
}

/** Why a run's files couldn't be read, in a line; the server's own words are in the tooltip. */
function ReadFailed({ error }: { error: string }) {
  return (
    <p className="tsNote" title={error}>
      Couldn’t read this run’s files.
    </p>
  )
}

function ScriptTab({ run, detail, error }: { run: WorkflowRun; detail: WorkflowDetail | null; error: string | null }) {
  const [copied, setCopied] = useState(false)
  const script = detail?.script
  if (!script && run.taskId && !detail && error) return <ReadFailed error={error} />
  if (!script) return <p className="tsNote">{unlaunched(run) ? pendingNote(run) : !run.taskId ? 'This run never started, so there is no script on disk.' : detail ? 'The script isn’t on disk any more.' : 'Reading the script…'}</p>
  const copy = () =>
    void navigator.clipboard
      ?.writeText(script)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  return (
    <section className="tsSec">
      <div className="wfSecHead">
        <span className="tsK">{run.scriptPath ? run.scriptPath.slice(run.scriptPath.lastIndexOf('/') + 1) : 'script'}</span>
        <span className="sp" />
        <button type="button" className="btn xs ghost" onClick={copy}>
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="well wfScript">{script}</pre>
    </section>
  )
}

function ResultTab({ run, detail, error }: { run: WorkflowRun; detail: WorkflowDetail | null; error: string | null }) {
  // Cost only: the ledger's token sums count every API call, so they'd contradict the Agents tab.
  const models = new Map<string, { cost: number; agents: number }>()
  for (const a of Object.values(detail?.agents ?? {})) {
    const k = modelShort(a.model) || 'unknown'
    const m = models.get(k) ?? { cost: 0, agents: 0 }
    models.set(k, { cost: m.cost + a.costUsd, agents: m.agents + 1 })
  }
  const perAgent = run.agents.filter((a) => a.agentId && detail?.agents[a.agentId])
  return (
    <>
      <section className="tsSec">
        <div className="tsK">what it returned</div>
        {detail?.result ? (
          <pre className="well wfResult">{detail.result}</pre>
        ) : run.error ? (
          <div className="wfErrBox">{run.error}</div>
        ) : !detail && error && run.taskId ? (
          <ReadFailed error={error} />
        ) : (
          <div className="tsMeta">{unlaunched(run) ? pendingNote(run) : run.state === 'running' ? 'Still running. The result lands here when it ends.' : detail ? 'It returned nothing.' : 'Reading the run…'}</div>
        )}
      </section>
      {detail?.logs && detail.logs.length > 0 && (
        <section className="tsSec">
          <div className="tsK">log · {detail.logs.length}</div>
          <pre className="well wfLogs">{detail.logs.join('\n')}</pre>
        </section>
      )}
      {detail && models.size > 0 && (
        <section className="tsSec">
          <div className="tsK">cost by model · {money(detail.costUsd)}</div>
          <table className="wfCost">
            <tbody>
              {[...models].map(([k, m]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="n">{m.agents} {m.agents === 1 ? 'agent' : 'agents'}</td>
                  <td className="n">{money(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {detail && perAgent.length > 0 && (
        <section className="tsSec">
          <div className="tsK">cost per agent</div>
          <table className="wfCost">
            <tbody>
              {perAgent.map((a) => {
                const c = detail.agents[a.agentId!]
                return (
                  <tr key={a.index}>
                    <td className="lbl">{a.label}</td>
                    <td className="n">{modelShort(c.model ?? a.model)}</td>
                    <td className="n">{money(c.costUsd)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
      <p className="tsNote">Workflow agents work locally. Anything that leaves this machine still waits for your OK in the main chat.</p>
    </>
  )
}
