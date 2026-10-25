/**
 * Who a new chat talks to: plain Junior, or Junior as one of its agents
 * (core/junior/agents.ts), picked once before the first message. A popover in
 * the model picker's shape: a search box, Junior pinned on top, the agents in
 * a list that scrolls past a few rows, and a way to manage them. Arrow keys
 * move, Enter picks. Hidden when the workspace has no chat agents.
 */
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Search, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatAgent } from '../../../core/junior/agents.js'
import { useChatAgents } from '../chatAgents.js'
import { usePersona } from '../junior.js'
import { openSettings } from '../settings.js'
import { isMobile } from '../useMobile.js'
import { JuniorFace } from './JuniorFace.js'

export function AgentPicker({ agent, onChange, disabled }: { agent?: string; onChange: (name: string | undefined) => void; disabled?: boolean }) {
  const persona = usePersona()
  const agents = useChatAgents()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const picked = agents.find((a) => a.name === agent) ?? null

  // Junior first, then every agent the search matches; Junior drops out once you type.
  const shown = useMemo<Array<ChatAgent | null>>(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return [null, ...agents]
    return agents.filter((a) => `${a.label} ${a.description} ${a.slug}`.toLowerCase().includes(needle))
  }, [agents, q])

  useEffect(() => setAt(0), [q])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  if (!agents.length) return null

  const pick = (a: ChatAgent | null) => {
    onChange(a?.name)
    setOpen(false)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setAt(Math.max(0, agents.findIndex((a) => a.name === picked?.name) + 1))
        else setQ('')
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`chip agentChip${picked ? ' picked' : ''}`}
          disabled={disabled}
          title={picked ? `${persona.name} · ${picked.label}: ${picked.description}` : `Talk to ${persona.name}, or one of its agents`}
          aria-label={`Talk to: ${persona.name}${picked ? ` · ${picked.label}` : ''}`}
        >
          <JuniorFace size={15} motion="still" colour={picked?.colour ?? undefined} decorative />
          <span className="name">{picked ? picked.label : persona.name}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="mpop agpop"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(e) => {
            if (isMobile()) e.preventDefault()
          }}
        >
          <label className="mpSearch">
            <Search size={13} aria-hidden="true" />
            <input
              placeholder="Search agents…"
              value={q}
              aria-label="Search agents"
              aria-controls="agentList"
              aria-activedescendant={shown.length ? `agentOpt-${at}` : undefined}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setAt((i) => Math.min(shown.length - 1, i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAt((i) => Math.max(0, i - 1))
                } else if (e.key === 'Enter' && shown[at] !== undefined) {
                  e.preventDefault()
                  pick(shown[at])
                }
              }}
            />
            <span className="agCount">{agents.length}</span>
          </label>
          <div className="agList" id="agentList" role="listbox" aria-label="Talk to" ref={list}>
            {shown.map((a, i) => {
              const on = (a?.name ?? null) === (picked?.name ?? null)
              return (
                <div key={a?.name ?? ''}>
                  {a && i > 0 && shown[i - 1] === null && <div className="agSep">Agents</div>}
                  <button
                    type="button"
                    role="option"
                    id={`agentOpt-${i}`}
                    data-i={i}
                    aria-selected={on}
                    className={`agOpt${on ? ' sel' : ''}${i === at ? ' at' : ''}`}
                    title={a ? `${a.description}${a.scope ? `\n${a.scope}` : ''}` : undefined}
                    onPointerMove={() => setAt(i)}
                    onClick={() => pick(a)}
                  >
                    <JuniorFace size={22} motion="still" colour={a?.colour ?? undefined} decorative />
                    <span className="agText">
                      <span className="n">{a ? a.label : persona.name}</span>
                      <span className="d">{a ? a.description || a.scope : 'Every skill and tool'}</span>
                    </span>
                    <Check size={13} aria-hidden="true" className="chk" />
                  </button>
                </div>
              )
            })}
            {shown.length === 0 && <div className="mpEmpty">No agent matches “{q.trim()}”.</div>}
          </div>
          <div className="agFoot">
            <span>Ask {persona.name} in a chat to make one.</span>
            <button
              type="button"
              className="agManage"
              onClick={() => {
                setOpen(false)
                openSettings('agents')
              }}
            >
              <Settings2 size={12} aria-hidden="true" /> Manage
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
