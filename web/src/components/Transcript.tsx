import { KeyRound } from 'lucide-react'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  mentionToken,
  type PermissionBehavior,
  type QuestionAnswers,
  type ResolvedMention,
  type SessionEvent,
  type SessionStatus,
  type SessionTurnSummary,
  type WorkflowAgent,
  type WorkflowRun,
} from '../../../shared/protocol.js'
import type { Mood } from '../../../core/junior/mood.js'
import { parseQuestions } from '../askQuestions.js'
import { useConn, useLiveText } from '../hooks.js'
import type { SessionPaging } from '../paging.js'
import { openSettings } from '../settings.js'
import { store } from '../store.js'
import { artifactStore, useArtifacts } from '../artifactStore.js'
import { mentionHash, useRefIndex, type RefIndex } from '../refs.js'
import { agentLabel, type AgentRun } from '../agents.js'
import type { ShellRun } from '../../../core/shells/fold.js'
import { WORKFLOW_TOOL } from '../../../core/workflows/fold.js'
import { buildTranscript, eventIndexOf, formatDuration, toolLine, type TranscriptItem } from '../transcript.js'
import { AgentCard } from './Agents.js'
import { WorkflowCard } from './ultracode/WorkflowCard.js'
import { WorkflowApproval } from './ultracode/WorkflowApproval.js'
import { AskCard } from './AskCard.js'
import { InitCard } from './InitCard.js'
import { ChatFace, type Say } from './JuniorLabel.js'
import { usePersona } from '../junior.js'
import { MentionChip, MentionIcon } from './MentionPicker.js'
import { Markdown } from './Markdown.js'
import { PermissionCard, PlanCard } from './PermissionCard.js'
import { ToolCard } from './ToolCard.js'
import { ArtifactCard } from './ArtifactCard.js'
import { BrowserShots } from './BrowserShots.js'
import { FileChip } from './AttachmentStrip.js'
import { ToolGroup } from './ToolGroup.js'
import { ActionNotes } from './ActionCard.js'
import { RuleCards } from './RuleCard.js'
import { LearnedLines } from './LearnedLine.js'
import { useActions } from '../actions.js'
import type { ActionView } from '../../../shared/protocol.js'

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
  /** The session's shells (buildShells); folded from `events` when not given. */
  shells?: readonly ShellRun[]
  /** Show only what this subagent did (its Agent tool_use id). Unset = the main agent. */
  scope?: string | null
  /** Open a subagent's view (null = back to main). */
  onOpenAgent?: (toolUseId: string | null) => void
  /** Drawn before the first item and after the last. An agent's brief and how it ended. */
  lead?: ReactNode
  tail?: ReactNode
  /** Drawn before the first item folded from event `at` (0-based) or later, a team run's dividers. */
  marks?: readonly TranscriptMark[]
  /** Junior is the one talking (a Claude session's main view): each of its turns opens with its face and name. */
  speaker?: { status: SessionStatus }
  /** The session's Ultracode runs (buildWorkflows); with them, each Workflow call is drawn as its card. */
  workflows?: readonly WorkflowRun[]
  /** Open a run's panel, or one of its agents. */
  onOpenWorkflow?: (toolUseId: string, agent?: WorkflowAgent) => void
  /** When each event happened. Defaults to the store's clock; fetched events bring their own. */
  timeOf?: (ev: SessionEvent) => number | undefined
  /** Leave out the streaming line: the events aren't the session's main stream (a workflow agent's). */
  noLive?: boolean
  /** A paged log (store.getPaging): where `events` starts in the whole log, and the older-page state. Unset = whole. */
  paging?: SessionPaging | null
  /** Ask for the page before the oldest one held, and again after a failure. */
  onLoadEarlier?: (sessionId: string) => void
  onRetryEarlier?: (sessionId: string) => void
}

export type TranscriptMark = { at: number; key: string; node: ReactNode }
const NO_MARKS: readonly TranscriptMark[] = []

const NO_AGENTS: readonly AgentRun[] = []
const NO_WORKFLOWS: readonly WorkflowRun[] = []

/** What Junior says or does in a turn. Anything else (your messages, markers, CLI output) isn't its. */
const JUNIOR_KINDS = new Set<TranscriptItem['kind']>(['assistant', 'thinking', 'tool', 'toolGroup', 'agent', 'workflow', 'artifact', 'permission', 'error'])

