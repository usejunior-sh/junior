import * as Collapsible from '@radix-ui/react-collapsible'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PermissionBehavior, QuestionAnswers, SessionEvent, WorkflowAgent, WorkflowRun } from '../../../../shared/protocol.js'
import { useEventTimes, useMergedRun, useWorkflowAgentTranscript } from '../../app/useWorkflows.js'
import { usePersona } from '../../junior.js'
import { formatDuration } from '../../transcript.js'
import { useNow } from '../Agents.js'
import { Markdown } from '../Markdown.js'
import { Transcript } from '../Transcript.js'
import { STATE_LABEL, WfState, agentElapsed, modelShort, money, tok } from './shared.js'

const NO_EVENTS: readonly SessionEvent[] = []

/**
 * A workflow agent's own view, in place of the main transcript, the way a
 * subagent's is. Its messages are read off disk (the stream never carries
 * them) and refreshed while it runs. It can't be messaged, so the composer
 * slot says so and offers the way back.
 */
export function WorkflowAgentView({
  sessionId,
  run: live,
  index,
  agentId: pickedId,
  events,
  onRespond,
  onBack,
  onOpenRun,
  onNavigate,
}: {
  sessionId: string
  run: WorkflowRun
  index: number
  agentId?: string
  /** the session's own events: this agent's permission prompts live there, not on disk */
  events: readonly SessionEvent[]
  onRespond: (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => void
  onBack: () => void
  /** back to main, with the run panel open on this run */
  onOpenRun: (toolUseId: string) => void
  onNavigate: (hash: string) => void
}) {
  const persona = usePersona()
  const { run: merged, detail } = useMergedRun(sessionId, live)
  const run = merged ?? live
  const agent: WorkflowAgent | undefined = run.agents.find((a) => a.index === index)
  const agentId = agent?.agentId ?? pickedId
  const running = agent?.state === 'running'
  // Its transcript file appears a moment after it starts: until it has ended, a failed read is still loading.
  const ended = run.state !== 'running' || !agent || (agent.state !== 'running' && agent.state !== 'queued')
  const got = useWorkflowAgentTranscript(sessionId, run.taskId, agentId, running)
  const t = got?.transcript ?? null
  const timeOf = useEventTimes(t)
  // Its prompts, answered here or in main alike, after what it has said so far.
  const shown = useMemo(() => {
    if (!agentId) return t?.events ?? NO_EVENTS
    const asks = new Set<string>()
    const mine = events.filter((ev) => {
      if (ev.kind === 'permission_request' && ev.agentId === agentId) return asks.add(ev.id)
      return ev.kind === 'permission_resolved' && asks.has(ev.id)
    })
    return mine.length ? [...(t?.events ?? []), ...mine] : (t?.events ?? NO_EVENTS)
  }, [t, events, agentId])
  const runs = useMemo(() => [run], [run])
  const now = useNow(running)

  // Escape goes back to main, unless something on top (a menu, a field) takes it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, [contenteditable="true"], [role="menu"], [role="dialog"]')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const label = agent?.label ?? t?.label ?? `agent ${index}`
  const phase = agent?.phase ?? t?.phase
  const model = modelShort(agent?.model ?? t?.model)
  const cost = t?.costUsd ?? (agentId ? detail?.agents[agentId]?.costUsd : undefined)
  const ms = agent ? agentElapsed(agent, now) : undefined
  const nums = [
    agent?.toolCalls ? `${agent.toolCalls} ${agent.toolCalls === 1 ? 'tool' : 'tools'}` : '',
    agent?.tokens ? tok(agent.tokens) : '',
    cost !== undefined ? money(cost) : '',
    ms !== undefined ? formatDuration(ms) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const prompt = t?.prompt ?? agent?.promptPreview
  const result = t?.result ?? agent?.resultPreview

  return (
    <>
      <div className="agentHead wfAgentHead">
        <div className="ahRow">
          <nav className="ahCrumbs" aria-label="Workflow agent">
            <button type="button" className="ahCrumb" onClick={onBack}>
              Main
            </button>
            <ChevronRight size={12} className="ahSep" aria-hidden="true" />
            <button type="button" className="ahCrumb wfCrumbRun" onClick={() => onOpenRun(run.toolUseId)} title="Back to main, with this run’s panel open">
              {run.name}
            </button>
            {phase && (
              <>
                <ChevronRight size={12} className="ahSep" aria-hidden="true" />
                <span className="ahCrumb static">{phase}</span>
              </>
            )}
            <ChevronRight size={12} className="ahSep" aria-hidden="true" />
            <span className="ahName wfCrumbAgent">{label}</span>
          </nav>
          {agent && <WfState state={agent.state} />}
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={onBack} title="Back to main (Esc)">
            <ArrowLeft size={12} aria-hidden="true" /> Back
          </button>
        </div>
        <div className="ahMeta">
          <span className="t">workflow agent</span>
          {model && <span>{model}</span>}
          {nums && <span>{nums}</span>}
          {(agent?.attempt ?? 1) > 1 && <span>try {agent!.attempt}</span>}
        </div>
      </div>
      <Transcript
        key={`${sessionId}:${run.toolUseId}:${index}`}
        sessionId={sessionId}
        events={shown}
        timeOf={timeOf}
        onRespond={onRespond}
        onNavigate={onNavigate}
        workflows={runs}
        noLive
        lead={
          <>
            {prompt && <WfBrief prompt={prompt} from={run.name} />}
            {!agentId ? (
              <div className="meta">
                <span className="metaText">— queued: it starts when a slot frees up —</span>
              </div>
            ) : !got || (got.error && !t && !ended) ? (
              <div className="meta">
                <span className="metaText">— reading its transcript… —</span>
              </div>
            ) : got.error && !t ? (
              <div className="meta">
                <span className="metaText" title={got.error}>
                  — couldn’t read its transcript —
                </span>
              </div>
            ) : null}
          </>
        }
        tail={agent && <WfOutcome agent={agent} result={result} />}
      />
      <div id="composer" className="wfQuiet">
        <div className="frame card wfQuietBar">
          <span>
            Workflow agents can’t take messages. Ask {persona.name} in the main chat.
          </span>
          <span className="sp" />
          <button type="button" className="btn sm" onClick={onBack}>
            Back to main
          </button>
        </div>
      </div>
    </>
  )
}

function WfBrief({ prompt, from }: { prompt: string; from: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="agentBrief">
      <Collapsible.Trigger className="abTrigger">
        <ChevronRight size={12} className="chev" aria-hidden="true" />
        Task from <span className="mono">{from}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className="abBody">
        <Markdown text={prompt} />
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

function WfOutcome({ agent, result }: { agent: WorkflowAgent; result: string | undefined }) {
  if (agent.state === 'running' || agent.state === 'queued') return null
  if (agent.state === 'failed') return <div className="msg error">{agent.error || 'The agent failed.'}</div>
  if (result)
    return (
      <div className={`agentHandback${agent.state === 'done' ? '' : ' partial'}`}>
        <div className="ahbHead">{agent.state === 'done' ? '↩ returned to the workflow' : `■ ${STATE_LABEL[agent.state]} — what it had`}</div>
        <Markdown text={result} />
      </div>
    )
  return (
    <div className="meta">
      <span className="metaText">{agent.state === 'done' ? '— done —' : agent.state === 'stopped' ? '— stopped before it returned —' : '— interrupted: the session restarted while it ran —'}</span>
    </div>
  )
}
