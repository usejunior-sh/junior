/**
 * What this session has cost, as a pill in the chat header; hover (or tap, on
 * a phone) for the split, input, output, cache writes and reads, and models.
 *
 * Same ledger and vocabulary as the item page's cost block (`/api/usage/sessions`,
 * `usageFormat.ts`), so the two never disagree. The transcript is the source,
 * so a running session's figure is a floor: it is refetched a beat after each
 * assistant message lands and again when the session settles. Ultracode runs
 * spend with no main-agent reply, so while one is going it refetches every few
 * seconds, and once more when the last one ends.
 */
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { SessionStatus, SessionsUsage, SessionsUsageResponse } from '../../../shared/protocol.js'
import { useEvents } from '../hooks.js'
import { MAX_SERIES, OTHER, SERIES, contextUse, modelLabel, money, tokens } from '../usageFormat.js'

/** The widest window the ledger offers: a session from last month still adds up. */
const DAYS = 90
/** Claude Code appends to its transcript a moment after the SDK emits the message. */
const SETTLE_MS = 1500
/** While a workflow runs, its agents spend between replies: poll no faster than this. */
const WORKFLOW_POLL_MS = 5000
const HOVER_OPEN_MS = 120
const HOVER_CLOSE_MS = 160

/** The last figure per session, so landing on one shows it at once and refreshes behind. */
const lastSeen = new Map<string, SessionsUsage>()

/**
 * What a session has cost so far, from the usage ledger, refetched as it
 * replies and while its workflows run. The header's ring and the sidebar's
 * stats bar both read this, so they never disagree. `settled` = the ledger has
 * answered for this session (until then, show a skeleton).
 *
 * `workflows`: the summary's count of runs still going. Only a live subprocess
 * counts any, so a run the log never saw end (a restart, a crash) can't keep
 * the figure polling.
 */