/** A word for what a call is doing, for the working face's bubble ("Editing Transcript.tsx…"). */
const DOING: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Bash: 'Running',
  Grep: 'Searching for',
  Glob: 'Looking for',
  WebFetch: 'Reading',
  WebSearch: 'Searching the web for',
  Agent: 'Handing off',
  Task: 'Handing off',
}

type Turn = { mood: Mood; say: Say }

/** The sign-off word on a turn whose Workflow run is still going: the turn ended, the work didn't. */
const RUN_GOING = 'agents at work'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Which items open a Junior turn, the mood each turn's face shows, and what
 * its speech bubble says. A turn is the run of Junior's items between your
 * messages and turn markers. Needs you while a prompt in it waits, working
 * while it is the live one or a run it launched is still going, stuck when it
 * errored, done otherwise. `thinking` = live with nothing from Junior yet.
 * `going` = the turn markers of turns whose run is still going, so their
 * sign-off doesn't say "done".
 */
function speakerTurns(
  items: readonly TranscriptItem[],
  live: boolean,
  turns: readonly SessionTurnSummary[] | undefined,
  runningCalls: ReadonlySet<string>,
): { at: Map<string, Turn>; thinking: boolean; going: Set<string> } {
  type Seg = { first?: string; items: TranscriptItem[]; end?: Extract<TranscriptItem, { kind: 'meta' }> }
  const segs: Seg[] = []
  let seg: Seg = { items: [] }
  for (const it of items) {
    if (it.kind === 'user' || it.kind === 'relay' || (it.kind === 'meta' && it.turn)) {
      if (it.kind === 'meta') seg.end = it
      if (seg.first) segs.push(seg)
      seg = { items: [] }
      continue
    }
    if (!JUNIOR_KINDS.has(it.kind)) continue
    seg.first ??= it.key
    seg.items.push(it)
  }
  const open = seg.first ? seg : null
  if (open) segs.push(open)

  const at = new Map<string, Turn>()
  const going = new Set<string>()
  for (const s of segs) {
    const runGoing = s.items.some((it) => it.kind === 'workflow' && runningCalls.has(it.toolUseId))
    if (runGoing && s.end) going.add(s.end.key)
    const pending = s.items.findLast((it) => it.kind === 'permission' && !it.resolved && !it.agentId)
    const tools = s.items.flatMap((it) => (it.kind === 'tool' ? [it] : it.kind === 'artifact' ? [it.call] : it.kind === 'toolGroup' ? it.members.filter((m) => m.kind === 'tool') : []))
    let turn: Turn
    if (pending && pending.kind === 'permission') {
      const what = pending.toolName === 'AskUserQuestion' ? 'your answer' : pending.toolName === 'ExitPlanMode' ? 'you to review the plan' : 'your OK'
      turn = { mood: 'needs', say: { line: `Waiting on ${what}`, sub: 'click me to jump to it ↓' } }
    } else if (live && s === open) {
      const last = s.items[s.items.length - 1]
      const call = tools[tools.length - 1]
      if (last?.kind === 'assistant') turn = { mood: 'working', say: { line: 'On it', sub: 'writing to you…' } }
      else if (last?.kind === 'workflow') turn = { mood: 'working', say: { line: 'On it', sub: 'handing out work to agents…' } }
      else if (call && call.kind === 'tool') {
        const { verb, target } = toolLine(call.name, call.input)
        turn = { mood: 'working', say: { line: 'On it', sub: `${DOING[call.name] ?? verb}${target ? ` ${target}` : ''}…` } }
      } else turn = { mood: 'working', say: { line: 'On it', sub: 'working…' } }
    } else if (s.items.some((it) => it.kind === 'error')) {
      turn = { mood: 'stuck', say: { line: 'That failed', sub: 'the error’s below' } }
    } else if (runGoing) {
      // The Workflow call answers at once, so the turn ends while its agents work on.
      turn = { mood: 'working', say: { line: 'On it', sub: `${RUN_GOING}…` } }
    } else {
      const files = s.end?.changes ? (turns?.find((t) => t.seq === s.end!.changes)?.files ?? 0) : 0
      const facts: string[] = []
      if (tools.length) facts.push(plural(tools.length, 'step'))
      if (files) facts.push(`${plural(files, 'file')} changed`)
      turn = { mood: 'done', say: { line: s.end?.ms != null ? `Done in ${formatDuration(s.end.ms)}` : 'Done', sub: facts.join(' · ') || undefined } }
    }
    at.set(s.first!, turn)
  }
  return { at, thinking: live && !open, going }
}

