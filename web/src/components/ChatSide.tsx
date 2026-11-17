/**
 * The chat's right sidebar for the tabs that aren't the browser (chatSide.ts):
 * who the chat talks as, the threads it handed out, its artifacts, or its
 * background agents, with a stats bar at the bottom. The browser tab is the browser pane itself, in this slot.
 */
import { ChevronDown, Folder, List, X } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import type { CheckoutChanges, SessionSummary } from '../../../shared/protocol.js'
import type { AgentRun } from '../agents.js'
import { artifactAgo, FormatIcon } from '../artifactFormat.js'
import { useSessionArtifacts } from '../artifactsClient.js'
import { chatSide, type SideTab } from '../chatSide.js'
import { useEvents, useSessions } from '../hooks.js'
import { contextUse, money, tokens } from '../usageFormat.js'
import { AgentCard } from './Agents.js'
import { JuniorFace } from './JuniorFace.js'
import { useChatAgent } from '../chatAgents.js'
import { EFFORT_LABEL, findModel, useModels } from '../models.js'
import { usePersona } from '../junior.js'
import { agentTitle } from '../../../core/junior/agents.js'
import { useSessionSpend } from './SessionCost.js'
import { ChangeFileRows, useChangesPoll } from './ChangesPanel.js'
import { CheckoutMenu } from './CheckoutMenu.js'
import { changeId, useChanges } from '../changesStore.js'
import { threadState, type ThreadState } from '../../../core/junior/threads.js'
import { ThreadCard, ThreadOpenContext, useOpenThread } from './ThreadCards.js'

const TITLE: Record<Exclude<SideTab, 'browser'>, string> = { agent: 'About', threads: 'Threads', changes: 'Changes', artifacts: 'Artifacts', agents: 'Background agents' }

const THREAD_ORDER: Record<ThreadState, number> = { you: 0, stopped: 1, working: 2, ready: 3 }

/** The threads this chat handed out (`startedBy`): yours first, then stopped, working, done; newest first in each. */
export function useChatThreads(sessionId: string): SessionSummary[] {
  const sessions = useSessions()
  return useMemo(
    () =>
      sessions
        .filter((s) => s.startedBy === sessionId)
        .sort((a, b) => THREAD_ORDER[threadState(a)] - THREAD_ORDER[threadState(b)] || b.updatedAt - a.updatedAt),
    [sessions, sessionId],
  )
}

type Props = {
  session: SessionSummary
  tab: Exclude<SideTab, 'browser'>
  agents: AgentRun[]
  openAgent: AgentRun | null
  showAgent: (toolUseId: string | null) => void
  onNavigate: (hash: string) => void
  /** Keep a changed file as a tab of its own (⌘-click, middle-click on a row). */
  onPin: (key: string) => void
  newTerminalIn: (checkoutId: string) => void
}

