/**
 * The Agents panel: Junior first, then every chat agent (core/junior/agents.ts).
 * Each row opens that agent's DM, its one long-running chat
 * (core/junior/dms.ts). Quiet at rest: a row gets a mark only when its DM
 * needs you, is working, or failed.
 */
import { JUNIOR_DM, dmKey, findDm } from '../../../core/junior/dms.js'
import type { SessionSummary } from '../../../shared/protocol.js'
import { useChatAgents } from '../chatAgents.js'
import { useSessions } from '../hooks.js'
import { needsYouText } from '../inboxTabs.js'
import { relTime } from '../itemUi.js'
import { usePersona } from '../junior.js'
import { shownStatus } from '../sessionModes.js'
import { PanelSearch } from './ContextPanel.js'
import { JuniorFace } from './JuniorFace.js'

type Props = {
  /** the DM key on screen (`junior`, `junior:explainer`) */
  current: string | null
  onOpen: (key: string) => void
  /** Double-click: keep the agent's DM as a tab of its own, not just the peek. */
  onPin: (key: string) => void
  onSearch: () => void
}

type Row = { key: string; label: string; description: string; colour?: string }

export function AgentsPanel({ current, onOpen, onPin, onSearch }: Props) {
  const persona = usePersona()
  const agents = useChatAgents()
  const sessions = useSessions()
  const rows: Row[] = [
    { key: JUNIOR_DM, label: persona.name, description: 'Your junior engineer' },
    ...agents.map((a) => ({ key: dmKey(a.name), label: a.label, description: a.description, colour: a.colour ?? undefined })),
  ]
  return (
    <aside className="panel" aria-label="Agents">
      <PanelSearch onSearch={onSearch} placeholder="Search chats, items…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Agents</span>
          <span className="n">{rows.length}</span>
        </div>
        {rows.map((r) => (
          <AgentRow key={r.key} row={r} dm={findDm(sessions, r.key)} active={r.key === current} onOpen={() => onOpen(r.key)} onPin={() => onPin(r.key)} />
        ))}
      </div>
    </aside>
  )
}

function AgentRow({ row, dm, active, onOpen, onPin }: { row: Row; dm: SessionSummary | undefined; active: boolean; onOpen: () => void; onPin: () => void }) {
  // Waiting on you outranks working: the one orange in the list.
  const needs = dm ? needsYouText(dm) : null
  const shown = dm ? shownStatus(dm) : null
  const state = needs
    ? { cls: 'needs', text: 'needs you', title: `Waiting on you: ${needs}` }
    : shown?.status === 'error'
      ? { cls: 'failed', text: 'failed', title: shown.title }
      : shown?.status === 'running' || shown?.status === 'starting'
        ? { cls: 'working', text: 'working', title: shown.title }
        : null
  return (
    <div
      className={`prow agent${active ? ' sel' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      title={[row.label, row.description, 'Double-click to keep it open as a tab'].filter(Boolean).join('\n')}
      onClick={onOpen}
      onDoubleClick={onPin}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <span className="lead" aria-hidden="true">
        <JuniorFace size={18} motion="still" colour={row.colour} decorative />
      </span>
      <span className="t">
        <span className="nm">{row.label}</span>
        {row.description && <span className="sub">{row.description}</span>}
      </span>
      {state ? (
        <span className={`stateMark ${state.cls}`} title={state.title}>
          {state.text}
        </span>
      ) : (
        dm && <span className="age">{relTime(dm.updatedAt)}</span>
      )}
    </div>
  )
}