/** Scroll to the newest card still waiting on you, where the needs-you face points. */
function jumpToWaiting(from: Element | null) {
  const cards = from?.closest('#transcript')?.querySelectorAll('.perm:has(.actions), .perm.ask:has(.askOptions)')
  cards?.[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * A Junior turn's first line: its face in the turn's mood out in the margin
 * left of the column (inline, smaller, where the column has no margin), then
 * its name and what it's doing or when it spoke.
 */
function Speaker({ mood, say, at }: { mood: Mood; say: Say; at?: number }) {
  const persona = usePersona()
  const self = useRef<HTMLDivElement>(null)
  const note = mood === 'needs' ? 'needs you' : mood === 'working' ? 'is working' : mood === 'think' ? 'is thinking' : mood === 'stuck' ? 'got stuck' : null
  return (
    <div className="speaker" ref={self}>
      <span className="spFace">
        <ChatFace mood={mood} size={38} say={say} onClick={mood === 'needs' ? () => jumpToWaiting(self.current) : undefined} />
      </span>
      <span className="spWho">{persona.name}</span>
      {note && <span className={`spNote ${mood}`}>{note}</span>}
      {at !== undefined && <time className="spAt">{clock(at)}</time>}
    </div>
  )
}

/** A turn's end as Junior's sign-off: "done · 32.2s · 9 turns · $0.80", the word in Junior's colour. */
function SignOff({ stats, word = 'done' }: { stats: string; word?: string }) {
  const persona = usePersona()
  return (
    <span className="metaText">
      <span className="soDone" style={{ color: persona.colour }}>
        {word}
      </span>{' '}
      · {stats}
    </span>
  )
}

/**
 * Who else was touching the repo during this turn, in the width a one-line
 * turn marker has. A session's title is the first line of its first message
 * (up to 80 chars), which is far too long to sit inline, so a single one is
 * clamped and several collapse to a count. The full list is in the tooltip.
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
  shells,
  scope = null,
  onOpenAgent,
  lead,
  tail,
  marks = NO_MARKS,
  speaker,
  workflows = NO_WORKFLOWS,
  onOpenWorkflow,
  timeOf = store.eventTime,
  noLive,
  paging = null,
  onLoadEarlier,
  onRetryEarlier,
}: Props) {
  // A paged log counts from where the held part starts, so keys survive a prepend;
  // `midway` leaves off what only the start of the log can tell.
  const base = paging?.base ?? 0
  const midway = paging?.hasEarlier ?? false
  const items = useMemo(() => buildTranscript(events, timeOf, { scope, agents, shells, base, midway }), [events, timeOf, scope, agents, shells, base, midway])
  const byCall = useMemo(() => new Map(agents.map((a) => [a.toolUseId, a])), [agents])
  const byAgentId = useMemo(() => new Map(agents.filter((a) => a.agentId).map((a) => [a.agentId!, a])), [agents])
  const openAgent = useCallback((id: string | null) => onOpenAgent?.(id), [onOpenAgent])
  const runByCall = useMemo(() => new Map(workflows.map((r) => [r.toolUseId, r])), [workflows])
  // A workflow agent can raise a prompt too: by its id, the run and agent it is.
  const wfByAgentId = useMemo(() => {
    const m = new Map<string, WfAsker>()
    for (const run of workflows) for (const agent of run.agents) if (agent.agentId) m.set(agent.agentId, { run, agent })
    return m
  }, [workflows])
  // By the agent's id, else the run the server named, else (an agent no progress
  // frame has named yet, and no subagent either) the run going on now.
  const wfAskerOf = (agentId: string, taskId: string | undefined): WfAsker | undefined => {
    const known = wfByAgentId.get(agentId)
    if (known) return known
    const run = (taskId ? workflows.find((r) => r.taskId === taskId) : undefined) ?? workflows.findLast((r) => r.state === 'running')
    return run ? { run } : undefined
  }
  const openWorkflow = useCallback((id: string, agent?: WorkflowAgent) => onOpenWorkflow?.(id, agent), [onOpenWorkflow])
  // Outbound actions this session took, by the tool call that made each one, 
  // drawn as a line under that call (a collapsed push names several calls).
  const { actions } = useActions({ session: sessionId })
  const actionByCall = useMemo(() => {
    const m = new Map<string, ActionView>()
    for (const a of actions) for (const c of a.calls) m.set(c, a)
    return m
  }, [actions])
  const { ref, scrollToBottom } = useStickToBottom(`${sessionId}:${scope ?? ''}`, base, midway)
  const refs = useRefIndex()
  // Reference chips resolve against the artifacts index, which isn't otherwise
  // loaded while a chat is in front, pull it once so names appear.
  const { loaded } = useArtifacts()
  useEffect(() => {
    if (!loaded) void artifactStore.refresh()
  }, [loaded])

  // Committed events grow the transcript; the streaming line grows it too, but
  // re-renders separately (see LiveLine), so it calls back in here to scroll.
  useLayoutEffect(scrollToBottom, [items, scrollToBottom])

  const live = speaker?.status === 'running' || speaker?.status === 'starting'
  const runningCalls = useMemo(() => new Set(workflows.filter((r) => r.state === 'running').map((r) => r.toolUseId)), [workflows])
  const moods = useMemo(() => (speaker ? speakerTurns(items, live, turns, runningCalls) : null), [items, live, turns, runningCalls, !!speaker])
  const timeAt = (item: TranscriptItem) => {
    const ev = events[eventIndexOf(item) - base]
    return ev ? timeOf(ev) : undefined
  }

  // Each mark goes before the first item at or past its event; one past every item goes last.
  const marksBefore = useMemo(() => {
    const m = new Map<string, TranscriptMark[]>()
    const tailMarks: TranscriptMark[] = []
    for (const mark of [...marks].sort((x, y) => x.at - y.at)) {
      // A divider whose event is on a page not loaded yet would land at the top, in the wrong place.
      if (midway && mark.at < base) continue
      const item = items.find((it) => eventIndexOf(it) >= mark.at)
      if (!item) tailMarks.push(mark)
      else m.set(item.key, [...(m.get(item.key) ?? []), mark])
    }
    return { m, tailMarks }
  }, [items, marks, midway, base])

  return (
    <div id="transcript" ref={ref}>
      <div className="inner">
        {!scope && paging?.hasEarlier && (
          <EarlierRow
            state={paging.state}
            base={paging.base}
            onLoad={() => onLoadEarlier?.(sessionId)}
            onRetry={() => onRetryEarlier?.(sessionId)}
          />
        )}
        {!scope && paging && <PagingStatus paging={paging} />}
        {lead}
        {items.map((item) => (
          <Fragment key={item.key}>
          {marksBefore.m.get(item.key)?.map((x) => <Fragment key={x.key}>{x.node}</Fragment>)}
          {moods?.at.has(item.key) && <Speaker {...moods.at.get(item.key)!} at={timeAt(item)} />}
          <Item
            item={item}
            turn={item.kind === 'meta' && item.changes ? turns?.find((t) => t.seq === item.changes) : undefined}
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
            workflow={item.kind === 'workflow' ? runByCall.get(item.toolUseId) : undefined}
            wfAsker={item.kind === 'permission' && item.agentId && !byAgentId.has(item.agentId) ? wfAskerOf(item.agentId, item.workflowTaskId) : undefined}
            onOpenWorkflow={onOpenWorkflow ? openWorkflow : undefined}
            onRespond={onRespond}
            refs={refs}
            onRef={onNavigate}
            sessionId={sessionId}
            actionByCall={actionByCall}
            signoff={!speaker ? undefined : moods?.going.has(item.key) ? RUN_GOING : 'done'}
          />
          </Fragment>
        ))}
        {marksBefore.tailMarks.map((x) => <Fragment key={x.key}>{x.node}</Fragment>)}
        {/* The streaming line is the main agent's; an agent's view shows its messages as they commit. */}
        {moods?.thinking && <Speaker mood="think" say={{ line: 'Thinking…', sub: 'reading your message' }} />}
        {!scope && !noLive && <LiveLine sessionId={sessionId} onGrow={scrollToBottom} />}
        {tail}
      </div>
    </div>
  )
}