export function ChatSide({ session, tab, agents, openAgent, showAgent, onNavigate, onPin, newTerminalIn }: Props) {
  const artifacts = useSessionArtifacts(session.id)
  // Running first, then the newest: what's going on now is what you came to look at.
  const runs = useMemo(
    () => [...agents].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    [agents],
  )
  const changed = useChatChanges(session.checkoutId)
  const threads = useChatThreads(session.id)
  // Opening one shows it beside the chat, in this sidebar's place. Closed from the
  // open itself: a capture-phase close re-renders before the row's click lands.
  const openThread = useOpenThread()
  const openInPlace = useCallback(
    (id: string) => {
      chatSide.set(session.id, null)
      openThread(id)
    },
    [session.id, openThread],
  )
  const count = tab === 'artifacts' ? artifacts.length : tab === 'agents' ? agents.length : tab === 'changes' ? (changed?.files.length ?? 0) : tab === 'threads' ? threads.length : 0
  return (
    <aside className="chatSide" aria-label={TITLE[tab]}>
      <div className="csHead">
        <span className="t">{TITLE[tab]}</span>
        {count > 0 && <span className="n">{count}</span>}
        <button type="button" className="iconBtn" title="Hide the sidebar (⌘⌥B)" aria-label="Hide the sidebar" onClick={() => chatSide.set(session.id, null)}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="csBody">
        {tab === 'changes' ? (
          <SideChanges cc={changed} onNavigate={onNavigate} onPin={onPin} newTerminalIn={newTerminalIn} />
        ) : tab === 'agent' ? (
          <AgentAbout session={session} onNavigate={onNavigate} />
        ) : tab === 'threads' ? (
          threads.length === 0 ? (
            <div className="csEmpty">No threads yet. Work handed off from this chat shows up here.</div>
          ) : (
            <ThreadOpenContext.Provider value={openInPlace}>
              <div className="csThreads">
                {threads.map((t) => (
                  <ThreadCard key={t.id} id={t.id} />
                ))}
              </div>
            </ThreadOpenContext.Provider>
          )
        ) : tab === 'artifacts' ? (
          artifacts.length === 0 ? (
            <div className="csEmpty">Nothing published from this chat yet. Files Junior writes as artifacts show up here.</div>
          ) : (
            <>
              {artifacts.map((a) => (
                <button key={a.id} type="button" className="csRow" title={a.title} onClick={() => onNavigate(`/artifact/${a.id}`)}>
                  <FormatIcon format={a.format} />
                  <span className="name">{a.title}</span>
                  <span className="val">
                    v{a.version} · {artifactAgo(a.updated)}
                  </span>
                </button>
              ))}
              <button type="button" className="csRow foot" onClick={() => onNavigate(`/artifacts?session=${encodeURIComponent(session.id)}`)}>
                <List size={14} aria-hidden="true" />
                <span className="name">See in Artifacts</span>
              </button>
            </>
          )
        ) : runs.length === 0 ? (
          <div className="csEmpty">No background agents in this chat.</div>
        ) : (
          <div className="csAgents">
            {runs.map((r) => (
              <div key={r.toolUseId} className={openAgent?.toolUseId === r.toolUseId ? 'sel' : undefined}>
                <AgentCard run={r} onOpen={showAgent} />
              </div>
            ))}
          </div>
        )}
      </div>
      <SideStats session={session} />
    </aside>
  )
}

/** The sidebar's last line: what this chat has cost, its tokens, and how full its context is. */
function SideStats({ session }: { session: SessionSummary }) {
  const events = useEvents(session.id)
  const ctx = useMemo(() => contextUse(events, session.kind), [events, session.kind])
  const { spend } = useSessionSpend(session.id, session.status, session.workflows)
  if (!spend && !ctx) return null
  return (
    <div className="csStats">
      {spend && (
        <span>
          {money(spend.cost)}
          {!spend.priced && '+'}
        </span>
      )}
      {spend && <span>{tokens(spend.tokens)} tokens</span>}
      {ctx && (
        <>
          <span className="lab">context</span>
          <span className="ctxBar" aria-hidden="true">
            <i style={{ width: `${ctx.pct}%` }} className={ctx.pct >= 80 ? 'full' : undefined} />
          </span>
          <span title={`${tokens(ctx.used)} of ${tokens(ctx.window)}`}>{ctx.pct}%</span>
        </>
      )}
    </div>
  )
}

/**
 * Who this chat talks as, opened from a DM's pill: the face, what it's for, and
 * what it may use (core/junior/agents.ts). Plain Junior has no agent file, so
 * it shows the persona and where to change it.
 */
