import { KeyRound } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  mentionToken,
  type PermissionBehavior,
  type QuestionAnswers,
  type ResolvedMention,
  type SessionEvent,
  type SessionTurnSummary,
} from '../../../shared/protocol.js'
import { parseQuestions } from '../askQuestions.js'
import { useLiveText } from '../hooks.js'
import { openSettings } from '../settings.js'
import { store } from '../store.js'
import { artifactStore, useArtifacts } from '../artifactStore.js'
import { mentionHash, useRefIndex, type RefIndex } from '../refs.js'
import { agentLabel, type AgentRun } from '../agents.js'
import { buildTranscript, type TranscriptItem } from '../transcript.js'
import { AgentCard } from './Agents.js'
import { AskCard } from './AskCard.js'
import { InitCard } from './InitCard.js'
import { MentionChip, MentionIcon } from './MentionPicker.js'
import { Markdown } from './Markdown.js'
import { PermissionCard } from './PermissionCard.js'
import { ToolCard } from './ToolCard.js'
import { BrowserShots } from './BrowserShots.js'
import { ToolGroup } from './ToolGroup.js'

type Props = {
  sessionId: string
  events: readonly SessionEvent[]
  /** per-turn file counts, so a turn marker can say what that turn changed */
  turns?: readonly SessionTurnSummary[]
  onRespond: (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => void
  /** Open an entity a reference chip points at (an app route hash). */
  onNavigate: (hash: string) => void
  /** The session's subagents (buildAgents); with them, each Agent call is drawn as its card. */
  agents?: readonly AgentRun[]
  /** Show only what this subagent did (its Agent tool_use id). Unset = the main agent. */
  scope?: string | null
  /** Open a subagent's view (null = back to main). */
  onOpenAgent?: (toolUseId: string | null) => void
  /** Drawn before the first item and after the last — an agent's brief and how it ended. */
  lead?: ReactNode
  tail?: ReactNode
}

const NO_AGENTS: readonly AgentRun[] = []

/**
 * Who else was touching the repo during this turn, in the width a one-line
 * turn marker has. A session's title is the first line of its first message
 * (up to 80 chars), which is far too long to sit inline, so a single one is
 * clamped and several collapse to a count — the full list is in the tooltip.
 */
const MAX_OVERLAP_CHARS = 32

function overlapLabel(titles: readonly string[]): string {
  if (titles.length > 1) return `${titles.length} other sessions`
  const t = titles[0]
  return t.length > MAX_OVERLAP_CHARS ? `${t.slice(0, MAX_OVERLAP_CHARS - 1).trimEnd()}…` : t
}

export function Transcript({
  sessionId,
  events,
  turns,
  onRespond,
  onNavigate,
  agents = NO_AGENTS,
  scope = null,
  onOpenAgent,
  lead,
  tail,
}: Props) {
  const items = useMemo(() => buildTranscript(events, store.eventTime, { scope, agents }), [events, scope, agents])
  const byCall = useMemo(() => new Map(agents.map((a) => [a.toolUseId, a])), [agents])
  const byAgentId = useMemo(() => new Map(agents.filter((a) => a.agentId).map((a) => [a.agentId!, a])), [agents])
  const openAgent = useCallback((id: string | null) => onOpenAgent?.(id), [onOpenAgent])
  const { ref, scrollToBottom } = useStickToBottom()
  const refs = useRefIndex()
  // Reference chips resolve against the artifacts index, which isn't otherwise
  // loaded while a chat is in front — pull it once so names appear.
  const { loaded } = useArtifacts()
  useEffect(() => {
    if (!loaded) void artifactStore.refresh()
  }, [loaded])

  // Committed events grow the transcript; the streaming line grows it too, but
  // re-renders separately (see LiveLine), so it calls back in here to scroll.
  useLayoutEffect(scrollToBottom, [items, scrollToBottom])

  return (
    <div id="transcript" ref={ref}>
      <div className="inner">
        {lead}
        {items.map((item) => (
          <Item
            key={item.key}
            item={item}
            turn={item.kind === 'meta' && item.turn ? turns?.find((t) => t.seq === item.turn) : undefined}
            agent={
              item.kind === 'agent'
                ? byCall.get(item.toolUseId)
                : item.kind === 'permission' && item.agentId
                  ? byAgentId.get(item.agentId)
                  : item.kind === 'relay'
                    ? byCall.get(item.relay.toolUseId)
                    : undefined
            }
            onOpenAgent={openAgent}
            onRespond={onRespond}
            refs={refs}
            onRef={onNavigate}
            sessionId={sessionId}
          />
        ))}
        {/* The streaming line is the main agent's; an agent's view shows its messages as they commit. */}
        {!scope && <LiveLine sessionId={sessionId} onGrow={scrollToBottom} />}
        {tail}
      </div>
    </div>
  )
}

/**
 * The user's text with each `@` token shown as its label — `@smoke test`
 * rather than `@session:72dce3d1-…` — and clickable when it names something
 * the app can open. Bare ids typed into the text get the same name chips as an
 * agent reply. The stored text keeps the token; only the rendering changes, so
 * a reload shows the same thing.
 */
function withMentionLabels(
  text: string,
  mentions: readonly ResolvedMention[] | undefined,
  refs: RefIndex,
  onRef: (hash: string) => void,
): ReactNode {
  const tokens = (mentions ?? []).map((m) => ({ token: mentionToken(m), label: m.label, hash: mentionHash(m) }))
  const out: ReactNode[] = []
  let rest = text
  let k = 0
  while (rest) {
    let first: { i: number; token: string; label: string; hash: string | null } | null = null
    for (const t of tokens) {
      const i = rest.indexOf(t.token)
      if (i >= 0 && (first === null || i < first.i)) first = { i, ...t }
    }
    if (!first) {
      out.push(...linkifyText(rest, refs, onRef, () => k++))
      break
    }
    if (first.i > 0) out.push(...linkifyText(rest.slice(0, first.i), refs, onRef, () => k++))
    const hash = first.hash
    out.push(
      hash !== null ? (
        <button type="button" className="mtok open" key={k++} title={`Open ${first.label}`} onClick={() => onRef(hash)}>
          @{first.label}
        </button>
      ) : (
        <span className="mtok" key={k++} title={first.token}>
          @{first.label}
        </span>
      ),
    )
    rest = rest.slice(first.i + first.token.length)
  }
  return out
}

/** Plain text with every id the index knows swapped for a name chip; unknown ids stay as typed. */
function linkifyText(text: string, refs: RefIndex, onRef: (hash: string) => void, key: () => number): ReactNode[] {
  const pattern = refs.pattern()
  if (!pattern) return [text]
  const out: ReactNode[] = []
  let last = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const hit = refs.lookup(m[0])
    if (!hit) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <button type="button" className={`refLink ${hit.kind}`} key={key()} title={`Open ${hit.label}`} onClick={() => onRef(hit.hash)}>
        <MentionIcon kind={hit.kind} size={12} />
        <span className="n">{hit.label}</span>
      </button>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * A watch a chat drafted (draft_watch) is off until the user turns it on —
 * so the call's result carries a way there, right under it.
 */
function DraftWatchLinks({ tools, onRef }: { tools: readonly TranscriptItem[]; onRef: (hash: string) => void }) {
  const ids = tools.flatMap((t) => {
    if (t.kind !== 'tool' || !t.name.endsWith('__draft_watch') || !t.result || t.result.isError) return []
    const m = /#(\/watches\/[\w-]+)/.exec(t.result.text)
    return m ? [{ key: t.key, hash: m[1]!, title: typeof t.input.title === 'string' ? t.input.title : 'the watch' }] : []
  })
  if (!ids.length) return null
  return (
    <>
      {ids.map((d) => (
        <div key={d.key} className="draftLink">
          <span className="draftTag">draft</span>
          <span>“{d.title}” is saved off until you enable it.</span>
          <button type="button" className="btn sm primary" onClick={() => onRef(d.hash)}>
            Review and enable
          </button>
        </div>
      ))}
    </>
  )
}

function mentionOpener(m: ResolvedMention, onRef: (hash: string) => void): (() => void) | undefined {
  const hash = mentionHash(m)
  return hash === null ? undefined : () => onRef(hash)
}

const Item = memo(function Item({
  item,
  turn,
  agent,
  onOpenAgent,
  onRespond,
  refs,
  onRef,
  sessionId,
}: {
  item: TranscriptItem
  turn?: SessionTurnSummary
  /** The subagent this item is about: an Agent call's run, a prompt's asker, a relay's recipient. */
  agent?: AgentRun
  onOpenAgent: (toolUseId: string | null) => void
  onRespond: Props['onRespond']
  refs: RefIndex
  onRef: (hash: string) => void
  sessionId: string
}) {
  switch (item.kind) {
    case 'agent':
      return <AgentCard run={agent} onOpen={onOpenAgent} />
    case 'relay':
      return (
        <button type="button" className="relayRow" onClick={() => onOpenAgent(item.relay.toolUseId)} title="Open this agent">
          <span className="rrWho">you → {agent ? agentLabel(agent) : item.relay.label}</span>
          <span className="rrText">{item.text}</span>
          <span className="rrState">{relayNote(item.delivery)}</span>
        </button>
      )
    case 'user':
      if (item.relayed)
        return (
          <div className="msg user">
            {item.text}
            <div className="msgVia" title={item.relayed.delivery === 'reworded' ? `Main sent: ${item.relayed.sent}` : undefined}>
              <span className="mgrGlyph" aria-hidden="true" /> via main · {relayNote(item.relayed.delivery)}
            </div>
          </div>
        )
      // A teammate agent's message: its own card, so it never reads as something the user typed.
      if (item.from)
        return (
          <div className="msg teammate">
            <div className="msgFrom">from {item.from}</div>
            <Markdown text={item.text} refs={refs} onRef={onRef} />
          </div>
        )
      return (
        <div className="msg user">
          {item.images && item.images.length > 0 && (
            <div className="msgImages">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={img.name ?? 'Attached image'}
                  title={img.name}
                />
              ))}
            </div>
          )}
          {withMentionLabels(item.text, item.mentions, refs, onRef)}
          {item.mentions && item.mentions.length > 0 && (
            <div className="msgMentions">
              {item.mentions.map((m) => (
                <MentionChip
                  key={`${m.kind}:${m.ref}`}
                  m={m}
                  muted={!m.inlined}
                  onOpen={mentionOpener(m, onRef)}
                  title={
                    m.error
                      ? `${m.kind === 'file' ? m.ref : m.label} — ${m.error}`
                      : m.kind === 'file'
                        ? `${m.ref}${m.bytes !== undefined ? ` · ${Math.max(1, Math.round(m.bytes / 1024))} KB` : ''}`
                        : m.label
                  }
                />
              ))}
            </div>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className="msg assistant">
          <Markdown text={item.text} refs={refs} onRef={onRef} />
        </div>
      )
    case 'thinking':
      return <div className="msg thinking">{item.text}</div>
    case 'error':
      return <ErrorCard text={item.text} />
    case 'meta':
      // A turn that changed files says so here, where it happened — the drawer
      // below answers "in total", this answers "in this turn".
      return (
        <div className="meta">
          <span className="metaText">{item.text}</span>
          {turn && turn.files > 0 && (
            <span className="turnChange">
              {turn.files} {turn.files === 1 ? 'file' : 'files'} <span className="pl">+{turn.insertions}</span>{' '}
              <span className="mn">−{turn.deletions}</span>
              {turn.overlapped.length > 0 && (
                <span className="warn" title={`Ran at the same time as ${turn.overlapped.join(', ')}`}>
                  {' '}
                  · concurrent with {overlapLabel(turn.overlapped)}
                </span>
              )}
            </span>
          )}
        </div>
      )
    case 'command':
      // Local command output is plain text the CLI already formatted (often
      // with its own alignment), so it is shown as-is rather than as markdown.
      return <pre className="msg commandOut">{item.text}</pre>
    case 'init':
      return <InitCard item={item} />
    case 'tool':
      return (
        <>
          <ToolCard item={item} />
          <DraftWatchLinks tools={[item]} onRef={onRef} />
          <BrowserShots sessionId={sessionId} tools={[item]} />
        </>
      )
    case 'toolGroup':
      return (
        <>
          <ToolGroup item={item} />
          <DraftWatchLinks tools={item.members} onRef={onRef} />
          <BrowserShots sessionId={sessionId} tools={item.members} />
        </>
      )
    case 'permission': {
      // AskUserQuestion arrives as a permission prompt, but it is a question
      // for the reader — render it as choices, not as JSON to approve.
      const questions = item.toolName === 'AskUserQuestion' ? parseQuestions(item.input) : null
      const card = questions ? (
        <AskCard item={item} questions={questions} onRespond={onRespond} />
      ) : (
        <PermissionCard item={item} onRespond={onRespond} />
      )
      // A subagent's prompt says who is asking — answering it here or in its view is the same answer.
      if (!item.agentId) return card
      return (
        <div className="agentAsks">
          <button type="button" className="aaFrom" onClick={() => agent && onOpenAgent(agent.toolUseId)} disabled={!agent}>
            {agent ? `${agent.type} · ${agentLabel(agent)}` : 'a subagent'} asks
          </button>
          {card}
        </div>
      )
    }
  }
})

/** Where a relayed message stands, as far as the transcript can tell. */
function relayNote(d: 'verbatim' | 'reworded' | undefined): string {
  return d === 'verbatim' ? 'delivered' : d === 'reworded' ? 'main reworded it' : 'sent to main'
}

/**
 * The partially-streamed assistant message. Isolated in its own component so a
 * burst of token deltas re-renders this node alone — the rest of the transcript
 * is untouched between committed messages.
 */
function LiveLine({ sessionId, onGrow }: { sessionId: string; onGrow: () => void }) {
  const text = useLiveText(sessionId)
  useLayoutEffect(() => {
    if (text) onGrow()
  }, [text, onGrow])
  if (!text) return null
  return (
    <div className="msg assistant live">
      <Markdown text={text} />
    </div>
  )
}

/** Follows new output, unless the reader has scrolled up to look at something. */
function useStickToBottom() {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [])

  return { ref, scrollToBottom }
}

/**
 * A failed turn. When the text reads like a credentials problem, the card
 * also offers the fix — the Claude auth tab, opened directly.
 */
const AUTH_ERROR = /api[ -]?key|authenticat|unauthori[sz]ed|not logged in|\/login|\b401\b|credential|oauth|token (?:has )?expired|billing|insufficient credits/i

function ErrorCard({ text }: { text: string }) {
  const authy = AUTH_ERROR.test(text)
  return (
    <div className="msg error">
      {text}
      {authy && (
        <div className="fixRow">
          <span>This looks like a Claude auth problem in this workspace.</span>
          <button type="button" className="btn xs" onClick={() => openSettings('providers')}>
            <KeyRound size={11} aria-hidden="true" /> Fix in Settings
          </button>
        </div>
      )}
    </div>
  )
}