/**
 * The user's text with each `@` token shown as its label, `@smoke test`
 * rather than `@session:72dce3d1-…`, and clickable when it names something
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
 * A job a chat drafted (draft_job) is off until the user turns it on,
 * so the call's result carries a way there, right under it.
 */
function DraftJobLinks({ tools, onRef }: { tools: readonly TranscriptItem[]; onRef: (hash: string) => void }) {
  const ids = tools.flatMap((t) => {
    if (t.kind !== 'tool' || !t.name.endsWith('__draft_job') || !t.result || t.result.isError) return []
    const m = /#(\/jobs\/[\w-]+)/.exec(t.result.text)
    return m ? [{ key: t.key, hash: m[1]!, title: typeof t.input.title === 'string' ? t.input.title : 'the job' }] : []
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

type WfAsker = { run: WorkflowRun; agent?: WorkflowAgent }

const Item = memo(function Item({
  item,
  turn,
  agent,
  onOpenAgent,
  workflow,
  wfAsker,
  onOpenWorkflow,
  onRespond,
  refs,
  onRef,
  sessionId,
  actionByCall,
  signoff,
}: {
  item: TranscriptItem
  turn?: SessionTurnSummary
  /** The subagent this item is about: an Agent call's run, a prompt's asker, a relay's recipient. */
  agent?: AgentRun
  onOpenAgent: (toolUseId: string | null) => void
  /** A Workflow call's run. */
  workflow?: WorkflowRun
  /** A prompt raised by a workflow agent: which run and agent. */
  wfAsker?: WfAsker
  /** Absent where a run can't be opened (inside one of its agents' views). */
  onOpenWorkflow?: (toolUseId: string, agent?: WorkflowAgent) => void
  onRespond: Props['onRespond']
  refs: RefIndex
  onRef: (hash: string) => void
  sessionId: string
  /** this session's outbound actions, by tool_use id */
  actionByCall: ReadonlyMap<string, ActionView>
  /** a turn's end reads as Junior's sign-off ("done · 32s · …") rather than "turn done": the word it opens with */
  signoff?: string
}) {
  switch (item.kind) {
    case 'agent':
      return <AgentCard run={agent} onOpen={onOpenAgent} />
    case 'artifact':
      return <ArtifactCard item={item} onOpen={onRef} />
    case 'workflow':
      return <WorkflowCard sessionId={sessionId} run={workflow} onOpen={onOpenWorkflow} />
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
            <div className="msgFrom">
              from{' '}
              {item.fromSession ? (
                // Another chat (start_session / message_session): open it.
                <button type="button" className="msgFromLink" title="Open the chat that sent this" onClick={() => onRef(item.fromSession!)}>
                  {item.from}
                </button>
              ) : (
                item.from
              )}
            </div>
            <Markdown text={item.text} refs={refs} onRef={onRef} />
          </div>
        )
      return (
        <div className="msg user">
          {item.mode === 'goal' && (
            <div className="msgMode" title="Sent in Goal mode: Junior proposes a team with a done-when">
              Goal
            </div>
          )}
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
          {item.files && item.files.length > 0 && (
            <div className="msgFiles">
              {item.files.map((f) => (
                <FileChip key={f.id} file={f} />
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
      // A turn that changed files says so here, where it happened, the drawer
      // below answers "in total", this answers "in this turn".
      return (
        <div className={`meta${signoff && item.stats ? ' signoff' : ''}`}>
          {signoff && item.stats ? (
            <SignOff stats={item.stats} word={signoff} />
          ) : (
            <span className="metaText" title={item.text}>
              {item.text}
            </span>
          )}
          {item.workflowSpend && (
            <span className="metaWf" title="Workflow agents worked during this turn. Its cost may include some of theirs.">
              incl. workflow agents
            </span>
          )}
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
          <ToolCard sessionId={sessionId} item={item} />
          <ActionNotes tools={[item]} byCall={actionByCall} onNavigate={onRef} />
          <DraftJobLinks tools={[item]} onRef={onRef} />
          <RuleCards sessionId={sessionId} tools={[item]} />
          <LearnedLines tools={[item]} />
          <BrowserShots sessionId={sessionId} tools={[item]} />
        </>
      )
    case 'toolGroup':
      return (
        <>
          <ToolGroup sessionId={sessionId} item={item} />
          <ActionNotes tools={item.members} byCall={actionByCall} onNavigate={onRef} />
          <DraftJobLinks tools={item.members} onRef={onRef} />
          <RuleCards sessionId={sessionId} tools={item.members} />
          <LearnedLines tools={item.members} />
          <BrowserShots sessionId={sessionId} tools={item.members} />
        </>
      )
    case 'permission': {
      // AskUserQuestion arrives as a permission prompt, but it is a question
      // for the reader: render it as choices, not as JSON to approve.
      const questions = item.toolName === 'AskUserQuestion' ? parseQuestions(item.input) : null
      // Plan mode's plan, to approve like a PR, read as the document it is.
      const plan = item.toolName === 'ExitPlanMode' && typeof item.input?.plan === 'string' ? item.input.plan : null
      // Junior is asking unless a subagent is, then the wrapper below names it.
      const junior = !item.agentId
      const card = questions ? (
        <AskCard item={item} questions={questions} onRespond={onRespond} junior={junior} />
      ) : plan !== null ? (
        <PlanCard item={item} plan={plan} refs={refs} onRef={onRef} onRespond={onRespond} junior={junior} />
      ) : item.toolName === WORKFLOW_TOOL ? (
        <WorkflowApproval item={item} onRespond={onRespond} junior={junior} />
      ) : (
        <PermissionCard item={item} onRespond={onRespond} junior={junior} />
      )
      // A subagent's prompt says who is asking, answering it here or in its view is the same answer.
      if (!item.agentId) return card
      if (!agent && wfAsker) {
        const who = `${wfAsker.run.name} · ${wfAsker.agent?.label ?? 'a workflow agent'} asks`
        return (
          <div className="agentAsks">
            {onOpenWorkflow ? (
              <button type="button" className="aaFrom" onClick={() => onOpenWorkflow(wfAsker.run.toolUseId, wfAsker.agent)} title={wfAsker.agent ? 'Open this workflow agent' : 'Open this run'}>
                {who}
              </button>
            ) : (
              <span className="aaFrom static">{who}</span>
            )}
            {card}
          </div>
        )
      }
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
 * burst of token deltas re-renders this node alone. The rest of the transcript
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

/**
 * The quiet row above a paged transcript's first item: older messages load by
 * themselves when it comes within a screen of view, and its button does the
 * same for a keyboard, a screen reader, or a slow link. Nothing here needs
 * you, so it's ink and hairlines, no colour.
 */
function EarlierRow({ state, base, onLoad, onRetry }: { state: SessionPaging['state']; base: number; onLoad: () => void; onRetry: () => void }) {
  const self = useRef<HTMLDivElement>(null)
  const conn = useConn()
  const latest = useRef({ state, onLoad })
  latest.current = { state, onLoad }

  // Within one screen above the visible part, measured now: an observer's
  // answer lags a commit, and right after a page lands the row has just
  // moved up out of range (the reader's place is kept), so a stale "in view"
  // would chain-load the whole log.
  const near = useCallback(() => {
    const row = self.current
    const root = row?.closest('#transcript')
    if (!row || !root) return false
    const r = root.getBoundingClientRect()
    if (r.height === 0) return false
    const b = row.getBoundingClientRect()
    return b.bottom >= r.top - r.height && b.top <= r.bottom
  }, [])

  // Scrolling it into range: the observer only says when to look.
  useEffect(() => {
    const row = self.current
    const root = row?.closest('#transcript')
    if (!row || !root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && latest.current.state === 'idle' && near()) latest.current.onLoad()
      },
      { root, rootMargin: '100% 0px 0px 0px' },
    )
    io.observe(row)
    return () => io.disconnect()
  }, [near])

  // After each page (and on a reconnect), still in range: the next page. A
  // short page on a tall screen chains one page at a time this way.
  useEffect(() => {
    if (state === 'idle' && conn === 'connected' && near()) onLoad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, base, conn, near])

  // Failing swaps the button for Try again, and retrying swaps it back: keep
  // focus in the row when it was there, rather than dropping it on the page.
  const focused = useRef(false)
  useLayoutEffect(() => {
    const row = self.current
    if (!row || !focused.current || row.contains(document.activeElement)) return
    row.querySelector<HTMLButtonElement>('button')?.focus()
  }, [state])

  const loading = state === 'loading'
  return (
    <div
      ref={self}
      className={`earlier ${state}`}
      aria-busy={loading || undefined}
      onFocus={() => (focused.current = true)}
      onBlur={(e) => {
        const row = e.currentTarget
        if (e.relatedTarget) focused.current = row.contains(e.relatedTarget as Node)
        // No next target: a click on nothing, or the focused button being swapped
        // out. Decide after the swap's layout effect has had its chance.
        else requestAnimationFrame(() => (focused.current = row.contains(document.activeElement)))
      }}
    >
      {state === 'failed' ? (
        <>
          <span className="earlierNote">
            <span className="long">Couldn't load earlier messages.</span>
            <span className="short">Couldn't load.</span>
          </span>
          <button type="button" className="btn xs" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <button
          type="button"
          className="earlierBtn"
          aria-label={loading ? undefined : 'Load earlier messages'}
          aria-disabled={loading || undefined}
          onClick={() => !loading && onLoad()}
        >
          {loading ? 'Loading earlier messages…' : 'Earlier messages'}
        </button>
      )}
    </div>
  )
}

/**
 * Screen readers hear each page land, and the start. Outlives the row, which
 * goes away once the start is loaded.
 */
function PagingStatus({ paging }: { paging: SessionPaging }) {
  const [say, setSay] = useState('')
  const seen = useRef(paging)
  useEffect(() => {
    const was = seen.current
    seen.current = paging
    if (paging.base >= was.base) return
    setSay(paging.hasEarlier ? 'Earlier messages loaded.' : 'This is the start of the chat.')
  }, [paging])
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {say}
    </div>
  )
}

/**
 * Where the reader left each transcript they scrolled up in, so coming back
 * lands there: as distance from the bottom, which an older page landing on
 * top doesn't change.
 */
const scrolledTo = new Map<string, number>()

/**
 * Follows new output, unless the reader has scrolled up to look at something.
 * And keeps the reader's place when an older page lands above (`base` drops):
 * the distance from the bottom is recorded on every scroll, resize and
 * commit, and put back before paint. `#transcript` has `overflow-anchor:
 * none`, so the browser's own anchoring never adds a second correction, and
 * iOS Safari, which has none, behaves the same.
 */
function useStickToBottom(memo: string, base: number, moreAbove: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const restore = useRef(scrolledTo.get(memo) ?? null)
  const stuck = useRef(restore.current === null)
  /** scrollHeight − scrollTop as of the last scroll, resize or commit */
  const fromBottom = useRef<number | null>(null)
  const lastBase = useRef(base)
  const more = useRef(moreAbove)
  more.current = moreAbove

  const record = useCallback(() => {
    const el = ref.current
    if (el) fromBottom.current = el.scrollHeight - el.scrollTop
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      restore.current = null
      record()
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      if (stuck.current) scrolledTo.delete(memo)
      else scrolledTo.set(memo, el.scrollHeight - el.scrollTop)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Content that grows without a scroll (a card opening, an image loading)
    // moves the bottom: keep the record current, or a prepend lands off by it.
    const inner = el.firstElementChild
    const ro = typeof ResizeObserver === 'undefined' || !inner ? null : new ResizeObserver(record)
    if (ro && inner) ro.observe(inner)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [memo, record])

  // An older page landed on top: put the reader back where they were, before paint.
  useLayoutEffect(() => {
    const el = ref.current
    const dropped = base < lastBase.current
    lastBase.current = base
    // Still waiting to land on a saved spot: stay at the top, where the row
    // keeps loading pages until there is room for it (scrollToBottom below).
    if (!el || !dropped || fromBottom.current === null || stuck.current || restore.current !== null) return
    el.scrollTop = el.scrollHeight - fromBottom.current
  }, [base])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (restore.current !== null) {
      const top = el.scrollHeight - restore.current
      // The events may still be loading (or older pages still coming): hold
      // the spot until there is room for it. At the start with no room, stay put.
      if (top < 0) {
        if (!more.current && el.scrollHeight > el.clientHeight) restore.current = null
        record()
        return
      }
      el.scrollTop = top
      restore.current = null
      record()
      return
    }
    if (stuck.current) el.scrollTop = el.scrollHeight
    record()
  }, [record])

  return { ref, scrollToBottom }
}

/**
 * A failed turn. When the text reads like a credentials problem, the card
 * also offers the fix. The Claude auth tab, opened directly.
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