function AgentAbout({ session, onNavigate }: { session: SessionSummary; onNavigate: (hash: string) => void }) {
  const agent = useChatAgent(session.agent)
  const persona = usePersona()
  // The model this chat actually runs, and whether the agent's file asks for it or leaves it to the chat.
  const models = useModels()
  const running = findModel(models, session.model)?.name ?? session.model
  const effort = session.effort ? ` · ${EFFORT_LABEL[session.effort].toLowerCase()}` : ''
  if (!agent)
    return (
      <div className="csAbout">
        <JuniorFace size={56} motion="still" decorative />
        <div className="nm">{persona.name}</div>
        <p>Your junior engineer. It runs on your Mac, plans first, and asks before anything goes out.</p>
        <button type="button" className="btn sm" onClick={() => onNavigate('/junior')}>
          Open {persona.name}'s page
        </button>
      </div>
    )
  const list = (xs: string[] | null, all: string) => (xs ? xs.join(', ') : all)
  return (
    <div className="csAbout">
      <JuniorFace size={56} motion="still" colour={agent.colour ?? undefined} decorative />
      <div className="nm">{agentTitle(persona.name, agent.label)}</div>
      {agent.description && <p>{agent.description}</p>}
      <dl>
        <div>
          <dt>Model</dt>
          <dd>
            {running ? `${running}${effort}` : 'set when the chat starts'}
            <span className="note">{agent.model ? ' · set by the agent' : " · the chat's pick"}</span>
          </dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>{list(agent.skills, 'every skill')}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>{list(agent.tools, 'everything a chat has')}</dd>
        </div>
        <div>
          <dt>From</dt>
          <dd className="mono" title={agent.path}>
            {agent.scope} · {agent.slug}.md
          </dd>
        </div>
      </dl>
      <button type="button" className="btn sm" onClick={() => onNavigate('/settings/agents')}>
        Edit in Settings → Agents
      </button>
    </div>
  )
}

/** This chat's folder as the changes store sees it (null until it loads, or for a chat with no checkout). */
export function useChatChanges(checkoutId: string | undefined): CheckoutChanges | null {
  const { projects } = useChanges()
  return useMemo(() => {
    if (!checkoutId) return null
    for (const p of projects) for (const c of p.checkouts) if (c.checkout.id === checkoutId) return c
    return null
  }, [projects, checkoutId])
}

/**
 * Every uncommitted file in the chat's folder, the same rows as the rail's
 * Changes, under a bar that says which folder and branch it is and opens it
 * elsewhere. It lists the disk, so a change from a terminal or an editor shows
 * up here too, not only the agent's.
 */
function SideChanges({
  cc,
  onNavigate,
  onPin,
  newTerminalIn,
}: {
  cc: CheckoutChanges | null
  onNavigate: (hash: string) => void
  onPin: (key: string) => void
  newTerminalIn: (checkoutId: string) => void
}) {
  useChangesPoll()
  const { projects, loaded } = useChanges()
  if (!cc) return <div className="csEmpty">{loaded ? "This chat's folder isn't a project with git, so there are no changes to list." : 'Loading changes…'}</div>
  const project = projects.find((p) => p.project.id === cc.checkout.projectId)?.project.name
  return (
    <>
      <div className="csFolder" title={cc.checkout.path}>
        <Folder size={14} aria-hidden="true" />
        <span className="t">
          {project ?? cc.checkout.path}
          {cc.checkout.branch && <span className="br"> / {cc.checkout.branch}</span>}
        </span>
        <CheckoutMenu checkout={cc.checkout} align="end" onNewTerminal={() => newTerminalIn(cc.checkout.id)}>
          <button type="button" className="iconBtn" title="Open in…" aria-label="Open in">
            <Folder size={14} aria-hidden="true" />
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </CheckoutMenu>
      </div>
      {cc.error ? (
        <div className="csEmpty">git failed for this folder: {cc.error}</div>
      ) : cc.files.length === 0 ? (
        <div className="csEmpty">No uncommitted changes in this folder.</div>
      ) : (
        <div className="csChanges">
          <ChangeFileRows
            cc={cc}
            current={null}
            onOpen={(checkoutId, path) => onNavigate(`/change/${changeId(checkoutId, path)}`)}
            onPin={(checkoutId, path) => onPin(`change:${changeId(checkoutId, path)}`)}
          />
        </div>
      )}
    </>
  )
}