export function useSessionSpend(sessionId: string, status: SessionStatus, workflows = 0) {
  const events = useEvents(sessionId)
  const replies = events.reduce((n, ev) => (ev.kind === 'sdk' && ev.message.type === 'assistant' ? n + 1 : n), 0)
  const workflowRunning = workflows > 0
  /** Bumped every WORKFLOW_POLL_MS while a run is going: each bump is a refetch. */
  const [tick, setTick] = useState(0)
  const [usage, setUsage] = useState<SessionsUsage | null>(() => lastSeen.get(sessionId) ?? null)
  /** The session the ledger has answered for, until then, a skeleton holds the pill's place. */
  const [settled, setSettled] = useState<string | null>(() => (lastSeen.has(sessionId) ? sessionId : null))
  /** The session whose first, undelayed fetch has gone out. */
  const fetchedFor = useRef<string | null>(null)

  useEffect(() => {
    setUsage(lastSeen.get(sessionId) ?? null)
    setSettled(lastSeen.has(sessionId) ? sessionId : null)
  }, [sessionId])

  useEffect(() => {
    let live = true
    // Landing on a session fetches straight away; a new reply, a status change,
    // a workflow tick or a run ending waits for Claude Code to finish writing.
    const first = fetchedFor.current !== sessionId
    const t = setTimeout(
      () => {
        // Marked once it actually goes out: events loading a beat after landing
        // re-run this effect, and a cancelled first fetch must stay undelayed.
        fetchedFor.current = sessionId
        void fetch(`/api/usage/sessions?ids=${encodeURIComponent(sessionId)}&days=${DAYS}`)
          .then((r) => r.json() as Promise<SessionsUsageResponse>)
          .then((b) => {
            if (b.ok) lastSeen.set(sessionId, b.usage)
            if (!live) return
            if (b.ok) setUsage(b.usage)
            setSettled(sessionId)
          })
          .catch(() => {
            if (live) setSettled(sessionId)
          })
      },
      first ? 0 : SETTLE_MS,
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [sessionId, replies, status, workflowRunning, tick])

  useEffect(() => {
    if (!workflowRunning) return
    const t = setInterval(() => setTick((n) => n + 1), WORKFLOW_POLL_MS)
    return () => clearInterval(t)
  }, [workflowRunning])

  return { usage, spend: usage?.bySession[sessionId], settled: settled === sessionId, running: status === 'running' || status === 'starting' || workflowRunning }
}

export function SessionCost({
  sessionId,
  status,
  workflows = 0,
  compact = false,
  bar = false,
  kind,
}: {
  sessionId: string
  status: SessionStatus
  workflows?: number
  compact?: boolean
  /** The desktop header's trigger: the context bar and its percentage; the cost waits in the popover. */
  bar?: boolean
  kind?: string
}) {
  const events = useEvents(sessionId)
  // The chat header's ring: how full the main agent's context is, beside what it has cost.
  // A DM is full at its compaction point, as its sidebar row and composer meter say.
  const ctx = useMemo(() => contextUse(events, kind), [events, kind])
  const { usage, spend, settled, running } = useSessionSpend(sessionId, status, workflows)
  const [open, setOpen] = useState(false)
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(hover.current), [])

  if (!spend) {
    // Loading: a faint bar where the figure will land.
    // Answered with no spend (a session yet to reply): nothing.
    return settled ? null : <span className="costSkel" aria-hidden="true" />
  }

  const later = (next: boolean, ms: number) => {
    clearTimeout(hover.current)
    hover.current = setTimeout(() => setOpen(next), ms)
  }
  const hoverProps = {
    onPointerEnter: (e: PointerEvent) => e.pointerType === 'mouse' && later(true, HOVER_OPEN_MS),
    onPointerLeave: (e: PointerEvent) => e.pointerType === 'mouse' && later(false, HOVER_CLOSE_MS),
  }

  const prompt = spend.input + spend.cacheWrite + spend.cacheRead
  const hit = prompt > 0 ? Math.round((spend.cacheRead / prompt) * 100) : 0
  const models = (usage?.models ?? []).filter((m) => m.tokens > 0)
  // Who spent it: the main agent, its subagents, and Ultracode runs' agents, each a disjoint share.
  const sub = spend.subagents && spend.subagents.messages > 0 ? spend.subagents : undefined
  const wf = spend.workflows && spend.workflows.messages > 0 ? spend.workflows : undefined

  const rows: Array<[string, number, string?]> = [
    ['Input', spend.input],
    ['Output', spend.output],
    ['Cache write', spend.cacheWrite],
    ['Cache read', spend.cacheRead, prompt > 0 ? `${hit}% of prompt` : undefined],
  ]

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {bar ? (
          <button
            type="button"
            className={`ctxHead${open ? ' on' : ''}${ctx && ctx.pct >= 80 ? ' full' : ''}`}
            aria-label={`${ctx ? `${ctx.pct}% of context used, ` : ''}${money(spend.cost)}${spend.priced ? '' : '+'} spent — show breakdown`}
            {...hoverProps}
          >
            {ctx ? (
              <>
                <span className="ctxHeadBar" aria-hidden="true">
                  <i style={{ width: `${ctx.pct}%` }} />
                </span>
                <span className="pct">{ctx.pct}%</span>
              </>
            ) : (
              // No turn has reported its context yet: the cost alone.
              <span className="pct">
                {money(spend.cost)}
                {!spend.priced && '+'}
              </span>
            )}
          </button>
        ) : compact ? (
          <button
            type="button"
            className={`ib costRing${open ? ' on' : ''}${ctx && ctx.pct >= 80 ? ' full' : ''}`}
            aria-label={`${money(spend.cost)}${spend.priced ? '' : '+'} spent${ctx ? `, ${ctx.pct}% of context used` : ''} — show breakdown`}
            {...hoverProps}
          >
            <ContextRing pct={ctx?.pct ?? 0} />
            {/* The figure beside the ring: a ring alone, nearly empty, reads as a spinner. */}
            <span className="ibCount">
              {money(spend.cost)}
              {!spend.priced && '+'}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className={`pill mono costPill${open ? ' on' : ''}`}
            aria-label={`Session cost ${money(spend.cost)} — show breakdown`}
            {...hoverProps}
          >
            {money(spend.cost)}
            {!spend.priced && '+'}
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="costPop"
          side="bottom"
          align={bar ? 'end' : 'start'}
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          {...hoverProps}
        >
          <div className="head">
            <span className="lab">Session cost</span>
            {running && <span className="win">so far</span>}
          </div>
          <div className="big">
            {money(spend.cost)}
            {!spend.priced && <span className="approx">+</span>}
          </div>
          <div className="sub">
            {tokens(spend.tokens)} tokens · {spend.messages} {spend.messages === 1 ? 'API call' : 'API calls'}
          </div>
          {ctx && (
            <div className="ctxRow" title={kind === 'dm' ? "The main agent's last prompt, against where this chat compacts" : "The main agent's last prompt, against its model's context window"}>
              <span className="lab">Context</span>
              <span className="ctxBar" aria-hidden="true">
                <i style={{ width: `${ctx.pct}%` }} className={ctx.pct >= 80 ? 'full' : undefined} />
              </span>
              <span className="val">
                {tokens(ctx.used)} / {tokens(ctx.window)} · {ctx.pct}%
              </span>
            </div>
          )}

          {/* A daemon older than the breakdown sends the totals only. */}
          {typeof spend.input === 'number' && (
            <dl className="split">
              {rows.map(([label, n, note]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {note && <span className="note">{note}</span>}
                    {tokens(n)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {/* Who spent it: subagents and workflow agents bill from their own transcripts, folded in here. */}
          {(sub || wf) && (
            <dl className="split who">
              <div>
                <dt>Main agent</dt>
                <dd>{money(Math.max(0, spend.cost - (sub?.cost ?? 0) - (wf?.cost ?? 0)))}</dd>
              </div>
              {sub && (
                <div>
                  <dt>Subagents</dt>
                  <dd>
                    <span className="note">
                      {sub.messages} {sub.messages === 1 ? 'call' : 'calls'}
                    </span>
                    {money(sub.cost)}
                  </dd>
                </div>
              )}
              {wf && (
                <div>
                  <dt>Workflow agents</dt>
                  <dd>
                    <span className="note">{tokens(wf.tokens)} tokens</span>
                    {money(wf.cost)}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {models.length > 0 && (
            <div className="keys">
              {models.map((m, i) => (
                <span className="key" key={m.model}>
                  <i className="sw" style={{ background: i < MAX_SERIES ? SERIES[i] : OTHER }} aria-hidden="true" />
                  {modelLabel(m.model)} <span className="v">{m.priced ? money(m.cost) : '—'}</span>
                </span>
              ))}
            </div>
          )}

          <div className="foot">list-price equivalent{!spend.priced && ' · some tokens unpriced'}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A small ring filled to how much of the context is in use: sky, amber past 80%. */
function ContextRing({ pct }: { pct: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg className="ctxRing" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} className="track" />
      <circle cx="8" cy="8" r={r} className="fill" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  )
}
