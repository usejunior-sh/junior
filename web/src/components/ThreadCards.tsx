/**
 * Threads in Junior's chat (.docs/redesign-b2-plan.md): where Junior handed a
 * task to an agent (start_session) or added to one (message_session), one card
 * per thread, kept current from the session list: working, needs you, ready.
 * A click opens the thread beside the chat (ThreadOpenContext), or full size
 * where there is no chat to sit beside.
 */
import { createContext, useContext } from 'react'
import { threadState, type ThreadState } from '../../../core/junior/threads.js'
import { useChatAgents } from '../chatAgents.js'
import { useSessions } from '../hooks.js'
import { usePersona } from '../junior.js'
import type { TranscriptItem } from '../transcript.js'
import { JuniorFace } from './JuniorFace.js'
import { PinThreadButton, ThreadPinMenu } from './PinThread.js'

/** Opens a thread: beside Junior's chat at home, full size elsewhere. Unset = go to the session. */
export const ThreadOpenContext = createContext<((sessionId: string) => void) | null>(null)

export function useOpenThread(): (sessionId: string) => void {
  const open = useContext(ThreadOpenContext)
  return open ?? ((id: string) => (location.hash = id))
}

type Started = { id: string; name: string; title: string }
type Ref = { key: string; kind: 'started'; started: Started; attached: number } | { key: string; kind: 'pending'; title: string } | { key: string; kind: 'failed'; name: string; error: string } | { key: string; kind: 'added'; name: string; attached: number }

/** How many files went with a hand-off: its `attachments` list. */
export const attachedCount = (v: unknown): number => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.trim()).length : 0)
const attachedWords = (n: number): string => (n ? ` · ${n} attached` : '')

/** What a start_session result says: `{ started: [...] }`, each a thread or an error. */
export function startedOf(text: string): (Started | { name: string; error: string })[] {
  try {
    const body = JSON.parse(text) as { started?: unknown }
    if (!Array.isArray(body.started)) return []
    return body.started.flatMap((x): (Started | { name: string; error: string })[] => {
      if (!x || typeof x !== 'object') return []
      const r = x as Record<string, unknown>
      if (typeof r.error === 'string' && typeof r.name === 'string') return [{ name: r.name, error: r.error }]
      if (typeof r.id === 'string' && typeof r.name === 'string') return [{ id: r.id, name: r.name, title: typeof r.title === 'string' ? r.title : r.name }]
      return []
    })
  } catch {
    return []
  }
}

function refsIn(tools: readonly TranscriptItem[]): Ref[] {
  return tools.flatMap((t): Ref[] => {
    if (t.kind !== 'tool') return []
    if (t.name.endsWith('__start_session')) {
      if (!t.result) {
        const specs = Array.isArray(t.input.sessions) ? (t.input.sessions as Record<string, unknown>[]) : []
        return specs.map((s, i) => ({ key: `${t.key}.${i}`, kind: 'pending' as const, title: String(s.title ?? s.name ?? 'A thread') }))
      }
      if (t.result.isError) return []
      // One result per spec, in order, so the spec at the same index says what went with it.
      const specs = Array.isArray(t.input.sessions) ? (t.input.sessions as Record<string, unknown>[]) : []
      return startedOf(t.result.text).map((s, i) => ('error' in s ? { key: `${t.key}.${i}`, kind: 'failed' as const, name: s.name, error: s.error } : { key: `${t.key}.${i}`, kind: 'started' as const, started: s, attached: attachedCount(specs[i]?.attachments) }))
    }
    if (t.name.endsWith('__message_session') && t.result && !t.result.isError && typeof t.input.name === 'string') return [{ key: t.key, kind: 'added', name: t.input.name, attached: attachedCount(t.input.attachments) }]
    return []
  })
}

export function ThreadCards({ tools }: { tools: readonly TranscriptItem[] }) {
  const refs = refsIn(tools)
  if (!refs.length) return null
  return (
    <div className="threadCards">
      {refs.map((r) =>
        r.kind === 'started' ? (
          <ThreadCard key={r.key} id={r.started.id} fallbackTitle={r.started.title} attached={r.attached} />
        ) : r.kind === 'added' ? (
          <AddedTo key={r.key} name={r.name} attached={r.attached} />
        ) : r.kind === 'failed' ? (
          <div key={r.key} className="threadCard failed">
            <span className="tcT">
              <b>{r.name}</b>
              <span>Did not start: {r.error}</span>
            </span>
          </div>
        ) : (
          <div key={r.key} className="threadCard pending">
            <span className="tcT">
              <b>{r.title}</b>
              <span>Starting…</span>
            </span>
          </div>
        ),
      )}
    </div>
  )
}

export const STATE_WORDS: Record<ThreadState, string> = { you: 'Needs you', working: 'Working', stopped: 'Stopped', ready: 'Ready for you' }

/** One thread, live: its agent's face, title, and whose turn it is. */
export function ThreadCard({ id, fallbackTitle, attached = 0 }: { id: string; fallbackTitle?: string; attached?: number }) {
  const sessions = useSessions()
  const agents = useChatAgents()
  const persona = usePersona()
  const open = useOpenThread()
  const s = sessions.find((x) => x.id === id)
  if (!s) {
    return (
      <div className="threadCard gone">
        <span className="tcT">
          <b>{fallbackTitle ?? 'A thread'}</b>
          <span>This thread was deleted.</span>
        </span>
      </div>
    )
  }
  const agent = s.agent ? agents.find((a) => a.name === s.agent) : undefined
  const state = threadState(s)
  const pinned = !!s.pinned
  // The card opens the thread; the pin beside it (on hover, or always once pinned) and right-click pin it to the sidebar.
  return (
    <ThreadPinMenu id={id} pinned={pinned}>
      <div className={`threadCard ${state}${pinned ? ' pinned' : ''}`}>
        <button type="button" className="tcMain" onClick={() => open(id)}>
          <JuniorFace mood={state === 'you' ? 'needs' : state === 'working' ? 'working' : state === 'stopped' ? 'stuck' : 'hello'} size={28} motion="still" colour={agent?.colour ?? undefined} decorative />
          <span className="tcT">
            <b>{s.title}</b>
            <span>
              {agent?.label ?? persona.name}
              {attachedWords(attached)}
            </span>
          </span>
          <span className={`tcState ${state}`}>{STATE_WORDS[state]}</span>
        </button>
        <PinThreadButton id={id} pinned={pinned} size={14} className="tcPin" />
      </div>
    </ThreadPinMenu>
  )
}

/** "Added to the #498 thread": the routing receipt for a follow-up. */
function AddedTo({ name, attached }: { name: string; attached: number }) {
  const sessions = useSessions()
  const open = useOpenThread()
  const s = sessions.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return (
    <div className="threadAdded">
      Added to{' '}
      {s ? (
        <button type="button" className="jrRef" onClick={() => open(s.id)}>
          {s.title}
        </button>
      ) : (
        name
      )}
      {attachedWords(attached)}
    </div>
  )
}
