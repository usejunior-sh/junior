/**
 * A thread beside Junior's chat (.docs/redesign-b2-plan.md): one task, one
 * agent, a clean start. The brief Junior wrote sits on top ("What Junior told
 * Reviewer"), then the thread itself, then a box to reply in it. Open full
 * size for the folder, model, terminal and browser.
 */
import { Maximize2, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { threadState } from '../../../core/junior/threads.js'
import type { EffortLevel, ImageAttachment, Mention, PermissionBehavior, QuestionAnswers } from '../../../shared/protocol.js'
import { SessionAgentScope, useChatAgents } from '../chatAgents.js'
import { composerDrafts } from '../composerDrafts.js'
import { useEvents, useSessions } from '../hooks.js'
import { usePersona } from '../junior.js'
import { store } from '../store.js'
import { useIsMobile } from '../useMobile.js'
import { type SplitOptions, useSplit } from './browser/paneHooks.js'
import { Composer } from './Composer.js'
import { JuniorFace } from './JuniorFace.js'
import { STATE_WORDS } from './ThreadCards.js'
import { Transcript } from './Transcript.js'

type Props = {
  sessionId: string
  onClose: () => void
  /** open the thread full size, with its folder, model and tools */
  onFull: () => void
  onNavigate: (hash: string) => void
}

/** Dragged from its left edge; the chat beside it keeps 380px, the sheet takes at most 70%. */
const SHEET_SPLIT: SplitOptions = { key: 'junior.threadSheetWidth', fallback: 0.46, paneMin: 360, chatMin: 380, maxShare: 0.7 }

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function ThreadSheet({ sessionId, onClose, onFull, onNavigate }: Props) {
  const sessions = useSessions()
  const agents = useChatAgents()
  const persona = usePersona()
  const s = sessions.find((x) => x.id === sessionId) ?? null
  const events = useEvents(sessionId)
  // Its history, beside the chat in front; live events reach this client anyway.
  useEffect(() => store.followSession(sessionId), [sessionId])
  const mobile = useIsMobile()
  const sheetRef = useRef<HTMLElement>(null)
  const split = useSplit(sheetRef, SHEET_SPLIT)

  const ops = useMemo(
    () => ({
      respond: (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => store.send({ type: 'permission_response', sessionId, requestId, behavior, answers }),
      message: (text: string, images?: ImageAttachment[], mentions?: Mention[], _mode?: 'goal', files?: string[]) =>
        store.send({ type: 'user_message', sessionId, text, images, ...(files ? { files } : {}), mentions }),
    }),
    [sessionId],
  )

  if (!s) {
    return (
      <aside className="threadSheet" aria-label="Thread">
        <header className="tshHead">
          <span className="tshT">
            <b>Thread</b>
            <span>This thread was deleted.</span>
          </span>
          <button type="button" className="iconBtn" aria-label="Close the thread" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
      </aside>
    )
  }

  const agent = s.agent ? agents.find((a) => a.name === s.agent) : undefined
  const who = agent?.label ?? persona.name
  const state = threadState(s)
  const firstAt = events.length ? undefined : s.updatedAt

  return (
    <SessionAgentScope agent={s.agent}>
    <aside
      ref={sheetRef}
      className="threadSheet"
      aria-label={`Thread: ${s.title}`}
      style={!mobile && split.custom ? { width: `${(split.fraction * 100).toFixed(2)}%` } : undefined}
    >
      {!mobile && (
        <div
          className="bpResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the thread (double-click to reset)"
          title="Drag to resize · double-click to reset"
          tabIndex={0}
          {...split.handleProps}
        />
      )}
      <header className="tshHead">
        <JuniorFace mood={state === 'you' ? 'needs' : state === 'working' ? 'working' : state === 'stopped' ? 'stuck' : 'hello'} size={36} motion="wander" colour={agent?.colour ?? undefined} decorative />
        <span className="tshT">
          <b>{s.title}</b>
          <span>
            {who} · <span className={`tcState ${state}`}>{STATE_WORDS[state]}</span>
            {firstAt ? ` · ${clock(firstAt)}` : ''}
          </span>
        </span>
        <button type="button" className="iconBtn" title="Open full size: folder, model, terminal, browser" aria-label="Open full size" onClick={onFull}>
          <Maximize2 size={15} aria-hidden="true" />
        </button>
        <button type="button" className="iconBtn" title="Close (Esc)" aria-label="Close the thread" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="tshBody">
        <Transcript
          key={sessionId}
          sessionId={sessionId}
          events={events}
          onRespond={ops.respond}
          onNavigate={onNavigate}
          brief={s.startedBy ? { from: persona.name, to: who, onEdit: () => composerDrafts.set(sessionId, 'A correction to your brief: ') } : undefined}
          speaker={(s.provider ?? 'claude') === 'claude' ? { status: s.status } : undefined}
        />
      </div>
      <Composer
        key={`thread-composer-${sessionId}`}
        placeholder={`Reply to ${who}…`}
        sessionId={sessionId}
        status={s.status}
        cwd={s.cwd}
        projectId={s.projectId}
        model={s.model}
        effort={s.effort}
        fastMode={s.fastMode}
        planning={s.planning}
        ultracode={s.ultracode}
        provider={s.provider ?? 'claude'}
        onSend={ops.message}
        onPlanningChange={(planning) => store.send({ type: 'set_session_mode', sessionId, mode: planning ? 'plan' : 'normal' })}
        onInterrupt={() => store.send({ type: 'interrupt', sessionId })}
        onModelChange={(model: string | undefined, effort: EffortLevel | undefined) => store.send({ type: 'set_model', sessionId, model, effort })}
        onFastModeChange={(fastMode) => store.send({ type: 'set_fast_mode', sessionId, fastMode })}
      />
    </aside>
    </SessionAgentScope>
  )
}
