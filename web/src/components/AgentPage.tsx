/**
 * One agent as a teammate (.docs/redesign-b2-plan.md, Phase 3): what it is
 * for, its threads, how it works (its file's instructions), what it has
 * learned about how you want the job done (learnings scoped `agent:<name>`),
 * and the jobs that hand it work. Junior stays the default route; "Message"
 * opens the agent's own chat for when you want to talk to it directly.
 */
import { MessageSquare } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { openThreads } from '../../../core/junior/threads.js'
import type { Job } from '../../../core/job/types.js'
import { describeCron } from '../../../core/job/cron.js'
import type { JobsResponse } from '../../../shared/protocol.js'
import { useChatAgents } from '../chatAgents.js'
import { useSessions } from '../hooks.js'
import { usePersona } from '../junior.js'
import { useLearnings } from '../learnings.js'
import { openNotebook, openSettings } from '../settings.js'
import { JuniorFace } from './JuniorFace.js'
import { Markdown } from './Markdown.js'
import { ThreadCard } from './ThreadCards.js'

/** Older threads shown under the open ones. */
const PAST_SHOWN = 5

export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([])
  useEffect(() => {
    let live = true
    const load = () =>
      fetch('/api/jobs')
        .then((r) => r.json() as Promise<JobsResponse>)
        .then((b) => live && b.ok && setJobs(b.jobs))
        .catch(() => {})
    load()
    return () => {
      live = false
    }
  }, [])
  return jobs
}

export function AgentPage({ name, onNavigate }: { name: string; onNavigate: (hash: string) => void }) {
  const agents = useChatAgents()
  const persona = usePersona()
  const sessions = useSessions()
  const { learnings } = useLearnings()
  const jobs = useJobs()
  const agent = agents.find((a) => a.name === name) ?? null

  const { open, past } = useMemo(() => {
    const mine = sessions.filter((s) => s.agent === name && s.kind !== 'dm')
    // Over every session: whether Junior started a thread depends on its chat being in the list.
    const openIds = new Set(openThreads(sessions, Date.now()).map((t) => t.id))
    return {
      open: mine.filter((s) => openIds.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt),
      past: mine.filter((s) => !openIds.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt),
    }
  }, [sessions, name])

  if (!agent) {
    return (
      <div className="page agentPage">
        <div className="inner">
          <p className="muted">No agent is called {name} here. It may have been removed from Settings → Agents.</p>
        </div>
      </div>
    )
  }

  const scopes = new Set([`agent:${agent.name}`, `agent:${agent.slug}`])
  const memory = (learnings ?? []).filter((l) => scopes.has(l.scope))
  const kept = memory.filter((l) => l.status === 'kept')
  const proposed = memory.filter((l) => l.status === 'proposed')
  // Jobs it owns: their runs are its threads. Jobs that only list it as a helper come after.
  const myJobs = jobs.filter((j) => j.agent === agent.name)
  const helps = jobs.filter((j) => j.agent !== agent.name && j.agents?.some((a) => a === agent.name || a === agent.slug || a.endsWith(`:${agent.slug}`)))

  return (
    <div className="page agentPage">
      <div className="inner">
        <header className="agHead">
          <JuniorFace mood="hello" size={64} motion="follow" colour={agent.colour ?? undefined} decorative />
          <div className="agWho">
            <h1>{agent.label}</h1>
            <p>{agent.description || `One of ${persona.name}'s agents.`}</p>
          </div>
          <button type="button" className="btn" onClick={() => onNavigate(`/agents/${encodeURIComponent(agent.name)}`)}>
            <MessageSquare size={14} aria-hidden="true" /> Message {agent.label}
          </button>
        </header>
        <p className="agRoute">
          Most of the time you tell {persona.name}, and {persona.name} hands {agent.label} the work as a thread.
        </p>

        <h2 className="agH">Threads</h2>
        {open.length === 0 && past.length === 0 && <p className="agEmpty">No threads yet. Ask {persona.name} for something in {agent.label}'s line of work.</p>}
        <div className="threadCards">
          {open.map((s) => (
            <ThreadCard key={s.id} id={s.id} />
          ))}
        </div>
        {past.length > 0 && (
          <details className="agPast">
            <summary>
              {past.length} earlier thread{past.length === 1 ? '' : 's'}
            </summary>
            <div className="threadCards">
              {past.slice(0, PAST_SHOWN).map((s) => (
                <ThreadCard key={s.id} id={s.id} />
              ))}
            </div>
          </details>
        )}

        <div className="agTwo">
          <section className="agPanel">
            <div className="agPanelHead">
              <h3>How {agent.label} works</h3>
              <button type="button" className="jrRef" onClick={() => openSettings('agents')}>
                Edit
              </button>
            </div>
            {agent.prompt ? <Markdown text={agent.prompt} /> : <p className="agEmpty">No instructions yet. It works as plain {persona.name}.</p>}
            <p className="agFoot">
              {agent.tools ? `Tools: ${agent.tools.join(', ')}.` : 'Every tool a chat has.'} {agent.model ? `Model: ${agent.model}.` : ''} From {agent.scope}.
            </p>
          </section>
          <section className="agPanel">
            <div className="agPanelHead">
              <h3>What it has learned</h3>
              <button type="button" className="jrRef" onClick={openNotebook}>
                All learnings
              </button>
            </div>
            {kept.length === 0 && proposed.length === 0 ? (
              <p className="agEmpty">
                Nothing yet. When you correct {agent.label}, {persona.name} proposes a note here. Nothing is kept until you press Keep.
              </p>
            ) : (
              <ul className="agMemory">
                {kept.map((l) => (
                  <li key={l.id}>{l.text}</li>
                ))}
                {proposed.map((l) => (
                  <li key={l.id} className="proposed" title="Proposed: keep or forget it where it was proposed">
                    {l.text} <span>proposed</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <h2 className="agH">Jobs</h2>
        {myJobs.length === 0 ? (
          <p className="agEmpty">
            {agent.label} has no jobs yet. Message {agent.label} with one: "Every hour, check the logs. If something is wrong, investigate and write the report."
          </p>
        ) : (
          <ul className="agJobs">
            {myJobs.map((j) => (
              <JobLine key={j.id} job={j} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
        {helps.length > 0 && (
          <>
            <p className="agRoute">Helps in</p>
            <ul className="agJobs">
              {helps.map((j) => (
                <JobLine key={j.id} job={j} onNavigate={onNavigate} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

/** One job on an agent's page: its title, when it runs, on or off. */
export function JobLine({ job, onNavigate }: { job: Job; onNavigate: (hash: string) => void }) {
  return (
    <li>
      <button type="button" className="agJob" onClick={() => onNavigate(`/jobs/${encodeURIComponent(job.id)}`)}>
        <span className="tcT">
          <b>{job.title}</b>
          <span>{describeCron(job.schedule)}</span>
        </span>
        <span className={`tcState ${job.enabled ? '' : 'ready'}`}>{job.enabled ? 'On' : 'Off'}</span>
      </button>
    </li>
  )
}
