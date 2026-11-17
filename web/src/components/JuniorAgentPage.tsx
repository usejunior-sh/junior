/**
 * Junior's own page, laid out like every agent's (AgentPage.tsx): who it is
 * (the name you can change), the jobs it owns (every job without `agent:` is
 * Junior's), what it has learned about how you work (global learnings and
 * any scoped `agent:junior`), and its memory (`<workspace>/memory.md`, read
 * only here: Junior writes it, you edit the file by hand).
 */
import { MessageSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { JUNIOR_DM } from '../../../core/junior/dms.js'
import { cleanName, DEFAULT_NAME, NAME_MAX } from '../../../core/junior/persona.js'
import type { MemoryLine } from '../../../core/junior/memory.js'
import type { MemoryResponse } from '../../../shared/protocol.js'
import { savePersona, usePersona } from '../junior.js'
import { useLearnings } from '../learnings.js'
import { openNotebook } from '../settings.js'
import { JobLine, useJobs } from './AgentPage.js'
import { JuniorFace } from './JuniorFace.js'

function useMemory(): { lines: MemoryLine[]; path: string } | null {
  const [memory, setMemory] = useState<{ lines: MemoryLine[]; path: string } | null>(null)
  useEffect(() => {
    let live = true
    fetch('/api/memory')
      .then((r) => r.json() as Promise<MemoryResponse>)
      .then((b) => live && setMemory(b.ok ? { lines: b.lines, path: b.path } : { lines: [], path: '' }))
      .catch(() => live && setMemory({ lines: [], path: '' }))
    return () => {
      live = false
    }
  }, [])
  return memory
}

export function JuniorAgentPage({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const persona = usePersona()
  const { learnings } = useLearnings()
  const jobs = useJobs()
  const memory = useMemory()
  const [name, setName] = useState(persona.name)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setName(persona.name), [persona.name])

  const commitName = async () => {
    const next = cleanName(name)
    setName(next)
    if (next === persona.name) return
    const r = await savePersona({ name: next })
    setError(typeof r === 'string' ? r : null)
  }

  const scopes = new Set(['global', `agent:${JUNIOR_DM}`, `agent:${persona.name.toLowerCase()}`])
  const mine = (learnings ?? []).filter((l) => scopes.has(l.scope))
  const kept = mine.filter((l) => l.status === 'kept')
  const proposed = mine.filter((l) => l.status === 'proposed')
  // A job with no owner is Junior's.
  const myJobs = jobs.filter((j) => !j.agent || j.agent === JUNIOR_DM)

  return (
    <div className="page agentPage">
      <div className="inner">
        <header className="agHead">
          <JuniorFace mood="hello" size={64} motion="follow" decorative />
          <div className="agWho">
            <h1>{persona.name}</h1>
            <p>Your junior engineer. Runs on your Mac.</p>
          </div>
          <button type="button" className="btn" onClick={() => onNavigate(`/agents/${JUNIOR_DM}`)}>
            <MessageSquare size={14} aria-hidden="true" /> Message {persona.name}
          </button>
        </header>
        <p className="agRoute">Your main agent. You tell {persona.name}, and {persona.name} hands work to your other agents as threads.</p>

        <h2 className="agH">About</h2>
        <section className="agPanel agAbout">
          <label className="agAboutL" htmlFor="agJuniorName">
            Name
          </label>
          <input
            id="agJuniorName"
            className="jrName"
            value={name}
            maxLength={NAME_MAX}
            placeholder={DEFAULT_NAME}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setName(persona.name)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          <span className="agFoot">Shows in the rail, in chats and in every report.</span>
          {error && (
            <p className="agEmpty" role="alert">
              Couldn't save: {error}
            </p>
          )}
        </section>

        <h2 className="agH">Jobs</h2>
        {myJobs.length === 0 ? (
          <p className="agEmpty">{persona.name} has no jobs yet. Message {persona.name} with one: "Every morning, check my PRs and tell me which ones need me."</p>
        ) : (
          <ul className="agJobs">
            {myJobs.map((j) => (
              <JobLine key={j.id} job={j} onNavigate={onNavigate} />
            ))}
          </ul>
        )}

        <div className="agTwo">
          <section className="agPanel">
            <div className="agPanelHead">
              <h3>What it has learned</h3>
              <button type="button" className="jrRef" onClick={openNotebook}>
                All learnings
              </button>
            </div>
            {kept.length === 0 && proposed.length === 0 ? (
              <p className="agEmpty">Nothing yet. When you correct {persona.name}, it proposes a note here. Nothing is kept until you press Keep.</p>
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
          <section className="agPanel">
            <div className="agPanelHead">
              <h3>What it remembers</h3>
            </div>
            {memory === null ? (
              <p className="agEmpty">Looking…</p>
            ) : memory.lines.length === 0 ? (
              <p className="agEmpty">Nothing yet. {persona.name} keeps facts here that still matter next week: who someone is, where a piece of work stands.</p>
            ) : (
              <ul className="agMemory">
                {memory.lines.map((l, i) => (
                  <li key={i}>
                    {l.day && <span className="agDay">{l.day}</span>}
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
            <p className="agFoot" title={memory?.path || undefined}>
              Tell {persona.name} to forget a line, or edit memory.md by hand.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
