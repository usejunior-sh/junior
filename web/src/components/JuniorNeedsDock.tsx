/**
 * What needs you, docked above the box in Junior's chat (.docs/redesign-b2-plan.md,
 * "Junior's morning message"). The chat never ends, so a message at the top
 * would scroll away: the rows sit here while they wait, one button each, and
 * the dock goes away when nothing does. Built from the same rows as the
 * Junior page's Needs you (core/junior/needs.ts).
 */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import type { NeedsRow } from '../../../core/junior/needs.js'
import { useWorkspaceId } from '../hooks.js'
import { useAwayWindow, useJuniorDay } from '../junior.js'

/** Rows shown before "Show N more". */
const SHOWN = 3

export function JuniorNeedsDock({ onOpenSession, onNavigate }: { onOpenSession: (id: string) => void; onNavigate: (hash: string) => void }) {
  const workspaceId = useWorkspaceId()
  const win = useAwayWindow(workspaceId)
  const { day } = useJuniorDay(win)
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const needs = day?.needs ?? []
  if (!needs.length) return null
  const go = (n: NeedsRow) => (n.target.kind === 'session' ? onOpenSession(n.target.id) : onNavigate('/junior/log'))
  const rows = all ? needs : needs.slice(0, SHOWN)
  return (
    <section className="needsDock" aria-label="Needs you">
      <button type="button" className="ndHead" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ndDot" aria-hidden="true" />
        <span className="ndTitle">
          {needs.length === 1 ? 'One thing needs you' : `${needs.length} things need you`}
        </span>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
      </button>
      {open && (
        <ul className="ndRows">
          {rows.map((n) => (
            <li key={n.key}>
              <span className="ndT">
                <b>{n.title}</b>
                <span>{n.meta}</span>
              </span>
              <button type="button" className="btn primary sm" onClick={() => go(n)}>
                {n.go}
              </button>
            </li>
          ))}
          {needs.length > SHOWN && (
            <li className="ndMore">
              <button type="button" className="jrRef" onClick={() => setAll((v) => !v)}>
                {all ? 'Show fewer' : `Show ${needs.length - SHOWN} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
