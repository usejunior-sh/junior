/**
 * Chat agents (core/junior/agents.ts) on the client: one shared list, fetched
 * once and again whenever the library changes, so an agent Junior just wrote
 * shows up in the composer chip and on faces without a refresh.
 */
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'
import type { ChatAgentsResponse } from '../../shared/protocol.js'
import type { ChatAgent } from '../../core/junior/agents.js'
import { agentTitle } from '../../core/junior/agents.js'
import { usePersona } from './junior.js'
import { store } from './store.js'

let agents: ChatAgent[] = []
let started = false
const subs = new Set<() => void>()

function load() {
  fetch('/api/library/chat-agents')
    .then((r) => r.json() as Promise<ChatAgentsResponse>)
    .then((b) => {
      if (!b.ok) return
      agents = b.agents
      for (const f of subs) f()
    })
    .catch(() => {})
}

function subscribe(f: () => void) {
  if (!started) {
    started = true
    load()
    store.onLibraryChanged(load)
  }
  subs.add(f)
  return () => subs.delete(f)
}

/** Every agent a chat here can talk as, workspace first. */
export const useChatAgents = (): ChatAgent[] => useSyncExternalStore(subscribe, () => agents)

/** The agent a session talks as; null for plain Junior, or when its file is gone. */
export function useChatAgent(name: string | undefined | null): ChatAgent | null {
  const all = useChatAgents()
  return name ? (all.find((a) => a.name === name) ?? null) : null
}

/** The agent the session on screen talks as, for every face and name inside it. */
const Scope = createContext<ChatAgent | null>(null)

export function SessionAgentScope({ agent, children }: { agent?: string; children: ReactNode }) {
  return <Scope.Provider value={useChatAgent(agent)}>{children}</Scope.Provider>
}

/** Inside a session: its agent's face colour (undefined = the persona's) and "Junior · Reviewer". */
export function useScopedAgent(): { agent: ChatAgent | null; colour: string | undefined; name: string } {
  const agent = useContext(Scope)
  const persona = usePersona()
  return { agent, colour: agent?.colour ?? undefined, name: agentTitle(persona.name, agent?.label) }
}
