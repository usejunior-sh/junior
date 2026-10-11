/**
 * Subagents in a chat (.docs/subagents-ux.html), in four places so none of them is big:
 *
 *   AgentCard      in the transcript — one per Agent call, the history
 *   AgentDock      above the composer — only what's running now; gone when nothing is
 *   AgentsMenu     every agent this session spawned, finished ones too (header, dock, breadcrumb)
 *   AgentHeader    an agent's own view: Main › … › it, its state, Stop / Background
 *
 * All of them read `buildAgents` (agents.ts) over the session's events. A
 * subagent is a slice of the main agent's stream, not a session, so "opening"
 * one swaps the transcript for that slice rather than navigating anywhere.
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronDown, ChevronRight, Square } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { agentAncestors, agentElapsedMs, agentLabel, type AgentRun } from '../agents.js'
import { colorOf } from '../teams.js'
import { formatDuration } from '../transcript.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { Markdown } from './Markdown.js'

/** A clock that ticks once a second while something is running, and not otherwise. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

// Built-in types get fixed colours so "Explore" reads the same in every session;
// anything else (a custom agent) is hashed onto the team palette.
const TYPE_COLOR: Record<string, string> = { explore: 'blue', plan: 'yellow' }
const PALETTE = ['green', 'purple', 'orange', 'cyan', 'pink']

function typeColor(type: string): string {
  const t = type.toLowerCase()
  if (t === 'general-purpose' || t === 'skill') return 'var(--charcoal)'
  if (TYPE_COLOR[t]) return colorOf(TYPE_COLOR[t])
  let h = 0
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return colorOf(PALETTE[h % PALETTE.length])
}

export function AgentMark({ type }: { type: string }) {
  return <span className="swatch" style={{ background: typeColor(type) }} aria-hidden="true" />
}

const running = (r: AgentRun) => r.state === 'running'

const STATE_LABEL: Record<AgentRun['state'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
}

function AgentStatus({ run }: { run: AgentRun }) {
  if (run.state === 'running') {
    return run.waiting ? (
      <span className="agentState ask">
        <span className="dot yellow" aria-hidden="true" /> needs you
      </span>
    ) : (
      <span className="agentState">
        <span className="dot live" aria-hidden="true" /> running
      </span>
    )
  }
  const glyph = run.state === 'done' ? '✓' : run.state === 'failed' ? '✕' : run.state === 'stopped' ? '■' : '–'
  return (
    <span className={`agentState ${run.state}`}>
      {glyph} {STATE_LABEL[run.state]}
    </span>
  )
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k tok` : `${n} tok`)

/** "12 tools · 38.6k tok · 52s" — whatever is known. */
function numbers(run: AgentRun, now: number, withTokens = true): string {
  const ms = agentElapsedMs(run, now)
  return [
    run.toolUses ? `${run.toolUses} ${run.toolUses === 1 ? 'tool' : 'tools'}` : '',
    withTokens && run.tokens ? tokens(run.tokens) : '',
    ms !== undefined ? formatDuration(ms) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

const firstLine = (s: string) => s.trim().split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? ''

/** The card an Agent call becomes in the transcript. The whole card opens the agent. */
export function AgentCard({ run, onOpen }: { run: AgentRun | undefined; onOpen: (toolUseId: string) => void }) {
  const now = useNow(!!run && running(run))
  if (!run) return null
  const line = run.waiting
    ? 'Waiting on a permission prompt — open to answer'
    : running(run)
      ? run.activity
      : run.state === 'failed'
        ? run.error
        : run.report
  return (
    <button
      type="button"
      className={`agentCard ${run.state}${run.waiting ? ' ask' : ''}`}
      onClick={() => onOpen(run.toolUseId)}
      title="Open this agent"
    >
      <span className="acRow">
        <AgentMark type={run.type} />
        <span className="acType">{run.type}</span>
        <span className="acDesc">{run.description}</span>
        <span className="acEnd">
          {run.background && running(run) && <span className="pill">background</span>}
          <AgentStatus run={run} />
          <span className="acNums">{numbers(run, now)}</span>
        </span>
      </span>
      {line && <span className="acLine">{firstLine(line)}</span>}
    </button>
  )
}

/**
 * Every agent this session spawned, running first, then the rest newest first.
 * The trigger is the caller's; `current` marks the agent being viewed, and
 * `withMain` adds the way back (the breadcrumb's menu).
 */
export function AgentsMenu({
  agents,
  current,
  withMain,
  align = 'end',
  onOpen,
  children,
}: {
  agents: readonly AgentRun[]
  current?: string
  withMain?: boolean
  align?: 'start' | 'end'
  onOpen: (toolUseId: string | null) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const live = agents.filter(running)
  const ended = agents.filter((a) => !running(a)).reverse()
  const now = useNow(open && live.length > 0)
  const row = (a: AgentRun) => (
    <MenuItem
      key={a.toolUseId}
      className={`agentsMenuItem${a.toolUseId === current ? ' on' : ''}`}
      onSelect={() => onOpen(a.toolUseId)}
    >
      <AgentMark type={a.type} />
      <span className="text">
        <span className="name">
          {a.type} · {agentLabel(a)}
        </span>
        <span className="desc">{firstLine((running(a) ? a.activity : a.state === 'failed' ? a.error : a.report) ?? '') || STATE_LABEL[a.state]}</span>
      </span>
      <span className="val">
        {running(a) ? <span className={`dot ${a.waiting ? 'yellow' : 'live'}`} aria-hidden="true" /> : <span className={`amGlyph ${a.state}`}>{a.state === 'done' ? '✓' : a.state === 'failed' ? '✕' : '■'}</span>}
        {formatDuration(agentElapsedMs(a, now) ?? 0)}
      </span>
    </MenuItem>
  )
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent className="agentsMenu" align={align}>
        {withMain && (
          <>
            <MenuItem className="agentsMenuItem" onSelect={() => onOpen(null)}>
              <span className="mgrGlyph" aria-hidden="true" />
              <span className="text">
                <span className="name">Main</span>
              </span>
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <div className="amHead">
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'} in this session
          {live.length > 0 && <span>{live.length} running</span>}
        </div>
        {live.length > 0 && <div className="amGroup">running</div>}
        {live.map(row)}
        {ended.length > 0 && <div className="amGroup">finished</div>}
        {ended.map(row)}
      </MenuContent>
    </Menu>
  )
}

/** Above the composer, while any agent runs: what each is doing, and a way to stop it. */
export function AgentDock({
  agents,
  onOpen,
  onStop,
}: {
  agents: readonly AgentRun[]
  onOpen: (toolUseId: string | null) => void
  onStop: (run: AgentRun) => void
}) {
  const live = agents.filter(running)
  const now = useNow(live.length > 0)
  if (!live.length) return null
  const shown = live.slice(0, 3)
  return (
    <div className={`agentDock${live.some((a) => a.waiting) ? ' ask' : ''}`} role="region" aria-label="Running agents">
      <div className="adHead">
        <span className="dot live" aria-hidden="true" />
        <span>
          {live.length} {live.length === 1 ? 'agent' : 'agents'} running
        </span>
        <span className="sp" />
        <AgentsMenu agents={agents} onOpen={onOpen}>
          <button type="button" className="btn xs ghost">
            All {agents.length} <ChevronDown size={11} aria-hidden="true" />
          </button>
        </AgentsMenu>
        {live.length > 1 && (
          <button type="button" className="btn xs ghost" onClick={() => live.forEach(onStop)} title="Stop every running agent">
            Stop all
          </button>
        )}
      </div>
      {shown.map((a) => (
        <div key={a.toolUseId} className={`adRow${a.waiting ? ' ask' : ''}`}>
          <button type="button" className="adOpen" onClick={() => onOpen(a.toolUseId)} title="Open this agent">
            <AgentMark type={a.type} />
            <span className="adName">{agentLabel(a)}</span>
            <span className="adNow">{a.waiting ? 'needs you — open to answer' : a.activity ?? a.type}</span>
            <span className="adTime">{formatDuration(agentElapsedMs(a, now) ?? 0)}</span>
          </button>
          <button
            type="button"
            className="adStop"
            disabled={!a.agentId}
            onClick={() => onStop(a)}
            title="Stop this agent"
            aria-label={`Stop ${agentLabel(a)}`}
          >
            <Square size={9} aria-hidden="true" />
          </button>
        </div>
      ))}
      {live.length > shown.length && (
        <AgentsMenu agents={agents} onOpen={onOpen}>
          <button type="button" className="adMore">
            +{live.length - shown.length} more running
          </button>
        </AgentsMenu>
      )}
    </div>
  )
}

/** The top of an agent's own view: where it sits, what state it's in, and what you can do to it. */
export function AgentHeader({
  run,
  agents,
  onOpen,
  onStop,
  onBackground,
}: {
  run: AgentRun
  agents: readonly AgentRun[]
  onOpen: (toolUseId: string | null) => void
  onStop: (run: AgentRun) => void
  onBackground: (run: AgentRun) => void
}) {
  const now = useNow(running(run))
  const up = agentAncestors(agents, run)
  return (
    <div className="agentHead">
      <div className="ahRow">
        <nav className="ahCrumbs" aria-label="Agent">
          <button type="button" className="ahCrumb" onClick={() => onOpen(null)}>
            Main
          </button>
          {up.map((a) => (
            <Fragment key={a.toolUseId}>
              <ChevronRight size={12} className="ahSep" aria-hidden="true" />
              <button type="button" className="ahCrumb" onClick={() => onOpen(a.toolUseId)}>
                {agentLabel(a)}
              </button>
            </Fragment>
          ))}
          <ChevronRight size={12} className="ahSep" aria-hidden="true" />
          <AgentsMenu agents={agents} current={run.toolUseId} withMain align="start" onOpen={onOpen}>
            <button type="button" className="ahCurrent" title="Switch to another agent">
              <AgentMark type={run.type} />
              <span className="ahName">
                {run.type} · {agentLabel(run)}
              </span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </AgentsMenu>
        </nav>
        <AgentStatus run={run} />
        <span className="sp" />
        {running(run) && !run.background && (
          <button type="button" className="btn sm ghost" onClick={() => onBackground(run)} title="Let main carry on while this keeps running">
            Background
          </button>
        )}
        {running(run) && (
          <button type="button" className="btn sm" disabled={!run.agentId} onClick={() => onStop(run)}>
            Stop
          </button>
        )}
      </div>
      <div className="ahMeta">
        <span className="t">{run.type}</span>
        {numbers(run, now) && <span>{numbers(run, now)}</span>}
        {running(run) && <span>{run.background ? 'background · main carried on' : 'foreground · main waits'}</span>}
      </div>
    </div>
  )
}

/** What the spawning agent asked of it — first in its view, folded. */
export function AgentBrief({ run, from }: { run: AgentRun; from: string }) {
  const [open, setOpen] = useState(false)
  if (!run.prompt) return null
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="agentBrief">
      <Collapsible.Trigger className="abTrigger">
        <ChevronRight size={12} className="chev" aria-hidden="true" />
        Brief from {from}
      </Collapsible.Trigger>
      <Collapsible.Content className="abBody">
        <Markdown text={run.prompt} />
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

/** How it ended — last in its view. */
export function AgentOutcome({ run, to }: { run: AgentRun; to: string }) {
  if (run.state === 'running') return null
  if (run.state === 'failed') return <div className="msg error">{run.error || 'The agent failed.'}</div>
  if (run.report)
    return (
      <div className={`agentHandback${run.state === 'done' ? '' : ' partial'}`}>
        <div className="ahbHead">{run.state === 'done' ? `↩ reported back to ${to}` : `■ ${STATE_LABEL[run.state]} — what it had`}</div>
        <Markdown text={run.report} />
      </div>
    )
  return (
    <div className="meta">
      <span className="metaText">
        {run.state === 'stopped'
          ? '— stopped before it reported back —'
          : run.state === 'interrupted'
            ? '— interrupted: the session restarted while it ran —'
            : '— done —'}
      </span>
    </div>
  )
}

/**
 * The composer in an agent's view. The SDK can't address a subagent, so this
 * writes to main, which passes it on with SendMessage — said once, plainly.
 */
export function AgentComposer({ run, onSend }: { run: AgentRun; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const can = !!run.agentId
  const send = () => {
    const t = text.trim()
    if (!t || !can) return
    onSend(t)
    setText('')
  }
  return (
    <div id="composer" className="agentComposer">
      <div className="frame card">
        <textarea
          className="acBox"
          rows={2}
          value={text}
          disabled={!can}
          placeholder={can ? `Message ${run.type}…` : 'This agent has no id to write to'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="acFoot">
          <span className="mgrGlyph" aria-hidden="true" />
          <span>
            {running(run) ? (
              <>
                Delivered <b>through main</b> with SendMessage — it costs a main turn.
              </>
            ) : (
              <>
                Main <b>resumes this agent</b> with your message — it keeps its context.
              </>
            )}
          </span>
          <span className="sp" />
          <button type="button" className="btn sm primary" disabled={!can || !text.trim()} onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
